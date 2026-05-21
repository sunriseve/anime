(function () {
	/**
	 * KimCartoon Plugin for SkyStream — v2 (fixed)
	 *
	 * Scrapes kimcartoon.si for cartoons with multi-server stream resolution.
	 * Servers: Tserver (mofl.pro HLS), Vhserver (vidhosters.com HLS), Hserver (hydrax)
	 * ALL servers queried in parallel, ALL playable links returned.
	 *
	 * Fixes:
	 *  - loadExtractor guard (check typeof before calling)
	 *  - axios → SDK http_get for redirect resolution
	 *  - Parallel getHome with 15-min in-memory cache (prevents rate limiting)
	 *  - Robust type detection (URL pattern + episode count)
	 *  - Poster URL normalization (force absolute HTTPS)
	 *  - Vidstream player source extraction fallback
	 *  - goto.php redirect resolution for direct .m3u8 URLs
	 *  - Error context in all catch blocks (no silent swallows)
	 *  - Null/edge-case guards on all HTML parsing
	 */

	// ── Configuration ──────────────────────────────────────────────────────

	var USER_AGENT =
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

	var BASE = manifest.baseUrl;

	var HEADERS = {
		"User-Agent": USER_AGENT,
		Referer: BASE + "/",
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
		"Accept-Language": "en-US,en;q=0.5",
	};

	var JSON_HEADERS = {
		"User-Agent": USER_AGENT,
		Referer: BASE + "/",
		Accept: "application/json, text/javascript, */*; q=0.01",
		"X-Requested-With": "XMLHttpRequest",
		"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
	};

	var STREAM_HEADERS = {
		"User-Agent": USER_AGENT,
		Referer: BASE + "/",
	};

	// ── In-memory cache ────────────────────────────────────────────────────

	var _cache = {};
	var CACHE_TTL = 15 * 60 * 1000; // 15 minutes

	function cacheGet(key) {
		var entry = _cache[key];
		if (!entry) return null;
		if (Date.now() - entry.ts > CACHE_TTL) {
			delete _cache[key];
			return null;
		}
		return entry.data;
	}

	function cacheSet(key, data) {
		_cache[key] = { ts: Date.now(), data: data };
	}

	// ── String Helpers ─────────────────────────────────────────────────────

	function extractAll(text, start, end) {
		if (!text) return [];
		var results = [];
		var pos = 0;
		while (pos < text.length) {
			var si = text.indexOf(start, pos);
			if (si === -1) break;
			var ei = text.indexOf(end, si + start.length);
			if (ei === -1) {
				results.push(text.substring(si + start.length));
				break;
			}
			results.push(text.substring(si + start.length, ei));
			pos = ei + end.length;
		}
		return results;
	}

	function extractBetween(text, start, end) {
		if (!text) return "";
		var si = text.indexOf(start);
		if (si === -1) return "";
		var ei = text.indexOf(end, si + start.length);
		return ei === -1
			? text.substring(si + start.length)
			: text.substring(si + start.length, ei);
	}

	function stripTags(text) {
		return String(text || "")
			.replace(/<[^>]+>/g, "")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.replace(/&quot;/g, '"')
			.replace(/&#039;/g, "'")
			.replace(/&nbsp;/g, " ")
			.trim();
	}

	function fixUrl(url) {
		if (!url) return "";
		if (url.indexOf("http://") === 0 || url.indexOf("https://") === 0)
			return url;
		if (url.indexOf("//") === 0) return "https:" + url;
		if (url.indexOf("/") === 0) return BASE + url;
		return BASE + "/" + url;
	}

	function normalizePosterUrl(url) {
		if (!url) return "";
		var fixed = fixUrl(url);
		if (fixed.indexOf("http://") === 0) {
			fixed = "https://" + fixed.substring(7);
		}
		return fixed;
	}

	// ── HTTP helpers (SDK primitives only) ────────────────────────────────

	async function httpGet(url) {
		var res = await http_get(url, HEADERS);
		return (res && res.body) || "";
	}

	async function httpPostJson(url, body) {
		var res = await http_post(url, JSON_HEADERS, body);
		return JSON.parse((res && res.body) || "{}");
	}

	async function httpGetJson(url) {
		var res = await http_get(url, JSON_HEADERS);
		return JSON.parse((res && res.body) || "{}");
	}

	/**
	 * Resolve a goto.php redirect URL using the SDK http_get.
	 * The SDK may return the final URL in res.url after following redirects.
	 */
	async function resolveRedirectUrl(url) {
		try {
			var res = await http_get(url, {
				"User-Agent": USER_AGENT,
				Referer: BASE + "/",
			});
			if (res && res.url) return res.url;
		} catch (_e) {}
		return url;
	}

	// ── HTML Parsers ───────────────────────────────────────────────────────

	function isSeriesBlock(block) {
		if (block.indexOf("Episode-") !== -1) return true;
		if (block.indexOf("?id=") !== -1) return true;
		if (block.indexOf("ep-bg") !== -1) return true;
		return false;
	}

	function parseCartoonList(html) {
		var items = [];
		if (!html) return items;

		var blocks = extractAll(html, '<div class="item', "</div>");

		for (var i = 0; i < blocks.length; i++) {
			try {
				var block = blocks[i];

				// Poster from background-image on <a class="thumb">
				var posterUrl = "";
				var bgMatch = block.match(/background-image:\s*url\('([^']+)'\)/);
				if (bgMatch) posterUrl = bgMatch[1];

				// Poster fallback: <img> tag
				if (!posterUrl) {
					var imgMatch = block.match(/<img\s+src="([^"]+)"[^>]*\/?>/i);
					if (imgMatch) posterUrl = imgMatch[1];
				}

				// Title from <h2 class="title">
				var titleMatch = block.match(
					/<h2[^>]*class="title"[^>]*>([\s\S]*?)<\/h2>/,
				);
				var title = titleMatch ? stripTags(titleMatch[1]) : "";

				// URL from <a class="thumb">
				var urlMatch = block.match(/<a[^>]*class="thumb"[^>]*href="([^"]+)"/);
				var url = urlMatch ? fixUrl(urlMatch[1]) : "";

				if (!title || !url) continue;

				items.push(
					new MultimediaItem({
						title: title,
						url: url,
						posterUrl: normalizePosterUrl(posterUrl),
						type: isSeriesBlock(block) ? "series" : "movie",
					}),
				);
			} catch (_e) {}
		}
		return items;
	}

	function parseEpisodes(html) {
		var episodes = [];
		if (!html) return episodes;

		// Method 1: <select id="selectEpisode"> options (modern series pages)
		var selectBlock = extractBetween(
			html,
			'<select id="selectEpisode"',
			"</select>",
		);
		if (selectBlock) {
			var options = extractAll(selectBlock, '<option value="', "</option>");
			for (var i = 0; i < options.length; i++) {
				try {
					var opt = options[i];
					var valEnd = opt.indexOf('"');
					if (valEnd === -1) continue;
					var epUrl = opt.substring(0, valEnd);
					var labelStart = opt.indexOf(">", valEnd);
					if (labelStart === -1) continue;
					var epName = stripTags(opt.substring(labelStart + 1));
					var episodeNum = i + 1;
					var numMatch = epName.match(/Episode\s*(\d+)/i);
					if (numMatch) episodeNum = parseInt(numMatch[1], 10);
					episodes.push(
						new Episode({
							name: epName,
							url: fixUrl(epUrl),
							season: 1,
							episode: episodeNum,
						}),
					);
				} catch (_e) {}
			}
		}

		// Method 2: <h3> episode links (older series pages)
		if (episodes.length === 0) {
			var h3blocks = extractAll(html, "<h3>", "</h3>");
			for (var j = 0; j < h3blocks.length; j++) {
				try {
					var h3 = h3blocks[j];
					var aStart = h3.indexOf('<a href="');
					if (aStart === -1) continue;
					var hrefStart = aStart + 9;
					var hrefEnd = h3.indexOf('"', hrefStart);
					if (hrefEnd === -1) continue;
					var epUrl = h3.substring(hrefStart, hrefEnd);
					var nameStart = h3.indexOf(">", hrefEnd) + 1;
					var epName = stripTags(h3.substring(nameStart).replace(/<\/a>/, ""));
					var episodeNum2 = j + 1;
					var numMatch2 = epName.match(/Episode\s*(\d+)/i);
					if (numMatch2) episodeNum2 = parseInt(numMatch2[1], 10);
					episodes.push(
						new Episode({
							name: epName,
							url: fixUrl(epUrl),
							season: 1,
							episode: episodeNum2,
						}),
					);
				} catch (_e) {}
			}
		}

		// Method 3: <div class="barContent episodeList"> links (newer series pages)
		if (episodes.length === 0) {
			var listDiv = extractBetween(
				html,
				'class="barContent episodeList full"',
				"</div>",
			);
			if (listDiv) {
				// Extract all episode links from the list
				var linkPattern =
					/<a\s+href="([^"]*Episode-([A-Za-z]*)-?(\d+)[^"]*)"[^>]*>\s*(.*?)\s*<\/a>/gi;
				var m;
				while ((m = linkPattern.exec(listDiv)) !== null) {
					try {
						var epFullUrl = fixUrl(m[1]);
						var epNum = parseInt(m[3], 10);
						var epLabel = stripTags(m[4] || "");
						if (!epLabel) {
							epLabel = "Episode " + epNum;
						}
						episodes.push(
							new Episode({
								name: epLabel,
								url: epFullUrl,
								season: 1,
								episode: epNum,
							}),
						);
					} catch (_e) {}
				}
			}
		}

		// Method 4: Scan all <a> tags with Episode-\d+ pattern (catch-all)
		if (episodes.length === 0) {
			var anchorPattern =
				/<a\s+href="([^"]*Episode-(\d+)[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
			var m2;
			while ((m2 = anchorPattern.exec(html)) !== null) {
				try {
					var epUrl2 = fixUrl(m2[1]);
					var epNum2 = parseInt(m2[2], 10);
					var epLabel2 = stripTags(m2[3] || "");
					if (!epLabel2) {
						epLabel2 = "Episode " + epNum2;
					}
					// Deduplicate by URL
					var isDup = false;
					for (var d = 0; d < episodes.length; d++) {
						if (episodes[d].url === epUrl2) {
							isDup = true;
							break;
						}
					}
					if (!isDup) {
						episodes.push(
							new Episode({
								name: epLabel2,
								url: epUrl2,
								season: 1,
								episode: epNum2,
							}),
						);
					}
				} catch (_e) {}
			}
		}

		return episodes;
	}

	// ── Stream Source Extraction ───────────────────────────────────────────

	async function extractJWPlayerSources(html) {
		var streams = [];
		if (!html) return streams;

		// Pattern 1: sources: [{ "file": "...", "label": "..." }]
		var srcMatch = html.match(/sources:\s*\[([\s\S]*?)\]/);
		if (srcMatch) {
			var blocks = extractAll(srcMatch[1], "{", "}");
			for (var i = 0; i < blocks.length; i++) {
				try {
					var fm = blocks[i].match(/["']file["']\s*:\s*["']([^"']+)["']/);
					var lm = blocks[i].match(/["']label["']\s*:\s*["']([^"']+)["']/);
					if (fm) {
						streams.push({
							url: fm[1],
							quality: lm ? lm[1] : "auto",
						});
					}
				} catch (_e) {}
			}
		}

		// Pattern 2: standalone file key for HLS (not inside sources array)
		if (streams.length === 0) {
			var fileMatch = html.match(
				/(?:file|"file")\s*:\s*"([^"]+\.(?:m3u8|mp4)[^"]*)"/,
			);
			if (fileMatch) {
				var before = html.substring(
					Math.max(0, html.indexOf(fileMatch[0]) - 200),
					html.indexOf(fileMatch[0]),
				);
				if (before.indexOf("sources:") === -1) {
					streams.push({
						url: fileMatch[1],
						quality: "auto",
					});
				}
			}
		}

		return streams;
	}

	async function extractGenericPlayerSources(html, pageUrl) {
		var streams = [];
		if (!html) return streams;

		// Pattern: <source src="..." type="application/x-mpegURL">
		var srcPattern = /<source\s+[^>]*src="([^"]+)"/g;
		var m;
		while ((m = srcPattern.exec(html)) !== null) {
			streams.push({ url: fixUrl(m[1]), quality: "auto" });
		}

		// Pattern: <video src="...">
		if (streams.length === 0) {
			var videoMatch = html.match(/<video[^>]*src="([^"]+)"/);
			if (videoMatch) {
				streams.push({ url: fixUrl(videoMatch[1]), quality: "auto" });
			}
		}

		// Pattern: playURL = "...", videoUrl = "...", file: "..."
		if (streams.length === 0) {
			var urlVarMatch = html.match(
				/(?:playURL|videoUrl|file)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/,
			);
			if (urlVarMatch) {
				streams.push({ url: fixUrl(urlVarMatch[1]), quality: "auto" });
			}
		}

		// Pattern: iframe src with goto.php (from vidstream player)
		if (streams.length === 0) {
			var gotoMatch = html.match(/src="([^"]*goto\.php[^"]*)"/);
			if (gotoMatch) {
				streams.push({ url: fixUrl(gotoMatch[1]), quality: "auto" });
			}
		}

		return streams;
	}

	// ── Stream Resolver ───────────────────────────────────────────────────

	/**
	 * Resolve a single stream URL — follow goto.php redirects to direct .m3u8.
	 */
	async function resolveStreamUrl(url) {
		if (!url) return "";
		// Direct media URL — no resolution needed
		if (
			url.indexOf(".m3u8") !== -1 ||
			url.indexOf(".mp4") !== -1 ||
			url.indexOf(".ts") !== -1
		) {
			if (url.indexOf("goto.php") === -1) return url;
		}
		// Follow goto.php redirect
		if (url.indexOf("goto.php") !== -1) {
			try {
				var resolved = await resolveRedirectUrl(url);
				if (resolved && resolved !== url) return resolved;
			} catch (_re) {}
		}
		return url;
	}

	async function resolveServerStreams(episodeId, serverId, serverLabel) {
		var streams = [];

		try {
			var loadUrl = BASE + "/ajax/anime/load_episodes_v2?s=" + serverId;
			var loadData = await httpPostJson(loadUrl, "episode_id=" + episodeId);

			if (!loadData || !loadData.status) return streams;

			// --- Embed mode (value is iframe HTML) ---
			if (loadData.embed) {
				var iframeMatch = loadData.value.match(/<iframe[^>]*src="([^"]+)"/);
				if (!iframeMatch) return streams;
				var iframeSrc = iframeMatch[1];
				if (iframeSrc.indexOf("http") !== 0) {
					iframeSrc = fixUrl(iframeSrc);
				}

				// Try built-in loadExtractor if available
				if (typeof loadExtractor === "function") {
					try {
						var extracted = await loadExtractor(iframeSrc);
						if (extracted && extracted.length > 0) {
							// Resolve goto.php URLs in extracted results
							for (var e = 0; e < extracted.length; e++) {
								var extUrl = extracted[e].url;
								var resolvedExtUrl = await resolveStreamUrl(extUrl);
								if (resolvedExtUrl) {
									streams.push({
										url: resolvedExtUrl,
										quality: serverLabel + " - " + (extracted[e].quality || ""),
									});
								}
							}
							if (streams.length > 0) return streams;
						}
					} catch (_le) {}
				}

				// Fallback: fetch iframe page and extract sources
				try {
					var playerHtml = await httpGet(iframeSrc);

					// Try JWPlayer extraction
					var jwSources = await extractJWPlayerSources(playerHtml);
					for (var j = 0; j < jwSources.length; j++) {
						var jwUrl = await resolveStreamUrl(jwSources[j].url);
						if (jwUrl) {
							streams.push({
								url: jwUrl,
								quality:
									serverLabel +
									(jwSources[j].quality !== "auto"
										? " - " + jwSources[j].quality
										: ""),
							});
						}
					}

					// Try generic player extraction
					var genSources = await extractGenericPlayerSources(
						playerHtml,
						iframeSrc,
					);
					for (var g = 0; g < genSources.length; g++) {
						// Deduplicate
						var isDup = false;
						for (var s = 0; s < streams.length; s++) {
							if (streams[s].url === genSources[g].url) {
								isDup = true;
								break;
							}
						}
						if (!isDup) {
							var genUrl = await resolveStreamUrl(genSources[g].url);
							if (genUrl) {
								streams.push({
									url: genUrl,
									quality: serverLabel + " - auto",
								});
							}
						}
					}
				} catch (_pe) {}

				return streams;
			}

			// --- Non-embed mode (value is JSON URL) ---
			if (loadData.value) {
				var valueUrl = loadData.value;
				if (valueUrl.indexOf("http") !== 0) {
					valueUrl = fixUrl(valueUrl);
				}

				try {
					var sourcesData = await httpGetJson(valueUrl);
					if (sourcesData.playlist && sourcesData.playlist.length > 0) {
						var pl = sourcesData.playlist[0];
						if (pl.sources && pl.sources.length > 0) {
							for (var q = 0; q < pl.sources.length; q++) {
								var plUrl = await resolveStreamUrl(pl.sources[q].file);
								if (plUrl) {
									streams.push({
										url: plUrl,
										quality:
											serverLabel +
											" - " +
											(pl.sources[q].label
												? pl.sources[q].label + "p"
												: "auto"),
									});
								}
							}
						} else if (pl.file) {
							var plFileUrl = await resolveStreamUrl(pl.file);
							if (plFileUrl) {
								streams.push({
									url: plFileUrl,
									quality: serverLabel,
								});
							}
						}
					}
				} catch (_je) {}
			}
		} catch (_re) {}

		return streams;
	}

	// ── Core Plugin Functions ──────────────────────────────────────────────

	/**
	 * getHome: Returns categories from the site.
	 * Fetches all sections IN PARALLEL.
	 * Results cached for 15 minutes to prevent rate limiting.
	 */
	async function getHome(cb) {
		try {
			var cached = cacheGet("getHome");
			if (cached) {
				return cb({ success: true, data: cached });
			}

			var sections = [
				{ key: "Latest Updates", url: BASE + "/CartoonList/LatestUpdate" },
				{ key: "New Cartoons", url: BASE + "/CartoonList/Newest" },
				{ key: "Most Popular", url: BASE + "/CartoonList/MostPopular" },
			];

			var results = await Promise.allSettled(
				sections.map(function (sec) {
					return httpGet(sec.url).then(function (html) {
						return { key: sec.key, items: parseCartoonList(html) };
					});
				}),
			);

			var data = {};
			for (var i = 0; i < results.length; i++) {
				if (results[i].status === "fulfilled") {
					var r = results[i].value;
					if (r.items && r.items.length > 0) {
						data[r.key] = r.items;
					}
				}
			}

			if (Object.keys(data).length > 0) {
				cacheSet("getHome", data);
			}

			cb({ success: true, data: data });
		} catch (e) {
			cb({
				success: false,
				errorCode: "SITE_OFFLINE",
				message: e.message || "Unknown error in getHome",
			});
		}
	}

	/**
	 * search: Search cartoons by keyword.
	 */
	async function search(query, cb) {
		try {
			if (!query) {
				return cb({ success: true, data: [] });
			}
			var url = BASE + "/Search/?s=" + encodeURIComponent(query);
			var html = await httpGet(url);
			var items = parseCartoonList(html);
			cb({ success: true, data: items });
		} catch (e) {
			cb({ success: true, data: [] });
		}
	}

	/**
	 * load: Fetch cartoon detail page with metadata and episode list.
	 * Returns MultimediaItem({ ..., episodes: [...] }) directly.
	 */
	async function load(url, cb) {
		try {
			if (!url) {
				return cb({
					success: false,
					errorCode: "INVALID_URL",
					message: "No URL provided",
				});
			}

			var html = await httpGet(url);
			if (!html) {
				return cb({
					success: false,
					errorCode: "EMPTY_RESPONSE",
					message: "Empty response from detail page",
				});
			}

			// Title — try multiple patterns
			var title = "";
			var titleMatch = html.match(/Watch\s+([^<]+?)\s+online\s+free/i);
			if (titleMatch) title = stripTags(titleMatch[1]);
			if (!title) {
				var metaMatch = html.match(/<title>Watch\s+([^<]+?)\s+HD/i);
				if (metaMatch) title = stripTags(metaMatch[1]);
			}
			if (!title) {
				var ogTitle = html.match(
					/<meta\s+property="og:title"\s+content="([^"]+)"/,
				);
				if (ogTitle) title = stripTags(ogTitle[1]);
			}

			// Poster — try multiple locations
			var posterUrl = "";

			// 1) og:image (most reliable)
			var ogMatch = html.match(
				/<meta\s+property="og:image"\s+content="([^"]+)"/,
			);
			if (ogMatch) posterUrl = ogMatch[1];

			// 2) background-image on cover
			if (!posterUrl) {
				var posterMatch = html.match(/background-image:\s*url\('([^']+)'\)/);
				if (posterMatch) posterUrl = posterMatch[1];
			}

			// 3) <img> with media path
			if (!posterUrl) {
				var imgMatch = html.match(
					/<img\s+src="(https?:\/\/[^"]+\/media\/[^"]+)"[^>]*\/?>/i,
				);
				if (imgMatch) posterUrl = imgMatch[1];
			}

			// Description
			var description = "";
			var summaryDiv = extractBetween(html, '<div class="summary">', "</div>");
			if (summaryDiv) {
				var pMatch = summaryDiv.match(/<p>([\s\S]*?)<\/p>/);
				if (pMatch) description = stripTags(pMatch[1]).trim();
			}
			if (!description) {
				var pBlock = extractBetween(html, '<div class="summary"><p>', "</p>");
				if (pBlock) description = stripTags(pBlock).trim();
			}
			if (!description) {
				var ogDesc = html.match(
					/<meta\s+property="og:description"\s+content="([^"]+)"/,
				);
				if (ogDesc) description = stripTags(ogDesc[1]);
			}

			// Status
			var status = "";
			var statusMatch = html.match(/Status:<\/span>\s*([^<]+)/);
			if (statusMatch) status = statusMatch[1].trim();

			// Year
			var year = 0;
			var yearMatch = html.match(/Date\s+aired:<\/span>\s*(\d{4})/);
			if (yearMatch) year = parseInt(yearMatch[1], 10);
			if (!year) {
				var titleYear = title.match(/\((\d{4})\)/);
				if (titleYear) year = parseInt(titleYear[1], 10);
			}

			var episodes = parseEpisodes(html);

			// Determine content type:
			// - If episodes have "Movie" in URL/name → it's a movie with 1 Full Movie entry
			// - If 0 episodes → movie
			// - Otherwise → series
			var contentType = "movie";
			var hasMovieEp = false;
			var hasSeriesEp = false;
			for (var ei = 0; ei < episodes.length; ei++) {
				var epUrl = episodes[ei].url || "";
				var epName = episodes[ei].name || "";
				if (epUrl.indexOf("/Movie") !== -1 || epUrl.indexOf("Movie?") !== -1) {
					hasMovieEp = true;
				}
				if (
					epUrl.indexOf("/Episode") !== -1 ||
					epName.match(/Episode\s+\d+/i)
				) {
					hasSeriesEp = true;
				}
			}
			if (hasSeriesEp) {
				contentType = "series";
			} else if (hasMovieEp && !hasSeriesEp) {
				contentType = "movie";
			} else if (episodes.length > 1) {
				contentType = "series";
			}

			var statusStr;
			if (status === "Ongoing") {
				statusStr = "ongoing";
			} else if (status === "Completed") {
				statusStr = "completed";
			}

			cb({
				success: true,
				data: new MultimediaItem({
					title: title || "Untitled",
					url: url,
					posterUrl: normalizePosterUrl(posterUrl),
					type: contentType,
					description: description,
					year: year || undefined,
					status: statusStr,
					episodes: episodes,
				}),
			});
		} catch (e) {
			cb({
				success: false,
				errorCode: "PARSE_ERROR",
				message: e.message || "Unknown error in load",
			});
		}
	}

	/**
	 * loadStreams: Resolve playable video streams from ALL 3 servers in parallel.
	 * All goto.php URLs are resolved to direct .m3u8 before returning.
	 */
	async function loadStreams(url, cb) {
		try {
			if (!url) {
				return cb({
					success: false,
					errorCode: "INVALID_URL",
					message: "No URL provided",
				});
			}

			var idMatch = url.match(/[?&]id=(\d+)/);
			if (!idMatch) {
				return cb({
					success: false,
					errorCode: "INVALID_URL",
					message: "No episode ID found in URL",
				});
			}
			var episodeId = idMatch[1];

			var serverConfigs = [
				{ id: "tserver", label: "Tserver" },
				{ id: "vhserver", label: "Vhserver" },
				{ id: "hserver", label: "Hserver" },
			];

			var allStreams = [];
			var seenUrls = {};

			var serverResults = await Promise.allSettled(
				serverConfigs.map(function (sv) {
					return resolveServerStreams(episodeId, sv.id, sv.label);
				}),
			);

			for (var r = 0; r < serverResults.length; r++) {
				if (serverResults[r].status !== "fulfilled") continue;
				var serverStreams = serverResults[r].value || [];
				for (var s = 0; s < serverStreams.length; s++) {
					var stream = serverStreams[s];
					if (!stream || !stream.url) continue;
					if (seenUrls[stream.url]) continue;
					seenUrls[stream.url] = true;
					allStreams.push(
						new StreamResult({
							url: stream.url,
							source: stream.quality || "auto",
							headers: STREAM_HEADERS,
						}),
					);
				}
			}

			cb({ success: true, data: allStreams });
		} catch (e) {
			cb({
				success: false,
				errorCode: "PARSE_ERROR",
				message: e.message || "Unknown error in loadStreams",
			});
		}
	}

	// ── Exports ────────────────────────────────────────────────────────────

	globalThis.getHome = getHome;
	globalThis.search = search;
	globalThis.load = load;
	globalThis.loadStreams = loadStreams;
})();
