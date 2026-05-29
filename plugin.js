(function () {
	"use strict";

	var TAG = "MultiSourceHub";

	// ===========================================================================
	// TMDB CONFIG
	// ===========================================================================
	var TMDB_KEYS = [
		"68e094699525b18a70bab2f86b1fa706",
		"af3a53eb387d57fc935e9128468b1899",
		"0142a22c560ce3efb1cfd6f3b2faab77",
	];
	var TMDB_BASE = "https://api.themoviedb.org/3";
	var TMDB_IMG = "https://image.tmdb.org/t/p";
	var _tmdbKeyIdx = 0;

	var IMG_POSTER = "w500";
	var IMG_BACKDROP = "w780";
	var IMG_STILL = "w300";
	var IMG_PROFILE = "w185";

	// ===========================================================================
	// TIMEOUTS
	// ===========================================================================
	var HTTP_TIMEOUT = 15000;
	var LOAD_TIMEOUT = 20000;
	var HOME_TIMEOUT = 15000;
	var CATEGORY_TIMEOUT = 10000;
	var STREAM_TIMEOUT = 45000;

	// ===========================================================================
	// HEADERS
	// ===========================================================================
	var UA =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
	var H_JSON = {
		"User-Agent": UA,
		Accept: "application/json, text/plain, */*",
	};

	// ===========================================================================
	// UTILITIES
	// ===========================================================================
	function log(msg) {
		try {
			console.log("[" + TAG + "] " + msg);
		} catch (e) {}
	}
	function warn(msg) {
		try {
			console.warn("[" + TAG + "] " + msg);
		} catch (e) {}
	}
	function str(s) {
		return String(s == null ? "" : s);
	}
	function padNum(n) {
		return n < 10 ? "0" + n : String(n);
	}

	function withTimeout(promise, ms, label) {
		return new Promise(function (resolve) {
			var done = false;
			var timer = setTimeout(function () {
				if (!done) {
					done = true;
					warn("timeout (" + ms + "ms) " + label);
					resolve(null);
				}
			}, ms);
			promise
				.then(function (v) {
					if (!done) {
						done = true;
						clearTimeout(timer);
						resolve(v);
					}
				})
				.catch(function () {
					if (!done) {
						done = true;
						clearTimeout(timer);
						resolve(null);
					}
				});
		});
	}

	// ===========================================================================
	// SDK SHIMS
	// ===========================================================================
	if (typeof globalThis.MultimediaItem === "undefined") {
		globalThis.MultimediaItem = function (props) {
			if (props) {
				for (var k in props) {
					if (props.hasOwnProperty(k)) this[k] = props[k];
				}
			}
		};
	}
	if (typeof globalThis.Episode === "undefined") {
		globalThis.Episode = function (props) {
			if (props) {
				for (var k in props) {
					if (props.hasOwnProperty(k)) this[k] = props[k];
				}
			}
		};
	}
	if (typeof globalThis.StreamResult === "undefined") {
		globalThis.StreamResult = function (props) {
			if (props) {
				for (var k in props) {
					if (props.hasOwnProperty(k)) this[k] = props[k];
				}
			}
		};
	}
	if (typeof globalThis.Actor === "undefined") {
		globalThis.Actor = function (props) {
			if (props) {
				for (var k in props) {
					if (props.hasOwnProperty(k)) this[k] = props[k];
				}
			}
		};
	}
	if (typeof globalThis.Trailer === "undefined") {
		globalThis.Trailer = function (props) {
			if (props) {
				for (var k in props) {
					if (props.hasOwnProperty(k)) this[k] = props[k];
				}
			}
		};
	}

	// ===========================================================================
	// ENVIRONMENT POLYFILLS
	// ===========================================================================
	if (typeof global === "undefined") {
		globalThis.global = globalThis;
	}
	if (typeof window === "undefined") {
		globalThis.window = globalThis;
	}
	if (typeof globalThis.self === "undefined") {
		globalThis.self = globalThis;
	}

	// ===========================================================================
	// HTTP LAYER — Robust http_get wrapper
	// ===========================================================================
	function normalizeResponse(r) {
		if (!r) return { status: 0, body: "" };
		if (r instanceof Error) return { status: 0, body: "", error: r };
		var body = "";
		if (typeof r.body === "string") body = r.body;
		else if (r.body && typeof r.body === "object")
			body = JSON.stringify(r.body);
		else if (typeof r === "string") body = r;
		else if (r && typeof r.statusCode === "number") {
			body = r.data || r.body || "";
			r.status = r.statusCode;
		}
		return {
			status: r.status || r.statusCode || (body ? 200 : 0),
			body: body,
			headers: r.headers || {},
		};
	}

	function httpGet(url, headers) {
		return new Promise(function (resolve) {
			try {
				var result = http_get(url, headers);
				if (result && typeof result.then === "function") {
					result
						.then(function (r) {
							if (r && r.length === 2 && r[0] === null)
								resolve(normalizeResponse(r[1]));
							else resolve(normalizeResponse(r));
						})
						.catch(function (e) {
							resolve({ status: 0, body: "", error: e });
						});
					return;
				}
				if (result && typeof result.status !== "undefined") {
					resolve(normalizeResponse(result));
					return;
				}
				http_get(url, headers, function (err, res) {
					if (err) {
						if (err && typeof err === "object" && err.status !== undefined)
							resolve(normalizeResponse(err));
						else resolve({ status: 0, body: "", error: err });
					} else if (res) {
						resolve(normalizeResponse(res));
					} else {
						resolve({ status: 200, body: "", headers: {} });
					}
				});
			} catch (e) {
				try {
					http_get(url, headers, function (r) {
						resolve(normalizeResponse(r || {}));
					});
				} catch (e2) {
					resolve({ status: 0, body: "", error: e2 });
				}
			}
		});
	}

	function httpGetTimed(url, headers, ms) {
		return new Promise(function (resolve) {
			var done = false;
			var timer = setTimeout(function () {
				if (!done) {
					done = true;
					resolve({ status: 0, body: "", error: new Error("timeout") });
				}
			}, ms || HTTP_TIMEOUT);
			httpGet(url, headers)
				.then(function (r) {
					if (!done) {
						done = true;
						clearTimeout(timer);
						resolve(r);
					}
				})
				.catch(function () {
					if (!done) {
						done = true;
						clearTimeout(timer);
						resolve({ status: 0, body: "", error: new Error("fetch failed") });
					}
				});
		});
	}

	function fetchJson(url, headers) {
		return httpGet(url, headers).then(function (r) {
			if (r.status === 0 || r.status >= 400) return null;
			try {
				return JSON.parse(r.body);
			} catch (e) {
				return null;
			}
		});
	}

	// ===========================================================================
	// FETCH POLYFILL
	// ===========================================================================
	if (typeof globalThis.fetch === "undefined") {
		globalThis.fetch = function (url, opts) {
			return new Promise(function (resolve) {
				var urlStr = typeof url === "object" && url.url ? url.url : String(url);
				var options = opts || {};
				var method = (options.method || "GET").toUpperCase();
				var reqHeaders = {};
				for (var k in H_JSON) {
					if (H_JSON.hasOwnProperty(k)) reqHeaders[k] = H_JSON[k];
				}
				var h = options.headers || {};
				for (var k in h) {
					if (h.hasOwnProperty(k)) reqHeaders[k] = h[k];
				}
				function onResp(err, res) {
					if (err && !res) {
						if (err.status !== undefined) res = err;
						else {
							resolve({
								ok: false,
								status: 0,
								json: function () {
									return Promise.reject(err);
								},
								text: function () {
									return Promise.resolve("");
								},
							});
							return;
						}
					}
					if (!res) {
						resolve({
							ok: false,
							status: 0,
							json: function () {
								return Promise.reject(new Error("no response"));
							},
							text: function () {
								return Promise.resolve("");
							},
						});
						return;
					}
					var bodyStr =
						typeof res.body === "string"
							? res.body
							: res.body
								? JSON.stringify(res.body)
								: "";
					var ok = res.status >= 200 && res.status < 300;
					resolve({
						ok: ok,
						status: res.status || 200,
						json: function () {
							try {
								return Promise.resolve(JSON.parse(bodyStr));
							} catch (e) {
								return Promise.reject(e);
							}
						},
						text: function () {
							return Promise.resolve(bodyStr);
						},
					});
				}
				try {
					if (method === "POST")
						http_post(urlStr, reqHeaders, options.body || "", onResp);
					else http_get(urlStr, reqHeaders, onResp);
				} catch (e) {
					resolve({
						ok: false,
						status: 0,
						json: function () {
							return Promise.reject(e);
						},
						text: function () {
							return Promise.resolve("");
						},
					});
				}
			});
		};
	}

	// ===========================================================================
	// TMDB FUNCTIONS
	// ===========================================================================
	function getNextTmdbKey() {
		var key = TMDB_KEYS[_tmdbKeyIdx % TMDB_KEYS.length];
		_tmdbKeyIdx++;
		return key;
	}

	function tmdbGet(endpoint, params) {
		var p = [];
		for (var k in params) {
			if (params.hasOwnProperty(k))
				p.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
		}
		var qs = p.join("&");
		var url =
			TMDB_BASE +
			"/" +
			endpoint +
			"?api_key=" +
			getNextTmdbKey() +
			(qs ? "&" + qs : "");
		return fetchJson(url, H_JSON).then(function (result) {
			if (!result) {
				var url2 =
					TMDB_BASE +
					"/" +
					endpoint +
					"?api_key=" +
					getNextTmdbKey() +
					(qs ? "&" + qs : "");
				return fetchJson(url2, H_JSON);
			}
			return result;
		});
	}

	function tmdbSearchMulti(query, page) {
		return tmdbGet("search/multi", { query: query, page: page || 1 });
	}

	function tmdbDetails(id, type) {
		return tmdbGet(type + "/" + id, {
			append_to_response: "credits,videos,external_ids",
		});
	}

	function tmdbSeasonEpisodes(tmdbId, seasonNum) {
		return tmdbGet("tv/" + tmdbId + "/season/" + seasonNum, {});
	}

	function tmdbToItem(r, fallbackType) {
		try {
			var title =
				r.title || r.name || r.original_title || r.original_name || "";
			if (!title) return null;
			var mediaType = r.media_type || fallbackType || "movie";
			if (mediaType === "tv") mediaType = "series";
			var id = r.id;
			var posterPath = r.poster_path
				? TMDB_IMG + "/" + IMG_POSTER + r.poster_path
				: r.backdrop_path
					? TMDB_IMG + "/" + IMG_BACKDROP + r.backdrop_path
					: "";
			var year = (r.release_date || r.first_air_date || "").split("-")[0];
			return new MultimediaItem({
				title: title,
				url: "tmdb:" + mediaType + ":" + id,
				posterUrl: posterPath,
				type: mediaType,
				year: parseInt(year, 10) || undefined,
				score: r.vote_average || undefined,
			});
		} catch (e) {
			return null;
		}
	}

	// ===========================================================================
	// MULTI-PAGE FETCH HELPERS
	// ===========================================================================
	function fetchUpToN(endpoint, params, mediaType, n) {
		var pagesNeeded = Math.ceil(n / 20);
		var promises = [];
		for (var i = 1; i <= pagesNeeded; i++) {
			var p = {};
			for (var k in params) {
				if (params.hasOwnProperty(k)) p[k] = params[k];
			}
			p.page = i;
			promises.push(tmdbGet(endpoint, p));
		}
		return Promise.all(promises).then(function (results) {
			var items = [];
			var seen = {};
			for (var r = 0; r < results.length; r++) {
				if (results[r] && results[r].results) {
					for (var j = 0; j < results[r].results.length; j++) {
						var item = tmdbToItem(results[r].results[j], mediaType);
						if (item && !seen[item.url]) {
							seen[item.url] = true;
							items.push(item);
						}
					}
				}
			}
			return { items: items.slice(0, n) };
		});
	}

	function fetchMergedUpToN(
		movieEndpoint,
		movieParams,
		tvEndpoint,
		tvParams,
		n,
	) {
		var pages = Math.ceil(n / 20);
		var promises = [];
		for (var i = 1; i <= pages; i++) {
			var mp = {};
			for (var k in movieParams) {
				if (movieParams.hasOwnProperty(k)) mp[k] = movieParams[k];
			}
			mp.page = i;
			promises.push(
				tmdbGet(movieEndpoint, mp).then(function (d) {
					return { type: "movie", data: d };
				}),
			);
		}
		for (var i = 1; i <= pages; i++) {
			var tp = {};
			for (var k in tvParams) {
				if (tvParams.hasOwnProperty(k)) tp[k] = tvParams[k];
			}
			tp.page = i;
			promises.push(
				tmdbGet(tvEndpoint, tp).then(function (d) {
					return { type: "series", data: d };
				}),
			);
		}
		return Promise.all(promises).then(function (results) {
			var items = [];
			var seen = {};
			for (var r = 0; r < results.length; r++) {
				if (results[r].data && results[r].data.results) {
					for (var j = 0; j < results[r].data.results.length; j++) {
						var item = tmdbToItem(results[r].data.results[j], results[r].type);
						if (item && !seen[item.url]) {
							seen[item.url] = true;
							items.push(item);
						}
					}
				}
			}
			items.sort(function (a, b) {
				return (b.score || 0) - (a.score || 0);
			});
			return { items: items.slice(0, n) };
		});
	}

	// ===========================================================================
	// HOME CATEGORIES
	// ===========================================================================
	var HOME_CATEGORIES = [
		{
			id: "trending-movies",
			name: "Trending",
			fetcher: function () {
				return fetchUpToN("trending/movie/week", {}, "movie", 50);
			},
		},
		{
			id: "trending-series",
			name: "Trending Series",
			fetcher: function () {
				return fetchUpToN("trending/tv/week", {}, "series", 50);
			},
		},
		{
			id: "airing-today",
			name: "Airing Today",
			fetcher: function () {
				return fetchUpToN("tv/airing_today", {}, "series", 50);
			},
		},
		{
			id: "top-rated-movies",
			name: "Top Rated Movies",
			fetcher: function () {
				return fetchUpToN("movie/top_rated", {}, "movie", 50);
			},
		},
		{
			id: "top-rated-series",
			name: "Top Rated Series",
			fetcher: function () {
				return fetchUpToN("tv/top_rated", {}, "series", 50);
			},
		},
		{
			id: "trending-anime",
			name: "Trending Anime",
			fetcher: function () {
				return fetchMergedUpToN(
					"discover/movie",
					{ with_genres: "16", sort_by: "popularity.desc" },
					"discover/tv",
					{ with_genres: "16", sort_by: "popularity.desc" },
					50,
				);
			},
		},
		{
			id: "popular-movies",
			name: "Popular Movies",
			fetcher: function () {
				return fetchUpToN(
					"discover/movie",
					{ sort_by: "popularity.desc" },
					"movie",
					50,
				);
			},
		},
		{
			id: "now-playing",
			name: "Now Playing",
			fetcher: function () {
				return fetchUpToN("movie/now_playing", {}, "movie", 50);
			},
		},
		{
			id: "upcoming",
			name: "Upcoming",
			fetcher: function () {
				return fetchUpToN("movie/upcoming", {}, "movie", 50);
			},
		},
	];

	// ===========================================================================
	// getHome
	// ===========================================================================
	function getHome(cb, page) {
		var pn = parseInt(page) || 1;
		log("getHome: page " + pn + " (" + HOME_CATEGORIES.length + " categories)");

		var finalized = false;
		var overallTimer = setTimeout(function () {
			if (!finalized) {
				finalized = true;
				warn("getHome: timeout reached");
				buildAndReturn();
			}
		}, HOME_TIMEOUT);

		var categoryResults = [];
		var retryQueue = [];

		function buildAndReturn() {
			if (finalized && categoryResults.length < HOME_CATEGORIES.length) return;
			finalized = true;
			clearTimeout(overallTimer);
			var out = {};
			var count = 0;
			for (var i = 0; i < categoryResults.length; i++) {
				if (categoryResults[i].items && categoryResults[i].items.length) {
					out[categoryResults[i].name] = categoryResults[i].items;
					count++;
				}
			}
			log(
				"getHome: " +
					count +
					"/" +
					HOME_CATEGORIES.length +
					" categories with data",
			);
			cb({ success: true, data: out, page: pn });
		}

		var mainPromises = HOME_CATEGORIES.map(function (cat) {
			return withTimeout(cat.fetcher(pn), CATEGORY_TIMEOUT, "home:" + cat.id)
				.then(function (result) {
					var items = (result && result.items) || [];
					categoryResults.push({ name: cat.name, items: items });
					if (!items.length) retryQueue.push(cat);
				})
				.catch(function () {
					categoryResults.push({ name: cat.name, items: [] });
					retryQueue.push(cat);
				});
		});

		Promise.all(mainPromises)
			.then(function () {
				if (retryQueue.length > 0) {
					var remaining = HOME_TIMEOUT - (Date.now() - _homeStart);
					if (remaining > 2000) {
						var retryPromises = retryQueue.map(function (cat) {
							return withTimeout(
								cat.fetcher(pn),
								Math.min(remaining - 1000, CATEGORY_TIMEOUT),
								"retry:" + cat.id,
							)
								.then(function (result) {
									var items = (result && result.items) || [];
									if (items.length) {
										for (var i = 0; i < categoryResults.length; i++) {
											if (categoryResults[i].name === cat.name) {
												categoryResults[i].items = items;
												break;
											}
										}
									}
								})
								.catch(function () {});
						});
						return Promise.all(retryPromises).then(function () {
							buildAndReturn();
						});
					}
				}
				buildAndReturn();
			})
			.catch(function () {
				buildAndReturn();
			});

		var _homeStart = Date.now();
	}

	// ===========================================================================
	// search
	// ===========================================================================
	function search(query, cb) {
		var q = str(query).trim();
		if (!q) return cb({ success: true, data: [] });
		log('search: "' + q + '"');

		function doMultiSearch() {
			return tmdbSearchMulti(q, 1)
				.then(function (data) {
					var items = [];
					var seen = {};
					if (data && Array.isArray(data.results)) {
						for (var i = 0; i < data.results.length; i++) {
							var r = data.results[i];
							if (r.media_type === "movie" || r.media_type === "tv") {
								var item = tmdbToItem(
									r,
									r.media_type === "tv" ? "series" : "movie",
								);
								if (item && !seen[item.url]) {
									seen[item.url] = true;
									items.push(item);
								}
							}
						}
					}
					return items;
				})
				.catch(function () {
					return [];
				});
		}

		function doSeparateSearch() {
			return Promise.all([
				tmdbGet("search/movie", { query: q, page: 1 }),
				tmdbGet("search/tv", { query: q, page: 1 }),
			])
				.then(function (results) {
					var items = [];
					var seen = {};
					for (var ri = 0; ri < results.length; ri++) {
						var data = results[ri];
						if (!data || !Array.isArray(data.results)) continue;
						for (var i = 0; i < data.results.length; i++) {
							var r = data.results[i];
							var type = ri === 1 ? "series" : "movie";
							var item = tmdbToItem(r, type);
							if (item && !seen[item.url]) {
								seen[item.url] = true;
								items.push(item);
							}
						}
					}
					return items;
				})
				.catch(function () {
					return [];
				});
		}

		doMultiSearch()
			.then(function (multiResults) {
				if (multiResults.length >= 3) {
					cb({ success: true, data: multiResults.slice(0, 50) });
				} else {
					doSeparateSearch()
						.then(function (sepResults) {
							var combined = {};
							var all = [];
							function addItem(item) {
								if (item && !combined[item.url]) {
									combined[item.url] = true;
									all.push(item);
								}
							}
							multiResults.forEach(addItem);
							sepResults.forEach(addItem);
							cb({ success: true, data: all.slice(0, 50) });
						})
						.catch(function () {
							cb({ success: true, data: multiResults });
						});
				}
			})
			.catch(function () {
				doSeparateSearch()
					.then(function (items) {
						cb({ success: true, data: items.slice(0, 50) });
					})
					.catch(function () {
						cb({ success: true, data: [] });
					});
			});
	}

	// ===========================================================================
	// URL PARSING
	// ===========================================================================
	function parseContentUrl(url) {
		try {
			var s = str(url).trim();

			// tmdb:movie:123 or tmdb:series:123
			var tmdbMatch = s.match(/^tmdb:(movie|series|tv):(\d+)$/i);
			if (tmdbMatch) {
				return {
					tmdbId: tmdbMatch[2],
					mediaType:
						tmdbMatch[1].toLowerCase() === "series" ||
						tmdbMatch[1].toLowerCase() === "tv"
							? "tv"
							: "movie",
					season: null,
					episode: null,
				};
			}

			// nuvio://tv/12345/1/2
			var nuvioTvMatch = s.match(
				/^nuvio:\/\/tv\/(\d+)(?:\/(\d+)(?:\/(\d+))?)?$/i,
			);
			if (nuvioTvMatch) {
				return {
					tmdbId: nuvioTvMatch[1],
					mediaType: "tv",
					season: nuvioTvMatch[2] ? parseInt(nuvioTvMatch[2], 10) : null,
					episode: nuvioTvMatch[3] ? parseInt(nuvioTvMatch[3], 10) : null,
				};
			}

			// nuvio://movie/12345
			var nuvioMovieMatch = s.match(/^nuvio:\/\/movie\/(\d+)/i);
			if (nuvioMovieMatch) {
				return {
					tmdbId: nuvioMovieMatch[1],
					mediaType: "movie",
					season: null,
					episode: null,
				};
			}

			// Raw number
			var numMatch = s.match(/^(\d+)$/);
			if (numMatch) {
				return {
					tmdbId: numMatch[1],
					mediaType: "movie",
					season: null,
					episode: null,
				};
			}

			// Try to extract any number
			var anyNumMatch = s.match(/(\d+)/);
			if (anyNumMatch) {
				return {
					tmdbId: anyNumMatch[1],
					mediaType: "movie",
					season: null,
					episode: null,
				};
			}

			return null;
		} catch (e) {
			warn("parseContentUrl error: " + (e.message || e));
			return null;
		}
	}

	// ===========================================================================
	// load
	// ===========================================================================
	function load(url, cb) {
		try {
			var rawInput = str(url).trim();
			if (!rawInput)
				return cb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "No URL provided",
				});

			var loadTimedOut = false;
			function safeCb(resp) {
				if (loadTimedOut) return;
				loadTimedOut = true;
				clearTimeout(loadTimer);
				cb(resp);
			}

			var loadTimer = setTimeout(function () {
				if (!loadTimedOut) {
					loadTimedOut = true;
					var fallbackType =
						knownType === "tv" || knownType === "series" ? "series" : "movie";
					var fallbackUrl =
						fallbackType === "series"
							? "nuvio://tv/" + resolvedId + "/1/1"
							: "nuvio://movie/" + resolvedId;
					warn("load: timeout for " + url);
					safeCb({
						success: true,
						data: new MultimediaItem({
							title: "Content",
							url: rawInput,
							type: fallbackType,
							episodes: [
								new Episode({
									name: fallbackType === "series" ? "Season 1" : "Play",
									url: fallbackUrl,
									season: 1,
									episode: 1,
								}),
							],
						}),
					});
				}
			}, LOAD_TIMEOUT);

			var resolvedId, knownType;
			var parsed = parseContentUrl(rawInput);
			if (parsed) {
				resolvedId = parsed.tmdbId;
				knownType = parsed.mediaType;
			} else {
				var numMatch = String(rawInput).match(/(\d+)/);
				resolvedId = numMatch ? numMatch[1] : rawInput;
				knownType = "movie";
			}

			if (!resolvedId)
				return safeCb({
					success: false,
					errorCode: "PARSE_ERROR",
					message: "No ID found",
				});

			var apiType =
				knownType === "series" || knownType === "tv" ? "tv" : "movie";
			log("load: " + apiType + " " + resolvedId);

			tmdbDetails(resolvedId, apiType)
				.then(function (data) {
					if (!data) {
						return respondMeta(
							{ name: "Content", id: resolvedId },
							resolvedId,
							safeCb,
							knownType,
							[],
						);
					}

					var episodes = [];
					var isSeries =
						knownType === "series" ||
						knownType === "tv" ||
						apiType === "tv" ||
						(data.number_of_seasons && data.number_of_seasons > 0);

					if (isSeries && Array.isArray(data.seasons) && data.seasons.length) {
						var seasonPromises = [];
						var seasonIdx = 0;
						for (var si = 0; si < data.seasons.length; si++) {
							var s = data.seasons[si];
							if (!s || s.season_number === 0 || s.season_number === undefined)
								continue;
							var sn = s.season_number;
							var delay = seasonIdx * 300;
							seasonIdx++;
							(function (seasonNum, dly) {
								seasonPromises.push(
									new Promise(function (resolve) {
										setTimeout(function () {
											resolve(
												withTimeout(
													tmdbSeasonEpisodes(resolvedId, seasonNum),
													15000,
													"season " + seasonNum,
												)
													.then(function (seasonData) {
														var seasonEps = [];
														if (
															!seasonData ||
															!Array.isArray(seasonData.episodes)
														)
															return seasonEps;
														for (
															var ei = 0;
															ei < seasonData.episodes.length;
															ei++
														) {
															var ep = seasonData.episodes[ei];
															if (!ep || !ep.episode_number) continue;
															try {
																seasonEps.push(
																	new Episode({
																		name:
																			ep.name || "Episode " + ep.episode_number,
																		url:
																			"nuvio://tv/" +
																			resolvedId +
																			"/" +
																			seasonData.season_number +
																			"/" +
																			ep.episode_number,
																		season: seasonData.season_number,
																		episode: ep.episode_number,
																		posterUrl: ep.still_path
																			? TMDB_IMG +
																				"/" +
																				IMG_STILL +
																				ep.still_path
																			: "",
																		description: (ep.overview || "").substring(
																			0,
																			300,
																		),
																		airDate: ep.air_date || "",
																	}),
																);
															} catch (e) {}
														}
														return seasonEps;
													})
													.catch(function () {
														return [];
													}),
											);
										}, dly);
									}),
								);
							})(sn, delay);
						}

						Promise.all(seasonPromises)
							.then(function (seasonResults) {
								for (var si = 0; si < seasonResults.length; si++) {
									var seasonEps = seasonResults[si];
									for (var ei = 0; ei < seasonEps.length; ei++)
										episodes.push(seasonEps[ei]);
								}
								episodes.sort(function (a, b) {
									if (a.season !== b.season) return a.season - b.season;
									return a.episode - b.episode;
								});
								respondMeta(data, resolvedId, safeCb, knownType, episodes);
							})
							.catch(function () {
								respondMeta(data, resolvedId, safeCb, knownType, episodes);
							});
					} else {
						episodes.push(
							new Episode({
								name: "Full Movie",
								url: "nuvio://movie/" + resolvedId,
								season: 1,
								episode: 1,
								posterUrl: data.poster_path
									? TMDB_IMG + "/" + IMG_POSTER + data.poster_path
									: "",
							}),
						);
						respondMeta(data, resolvedId, safeCb, knownType, episodes);
					}
				})
				.catch(function (e) {
					warn("load TMDB error: " + (e.message || e));
					respondMeta(
						{ name: "Unknown", id: rawInput },
						rawInput.replace(/[^0-9]/g, ""),
						safeCb,
						"movie",
						[
							new Episode({
								name: "Play",
								url: "nuvio://movie/" + rawInput.replace(/[^0-9]/g, ""),
								season: 1,
								episode: 1,
							}),
						],
					);
				});
		} catch (e) {
			warn("load error: " + (e.message || e));
			cb({
				success: false,
				errorCode: "LOAD_ERROR",
				message: e.message || "Error",
			});
		}
	}

	function respondMeta(data, metaId, cb, knownType, episodes) {
		try {
			var apiType =
				knownType === "series" || knownType === "tv" ? "tv" : "movie";
			if (data.media_type === "tv" || data.media_type === "series")
				apiType = "tv";
			var isSeries = apiType !== "movie";
			var st = isSeries ? "series" : "movie";
			var title =
				data.title ||
				data.name ||
				data.original_title ||
				data.original_name ||
				"Unknown";
			var posterPath = data.poster_path
				? TMDB_IMG + "/" + IMG_POSTER + data.poster_path
				: data.poster || data.posterUrl || "";
			if (!posterPath && data.backdrop_path)
				posterPath = TMDB_IMG + "/" + IMG_BACKDROP + data.backdrop_path;
			var backdropPath = data.backdrop_path
				? TMDB_IMG + "/" + IMG_BACKDROP + data.backdrop_path
				: data.backdrop || data.background || "";
			var releaseDate = data.release_date || data.first_air_date || "";
			var year = releaseDate
				? parseInt(releaseDate.split("-")[0], 10)
				: undefined;
			if (year && (year < 1900 || year > 2100)) year = undefined;
			var rating = data.vote_average
				? parseFloat(data.vote_average)
				: undefined;
			var desc = (data.overview || data.description || "")
				.replace(/<[^>]*>/g, "")
				.trim()
				.substring(0, 500);

			var cast = undefined;
			var credits = data.credits;
			if (credits && Array.isArray(credits.cast) && credits.cast.length) {
				cast = [];
				for (var ci = 0; ci < Math.min(credits.cast.length, 30); ci++) {
					try {
						var c = credits.cast[ci];
						if (!c) continue;
						cast.push(
							new Actor({
								name: c.name || "Unknown",
								role: c.character || "",
								image: c.profile_path
									? TMDB_IMG + "/" + IMG_PROFILE + c.profile_path
									: "",
							}),
						);
					} catch (e) {}
				}
				if (!cast.length) cast = undefined;
			}

			var trailers = undefined;
			var videos = data.videos;
			if (videos && Array.isArray(videos.results) && videos.results.length) {
				trailers = [];
				for (var tvi = 0; tvi < videos.results.length; tvi++) {
					try {
						var v = videos.results[tvi];
						if (!v || v.site !== "YouTube" || !v.key) continue;
						if (v.type !== "Trailer" && v.type !== "Teaser") continue;
						trailers.push(
							new Trailer({
								url: "https://www.youtube.com/watch?v=" + v.key,
								name: v.name || "Trailer",
							}),
						);
					} catch (e) {}
				}
				if (!trailers.length) trailers = undefined;
			}

			var genres = undefined;
			if (Array.isArray(data.genres) && data.genres.length) {
				genres = data.genres.map(function (g) {
					return g.name || String(g.id);
				});
			}

			var status = undefined;
			if (data.status) {
				var sv = str(data.status).toLowerCase();
				if (sv === "ended" || sv === "canceled") status = "completed";
				else if (
					sv === "returning series" ||
					sv === "continuing" ||
					sv === "in production"
				)
					status = "ongoing";
			}

			var runtime = data.runtime ? str(data.runtime) : undefined;
			if (!runtime && data.episode_run_time && data.episode_run_time.length)
				runtime = str(data.episode_run_time[0]);

			if (!episodes || !episodes.length) {
				episodes = [];
				episodes.push(
					new Episode({
						name: isSeries ? "Season 1" : "Full Movie",
						url: isSeries
							? "nuvio://tv/" + metaId + "/1/1"
							: "nuvio://movie/" + metaId,
						season: 1,
						episode: 1,
						posterUrl: posterPath,
					}),
				);
			}

			cb({
				success: true,
				data: new MultimediaItem({
					title: title,
					url: "tmdb:" + st + ":" + metaId,
					posterUrl: posterPath,
					bannerUrl: backdropPath,
					description: desc,
					type: st,
					year: year,
					score: rating,
					genres: genres,
					cast: cast,
					trailers: trailers,
					status: status,
					runtime: runtime,
					episodes: episodes,
				}),
			});
		} catch (e) {
			warn("respondMeta error: " + (e.message || e));
			cb({
				success: true,
				data: new MultimediaItem({
					title: data.title || data.name || "Unknown",
					url: "tmdb:movie:" + metaId,
					type: "movie",
					episodes: [
						new Episode({
							name: "Play",
							url: "nuvio://movie/" + metaId,
							season: 1,
							episode: 1,
						}),
					],
				}),
			});
		}
	}

	// ===========================================================================
	// MULTISOURCE API CLIENT
	// ===========================================================================
	function getBaseUrl() {
		try {
			if (typeof manifest !== "undefined" && manifest.baseUrl)
				return manifest.baseUrl.replace(/\/$/, "");
		} catch (e) {}
		return "https://multisource-api.fly.dev";
	}

	function multisourceFetch(tmdbId, type, season, episode) {
		var base = getBaseUrl();
		var endpoint;
		if (type === "tv") {
			endpoint =
				base +
				"/api/tv/" +
				tmdbId +
				"?season=" +
				(season || 1) +
				"&episode=" +
				(episode || 1);
		} else {
			endpoint = base + "/api/movie/" + tmdbId;
		}
		log("multisource: fetching " + endpoint);
		return httpGetTimed(endpoint, H_JSON, STREAM_TIMEOUT).then(function (res) {
			if (res.status === 0 || res.status >= 400) {
				warn("multisource: HTTP " + res.status + " for " + endpoint);
				return null;
			}
			try {
				return JSON.parse(res.body);
			} catch (e) {
				return null;
			}
		});
	}

	// ===========================================================================
	// STREAM CACHE
	// ===========================================================================
	var _streamsCache = {};
	var _streamsCacheTimers = {};
	var STREAM_CACHE_TTL = 3600000; // 1 hour

	function getStreamCacheKey(url) {
		var parsed = parseContentUrl(url);
		if (!parsed) return url;
		return (
			parsed.tmdbId +
			":" +
			parsed.mediaType +
			":" +
			(parsed.season || "0") +
			":" +
			(parsed.episode || "0")
		);
	}

	function getCachedStreams(url) {
		var key = getStreamCacheKey(url);
		return _streamsCache[key] || null;
	}

	function setCachedStreams(url, streams) {
		var key = getStreamCacheKey(url);
		if (_streamsCacheTimers[key]) clearTimeout(_streamsCacheTimers[key]);
		_streamsCache[key] = streams;
		_streamsCacheTimers[key] = setTimeout(function () {
			delete _streamsCache[key];
			delete _streamsCacheTimers[key];
		}, STREAM_CACHE_TTL);
	}

	// ===========================================================================
	// loadStreams — Resolves streams via multisource-api
	// ===========================================================================
	function loadStreams(url, cb) {
		log("loadStreams: " + url);

		var cached = getCachedStreams(url);
		if (cached) {
			log("loadStreams: cache hit (" + cached.length + " streams)");
			return cb({ success: true, data: cached });
		}

		var parsed = parseContentUrl(url);
		if (!parsed) {
			warn("loadStreams: could not parse URL: " + url);
			return cb({
				success: false,
				errorCode: "PARSE_ERROR",
				message: "Could not parse URL: " + url,
			});
		}

		var tmdbId = parsed.tmdbId;
		var mediaType = parsed.mediaType;
		var season = parsed.season || 1;
		var episodeNum = parsed.episode || 1;

		if (!tmdbId) {
			return cb({
				success: false,
				errorCode: "PARSE_ERROR",
				message: "No TMDB ID in URL",
			});
		}

		var streamTimedOut = false;
		function safeCb(resp) {
			if (streamTimedOut) return;
			streamTimedOut = true;
			clearTimeout(streamTimer);
			cb(resp);
		}

		var streamTimer = setTimeout(function () {
			if (!streamTimedOut) {
				streamTimedOut = true;
				warn("loadStreams: timeout");
				cb({ success: true, data: [] });
			}
		}, STREAM_TIMEOUT);

		multisourceFetch(tmdbId, mediaType, season, episodeNum)
			.then(function (apiResult) {
				if (!apiResult || !apiResult.success) {
					warn("multisource: API returned failure");
					return safeCb({ success: true, data: [] });
				}

				var allStreams = [];
				var sources = apiResult.sources || [];

				for (var i = 0; i < sources.length; i++) {
					var source = sources[i];
					if (
						!source ||
						source.status !== "working" ||
						!source.streams ||
						!source.streams.length
					)
						continue;

					for (var j = 0; j < source.streams.length; j++) {
						var stream = source.streams[j];
						if (!stream || !stream.url) continue;

						try {
							var quality = stream.quality || stream.resolution || "";
							var sourceLabel =
								source.source + (quality ? " [" + quality + "]" : "");

							var streamResult = new StreamResult({
								url: stream.url,
								source: sourceLabel,
								headers: {},
							});

							if (streamResult && streamResult.url) {
								allStreams.push(streamResult);
							}
						} catch (e) {
							log("loadStreams: StreamResult error: " + (e.message || e));
						}
					}
				}

				// Deduplicate by URL
				var seen = {};
				var uniqueStreams = [];
				for (var k = 0; k < allStreams.length; k++) {
					var s = allStreams[k];
					var streamUrl = s.url || "";
					if (streamUrl && !seen[streamUrl]) {
						seen[streamUrl] = true;
						uniqueStreams.push(s);
					}
				}

				if (uniqueStreams.length > 0) {
					setCachedStreams(url, uniqueStreams);
				}

				log(
					"loadStreams: " +
						uniqueStreams.length +
						" unique streams from " +
						sources.length +
						" sources (working: " +
						apiResult.workingSources +
						"/" +
						apiResult.totalSources +
						")",
				);
				safeCb({ success: true, data: uniqueStreams });
			})
			.catch(function (e) {
				warn("loadStreams: error: " + (e.message || e));
				safeCb({ success: true, data: [] });
			});
	}

	// ===========================================================================
	// EXPORT GLOBALS
	// ===========================================================================
	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;

	log(
		"MultiSource Hub loaded with " +
			HOME_CATEGORIES.length +
			" categories, multisource-api integration, stream caching",
	);
})();
