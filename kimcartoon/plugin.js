(function () {
	/**
	 * KimCartoon Plugin for SkyStream
	 * @type {import('@skystream/sdk').Manifest}
	 *
	 * Scrapes kimcartoon.si for cartoons with multi-server stream resolution.
	 * Servers: Tserver (mofl.pro HLS), Vhserver (vidhosters.com HLS), Hserver (hydrax/encrypted)
	 * ALL servers are queried in parallel and ALL playable links returned.
	 */

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

	// ── Helpers ────────────────────────────────────────────────────────────

	function extractAll(text, start, end) {
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
		var si = text.indexOf(start);
		if (si === -1) return "";
		var ei = text.indexOf(end, si + start.length);
		return ei === -1
			? text.substring(si + start.length)
			: text.substring(si + start.length, ei);
	}

	// ── HTTP helpers (SDK primitives only, like reference plugins) ─────────

	async function httpGet(url) {
		var res = await http_get(url, HEADERS);
		return res.body || "";
	}

	async function httpPostJson(url, body) {
		var res = await http_post(url, JSON_HEADERS, body);
		return JSON.parse(res.body);
	}

	async function httpGetJson(url) {
		var res = await http_get(url, JSON_HEADERS);
		return JSON.parse(res.body);
	}

	// ── HTML Parsers ───────────────────────────────────────────────────────

	function parseCartoonList(html) {
		var items = [];
		var blocks = extractAll(html, '<div class="item', "</div>");

		for (var i = 0; i < blocks.length; i++) {
			try {
				var block = blocks[i];

				var posterUrl = "";
				var bgMatch = block.match(/background-image:url\('([^']+)'\)/);
				if (bgMatch) posterUrl = bgMatch[1];

				if (!posterUrl) {
					var imgMatch = block.match(/<img\s+src="([^"]+)"\s*\/?>/);
					if (imgMatch) posterUrl = imgMatch[1];
				}

				var titleMatch = block.match(
					/<h2[^>]*class="title"[^>]*>([\s\S]*?)<\/h2>/,
				);
				var title = titleMatch
					? titleMatch[1].replace(/<[^>]+>/g, "").trim()
					: "";

				var urlMatch = block.match(/<a[^>]*class="thumb"[^>]*href="([^"]+)"/);
				var url = urlMatch ? urlMatch[1] : "";

				if (!title || !url) continue;

				items.push(
					new MultimediaItem({
						title: title,
						url: url.indexOf("http") === 0 ? url : BASE + url,
						posterUrl: posterUrl || "",
						type: block.indexOf("ep-bg") !== -1 ? "series" : "movie",
					}),
				);
			} catch (e) {}
		}
		return items;
	}

	function parseEpisodes(html) {
		var episodes = [];

		// Method 1: <select id="selectEpisode"> options
		var selectBlock = extractBetween(
			html,
			'<select id="selectEpisode"',
			"</select>",
		);
		if (selectBlock) {
			var options = extractAll(selectBlock, '<option value="', "</option>");
			for (var i = 0; i < options.length; i++) {
				var opt = options[i];
				var valEnd = opt.indexOf('"');
				if (valEnd === -1) continue;
				var epUrl = opt.substring(0, valEnd);
				var labelStart = opt.indexOf(">", valEnd);
				if (labelStart === -1) continue;
				var epName = opt.substring(labelStart + 1).trim();
				var episodeNum = i + 1;
				var numMatch = epName.match(/Episode\s*(\d+)/i);
				if (numMatch) episodeNum = parseInt(numMatch[1]);
				episodes.push(
					new Episode({
						name: epName,
						url: epUrl.indexOf("http") === 0 ? epUrl : BASE + epUrl,
						season: 1,
						episode: episodeNum,
					}),
				);
			}
		}

		// Method 2: <h3> episode links (fallback for detail pages)
		if (episodes.length === 0) {
			var h3blocks = extractAll(html, "<h3>", "</h3>");
			for (var j = 0; j < h3blocks.length; j++) {
				var h3 = h3blocks[j];
				var aStart = h3.indexOf('<a href="');
				if (aStart === -1) continue;
				var hrefStart = aStart + 9;
				var hrefEnd = h3.indexOf('"', hrefStart);
				if (hrefEnd === -1) continue;
				var epUrl = h3.substring(hrefStart, hrefEnd);
				var nameStart = h3.indexOf(">", hrefEnd) + 1;
				var epName = h3.substring(nameStart).replace(/<\/a>/, "").trim();
				var episodeNum2 = j + 1;
				var numMatch2 = epName.match(/Episode\s*(\d+)/i);
				if (numMatch2) episodeNum2 = parseInt(numMatch2[1]);
				episodes.push(
					new Episode({
						name: epName,
						url: epUrl.indexOf("http") === 0 ? epUrl : BASE + epUrl,
						season: 1,
						episode: episodeNum2,
					}),
				);
			}
		}

		return episodes;
	}

	/**
	 * Extract video sources from a JWPlayer embed page HTML.
	 * Resolves goto.php redirect URLs (vhserver) to actual .m3u8 links
	 * using axios if available in the sandbox.
	 */
	async function extractJWPlayerSources(html) {
		var streams = [];

		// Pattern 1: sources: [{ "file": "...", "label": "..." }]
		var srcMatch = html.match(/sources:\s*\[([\s\S]*?)\]/);
		if (srcMatch) {
			var blocks = extractAll(srcMatch[1], "{", "}");
			for (var i = 0; i < blocks.length; i++) {
				var fm = blocks[i].match(/["']file["']\s*:\s*["']([^"']+)["']/);
				var lm = blocks[i].match(/["']label["']\s*:\s*["']([^"']+)["']/);
				if (fm) {
					streams.push({
						url: fm[1],
						quality: lm ? lm[1] : "auto",
					});
				}
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

		// Resolve goto.php redirect URLs using axios (may not be available in all runtimes)
		for (var s = 0; s < streams.length; s++) {
			if (streams[s].url.indexOf("goto.php") !== -1) {
				try {
					var redirectResp = await axios.get(streams[s].url, {
						headers: {
							"User-Agent": USER_AGENT,
							Referer: BASE + "/",
						},
						maxRedirects: 0,
						validateStatus: function (status) {
							return status >= 200 && status < 400;
						},
					});
					if (redirectResp.headers && redirectResp.headers.location) {
						streams[s].url = redirectResp.headers.location;
					}
				} catch (_) {}
			}
		}

		return streams;
	}

	// ── Stream Resolver ───────────────────────────────────────────────────

	/**
	 * Resolve streams from a single server.
	 * Flow: POST load_episodes_v2 → get iframe embed → fetch iframe → extract JWPlayer sources.
	 */
	async function resolveServerStreams(episodeId, serverId, serverLabel) {
		var streams = [];

		try {
			var loadUrl = BASE + "/ajax/anime/load_episodes_v2?s=" + serverId;
			var loadData = await httpPostJson(loadUrl, "episode_id=" + episodeId);

			if (!loadData || !loadData.status) return streams;

			// --- Embed mode (value is HTML/iframe) ---
			if (loadData.embed) {
				var iframeMatch = loadData.value.match(/<iframe[^>]*src="([^"]+)"/);
				if (!iframeMatch) return streams;
				var iframeSrc = iframeMatch[1];
				if (iframeSrc.indexOf("http") !== 0) {
					iframeSrc = BASE + iframeSrc;
				}

				// Try loadExtractor for known video hosts (MixDrop, StreamTape, Hydrax, etc.)
				try {
					var extracted = await loadExtractor(iframeSrc);
					if (extracted && extracted.length > 0) {
						for (var e = 0; e < extracted.length; e++) {
							streams.push({
								url: extracted[e].url,
								quality: serverLabel + " - " + (extracted[e].quality || ""),
							});
						}
						return streams;
					}
				} catch (_) {}

				// Fallback: fetch iframe page and parse JWPlayer sources
				try {
					var playerHtml = await httpGet(iframeSrc);
					var sources = await extractJWPlayerSources(playerHtml);
					for (var i = 0; i < sources.length; i++) {
						sources[i].quality =
							serverLabel +
							(sources[i].quality !== "auto" ? " - " + sources[i].quality : "");
						streams.push(sources[i]);
					}
				} catch (_) {}

				return streams;
			}

			// --- Non-embed mode (value is JSON URL) ---
			if (loadData.value) {
				var valueUrl = loadData.value;
				if (valueUrl.indexOf("http") !== 0) {
					valueUrl = BASE + valueUrl;
				}

				try {
					var sourcesData = await httpGetJson(valueUrl);
					if (sourcesData.playlist && sourcesData.playlist.length > 0) {
						var pl = sourcesData.playlist[0];
						if (pl.sources && pl.sources.length > 0) {
							for (var q = 0; q < pl.sources.length; q++) {
								streams.push({
									url: pl.sources[q].file,
									quality:
										serverLabel +
										" - " +
										(pl.sources[q].label ? pl.sources[q].label + "p" : "auto"),
								});
							}
						} else if (pl.file) {
							streams.push({
								url: pl.file,
								quality: serverLabel,
							});
						}
					}
				} catch (_) {}
			}
		} catch (_) {}

		return streams;
	}

	// ── Core Plugin Functions ──────────────────────────────────────────────

	/**
	 * getHome: Returns categories from the site.
	 * Uses sequential fetching with per-category try/catch,
	 * matching the pattern used by reference SkyStream plugins (YTS, etc.).
	 */
	async function getHome(cb) {
		try {
			var sections = [
				{ key: "Latest Updates", url: BASE + "/CartoonList/LatestUpdate" },
				{ key: "New Cartoons", url: BASE + "/CartoonList/Newest" },
				{ key: "Most Popular", url: BASE + "/CartoonList/MostPopular" },
			];

			var data = {};
			for (var i = 0; i < sections.length; i++) {
				try {
					var html = await httpGet(sections[i].url);
					var items = parseCartoonList(html);
					if (items.length > 0) {
						data[sections[i].key] = items;
					}
				} catch (_) {}
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
			var url = BASE + "/Search/?s=" + encodeURIComponent(query);
			var html = await httpGet(url);
			var items = parseCartoonList(html);
			cb({ success: true, data: items });
		} catch (e) {
			cb({
				success: false,
				errorCode: "PARSE_ERROR",
				message: e.message || "Unknown error in search",
			});
		}
	}

	/**
	 * load: Fetch cartoon detail page with metadata and episode list.
	 */
	async function load(url, cb) {
		try {
			var html = await httpGet(url);

			// Title from heading
			var title = "";
			var titleMatch = html.match(/Watch\s+([^<]+?)\s+online\s+free/i);
			if (titleMatch) title = titleMatch[1].trim();
			if (!title) {
				var metaMatch = html.match(/<title>Watch\s+([^<]+?)\s+HD/i);
				if (metaMatch) title = metaMatch[1].trim();
			}

			// Poster
			var posterUrl = "";
			var posterMatch = html.match(/background-image:url\('([^']+)'\)/);
			if (posterMatch) posterUrl = posterMatch[1];

			// Description
			var description = "";
			var descMatch = html.match(/Summary:<\/strong>\s*([^<]+)</);
			if (descMatch) description = descMatch[1].trim();
			if (!description) {
				var ogDesc = html.match(
					/<meta\s+property="og:description"\s+content="([^"]+)"/,
				);
				if (ogDesc) description = ogDesc[1];
			}

			// Status
			var status = "";
			var statusMatch = html.match(/Status:<\/strong>\s*([^<]+)</);
			if (statusMatch) status = statusMatch[1].trim();

			// Year
			var year = 0;
			var yearMatch = title.match(/\((\d{4})\)/);
			if (yearMatch) year = parseInt(yearMatch[1]);
			if (!year) {
				var dateMatch = html.match(/Date aired:\s*(\d{4})/);
				if (dateMatch) year = parseInt(dateMatch[1]);
			}

			var episodes = parseEpisodes(html);
			var contentType = episodes.length > 0 ? "series" : "movie";

			cb({
				success: true,
				data: {
					item: new MultimediaItem({
						title: title,
						url: url,
						posterUrl: posterUrl || "",
						type: contentType,
						description: description,
						year: year || undefined,
						status:
							status === "Ongoing"
								? "ongoing"
								: status === "Completed"
									? "completed"
									: undefined,
					}),
					episodes: episodes,
				},
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
	 *
	 * Queries: tserver, vhserver, hserver simultaneously.
	 * For each: POST → get iframe → fetch iframe → extract HLS URLs from JWPlayer.
	 * Returns ALL unique playable links across all servers.
	 */
	async function loadStreams(url, cb) {
		try {
			var idMatch = url.match(/[?&]id=(\d+)/);
			if (!idMatch) {
				return cb({
					success: false,
					errorCode: "INVALID_URL",
					message: "No episode ID found in URL",
				});
			}
			var episodeId = idMatch[1];

			// All 3 servers queried in parallel
			var serverConfigs = [
				{ id: "tserver", label: "Tserver" },
				{ id: "vhserver", label: "Vhserver" },
				{ id: "hserver", label: "Hserver" },
			];

			var allStreams = [];
			var seenUrls = {};

			// Query all servers in parallel
			var serverResults = await Promise.allSettled(
				serverConfigs.map(function (sv) {
					return resolveServerStreams(episodeId, sv.id, sv.label);
				}),
			);

			// Collect all unique streams
			for (var r = 0; r < serverResults.length; r++) {
				if (serverResults[r].status !== "fulfilled") continue;
				var serverStreams = serverResults[r].value || [];
				for (var s = 0; s < serverStreams.length; s++) {
					var stream = serverStreams[s];
					if (!stream.url || seenUrls[stream.url]) continue;
					seenUrls[stream.url] = true;
					allStreams.push(
						new StreamResult({
							url: stream.url,
							quality: stream.quality || "auto",
							headers: { Referer: BASE + "/" },
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
