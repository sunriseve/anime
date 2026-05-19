(function() {
    "use strict";

    // ========================================================================
    // CONSTANTS
    // ========================================================================
    const ANILIST_API = "https://graphql.anilist.co";
    const ALLANIME_API = "https://api.allanime.day";
    const ALLANIME_CDN = "https://allanime.uns.bio";
    const ALLANIME_WEB = "https://allanime.day";
    const ANIMESALT_BASE = (manifest && manifest.domains && manifest.domains[2])
        ? manifest.domains[2].url : "https://animesalt.ac";
    const ANI_ZIP_API = "https://api.ani.zip";

    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
    const HEADERS = {
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9"
    };
    const ANILIST_HEADERS = { "Content-Type": "application/json", "Accept": "application/json" };
    const ALLANIME_HEADERS = {
        "User-Agent": UA,
        "app-version": "android_c-247",
        "from-app": "allmanga",
        "platformstr": "android_c",
        "Referer": "https://allmanga.to"
    };

    // AllAnime GraphQL persisted query SHA256 hashes (from Anichi plugin)
    const HASHES = {
        mainPage: "a24c500a1b765c68ae1d8dd85174931f661c71369c89b92b88b75a725afc471c",
        popular: "60f50b84bb545fa25ee7f7c8c0adbf8f5cea40f7b1ef8501cbbff70e38589489",
        detail: "bb263f91e5bdd048c1c978f324613aeccdfe2cbc694a419466a31edb58c0cc0b",
        server: "d405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec"
    };

    // Quality detection patterns
    var QUALITY_RULES = [
        { re: /2160|4k|uhd/i, label: 2160 },
        { re: /1440|2k/i, label: 1440 },
        { re: /1080|fhd/i, label: 1080 },
        { re: /720|hd/i, label: 720 },
        { re: /480|sd/i, label: 480 },
        { re: /360/i, label: 360 }
    ];

    // Season mapping
    var SEASON_MAP = {
        1: "WINTER", 2: "WINTER", 3: "WINTER",
        4: "SPRING", 5: "SPRING", 6: "SPRING",
        7: "SUMMER", 8: "SUMMER", 9: "SUMMER",
        10: "FALL", 11: "FALL", 12: "FALL"
    };

    // ========================================================================
    // BASE HELPERS
    // ========================================================================

    function safeJson(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try { return JSON.parse(data); } catch (e) { return null; }
    }

    function safeGet(url, headers) {
        try { return http_get(url, headers || HEADERS); } catch (e) { return null; }
    }

    async function getText(url, headers) {
        try {
            var res = await http_get(url, headers || HEADERS);
            return res && res.body ? String(res.body) : "";
        } catch (e) {
            return "";
        }
    }

    async function getTextWithTimeout(url, headers, ms) {
        var timedOut = false;
        var timer = setTimeout(function() { timedOut = true; }, ms || 8000);
        try {
            var res = await http_get(url, headers || HEADERS);
            clearTimeout(timer);
            if (timedOut) return "";
            return res && res.body ? String(res.body) : "";
        } catch (e) {
            clearTimeout(timer);
            return "";
        }
    }

    async function postJson(url, headers, data) {
        try {
            var res = await http_post(url, headers || ANILIST_HEADERS, JSON.stringify(data));
            if (res && res.body) return safeJson(res.body);
            return null;
        } catch (_) {
            try {
                var res2 = await http_post(url, JSON.stringify(data), headers || ANILIST_HEADERS);
                if (res2 && res2.body) return safeJson(res2.body);
            } catch (e2) {}
            return null;
        }
    }

    async function postForm(url, headers, body) {
        try {
            var res = await http_post(url, headers, body);
            return res && res.body ? String(res.body) : "";
        } catch (_) {
            try {
                var res2 = await http_post(url, body, headers);
                return res2 && res2.body ? String(res2.body) : "";
            } catch (e2) {
                return "";
            }
        }
    }

    function fixUrl(raw, base) {
        if (!raw) return "";
        var url = String(raw).trim();
        if (!url || url.startsWith("data:")) return "";
        if (url.startsWith("//")) return "https:" + url;
        if (/^https?:\/\//i.test(url)) return url;
        try { return new URL(url, base || ANILIST_API).href; } catch (e) { return url; }
    }

    function getHost(url) {
        try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
    }

    function detectQuality(text) {
        if (!text) return 0;
        var str = String(text);
        for (var i = 0; i < QUALITY_RULES.length; i++) {
            if (QUALITY_RULES[i].re.test(str)) return QUALITY_RULES[i].label;
        }
        return 0;
    }

    function streamLabel(source, quality, lang) {
        var parts = [source];
        if (lang) parts.push("[" + lang.toUpperCase() + "]");
        if (quality) parts.push("" + quality + "p");
        return parts.join(" ");
    }

    function encodeBase64(str) {
        try { return btoa(str); } catch (_) {
            try { if (typeof Buffer !== "undefined") return Buffer.from(str, "binary").toString("base64"); } catch (e2) {}
            return "";
        }
    }

    function textContent(value) {
        return (value == null ? "" : String(value)).replace(/\s+/g, " ").trim();
    }

    function qsa(root, selector) {
        try { return Array.from(root.querySelectorAll(selector)); } catch (e) { return []; }
    }

    function qs(root, selector) {
        try { return root.querySelector(selector); } catch (e) { return null; }
    }

    function attr(el, names) {
        if (!el) return "";
        for (var i = 0; i < names.length; i++) {
            var value = el.getAttribute(names[i]);
            if (value && !String(value).startsWith("data:image")) return String(value).trim();
        }
        return "";
    }

    function getImageSrc(img, base) {
        return fixUrl(attr(img, ["data-src", "data-lazy-src", "data-original", "src"]), base);
    }

    function proxifyV1(url) {
        return "MAGIC_PROXY_v1" + encodeBase64(String(url || ""));
    }

    // ========================================================================
    // ANILIST GRAPHQL HELPERS
    // ========================================================================

    var MEDIA_FRAGMENT = `
    fragment mediaFields on Media {
      id idMal
      title { romaji english native userPreferred }
      type format status(version: 2)
      description
      startDate { year month day }
      endDate { year month day }
      season seasonYear
      episodes duration
      countryOfOrigin
      coverImage { extraLarge large medium color }
      bannerImage
      genres
      averageScore meanScore popularity trending favourites
      trailer { id site thumbnail }
      studios(isMain: true) { edges { node { id name } } }
      nextAiringEpisode { airingAt timeUntilAiring episode }
      siteUrl
      rankings { rank type format year context allTime }
      externalLinks { url site }
      streamingEpisodes { title site url }
    }`;

    async function queryAnilist(query, variables) {
        var data = await postJson(ANILIST_API, ANILIST_HEADERS, { query: query, variables: variables || {} });
        if (data && data.errors) {
            console.error("AniList Error:", JSON.stringify(data.errors));
            return null;
        }
        return data;
    }

    function anilistMediaToItem(media) {
        if (!media) return null;
        var title = (media.title && (media.title.userPreferred || media.title.english || media.title.romaji)) || "Unknown";
        var poster = media.coverImage && (media.coverImage.extraLarge || media.coverImage.large || media.coverImage.medium);
        var year = media.startDate && media.startDate.year;
        var type = media.format === "MOVIE" ? "movie" : "anime";
        var score = media.averageScore ? media.averageScore / 10 : undefined;
        var status = media.status === "RELEASING" ? "ongoing" : (media.status === "FINISHED" ? "completed" : "upcoming");

        return new MultimediaItem({
            title: title,
            url: buildMediaPayload(media.id, media.idMal, title, poster, type),
            posterUrl: poster || "",
            type: type,
            year: year,
            score: score,
            status: status,
            description: media.description ? media.description.replace(/<[^>]*>/g, "") : undefined,
            genres: media.genres || [],
            bannerUrl: media.bannerImage || undefined
        });
    }

    function buildMediaPayload(anilistId, malId, title, poster, type) {
        return JSON.stringify({
            type: "anime",
            anilistId: anilistId,
            malId: malId || 0,
            title: title || "",
            poster: poster || "",
            mediaType: type || "anime"
        });
    }

function buildEpisodePayload(anilistId, malId, episode, dubStatus, allanimeHash) {
    return JSON.stringify({
        type: "episode",
        anilistId: anilistId,
        malId: malId || 0,
        episode: episode,
        dubStatus: dubStatus || "sub",
        allanimeHash: allanimeHash || ""
    });
}

    function parsePayload(str) {
        var data = safeJson(str);
        if (data && data.type) return data;
        if (data && data.url) return data;
        return { type: "raw", url: String(str || "") };
    }

    // ========================================================================
    // ANILIST ADAPTER — getHome
    // ========================================================================

    var HOME_QUERY = `
    query ($season: MediaSeason, $seasonYear: Int, $nextSeason: MediaSeason, $nextYear: Int, $perPage: Int) {
      trending: Page(page: 1, perPage: $perPage) {
        media(sort: TRENDING_DESC, type: ANIME, isAdult: false) { ...mediaFields }
      }
      popular: Page(page: 1, perPage: $perPage) {
        media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) { ...mediaFields }
      }
      season: Page(page: 1, perPage: $perPage) {
        media(season: $season, seasonYear: $seasonYear, sort: POPULARITY_DESC, type: ANIME, isAdult: false) { ...mediaFields }
      }
      topRated: Page(page: 1, perPage: $perPage) {
        media(sort: SCORE_DESC, type: ANIME, isAdult: false) { ...mediaFields }
      }
      upcoming: Page(page: 1, perPage: $perPage) {
        media(season: $nextSeason, seasonYear: $nextYear, sort: POPULARITY_DESC, type: ANIME, isAdult: false) { ...mediaFields }
      }
    }
    ${MEDIA_FRAGMENT}`;

    function getNextSeason(month) {
        if (month >= 1 && month <= 3) return { season: "SPRING", year: new Date().getFullYear() };
        if (month >= 4 && month <= 6) return { season: "SUMMER", year: new Date().getFullYear() };
        if (month >= 7 && month <= 9) return { season: "FALL", year: new Date().getFullYear() };
        return { season: "WINTER", year: new Date().getFullYear() + 1 };
    }

    async function getHomeFromAnilist() {
        var now = new Date();
        var month = now.getMonth() + 1;
        var year = now.getFullYear();
        var season = SEASON_MAP[month] || "SPRING";
        var next = getNextSeason(month);

        var result = await queryAnilist(HOME_QUERY, {
            season: season,
            seasonYear: year,
            nextSeason: next.season,
            nextYear: next.year,
            perPage: 20
        });
        if (!result || !result.data) return {};

        var data = {};
        var categories = {
            "Trending": result.data.trending,
            "Popular": result.data.popular,
            "Seasonal": result.data.season,
            "Top Rated": result.data.topRated,
            "Upcoming": result.data.upcoming
        };

        for (var key in categories) {
            if (!categories[key] || !categories[key].media) continue;
            var items = categories[key].media.map(function(m) { return anilistMediaToItem(m); }).filter(Boolean);
            if (items.length > 0) data[key] = items;
        }

        return data;
    }

    // ========================================================================
    // ANILIST ADAPTER — search
    // ========================================================================

    var SEARCH_QUERY = `
    query ($search: String, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(search: $search, type: ANIME, isAdult: false) { ...mediaFields }
      }
    }
    ${MEDIA_FRAGMENT}`;

    async function searchFromAnilist(query) {
        if (!query || !String(query).trim()) return [];
        var result = await queryAnilist(SEARCH_QUERY, { search: String(query).trim(), perPage: 25 });
        if (!result || !result.data || !result.data.Page || !result.data.Page.media) return [];
        return result.data.Page.media.map(function(m) { return anilistMediaToItem(m); }).filter(Boolean);
    }

    // ========================================================================
    // ANILIST + ANI.ZIP ADAPTER — load
    // ========================================================================

    var LOAD_QUERY = `
    query ($id: Int) {
      Media(id: $id) {
        ...mediaFields
        characters(page: 1, perPage: 20) {
          edges { role node { id name { full } image { medium } } }
        }
        recommendations(page: 1, perPage: 12) {
          edges { node { mediaRecommendation { id title { romaji english } coverImage { large } } } }
        }
        relations { edges { node { id title { romaji } type format status } relationType } }
      }
    }
    ${MEDIA_FRAGMENT}`;

    async function loadFromAnilist(payload) {
        var info = parsePayload(payload);
        var anilistId = parseInt(info.anilistId || info.url || 0, 10);
        if (!anilistId) return null;

        // Fetch anime metadata from AniList
        var result = await queryAnilist(LOAD_QUERY, { id: anilistId });
        if (!result || !result.data || !result.data.Media) return null;

        var media = result.data.Media;
        var malId = media.idMal || info.malId || 0;

        // Fetch ani.zip for episode metadata in parallel (with timeout, optional)
        var aniZipData = null;
        if (malId) {
            var aniZipUrl = ANI_ZIP_API + "/mappings?mal_id=" + malId;
            var aniZipRes = await getTextWithTimeout(aniZipUrl, HEADERS, 5000);
            aniZipData = safeJson(aniZipRes);
        }

        // Search AllAnime for the show's hash (for later stream resolution)
        var allanimeShowHash = "";
        try {
            var allanimeSearchRes = await getTextWithTimeout(
                ALLANIME_API + "?" + allanimeEncode({
                    search: { query: title },
                    limit: 8,
                    page: 1,
                    translationType: "sub",
                    countryOrigin: "ALL"
                }, HASHES.mainPage),
                ALLANIME_HEADERS, 6000
            );
            var allanimeData = safeJson(allanimeSearchRes);
            if (allanimeData && allanimeData.data && allanimeData.data.shows && allanimeData.data.shows.edges) {
                var edges = allanimeData.data.shows.edges;
                if (edges.length > 0) {
                    allanimeShowHash = edges[0]._id || "";
                }
            }
        } catch (_) {
            // AllAnime search is optional; continue without hash
        }

        var title = (media.title && (media.title.userPreferred || media.title.english || media.title.romaji)) || "Unknown";
        var poster = media.coverImage && (media.coverImage.extraLarge || media.coverImage.large || media.coverImage.medium) || "";
        var banner = media.bannerImage || "";
        var year = media.startDate && media.startDate.year;
        var type = media.format === "MOVIE" ? "movie" : "anime";
        var score = media.averageScore ? media.averageScore / 10 : undefined;
        var desc = media.description ? media.description.replace(/<[^>]*>/g, "") : undefined;

        // Build episodes
        var episodes = [];
        var epCount = Math.min(media.episodes || 12, 100); // Cap at 100 to prevent timeout

        // Try ani.zip for rich episode data (optional, may fail)
        var aniEps = {};
        if (aniZipData && aniZipData.episodes) {
            aniEps = aniZipData.episodes;
        }

        if (type === "movie") {
            // Movies: single episode
            episodes.push(new Episode({
                name: title,
                url: buildEpisodePayload(anilistId, malId, 1, "sub", allanimeShowHash),
                season: 1,
                episode: 1,
                posterUrl: poster,
                runtime: media.duration || undefined,
                dubStatus: "sub"
            }));
            // Also add dub option
            episodes.push(new Episode({
                name: title + " (Dub)",
                url: buildEpisodePayload(anilistId, malId, 1, "dub", allanimeShowHash),
                season: 1,
                episode: 1,
                posterUrl: poster,
                runtime: media.duration || undefined,
                dubStatus: "dub"
            }));
        } else {
            // Series: one episode per number
            for (var i = 1; i <= epCount; i++) {
                var aniEp = aniEps[String(i)];
                var epTitle = "Episode " + i;
                if (aniEp && aniEp.title) {
                    epTitle = aniEp.title.en || aniEp.title["x-jat"] || aniEp.title.ja || epTitle;
                }
                episodes.push(new Episode({
                    name: epTitle,
                    url: buildEpisodePayload(anilistId, malId, i, "sub", allanimeShowHash),
                    season: 1,
                    episode: i,
                    description: aniEp && aniEp.overview ? aniEp.overview : undefined,
                    posterUrl: aniEp && aniEp.image ? fixUrl(aniEp.image) : poster,
                    runtime: aniEp && aniEp.runtime ? aniEp.runtime : (media.duration || undefined),
                    airDate: aniEp && aniEp.airDate ? aniEp.airDate : undefined,
                    dubStatus: "sub"
                }));
                // Dub episode
                episodes.push(new Episode({
                    name: epTitle + " (Dub)",
                    url: buildEpisodePayload(anilistId, malId, i, "dub", allanimeShowHash),
                    season: 1,
                    episode: i,
                    description: aniEp && aniEp.overview ? aniEp.overview : undefined,
                    posterUrl: aniEp && aniEp.image ? fixUrl(aniEp.image) : poster,
                    runtime: aniEp && aniEp.runtime ? aniEp.runtime : (media.duration || undefined),
                    airDate: aniEp && aniEp.airDate ? aniEp.airDate : undefined,
                    dubStatus: "dub"
                }));
            }
        }

        // Build recommendations
        var recommendations = [];
        if (media.recommendations && media.recommendations.edges) {
            recommendations = media.recommendations.edges.map(function(edge) {
                var rec = edge.node && edge.node.mediaRecommendation;
                if (!rec) return null;
                var recTitle = (rec.title && (rec.title.english || rec.title.romaji)) || "Unknown";
                var recPoster = rec.coverImage && rec.coverImage.large;
                return new MultimediaItem({
                    title: recTitle,
                    url: buildMediaPayload(rec.id, 0, recTitle, recPoster || "", "anime"),
                    posterUrl: recPoster || "",
                    type: "anime"
                });
            }).filter(Boolean);
        }

        // Build cast
        var cast = [];
        if (media.characters && media.characters.edges) {
            cast = media.characters.edges.map(function(edge) {
                var node = edge.node;
                if (!node) return null;
                return new Actor({
                    name: node.name && (node.name.full || node.name.native) || "Unknown",
                    role: edge.role || "Supporting",
                    image: node.image && node.image.medium || undefined
                });
            }).filter(Boolean);
        }

        // Build trailers
        var trailers = [];
        if (media.trailer && media.trailer.id && media.trailer.site === "youtube") {
            trailers.push(new Trailer({
                name: "Trailer",
                url: "https://www.youtube.com/watch?v=" + media.trailer.id
            }));
        }

        return new MultimediaItem({
            title: title,
            url: buildMediaPayload(anilistId, malId, title, poster, type),
            posterUrl: poster,
            bannerUrl: banner || undefined,
            type: type,
            description: desc,
            year: year,
            score: score,
            status: media.status === "RELEASING" ? "ongoing" : (media.status === "FINISHED" ? "completed" : undefined),
            genres: media.genres || undefined,
            episodes: episodes,
            cast: cast.length > 0 ? cast : undefined,
            trailers: trailers.length > 0 ? trailers : undefined,
            recommendations: recommendations.length > 0 ? recommendations : undefined
        });
    }

    // ========================================================================
    // ALLANIME STREAM ADAPTER
    // ========================================================================

    // AllAnime GraphQL helpers
    function allanimeEncode(variables, hash) {
        return "variables=" + encodeURIComponent(JSON.stringify(variables || {}))
            + "&extensions=" + encodeURIComponent(JSON.stringify({
                persistedQuery: { version: 1, sha256Hash: hash }
            }));
    }

    async function allanimeQuery(variables, hash) {
        var url = ALLANIME_API + "?" + allanimeEncode(variables, hash);
        try {
            var text = await getTextWithTimeout(url, ALLANIME_HEADERS, 8000);
            if (!text || text.trim().startsWith("<") || text.trim() === "") return null;
            return safeJson(text);
        } catch (e) {
            return null;
        }
    }

    function allanimePrefTitle(show) {
        if (!show) return "Unknown";
        return show.englishName || show.name || show.nativeName || "Unknown";
    }

    function allanimeDecryptHex(hex) {
        if (!hex) return "";
        var clean = hex;
        if (clean.startsWith("--")) clean = clean.slice(2);
        if (clean.startsWith("-")) clean = clean.split("-").pop();
        var out = "";
        for (var i = 0; i < clean.length; i += 2) {
            var byte = parseInt(clean.substring(i, i + 2), 16);
            out += String.fromCharCode(byte ^ 56);
        }
        return out;
    }

    function allanimeGetHost(url) {
        try {
            var host = new URL(url.startsWith("//") ? "https:" + url : url).hostname;
            var parts = host.split(".");
            return parts.length >= 2 ? parts[parts.length - 2] : host;
        } catch (_) { return "source"; }
    }

    async function allanimeSearchByTitle(title) {
        var variables = {
            search: { query: title },
            limit: 10,
            page: 1,
            translationType: "sub",
            countryOrigin: "ALL"
        };
        var result = await allanimeQuery(variables, HASHES.mainPage);
        if (!result || !result.data || !result.data.shows || !result.data.shows.edges) return null;
        return result.data.shows.edges;
    }

    async function allanimeResolveStreams(anilistId, episode, dubStatus, allanimeHash, titleFallback) {
        var showId = allanimeHash || "";

        // If we don't have a hash, try to search AllAnime by title
        if (!showId && titleFallback) {
            try {
                var searchRes = await allanimeQuery({
                    search: { query: titleFallback },
                    limit: 8,
                    page: 1,
                    translationType: "sub",
                    countryOrigin: "ALL"
                }, HASHES.mainPage);
                if (searchRes && searchRes.data && searchRes.data.shows && searchRes.data.shows.edges && searchRes.data.shows.edges.length > 0) {
                    showId = searchRes.data.shows.edges[0]._id || "";
                }
            } catch (_) {}
        }

        // If still no hash, try looking up by AniList ID via detail endpoint
        if (!showId) {
            try {
                var detailRes = await allanimeQuery({ _id: "?anilistId=" + anilistId }, HASHES.detail);
                if (detailRes && detailRes.data && detailRes.data.show) {
                    showId = detailRes.data.show._id || "";
                }
            } catch (_) {}
        }

        if (!showId) return [];

        // Get episode server sources
        var transType = dubStatus === "dub" ? "dub" : "sub";
        var serverVars = {
            showId: showId,
            translationType: transType,
            episodeString: String(episode)
        };
        var serverResult = await allanimeQuery(serverVars, HASHES.server);
        if (!serverResult || !serverResult.data || !serverResult.data.episode) return [];

        var sources = serverResult.data.episode.sourceUrls || [];
        var streams = [];

        for (var si = 0; si < sources.length; si++) {
            var src = sources[si];
            if (!src || !src.sourceUrl) continue;

            var rawLink = src.sourceUrl;
            var link = rawLink.startsWith("--") || rawLink.startsWith("-")
                ? allanimeDecryptHex(rawLink)
                : rawLink;

            if (!link) continue;

            var sourceName = src.sourceName || allanimeGetHost(link);
            var langTag = dubStatus === "dub" ? "dub" : "sub";

            // If it's a relative path, fetch the JSON to get actual URLs
            if (!/^https?:\/\//i.test(link) && !link.startsWith("//")) {
                var jsonUrl = fixUrl(link, ALLANIME_WEB);
                var jsonText = await getTextWithTimeout(jsonUrl, ALLANIME_HEADERS, 5000);
                var jsonData = safeJson(jsonText);
                if (jsonData && jsonData.links) {
                    for (var li = 0; li < jsonData.links.length; li++) {
                        var l = jsonData.links[li];
                        if (!l || !l.link) continue;
                        var streamUrl = fixUrl(l.link);
                        if (!streamUrl) continue;
                        var quality = detectQuality(l.resolutionStr || l.link);
                        streams.push(new StreamResult({
                            url: streamUrl,
                            source: streamLabel("AllAnime", quality, langTag),
                            quality: quality || undefined,
                            headers: { "User-Agent": UA, "Referer": ALLANIME_WEB + "/" }
                        }));
                    }
                }
                continue;
            }

            // Direct URL
            var fixedLink = link.startsWith("//") ? "https:" + link : link;
            var quality = detectQuality(fixedLink);
            streams.push(new StreamResult({
                url: fixedLink,
                source: streamLabel("AllAnime", quality || 720, langTag),
                quality: quality || undefined,
                headers: { "User-Agent": UA, "Referer": ALLANIME_WEB + "/" }
            }));
        }

        return streams;
    }

    async function animesaltResolveStreamsFallback(title, episode, dubStatus) {
        // Search Animesalt for show page and extract iframes
        try {
            var searchHtml = await animesaltSearchShow(title);
            if (!searchHtml) return [];
            var doc;
            try { doc = await parseHtml(searchHtml); } catch (e) { return []; }
            if (!doc) return [];

            var articles = qsa(doc, "article");
            if (articles.length === 0) return [];

            // Get the first match's URL
            var link = qs(articles[0], "a");
            var showUrl = fixUrl(attr(link, ["href"]));
            if (!showUrl) return [];

            return await animesaltResolveStreams(showUrl, episode, dubStatus);
        } catch (e) {
            return [];
        }
    }

    // ========================================================================
    // ANIMESALT STREAM ADAPTER
    // ========================================================================

    async function animesaltSearchShow(title) {
        var searchBody = [
            "action=torofilm_infinite_scroll",
            "page=1",
            "per_page=5",
            "query_type=search",
            "query_args[s]=" + encodeURIComponent(title)
        ].join("&");

        var html = await postForm(ANIMESALT_BASE + "/wp-admin/admin-ajax.php", {
            "User-Agent": UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": ANIMESALT_BASE + "/"
        }, searchBody);

        if (!html) return null;
        var json = safeJson(html);
        var content = json && json.data && json.data.content ? json.data.content : html;
        return content;
    }

    async function animesaltGetEpisodeUrl(showUrl, episode) {
        // Fetch the anime page to find episode links
        var html = await getText(showUrl, {
            "User-Agent": UA,
            "Accept": "text/html",
            "Referer": ANIMESALT_BASE + "/"
        });
        if (!html) return null;

        var doc;
        try { doc = await parseHtml(html); } catch (e) { return null; }
        if (!doc) return null;

        // Try to find the specific episode link
        var epLinks = qsa(doc, "ul.episodes a, .episodios a, .episode-card a, a[href*='episode']");
        for (var i = 0; i < epLinks.length; i++) {
            var href = fixUrl(attr(epLinks[i], ["href"]), showUrl);
            var epMatch = href.match(/episode[-\/](\d+)/i);
            if (epMatch && parseInt(epMatch[1], 10) === episode) return href;
        }

        // Fallback: return the first episode link
        if (epLinks.length > 0) return fixUrl(attr(epLinks[0], ["href"]), showUrl);
        return null;
    }

    async function animesaltResolveStreams(showUrl, episode, dubStatus) {
        try {
            // Find the episode URL
            var epUrl = await animesaltGetEpisodeUrl(showUrl, episode);
            if (!epUrl) return [];

            // Fetch the episode page
            var html = await getText(epUrl, {
                "User-Agent": UA,
                "Referer": ANIMESALT_BASE + "/"
            });
            if (!html) return [];

            var doc;
            try { doc = await parseHtml(html); } catch (e) { return []; }
            if (!doc) return [];

            // Find iframes / video sources
            var iframes = qsa(doc, "#options-0 iframe, .video-options iframe, iframe");
            var streams = [];

            for (var i = 0; i < iframes.length; i++) {
                var src = fixUrl(attr(iframes[i], ["data-src", "src"]), epUrl);
                if (!src || src === epUrl) continue;

                var langTag = dubStatus === "dub" ? "dub" : "sub";
                var quality = detectQuality(src);

                // Try the built-in extractor first
                if (typeof loadExtractor === "function") {
                    try {
                        var extracted = loadExtractor(src);
                        if (extracted) {
                            var extResult = await extracted;
                            for (var ei = 0; ei < extResult.length; ei++) {
                                extResult[ei].source = streamLabel("Animesalt", extResult[ei].quality || quality, langTag);
                                streams.push(extResult[ei]);
                            }
                            continue;
                        }
                    } catch (_) {}
                }

                // Direct URL fallback
                if (/\.(m3u8|mp4)(\?|$)/i.test(src)) {
                    streams.push(new StreamResult({
                        url: src,
                        source: streamLabel("Animesalt", quality || 720, langTag),
                        quality: quality || undefined,
                        headers: { "User-Agent": UA, "Referer": ANIMESALT_BASE + "/" }
                    }));
                } else {
                    streams.push(new StreamResult({
                        url: src,
                        source: streamLabel("Animesalt", quality || 0, langTag),
                        quality: quality || undefined,
                        headers: { "User-Agent": UA, "Referer": ANIMESALT_BASE + "/" }
                    }));
                }
            }

            return streams;
        } catch (e) {
            return [];
        }
    }

    // ========================================================================
    // GOGOANIME STREAM ADAPTER
    // ========================================================================

    // Gogoanime mirror domains to try
    var GOGO_DOMAINS = [
        "https://gogoanime.biz",
        "https://gogoanime.cl",
        "https://anitaku.bz",
        "https://gogoanimehd.io"
    ];
    var GOGO_AJAX_DOMAIN = "https://ajax.gogoanime.biz";

    async function gogoSearchAnime(title) {
        for (var di = 0; di < GOGO_DOMAINS.length; di++) {
            try {
                var url = GOGO_DOMAINS[di] + "/search.html?keyword=" + encodeURIComponent(title);
                var html = await getTextWithTimeout(url, { "User-Agent": UA }, 5000);
                if (!html) continue;
                var doc;
                try { doc = await parseHtml(html); } catch (e) { continue; }
                if (!doc) continue;

                var items = qsa(doc, "ul.items li a, .last_episode a, .ss a");
                for (var ii = 0; ii < items.length; ii++) {
                    var href = fixUrl(attr(items[ii], ["href"]), GOGO_DOMAINS[di]);
                    if (/\/category\//i.test(href)) {
                        return { url: href, domain: GOGO_DOMAINS[di] };
                    }
                }
            } catch (_) { continue; }
        }
        return null;
    }

    async function gogoGetEpisodeId(animeUrl, episode) {
        try {
            var html = await getTextWithTimeout(animeUrl, { "User-Agent": UA }, 5000);
            if (!html) return null;
            // Try to find the movie_id / episode list
            var movieIdMatch = html.match(/value=["'](\d+)["'][^>]*id=["']movie_id/i) ||
                html.match(/id=["']movie_id["'][^>]*value=["'](\d+)["']/i);
            if (!movieIdMatch) return null;
            var movieId = movieIdMatch[1];

            // Gogoanime uses ajax to load episode list
            var epStart = Math.max(0, episode - 50);
            var epEnd = episode + 50;
            var ajaxUrl = GOGO_AJAX_DOMAIN + "/ajax/load-list-episode?ep_start=" + epStart + "&ep_end=" + epEnd + "&id=" + movieId;
            var ajaxHtml = await getTextWithTimeout(ajaxUrl, {
                "User-Agent": UA,
                "X-Requested-With": "XMLHttpRequest",
                "Referer": animeUrl
            }, 5000);
            if (!ajaxHtml) return null;

            var epDoc;
            try { epDoc = await parseHtml(ajaxHtml); } catch (e) { return null; }
            if (!epDoc) return null;

            var epLinks = qsa(epDoc, "a");
            for (var ei = 0; ei < epLinks.length; ei++) {
                var href = attr(epLinks[ei], ["href"]);
                var epNumMatch = href.match(/-episode-(\d+)/i);
                if (epNumMatch && parseInt(epNumMatch[1], 10) === episode) {
                    return fixUrl(href);
                }
            }
            return null;
        } catch (_) {
            return null;
        }
    }

    async function gogoResolveStreams(anilistId, episode, dubStatus, titleFallback) {
        try {
            // Search Gogoanime for the anime
            var searchTitle = titleFallback || "anime";
            var found = await gogoSearchAnime(searchTitle);
            if (!found) return [];

            // Get episode page URL
            var epUrl = await gogoGetEpisodeId(found.url, episode);
            if (!epUrl) return [];

            // Fetch the episode page
            var html = await getTextWithTimeout(epUrl, { "User-Agent": UA, "Referer": found.domain }, 5000);
            if (!html) return [];

            // Try to find video sources
            var streams = [];
            var langTag = dubStatus === "dub" ? "dub" : "sub";

            // Look for streaming URLs in the page
            // Gogoanime usually embeds links to StreamTape, MixDrop, etc.
            var serverLinks = html.match(/https?:\/\/[^"'\\\s]+(?:streamtape|mixdrop|mp4upload|dood)[^"'\\\s]*/gi) || [];

            for (var si = 0; si < serverLinks.length; si++) {
                var videoUrl = serverLinks[si];
                // Try built-in extractors first
                if (typeof loadExtractor === "function") {
                    try {
                        var extPromise = loadExtractor(videoUrl);
                        if (extPromise) {
                            var extResult = await extPromise;
                            if (extResult && extResult.length > 0) {
                                for (var ei = 0; ei < extResult.length; ei++) {
                                    extResult[ei].source = streamLabel("Gogoanime", extResult[ei].quality || 720, langTag);
                                    streams.push(extResult[ei]);
                                }
                                continue;
                            }
                        }
                    } catch (_) {}
                }
                // Direct URL fallback
                var quality = detectQuality(videoUrl);
                streams.push(new StreamResult({
                    url: videoUrl,
                    source: streamLabel("Gogoanime", quality || 720, langTag),
                    quality: quality || undefined,
                    headers: { "User-Agent": UA, "Referer": found.domain }
                }));
            }

            return streams;
        } catch (e) {
            return [];
        }
    }

    // ========================================================================
    // STREAM DEDUP & MERGE
    // ========================================================================

    function dedupeStreams(streams) {
        var seen = {};
        return (streams || []).filter(function(s) {
            if (!s || !s.url) return false;
            var key = s.url + "|" + (s.source || "") + "|" + (s.quality || 0);
            if (seen[key]) return false;
            seen[key] = true;
            return true;
        });
    }

    function sortStreams(streams) {
        return (streams || []).sort(function(a, b) {
            var qualityA = a.quality || 0;
            var qualityB = b.quality || 0;
            if (qualityA !== qualityB) return qualityB - qualityA; // higher quality first
            // Prefer hls over mp4
            var isHlsA = /\.m3u8/i.test(a.url) ? 1 : 0;
            var isHlsB = /\.m3u8/i.test(b.url) ? 1 : 0;
            return isHlsB - isHlsA;
        });
    }

    // ========================================================================
    // CORE: getHome
    // ========================================================================

    async function getHome(cb) {
        try {
            var raw = await getHomeFromAnilist();
            if (!raw || Object.keys(raw).length === 0) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No home sections available" });
            }
            // Convert object { "Trending": [...], ... } to array [{ name, items }, ...]
            var catOrder = ["Trending", "Popular", "Seasonal", "Top Rated", "Upcoming"];
            var formatted = [];
            for (var ci = 0; ci < catOrder.length; ci++) {
                var name = catOrder[ci];
                var items = raw[name];
                if (items && items.length > 0) {
                    formatted.push({ name: name, items: items });
                }
            }
            if (formatted.length === 0) {
                return cb({ success: false, errorCode: "HOME_ERROR", message: "No home sections available" });
            }
            cb({ success: true, data: formatted });
        } catch (e) {
            cb({ success: false, errorCode: "HOME_ERROR", message: e.message || String(e) });
        }
    }

    // ========================================================================
    // CORE: search
    // ========================================================================

    async function search(query, cb) {
        try {
            var q = String(query || "").trim().replace(/[<>"'&]/g, "").substring(0, 200);
            if (!q) return cb({ success: true, data: [] });

            var items = await searchFromAnilist(q);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "SEARCH_ERROR", message: e.message || String(e) });
        }
    }

    // ========================================================================
    // CORE: load
    // ========================================================================

    async function load(url, cb) {
        try {
            if (!url) return cb({ success: false, errorCode: "LOAD_ERROR", message: "No URL provided" });

            var item = await loadFromAnilist(url);
            if (!item) return cb({ success: false, errorCode: "LOAD_ERROR", message: "Failed to load anime details" });

            cb({ success: true, data: item });
        } catch (e) {
            cb({ success: false, errorCode: "LOAD_ERROR", message: e.message || String(e) });
        }
    }

    // ========================================================================
    // CORE: loadStreams — Multi-Source Aggregation
    // ========================================================================

    async function loadStreams(url, episodeOrCb, subOrDub, cb) {
        var done = false;
        var allStreams = [];
        var STREAM_TIMEOUT = 25000; // 25 seconds max

        function finish() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            var unique = dedupeStreams(allStreams);
            var sorted = sortStreams(unique);
            cb({ success: true, data: sorted });
        }

        var timer = setTimeout(function() {
            if (!done) finish();
        }, STREAM_TIMEOUT);

        try {
            // Support two calling conventions:
            // 1. (stringPayload, cb)
            // 2. (animeId, episode, subOrDub, cb)
            var anilistId, episode, dubStatus, malId, allanimeHash;

            if (typeof url === "number" || (typeof url === "string" && /^\d+$/.test(url))) {
                // Convention 2: (animeId, episode, subOrDub, cb)
                anilistId = parseInt(url, 10);
                episode = parseInt(episodeOrCb, 10);
                dubStatus = String(subOrDub || "sub").toLowerCase();
                malId = 0;
                allanimeHash = "";
                cb = cb || episodeOrCb;
                if (typeof cb !== "function") cb = typeof episodeOrCb === "function" ? episodeOrCb : subOrDub;
            } else {
                // Convention 1: (jsonPayloadString, cb)
                if (typeof episodeOrCb === "function") {
                    cb = episodeOrCb;
                }
                if (typeof cb !== "function") {
                    done = true;
                    clearTimeout(timer);
                    return; // silently exit - no callback
                }
                var info = parsePayload(url);
                if (info.type !== "episode" || !info.anilistId || !info.episode) {
                    done = true;
                    clearTimeout(timer);
                    return cb({ success: false, errorCode: "PARSE_ERROR", message: "Invalid episode URL payload" });
                }
                anilistId = parseInt(info.anilistId, 10);
                episode = parseInt(info.episode, 10);
                dubStatus = info.dubStatus || "sub";
                malId = parseInt(info.malId || 0, 10);
                allanimeHash = info.allanimeHash || "";
            }

            if (!anilistId || !episode) {
                done = true;
                clearTimeout(timer);
                return cb({ success: false, errorCode: "PARSE_ERROR", message: "Missing anilistId or episode" });
            }

            // Derive a title fallback from the AniList ID if needed
            // (For direct stream calls that skip load())
            var titleFallback = "";

            // Run all sources in parallel
            var sourcePromises = [];

            // Source 1: AllAnime GraphQL (primary streaming source)
            sourcePromises.push((async function() {
                try {
                    var streams = await allanimeResolveStreams(anilistId, episode, dubStatus, allanimeHash, titleFallback);
                    for (var i = 0; i < streams.length; i++) {
                        allStreams.push(streams[i]);
                    }
                } catch (e) {
                    console.warn("AllAnime source failed:", e.message);
                }
            })());

            // Source 2: Gogoanime (secondary streaming source)
            sourcePromises.push((async function() {
                try {
                    var streams = await gogoResolveStreams(anilistId, episode, dubStatus, titleFallback);
                    for (var i = 0; i < streams.length; i++) {
                        allStreams.push(streams[i]);
                    }
                } catch (e) {
                    console.warn("Gogoanime source failed:", e.message);
                }
            })());

            // Wait for all sources with Promise.allSettled
            for (var pi = 0; pi < sourcePromises.length; pi++) {
                try {
                    await sourcePromises[pi];
                } catch (_) {}
            }

            finish();
        } catch (e) {
            if (!done) {
                done = true;
                clearTimeout(timer);
                cb({ success: false, errorCode: "STREAM_ERROR", message: e.message || String(e) });
            }
        }
    }

    // ========================================================================
    // EXPORTS
    // ========================================================================
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;

})();
