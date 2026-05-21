(function () {
	"use strict";

	// ═══════════════════════════════════════════════════════════════════
	//  OnlyTorrents — Stremio Hub for SkyStream
	// ═══════════════════════════════════════════════════════════════════
	//
	//  ARCHITECTURE:
	//    getHome()     → catalogueAddons (browse catalogs only)
	//    search()      → Cinemeta (single authoritative source)
	//    load()        → Cinemeta only, with tmdb:→search fallback
	//    loadStreams() → streamingAddons (per-addon timeout + dedup)
	//
	//  Cinemeta-only design — mirrors official Stremio metadata sourcing.
	//  TMDB addon removed (causes wrong types, missing episodes for series).
	//  Pipe-delimited tmdb: IDs from catalogue are resolved via Cinemeta search.
	//
	//  KEY FEATURES:
	//    ★ Cinemeta-authoritative metadata (tt→direct, tmdb:→search→direct)
	//    ★ Cast photos from Cinemeta credits_cast (profile_path)
	//    ★ Streaming-safe episode URLs (use imdb_id / behaviorHints)
	//    ★ 30-min metadata cache
	//    ★ Rate limiting with backoff
	// ═══════════════════════════════════════════════════════════════════

	// ────────────────────────────────────────────────────────────────
	//  SECTION 1: CONFIGURATION & CONSTANTS
	// ────────────────────────────────────────────────────────────────

	var UA =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

	var JSON_HEADERS = {
		"User-Agent": UA,
		Accept: "application/json",
		"Accept-Language": "en-US,en;q=0.5",
	};

	var CACHE_TTL = 1800000; // 30 min — metadata cache
	var STREAM_CACHE_TTL = 180000; // 3 min  — read-through cache for streams
	var _cache = {};
	var CACHE_MAX_ENTRIES = 500;

	try {
		var ttlPref = parseInt(getPreference("hub_cache_ttl"), 10);
		if (ttlPref > 0) CACHE_TTL = ttlPref;
	} catch (e) {}

	// Per-addon stream timeout (80s) — prevents one slow addon blocking all
	var STREAM_ADDON_TIMEOUT = 80000;
	try {
		var stPref = parseInt(getPreference("hub_stream_timeout"), 10);
		if (stPref > 0) STREAM_ADDON_TIMEOUT = stPref;
	} catch (e) {}

	var META_TIMEOUT = 8000; // Manifest fetch timeout
	var META_FETCH_TIMEOUT = 12000; // Per-metadata-query timeout

	// Rate-limit: backoff 5min after 3 consecutive 429/503/502/504
	var _rateLimits = {};
	var RATE_BACKOFF_MS = 300000;
	var RATE_MAX_FAILS = 3;

	var MAX_SEARCH_RESULTS = 50;
	var MAX_SEARCH_QUERY_LENGTH = 200;
	var CATALOG_PAGE_SIZE = 20;

	// TMDB image base — kept for resolving Cinemeta's relative cast photo paths
	var TMDB_IMG_BASE = "https://image.tmdb.org/t/p";

	// ── Trackers ──
	var FALLBACK_TRACKERS = [
		"udp://tracker.opentrackr.org:1337/announce",
		"udp://open.demonii.com:1337/announce",
		"udp://tracker.torrent.eu.org:451/announce",
	];

	var TRACKERS_LIST_URLS = [
		"https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_all.txt",
		"https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/all.txt",
		"https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt",
		"https://raw.githubusercontent.com/ngosang/trackerslist/master/trackers_best.txt",
	];

	var TRACKERS = FALLBACK_TRACKERS.slice();
	var _trackersFetched = false;

	// ────────────────────────────────────────────────────────────────
	//  SECTION 2: UTILITY FUNCTIONS
	// ────────────────────────────────────────────────────────────────

	function baseUrl(manifestUrl) {
		return (manifestUrl || "")
			.replace(/\/manifest\.json$/, "")
			.replace(/\/$/, "");
	}

	function addonName(url) {
		try {
			var parts = url
				.replace(/https?:\/\//, "")
				.split("/")[0]
				.replace(/^www\./, "")
				.split(".");
			var name = parts[0] || "";
			if (/^[a-f0-9]{8,}$/i.test(name) && parts.length >= 2) {
				name = parts[parts.length - 2];
			}
			name = name.replace(/^[a-f0-9]{6,}-/i, "");
			var tlds = [
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
				for (var ni = 1; ni < parts.length - 1; ni++) {
					if (tlds.indexOf(parts[ni]) === -1 && parts[ni].length > 2) {
						name = parts[ni];
						break;
					}
				}
			}
			name = name.replace(/[-_]/g, " ").replace(/\b\w/g, function (c) {
				return c.toUpperCase();
			});
			return name.trim() || "Addon";
		} catch (e) {
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
		var sv = safeStr(status).toLowerCase();
		if (sv === "ended" || sv === "canceled") return "completed";
		if (sv === "returning series" || sv === "continuing" || sv === "ongoing")
			return "ongoing";
		if (sv === "in production" || sv === "planned") return "upcoming";
		return undefined;
	}

	function magnetLink(hash, name) {
		ensureTrackersLoaded();
		var m =
			"magnet:?xt=urn:btih:" + hash + "&dn=" + encodeURIComponent(name || hash);
		for (var i = 0; i < TRACKERS.length && i < 20; i++) {
			m += "&tr=" + encodeURIComponent(TRACKERS[i]);
		}
		return m;
	}

	function dedupKey(stream, addonIndex) {
		var prefix = addonIndex !== undefined ? addonIndex + ":" : "";
		if (stream.infoHash) return prefix + stream.infoHash.toLowerCase();
		var key = stream.url || "";
		key = key
			.replace(/^https?:\/\//, "")
			.replace(/\/+$/, "")
			.split("#")[0];
		return prefix + key.toLowerCase();
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 3: TRACKER LOADING
	// ────────────────────────────────────────────────────────────────

	function ensureTrackersLoaded() {
		if (_trackersFetched) return;
		_trackersFetched = true;

		try {
			var cachedRaw = getPreference("hub_trackers_list");
			if (cachedRaw) {
				var cached = safeJson(cachedRaw, null);
				if (cached && Array.isArray(cached) && cached.length > 0) {
					TRACKERS = cached;
					return;
				}
			}
		} catch (e) {}

		try {
			var allParsed = [];
			var seen = {};
			var remaining = TRACKERS_LIST_URLS.length;

			function addTrackersFromBody(body) {
				var lines = (body || "").split("\n");
				for (var i = 0; i < lines.length; i++) {
					var line = lines[i].trim();
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

			for (var ui = 0; ui < TRACKERS_LIST_URLS.length; ui++) {
				(function (url) {
					http_get(url, { "User-Agent": UA })
						.then(function (resp) {
							if (resp && resp.status === 200 && resp.body) {
								var body =
									typeof resp.body === "string" ? resp.body : String(resp.body);
								addTrackersFromBody(body);
							}
							remaining--;
							if (remaining <= 0) finalizeTrackers(allParsed);
						})
						.catch(function () {
							remaining--;
							if (remaining <= 0) finalizeTrackers(allParsed);
						});
				})(TRACKERS_LIST_URLS[ui]);
			}

			if (typeof setTimeout !== "undefined") {
				setTimeout(function () {
					if (remaining > 0) {
						remaining = 0;
						finalizeTrackers(allParsed);
					}
				}, 10000);
			}
		} catch (e) {}
	}

	function finalizeTrackers(parsed) {
		if (parsed.length > 0) {
			TRACKERS = parsed;
			try {
				setPreference("hub_trackers_list", JSON.stringify(parsed));
			} catch (e) {}
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 4: CACHE SYSTEM
	// ────────────────────────────────────────────────────────────────

	function cacheGet(key) {
		var entry = _cache[key];
		if (entry && Date.now() - entry.ts < CACHE_TTL) {
			return entry.data;
		}
		try {
			var raw = getPreference("hub_cache:" + key);
			if (raw) {
				var parsed = safeJson(raw, null);
				if (parsed && parsed.ts && Date.now() - parsed.ts < CACHE_TTL) {
					_cache[key] = parsed;
					return parsed.data;
				}
			}
		} catch (e) {}
		return null;
	}

	function cacheSet(key, data) {
		var entry = { ts: Date.now(), data: data };
		_cache[key] = entry;
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
		try {
			setPreference("hub_cache:" + key, JSON.stringify(entry));
		} catch (e) {}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 5: RATE LIMITING
	// ────────────────────────────────────────────────────────────────

	function isRateLimited(url) {
		var rl = _rateLimits[url];
		return rl && rl.fails >= RATE_MAX_FAILS && Date.now() < rl.until;
	}

	function recordResponseStatus(url, status) {
		if (status === 429 || status === 503 || status === 502 || status === 504) {
			var rl = _rateLimits[url] || { fails: 0, until: 0 };
			rl.fails++;
			rl.until = Date.now() + RATE_BACKOFF_MS;
			_rateLimits[url] = rl;
			try {
				setPreference("hub_ratelimit:" + url, JSON.stringify(rl));
			} catch (e) {}
		} else if (status >= 200 && status < 300) {
			if (_rateLimits[url]) {
				_rateLimits[url].fails = 0;
				try {
					setPreference(
						"hub_ratelimit:" + url,
						JSON.stringify(_rateLimits[url]),
					);
				} catch (e) {}
			}
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 6: HTTP LAYER
	// ────────────────────────────────────────────────────────────────

	function buildRequest(url) {
		return { method: "GET", url: url, headers: JSON_HEADERS };
	}

	function httpBatch(urls) {
		if (!urls || !urls.length) return Promise.resolve([]);

		var activeUrls = [];
		var activeIndices = [];
		for (var i = 0; i < urls.length; i++) {
			if (!isRateLimited(urls[i])) {
				activeUrls.push(urls[i]);
				activeIndices.push(i);
			}
		}

		if (!activeUrls.length) {
			var allLimited = [];
			for (var i = 0; i < urls.length; i++) {
				allLimited.push({ url: urls[i], ok: false, data: null, status: 429 });
			}
			return Promise.resolve(allLimited);
		}

		var requests = [];
		for (var i = 0; i < activeUrls.length; i++) {
			requests.push(buildRequest(activeUrls[i]));
		}

		return http_parallel(requests)
			.then(function (responses) {
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
						status: resp ? resp.status || resp.code || 0 : 0,
					};

					recordResponseStatus(activeUrls[ri], entry.status);

					if (resp && entry.status >= 300 && entry.status < 400) {
						var location =
							resp.location ||
							(resp.headers &&
								(resp.headers.location || resp.headers.Location));
						if (location) {
							entry.redirectUrl =
								typeof location === "string" ? location : location.url || "";
						}
					}

					if (
						resp &&
						resp.body &&
						(entry.status === 200 || entry.status === 206)
					) {
						try {
							var body = resp.body;
							if (typeof body === "string") {
								body = body.trim();
								if (body && body.charAt(0) !== "<") {
									entry.data = JSON.parse(body);
									entry.ok = true;
								}
							} else if (typeof body === "object") {
								entry.data = body;
								entry.ok = true;
							}
						} catch (parseErr) {}
					}
					results[idx] = entry;
				}
				return results;
			})
			.catch(function () {
				var fallback = [];
				for (var i = 0; i < urls.length; i++) {
					fallback.push({ url: urls[i], ok: false, data: null, status: 0 });
				}
				return fallback;
			});
	}

	function fetchJson(url, timeoutMs) {
		timeoutMs = timeoutMs || META_TIMEOUT;
		return new Promise(function (resolve, reject) {
			var timedOut = false;
			var timer = setTimeout(function () {
				timedOut = true;
				reject(new Error("Timeout: " + url));
			}, timeoutMs);

			http_get(url, JSON_HEADERS)
				.then(function (response) {
					if (timedOut) return;
					clearTimeout(timer);
					if (!response || !response.body) {
						return reject(new Error("Empty response: " + url));
					}
					recordResponseStatus(url, response.status || 0);

					if (response.status >= 300 && response.status < 400) {
						var location =
							response.location ||
							(response.headers &&
								(response.headers.location || response.headers.Location));
						if (
							typeof response.body === "string" &&
							response.body.indexOf("Redirecting") !== -1
						) {
							var match = response.body.match(/https?:\/\/[^\s"']+/);
							if (match) location = match[0];
						}
						if (location) {
							var redirectUrl =
								typeof location === "string" ? location : location.url || "";
							if (redirectUrl.indexOf("http") !== 0) {
								try {
									redirectUrl = new URL(url).origin + redirectUrl;
								} catch (e) {}
							}
							return fetchJson(redirectUrl, timeoutMs).then(resolve, reject);
						}
					}

					if (response.status !== 200 && response.status !== 304) {
						return reject(new Error("HTTP " + response.status));
					}

					var body = response.body;
					if (typeof body === "string") {
						body = body.trim();
						if (!body) return reject(new Error("Empty body"));
						if (body.charAt(0) === "<")
							return reject(new Error("HTML response"));
						return resolve(JSON.parse(body));
					}
					resolve(body);
				})
				.catch(function (err) {
					if (timedOut) return;
					clearTimeout(timer);
					reject(err);
				});
		});
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 7: ADDON MANIFEST ACCESSORS
	// ────────────────────────────────────────────────────────────────

	function getCatalogueAddons() {
		try {
			if (manifest && Array.isArray(manifest.catalogueAddons))
				return manifest.catalogueAddons;
		} catch (e) {}
		return [];
	}

	function getStreamingAddons() {
		try {
			if (manifest && Array.isArray(manifest.streamingAddons))
				return manifest.streamingAddons;
		} catch (e) {}
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
			var cats = getCatalogueAddons();
			if (cats.length > 0) {
				var detected = [];
				var patterns = ["cinemeta", "cinemata"];
				for (var ci = 0; ci < cats.length; ci++) {
					var lower = cats[ci].toLowerCase();
					for (var pi = 0; pi < patterns.length; pi++) {
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
			return getCatalogueAddons();
		}
	}

	function getManifest(url) {
		var cacheKey = "mf:" + url;
		var cached = cacheGet(cacheKey);
		if (cached) return Promise.resolve(cached);
		if (isRateLimited(url)) return Promise.resolve(null);

		return fetchJson(url, META_TIMEOUT)
			.then(function (data) {
				if (data) cacheSet(cacheKey, data);
				return data;
			})
			.catch(function () {
				return null;
			});
	}

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
			return Promise.resolve(
				results.filter(function (r) {
					return r !== null;
				}),
			);
		}

		return httpBatch(uncachedUrls).then(function (batchResults) {
			for (var j = 0; j < batchResults.length; j++) {
				var idx = uncachedIndices[j];
				if (batchResults[j].ok && batchResults[j].data) {
					cacheSet("mf:" + uncachedUrls[j], batchResults[j].data);
					results[idx] = {
						url: uncachedUrls[j],
						manifest: batchResults[j].data,
						index: idx,
					};
				}
			}
			return results.filter(function (r) {
				return r !== null;
			});
		});
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 8: VIDEO ID PARSING
	// ────────────────────────────────────────────────────────────────

	/**
	 * Parses a video ID from various formats:
	 *   - IMDb IDs: "tt1254207", "tt0386676:1:1"
	 *   - TMDB IDs (from catalogue): "tmdb:12345", "tmdb:12345:1:1"
	 *   - Pipe-delimited: "tmdb:1634301||Name||year||type||poster||desc"
	 *   - JSON-encoded: '{"i":"tt1254207","t":"movie","s":1,"e":1}'
	 *
	 * Pipe-delimited IDs are stripped to their clean prefix+NUMBER form.
	 * The original raw input is available in load() for name extraction.
	 */
	function parseVideoId(raw) {
		if (!raw) return null;

		// Try JSON-encoded IDs
		var parsed = safeJson(raw, null);
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
					episode: isNaN(en) ? 0 : en,
					idPrefix: "tt",
				};
			}

			// tmdb: series episode: "tmdb:XXXX:season:episode"
			if (first === "tmdb" && parts.length >= 4) {
				var tmdbRawId = parts[1];
				var pipeIdx = tmdbRawId.indexOf("||");
				if (pipeIdx !== -1) tmdbRawId = tmdbRawId.substring(0, pipeIdx);
				var sn = parseInt(parts[2], 10);
				var en = parseInt(parts[3], 10);
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
				var serviceParts = parts[1];
				if (first === "tmdb") {
					var pipeIdx2 = serviceParts.indexOf("||");
					if (pipeIdx2 !== -1) {
						serviceParts = serviceParts.substring(0, pipeIdx2);
					}
					var typeHint = null;
					var metaParts = parts[1].split("||");
					var cleanTmid = metaParts[0];
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
			return {
				id: raw,
				type: null,
				season: 0,
				episode: 0,
				idPrefix: "tt",
			};
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

	/**
	 * Detect the ID ecosystem from a raw video ID.
	 */
	function detectIdPrefix(raw) {
		if (!raw) return "unknown";
		var r = raw.toLowerCase();
		if (/^tt\d+/.test(r)) return "tt";
		if (r.indexOf("tmdb:") === 0) return "tmdb:";
		if (/^\d+$/.test(r)) return "numeric";
		return "unknown";
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 9: METADATA → SKYSTREAM CONVERTERS
	// ────────────────────────────────────────────────────────────────

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

	function parseGenres(meta) {
		if (!meta) return undefined;
		var g = meta.genres || meta.genre || meta.tags;
		if (Array.isArray(g) && g.length > 0) {
			if (typeof g[0] === "object" && g[0].name) {
				return g.map(function (x) {
					return x.name;
				});
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
				description: safeStr(
					m.description || m.overview || m.synopsis || m.overview || "",
				)
					.replace(/<[^>]*>/g, "")
					.trim()
					.substring(0, 500),
				year: parseYear(m),
				score: parseRating(m),
				genres: parseGenres(m),
			});
		} catch (e) {
			return null;
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 10: STREAM QUALITY / FORMATTING
	// ────────────────────────────────────────────────────────────────

	function parseStreamFeatures(text) {
		var result = {
			resolution: "Auto",
			codec: null,
			hdr: null,
			audio: null,
			channels: null,
			sourceType: "unknown",
			_sortKey: 2,
		};
		if (!text) return result;

		var str = text.toLowerCase();

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

		var ch = str.match(/\b[257]\.1\b/);
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

	function buildStreamTitle(features, addonName, originalTitle) {
		var parts = [];
		parts.push("[" + addonName + "]");
		var tech = features.resolution;
		if (features.codec) tech += " " + features.codec;
		if (features.hdr) tech += " " + features.hdr;
		if (features.audio) tech += " " + features.audio;
		if (features.channels) tech += " " + features.channels;
		parts.push(tech);
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
	//  SECTION 11: STREAM FORMATTING ENGINE
	// ────────────────────────────────────────────────────────────────

	function formatStream(stream, addonIndex, baseUrl, addonDisplayName) {
		try {
			if (!stream) return null;

			var origName = safeStr(stream.name).trim();
			var origTitle = safeStr(stream.title).trim();
			var origDesc = safeStr(stream.description).trim();

			var fl = function (s) {
				return s.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
			};
			var combined = fl(origName) + " " + fl(origTitle) + " " + fl(origDesc);
			var features = parseStreamFeatures(combined);

			var addonLabel = addonDisplayName || "#" + addonIndex;
			var addonTag = "[" + addonLabel + "]";
			var displayParts = [];

			if (origName) {
				var nameSegs = origName.split("\n");
				for (var ni = 0; ni < nameSegs.length; ni++) {
					var ns = nameSegs[ni].trim();
					if (ns) displayParts.push(ns);
				}
			}

			var contentText = origTitle || origDesc;
			if (contentText) {
				var segs = contentText.split("\n");
				for (var si = 0; si < segs.length; si++) {
					var s = segs[si].trim();
					if (s) displayParts.push(s);
				}
			}

			var displaySource =
				displayParts.length > 0
					? addonTag + " " + displayParts.join(" | ")
					: addonTag;

			var headers = {};
			if (stream.behaviorHints) {
				if (
					stream.behaviorHints.proxyHeaders &&
					stream.behaviorHints.proxyHeaders.request
				) {
					headers = {};
					var srcHeaders = stream.behaviorHints.proxyHeaders.request;
					if (srcHeaders) {
						for (var hk in srcHeaders) {
							if (srcHeaders.hasOwnProperty(hk)) {
								headers[hk] = srcHeaders[hk];
							}
						}
					}
				}
			}

			if (!headers["User-Agent"]) headers["User-Agent"] = UA;
			if (!headers["Referer"]) headers["Referer"] = baseUrl + "/";
			if (!headers["Origin"]) headers["Origin"] = baseUrl;

			var bh = {};
			if (stream.behaviorHints) {
				for (var key in stream.behaviorHints) {
					if (stream.behaviorHints.hasOwnProperty(key)) {
						if (key !== "proxyHeaders" && key !== "headers") {
							bh[key] = stream.behaviorHints[key];
						}
					}
				}
			}

			var subs = undefined;
			if (
				stream.subtitles &&
				Array.isArray(stream.subtitles) &&
				stream.subtitles.length > 0
			) {
				subs = [];
				for (var si = 0; si < stream.subtitles.length; si++) {
					var sub = stream.subtitles[si];
					if (sub && sub.url && sub.lang) {
						subs.push({ url: sub.url, label: sub.lang, lang: sub.lang });
					}
				}
				if (subs.length === 0) subs = undefined;
			}

			if (stream.url) {
				var urlLower = stream.url.toLowerCase();
				if (urlLower.indexOf("data:text/plain") === 0) return null;
				if (
					urlLower.indexOf("/login.") !== -1 ||
					urlLower.indexOf("/logout") !== -1
				)
					return null;
				if (
					urlLower.indexOf("magnet:") === 0 &&
					!stream.infoHash &&
					urlLower.indexOf("urn:btih:") === -1 &&
					urlLower.indexOf("btih=") === -1
				)
					return null;
			}

			// Type 1: Direct HTTP(S) URL
			if (stream.url && isHttp(stream.url)) {
				var isDirectMedia = /\.(mp4|mkv|webm|avi|mov)(\?|$)/i.test(stream.url);
				var isStreamingPlaylist = /\.(m3u8|mpd)(\?|$)/i.test(stream.url);
				var isMaybeProxied =
					/(extract|proxy|redirect|gateway|fetch|resolve)/i.test(stream.url);

				var hasExtraHeaders = Object.keys(headers).length > 1;
				var finalUrl = stream.url;
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

				var result = new StreamResult({
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
					} catch (e) {}
				}

				return result;
			}

			// Type 2: Torrent (infoHash)
			if (stream.infoHash) {
				var filename =
					(stream.behaviorHints && stream.behaviorHints.filename) ||
					stream.title ||
					stream.name ||
					"";
				if (Object.keys(bh).length === 0) bh = { notWebReady: true };
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
				if (Object.keys(bh).length === 0) bh = { notWebReady: true };
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
				if (Object.keys(bh).length === 0) bh = { notWebReady: true };
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
			var archiveTypes = [
				{ key: "rarUrls", label: "RAR" },
				{ key: "zipUrls", label: "ZIP" },
				{ key: "7zipUrls", label: "7z" },
				{ key: "tgzUrls", label: "TGZ" },
				{ key: "tarUrls", label: "TAR" },
			];
			for (var ai = 0; ai < archiveTypes.length; ai++) {
				if (
					Array.isArray(stream[archiveTypes[ai].key]) &&
					stream[archiveTypes[ai].key].length
				) {
					var src = stream[archiveTypes[ai].key][0];
					var srcUrl = typeof src === "string" ? src : src.url || "";
					if (srcUrl) {
						if (Object.keys(bh).length === 0) bh = { notWebReady: true };
						return new StreamResult({
							url: srcUrl,
							quality: features.resolution,
							source: addonTag + " " + archiveTypes[ai].label,
							headers: headers,
							behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
							_sortKey: features._sortKey,
						});
					}
				}
			}

			// Type 7: Fallback raw URL
			if (stream.url) {
				var hash = null;
				if (stream.url.indexOf("magnet:?xt=urn:btih:") === 0) {
					var magnetMatch = stream.url.match(/urn:btih:([a-fA-F0-9]+)/);
					if (magnetMatch) hash = magnetMatch[1].toLowerCase();
				}
				if (
					Object.keys(bh).length === 0 &&
					(hash || stream.url.indexOf("magnet:") === 0)
				) {
					bh = { notWebReady: true };
				}
				var fallbackResult = new StreamResult({
					url: stream.url,
					quality: features.resolution,
					source: displaySource,
					headers: headers,
					behaviorHints: Object.keys(bh).length > 0 ? bh : undefined,
					subtitles: subs,
					_sortKey: features._sortKey,
				});
				if (hash) {
					fallbackResult.infoHash = hash;
					fallbackResult.fileIndex = 0;
				}
				return fallbackResult;
			}

			return null;
		} catch (e) {
			return null;
		}
	}

	function processStreams(streams, addonIndex, baseUrl, addonDisplayName) {
		if (!Array.isArray(streams)) return [];
		var out = [];
		for (var i = 0; i < streams.length; i++) {
			try {
				var formatted = formatStream(
					streams[i],
					addonIndex,
					baseUrl,
					addonDisplayName,
				);
				if (formatted) out.push(formatted);
			} catch (e) {}
		}
		return out;
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 12: getHome() — Dashboard Catalogs
	// ────────────────────────────────────────────────────────────────

	async function getHome(cb, page) {
		try {
			var pageNum = parseInt(page) || 1;
			var addonUrls = getCatalogueAddons();

			if (!addonUrls.length) {
				return cb({
					success: false,
					errorCode: "NO_ADDONS",
					message: "No catalogueAddons configured in plugin.json",
				});
			}

			var manifests = await fetchManifests(addonUrls);

			if (!manifests.length) {
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "Could not fetch any addon manifests",
				});
			}

			var catalogJobs = [];
			for (var mi = 0; mi < manifests.length; mi++) {
				var mf = manifests[mi].manifest;
				var addonBaseUrl = baseUrl(manifests[mi].url);

				if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length) continue;

				for (var ci = 0; ci < mf.catalogs.length; ci++) {
					var cat = mf.catalogs[ci];
					if (!cat || !cat.id || !cat.type) continue;

					var extras = cat.extra || [];
					var requiresSearch = extras.some(function (e) {
						return e && e.name === "search" && e.isRequired === true;
					});
					if (requiresSearch) continue;

					var catUrl =
						addonBaseUrl + "/catalog/" + cat.type + "/" + cat.id + ".json";
					if (pageNum > 1) {
						var skip = (pageNum - 1) * CATALOG_PAGE_SIZE;
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
				return cb({
					success: false,
					errorCode: "NO_DATA",
					message: "No browsable catalogs found in addon manifests",
				});
			}

			var catalogUrls = catalogJobs.map(function (j) {
				return j.url;
			});
			var catalogResponses = await httpBatch(catalogUrls);

			var organizedData = {};
			var categoryOrder = [];

			for (var ri = 0; ri < catalogResponses.length; ri++) {
				var response = catalogResponses[ri];
				var job = catalogJobs[ri];

				if (
					!response.ok ||
					!response.data ||
					!Array.isArray(response.data.metas) ||
					!response.data.metas.length
				) {
					continue;
				}

				var items = response.data.metas
					.map(function (m) {
						return toItem(m, job.categoryType);
					})
					.filter(Boolean);

				if (!items.length) continue;

				var catLabel = job.categoryName;

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
					message: "No catalog data returned from any addon",
				});
			}

			var finalData = {};
			for (var i = 0; i < categoryOrder.length; i++) {
				if (organizedData[categoryOrder[i]]) {
					finalData[categoryOrder[i]] = organizedData[categoryOrder[i]];
				}
			}

			cb({ success: true, data: finalData, page: pageNum });
		} catch (e) {
			cb({
				success: false,
				errorCode: "HOME_ERROR",
				message: safeStr(e.message || e),
			});
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 13: search() — Cinemeta Only
	// ────────────────────────────────────────────────────────────────

	async function search(query, cb) {
		try {
			var q = safeStr(query).trim().toLowerCase();
			if (!q) return cb({ success: true, data: [] });
			if (q.length > MAX_SEARCH_QUERY_LENGTH) {
				q = q.substring(0, MAX_SEARCH_QUERY_LENGTH);
			}

			var addonUrls = getMetaAddons();
			var allItems = [];
			var seenUrls = {};

			function addItem(item) {
				if (item && item.url && !seenUrls[item.url]) {
					seenUrls[item.url] = true;
					allItems.push(item);
				}
			}

			if (addonUrls.length > 0) {
				var manifests = await fetchManifests(addonUrls);

				var searchJobs = [];
				for (var mi = 0; mi < manifests.length; mi++) {
					var mf = manifests[mi].manifest;
					var addonBaseUrl = baseUrl(manifests[mi].url);

					if (!mf || !Array.isArray(mf.catalogs) || !mf.catalogs.length)
						continue;

					for (var ci = 0; ci < mf.catalogs.length; ci++) {
						var cat = mf.catalogs[ci];
						if (!cat || !cat.id || !cat.type) continue;
						var extras = cat.extra || [];
						if (
							extras.some(function (e) {
								return e && e.name === "search";
							})
						) {
							searchJobs.push({
								url:
									addonBaseUrl +
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
					var urls = searchJobs.map(function (j) {
						return j.url;
					});
					var responses = await httpBatch(urls);

					for (
						var ri = 0;
						ri < responses.length && allItems.length < MAX_SEARCH_RESULTS;
						ri++
					) {
						var resp = responses[ri];
						var job = searchJobs[ri];
						if (resp.ok && resp.data && Array.isArray(resp.data.metas)) {
							for (
								var mi = 0;
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

			cb({
				success: true,
				data: allItems.slice(0, MAX_SEARCH_RESULTS),
			});
		} catch (e) {
			cb({ success: true, data: [] });
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 14: load() — Cinemeta Only
	// ────────────────────────────────────────────────────────────────
	//
	//  Strategy (mirrors official Stremio):
	//    1. Parse video ID
	//    2. For tt IDs → direct Cinemeta meta fetch (fast, authoritative)
	//    3. For tmdb: IDs → extract name from pipe format, search Cinemeta,
	//       find best match, fetch full meta with episodes
	//    4. Always use Cinemeta as sole metadata source
	//    5. Pre-fetch streams in background
	//
	//  TMDB addon removed — caused wrong types (movie→series) and missing episodes.

	async function load(url, cb) {
		try {
			var rawInput = safeStr(url).trim();
			if (!rawInput) {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "No video ID provided",
				});
			}

			var parsed = parseVideoId(rawInput);
			var metaId = parsed ? parsed.id : rawInput;
			var knownType = parsed ? parsed.type : null;
			var idPrefix = parsed ? parsed.idPrefix : "unknown";
			var season = parsed ? parsed.season : 0;
			var episode = parsed ? parsed.episode : 0;

			if (!metaId) {
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "Could not parse video ID: " + rawInput,
				});
			}

			var callbackCalled = false;
			function safeCallback(result) {
				if (!callbackCalled) {
					callbackCalled = true;
					cb(result);
				}
			}

			var addonUrls = getMetaAddons();
			var cinemetaUrl = addonUrls.length > 0 ? addonUrls[0] : null;

			// ── Helper: query a single addon's meta endpoint ──
			// When typeHint is known, only queries that type (1 request).
			// When typeHint is null, queries BOTH types in parallel and
			// returns the BEST match (prefers series with episodes).
			function fetchMeta(addonBase, id, typeHint) {
				return new Promise(function (resolve) {
					if (typeHint === "movie" || typeHint === "series") {
						// Known type → single request
						var qUrl =
							addonBase +
							"/meta/" +
							typeHint +
							"/" +
							encodeURIComponent(id) +
							".json";
						var timer = setTimeout(function () {
							resolve(null);
						}, META_FETCH_TIMEOUT);
						http_get(qUrl, JSON_HEADERS)
							.then(function (resp) {
								clearTimeout(timer);
								if (
									resp &&
									(resp.status === 200 || resp.status === 206) &&
									resp.body
								) {
									var body =
										typeof resp.body === "string"
											? resp.body.trim()
											: JSON.stringify(resp.body);
									if (body && body.charAt(0) !== "<") {
										try {
											var parsed = JSON.parse(body);
											var metaData =
												parsed.meta ||
												(Array.isArray(parsed.metas) ? parsed.metas[0] : null);
											if (metaData && metaData.id) return resolve(metaData);
										} catch (e) {}
									}
								}
								resolve(null);
							})
							.catch(function () {
								clearTimeout(timer);
								resolve(null);
							});
					} else {
						// Unknown type → query BOTH in parallel, pick best
						var results = {};
						var pending = 2;
						var done = false;

						function tryType(typeName) {
							var qUrl =
								addonBase +
								"/meta/" +
								typeName +
								"/" +
								encodeURIComponent(id) +
								".json";
							var timer = setTimeout(function () {
								pending--;
								if (pending <= 0 && !done) finalize();
							}, META_FETCH_TIMEOUT);
							http_get(qUrl, JSON_HEADERS)
								.then(function (resp) {
									clearTimeout(timer);
									if (
										resp &&
										(resp.status === 200 || resp.status === 206) &&
										resp.body
									) {
										var body =
											typeof resp.body === "string"
												? resp.body.trim()
												: JSON.stringify(resp.body);
										if (body && body.charAt(0) !== "<") {
											try {
												var parsed = JSON.parse(body);
												var metaData =
													parsed.meta ||
													(Array.isArray(parsed.metas)
														? parsed.metas[0]
														: null);
												if (metaData && metaData.id) {
													results[typeName] = metaData;
												}
											} catch (e) {}
										}
									}
									pending--;
									if (pending <= 0 && !done) finalize();
								})
								.catch(function () {
									clearTimeout(timer);
									pending--;
									if (pending <= 0 && !done) finalize();
								});
						}

						function finalize() {
							done = true;
							// If both returned, prefer the one with episodes (series)
							if (results.series && results.movie) {
								var sEpisodes = results.series.videos
									? results.series.videos.length
									: 0;
								var mEpisodes = results.movie.videos
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

			var bestMeta = null;
			var resolvedId = metaId;

			if (idPrefix === "tt" && cinemetaUrl) {
				// ── IMDb ID → Direct Cinemeta fetch ──
				bestMeta = await fetchMeta(baseUrl(cinemetaUrl), metaId, knownType);
			} else if (idPrefix === "tmdb:" && cinemetaUrl) {
				// ── TMDB ID → Extract metadata from pipe format ──
				// Cinemeta does NOT accept tmdb: IDs, and its catalog search
				// is unreliable in SkyStream. Instead, we extract metadata
				// directly from the pipe-delimited format which already has
				// the correct name, year, type, poster, and description.
				//
				// Format: tmdb:NUM||name||year||type||poster||description
				//
				// This is fast (zero API calls), always accurate, and matches
				// what Stremio's catalogue addon provides on hover.
				var pipeParts = rawInput.split("||");
				if (pipeParts.length >= 4) {
					var pipeName = pipeParts[1] || metaId;
					var pipeYear = parseInt(pipeParts[2], 10);
					var pipeType = (pipeParts[3] || "").toLowerCase();
					var pipePoster = pipeParts[4] || "";
					var pipeDesc = pipeParts.length >= 6 ? pipeParts[5] || "" : "";

					var isSeries = pipeType === "series" || pipeType === "tv";
					var skyTypeVal = isSeries ? "series" : "movie";
					var epName = isSeries ? "Watch" : "Full Movie";

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
					prefetchStreams(rawInput);
					return;
				}
				// Fall through to fallback if pipe format incomplete
			} else if (cinemetaUrl) {
				// ── Unknown prefix → try Cinemeta directly ──
				bestMeta = await fetchMeta(baseUrl(cinemetaUrl), metaId, knownType);
			}

			if (bestMeta) {
				respondMeta(
					bestMeta,
					resolvedId,
					safeCallback,
					knownType,
					season,
					episode,
				);
				prefetchStreams(rawInput);
				return;
			}

			// ── Absolute fallback: placeholder episode ──
			respondFallback(rawInput, knownType, season, episode, safeCallback);
			prefetchStreams(rawInput);
		} catch (e) {
			if (typeof safeCallback === "function") {
				respondFallback(rawInput, knownType, season, episode, safeCallback);
			} else {
				cb({
					success: false,
					errorCode: "LOAD_ERROR",
					message: safeStr(e.message || e),
				});
			}
		}
	}

	/**
	 * Pre-fetch streams in the background for instant playback.
	 */
	function prefetchStreams(rawInput) {
		try {
			loadStreams(rawInput, function (streamResult) {
				cacheSet("streams:" + rawInput, streamResult);
			});
		} catch (e) {}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 15: respondMeta / respondFallback
	// ────────────────────────────────────────────────────────────────

	function respondMeta(meta, metaId, cb, knownType, season, episode) {
		try {
			var stremioType = meta.type || knownType || "movie";
			var skyTypeVal = skyType(stremioType);
			var year = parseYear(meta);
			var score = parseRating(meta);
			var description = safeStr(
				meta.description || meta.overview || meta.synopsis || "",
			)
				.replace(/<[^>]*>/g, "")
				.trim();

			// Use IMDb ID for episode URLs when available (streaming addons
			// universally support tt IDs). Falls back to original metaId.
			var streamId = meta.imdb_id || metaId;
			if (meta.behaviorHints && meta.behaviorHints.defaultVideoId) {
				streamId = meta.behaviorHints.defaultVideoId;
			}

			var episodes = [];
			var isSeries = skyTypeVal !== "movie";

			if (isSeries && Array.isArray(meta.videos) && meta.videos.length > 0) {
				for (var vi = 0; vi < meta.videos.length; vi++) {
					try {
						var v = meta.videos[vi];
						if (!v || !v.id) continue;

						var seasonNum = v.season || 1;
						var episodeNum = v.episode || v.number || 1;
						var episodeId = streamId + ":" + seasonNum + ":" + episodeNum;

						episodes.push(
							new Episode({
								name: v.name || v.title || "Episode " + episodeNum,
								url: episodeId,
								season: seasonNum,
								episode: episodeNum,
								posterUrl: v.thumbnail || v.poster || meta.poster || "",
								description: v.overview || v.description || "",
								airDate: v.released || v.firstAired || "",
							}),
						);
					} catch (e) {}
				}
			}

			if (episodes.length === 0) {
				var playSeason = season > 0 ? season : 1;
				var playEpisode = episode > 0 ? episode : 1;
				var playId = isSeries
					? streamId + ":" + playSeason + ":" + playEpisode
					: streamId;
				episodes.push(
					new Episode({
						name: skyTypeVal === "movie" ? "Full Movie" : "Watch",
						url: playId,
						season: playSeason,
						episode: playEpisode,
						posterUrl: meta.poster || "",
					}),
				);
			}

			var cast = undefined;

			// Helper: extract cast from an array of cast objects
			function extractCast(castArr) {
				if (!Array.isArray(castArr) || castArr.length === 0) return null;
				var result = [];
				for (var ci = 0; ci < castArr.length && ci < 25; ci++) {
					try {
						var c = castArr[ci];
						if (!c) continue;
						if (typeof c === "string") {
							result.push(new Actor({ name: c, role: "", image: "" }));
						} else {
							var img =
								c.image ||
								c.picture ||
								c.photo ||
								c.profile ||
								c.profile_path ||
								"";
							// Convert TMDB relative path to full URL
							if (img && img.indexOf("http") !== 0 && img.indexOf("/") === 0) {
								img = TMDB_IMG_BASE + "/w185" + img;
							}
							result.push(
								new Actor({
									name: c.name || c.fullName || c.person || "",
									role: c.role || c.character || "",
									image: img,
								}),
							);
						}
					} catch (e) {}
				}
				return result.length > 0 ? result : null;
			}

			// Try standard meta.cast first
			cast = extractCast(meta.cast);

			// If no cast yet, try Cinemeta's credits_cast (has profile_path)
			if (!cast && Array.isArray(meta.credits_cast)) {
				cast = extractCast(meta.credits_cast);
			}

			var trailers = undefined;
			if (Array.isArray(meta.trailers) && meta.trailers.length > 0) {
				trailers = [];
				for (var tri = 0; tri < meta.trailers.length; tri++) {
					try {
						var tr = meta.trailers[tri];
						if (!tr) continue;
						var src = tr.source || tr.url || "";
						var trUrl =
							src.indexOf("http") === 0
								? src
								: "https://www.youtube.com/watch?v=" + src;
						trailers.push(
							new Trailer({
								url: trUrl,
								name: tr.name || tr.type || "Trailer",
							}),
						);
					} catch (e) {}
				}
				if (trailers.length === 0) trailers = undefined;
			}

			var director = undefined;
			if (meta.director) {
				director = Array.isArray(meta.director)
					? meta.director.filter(Boolean).join(", ")
					: safeStr(meta.director);
				if (!director) director = undefined;
			}

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
				episodes: episodes,
			});

			cb({ success: true, data: item });
		} catch (e) {
			var ft = skyType(meta.type || "movie");
			cb({
				success: true,
				data: new MultimediaItem({
					title: meta.name || meta.title || "Unknown",
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

	function respondFallback(rawInput, knownType, season, episode, cb) {
		try {
			var ft = skyType(knownType || "movie");
			var fs = season > 0 ? season : 1;
			var fe = episode > 0 ? episode : 1;
			var playId = ft === "movie" ? rawInput : rawInput + ":" + fs + ":" + fe;
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
			cb({
				success: false,
				errorCode: "FALLBACK_ERROR",
				message: safeStr(e.message || e),
			});
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  SECTION 16: loadStreams() — Stream from all streaming addons
	// ────────────────────────────────────────────────────────────────

	async function loadStreams(url, cb) {
		try {
			var rawInput = safeStr(url).trim();
			if (!rawInput) {
				return cb({ success: false, data: [] });
			}

			// Detect type from URL: if it has :season:episode, it's a series
			var isSeries = /:\d+:\d+$/.test(rawInput);
			var streamTypes = isSeries ? ["series"] : ["movie", "series"];

			var addonUrls = getStreamingAddons();
			if (!addonUrls.length) {
				return cb({ success: true, data: [] });
			}

			var manifests = await fetchManifests(addonUrls);

			var streamPromises = [];
			for (var mi = 0; mi < manifests.length; mi++) {
				var mf = manifests[mi];
				if (!mf || !mf.manifest) continue;

				var addonManifest = mf.manifest;
				var addonBaseUrl = baseUrl(mf.url);
				var addonDisplayName = addonName(mf.url);

				if (!addonManifest.resources || !Array.isArray(addonManifest.resources))
					continue;

				// Check if this addon supports streaming
				var supportsStream = false;
				for (var ri = 0; ri < addonManifest.resources.length; ri++) {
					var res = addonManifest.resources[ri];
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

				(function (idx, base, display) {
					// Try each stream type (movie and/or series) for this addon
					for (var ti = 0; ti < streamTypes.length; ti++) {
						var streamType = streamTypes[ti];
						var streamUrl =
							base +
							"/stream/" +
							streamType +
							"/" +
							encodeURIComponent(rawInput) +
							".json";
						streamPromises.push(
							new Promise(function (resolvePromise) {
								var timer = setTimeout(function () {
									resolvePromise([]);
								}, STREAM_ADDON_TIMEOUT);

								http_get(streamUrl, JSON_HEADERS)
									.then(function (resp) {
										clearTimeout(timer);
										if (resp && resp.status === 200 && resp.body) {
											var body =
												typeof resp.body === "string"
													? resp.body.trim()
													: JSON.stringify(resp.body);
											if (body && body.charAt(0) !== "<") {
												try {
													var parsed = JSON.parse(body);
													var streams = parsed.streams || [];
													var processed = processStreams(
														streams,
														idx,
														base,
														display,
													);
													return resolvePromise(processed);
												} catch (e) {}
											}
										}
										resolvePromise([]);
									})
									.catch(function () {
										clearTimeout(timer);
										resolvePromise([]);
									});
							}),
						);
					}
				})(mi, addonBaseUrl, addonDisplayName);
			}

			var allStreamResults = await Promise.all(streamPromises);

			var merged = [];
			var seenDedup = {};

			for (var si = 0; si < allStreamResults.length; si++) {
				var arr = allStreamResults[si];
				if (!Array.isArray(arr)) continue;
				for (var ii = 0; ii < arr.length; ii++) {
					var st = arr[ii];
					if (!st) continue;
					var dk = dedupKey(st, si);
					if (!seenDedup[dk]) {
						seenDedup[dk] = true;
						merged.push(st);
					}
				}
			}

			merged.sort(function (a, b) {
				return (b._sortKey || 0) - (a._sortKey || 0);
			});

			cb({ success: true, data: merged });
		} catch (e) {
			cb({ success: true, data: [] });
		}
	}

	// ────────────────────────────────────────────────────────────────
	//  EXPORTS — registered on globalThis
	// ────────────────────────────────────────────────────────────────

	var g = typeof globalThis !== "undefined" ? globalThis : null;
	if (!g && typeof self !== "undefined") g = self;
	if (!g && typeof window !== "undefined") g = window;
	if (!g && typeof global !== "undefined") g = global;

	if (g) {
		g.getHome = getHome;
		g.search = search;
		g.load = load;
		g.loadStreams = loadStreams;
	}
})();
