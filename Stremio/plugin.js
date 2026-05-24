(function () {
	"use strict";

	// ═══════════════════════════════════════════════════════════════════
	//  Stremio Hub — Universal Stremio Addon Aggregator for SkyStream
	// ═══════════════════════════════════════════════════════════════════
	//
	//  ARCHITECTURE:
	//    getHome()      → catalogueAddons (browse catalogs only)
	//    search()       → metaAddons / catalogueAddons (search)
	//    load()         → metaAddons (Cinemeta), with pipe-delimited tmdb: fallback
	//    loadStreams()  → streamingAddons (per-addon timeout + dedup)
	//
	//  RUNTIME DEPENDENCIES (injected by SkyStream):
	//    - globalThis.manifest              — Plugin config from plugin.json
	//    - http_get(url, headers)           → Promise<{status, body, headers, location}>
	//    - http_parallel(requests[])        → Promise<[{status, body, headers, location}]>
	//    - getPreference(key), setPreference(key, value)
	//    - MultimediaItem, StreamResult, Episode, Actor, Trailer
	//    - setTimeout / clearTimeout (provided by SkyStream)
	//    - btoa (standard Web API, polyfilled in SkyStream)
	//
	//  KEY FEATURES:
	//    ★ Cinemeta-authoritative metadata (tt→direct, tmdb:→pipe→direct)
	//    ★ Multi-meta-addon fallback support
	//    ★ Rate limiting with backoff + jitter
	//    ★ Map-based LRU cache with per-TTL support
	//    ★ Promise-based tracker loading
	//    ★ Structured logging throughout
	//    ★ Explicit dedup with correct addon-index tracking
	// ═══════════════════════════════════════════════════════════════════

	// ────────────────────────────────────────────────────────────────
	//  SECTION 1: CONFIGURATION & CONSTANTS
	// ────────────────────────────────────────────────────────────────

	const UA =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

	const JSON_HEADERS = {
		"User-Agent": UA,
		Accept: "application/json",
		"Accept-Language": "en-US,en;q=0.5",
	};

	// Default TTLs
	let CACHE_TTL = 1800000; // 30 min — metadata/manifest cache
	let STREAM_CACHE_TTL = 180000; // 3 min — stream cache
	const MAX_MAGNET_TRACKERS = 20;

	// Try loading user preferences for cache TTL
	try {
		const ttlPref = parseInt(getPreference("hub_cache_ttl"), 10);
		if (ttlPref > 0) CACHE_TTL = ttlPref;
	} catch (e) {
		console.warn("[StremioHub] Failed to load cache_ttl preference:", e);
	}

	try {
		const stPref = parseInt(getPreference("hub_stream_cache_ttl"), 10);
		if (stPref > 0) STREAM_CACHE_TTL = stPref;
	} catch (e) {
		console.warn("[StremioHub] Failed to load stream_cache_ttl preference:", e);
	}

	let STREAM_ADDON_TIMEOUT = 80000; // Per-addon stream timeout (80s)
	try {
		const stPref = parseInt(getPreference("hub_stream_addon_timeout"), 10);
		if (stPref > 0) STREAM_ADDON_TIMEOUT = stPref;
	} catch (e) {
		console.warn(
			"[StremioHub] Failed to load stream_addon_timeout preference:",
			e,
		);
	}

	const META_TIMEOUT = 8000; // Manifest fetch timeout
	const META_FETCH_TIMEOUT = 12000; // Per-metadata-query timeout

	// Rate-limit: backoff 5min after 3 consecutive 429/503/502/504
	const RATE_BACKOFF_MS = 300000;
	const RATE_MAX_FAILS = 3;
	const RATE_LIMIT_JITTER_MS = 30000; // +0-30s jitter to avoid thundering herd
	let _rateLimits = {};

	const MAX_SEARCH_RESULTS = 50;
	const MAX_SEARCH_QUERY_LENGTH = 200;
	const CATALOG_PAGE_SIZE = 20;

	// TMDB image base for resolving Cinemeta's relative cast photo paths
	const TMDB_IMG_BASE = "https://image.tmdb.org/t/p";

	// ── TMDB API (convert TMDB IDs → IMDb IDs for maximum stream coverage) ──
	const TMDB_API_KEYS = [
		"af3a53eb387d57fc935e9128468b1899",
		"68e094699525b18a70bab2f86b1fa706",
	];
	let _tmdbKeyIndex = 0;
	const TMDB_API_TIMEOUT = 5000; // 5s per TMDB API call
	const TMDB_CACHE_TTL = 86400000; // 24h — TMDB→IMDb mappings rarely change

	function getTmdbApiKey() {
		const key = TMDB_API_KEYS[_tmdbKeyIndex % TMDB_API_KEYS.length];
		_tmdbKeyIndex++;
		return key;
	}

	/**
	 * Resolve a TMDB ID to an IMDb ID via TMDB API.
	 * Supports both movie (/movie/{id}) and TV (/tv/{id}) endpoints.
	 * Returns null on failure (network, rate-limit, not found).
	 * Results cached for 24h.
	 */
	function resolveTmdbToImdb(tmdbId, type) {
		const cacheKey = "tmdb2imdb:" + tmdbId;
		const cached = cacheGet(cacheKey, TMDB_CACHE_TTL);
		if (cached !== undefined && cached !== null) return Promise.resolve(cached);

		const tmdbType = type === "series" || type === "tv" ? "tv" : "movie";
		const apiKey = getTmdbApiKey();
		const baseUrl = "https://api.themoviedb.org/3/" + tmdbType + "/" + tmdbId;

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				logWarn("resolveTmdbToImdb", "Timeout for TMDB ID " + tmdbId);
				resolve(null);
			}, TMDB_API_TIMEOUT);

			// First call: get main item (movies include imdb_id here)
			http_get(baseUrl + "?api_key=" + apiKey + "&language=en", JSON_HEADERS)
				.then((resp) => {
					clearTimeout(timer);
					if (resp && resp.status === 200 && resp.body) {
						try {
							const body =
								typeof resp.body === "string"
									? JSON.parse(resp.body)
									: resp.body;
							if (body.imdb_id) {
								cacheSet(cacheKey, body.imdb_id, TMDB_CACHE_TTL);
								logWarn(
									"resolveTmdbToImdb",
									"Resolved tmdb:" + tmdbId + " → " + body.imdb_id,
								);
								return resolve(body.imdb_id);
							}
							// TV shows: imdb_id may be in /external_ids
							if (tmdbType === "tv") {
								resolveExternalIds(tmdbId, apiKey, resolve);
							} else {
								cacheSet(cacheKey, null, TMDB_CACHE_TTL);
								resolve(null);
							}
						} catch (e) {
							logWarn(
								"resolveTmdbToImdb",
								"Parse error for movie endpoint: " + tmdbId,
							);
							// Try external_ids as fallback
							if (tmdbType === "tv") {
								resolveExternalIds(tmdbId, apiKey, resolve);
							} else {
								clearTimeout(timer);
								resolve(null);
							}
						}
					} else {
						clearTimeout(timer);
						resolve(null);
					}
				})
				.catch(() => {
					clearTimeout(timer);
					resolve(null);
				});
		});

		function resolveExternalIds(tvId, apiKey, cb) {
			const extTimer = setTimeout(() => cb(null), TMDB_API_TIMEOUT);
			http_get(baseUrl + "/external_ids?api_key=" + apiKey, JSON_HEADERS)
				.then((extResp) => {
					clearTimeout(extTimer);
					if (extResp && extResp.status === 200 && extResp.body) {
						try {
							const extBody =
								typeof extResp.body === "string"
									? JSON.parse(extResp.body)
									: extResp.body;
							if (extBody.imdb_id) {
								cacheSet(cacheKey, extBody.imdb_id, TMDB_CACHE_TTL);
								logWarn(
									"resolveTmdbToImdb",
									"Resolved tmdb:" + tmdbId + " (TV) → " + extBody.imdb_id,
								);
								return cb(extBody.imdb_id);
							}
						} catch (e) {
							logWarn(
								"resolveTmdbToImdb",
								"Parse error for TV external_ids: " + tvId,
							);
							clearTimeout(extTimer);
						}
					}
					cacheSet(cacheKey, null, TMDB_CACHE_TTL);
					clearTimeout(extTimer);
					cb(null);
				})
				.catch(() => {
					clearTimeout(extTimer);
					cb(null);
				});
		}
	}

	// ── Trackers ──
	const FALLBACK_TRACKERS = [
		"udp://tracker.opentrackr.org:1337/announce",
		"udp://open.demonii.com:1337/announce",
		"udp://tracker.torrent.eu.org:451/announce",
	];

	const TRACKER_FETCH_TIMEOUT = 10000; // 10s timeout for tracker list fetches

	const TRACKERS_LIST_URLS = [
		"https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt",
		"https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt",
		"https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt",
		"https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
	];

	let TRACKERS = FALLBACK_TRACKERS.slice();
	let _trackersPromise = null;

	// ────────────────────────────────────────────────────────────────
	//  SECTION 2: LOGGING UTILITY
	// ────────────────────────────────────────────────────────────────

	const LOG_PREFIX = "[StremioHub]";

	function logError(context, message, err) {
		try {
			console.error(
				LOG_PREFIX,
				"[" + context + "]",
				message,
				err ? err.message || err : "",
			);
		} catch (_) {}
	}

	function logWarn(context, message) {
		try {
			console.warn(LOG_PREFIX, "[" + context + "]", message);
		} catch (_) {}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 3: UTILITY FUNCTIONS
	// ────────────────────────────────────────────────────────────────

	function baseUrl(manifestUrl) {
		return (manifestUrl || "")
			.replace(/\/manifest\.json$/, "")
			.replace(/\/$/, "");
	}

	function addonName(url) {
		try {
			const parts = url
				.replace(/https?:\/\//, "")
				.split("/")[0]
				.replace(/^www\./, "")
				.split(".");
			let name = parts[0] || "";
			if (/^[a-f0-9]{8,}$/i.test(name) && parts.length >= 2) {
				name = parts[parts.length - 2];
			}
			name = name.replace(/^[a-f0-9]{6,}-/i, "");
			const tlds = [
				"com",
				"org",
				"net",
				"io",
				"app",
				"dev",
				"tv",
				"co",
				"uk",
				"de",
				"xyz",
				"fun",
				"cloud",
				"me",
				"in",
			];
			if (tlds.indexOf(name) !== -1 || name.length <= 2) {
				for (let ni = 1; ni < parts.length - 1; ni++) {
					if (tlds.indexOf(parts[ni]) === -1 && parts[ni].length > 2) {
						name = parts[ni];
						break;
					}
				}
			}
			name = name
				.replace(/[-_]/g, " ")
				.replace(/\b\w/g, (c) => c.toUpperCase());
			return name.trim() || "Addon";
		} catch (e) {
			logError("addonName", "Failed to parse name from URL", e);
			return "Addon";
		}
	}

	function isHttp(s) {
		return s && (s.indexOf("http://") === 0 || s.indexOf("https://") === 0);
	}

	function safeStr(s) {
		return String(s == null ? "" : s);
	}

	function safeJson(text, fallback) {
		try {
			return JSON.parse(safeStr(text));
		} catch (e) {
			return fallback !== undefined ? fallback : null;
		}
	}

	function skyType(t) {
		return t === "movie" || t === "short" ? "movie" : "series";
	}

	function mapStatus(status) {
		if (!status) return undefined;
		const sv = safeStr(status).toLowerCase();
		if (sv === "ended" || sv === "canceled") return "completed";
		if (sv === "returning series" || sv === "continuing" || sv === "ongoing")
			return "ongoing";
		if (sv === "in production" || sv === "planned") return "upcoming";
		return undefined;
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 4: TRACKER LOADING (Promise-based, no race condition)
	// ────────────────────────────────────────────────────────────────

	function ensureTrackersLoaded() {
		if (_trackersPromise) return _trackersPromise;

		// Check cached preferences first
		try {
			const cachedRaw = getPreference("hub_trackers_list");
			if (cachedRaw) {
				const cached = safeJson(cachedRaw, null);
				if (cached && Array.isArray(cached) && cached.length > 0) {
					TRACKERS = cached;
					_trackersPromise = Promise.resolve(cached);
					return _trackersPromise;
				}
			}
		} catch (e) {
			logWarn("ensureTrackersLoaded", "Failed to read cached trackers");
		}

		_trackersPromise = new Promise((resolve) => {
			const allParsed = [];
			const seen = {};
			let remaining = TRACKERS_LIST_URLS.length;

			function addTrackersFromBody(body) {
				const lines = (body || "").split("\n");
				for (let i = 0; i < lines.length; i++) {
					const line = lines[i].trim();
					if (!line || line.charAt(0) === "#") continue;
					if (
						line.indexOf("udp://") === 0 ||
						line.indexOf("http://") === 0 ||
						line.indexOf("https://") === 0 ||
						line.indexOf("ws://") === 0 ||
						line.indexOf("wss://") === 0
					) {
						if (!seen[line]) {
							seen[line] = true;
							allParsed.push(line);
						}
					}
				}
			}

			function finalize() {
				if (allParsed.length > 0) {
					TRACKERS = allParsed;
					try {
						setPreference("hub_trackers_list", JSON.stringify(allParsed));
					} catch (e) {
						logWarn("trackers.finalize", "Failed to persist trackers");
					}
				}
				resolve(TRACKERS);
			}

			const timeout = setTimeout(() => {
				remaining = 0;
				finalize();
			}, TRACKER_FETCH_TIMEOUT);

			for (let ui = 0; ui < TRACKERS_LIST_URLS.length; ui++) {
				http_get(TRACKERS_LIST_URLS[ui], { "User-Agent": UA })
					.then((resp) => {
						if (resp && resp.status === 200 && resp.body) {
							const body =
								typeof resp.body === "string" ? resp.body : String(resp.body);
							addTrackersFromBody(body);
						}
						remaining--;
						if (remaining <= 0) {
							clearTimeout(timeout);
							finalize();
						}
					})
					.catch(() => {
						remaining--;
						if (remaining <= 0) {
							clearTimeout(timeout);
							finalize();
						}
					});
			}
		});

		return _trackersPromise;
	}

	function magnetLink(hash, name) {
		// Trackers are pre-loaded during init; this is a no-op if already loaded
		ensureTrackersLoaded();
		let m =
			"magnet:?xt=urn:btih:" + hash + "&dn=" + encodeURIComponent(name || hash);
		const count = Math.min(TRACKERS.length, MAX_MAGNET_TRACKERS);
		for (let i = 0; i < count; i++) {
			m += "&tr=" + encodeURIComponent(TRACKERS[i]);
		}
		return m;
	}

	function dedupKey(stream, addonIndex) {
		const prefix = addonIndex !== undefined ? addonIndex + ":" : "";
		if (stream.infoHash) return prefix + stream.infoHash.toLowerCase();
		let key = stream.url || "";
		key = key
			.replace(/^https?:\/\//, "")
			.replace(/\/+$/, "")
			.split("#")[0];
		return prefix + key.toLowerCase();
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 5: CACHE SYSTEM (Map-based LRU with per-TTL support)
	// ────────────────────────────────────────────────────────────────

	let _cache = new Map();
	const CACHE_MAX_ENTRIES = 500;
	let _cacheGen = 0;

	function cacheGet(key, ttl) {
		ttl = ttl !== undefined ? ttl : CACHE_TTL;

		if (_cache.has(key)) {
			const entry = _cache.get(key);
			if (Date.now() - entry.ts < ttl) {
				// LRU: move to end on hit
				_cache.delete(key);
				_cache.set(key, entry);
				return entry.data;
			}
			// Expired: remove
			_cache.delete(key);
		}

		// Fallback: try persistent storage
		try {
			const raw = getPreference("hub_cache:" + key);
			if (raw) {
				const parsed = safeJson(raw, null);
				if (parsed && parsed.ts && Date.now() - parsed.ts < ttl) {
					_cache.set(key, parsed);
					return parsed.data;
				}
			}
		} catch (e) {
			logWarn("cacheGet", "Failed to read persistent cache for " + key);
		}

		return null;
	}

	function cacheSet(key, data, ttl) {
		ttl = ttl !== undefined ? ttl : CACHE_TTL;
		const entry = { ts: Date.now(), data: data, ttl: ttl, gen: _cacheGen++ };

		// LRU: delete then re-insert to mark as recent
		if (_cache.has(key)) _cache.delete(key);
		_cache.set(key, entry);

		// Evict oldest (LRU) if over limit, persist evicted entries with long TTLs
		if (_cache.size > CACHE_MAX_ENTRIES) {
			const oldestKey = _cache.keys().next().value;
			if (oldestKey) {
				const evicted = _cache.get(oldestKey);
				_cache.delete(oldestKey);
				if (evicted && evicted.ttl >= 3600000) {
					tryPersistCache(oldestKey, evicted);
				}
			}
		}

		// Persist long-lived entries to preferences
		if (ttl >= 3600000) {
			tryPersistCache(key, entry);
		}
	}

	function tryPersistCache(key, entry) {
		try {
			setPreference(
				"hub_cache:" + key,
				JSON.stringify({
					ts: entry.ts,
					data: entry.data,
					ttl: entry.ttl,
				}),
			);
		} catch (e) {
			logWarn("tryPersistCache", "Failed to persist cache for " + key);
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 6: RATE LIMITING (with jitter)
	// ────────────────────────────────────────────────────────────────

	function rateLimitKey(url) {
		try {
			const u = new URL(url);
			return u.origin + u.pathname;
		} catch (e) {
			return url;
		}
	}

	function isRateLimited(url) {
		const key = rateLimitKey(url);
		const rl = _rateLimits[key];
		return rl && rl.fails >= RATE_MAX_FAILS && Date.now() < rl.until;
	}

	function recordResponseStatus(url, status) {
		const key = rateLimitKey(url);
		if (status === 429 || status === 503 || status === 502 || status === 504) {
			const rl = _rateLimits[key] || { fails: 0, until: 0 };
			rl.fails++;
			// Add jitter to prevent thundering herd
			const jitter = Math.floor(Math.random() * RATE_LIMIT_JITTER_MS);
			rl.until = Date.now() + RATE_BACKOFF_MS + jitter;
			_rateLimits[key] = rl;
			try {
				setPreference("hub_ratelimit:" + key, JSON.stringify(rl));
			} catch (e) {
				logWarn("rateLimit", "Failed to persist rate limit for " + key);
			}
		} else if (status >= 200 && status < 300) {
			if (_rateLimits[key]) {
				_rateLimits[key].fails = 0;
				try {
					setPreference(
						"hub_ratelimit:" + key,
						JSON.stringify(_rateLimits[key]),
					);
				} catch (e) {
					logWarn("rateLimit", "Failed to persist rate limit reset for " + key);
				}
			}
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 7: HTTP LAYER
	// ────────────────────────────────────────────────────────────────

	function buildRequest(url) {
		return { method: "GET", url: url, headers: JSON_HEADERS };
	}

	/**
	 * Batch HTTP requests via http_parallel.
	 * Rate-limited URLs are excluded from the batch and pre-filled with status 429.
	 */
	function httpBatch(urls) {
		if (!urls || !urls.length) return Promise.resolve([]);

		// Pre-fill results array — rate-limited entries get status 429
		const results = [];
		const activeUrls = [];
		const activeIndices = [];

		for (let i = 0; i < urls.length; i++) {
			if (isRateLimited(urls[i])) {
				results.push({ url: urls[i], ok: false, data: null, status: 429 });
			} else {
				results.push({ url: urls[i], ok: false, data: null, status: 0 });
				activeUrls.push(urls[i]);
				activeIndices.push(i);
			}
		}

		if (activeUrls.length === 0) {
			return Promise.resolve(results);
		}

		const requests = activeUrls.map((u) => buildRequest(u));

		return http_parallel(requests)
			.then((responses) => {
				for (let ri = 0; ri < responses.length; ri++) {
					const resp = responses[ri];
					const idx = activeIndices[ri];
					const status = resp ? resp.status || resp.code || 0 : 0;

					recordResponseStatus(activeUrls[ri], status);

					const entry = {
						url: activeUrls[ri],
						ok: false,
						data: null,
						status: status,
					};

					if (resp && status >= 300 && status < 400) {
						const location =
							resp.location ||
							(resp.headers &&
								(resp.headers.location || resp.headers.Location));
						if (location) {
							entry.redirectUrl =
								typeof location === "string" ? location : location.url || "";
						}
					}

					if (resp && resp.body && (status === 200 || status === 206)) {
						tryParseJson(resp.body, entry);
					}

					results[idx] = entry;
				}
				return results;
			})
			.catch((err) => {
				logError("httpBatch", "http_parallel failed", err);
				// Non-rate-limited entries already have status 0; return as-is
				return results;
			});
	}

	function tryParseJson(body, entry) {
		try {
			if (typeof body === "string") {
				const trimmed = body.trim();
				if (trimmed && trimmed.charAt(0) !== "<") {
					entry.data = JSON.parse(trimmed);
					entry.ok = true;
				}
			} else if (typeof body === "object") {
				entry.data = body;
				entry.ok = true;
			}
		} catch (parseErr) {
			// Not JSON — leave as ok:false
		}
	}

	function parseHttpBody(body) {
		if (typeof body === "string") {
			const trimmed = body.trim();
			if (!trimmed) return null;
			if (trimmed.charAt(0) === "<") return null;
			return JSON.parse(trimmed);
		}
		return body;
	}

	function fetchJson(url, timeoutMs, _redirectDepth) {
		timeoutMs = timeoutMs || META_TIMEOUT;
		_redirectDepth = _redirectDepth || 0;
		const MAX_REDIRECTS = 5;
		return new Promise((resolve, reject) => {
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				reject(new Error("Timeout: " + url));
			}, timeoutMs);

			function cleanupReject(err) {
				clearTimeout(timer);
				reject(err);
			}

			http_get(url, JSON_HEADERS)
				.then((response) => {
					if (timedOut) return;
					clearTimeout(timer);

					if (!response || !response.body) {
						return cleanupReject(new Error("Empty response: " + url));
					}

					recordResponseStatus(url, response.status || 0);

					// Handle redirects with depth limit
					if (response.status >= 300 && response.status < 400) {
						if (_redirectDepth >= MAX_REDIRECTS) {
							return cleanupReject(new Error("Too many redirects: " + url));
						}
						let location =
							response.location ||
							(response.headers &&
								(response.headers.location || response.headers.Location));
						if (
							typeof response.body === "string" &&
							response.body.indexOf("Redirecting") !== -1
						) {
							const match = response.body.match(/https?:\/\/[^\s"']+/);
							if (match) location = match[0];
						}
						if (location) {
							const redirectUrl =
								typeof location === "string" ? location : location.url || "";
							const resolvedUrl =
								redirectUrl.indexOf("http") === 0
									? redirectUrl
									: (() => {
											try {
												return new URL(url).origin + redirectUrl;
											} catch (e) {
												return null;
											}
										})();
							if (resolvedUrl) {
								return fetchJson(
									resolvedUrl,
									timeoutMs,
									_redirectDepth + 1,
								).then(resolve, reject);
							}
						}
					}

					if (response.status !== 200 && response.status !== 304) {
						return cleanupReject(
							new Error("HTTP " + response.status + " for " + url),
						);
					}

					try {
						const parsed = parseHttpBody(response.body);
						if (parsed === null)
							return cleanupReject(new Error("Empty or HTML response: " + url));
						resolve(parsed);
					} catch (parseErr) {
						cleanupReject(new Error("JSON parse error: " + url));
					}
				})
				.catch((err) => {
					if (timedOut) return;
					clearTimeout(timer);
					reject(err);
				});
		});
	}

	/**
	 * fetchJson with retry for transient failures.
	 */
	function fetchJsonWithRetry(url, timeoutMs, maxRetries) {
		maxRetries = maxRetries || 2;
		let attempts = 0;

		function attempt() {
			return fetchJson(url, timeoutMs).catch((err) => {
				attempts++;
				// Only retry on transient errors (timeout, network, 5xx)
				const msg = (err && err.message) || "";
				if (
					attempts <= maxRetries &&
					(msg.indexOf("Timeout") !== -1 ||
						msg.indexOf("Empty") !== -1 ||
						msg.indexOf("HTTP 5") !== -1 ||
						msg.indexOf("HTTP 0") !== -1)
				) {
					const delay = Math.pow(2, attempts) * 200; // 400ms, 800ms
					logWarn(
						"fetchJsonWithRetry",
						"Retry " +
							attempts +
							"/" +
							maxRetries +
							" for " +
							url +
							" after " +
							delay +
							"ms",
					);
					return new Promise((r) => setTimeout(r, delay)).then(attempt);
				}
				throw err;
			});
		}

		return attempt();
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 8: ADDON MANIFEST ACCESSORS
	// ────────────────────────────────────────────────────────────────

	function getCatalogueAddons() {
		try {
			if (manifest && Array.isArray(manifest.catalogueAddons))
				return manifest.catalogueAddons;
		} catch (e) {
			logWarn("getCatalogueAddons", "manifest not available");
		}
		return [];
	}

	function getStreamingAddons() {
		try {
			if (manifest && Array.isArray(manifest.streamingAddons))
				return manifest.streamingAddons;
		} catch (e) {
			logWarn("getStreamingAddons", "manifest not available");
		}
		return [];
	}

	function getMetaAddons() {
		try {
			if (
				manifest &&
				Array.isArray(manifest.metaAddons) &&
				manifest.metaAddons.length > 0
			) {
				return manifest.metaAddons;
			}
			// Fallback: auto-detect Cinemeta from catalogue addons
			const cats = getCatalogueAddons();
			if (cats.length > 0) {
				const detected = [];
				const patterns = ["cinemeta", "cinemata"];
				for (let ci = 0; ci < cats.length; ci++) {
					const lower = cats[ci].toLowerCase();
					for (let pi = 0; pi < patterns.length; pi++) {
						if (lower.indexOf(patterns[pi]) !== -1) {
							detected.push(cats[ci]);
							break;
						}
					}
				}
				if (detected.length > 0) return detected;
			}
			return cats;
		} catch (e) {
			logWarn("getMetaAddons", "Failed to resolve meta addons");
			return getCatalogueAddons();
		}
	}

	function getManifest(url) {
		const cacheKey = "mf:" + url;
		const cached = cacheGet(cacheKey);
		if (cached) return Promise.resolve(cached);
		if (isRateLimited(url)) {
			logWarn("getManifest", "Skipping rate-limited URL: " + url);
			return Promise.resolve(null);
		}

		return fetchJsonWithRetry(url, META_TIMEOUT)
			.then((data) => {
				if (data) cacheSet(cacheKey, data);
				return data;
			})
			.catch((err) => {
				logError("getManifest", "Failed to fetch manifest: " + url, err);
				return null;
			});
	}

	function fetchManifests(urls) {
		const results = [];
		const uncachedUrls = [];
		const uncachedIndices = [];

		for (let i = 0; i < urls.length; i++) {
			const cached = cacheGet("mf:" + urls[i]);
			if (cached) {
				results[i] = { url: urls[i], manifest: cached, index: i };
			} else {
				results[i] = null;
				uncachedUrls.push(urls[i]);
				uncachedIndices.push(i);
			}
		}

		if (uncachedUrls.length === 0) {
			return Promise.resolve(results.filter((r) => r !== null));
		}

		return httpBatch(uncachedUrls).then((batchResults) => {
			const retryUrls = [];
			const retryIndices = [];
			for (let j = 0; j < batchResults.length; j++) {
				const idx = uncachedIndices[j];
				const url = uncachedUrls[j];
				if (batchResults[j].ok && batchResults[j].data) {
					cacheSet("mf:" + url, batchResults[j].data);
					results[idx] = {
						url: url,
						manifest: batchResults[j].data,
						index: idx,
					};
				} else if (batchResults[j].status === 429) {
					logWarn("fetchManifests", "Rate-limited: " + url);
				} else {
					// Transient failure — retry once
					retryUrls.push(url);
					retryIndices.push(idx);
				}
			}
			if (retryUrls.length > 0) {
				return httpBatch(retryUrls).then((retryResults) => {
					for (let j = 0; j < retryResults.length; j++) {
						const idx = retryIndices[j];
						if (retryResults[j].ok && retryResults[j].data) {
							cacheSet("mf:" + retryUrls[j], retryResults[j].data);
							results[idx] = {
								url: retryUrls[j],
								manifest: retryResults[j].data,
								index: idx,
							};
						} else {
							logWarn("fetchManifests", "Retry failed: " + retryUrls[j]);
						}
					}
					return results.filter((r) => r !== null);
				});
			}
			return results.filter((r) => r !== null);
		});
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 9: VIDEO ID PARSING
	// ────────────────────────────────────────────────────────────────

	/**
	 * Parses a video ID from various formats:
	 *   - IMDb IDs: "tt1254207", "tt0386676:1:1"
	 *   - TMDB IDs (from catalogue): "tmdb:12345", "tmdb:12345:1:1"
	 *   - Pipe-delimited: "tmdb:1634301||Name||year||type||poster||desc"
	 *   - JSON-encoded: '{"i":"tt1254207","t":"movie","s":1,"e":1}'
	 */
	function parseVideoId(raw) {
		if (!raw) return null;

		// Try JSON-encoded IDs
		const parsed = safeJson(raw, null);
		if (parsed && parsed.i !== undefined) {
			return {
				id: safeStr(parsed.i),
				type: parsed.t || null,
				season: parsed.s || 0,
				episode: parsed.e || 0,
				idPrefix: detectIdPrefix(safeStr(parsed.i)),
			};
		}

		// Colon-separated format
		if (raw.indexOf(":") !== -1) {
			const parts = raw.split(":");
			const first = parts[0];

			// IMDb series episode: "ttXXXXXX:season:episode"
			if (/^tt\d+$/.test(first) && parts.length >= 3) {
				const sn = parseInt(parts[1], 10);
				const en = parseInt(parts[2], 10);
				return {
					id: first,
					type: "series",
					season: isNaN(sn) ? 0 : sn,
					episode: isNaN(en) ? 0 : en,
					idPrefix: "tt",
				};
			}

			// tmdb: series episode: "tmdb:XXXX:season:episode"
			if (first === "tmdb" && parts.length >= 4) {
				let tmdbRawId = parts[1];
				const pipeIdx = tmdbRawId.indexOf("||");
				if (pipeIdx !== -1) tmdbRawId = tmdbRawId.substring(0, pipeIdx);
				const sn = parseInt(parts[2], 10);
				const en = parseInt(parts[3], 10);
				return {
					id: "tmdb:" + tmdbRawId,
					type: "series",
					season: isNaN(sn) ? 0 : sn,
					episode: isNaN(en) ? 0 : en,
					idPrefix: "tmdb:",
				};
			}

			// Service-prefixed ID: "tmdb:1234"
			if (/^[a-zA-Z]+$/.test(first) && parts.length >= 2) {
				if (first === "tmdb") {
					let serviceParts = parts[1];
					const pipeIdx2 = serviceParts.indexOf("||");
					if (pipeIdx2 !== -1)
						serviceParts = serviceParts.substring(0, pipeIdx2);
					let typeHint = null;
					const metaParts = parts[1].split("||");
					const cleanTmid = metaParts[0];
					if (metaParts.length >= 4) {
						typeHint = metaParts[3] === "series" ? "series" : "movie";
					}
					return {
						id: "tmdb:" + cleanTmid,
						type: typeHint || null,
						season: 0,
						episode: 0,
						idPrefix: "tmdb:",
					};
				}
				return {
					id: raw,
					type: null,
					season: 0,
					episode: 0,
					idPrefix: detectIdPrefix(raw),
				};
			}
		}

		// Bare IMDb ID
		if (/^tt\d+$/.test(raw)) {
			return { id: raw, type: null, season: 0, episode: 0, idPrefix: "tt" };
		}

		// Numeric ID
		if (/^\d+$/.test(raw)) {
			return {
				id: raw,
				type: null,
				season: 0,
				episode: 0,
				idPrefix: "numeric",
			};
		}

		return {
			id: raw,
			type: null,
			season: 0,
			episode: 0,
			idPrefix: detectIdPrefix(raw),
		};
	}

	function detectIdPrefix(raw) {
		if (!raw) return "unknown";
		const r = raw.toLowerCase();
		if (/^tt\d+/.test(r)) return "tt";
		if (r.indexOf("tmdb:") === 0) return "tmdb:";
		if (/^\d+$/.test(r)) return "numeric";
		return "unknown";
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 10: METADATA → SKYSTREAM CONVERTERS
	// ────────────────────────────────────────────────────────────────

	function parseYear(meta) {
		if (!meta) return undefined;
		if (meta.year != null) {
			const y = parseInt(meta.year, 10);
			if (y > 1900 && y < 2100) return y;
		}
		if (meta.releaseInfo) {
			const parts = safeStr(meta.releaseInfo).split(/[–-]/).shift().trim();
			const y = parseInt(parts, 10);
			if (y > 1900 && y < 2100) return y;
		}
		return undefined;
	}

	function parseRating(meta) {
		if (!meta) return undefined;
		if (meta.imdbRating != null) {
			const r = parseFloat(meta.imdbRating);
			if (!isNaN(r) && r >= 0 && r <= 10) return r;
		}
		if (meta.score != null) {
			const r = parseFloat(meta.score);
			if (!isNaN(r) && r >= 0 && r <= 10) return r;
		}
		return undefined;
	}

	function parseGenres(meta) {
		if (!meta) return undefined;
		const g = meta.genres || meta.genre || meta.tags;
		if (Array.isArray(g) && g.length > 0) {
			if (typeof g[0] === "object" && g[0].name) {
				return g.map((x) => x.name);
			}
			return g;
		}
		return undefined;
	}

	function toItem(m, fallbackType) {
		try {
			if (!m || !m.id) return null;
			return new MultimediaItem({
				title:
					m.name || m.title || m.originalName || m.original_title || "Unknown",
				url: m.id || "",
				posterUrl:
					m.poster || m.posterUrl || m.poster_path || m.thumbnail || "",
				bannerUrl:
					m.background ||
					m.backdrop ||
					m.banner ||
					m.bannerUrl ||
					m.backdrop_path ||
					"",
				logoUrl: m.logo || m.logoUrl || "",
				type: skyType(m.type || fallbackType || "movie"),
				description: safeStr(m.description || m.overview || m.synopsis || "")
					.replace(/<[^>]*>/g, "")
					.trim()
					.substring(0, 500),
				year: parseYear(m),
				score: parseRating(m),
				genres: parseGenres(m),
			});
		} catch (e) {
			logError("toItem", "Failed to convert meta item", e);
			return null;
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 11: STREAM QUALITY / FORMATTING
	// ────────────────────────────────────────────────────────────────

	function parseStreamFeatures(text) {
		const result = {
			resolution: "Auto",
			codec: null,
			hdr: null,
			audio: null,
			channels: null,
			sourceType: "unknown",
			_sortKey: 2,
		};
		if (!text) return result;

		const str = text.toLowerCase();

		if (/\b(2160|4k|uhd)\b/.test(str)) {
			result.resolution = "4K";
			result._sortKey = 5;
		} else if (/\b1440\b/.test(str)) {
			result.resolution = "1440p";
			result._sortKey = 4;
		} else if (/\b1080\b/.test(str)) {
			result.resolution = "1080p";
			result._sortKey = 3;
		} else if (/\b720\b/.test(str)) {
			result.resolution = "720p";
			result._sortKey = 2;
		} else if (/\b480\b/.test(str)) {
			result.resolution = "480p";
			result._sortKey = 1;
		} else if (/\b360\b/.test(str)) {
			result.resolution = "360p";
			result._sortKey = 1;
		} else if (/\b(cam|ts|tc|scr|workprint|hqcam)\b/.test(str)) {
			result.resolution = "CAM";
			result._sortKey = 0;
		}

		if (/\b(av1|av01)\b/.test(str)) result.codec = "AV1";
		else if (/\b(x?v?265|hevc)\b/.test(str)) result.codec = "HEVC";
		else if (/\b(x264|h\.?264|avc)\b/.test(str)) result.codec = "H.264";
		else if (/\b(vp9|vp9\.2)\b/.test(str)) result.codec = "VP9";
		else if (/\b(vc[\s-]?1|vc1)\b/.test(str)) result.codec = "VC-1";
		else if (/\b(xvid|divx)\b/.test(str)) result.codec = "XviD";

		if (/\b(dv|dovi|dolby[\s._-]?vision)\b/.test(str)) result.hdr = "DV";
		else if (/\bhdr10\+\b/.test(str)) result.hdr = "HDR10+";
		else if (/\bhdr10\b/.test(str)) result.hdr = "HDR10";
		else if (/\bhdr\b/.test(str)) result.hdr = "HDR";
		if (/\bhlg\b/.test(str))
			result.hdr = result.hdr ? result.hdr + "+HLG" : "HLG";

		if (/\b(atmos|truehd)\b/.test(str)) result.audio = "Atmos";
		else if (/\bdts[-\s]?hd\b/.test(str)) result.audio = "DTS-HD";
		else if (/\bdts\b/.test(str)) result.audio = "DTS";
		else if (/\b(flac|lpcm)\b/.test(str)) result.audio = "FLAC";
		else if (/\b(e?aac)\b/.test(str)) result.audio = "AAC";
		else if (/\bmp3\b/.test(str)) result.audio = "MP3";
		else if (/\bopus\b/.test(str)) result.audio = "Opus";

		const ch = str.match(/\b[257]\.1\b/);
		if (ch) result.channels = ch[0];

		if (/\btorrent\b/.test(str) || /\binfohash\b/.test(str))
			result.sourceType = "torrent";
		else if (
			/\bhttp\b/.test(str) ||
			/\bhls\b/.test(str) ||
			/\bm3u8\b/.test(str) ||
			/\bmpd\b/.test(str)
		)
			result.sourceType = "http";
		else if (/\byoutube\b/.test(str) || /\bytId\b/.test(str))
			result.sourceType = "youtube";

		return result;
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 12: STREAM FORMATTING ENGINE
	// ────────────────────────────────────────────────────────────────

	function normalizeStreamUrl(url) {
		if (!url) return null;
		const lower = url.toLowerCase();
		if (lower.indexOf("data:text/plain") === 0) return null;
		if (lower.indexOf("/login.") !== -1 || lower.indexOf("/logout") !== -1)
			return null;
		if (
			lower.indexOf("magnet:") === 0 &&
			lower.indexOf("urn:btih:") === -1 &&
			lower.indexOf("btih=") === -1
		)
			return null;
		return url;
	}

	function extractHeaders(stream, baseUrlVal) {
		const headers = {};

		if (
			stream.behaviorHints &&
			stream.behaviorHints.proxyHeaders &&
			stream.behaviorHints.proxyHeaders.request
		) {
			const src = stream.behaviorHints.proxyHeaders.request;
			if (src) {
				for (const hk in src) {
					if (Object.prototype.hasOwnProperty.call(src, hk)) {
						headers[hk] = src[hk];
					}
				}
			}
		}

		if (!headers["User-Agent"]) headers["User-Agent"] = UA;
		if (!headers["Referer"]) headers["Referer"] = baseUrlVal + "/";
		if (!headers["Origin"]) headers["Origin"] = baseUrlVal;

		return headers;
	}

	function extractBehaviorHints(stream) {
		const bh = {};
		if (stream.behaviorHints) {
			for (const key in stream.behaviorHints) {
				if (Object.prototype.hasOwnProperty.call(stream.behaviorHints, key)) {
					if (key !== "proxyHeaders" && key !== "headers") {
						bh[key] = stream.behaviorHints[key];
					}
				}
			}
		}
		return bh;
	}

	function extractSubtitles(stream) {
		if (
			stream.subtitles &&
			Array.isArray(stream.subtitles) &&
			stream.subtitles.length > 0
		) {
			const subs = [];
			for (let si = 0; si < stream.subtitles.length; si++) {
				const sub = stream.subtitles[si];
				if (sub && sub.url && sub.lang) {
					subs.push({ url: sub.url, label: sub.lang, lang: sub.lang });
				}
			}
			return subs.length > 0 ? subs : undefined;
		}
		return undefined;
	}

	function buildDisplaySource(stream, addonTag) {
		const parts = [];

		if (stream.name) {
			const segs = safeStr(stream.name).split("\n");
			for (let ni = 0; ni < segs.length; ni++) {
				const s = segs[ni].trim();
				if (s) parts.push(s);
			}
		}

		const contentText =
			safeStr(stream.title).trim() || safeStr(stream.description).trim();
		if (contentText) {
			const segs = contentText.split("\n");
			for (let si = 0; si < segs.length; si++) {
				const s = segs[si].trim();
				if (s) parts.push(s);
			}
		}

		return parts.length > 0 ? addonTag + " " + parts.join(" | ") : addonTag;
	}

	function formatStream(stream, addonIndex, baseUrlVal, addonDisplayName) {
		try {
			if (!stream) return null;

			const origName = safeStr(stream.name).trim();
			const origTitle = safeStr(stream.title).trim();
			const origDesc = safeStr(stream.description).trim();

			const flatten = (s) => s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
			const combined =
				flatten(origName) + " " + flatten(origTitle) + " " + flatten(origDesc);
			const features = parseStreamFeatures(combined);

			const addonLabel = addonDisplayName || "#" + addonIndex;
			const addonTag = "[" + addonLabel + "]";
			const displaySource = buildDisplaySource(stream, addonTag);

			const headers = extractHeaders(stream, baseUrlVal);
			const bh = extractBehaviorHints(stream);
			const subs = extractSubtitles(stream);

			// Validate URL
			if (stream.url) {
				const validated = normalizeStreamUrl(stream.url);
				if (validated === null) {
					logWarn(
						"formatStream",
						"Filtered invalid stream URL from " + addonLabel,
					);
					return null;
				}
			}

			// Type 1: Direct HTTP(S) URL
			if (stream.url && isHttp(stream.url)) {
				return formatHttpStream(
					stream,
					features,
					addonTag,
					displaySource,
					headers,
					bh,
					subs,
					baseUrlVal,
				);
			}

			// Type 2: Torrent (infoHash)
			if (stream.infoHash) {
				return formatTorrentStream(
					stream,
					features,
					addonTag,
					displaySource,
					headers,
					bh,
					subs,
				);
			}

			// Type 3: YouTube
			if (stream.ytId) {
				return new StreamResult({
					url: "https://www.youtube.com/watch?v=" + stream.ytId,
					quality: "YouTube",
					source: addonTag + " YouTube",
					headers: { Referer: "https://www.youtube.com/", "User-Agent": UA },
					behaviorHints: { notWebReady: true },
					_sortKey: 1,
				});
			}

			// Type 4: External URL
			if (stream.externalUrl) {
				if (Object.keys(bh).length === 0) bh.notWebReady = true;
				return new StreamResult({
					url: stream.externalUrl,
					quality: features.resolution,
					source: addonTag + " External",
					headers: headers,
					behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
					_sortKey: features._sortKey,
				});
			}

			// Type 5: Usenet (NZB)
			if (stream.nzbUrl) {
				if (Object.keys(bh).length === 0) bh.notWebReady = true;
				return new StreamResult({
					url: stream.nzbUrl,
					quality: features.resolution,
					source: addonTag + " Usenet",
					headers: headers,
					behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
					_sortKey: features._sortKey,
				});
			}

			// Type 6: Archive-based streams
			const archiveTypes = [
				{ key: "rarUrls", label: "RAR" },
				{ key: "zipUrls", label: "ZIP" },
				{ key: "7zipUrls", label: "7z" },
				{ key: "tgzUrls", label: "TGZ" },
				{ key: "tarUrls", label: "TAR" },
			];
			for (let ai = 0; ai < archiveTypes.length; ai++) {
				const at = archiveTypes[ai];
				if (Array.isArray(stream[at.key]) && stream[at.key].length) {
					const src = stream[at.key][0];
					const srcUrl = typeof src === "string" ? src : src.url || "";
					if (srcUrl) {
						if (Object.keys(bh).length === 0) bh.notWebReady = true;
						return new StreamResult({
							url: srcUrl,
							quality: features.resolution,
							source: addonTag + " " + at.label,
							headers: headers,
							behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
							_sortKey: features._sortKey,
						});
					}
				}
			}

			// Type 7: Fallback raw URL
			if (stream.url) {
				return formatFallbackStream(
					stream,
					features,
					displaySource,
					headers,
					bh,
					subs,
				);
			}

			return null;
		} catch (e) {
			logError(
				"formatStream",
				"Failed to format stream from addon #" + addonIndex,
				e,
			);
			return null;
		}
	}

	function formatHttpStream(
		stream,
		features,
		addonTag,
		displaySource,
		headers,
		bh,
		subs,
		baseUrlVal,
	) {
		const isDirectMedia = /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(stream.url);
		const isStreamingPlaylist = /\.(m3u8|mpd)(\?|$)/i.test(stream.url);
		const isMaybeProxied =
			/(extract|proxy|redirect|gateway|fetch|resolve)/i.test(stream.url);

		const hasExtraHeaders = Object.keys(headers).length > 1;
		let finalUrl = stream.url;
		if (hasExtraHeaders && !isDirectMedia) {
			finalUrl =
				typeof btoa !== "undefined"
					? "MAGIC_PROXY_v1" + btoa(stream.url)
					: stream.url;
		}

		if (
			!bh.notWebReady &&
			(!isDirectMedia || isMaybeProxied || isStreamingPlaylist)
		) {
			bh.notWebReady = true;
		}

		const result = new StreamResult({
			url: finalUrl,
			quality: features.resolution,
			source: displaySource,
			cached: !!stream.cached,
			size: stream.size || null,
			headers: headers,
			behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
			subtitles: subs,
			_sortKey: features._sortKey,
		});

		if (isStreamingPlaylist && !result.headers["Origin"]) {
			try {
				result.headers["Origin"] = new URL(stream.url).origin;
			} catch (e) {
				logWarn(
					"formatStream",
					"Could not parse origin URL: " + (stream.url || ""),
				);
			}
		}

		return result;
	}

	function formatTorrentStream(
		stream,
		features,
		addonTag,
		displaySource,
		headers,
		bh,
		subs,
	) {
		const filename =
			(stream.behaviorHints && stream.behaviorHints.filename) ||
			stream.title ||
			stream.name ||
			"";
		if (Object.keys(bh).length === 0) bh.notWebReady = true;

		// Ensure trackers are loaded (fire and forget for magnet generation)
		// This will eventually populate TRACKERS; first calls use fallbacks
		ensureTrackersLoaded();

		return new StreamResult({
			url: magnetLink(stream.infoHash, filename),
			infoHash: stream.infoHash,
			fileIndex: stream.fileIdx !== undefined ? stream.fileIdx : 0,
			quality: features.resolution,
			source: displaySource,
			headers: headers,
			behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
			subtitles: subs,
			_sortKey: features._sortKey,
		});
	}

	function formatFallbackStream(
		stream,
		features,
		displaySource,
		headers,
		bh,
		subs,
	) {
		let hash = null;
		if (stream.url.indexOf("magnet:?xt=urn:btih:") === 0) {
			const magnetMatch = stream.url.match(/urn:btih:([a-fA-F0-9]+)/);
			if (magnetMatch) hash = magnetMatch[1].toLowerCase();
		}
		if (
			Object.keys(bh).length === 0 &&
			(hash || stream.url.indexOf("magnet:") === 0)
		) {
			bh.notWebReady = true;
		}
		const result = new StreamResult({
			url: stream.url,
			quality: features.resolution,
			source: displaySource,
			headers: headers,
			behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
			subtitles: subs,
			_sortKey: features._sortKey,
		});
		if (hash) {
			result.infoHash = hash;
			result.fileIndex = 0;
		}
		return result;
	}

	function processStreams(streams, addonIndex, baseUrlVal, addonDisplayName) {
		if (!Array.isArray(streams)) return [];
		const out = [];
		for (let i = 0; i < streams.length; i++) {
			try {
				const formatted = formatStream(
					streams[i],
					addonIndex,
					baseUrlVal,
					addonDisplayName,
				);
				if (formatted) {
					out.push(formatted);
				} else {
					logWarn(
						"processStreams",
						"Skipped invalid stream #" + i + " from " + addonDisplayName,
					);
				}
			} catch (e) {
				logError(
					"processStreams",
					"Error formatting stream #" + i + " from " + addonDisplayName,
					e,
				);
			}
		}
		return out;
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 13: getHome() — Dashboard Catalogs
	// ────────────────────────────────────────────────────────────────

	async function getHome(cb, page) {
		try {
			const pageNum = parseInt(page) || 1;
			const addonUrls = getCatalogueAddons();

			if (!addonUrls.length) {
				logWarn("getHome", "No catalogueAddons configured in plugin.json");
				return cb({
					success: false,
					errorCode: "NO_ADDONS",
					message: "No catalogueAddons configured in plugin.json",
				});
			}

			const manifests = await fetchManifests(addonUrls);

			if (!manifests.length) {
				logWarn("getHome", "Could not fetch any addon manifests");
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "Could not fetch any addon manifests",
				});
			}

			const catalogJobs = [];
			for (let mi = 0; mi < manifests.length; mi++) {
				const mf = manifests[mi].manifest;
				const addonBaseUrlVal = baseUrl(manifests[mi].url);

				if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;

				for (let ci = 0; ci < mf.catalogs.length; ci++) {
					const cat = mf.catalogs[ci];
					if (!cat || !cat.id || !cat.type) continue;

					const extras = cat.extra || [];
					const requiresSearch = extras.some(
						(e) => e && e.name === "search" && e.isRequired === true,
					);
					if (requiresSearch) continue;

					let catUrl =
						addonBaseUrlVal + "/catalog/" + cat.type + "/" + cat.id + ".json";
					if (pageNum > 1) {
						const skip = (pageNum - 1) * CATALOG_PAGE_SIZE;
						catUrl += (catUrl.indexOf("?") === -1 ? "?" : "&") + "skip=" + skip;
					}

					catalogJobs.push({
						url: catUrl,
						addonIndex: mi,
						categoryName: cat.name || cat.id,
						categoryType: cat.type,
					});
				}
			}

			if (!catalogJobs.length) {
				logWarn("getHome", "No browsable catalogs found in addon manifests");
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "No browsable catalogs found in addon manifests",
				});
			}

			const catalogUrls = catalogJobs.map((j) => j.url);
			const catCacheKey = "catalog:page:" + pageNum;
			let catalogResponses = cacheGet(catCacheKey);
			if (!catalogResponses) {
				catalogResponses = await httpBatch(catalogUrls);
				cacheSet(catCacheKey, catalogResponses);
			}

			const organizedData = {};
			const categoryOrder = [];

			for (let ri = 0; ri < catalogResponses.length; ri++) {
				const response = catalogResponses[ri];
				const job = catalogJobs[ri];

				if (
					!response.ok ||
					!response.data ||
					!Array.isArray(response.data.metas) ||
					!response.data.metas.length
				) {
					if (response.status === 429) {
						logWarn("getHome", "Rate-limited catalog: " + job.url);
					}
					continue;
				}

				const items = response.data.metas
					.map((m) => toItem(m, job.categoryType))
					.filter(Boolean);

				if (!items.length) continue;

				const catLabel = job.categoryName;

				if (!organizedData[catLabel]) {
					organizedData[catLabel] = items;
					categoryOrder.push(catLabel);
				}
			}

			if (Object.keys(organizedData).length === 0) {
				logWarn("getHome", "No catalog data returned from any addon");
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "No catalog data returned from any addon",
				});
			}

			const finalData = {};
			for (let i = 0; i < categoryOrder.length; i++) {
				if (organizedData[categoryOrder[i]]) {
					finalData[categoryOrder[i]] = organizedData[categoryOrder[i]];
				}
			}

			logWarn(
				"getHome",
				"Returning " +
					Object.keys(finalData).length +
					" categories (page " +
					pageNum +
					")",
			);
			cb({ success: true, data: finalData, page: pageNum });
		} catch (e) {
			logError("getHome", "Unexpected error", e);
			cb({
				success: false,
				errorCode: "HOME_ERROR",
				message: safeStr(e.message || e),
			});
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 14: search() — MetaAddons Search
	// ────────────────────────────────────────────────────────────────

	async function search(query, cb) {
		try {
			let q = safeStr(query).trim().toLowerCase();
			if (!q) return cb({ success: true, data: [] });
			if (q.length > MAX_SEARCH_QUERY_LENGTH) {
				q = q.substring(0, MAX_SEARCH_QUERY_LENGTH);
			}

			const addonUrls = getMetaAddons();
			const allItems = [];
			const seenUrls = {};

			function addItem(item) {
				if (item && item.url && !seenUrls[item.url]) {
					seenUrls[item.url] = true;
					allItems.push(item);
				}
			}

			if (addonUrls.length > 0) {
				const manifests = await fetchManifests(addonUrls);

				const searchJobs = [];
				for (let mi = 0; mi < manifests.length; mi++) {
					const mf = manifests[mi].manifest;
					const addonBaseUrlVal = baseUrl(manifests[mi].url);

					if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length)
						continue;

					for (let ci = 0; ci < mf.catalogs.length; ci++) {
						const cat = mf.catalogs[ci];
						if (!cat || !cat.id || !cat.type) continue;
						const extras = cat.extra || [];
						if (extras.some((e) => e && e.name === "search")) {
							searchJobs.push({
								url:
									addonBaseUrlVal +
									"/catalog/" +
									cat.type +
									"/" +
									cat.id +
									"/search=" +
									encodeURIComponent(q) +
									".json",
								catType: cat.type,
							});
						}
					}
				}

				if (searchJobs.length > 0) {
					const urls = searchJobs.map((j) => j.url);
					const searchCacheKey = "search:" + q;
					let responses = cacheGet(searchCacheKey);
					if (!responses) {
						responses = await httpBatch(urls);
						cacheSet(searchCacheKey, responses);
					}

					for (
						let ri = 0;
						ri < responses.length && allItems.length < MAX_SEARCH_RESULTS;
						ri++
					) {
						const resp = responses[ri];
						const job = searchJobs[ri];
						if (resp.ok && resp.data && Array.isArray(resp.data.metas)) {
							for (
								let mi = 0;
								mi < resp.data.metas.length &&
								allItems.length < MAX_SEARCH_RESULTS;
								mi++
							) {
								addItem(toItem(resp.data.metas[mi], job.catType));
							}
						}
					}
				}
			}

			cb({ success: true, data: allItems.slice(0, MAX_SEARCH_RESULTS) });
		} catch (e) {
			logError("search", "Search failed for query: " + query, e);
			cb({ success: true, data: [] });
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 15: load() — Metadata Loading
	// ────────────────────────────────────────────────────────────────

	async function load(url, cb) {
		let rawInput = safeStr(url).trim();
		let knownType = null;
		let season = 0;
		let episode = 0;
		let metaId = null;
		let idPrefix = "unknown";

		try {
			if (!rawInput) {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "No video ID provided",
				});
			}

			const parsed = parseVideoId(rawInput);
			metaId = parsed ? parsed.id : rawInput;
			knownType = parsed ? parsed.type : null;
			idPrefix = parsed ? parsed.idPrefix : "unknown";
			season = parsed ? parsed.season : 0;
			episode = parsed ? parsed.episode : 0;

			if (!metaId) {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Could not parse video ID: " + rawInput,
				});
			}

			let callbackCalled = false;
			function safeCallback(result) {
				if (!callbackCalled) {
					callbackCalled = true;
					cb(result);
				}
			}

			const addonUrls = getMetaAddons();

			// ── TMDB ID with pipe format → resolve to IMDb for full compatibility ──
			if (idPrefix === "tmdb:" && rawInput.indexOf("||") !== -1) {
				const pipeParts = rawInput.split("||");
				if (pipeParts.length >= 4) {
					const cleanTmdbId = pipeParts[0];
					const pipeType = (pipeParts[3] || "").toLowerCase();

					const imdbId = await resolveTmdbToImdb(cleanTmdbId, pipeType);
					if (imdbId) {
						logWarn(
							"load",
							"TMDB→IMDB resolution: " + cleanTmdbId + " → " + imdbId,
						);
						const pipeSeason = pipeParts.length >= 7 ? pipeParts[6] : "";
						const pipeEpisode = pipeParts.length >= 8 ? pipeParts[7] : "";
						const resolvedInput =
							imdbId +
							(pipeSeason ? ":" + pipeSeason : "") +
							(pipeEpisode ? ":" + pipeEpisode : "");

						const resolvedParsed = parseVideoId(resolvedInput);
						metaId = resolvedParsed ? resolvedParsed.id : imdbId;
						knownType = resolvedParsed
							? resolvedParsed.type
							: pipeType === "series"
								? "series"
								: "movie";
						idPrefix = "tt";
						season = resolvedParsed ? resolvedParsed.season : 0;
						episode = resolvedParsed ? resolvedParsed.episode : 0;
						// Fall through to the general meta addon loop below with IMDb ID
					} else {
						// Fallback: pipe format extraction (zero API calls, instant)
						respondPipeMetadata(pipeParts, metaId, safeCallback, rawInput);
						return;
					}
				}
			}

			// ── Try meta addons — parallelized for speed ──
			let bestMeta = null;
			if (addonUrls.length > 1) {
				const metaResults = await Promise.allSettled(
					addonUrls.map(async (addonUrl) => {
						if (isRateLimited(addonUrl)) return null;
						return fetchMeta(baseUrl(addonUrl), metaId, knownType);
					}),
				);
				for (let i = 0; i < metaResults.length; i++) {
					if (metaResults[i].status === "fulfilled" && metaResults[i].value) {
						bestMeta = metaResults[i].value;
						break;
					}
				}
			} else if (addonUrls.length === 1) {
				if (!isRateLimited(addonUrls[0])) {
					bestMeta = await fetchMeta(baseUrl(addonUrls[0]), metaId, knownType);
				}
			}

			if (bestMeta) {
				respondMeta(bestMeta, metaId, safeCallback, knownType, season, episode);
				return;
			}

			// ── Absolute fallback ──
			logWarn("load", "No metadata found for " + rawInput + ", using fallback");
			respondFallback(rawInput, knownType, season, episode, safeCallback);
		} catch (e) {
			logError("load", "Failed to load metadata for " + rawInput, e);
			// Fallback directly
			try {
				respondFallback(rawInput, knownType, season, episode, cb);
			} catch (e2) {
				cb({
					success: false,
					errorCode: "LOAD_ERROR",
					message: safeStr(e.message || e),
				});
			}
		}
	}

	function fetchMeta(addonBase, id, typeHint) {
		return new Promise((resolve) => {
			if (typeHint === "movie" || typeHint === "series") {
				// Known type → single request
				const qUrl =
					addonBase +
					"/meta/" +
					typeHint +
					"/" +
					encodeURIComponent(id) +
					".json";
				const timer = setTimeout(() => resolve(null), META_FETCH_TIMEOUT);

				http_get(qUrl, JSON_HEADERS)
					.then((resp) => {
						clearTimeout(timer);
						const metaData = extractMetaFromResponse(resp);
						if (metaData) return resolve(metaData);
						resolve(null);
					})
					.catch(() => {
						clearTimeout(timer);
						resolve(null);
					});
			} else {
				// Unknown type → query BOTH in parallel, pick best
				const results = {};
				let pending = 2;
				let done = false;
				const timers = {};

				function tryType(typeName) {
					const qUrl =
						addonBase +
						"/meta/" +
						typeName +
						"/" +
						encodeURIComponent(id) +
						".json";
					timers[typeName] = setTimeout(() => {
						if (done) return;
						if (pending > 0) pending--;
						if (pending <= 0) finalize();
					}, META_FETCH_TIMEOUT);

					http_get(qUrl, JSON_HEADERS)
						.then((resp) => {
							if (done) return;
							clearTimeout(timers[typeName]);
							const metaData = extractMetaFromResponse(resp);
							if (metaData && metaData.id) {
								results[typeName] = metaData;
							}
							if (pending > 0) pending--;
							if (pending <= 0 && !done) finalize();
						})
						.catch(() => {
							if (done) return;
							clearTimeout(timers[typeName]);
							if (pending > 0) pending--;
							if (pending <= 0 && !done) finalize();
						});
				}

				function finalize() {
					if (done) return;
					done = true;
					clearTimeout(timers.series);
					clearTimeout(timers.movie);
					if (results.series && results.movie) {
						const sEpisodes = results.series.videos
							? results.series.videos.length
							: 0;
						const mEpisodes = results.movie.videos
							? results.movie.videos.length
							: 0;
						return resolve(
							sEpisodes >= mEpisodes ? results.series : results.movie,
						);
					}
					if (results.series) return resolve(results.series);
					if (results.movie) return resolve(results.movie);
					resolve(null);
				}

				tryType("series");
				tryType("movie");
			}
		});
	}

	function extractMetaFromResponse(resp) {
		if (!resp || !resp.body) return null;
		const status = resp.status || 0;
		if (status !== 200 && status !== 206) return null;

		try {
			let parsed;
			if (typeof resp.body === "string") {
				const trimmed = resp.body.trim();
				if (!trimmed || trimmed.charAt(0) === "<") return null;
				parsed = JSON.parse(trimmed);
			} else {
				parsed = resp.body;
			}
			return (
				parsed.meta || (Array.isArray(parsed.metas) ? parsed.metas[0] : null)
			);
		} catch (e) {
			return null;
		}
	}

	function respondPipeMetadata(pipeParts, metaId, cb, rawInput) {
		const pipeName = pipeParts[1] || metaId;
		const pipeYear = parseInt(pipeParts[2], 10);
		const pipeType = (pipeParts[3] || "").toLowerCase();
		const pipePoster = pipeParts[4] || "";
		const pipeDesc = pipeParts.length >= 6 ? pipeParts[5] || "" : "";

		const isSeries = pipeType === "series" || pipeType === "tv";
		const skyTypeVal = isSeries ? "series" : "movie";
		const epName = isSeries ? "Watch" : "Full Movie";

		cb({
			success: true,
			data: new MultimediaItem({
				title: pipeName,
				url: metaId,
				posterUrl: pipePoster,
				posterShape: "poster",
				type: skyTypeVal,
				description: pipeDesc.replace(/<[^>]*>/g, "").trim(),
				year: pipeYear > 1900 && pipeYear < 2100 ? pipeYear : undefined,
				episodes: [
					new Episode({
						name: epName,
						url: metaId,
						season: 1,
						episode: 1,
						posterUrl: pipePoster,
					}),
				],
			}),
		});
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 16: respondMeta / respondFallback
	// ────────────────────────────────────────────────────────────────

	function respondMeta(meta, metaId, cb, knownType, season, episode) {
		try {
			const skyTypeVal = skyType(meta.type || knownType || "movie");
			const isSeries = skyTypeVal === "series";

			const description = safeStr(
				meta.description || meta.overview || meta.synopsis || "",
			)
				.replace(/<[^>]*>/g, "")
				.trim()
				.substring(0, 1000);

			const year = parseYear(meta);
			const score = parseRating(meta);

			// ── Episodes ──
			let episodes = [];
			if (isSeries && Array.isArray(meta.videos)) {
				episodes = meta.videos
					.map((v) => {
						try {
							return new Episode({
								name:
									v.name ||
									v.title ||
									"S" + (v.season || 1) + "E" + (v.episode || 1),
								url:
									v.imdb_id ||
									v.id ||
									(meta.id
										? meta.id + ":" + (v.season || 1) + ":" + (v.episode || 1)
										: ""),
								season: v.season || 1,
								episode: v.episode || 1,
								rating: v.rating ? parseFloat(v.rating) : undefined,
								runtime: v.runtime ? parseInt(v.runtime, 10) : undefined,
								airDate: v.released || v.airDate || v.firstAired || undefined,
								posterUrl: v.thumbnail || v.poster || meta.poster || "",
							});
						} catch (e) {
							return null;
						}
					})
					.filter(Boolean);
			}

			if (!episodes.length) {
				episodes.push(
					new Episode({
						name: isSeries ? "Watch" : "Full Movie",
						url: isSeries ? (meta.id || metaId) + ":1:1" : meta.id || metaId,
						season: 1,
						episode: 1,
						posterUrl: meta.poster || "",
					}),
				);
			}

			// ── Cast ──
			let cast = undefined;
			if (Array.isArray(meta.cast) && meta.cast.length > 0) {
				cast = extractCast(meta.cast);
			} else if (
				Array.isArray(meta.credits_cast) &&
				meta.credits_cast.length > 0
			) {
				cast = extractCast(meta.credits_cast);
			}

			// ── Trailers ──
			let trailers = undefined;
			if (Array.isArray(meta.trailers) && meta.trailers.length > 0) {
				trailers = [];
				for (let ti = 0; ti < meta.trailers.length; ti++) {
					try {
						const tr = meta.trailers[ti];
						const src = tr.source || tr.url || "";
						const trUrl =
							src.indexOf("http") === 0
								? src
								: "https://www.youtube.com/watch?v=" + src;
						trailers.push(
							new Trailer({
								url: trUrl,
								name: tr.name || tr.type || "Trailer",
							}),
						);
					} catch (e) {
						logWarn("respondMeta", "Failed to build trailer entry");
					}
				}
				if (trailers.length === 0) trailers = undefined;
			}

			// ── Director ──
			let director = undefined;
			if (meta.director) {
				director = Array.isArray(meta.director)
					? meta.director.filter(Boolean).join(", ")
					: safeStr(meta.director);
				if (!director) director = undefined;
			}

			const item = new MultimediaItem({
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
				episodes: episodes,
			});

			cb({ success: true, data: item });
		} catch (e) {
			logError("respondMeta", "Failed to build metadata response", e);
			const safeMeta = meta || {};
			const ft = skyType(safeMeta.type || "movie");
			cb({
				success: true,
				data: new MultimediaItem({
					title: safeMeta.name || safeMeta.title || "Unknown",
					url: metaId,
					type: ft,
					episodes: [
						new Episode({
							name: ft === "movie" ? "Full Movie" : "Watch",
							url: ft === "movie" ? metaId : metaId + ":1:1",
							season: 1,
							episode: 1,
						}),
					],
				}),
			});
		}
	}

	function extractCast(castList) {
		const result = [];
		for (let ci = 0; ci < Math.min(castList.length, 20); ci++) {
			try {
				const c = castList[ci];
				if (!c || (!c.name && !c.role && !c.character)) continue;
				let img = c.image || c.photo || c.profile_path || c.imageUrl || "";
				if (img && img.indexOf("http") !== 0) {
					img = TMDB_IMG_BASE + "/w185" + img;
				}
				result.push(
					new Actor({
						name: c.name || c.actor || "Unknown",
						role: c.role || c.character || "",
						image: img || undefined,
					}),
				);
			} catch (e) {
				logWarn("extractCast", "Failed to process cast member");
			}
		}
		return result.length > 0 ? result : undefined;
	}

	function respondFallback(rawInput, knownType, season, episode, cb) {
		try {
			const ft = skyType(knownType || "movie");
			const fs = season > 0 ? season : 1;
			const fe = episode > 0 ? episode : 1;
			const playId = ft === "movie" ? rawInput : rawInput + ":" + fs + ":" + fe;
			cb({
				success: true,
				data: new MultimediaItem({
					title: rawInput,
					url: rawInput,
					type: ft,
					episodes: [
						new Episode({
							name: ft === "movie" ? "Full Movie" : "Watch",
							url: playId,
							season: fs,
							episode: fe,
						}),
					],
				}),
			});
		} catch (e) {
			logError("respondFallback", "Fallback failed for " + rawInput, e);
			cb({
				success: false,
				errorCode: "FALLBACK_ERROR",
				message: safeStr(e.message || e),
			});
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 17: loadStreams() — Stream from all streaming addons
	// ────────────────────────────────────────────────────────────────

	function cleanStreamId(input) {
		// Strip pipe-delimited metadata: "tmdb:60625||Name||year||type||poster||desc" → "tmdb:60625"
		const pipeIdx = input.indexOf("||");
		if (pipeIdx !== -1) {
			return input.substring(0, pipeIdx);
		}
		return input;
	}

	async function loadStreams(url, cb) {
		try {
			let rawInput = safeStr(url).trim();
			if (!rawInput) {
				return cb({ success: true, data: [] });
			}

			// Strip pipe-delimited metadata — streaming addons need clean IDs
			rawInput = cleanStreamId(rawInput);

			// Resolve TMDB IDs to IMDb IDs before passing to streaming addons
			// for maximum compatibility (most addons only accept tt-prefixed IDs)
			if (/^tmdb:(\d+)/i.test(rawInput)) {
				const tmdbMatch = rawInput.match(/^tmdb:(\d+)/i);
				if (tmdbMatch) {
					const tmdbId = tmdbMatch[1];
					const hasSeasonEp = /:\d+:\d+$/.test(rawInput);
					const type = hasSeasonEp ? "tv" : "movie";
					const imdbId = await resolveTmdbToImdb(tmdbId, type);
					if (imdbId) {
						const suffix = hasSeasonEp ? rawInput.match(/:\d+:\d+$/)[0] : "";
						rawInput = imdbId + (suffix || "");
						logWarn(
							"loadStreams",
							"TMDB→IMDB resolution: tmdb:" + tmdbId + " → " + rawInput,
						);
					}
				}
			}

			// Check prefetch cache first
			const prefetched = cacheGet("prefetch:" + rawInput);
			if (prefetched) {
				logWarn(
					"loadStreams",
					"Returning " +
						prefetched.length +
						" pre-cached streams for " +
						rawInput,
				);
				return cb({ success: true, data: prefetched });
			}

			// Detect type from URL
			const isSeries = /:\d+:\d+$/.test(rawInput);
			const streamTypes = isSeries ? ["series"] : ["movie", "series"];

			const addonUrls = getStreamingAddons();
			if (!addonUrls.length) {
				return cb({ success: true, data: [] });
			}

			const manifests = await fetchManifests(addonUrls);

			// Build stream promises with addon index tracking
			const streamPromises = [];
			const promiseAddonMap = []; // Maps flat promise index → addon index

			for (let mi = 0; mi < manifests.length; mi++) {
				const mf = manifests[mi];
				if (!mf || !mf.manifest) continue;

				const addonManifest = mf.manifest;
				const addonBaseUrlVal = baseUrl(mf.url);
				const addonDisplayName = addonName(mf.url);

				// Check if this addon supports streaming
				if (!addonManifest.resources || !Array.isArray(addonManifest.resources))
					continue;

				let supportsStream = false;
				for (let ri = 0; ri < addonManifest.resources.length; ri++) {
					const res = addonManifest.resources[ri];
					if (
						typeof res === "string"
							? res === "stream"
							: res.name === "stream" || res.id === "stream"
					) {
						supportsStream = true;
						break;
					}
				}
				if (!supportsStream) continue;

				// Push one promise per stream type, tracking addon index
				for (let ti = 0; ti < streamTypes.length; ti++) {
					const streamType = streamTypes[ti];
					const streamUrl =
						addonBaseUrlVal +
						"/stream/" +
						streamType +
						"/" +
						encodeURIComponent(rawInput) +
						".json";

					promiseAddonMap.push(mi);

					streamPromises.push(
						new Promise((resolvePromise) => {
							const timer = setTimeout(() => {
								resolvePromise([]);
							}, STREAM_ADDON_TIMEOUT);

							http_get(streamUrl, JSON_HEADERS)
								.then((resp) => {
									clearTimeout(timer);
									if (resp && resp.status === 200 && resp.body) {
										const body =
											typeof resp.body === "string"
												? resp.body.trim()
												: JSON.stringify(resp.body);
										if (body && body.charAt(0) !== "<") {
											try {
												const parsed = JSON.parse(body);
												const streams = parsed.streams || [];
												const processed = processStreams(
													streams,
													mi,
													addonBaseUrlVal,
													addonDisplayName,
												);
												return resolvePromise(processed);
											} catch (e) {
												logWarn(
													"loadStreams",
													"Failed to parse stream response from " +
														addonDisplayName,
												);
											}
										}
									}
									resolvePromise([]);
								})
								.catch(() => {
									clearTimeout(timer);
									resolvePromise([]);
								});
						}),
					);
				}
			}

			const allStreamResults = await Promise.all(streamPromises);

			// Merge and dedup — using correct addon index via promiseAddonMap
			const merged = [];
			const seenDedup = {};

			for (let si = 0; si < allStreamResults.length; si++) {
				const arr = allStreamResults[si];
				if (!Array.isArray(arr)) continue;
				const addonIdx = promiseAddonMap[si] || si;

				for (let ii = 0; ii < arr.length; ii++) {
					const st = arr[ii];
					if (!st) continue;
					const dk = dedupKey(st, addonIdx);
					if (!seenDedup[dk]) {
						seenDedup[dk] = true;
						merged.push(st);
					}
				}
			}

			// Sort by quality (best first)
			merged.sort((a, b) => (b._sortKey || 0) - (a._sortKey || 0));

			// Cache the result for quick re-loads
			cacheSet("prefetch:" + rawInput, merged, STREAM_CACHE_TTL);

			logWarn(
				"loadStreams",
				"Returning " +
					merged.length +
					" streams for " +
					rawInput +
					" (from " +
					manifests.length +
					" addons)",
			);

			cb({ success: true, data: merged });
		} catch (e) {
			logError("loadStreams", "Failed for " + url, e);
			cb({ success: true, data: [] });
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 19: EXPORTS — registered on globalThis
	// ────────────────────────────────────────────────────────────────

	let g = typeof globalThis !== "undefined" ? globalThis : null;
	if (!g && typeof self !== "undefined") g = self;
	if (!g && typeof window !== "undefined") g = window;
	if (!g && typeof global !== "undefined") g = global;

	if (g) {
		g.getHome = getHome;
		g.search = search;
		g.load = load;
		g.loadStreams = loadStreams;
		// Pre-load trackers in background during init so first magnet link has full list
		ensureTrackersLoaded();
		logWarn("init", "Plugin loaded successfully");
	} else {
		logError(
			"init",
			"Could not register plugin exports — no global scope found",
		);
	}
})();
