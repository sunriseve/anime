(function() {
    "use strict";

    // ═══════════════════════════════════════════════════════════════════
    //  Stremio Hub v5 — Stable, Full-Featured Stremio Aggregator
    // ═══════════════════════════════════════════════════════════════════
    //
    //  WHAT THIS PLUGIN DOES:
    //  Aggregates multiple Stremio addons into a single SkyStream plugin.
    //  It fetches catalogs, metadata, streams, subtitles, and search
    //  results from all configured addons and presents them unified.
    //
    //  HOW ADDON PRIORITY WORKS:
    //  - `catalogueAddons` (in plugin.json) — order defines priority:
    //    first addon = highest priority for catalog/metadata
    //  - `streamingAddons` (in plugin.json) — order defines priority:
    //    first addon = highest priority for streams
    //  - For duplicate stream URLs, only the first occurrence is kept
    //
    //  ARCHITECTURE:
    //  getHome()    → fetches catalogs from all catalogueAddons
    //  search()     → searches all catalogueAddons
    //  load()       → fetches metadata + pre-fetches streams (background)
    //  loadStreams()→ fetches streams from all streamingAddons
    //
    //  COMPATIBILITY:
    //  - SkyStream Gen 2 plugin system
    //  - Uses native http_parallel, parse_html, solveCaptcha helpers
    // ═══════════════════════════════════════════════════════════════════

    // ────────────────────────────────────────────────────────────────
    //  SECTION 1: CONFIGURATION & CONSTANTS
    // ────────────────────────────────────────────────────────────────

    /** Default User-Agent for HTTP requests */
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    /** JSON-specific request headers */
    var JSON_HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.5"
    };

    // ── Cache Configuration ────────────────────────────────────────
    // The cache stores:
    //   - Addon manifests (key: "mf:<url>")
    //   - Stream results for pre-fetch (key: "streams:<metaId>")
    //   - Metadata lookups (key: "meta:<id>:<type>")
    //
    // Cache TTL is 10 minutes by default. User can override via
    // SkyStream preferences: setPreference("hub_cache_ttl", <milliseconds>)

    /** @type {number} Cache TTL in milliseconds (default: 10 min) */
    var CACHE_TTL = 600000;

    /** @type {Object.<string, {ts: number, data: *}>} In-memory LRU cache */
    var _cache = {};

    /** @type {number} Max cache entries before eviction starts */
    var CACHE_MAX_ENTRIES = 500;

    // Load user preference for cache TTL
    try {
        var ttlPref = parseInt(getPreference("hub_cache_ttl"), 10);
        if (ttlPref > 0) CACHE_TTL = ttlPref;
    } catch (e) { /* Preference API may not be available */ }

    // ── Stream Timeout Configuration ───────────────────────────────
    // Per-addon timeout (not global): each streaming addon gets this
    // much time to respond. This prevents one slow addon from blocking
    // all others. If an addon times out, we move on without its streams.

    /** @type {number} Per-addon stream fetch timeout in ms (80s to give slow addons time) */
    var STREAM_ADDON_TIMEOUT = 80000;

    try {
        var stPref = parseInt(getPreference("hub_stream_timeout"), 10);
        if (stPref > 0) STREAM_ADDON_TIMEOUT = stPref;
    } catch (e) {}

    /** @type {number} Metadata fetch timeout per-addon in ms (default: 8s) */
    var META_TIMEOUT = 8000;

    // ── Rate-Limiting / Backoff ───────────────────────────────────
    // If an addon returns 429 (Too Many Requests), 503, 502, or 504,
    // we back off that URL for RATE_BACKOFF_MS milliseconds after
    // RATE_MAX_FAILS consecutive failures. A successful response
    // resets the fail counter.

    /**
     * @type {Object.<string, {fails: number, until: number}>}
     * Per-URL rate limit tracker
     */
    var _rateLimits = {};

    /** @type {number} Backoff duration after max failures (5 min) */
    var RATE_BACKOFF_MS = 300000;

    /** @type {number} Consecutive failures before backoff triggers */
    var RATE_MAX_FAILS = 3;

    // ── Search Configuration ──────────────────────────────────────
    /** @type {number} Maximum search results to return */
    var MAX_SEARCH_RESULTS = 50;

    /** @type {number} Max items per catalog page */
    var CATALOG_PAGE_SIZE = 20;

    // ── Bittorrent Trackers ───────────────────────────────────────
    // Fetches live tracker lists from multiple raw txt URLs (updated daily).
    // All sources are combined, deduplicated, and cached via preferences.
    // Minimal hardcoded fallback for emergencies only.
    // Source: https://github.com/ngosang/trackerslist

    /** Emergency fallback — only used when ALL live fetches AND cache fail */
    var FALLBACK_TRACKERS = [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://tracker.torrent.eu.org:451/announce"
    ];

    /**
     * Live tracker list URLs — raw txt files, auto-updated daily.
     * Add more URLs here to pull from additional sources.
     * Each URL should contain one tracker per line.
     */
    var TRACKERS_LIST_URLS = [
        "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt",
        "https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt",
        "https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt",
        "https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
    ];

    /** Active tracker list — starts as fallback, replaced by live fetch or cache */
    var TRACKERS = FALLBACK_TRACKERS.slice();

    /** Whether we've already attempted the live fetch */
    var _trackersFetched = false;

    /**
     * Fetch ALL live tracker lists, combine them, deduplicate, and update TRACKERS.
     * Falls back to cache first, then hardcoded fallback on any error.
     * Called lazily — only when a torrent stream needs a magnet link.
     */
    function ensureTrackersLoaded() {
        if (_trackersFetched) return;
        _trackersFetched = true;

        // Check persistent cache first
        try {
            var cachedRaw = getPreference("hub_trackers_list");
            if (cachedRaw) {
                var cached = safeJson(cachedRaw, null);
                if (cached && Array.isArray(cached) && cached.length > 0) {
                    TRACKERS = cached;
                    console.log("[Hub] Trackers loaded from cache: " + TRACKERS.length + " trackers");
                    return;
                }
            }
        } catch (e) { /* Preference API may not be available */ }

        // Fetch ALL live lists and combine them (non-blocking, fire-and-forget)
        try {
            var allParsed = [];
            var seen = {};
            var remaining = TRACKERS_LIST_URLS.length;

            // Helper: parse body text and add to combined list
            function addTrackersFromBody(body) {
                var lines = body.split("\n");
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (!line || line.charAt(0) === "#") continue;
                    // Only accept valid tracker protocols
                    if (line.indexOf("udp://") === 0 || line.indexOf("http://") === 0 ||
                        line.indexOf("https://") === 0 || line.indexOf("ws://") === 0 ||
                        line.indexOf("wss://") === 0) {
                        if (!seen[line]) {
                            seen[line] = true;
                            allParsed.push(line);
                        }
                    }
                }
            }

            // Fetch each URL
            for (var ui = 0; ui < TRACKERS_LIST_URLS.length; ui++) {
                (function(url, idx) {
                    http_get(url, { "User-Agent": UA }).then(function(resp) {
                        if (resp && resp.status === 200 && resp.body) {
                            var body = typeof resp.body === "string" ? resp.body : String(resp.body);
                            addTrackersFromBody(body);
                        }
                        remaining--;
                        // When all fetches complete (or timeout), finalize
                        if (remaining <= 0) finalizeTrackers(allParsed);
                    }).catch(function() {
                        remaining--;
                        if (remaining <= 0) finalizeTrackers(allParsed);
                    });
                })(TRACKERS_LIST_URLS[ui], ui);
            }

            // Safety timeout: if some fetches hang, finalize after 10s
            setTimeout(function() {
                if (remaining > 0) {
                    remaining = 0;
                    finalizeTrackers(allParsed);
                }
            }, 10000);

        } catch (e) {
            console.warn("[Hub] Live tracker fetch threw: " + (e.message || e) + ", using fallback");
        }
    }

    /**
     * Finalize the combined tracker list: cache it and update TRACKERS.
     * @param {string[]} parsed - Combined tracker URLs from all sources
     */
    function finalizeTrackers(parsed) {
        if (parsed.length > 0) {
            TRACKERS = parsed;
            try { setPreference("hub_trackers_list", JSON.stringify(parsed)); } catch (e) {}
            console.log("[Hub] Trackers fetched live from " + TRACKERS_LIST_URLS.length + " source(s): " + TRACKERS.length + " trackers total");
        } else {
            console.warn("[Hub] All live tracker fetches returned 0 entries, using fallback (" + FALLBACK_TRACKERS.length + " trackers)");
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 2: UTILITY FUNCTIONS
    // ────────────────────────────────────────────────────────────────

    /**
     * Get the base URL from a manifest URL (strip "/manifest.json" and trailing slash).
     * @param {string} manifestUrl - Full URL to manifest.json
     * @returns {string} Base URL without trailing slash
     */
    function baseUrl(manifestUrl) {
        return (manifestUrl || "")
            .replace(/\/manifest\.json$/, "")
            .replace(/\/$/, "");
    }

    /**
     * Extract a human-readable addon name from its manifest URL.
     * Handles UUID prefixes, subdomains, and TLDs gracefully.
     * @param {string} url - Manifest URL
     * @returns {string} Human-readable addon name (e.g., "Torrentio", "Indian Streams")
     */
    function addonName(url) {
        try {
            // Strip protocol and split by dots
            var parts = url.replace(/https?:\/\//, "").split("/")[0].replace(/^www\./, "").split(".");
            // If first part is a hex hash (deployment ID), use the second-level domain
            var name = parts[0] || "";
            if (/^[a-f0-9]{8,}$/i.test(name) && parts.length >= 2) {
                name = parts[parts.length - 2];
            }
            // Strip hex hash prefix: "83e20802dcf1-indian-streams" -> "indian-streams"
            name = name.replace(/^[a-f0-9]{6,}-/i, "");
            // Avoid TLDs and very short names
            var tlds = ["com","org","net","io","app","dev","tv","co","uk","de","xyz","fun","cloud","me","in"];
            if (tlds.indexOf(name) !== -1 || name.length <= 2) {
                for (var ni = 1; ni < parts.length - 1; ni++) {
                    if (tlds.indexOf(parts[ni]) === -1 && parts[ni].length > 2) {
                        name = parts[ni];
                        break;
                    }
                }
            }
            // Convert kebab-case to Title Case
            name = name.replace(/[-_]/g, " ").replace(/\b\w/g, function(c) { return c.toUpperCase(); });
            // Common acronym corrections
            name = name.replace(/\bTmdb\b/g, "TMDB");
            return name.trim() || "Addon";
        } catch (e) {
            return "Addon";
        }
    }

    /**
     * Check if a string starts with http:// or https://
     * @param {*} s - Value to check
     * @returns {boolean}
     */
    function isHttp(s) {
        return s && (s.indexOf("http://") === 0 || s.indexOf("https://") === 0);
    }

    /**
     * Safe string conversion
     * @param {*} s
     * @returns {string}
     */
    function safeStr(s) {
        return String(s == null ? "" : s);
    }

    /**
     * Safe JSON parsing with fallback
     * @param {*} text - JSON string to parse
     * @param {*} fallback - Default value if parsing fails
     * @returns {*}
     */
    function safeJson(text, fallback) {
        try {
            return JSON.parse(safeStr(text));
        } catch (e) {
            return fallback !== undefined ? fallback : null;
        }
    }

    /**
     * Create a magnet link from an infoHash.
     * Automatically triggers live tracker fetch on first call (non-blocking).
     * @param {string} hash - Torrent info hash
     * @param {string} [name] - Optional display name (used for &dn= parameter)
     * @returns {string} Full magnet URI with trackers
     */
    function magnetLink(hash, name) {
        ensureTrackersLoaded(); // Triggers live fetch or cache check (non-blocking)
        var m = "magnet:?xt=urn:btih:" + hash + "&dn=" + encodeURIComponent(name || hash);
        // Add up to 20 tracker entries to improve peer discovery
        for (var i = 0; i < TRACKERS.length && i < 20; i++) {
            m += "&tr=" + encodeURIComponent(TRACKERS[i]);
        }
        return m;
    }

    /**
     * Normalize a stream URL for deduplication comparison.
     * Strips protocol, trailing slashes, query params, and fragments.
     * For infoHash-based streams, uses the infoHash directly.
     * @param {Object} stream - StreamResult-like object
     * @returns {string} Normalized dedup key
     */
    function dedupKey(stream, addonIndex) {
        // Include addon index so different addons never dedup each other's streams
        var prefix = (addonIndex !== undefined ? addonIndex + ":" : "");
        // For torrent streams, use infoHash (case-insensitive) as dedup key
        if (stream.infoHash) return prefix + stream.infoHash.toLowerCase();
        // For URL-based streams, keep the FULL URL including query params
        // (query params often carry tokens, quality selectors, server IDs)
        var key = stream.url || "";
        key = key.replace(/^https?:\/\//, "").replace(/\/+$/, "").split("#")[0];
        return prefix + key.toLowerCase();
    }

    /**
     * Convert a Stremio content type string to SkyStream type.
     * @param {string} t - Stremio type ("movie", "series", etc.)
     * @returns {string} SkyStream type ("movie" or "series")
     */
    function skyType(t) {
        return (t === "movie" || t === "short") ? "movie" : "series";
    }

    /**
     * Map Stremio status to SkyStream status.
     * @param {string} status - Stremio status value
     * @returns {string|undefined} SkyStream status or undefined
     */
    function mapStatus(status) {
        if (!status) return undefined;
        var sv = safeStr(status).toLowerCase();
        if (sv === "ended" || sv === "canceled") return "completed";
        if (sv === "returning series" || sv === "continuing" || sv === "ongoing") return "ongoing";
        if (sv === "in production" || sv === "planned") return "upcoming";
        return undefined;
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 3: CACHE SYSTEM
    // ────────────────────────────────────────────────────────────────
    // Two-tier cache:
    //   1. In-memory (_cache object) — fast, per-session
    //   2. SkyStream preferences (setPreference/getPreference) —
    //      persists across app restarts
    //
    // Cache keys are prefixed to avoid collisions:
    //   "mf:<url>"          → Manifest data
    //   "streams:<id>"      → Pre-fetched streams
    //   "meta:<id>:<type>"  → Metadata results
    //
    // Cache entries older than CACHE_TTL are treated as expired.

    /**
     * Retrieve a cached value.
     * @param {string} key - Cache key
     * @returns {*|null} Cached data or null if not found/expired
     */
    function cacheGet(key) {
        // Check in-memory cache first
        var entry = _cache[key];
        if (entry && (Date.now() - entry.ts) < CACHE_TTL) {
            return entry.data;
        }
        // Fall back to persistent preference cache
        try {
            var raw = getPreference("hub_cache:" + key);
            if (raw) {
                var parsed = safeJson(raw, null);
                if (parsed && parsed.ts && (Date.now() - parsed.ts) < CACHE_TTL) {
                    _cache[key] = parsed; // Promote to in-memory
                    return parsed.data;
                }
            }
        } catch (e) { /* Preference API may be unavailable */ }
        return null;
    }

    /**
     * Store a value in both caches.
     * @param {string} key - Cache key
     * @param {*} data - Data to cache
     */
    function cacheSet(key, data) {
        var entry = { ts: Date.now(), data: data };
        _cache[key] = entry;
        // Evict oldest entry if cache is too large
        var keys = Object.keys(_cache);
        if (keys.length > CACHE_MAX_ENTRIES) {
            var oldest = keys[0];
            var oldestTs = _cache[oldest].ts;
            for (var i = 1; i < keys.length; i++) {
                if (_cache[keys[i]].ts < oldestTs) {
                    oldest = keys[i];
                    oldestTs = _cache[keys[i]].ts;
                }
            }
            delete _cache[oldest];
        }
        // Persist
        try {
            setPreference("hub_cache:" + key, JSON.stringify(entry));
        } catch (e) {}
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 4: RATE LIMITING
    // ────────────────────────────────────────────────────────────────

    /**
     * Check if a URL is currently rate-limited.
     * @param {string} url - The URL to check
     * @returns {boolean} true if requests should be deferred
     */
    function isRateLimited(url) {
        var rl = _rateLimits[url];
        return rl && rl.fails >= RATE_MAX_FAILS && Date.now() < rl.until;
    }

    /**
     * Record an HTTP response status for rate-limiting purposes.
     * @param {string} url - The URL that was requested
     * @param {number} status - HTTP status code
     */
    function recordResponseStatus(url, status) {
        if (status === 429 || status === 503 || status === 502 || status === 504) {
            // Server is overwhelmed — increment failure counter
            var rl = _rateLimits[url] || { fails: 0, until: 0 };
            rl.fails++;
            rl.until = Date.now() + RATE_BACKOFF_MS;
            _rateLimits[url] = rl;
            try { setPreference("hub_ratelimit:" + url, JSON.stringify(rl)); } catch (e) {}
        } else if (status >= 200 && status < 300) {
            // Success — reset failure counter
            if (_rateLimits[url]) {
                _rateLimits[url].fails = 0;
                try { setPreference("hub_ratelimit:" + url, JSON.stringify(_rateLimits[url])); } catch (e) {}
            }
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 5: HTTP LAYER
    // ────────────────────────────────────────────────────────────────
    // Uses SkyStream's native http_parallel for batch requests and
    // http_get for single requests (with redirect following).
    //
    // http_parallel fires multiple requests concurrently in Dart's
    // HTTP client (not JS), which is faster than Promise.all on fetch().

    /**
     * Build a request object for http_parallel.
     * @param {string} url - URL to fetch
     * @returns {{method: string, url: string, headers: Object}} Request config
     */
    function buildRequest(url) {
        return { method: "GET", url: url, headers: JSON_HEADERS };
    }

    /**
     * Fetch multiple URLs in parallel via native http_parallel.
     *
     * IMPORTANT: This function handles rate-limited URLs gracefully:
     * it skips them and returns a placeholder response. It also
     * records response status codes for rate limiting.
     *
     * FIX: Accepts 200 AND 206 as valid success status codes. Some
     * addons return 206 Partial Content for valid responses.
     *
     * FIX: Handles 3xx redirects by extracting Location header and
     * returning it so loadStreams can follow up. Skips HTML bodies
     * and non-JSON responses with debug logging.
     *
     * @param {string[]} urls - Array of URLs to fetch
     * @returns {Promise<Array<{url: string, ok: boolean, data: *, status: number}>>}
     */
    function httpBatch(urls) {
        if (!urls || !urls.length) return Promise.resolve([]);

        // Separate rate-limited URLs from active ones
        var activeUrls = [];
        var activeIndices = [];
        for (var i = 0; i < urls.length; i++) {
            if (!isRateLimited(urls[i])) {
                activeUrls.push(urls[i]);
                activeIndices.push(i);
            }
        }

        // If all URLs are rate-limited, return 429 immediately for all
        if (!activeUrls.length) {
            var allLimited = [];
            for (var i = 0; i < urls.length; i++) {
                allLimited.push({ url: urls[i], ok: false, data: null, status: 429 });
            }
            return Promise.resolve(allLimited);
        }

        // Build request objects for active URLs
        var requests = [];
        for (var i = 0; i < activeUrls.length; i++) {
            requests.push(buildRequest(activeUrls[i]));
        }

        // Fire requests via native parallel HTTP
        return http_parallel(requests).then(function(responses) {
            // Build full results array aligned with input urls
            var results = [];
            for (var i = 0; i < urls.length; i++) {
                results.push({ url: urls[i], ok: false, data: null, status: 0 });
            }

            for (var ri = 0; ri < responses.length; ri++) {
                var resp = responses[ri];
                var idx = activeIndices[ri];
                var entry = {
                    url: activeUrls[ri],
                    ok: false,
                    data: null,
                    status: resp ? (resp.status || resp.code || 0) : 0
                };

                // Record status for rate limiting
                recordResponseStatus(activeUrls[ri], entry.status);

                // Check for redirect (3xx): http_parallel MAY auto-follow,
                // but if not, the caller needs to know the redirect target
                if (resp && entry.status >= 300 && entry.status < 400) {
                    var location = resp.location || (resp.headers && (resp.headers.location || resp.headers.Location));
                    if (location) {
                        entry.redirectUrl = typeof location === 'string' ? location : (location.url || '');
                    }
                }

                // Parse JSON body if status is 200 or 206 (Partial Content)
                // Some addons return 206 for streaming/segment responses
                if (resp && resp.body && (entry.status === 200 || entry.status === 206)) {
                    try {
                        var body = resp.body;
                        if (typeof body === "string") {
                            body = body.trim();
                            // Ensure it's JSON (not HTML) — skip if starts with '<'
                            if (body && body.charAt(0) !== "<") {
                                entry.data = JSON.parse(body);
                                entry.ok = true;
                            } else {
                                console.warn("[Hub] httpBatch: HTML response (non-JSON) from", activeUrls[ri].substring(0, 80));
                            }
                        } else if (typeof body === "object") {
                            // http_parallel may auto-parse JSON into an object
                            entry.data = body;
                            entry.ok = true;
                        }
                    } catch (parseErr) {
                        console.warn("[Hub] httpBatch: JSON parse error for", activeUrls[ri].substring(0, 80), parseErr.message);
                    }
                } else if (resp && entry.status !== 200 && entry.status !== 206 && entry.status !== 0) {
                    // Non-success status — log for debugging (skip 0 = connection error)
                    if (entry.status >= 400) {
                        console.warn("[Hub] httpBatch: HTTP " + entry.status + " from", activeUrls[ri].substring(0, 80));
                    }
                }
                results[idx] = entry;
            }
            return results;
        }).catch(function(err) {
            console.error("[Hub] httpBatch: http_parallel threw:", err.message || err);
            var fallback = [];
            for (var i = 0; i < urls.length; i++) {
                fallback.push({ url: urls[i], ok: false, data: null, status: 0 });
            }
            return fallback;
        });
    }

    /**
     * Fetch a single URL with JSON response and redirect following.
     * Uses http_get which is a native SkyStream helper.
     *
     * @param {string} url - URL to fetch
     * @param {number} [timeoutMs=8000] - Timeout in milliseconds
     * @returns {Promise<*>} Parsed JSON body
     * @throws {Error} On HTTP error, empty body, or timeout
     */
    function fetchJson(url, timeoutMs) {
        timeoutMs = timeoutMs || META_TIMEOUT;
        return new Promise(function(resolve, reject) {
            var timedOut = false;
            var timer = setTimeout(function() {
                timedOut = true;
                reject(new Error("Timeout fetching: " + url));
            }, timeoutMs);

            http_get(url, JSON_HEADERS).then(function(response) {
                if (timedOut) return;
                clearTimeout(timer);

                if (!response || !response.body) {
                    return reject(new Error("Empty response from: " + url));
                }

                recordResponseStatus(url, response.status || 0);

                // Handle redirects (3xx)
                if (response.status >= 300 && response.status < 400) {
                    var location = response.location ||
                        (response.headers && (response.headers.location || response.headers.Location));
                    // Try to find a URL in the body (common for HTML redirects)
                    if (typeof response.body === 'string' && response.body.indexOf('Redirecting') !== -1) {
                        var match = response.body.match(/https?:\/\/[^\s"']+/);
                        if (match) location = match[0];
                    }
                    if (location) {
                        var redirectUrl = typeof location === 'string' ? location : (location.url || '');
                        if (redirectUrl.indexOf('http') !== 0) {
                            try { redirectUrl = new URL(url).origin + redirectUrl; } catch (e) {}
                        }
                        // Follow redirect recursively (limit to avoid loops)
                        return fetchJson(redirectUrl, timeoutMs).then(resolve, reject);
                    }
                }

                // Validate response
                if (response.status !== 200 && response.status !== 304) {
                    return reject(new Error("HTTP " + response.status + " from: " + url));
                }

                var body = response.body;
                if (typeof body === "string") {
                    body = body.trim();
                    if (!body) return reject(new Error("Empty body from: " + url));
                    if (body.charAt(0) === "<") return reject(new Error("HTML response (expected JSON) from: " + url));
                    return resolve(JSON.parse(body));
                }
                resolve(body);
            }).catch(function(err) {
                if (timedOut) return;
                clearTimeout(timer);
                reject(err);
            });
        });
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 6: ADDON MANIFEST ACCESSORS
    // ────────────────────────────────────────────────────────────────
    // These read the `catalogueAddons` and `streamingAddons` arrays
    // from the plugin.json manifest. These are injected at runtime by
    // SkyStream as `manifest.catalogueAddons` and `manifest.streamingAddons`.

    /**
     * Get the list of catalogue addon URLs (for browsing/searching).
     * @returns {string[]}
     */
    function getCatalogueAddons() {
        try {
            if (manifest && Array.isArray(manifest.catalogueAddons)) return manifest.catalogueAddons;
        } catch (e) {}
        return [];
    }

    /**
     * Get the list of streaming addon URLs (for stream resolution).
     * @returns {string[]}
     */
    function getStreamingAddons() {
        try {
            if (manifest && Array.isArray(manifest.streamingAddons)) return manifest.streamingAddons;
        } catch (e) {}
        return [];
    }

    /**
     * Fetch the manifest for a given addon URL, with caching.
     * @param {string} url - Manifest URL
     * @returns {Promise<Object|null>} Parsed manifest or null on failure
     */
    function getManifest(url) {
        var cacheKey = "mf:" + url;
        var cached = cacheGet(cacheKey);
        if (cached) return Promise.resolve(cached);
        if (isRateLimited(url)) return Promise.resolve(null);

        return fetchJson(url, META_TIMEOUT).then(function(data) {
            if (data) cacheSet(cacheKey, data);
            return data;
        }).catch(function() {
            return null;
        });
    }

    /**
     * Fetch manifests for multiple addons in parallel.
     * Uses cache when available.
     *
     * @param {string[]} urls - Array of manifest URLs
     * @returns {Promise<Array<{url: string, manifest: Object|null, index: number}>>}
     */
    function fetchManifests(urls) {
        var results = [];
        var uncachedUrls = [];
        var uncachedIndices = [];

        for (var i = 0; i < urls.length; i++) {
            var cached = cacheGet("mf:" + urls[i]);
            if (cached) {
                results[i] = { url: urls[i], manifest: cached, index: i };
            } else {
                results[i] = null;
                uncachedUrls.push(urls[i]);
                uncachedIndices.push(i);
            }
        }

        if (uncachedUrls.length === 0) {
            return Promise.resolve(results.filter(function(r) { return r !== null; }));
        }

        return httpBatch(uncachedUrls).then(function(batchResults) {
            for (var j = 0; j < batchResults.length; j++) {
                var idx = uncachedIndices[j];
                if (batchResults[j].ok && batchResults[j].data) {
                    cacheSet("mf:" + uncachedUrls[j], batchResults[j].data);
                    results[idx] = { url: uncachedUrls[j], manifest: batchResults[j].data, index: idx };
                }
            }
            return results.filter(function(r) { return r !== null; });
        });
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 7: VIDEO ID PARSING
    // ────────────────────────────────────────────────────────────────
    // Stremio uses video IDs in multiple formats:
    //   - Plain IMDb ID: "tt1254207"
    //   - Series episode: "tt0386676:1:1" (seriesImdbId:season:episode)
    //   - Service-prefixed: "kitsu:7442", "tmdb:12345"
    //   - JSON-encoded: '{"i":"tt1254207","t":"movie","s":1,"e":1}'
    //   - TMDB object: '{"tmdbId":1234,"mediaType":"movie","seasonNumber":1,"episodeNumber":1}'
    //
    // The parser is conservative: it only returns deterministic guesses.
    // When the type is uncertain, it returns type: null so load() will
    // try all available types.

    /**
     * Parse a video ID string into structured components.
     *
     * @param {string} raw - Raw video ID from Stremio
     * @returns {{id: string, type: string|null, season: number, episode: number}|null}
     *   - id: The base content ID (IMDb, TMDB, etc.)
     *   - type: "movie", "series", or null if unknown
     *   - season: Season number (0 if not applicable)
     *   - episode: Episode number (0 if not applicable)
     */
    function parseVideoId(raw) {
        if (!raw) return null;

        // Try JSON-encoded IDs (some addons use these)
        var parsed = safeJson(raw, null);
        if (parsed && parsed.i !== undefined) {
            // Format: {"i":"tt1254207","t":"movie","s":1,"e":1}
            return {
                id: safeStr(parsed.i),
                type: parsed.t || null,
                season: parsed.s || 0,
                episode: parsed.e || 0
            };
        }
        if (parsed && parsed.tmdbId !== undefined) {
            // Format: {"tmdbId":1234,"mediaType":"movie","seasonNumber":1,"episodeNumber":1}
            return {
                id: safeStr(parsed.tmdbId),
                type: parsed.mediaType || null,
                season: parsed.seasonNumber || 0,
                episode: parsed.episodeNumber || 0
            };
        }

        // Try colon-separated format: "tt0386676:1:1" or "kitsu:7442"
        if (raw.indexOf(":") !== -1) {
            var parts = raw.split(":");
            var first = parts[0];

            // IMDb series episode: "ttXXXXXX:season:episode"
            if (/^tt\d+$/.test(first) && parts.length >= 3) {
                var sn = parseInt(parts[1], 10);
                var en = parseInt(parts[2], 10);
                return {
                    id: first,
                    type: "series",
                    season: isNaN(sn) ? 0 : sn,
                    episode: isNaN(en) ? 0 : en
                };
            }

            // Service-prefixed ID: "kitsu:7442", "tmdb:1234" — type unknown
            if (/^[a-zA-Z]+$/.test(first) && parts.length >= 2) {
                return {
                    id: raw,   // Preserve full prefixed ID for addon matching
                    type: null, // Unknown type — will try all types in load()
                    season: 0,
                    episode: 0
                };
            }

            // Unknown colon format — could be a series
            return {
                id: raw,
                type: null,
                season: 0,
                episode: 0
            };
        }

        // Bare IMDb ID
        if (/^tt\d+$/.test(raw)) {
            return {
                id: raw,
                type: null, // Could be movie or series — let load() figure it out
                season: 0,
                episode: 0
            };
        }

        // Everything else — raw passthrough
        return {
            id: raw,
            type: null,
            season: 0,
            episode: 0
        };
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 8: METADATA → SKYSTREAM CONVERTERS
    // ────────────────────────────────────────────────────────────────

    /**
     * Extract a release year from Stremio metadata.
     * @param {Object} meta - Stremio meta object
     * @returns {number|undefined}
     */
    function parseYear(meta) {
        if (!meta) return undefined;
        if (meta.year != null) {
            var y = parseInt(meta.year, 10);
            if (y > 1900 && y < 2100) return y;
        }
        if (meta.releaseInfo) {
            var parts = safeStr(meta.releaseInfo).split(/[–-]/).shift().trim();
            var y = parseInt(parts, 10);
            if (y > 1900 && y < 2100) return y;
        }
        return undefined;
    }

    /**
     * Extract a rating from Stremio metadata.
     * @param {Object} meta - Stremio meta object
     * @returns {number|undefined}
     */
    function parseRating(meta) {
        if (!meta) return undefined;
        if (meta.imdbRating != null) {
            var r = parseFloat(meta.imdbRating);
            if (!isNaN(r) && r >= 0 && r <= 10) return r;
        }
        if (meta.score != null) {
            var r = parseFloat(meta.score);
            if (!isNaN(r) && r >= 0 && r <= 10) return r;
        }
        return undefined;
    }

    /**
     * Extract genres/tags from metadata.
     * @param {Object} meta
     * @returns {string[]|undefined}
     */
    function parseGenres(meta) {
        if (!meta) return undefined;
        var g = meta.genres || meta.genre || meta.tags;
        return (Array.isArray(g) && g.length) ? g : undefined;
    }

    /**
     * Convert a Stremio meta/catalog item to a SkyStream MultimediaItem.
     * Used for catalog and search results (thumbnails, not full detail).
     *
     * @param {Object} m - Stremio meta object
     * @param {string} [fallbackType] - Type to use if not specified in metadata
     * @returns {Object|null} SkyStream MultimediaItem or null if invalid
     */
    function toItem(m, fallbackType) {
        try {
            if (!m || !m.id) return null;
            return new MultimediaItem({
                title: m.name || m.title || m.originalName || "Unknown",
                url: m.id || "",
                posterUrl: m.poster || m.posterUrl || m.thumbnail || "",
                bannerUrl: m.background || m.backdrop || m.banner || m.bannerUrl || "",
                logoUrl: m.logo || m.logoUrl || "",
                type: skyType(m.type || fallbackType || "movie"),
                description: safeStr(m.description || m.overview || m.synopsis || "")
                    .replace(/<[^>]*>/g, "").trim().substring(0, 500),
                year: parseYear(m),
                score: parseRating(m),
                genres: parseGenres(m)
            });
        } catch (e) {
            return null;
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 9: STREAM QUALITY PARSER
    // ────────────────────────────────────────────────────────────────
    // Analyzes stream name/title/description to extract:
    //   - Resolution (4K, 1080p, 720p, etc.)
    //   - Video codec (HEVC, H.264, AV1, etc.)
    //   - HDR type (Dolby Vision, HDR10, HDR10+)
    //   - Audio format (Atmos, DTS-HD, AAC, etc.)
    //   - Audio channels (5.1, 7.1, 2.0)
    //   - Source type (torrent, HTTP, YouTube)

    /**
     * Parse technical features from a stream name/description.
     * @param {string} text - Combined name + title + description text
     * @returns {{resolution: string, codec: string|null, hdr: string|null,
     *           audio: string|null, channels: string|null, sourceType: string,
     *           _sortKey: number}}
     */
    function parseStreamFeatures(text) {
        var result = {
            resolution: "Auto",
            codec: null,
            hdr: null,
            audio: null,
            channels: null,
            sourceType: "unknown",
            _sortKey: 2 // Default mid-range
        };
        if (!text) return result;

        var str = text.toLowerCase();

        // ── Resolution detection (higher _sortKey = higher quality) ──
        if (/\b(2160|4k|uhd)\b/.test(str))              { result.resolution = "4K";    result._sortKey = 5; }
        else if (/\b1440\b/.test(str))                  { result.resolution = "1440p"; result._sortKey = 4; }
        else if (/\b1080\b/.test(str))                  { result.resolution = "1080p"; result._sortKey = 3; }
        else if (/\b720\b/.test(str))                   { result.resolution = "720p";  result._sortKey = 2; }
        else if (/\b480\b/.test(str))                   { result.resolution = "480p";  result._sortKey = 1; }
        else if (/\b360\b/.test(str))                   { result.resolution = "360p";  result._sortKey = 1; }
        else if (/\b(cam|ts|tc|scr|workprint|hqcam)\b/.test(str)) { result.resolution = "CAM"; result._sortKey = 0; }

        // ── Video codec ──
        if (/\b(av1|av01)\b/.test(str))                 result.codec = "AV1";
        else if (/\b(x?v?265|hevc)\b/.test(str))        result.codec = "HEVC";
        else if (/\b(x264|h\.?264|avc)\b/.test(str))    result.codec = "H.264";
        else if (/\b(vp9|vp9\.2)\b/.test(str))          result.codec = "VP9";
        else if (/\b(vc[\s-]?1|vc1)\b/.test(str))       result.codec = "VC-1";
        else if (/\b(xvid|divx)\b/.test(str))           result.codec = "XviD";

        // ── HDR / Dolby Vision ──
        if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(str))          result.hdr = "DV";
        else if (/\bhdr10\+\b/.test(str))                            result.hdr = "HDR10+";
        else if (/\bhdr10\b/.test(str))                              result.hdr = "HDR10";
        else if (/\bhdr\b/.test(str))                                result.hdr = "HDR";
        if (/\bhlg\b/.test(str))                                     result.hdr = result.hdr ? result.hdr + "+HLG" : "HLG";

        // ── Audio format ──
        if (/\b(atmos|truehd)\b/.test(str))                          result.audio = "Atmos";
        else if (/\bdts[-\s]?hd\b/.test(str))                        result.audio = "DTS-HD";
        else if (/\bdts\b/.test(str))                                result.audio = "DTS";
        else if (/\b(flac|lpcm)\b/.test(str))                        result.audio = "FLAC";
        else if (/\b(e?aac)\b/.test(str))                            result.audio = "AAC";
        else if (/\bmp3\b/.test(str))                                result.audio = "MP3";
        else if (/\bopus\b/.test(str))                               result.audio = "Opus";

        // ── Audio channels ──
        var ch = str.match(/\b[257]\.1\b/);
        if (ch) result.channels = ch[0];

        // ── Source type ──
        if (/\btorrent\b/.test(str) || /\binfohash\b/.test(str))     result.sourceType = "torrent";
        else if (/\bhttp\b/.test(str) || /\bhls\b/.test(str) ||
                 /\bm3u8\b/.test(str) || /\bmpd\b/.test(str))       result.sourceType = "http";
        else if (/\byoutube\b/.test(str) || /\bytId\b/.test(str))   result.sourceType = "youtube";

        return result;
    }

    /**
     * Build a human-readable stream title line for the SkyStream UI.
     * Example: "[Torrentio] 1080p HEVC 5.1 | Movie Name"
     *
     * @param {Object} features - Result from parseStreamFeatures()
     * @param {string} addonName - Name of the source addon
     * @param {string} originalTitle - Original stream title from addon
     * @returns {string} Formatted display string
     */
    function buildStreamTitle(features, addonName, originalTitle) {
        var parts = [];

        // Addon source tag (makes it clear where the stream came from)
        parts.push("[" + addonName + "]");

        // Resolution + codec + HDR + audio
        var tech = features.resolution;
        if (features.codec) tech += " " + features.codec;
        if (features.hdr) tech += " " + features.hdr;
        if (features.audio) tech += " " + features.audio;
        if (features.channels) tech += " " + features.channels;
        parts.push(tech);

        // Append original title as context (truncated to avoid clutter)
        var cleanTitle = (originalTitle || "")
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 60);
        if (cleanTitle) {
            parts.push("| " + cleanTitle);
        }

        return parts.join(" ");
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 10: STREAM FORMATTING ENGINE
    // ────────────────────────────────────────────────────────────────
    // Converts a raw Stremio stream object into a SkyStream StreamResult.
    // Handles:
    //   - Direct HTTP/HTTPS URLs (with optional headers)
    //   - HLS (.m3u8) and DASH (.mpd) streams
    //   - Torrent (infoHash) with magnet link generation
    //   - YouTube video IDs
    //   - External URLs (e.g., Netflix links)
    //   - Usenet (NZB) streams
    //   - Archive-based streams (RAR, ZIP, 7z, TGZ, TAR)
    //
    // IMPORTANT: Subtitles embedded in streams (stream.subtitles) are
    // passed through to SkyStream's subtitle array.

    /**
     * Format a single raw stream object from a Stremio addon into a
     * SkyStream-compatible StreamResult.
     *
     * @param {Object} stream - Raw stream object from Stremio addon response
     * @param {number} addonIndex - 0-based index of the source addon
     * @param {string} baseUrl - Base URL of the addon (for Referer/Origin headers)
     * @param {string} [addonDisplayName] - Human-readable addon name for the [Tag]
     * @returns {Object|null} SkyStream StreamResult or null if invalid
     */
    function formatStream(stream, addonIndex, baseUrl, addonDisplayName) {
        try {
            if (!stream) return null;

            // Gather original fields — Stremio addons use various field combinations:
            // - `name`: short label (addon brand + quality, sometimes just quality)
            // - `title`: main description (filename, size, source, codec)
            // - `description`: alternate description (some addons like HdHub use this)
            var origName = safeStr(stream.name).trim();
            var origTitle = safeStr(stream.title).trim();
            var origDesc = safeStr(stream.description).trim();

            // Flatten for feature parsing
            var fl = function(s) { return s.replace(/\n/g, " ").replace(/\s+/g, " ").trim(); };
            var combined = fl(origName) + " " + fl(origTitle) + " " + fl(origDesc);
            var features = parseStreamFeatures(combined);

            // Build display: [AddonTag] NameContent | TitleContent
            // This faithfully reproduces Stremio's two-line (name + title) layout
            var addonLabel = addonDisplayName || ("#" + addonIndex);
            var addonTag = "[" + addonLabel + "]";
            var displayParts = [];

            // Collect name content (brand, quality badges)
            if (origName) {
                var nameSegs = origName.split("\n");
                for (var ni = 0; ni < nameSegs.length; ni++) {
                    var ns = nameSegs[ni].trim();
                    if (ns) displayParts.push(ns);
                }
            }

            // Collect title/description content (filename, size, source, codec)
            var contentText = origTitle || origDesc;
            if (contentText) {
                var segs = contentText.split("\n");
                for (var si = 0; si < segs.length; si++) {
                    var s = segs[si].trim();
                    if (s) displayParts.push(s);
                }
            }

            var displaySource = displayParts.length > 0
                ? addonTag + " " + displayParts.join(" | ")
                : addonTag;

            // Prepare headers (combine addon headers with stream-specific ones)
            var headers = {};

            // If the stream has behaviorHints with proxyHeaders, use those
            if (stream.behaviorHints) {
                if (stream.behaviorHints.proxyHeaders && stream.behaviorHints.proxyHeaders.request) {
                    headers = Object.assign({}, stream.behaviorHints.proxyHeaders.request);
                }
            }

            // Ensure common headers are present
            if (!headers["User-Agent"]) headers["User-Agent"] = UA;
            if (!headers["Referer"]) headers["Referer"] = baseUrl + "/";
            if (!headers["Origin"]) headers["Origin"] = baseUrl;

            // Copy behaviorHints but remove proxyHeaders/headers (they're extracted above)
            var bh = {};
            if (stream.behaviorHints) {
                // Copy all behaviorHints properties
                for (var key in stream.behaviorHints) {
                    if (stream.behaviorHints.hasOwnProperty(key)) {
                        if (key !== "proxyHeaders" && key !== "headers") {
                            bh[key] = stream.behaviorHints[key];
                        }
                    }
                }
            }

            // CRITICAL: Preserve subtitle information from the stream
            // Stremio allows streams to carry their own subtitles (e.g., from
            // torrent files or embedded tracks). We MUST pass these through
            // to the SkyStream StreamResult so users get subtitles.
            var subs = undefined;
            if (stream.subtitles && Array.isArray(stream.subtitles) && stream.subtitles.length > 0) {
                subs = [];
                for (var si = 0; si < stream.subtitles.length; si++) {
                    var sub = stream.subtitles[si];
                    if (sub && sub.url && sub.lang) {
                        subs.push({ url: sub.url, label: sub.lang, lang: sub.lang });
                    }
                }
                if (subs.length === 0) subs = undefined;
            }

            // ── Stream type detection and conversion ──

            // ── Filter out obviously non-video URLs ──
            // Some addons return "no streams found" messages as data: URLs,
            // login pages, or other junk. Skip those.
            if (stream.url) {
                var urlLower = stream.url.toLowerCase();
                // Skip data: URLs that are plain text (error messages)
                if (urlLower.indexOf("data:text/plain") === 0) return null;
                // Skip login/logout pages
                if (urlLower.indexOf("/login.") !== -1 || urlLower.indexOf("/logout") !== -1) return null;
                // Skip magnet URLs that have no hash info at all (truly invalid)
                // But allow magnets with urn:btih: in the URL even without infoHash field
                if (urlLower.indexOf("magnet:") === 0 && !stream.infoHash &&
                    urlLower.indexOf("urn:btih:") === -1 && urlLower.indexOf("btih=") === -1) return null;
            }

            // Type 1: Direct HTTP(S) URL
            if (stream.url && isHttp(stream.url)) {
                var isDirectMedia = /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(stream.url);
                var isStreamingPlaylist = /\.(m3u8|mpd)(\?|$)/i.test(stream.url);
                var isMaybeProxied = /(extract|proxy|redirect|gateway|fetch|resolve)/i.test(stream.url);

                // If the stream needs custom headers and is NOT a direct media file,
                // use SkyStream's MAGIC_PROXY_v1 for header injection
                var hasExtraHeaders = Object.keys(headers).length > 1;
                var finalUrl = stream.url;
                if (hasExtraHeaders && !isDirectMedia) {
                    finalUrl = "MAGIC_PROXY_v1" + btoa(stream.url);
                }

                // Set notWebReady=true for non-direct media (HLS, DASH, proxied)
                if (!bh.notWebReady && (!isDirectMedia || isMaybeProxied || isStreamingPlaylist)) {
                    bh.notWebReady = true;
                }

                var result = new StreamResult({
                    url: finalUrl,
                    quality: features.resolution,
                    source: displaySource,
                    cached: !!stream.cached,
                    size: stream.size || null,
                    headers: headers,
                    behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
                    subtitles: subs,  // ← Pass through subtitles
                    _sortKey: features._sortKey
                });

                // Add Origin for streaming playlists
                if (isStreamingPlaylist && !result.headers["Origin"]) {
                    try { result.headers["Origin"] = new URL(stream.url).origin; } catch (e) {}
                }

                return result;
            }

            // Type 2: Torrent (infoHash)
            if (stream.infoHash) {
                var filename = (stream.behaviorHints && stream.behaviorHints.filename) ||
                    stream.title || stream.name || "";
                if (Object.keys(bh).length === 0) bh = { notWebReady: true };

                    return new StreamResult({
                        url: magnetLink(stream.infoHash, filename),
                        infoHash: stream.infoHash,
                        fileIndex: stream.fileIdx !== undefined ? stream.fileIdx : 0,
                        quality: features.resolution,
                        source: displaySource,
                        headers: headers,
                        behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
                        subtitles: subs,  // ← Pass through subtitles
                        _sortKey: features._sortKey
                    });
            }

            // Type 3: YouTube
            if (stream.ytId) {
                return new StreamResult({
                    url: "https://www.youtube.com/watch?v=" + stream.ytId,
                    quality: "YouTube",
                    source: addonTag + " YouTube",
                    headers: { "Referer": "https://www.youtube.com/", "User-Agent": UA },
                    behaviorHints: { notWebReady: true },
                    _sortKey: 1
                });
            }

            // Type 4: External URL (opens in browser) — pass through ALL external URLs
            if (stream.externalUrl) {
                if (Object.keys(bh).length === 0) bh = { notWebReady: true };
                return new StreamResult({
                    url: stream.externalUrl,
                    quality: features.resolution,
                    source: addonTag + " External",
                    headers: headers,
                    behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
                    _sortKey: features._sortKey
                });
            }

            // Type 5: Usenet (NZB)
            if (stream.nzbUrl) {
                if (Object.keys(bh).length === 0) bh = { notWebReady: true };
                    return new StreamResult({
                        url: stream.nzbUrl,
                        quality: features.resolution,
                        source: addonTag + " Usenet",
                    headers: headers,
                    behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
                    _sortKey: features._sortKey
                });
            }

            // Type 6: Archive-based streams (RAR, ZIP, 7z, TGZ, TAR)
            var archiveTypes = [
                { key: "rarUrls", label: "RAR" },
                { key: "zipUrls", label: "ZIP" },
                { key: "7zipUrls", label: "7z" },
                { key: "tgzUrls", label: "TGZ" },
                { key: "tarUrls", label: "TAR" }
            ];
            for (var ai = 0; ai < archiveTypes.length; ai++) {
                if (Array.isArray(stream[archiveTypes[ai].key]) && stream[archiveTypes[ai].key].length) {
                    var src = stream[archiveTypes[ai].key][0];
                    var srcUrl = (typeof src === "string") ? src : (src.url || "");
                    if (srcUrl) {
                        if (Object.keys(bh).length === 0) bh = { notWebReady: true };
                        return new StreamResult({
                            url: srcUrl,
                            quality: features.resolution,
                            source: addonTag + " " + archiveTypes[ai].label,
                            headers: headers,
                            behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
                            _sortKey: features._sortKey
                        });
                    }
                }
            }

            // Type 7: Fallback — raw URL (could be magnet, etc.)
            if (stream.url) {
                var hash = null;
                // Check if it's a magnet URI
                if (stream.url.indexOf("magnet:?xt=urn:btih:") === 0) {
                    var magnetMatch = stream.url.match(/urn:btih:([a-fA-F0-9]+)/);
                    if (magnetMatch) hash = magnetMatch[1].toLowerCase();
                }
                if (Object.keys(bh).length === 0 && (hash || stream.url.indexOf("magnet:") === 0)) {
                    bh = { notWebReady: true };
                }
                var fallbackResult = new StreamResult({
                    url: stream.url,
                    quality: features.resolution,
                    source: displaySource,
                    headers: headers,
                    behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
                    subtitles: subs,  // ← Pass through subtitles
                    _sortKey: features._sortKey
                });
                if (hash) { fallbackResult.infoHash = hash; fallbackResult.fileIndex = 0; }
                return fallbackResult;
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Process an array of raw streams from a single addon response.
     * Filters invalid entries and formats each one.
     *
     * @param {Array} streams - Raw stream objects
     * @param {number} addonIndex - 0-based index of the source addon
     * @param {string} baseUrl - Source addon base URL
     * @param {string} [addonDisplayName] - Human-readable addon name
     * @returns {Array<Object>} Formatted StreamResult objects
     */
    function processStreams(streams, addonIndex, baseUrl, addonDisplayName) {
        if (!Array.isArray(streams)) return [];
        var out = [];
        for (var i = 0; i < streams.length; i++) {
            try {
                var formatted = formatStream(streams[i], addonIndex, baseUrl, addonDisplayName);
                if (formatted) out.push(formatted);
            } catch (e) {
                console.warn("[Hub] processStreams: error formatting stream", i, "from addon", addonIndex, e.message);
            }
        }
        return out;
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 11: getHome() — Dashboard Catalogs
    // ────────────────────────────────────────────────────────────────
    //
    // Fetches catalog data from all catalogueAddons and organizes them
    // into named categories. The "Trending" category gets special
    // treatment (Hero Carousel in SkyStream).
    //
    // Pagination: pages are 1-indexed. Each page returns up to 20 items
    // per catalog. The `skip` extra parameter is used for pagination.
    //
    // CACHING: Manifest requests are cached (10 min TTL). Catalog
    // responses are NOT cached by us (Stremio addons should set their
    // own cacheMaxAge).

    /**
     * @param {Function} cb - Callback with { success, data, page }
     * @param {string|number} [page] - Page number (1-indexed)
     */
    async function getHome(cb, page) {
        try {
            var pageNum = parseInt(page) || 1;
            var addonUrls = getCatalogueAddons();

            if (!addonUrls.length) {
                return cb({
                    success: false,
                    errorCode: "NO_ADDONS",
                    message: "No catalogueAddons configured in plugin.json"
                });
            }

            // Step 1: Fetch all addon manifests (with caching)
            var manifests = await fetchManifests(addonUrls);

            if (!manifests.length) {
                return cb({
                    success: false,
                    errorCode: "NO_DATA",
                    message: "Could not fetch any addon manifests"
                });
            }

            // Step 2: Build catalog URLs from manifest definitions
            var catalogJobs = [];
            for (var mi = 0; mi < manifests.length; mi++) {
                var mf = manifests[mi].manifest;
                var addonBaseUrl = baseUrl(manifests[mi].url);

                if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;

                for (var ci = 0; ci < mf.catalogs.length; ci++) {
                    var cat = mf.catalogs[ci];
                    if (!cat || !cat.id || !cat.type) continue;

                    // Skip catalogs that require search (they're for search(), not browsing)
                    var extras = cat.extra || [];
                    var requiresSearch = extras.some(function(e) {
                        return e && e.name === "search" && e.isRequired === true;
                    });
                    if (requiresSearch) continue;

                    // Build catalog URL with optional pagination
                    var catUrl = addonBaseUrl + "/catalog/" + cat.type + "/" + cat.id + ".json";
                    if (pageNum > 1) {
                        var skip = (pageNum - 1) * CATALOG_PAGE_SIZE;
                        catUrl += (catUrl.indexOf("?") === -1 ? "?" : "&") + "skip=" + skip;
                    }

                    catalogJobs.push({
                        url: catUrl,
                        addonIndex: mi,
                        categoryName: cat.name || cat.id,
                        categoryType: cat.type
                    });
                }
            }

            if (!catalogJobs.length) {
                return cb({
                    success: false,
                    errorCode: "NO_DATA",
                    message: "No browsable catalogs found in addon manifests"
                });
            }

            // Step 3: Fetch all catalogs in parallel
            var catalogUrls = catalogJobs.map(function(j) { return j.url; });
            var catalogResponses = await httpBatch(catalogUrls);

            // Step 4: Organize results by category name (preserving addon priority order)
            var organizedData = {};
            var categoryOrder = [];

            for (var ri = 0; ri < catalogResponses.length; ri++) {
                var response = catalogResponses[ri];
                var job = catalogJobs[ri];

                if (!response.ok || !response.data ||
                    !Array.isArray(response.data.metas) || !response.data.metas.length) {
                    continue;
                }

                // Convert Stremio meta items to SkyStream MultimediaItems
                var items = response.data.metas
                    .map(function(m) { return toItem(m, job.categoryType); })
                    .filter(Boolean);

                if (!items.length) continue;

                // Use the category name as the key
                var catLabel = job.categoryName;

                // Only add category if not already seen (first addon wins)
                if (!organizedData[catLabel]) {
                    organizedData[catLabel] = items;
                    categoryOrder.push(catLabel);
                }
            }

            var categoryCount = Object.keys(organizedData).length;
            if (categoryCount === 0) {
                return cb({
                    success: false,
                    errorCode: "NO_DATA",
                    message: "No catalog data returned from any addon"
                });
            }

            // Step 5: Build the response preserving the order categories were discovered
            var finalData = {};
            for (var i = 0; i < categoryOrder.length; i++) {
                if (organizedData[categoryOrder[i]]) {
                    finalData[categoryOrder[i]] = organizedData[categoryOrder[i]];
                }
            }

            cb({ success: true, data: finalData, page: pageNum });

        } catch (e) {
            console.error("[Hub] getHome error:", e.message || e);
            cb({
                success: false,
                errorCode: "HOME_ERROR",
                message: safeStr(e.message || e)
            });
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 12: search() — Multi-Addon Search
    // ────────────────────────────────────────────────────────────────
    //
    // Strategy:
    //   1. First, try addon-native search (catalogs with `search` extra parameter)
    //   2. If no addons support native search, fall back to filtering browse catalogs
    //   3. Results are deduplicated and capped at MAX_SEARCH_RESULTS
    //
    // Addons that support search have a catalog with `{ name: "search" }` in their
    // `extra` array. We send `search=<query>` as a URL parameter.

    /**
     * @param {string} query - Search text from the user
     * @param {Function} cb - Callback with { success, data }
     */
    async function search(query, cb) {
        try {
            var q = safeStr(query).trim().toLowerCase();
            if (!q) return cb({ success: true, data: [] });

            var addonUrls = getCatalogueAddons();
            if (!addonUrls.length) return cb({ success: true, data: [] });

            // Step 1: Fetch manifests (cached)
            var manifests = await fetchManifests(addonUrls);

            // Step 2: Build search URLs
            var searchJobs = [];
            for (var mi = 0; mi < manifests.length; mi++) {
                var mf = manifests[mi].manifest;
                var addonBaseUrl = baseUrl(manifests[mi].url);

                if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;

                var searchCats = [];   // Catalogs with native search support
                var browseCats = [];   // Catalogs without search (for fallback)

                for (var ci = 0; ci < mf.catalogs.length; ci++) {
                    var cat = mf.catalogs[ci];
                    if (!cat || !cat.id || !cat.type) continue;
                    var extras = cat.extra || [];
                    if (extras.some(function(e) { return e && e.name === "search"; })) {
                        searchCats.push(cat);
                    } else if (browseCats.length < 5) {
                        // Limit fallback catalogs to 5 per addon to avoid excessive requests
                        browseCats.push(cat);
                    }
                }

                // Add search-enabled catalogs with the search query parameter
                for (var si = 0; si < searchCats.length; si++) {
                    searchJobs.push({
                        url: addonBaseUrl + "/catalog/" + searchCats[si].type + "/" +
                             searchCats[si].id + "/search=" + encodeURIComponent(query) + ".json",
                        catType: searchCats[si].type,
                        isSearch: true
                    });
                }

                // Add browse catalogs as fallback
                for (var bi = 0; bi < browseCats.length; bi++) {
                    searchJobs.push({
                        url: addonBaseUrl + "/catalog/" + browseCats[bi].type + "/" +
                             browseCats[bi].id + ".json",
                        catType: browseCats[bi].type,
                        isSearch: false
                    });
                }
            }

            if (!searchJobs.length) return cb({ success: true, data: [] });

            // Step 3: Fire all search requests in parallel
            var urls = searchJobs.map(function(j) { return j.url; });
            var responses = await httpBatch(urls);

            // Step 4: Collect results (deduplicated)
            var allItems = [];
            var seenUrls = {};

            function addItem(item) {
                if (item && item.url && !seenUrls[item.url]) {
                    seenUrls[item.url] = true;
                    allItems.push(item);
                }
            }

            // First pass: collect native search results
            var foundSearch = false;
            for (var ri = 0; ri < responses.length && allItems.length < MAX_SEARCH_RESULTS; ri++) {
                var resp = responses[ri];
                var job = searchJobs[ri];
                if (!resp.ok || !resp.data || !job.isSearch) continue;

                if (Array.isArray(resp.data.metas) && resp.data.metas.length) {
                    foundSearch = true;
                    for (var mi = 0; mi < resp.data.metas.length && allItems.length < MAX_SEARCH_RESULTS; mi++) {
                        addItem(toItem(resp.data.metas[mi], job.catType));
                    }
                }
            }

            // Second pass (if no native search): filter browse catalogs by keyword
            if (!foundSearch) {
                for (var ri = 0; ri < responses.length && allItems.length < MAX_SEARCH_RESULTS; ri++) {
                    var resp = responses[ri];
                    var job = searchJobs[ri];
                    if (job.isSearch || !resp.ok || !resp.data || !Array.isArray(resp.data.metas)) continue;

                    for (var mi = 0; mi < resp.data.metas.length && allItems.length < MAX_SEARCH_RESULTS; mi++) {
                        var m = resp.data.metas[mi];
                        var name = safeStr(m.name || m.title || "").toLowerCase();
                        if (name.indexOf(q) !== -1) {
                            addItem(toItem(m, job.catType));
                        }
                    }
                }
            }

            cb({ success: true, data: allItems.slice(0, MAX_SEARCH_RESULTS) });

        } catch (e) {
            console.error("[Hub] search error:", e.message || e);
            cb({ success: true, data: [] });
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 13: load() — Full Metadata + Episode Resolution
    // ────────────────────────────────────────────────────────────────
    //
    // This is the most critical function for fixing the "wrong movie" bug.
    //
    // PROBLEM: The old code queried ALL types (movie, series, anime, etc.)
    // across ALL addons and stopped at the first non-movie result. This
    // could pick up metadata for a completely different movie/series from
    // a different addon if that addon returned fallback data.
    //
    // SOLUTION:
    //   1. Parse the video ID to determine known type from the ID format
    //   2. Query each addon ONLY for relevant types (known type first,
    //      then fallback to all types if no known type)
    //   3. Score results: prefer exact ID matches, prefer addons whose
    //      idPrefixes match the ID
    //   4. After finding metadata, also pre-fetch streams in the background
    //      (cached for instant playback)
    //
    // The respondMeta() helper handles converting Stremio metadata to
    // SkyStream MultimediaItem format, including episode list for series.

    /**
     * @param {string} url - Video ID (plain ID or colon-separated season:episode)
     * @param {Function} cb - Callback with { success, data }
     */
    async function load(url, cb) {
        try {
            var rawInput = safeStr(url).trim();
            if (!rawInput) {
                return cb({
                    success: false,
                    errorCode: "PARSE_ERROR",
                    message: "No video ID provided"
                });
            }

            // Parse the video ID to understand its structure
            var parsed = parseVideoId(rawInput);
            var metaId = parsed ? parsed.id : rawInput;
            var knownType = parsed ? parsed.type : null;

            if (!metaId) {
                return cb({
                    success: false,
                    errorCode: "PARSE_ERROR",
                    message: "Could not parse video ID: " + rawInput
                });
            }

            var addonUrls = getCatalogueAddons();
            if (!addonUrls.length) {
                // No addons — return minimal metadata so the UI doesn't break
                return respondFallback(rawInput, knownType, cb);
            }

            // ── Step 1: Build metadata query URLs ──
            // If we know the type (e.g., series from a "tt:1:1" format), only
            // query that type. If unknown, try all reasonable types.
            var typesToTry = knownType
                ? [knownType, "movie", "series", "anime"]
                : ["movie", "series", "anime", "tv", "channel"];

            var metaQueries = [];
            for (var ai = 0; ai < addonUrls.length; ai++) {
                var addonBaseUrl = baseUrl(addonUrls[ai]);
                // For service-prefixed IDs like "kitsu:7442", use the full ID
                var queryId = encodeURIComponent(metaId);
                for (var ti = 0; ti < typesToTry.length; ti++) {
                    metaQueries.push({
                        url: addonBaseUrl + "/meta/" + typesToTry[ti] + "/" + queryId + ".json",
                        addonIndex: ai,
                        type: typesToTry[ti],
                        addonUrl: addonUrls[ai]
                    });
                }
            }

            // ── Step 2: Fetch metadata using per-addon http_get ──
            // NOTE: We use http_get instead of httpBatch/http_parallel because
            // http_parallel may hang in the Dart runtime with many concurrent
            // URLs (sample plugins all use http_get exclusively). Each query
            // has an individual timeout so one slow addon doesn't block all.
            var META_TIMEOUT = 15000; // 15s per metadata query
            
            var metaFetchPromises = metaQueries.map(function(q) {
                return new Promise(function(resolve) {
                    var timer = setTimeout(function() {
                        resolve({ ok: false, data: null, status: 0, url: q.url, query: q });
                    }, META_TIMEOUT);
                    
                    // Use http_get — proven reliable in all sample plugins
                    http_get(q.url, JSON_HEADERS).then(function(resp) {
                        clearTimeout(timer);
                        if (resp && (resp.status === 200 || resp.status === 206) && resp.body) {
                            var body = (typeof resp.body === 'string') ? resp.body.trim() : JSON.stringify(resp.body);
                            if (body && body.charAt(0) !== '<') {
                                try {
                                    var parsed = JSON.parse(body);
                                    return resolve({ ok: true, data: parsed, status: resp.status, url: q.url, query: q });
                                } catch (e) {}
                            }
                        }
                        resolve({ ok: false, data: null, status: resp ? resp.status : 0, url: q.url, query: q });
                    }).catch(function() {
                        clearTimeout(timer);
                        resolve({ ok: false, data: null, status: 0, url: q.url, query: q });
                    });
                });
            });
            var metaResponses = await Promise.all(metaFetchPromises);

            // ── Step 3: Score and select the best result ──
            // Scoring criteria:
            //   +2  if the type matches our known type (from parseVideoId)
            //   +1  if the addon's idPrefixes match the video ID
            //   +1  if the result has episodes (for series detection)
            //   +1  if the result has a real title name
            //   +1  if the result has poster/background art
            //   +2  if the result has a rich description (synopsis)
            //   +1  if the result has cast info
            //
            // We pick the highest-scored result. This prevents a movie addon
            // from "stealing" a series lookup and vice versa.
            // CRITICAL: We add large bonuses for rich metadata (description,
            // cast, etc.) so that TMDB's full data wins over stub entries.

            var candidates = [];

            for (var ri = 0; ri < metaResponses.length; ri++) {
                var resp = metaResponses[ri];
                var query = metaQueries[ri];

                if (!resp.ok || !resp.data) continue;

                // The response can have "meta" (single) or "metas" (array)
                var metaData = resp.data.meta || (Array.isArray(resp.data.metas) ? resp.data.metas[0] : null);
                if (!metaData || !metaData.id) continue;

                // Calculate relevance score
                var score = 0;

                // Bonus for correct type match
                if (knownType && query.type === knownType) score += 2;

                // Bonus if addon's idPrefixes match the video ID
                // (We'd need the manifest for this — check cached manifest)
                var cachedManifest = cacheGet("mf:" + query.addonUrl);
                if (cachedManifest && Array.isArray(cachedManifest.idPrefixes)) {
                    for (var pi = 0; pi < cachedManifest.idPrefixes.length; pi++) {
                        if (metaId.indexOf(cachedManifest.idPrefixes[pi]) === 0) {
                            score += 1;
                            break;
                        }
                    }
                }

                // Bonus for having episodes (indicates it's a series result)
                if (Array.isArray(metaData.videos) && metaData.videos.length > 0) {
                    score += 1;
                }

                // Bonus for having actual metadata vs stub data
                if (metaData.name && metaData.name !== "Unknown" && metaData.name !== metaId) {
                    score += 1;
                }
                if (metaData.poster || metaData.background) score += 1;

                // ★★★ CRITICAL: Bonus for having rich synopsis/description
                // This ensures TMDB's full metadata wins over stub entries
                // from other addons that might have name+poster but no synopsis
                var descText = safeStr(metaData.description || metaData.overview || metaData.synopsis || "");
                if (descText.length > 20) {
                    score += 2; // Rich description = high quality metadata
                } else if (descText.length > 0) {
                    score += 1; // Short description = partial
                }

                // Bonus for having cast (indicates complete metadata)
                if (Array.isArray(metaData.cast) && metaData.cast.length > 0) {
                    score += 1;
                }

                // Bonus for having IMDB rating or score
                if (metaData.imdbRating != null || metaData.score != null) {
                    score += 1;
                }

                candidates.push({
                    meta: metaData,
                    score: score,
                    type: query.type,
                    addonUrl: query.addonUrl,
                    addonIndex: query.addonIndex
                });
            }

            // Sort by score descending, then by addon priority (index)
            candidates.sort(function(a, b) {
                if (b.score !== a.score) return b.score - a.score;
                return a.addonIndex - b.addonIndex;
            });

            if (candidates.length > 0) {
                // Use the best candidate
                respondMeta(candidates[0].meta, metaId, cb, knownType);
            } else {
                // No metadata found — return a fallback so the UI still works
                respondFallback(rawInput, knownType, cb);
            }

            // ── Step 4: Pre-fetch streams in the background ──
            // When the user taps Play, the cached result is used immediately.
            // This gives the illusion of "instant" stream loading.
            try {
                loadStreams(rawInput, function(streamResult) {
                    cacheSet("streams:" + metaId, streamResult);
                });
            } catch (e) {
                // Pre-fetch is best-effort; don't block the UI
            }

        } catch (e) {
            console.error("[Hub] load error:", e.message || e);
            try {
                respondFallback(rawInput, knownType, cb);
            } catch (f) {
                cb({
                    success: false,
                    errorCode: "LOAD_ERROR",
                    message: safeStr(e.message || e)
                });
            }
        }
    }

    /**
     * Build a fallback MultimediaItem when no metadata is found.
     * @param {string} metaId - Content ID
     * @param {string|null} knownType - Known content type (if any)
     * @param {Function} cb - Callback
     */
    function respondFallback(metaId, knownType, cb) {
        var isSeries = (knownType === "series" || knownType === "anime" ||
                        knownType === "tv" || knownType === "channel");
        // Show a gradient placeholder poster so the app doesn't render blank
        // posterUrl is required by IMultimediaItem; empty triggers app fallback
        cb({
            success: true,
            data: new MultimediaItem({
                title: "Content",
                url: metaId,
                posterUrl: "",
                type: isSeries ? "series" : "movie",
                episodes: [new Episode({
                    name: isSeries ? "Watch" : "Full Movie",
                    url: isSeries ? (metaId + ":1:1") : metaId,
                    season: 1,
                    episode: 1
                })]
            })
        });
    }

    /**
     * Convert full Stremio metadata (from /meta/ endpoint) into a
     * SkyStream MultimediaItem with episodes, cast, trailers, etc.
     *
     * @param {Object} meta - Stremio metadata object
     * @param {string} metaId - Original video ID
     * @param {Function} cb - Callback
     * @param {string|null} [knownType] - Known type from parseVideoId
     */
    function respondMeta(meta, metaId, cb, knownType) {
        try {
            var stremioType = meta.type || knownType || "movie";
            var skyTypeVal = skyType(stremioType);

            // Parse basic metadata
            var year = parseYear(meta);
            var score = parseRating(meta);
            var description = safeStr(meta.description || meta.overview || meta.synopsis || "")
                .replace(/<[^>]*>/g, "").trim();

            // ── Build episode list for series ──
            var episodes = [];
            var isSeries = (skyTypeVal !== "movie");

            if (isSeries && Array.isArray(meta.videos) && meta.videos.length > 0) {
                for (var vi = 0; vi < meta.videos.length; vi++) {
                    try {
                        var v = meta.videos[vi];
                        if (!v || !v.id) continue;

                        var seasonNum = v.season || 1;
                        var episodeNum = v.episode || v.number || 1;
                        var episodeId = metaId + ":" + seasonNum + ":" + episodeNum;

                        episodes.push(new Episode({
                            name: v.name || v.title || "Episode " + episodeNum,
                            url: episodeId,
                            season: seasonNum,
                            episode: episodeNum,
                            posterUrl: v.thumbnail || v.poster || meta.poster || "",
                            description: v.overview || v.description || "",
                            airDate: v.released || v.firstAired || ""
                        }));
                    } catch (e) {
                        // Skip invalid episode entries
                    }
                }
            }

            // If no episodes were found, create a single "play" entry
            if (episodes.length === 0) {
                var playId = isSeries ? (metaId + ":1:1") : metaId;
                episodes.push(new Episode({
                    name: skyTypeVal === "movie" ? "Full Movie" : "Watch",
                    url: playId,
                    season: 1,
                    episode: 1,
                    posterUrl: meta.poster || ""
                }));
            }

            // ── Cast ──
            var cast = undefined;
            if (Array.isArray(meta.cast) && meta.cast.length > 0) {
                cast = [];
                for (var ci = 0; ci < meta.cast.length; ci++) {
                    try {
                        var c = meta.cast[ci];
                        if (!c) continue;
                        if (typeof c === "string") {
                            cast.push(new Actor({ name: c, role: "", image: "" }));
                        } else {
                            cast.push(new Actor({
                                name: c.name || c.fullName || c.person || "",
                                role: c.role || c.character || "",
                                image: c.image || c.picture || c.photo || c.profile || c.profile_path || ""
                            }));
                        }
                    } catch (e) {}
                }
                if (cast.length === 0) cast = undefined;
            }

            // ── Trailers ──
            var trailers = undefined;
            if (Array.isArray(meta.trailers) && meta.trailers.length > 0) {
                trailers = [];
                for (var tri = 0; tri < meta.trailers.length; tri++) {
                    try {
                        var tr = meta.trailers[tri];
                        if (!tr) continue;
                        var src = tr.source || tr.url || "";
                        var trUrl = (src.indexOf("http") === 0) ? src :
                            "https://www.youtube.com/watch?v=" + src;
                        trailers.push(new Trailer({
                            url: trUrl,
                            name: tr.name || tr.type || "Trailer"
                        }));
                    } catch (e) {}
                }
                if (trailers.length === 0) trailers = undefined;
            }

            // ── Director ──
            var director = undefined;
            if (meta.director) {
                director = Array.isArray(meta.director)
                    ? meta.director.filter(Boolean).join(", ")
                    : safeStr(meta.director);
                if (!director) director = undefined;
            }

            // ── Build the final MultimediaItem ──
            var item = new MultimediaItem({
                title: meta.name || meta.title || "Unknown",
                url: metaId,
                posterUrl: meta.poster || meta.posterUrl || "",
                posterShape: meta.posterShape || "poster",
                bannerUrl: meta.background || meta.backdrop || meta.banner || "",
                logoUrl: meta.logo || meta.logoUrl || "",
                type: skyTypeVal,
                description: description,
                year: year,
                score: score,
                genres: parseGenres(meta),
                cast: cast,
                director: director,
                trailers: trailers,
                runtime: meta.runtime ? safeStr(meta.runtime) : undefined,
                language: meta.language || undefined,
                country: meta.country || undefined,
                awards: meta.awards || undefined,
                website: meta.website || undefined,
                status: mapStatus(meta.status),
                episodes: episodes
            });

            cb({ success: true, data: item });

        } catch (e) {
            console.error("[Hub] respondMeta error:", e.message);
            // Fallback on error — include posterUrl to prevent blank screen
            var ft = skyType(meta.type || "movie");
            cb({
                success: true,
                data: new MultimediaItem({
                    title: meta.name || meta.title || "Unknown",
                    url: metaId,
                    posterUrl: meta.poster || meta.posterUrl || "",
                    type: ft,
                    episodes: [new Episode({
                        name: "Play",
                        url: ft === "movie" ? metaId : metaId + ":1:1",
                        season: 1,
                        episode: 1
                    })]
                })
            });
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 14: loadStreams() — Stream Resolution Engine
    // ────────────────────────────────────────────────────────────────
    //
    // This is the core streaming function. Key design decisions:
    //
    //  1. PER-ADDON TIMEOUT: Each addon has STREAM_ADDON_TIMEOUT (80s)
    //     instead of a global timeout. This prevents one slow addon from
    //     blocking all others. Slow addons are skipped, fast ones contribute.
    //
    //  2. ADDON PRIORITY: The order of `streamingAddons` in plugin.json
    //     determines priority. Results from the first addon appear first.
    //     Each addon's own stream order is preserved.
    //
    //  3. DEDUPLICATION: Streams are deduplicated ONLY within the same addon.
    //     Different addons never dedup each other's streams. URL dedup keeps
    //     query parameters (tokens, quality selectors, server IDs).
    //
    //  4. SUBTITLE PASSTHROUGH: Streams that carry embedded subtitles
    //     (via stream.subtitles) have them passed through to the UI.
    //
    //  5. CACHE: Streams are cached for CACHE_TTL. If load() pre-fetched
    //     streams, they're served from cache while a background refresh
    //     updates them.

    /**
     * @param {string} url - Video ID (with optional season:episode suffix)
     * @param {Function} cb - Callback with { success, data }
     */
    async function loadStreams(url, cb) {
        // Ensure callback is only called once (prevent double-fire)
        var callbackCalled = false;
        function safeCallback(result) {
            if (!callbackCalled) {
                callbackCalled = true;
                cb(result);
            }
        }

        try {
            // ── Step 1: Parse the video ID ──
            var parsed = parseVideoId(url);
            var metaId, mediaType, season, episode;

            if (parsed) {
                metaId = parsed.id;
                mediaType = parsed.type || "movie";
                season = parsed.season || 0;
                episode = parsed.episode || 0;
            } else {
                metaId = url;
                mediaType = "movie";
                season = 0;
                episode = 0;
            }

            // Determine Stremio stream type
            var streamType = (mediaType === "tv" || mediaType === "series" || mediaType === "anime")
                ? "series" : "movie";

            // Get the list of streaming addons
            var addonUrls = getStreamingAddons();
            if (!addonUrls || !addonUrls.length) {
                return safeCallback({ success: true, data: [] });
            }

            // ── Step 2: Ignore cache — always fetch fresh from all addons ──
            // Previously this served cached pre-fetched streams immediately and
            // then did a background refresh, but the fresh data was dropped
            // because safeCallback already fired. This caused users to only
            // see partial results from fast addons. Now we always wait for
            // ALL addons and return everything at once.

            // ── Step 3: Build per-addon stream URLs ──
            // Each streaming addon gets its own URL. For series episodes,
            // the ID includes the season:episode suffix.
            var addonJobs = [];
            for (var ai = 0; ai < addonUrls.length; ai++) {
                var addonBase = baseUrl(addonUrls[ai]);
                var addonDisplay = addonName(addonUrls[ai]);

                var streamUrl;
                if (streamType === "series" && season > 0 && episode > 0) {
                    streamUrl = addonBase + "/stream/" + streamType + "/" +
                        encodeURIComponent(metaId + ":" + season + ":" + episode) + ".json";
                } else {
                    streamUrl = addonBase + "/stream/" + streamType + "/" +
                        encodeURIComponent(metaId) + ".json";
                }

                addonJobs.push({
                    url: streamUrl,
                    addonName: addonDisplay,
                    baseUrl: addonBase,
                    addonIndex: ai
                });
            }

            // ── Step 4: Fetch streams from all addons ──
            // Each addon gets its own timeout. We use Promise.allSettled-like
            // behavior: individual timeouts per addon, not a global one.

            var addonStreamsMap = {}; // { addonIndex: { addonName, baseUrl, streams[] } }

            // Fire all requests concurrently with individual timeouts
            var fetchPromises = [];
            for (var ji = 0; ji < addonJobs.length; ji++) {
                // IIFE captures job per iteration (fixes closure bug: all callbacks
                // were referencing the same `var job`, getting the last addon's values)
                (function(job) {
                    var promise = httpBatch([job.url]).then(function(responses) {
                        // httpBatch returns array aligned to input
                        return { job: job, response: responses[0] };
                    });

                    // Apply per-addon timeout
                    var timeoutPromise = new Promise(function(resolve) {
                        setTimeout(function() {
                            resolve({ job: job, response: null, timedOut: true });
                        }, STREAM_ADDON_TIMEOUT);
                    });

                    fetchPromises.push(Promise.race([promise, timeoutPromise]));
                })(addonJobs[ji]);
            }

            // Wait for ALL addons to either respond or timeout
            var fetchResults = await Promise.all(fetchPromises);

            // Debug: log per-addon results
            var addonsResponded = 0;
            var addonsSkipped = 0;
            for (var fri = 0; fri < fetchResults.length; fri++) {
                var fr = fetchResults[fri];
                var j = fr.job;
                var resp = fr.response;

                if (fr.timedOut) {
                    addonsSkipped++;
                    continue;
                }
                if (!resp) {
                    addonsSkipped++;
                    continue;
                }
                if (!resp.ok || !resp.data) {
                    if (resp.redirectUrl) {
                        addonsSkipped++;
                    } else if (resp.status >= 400) {
                        addonsSkipped++;
                    } else {
                        addonsSkipped++;
                    }
                    continue;
                }
                if (!Array.isArray(resp.data.streams) || resp.data.streams.length === 0) {
                    addonsSkipped++;
                    continue;
                }
                addonsResponded++;
            }
            console.log("[Hub] loadStreams(" + metaId + "): " + addonsResponded +
                        " addons responded, " + addonsSkipped + " skipped/timed out");

            // Process each addon's response
            // For 3xx redirects, try to follow the redirect to get actual stream data
            var redirectFollowPromises = [];

            for (var fri = 0; fri < fetchResults.length; fri++) {
                var fr = fetchResults[fri];
                var j = fr.job;
                var resp = fr.response;

                // Case 1: Successful response with streams
                if (resp && resp.ok && resp.data &&
                    Array.isArray(resp.data.streams) && resp.data.streams.length > 0) {

                    // Use URL-derived name for the [Tag] (identifies the config source).
                    // The stream's own name appears in the content via formatStream.
                    var effectiveName = j.addonName;

                    if (!addonStreamsMap[j.addonIndex]) {
                        addonStreamsMap[j.addonIndex] = {
                            addonName: effectiveName,
                            baseUrl: j.baseUrl,
                            streams: []
                        };
                    }
                    var formatted = processStreams(resp.data.streams, j.addonIndex, j.baseUrl, effectiveName);
                    addonStreamsMap[j.addonIndex].streams =
                        addonStreamsMap[j.addonIndex].streams.concat(formatted);
                    continue;
                }

                // Case 2: Redirect response — try to follow the redirect
                if (resp && resp.redirectUrl && isHttp(resp.redirectUrl)) {
                    // Store the promise so we can await all redirects
                    var redirectPromise = (function(job, redirectUrl) {
                        return httpBatch([redirectUrl]).then(function(redirectResponses) {
                            var rr = redirectResponses[0];
                            if (rr && rr.ok && rr.data &&
                                Array.isArray(rr.data.streams) && rr.data.streams.length > 0) {
                                // Use URL-derived name for the [Tag]; stream name appears in content
                                var effectiveName = job.addonName;
                                if (!addonStreamsMap[job.addonIndex]) {
                                    addonStreamsMap[job.addonIndex] = {
                                        addonName: effectiveName,
                                        baseUrl: job.baseUrl,
                                        streams: []
                                    };
                                }
                                var formatted = processStreams(rr.data.streams, job.addonIndex, job.baseUrl, effectiveName);
                                addonStreamsMap[job.addonIndex].streams =
                                    addonStreamsMap[job.addonIndex].streams.concat(formatted);
                            }
                        }).catch(function() {});
                    })(j, resp.redirectUrl);
                    redirectFollowPromises.push(redirectPromise);
                }
            }

            // Wait for all redirect follow-ups to complete
            if (redirectFollowPromises.length > 0) {
                await Promise.all(redirectFollowPromises);
            }

            // ── Step 5: Merge streams in addon priority order ──
            // Concatenate in addon priority (first addon = top), preserving
            // each addon's own stream order. Tag each stream with its addon index.

            var mergedStreams = [];
            for (var ai = 0; ai < addonUrls.length; ai++) {
                var entry = addonStreamsMap[ai];
                if (entry && entry.streams.length > 0) {
                    // Tag each stream with its addon index for per-addon dedup
                    for (var ei = 0; ei < entry.streams.length; ei++) {
                        entry.streams[ei]._addonIndex = ai;
                    }
                    // Preserve addon's own stream order — no quality re-sorting
                    mergedStreams = mergedStreams.concat(entry.streams);
                }
            }

            // ── Step 6: Deduplicate ──
            // Dedup only within the same addon (different addons never dedup each other).
            // Keep query params in URL keys — they often carry tokens, quality selectors,
            // or server IDs that differentiate streams.
            var seenKeys = {};
            var deduplicated = [];
            for (var si = 0; si < mergedStreams.length; si++) {
                var stream = mergedStreams[si];
                var key = dedupKey(stream, stream._addonIndex);
                // If key is empty, use a unique fallback so no stream is dropped
                if (!key) key = "unknown:" + si;
                if (!seenKeys[key]) {
                    seenKeys[key] = true;
                    deduplicated.push(stream);
                }
            }

            // ── Step 7: Clean internal properties before returning ──
            for (var di = 0; di < deduplicated.length; di++) {
                if (deduplicated[di]._sortKey !== undefined) {
                    delete deduplicated[di]._sortKey;
                }
                if (deduplicated[di]._addonIndex !== undefined) {
                    delete deduplicated[di]._addonIndex;
                }
            }

            // Cache the result for subsequent calls
            var result = { success: true, data: deduplicated };
            cacheSet("streams:" + metaId, result);

            // Only call callback if we haven't already (cached may have been sent)
            if (!callbackCalled) {
                safeCallback(result);
            }

        } catch (e) {
            console.error("[Hub] loadStreams error:", e.message || e);
            safeCallback({
                success: false,
                errorCode: "STREAM_ERROR",
                message: safeStr(e.message || e)
            });
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  SECTION 15: EXPORTS
    // ────────────────────────────────────────────────────────────────
    // These four functions are the SkyStream plugin interface.
    // SkyStream looks for these on globalThis at runtime.

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

    console.log("[Hub] Stremio Hub v5 loaded — " + getCatalogueAddons().length +
                " catalogue addons, " + getStreamingAddons().length + " streaming addons");

})();
