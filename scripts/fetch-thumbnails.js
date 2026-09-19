/**
 * fetch-thumbnails.js
 *
 * Reads data.json (produced by the Apps Script parser), scrapes each
 * unique primaryUrl for an Open Graph / Twitter Card image, caches
 * results in thumbnails.json (so re-runs only scrape NEW urls), and
 * writes the merged result back to thumbnails.json.
 *
 * Usage: node scripts/fetch-thumbnails.js
 *
 * Exit code is always 0 even if individual scrapes fail — a single
 * unreachable site should never fail the whole build. Only a totally
 * malformed data.json should cause a non-zero exit.
 */

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const DATA_JSON_PATH = path.join(__dirname, "..", "data.json");
const THUMBNAILS_JSON_PATH = path.join(__dirname, "..", "thumbnails.json");
const FETCH_TIMEOUT_MS = 10000;
const MAX_HTML_BYTES = 2_000_000; // raised from 500KB after finding YouTube's
  // og:image tag sits ~694KB into the page (confirmed via diagnose-one-url.js
  // against a real video URL) - some sites have very large <head> sections
  // due to inline scripts/JSON before meta tags. 2MB comfortably covers this
  // while still bailing out of truly pathological pages.
const GENERIC_FALLBACK = "assets/generic-thumbnail.svg"; // relative path used by the site itself

/**
 * Extracts og:image (or twitter:image as fallback) from raw HTML text.
 * Deliberately uses simple regex rather than a full HTML parser: we only
 * ever need <head> meta tags, and pulling in a DOM parser for this is
 * unnecessary weight for a CI script. Regex is safe here because we are
 * only searching for a very specific, well-defined tag shape.
 */
function extractImageFromHtml(html) {
  const patterns = [
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && match[1]) return match[1];
  }
  return null;
}

/**
 * Resolves a possibly-relative image URL against the page's own URL.
 * og:image is often relative (e.g. "/images/preview.png") and needs
 * the page's origin to become a usable absolute URL.
 */
function resolveImageUrl(imageUrl, pageUrl) {
  try {
    return new URL(imageUrl, pageUrl).toString();
  } catch (e) {
    return null;
  }
}

/**
 * Given a page URL that had no usable og:image, builds a favicon URL
 * using Google's public favicon service as a second-tier fallback. This
 * works even for direct PDF/file links (favicons are domain-level, not
 * page-level), giving at least a "which site is this" visual instead of
 * a fully generic placeholder. We don't verify the favicon actually
 * resolves to a real (non-blank) icon before using it — the service
 * always returns *some* valid image response, so that would only
 * confirm reachability, not icon quality, and isn't worth an extra
 * request on every single fallback.
 */
function faviconUrlFor(pageUrl) {
  try {
    const domain = new URL(pageUrl).hostname;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  } catch (e) {
    return null;
  }
}

/**
 * PLATFORM-SPECIFIC THUMBNAIL STRATEGIES
 *
 * Confirmed via a direct diagnostic (raw-substring search on real
 * Actions output): GitHub Actions' network receives a complete-looking
 * YouTube watch page that specifically lacks the entire Open Graph
 * block - most likely a consent/region-variant page served to
 * cookie-less, first-visit traffic. Every other tested site (GitHub,
 * arxiv, Wikipedia, LessWrong, an ordinary personal blog) behaved
 * identically in both environments - this is a genuine, narrow,
 * YouTube-specific issue, not a general network problem, so it gets a
 * targeted fix.
 */
const PLATFORM_STRATEGIES = [
  {
    name: "YouTube",
    matches(url) {
      return extractYouTubeVideoId(url) !== null;
    },
    async getThumbnail(url) {
      const videoId = extractYouTubeVideoId(url);
      return getYouTubeThumbnail(videoId);
    }
  }
];

/**
 * Extracts a YouTube video ID from any common URL shape:
 *   - youtube.com/watch?v=ID (v param can be anywhere in the query string)
 *   - youtu.be/ID (the short-link redirector domain)
 *   - youtube.com/shorts/ID
 *   - youtube.com/embed/ID
 * Returns null for anything else, including non-YouTube URLs.
 */
function extractYouTubeVideoId(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname.replace(/^www\.|^m\./, "");

    if (host === "youtu.be") {
      return u.pathname.slice(1).split("/")[0] || null;
    }

    if (host === "youtube.com") {
      if (u.pathname === "/watch") {
        return u.searchParams.get("v");
      }
      const shortsMatch = u.pathname.match(/^\/shorts\/([^/]+)/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = u.pathname.match(/^\/embed\/([^/]+)/);
      if (embedMatch) return embedMatch[1];
    }

    return null;
  } catch (e) {
    return null;
  }
}

/**
 * Builds a YouTube thumbnail URL directly from a video ID, bypassing the
 * need to fetch/parse the video's HTML page at all - confirmed via a
 * real diagnostic that i.ytimg.com returns a valid 200 + real JPEG from
 * GitHub Actions' network, unaffected by the consent-variant issue that
 * hits the watch page itself.
 *
 * hqdefault.jpg (not maxresdefault.jpg) is used deliberately: maxres
 * only exists for videos uploaded at sufficient source resolution, and
 * YouTube silently serves a small gray placeholder (still HTTP 200) when
 * it doesn't - which would trick this into treating a placeholder as a
 * real thumbnail. hqdefault has existed for virtually every video since
 * YouTube's early years and is never a placeholder.
 */
async function getYouTubeThumbnail(videoId) {
  const resolutions = ["maxresdefault.jpg", "sddefault.jpg", "hqdefault.jpg"];
  // The known placeholder is a tiny, fixed-size 120px-wide JPEG - real
  // thumbnails at even the lowest tier are tens of KB. 2000 bytes is a
  // safely conservative cutoff between the two.
  const PLACEHOLDER_MAX_BYTES = 2000;

  for (const resolution of resolutions) {
    const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/${resolution}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(thumbnailUrl, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) continue; // try the next, lower resolution

      const buffer = await res.buffer();
      if (buffer.length > PLACEHOLDER_MAX_BYTES) {
        return { image: thumbnailUrl, source: "youtube-thumbnail" };
      }
      // Otherwise this was the placeholder - try the next resolution
      // down rather than accepting it.
    } catch (e) {
      // network error on this resolution - try the next one
    }
  }

  return null; // every resolution came back as the placeholder or failed
}
      

/**
 * Central "og:image didn't work" handler used by every failure path in
 * scrapeOne. Tries the domain favicon as a second tier before finally
 * falling back to the fully generic placeholder (only reached if the
 * page URL itself can't even be parsed, which should be rare).
 */
function fallbackFor(pageUrl, errorReason) {
  const favicon = faviconUrlFor(pageUrl);
  if (favicon) {
    return { image: favicon, source: "favicon", error: errorReason };
  }
  return { image: GENERIC_FALLBACK, source: "fallback", error: errorReason };
}

/**
 * Fetches a single URL and tries to extract its thumbnail image.
 * Returns { image: string, source: "og"|"fallback", error?: string }
 */
async function scrapeOne(url, isRetry = false) {
  for (const strategy of PLATFORM_STRATEGIES) {
    if (strategy.matches(url)) {
      const result = await strategy.getThumbnail(url);
      if (result) return result;
      break;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        // NOTE: this User-Agent identifies the AUTOMATED SCRAPER to the
        // websites it fetches during the build process - it has nothing
        // to do with any real visitor's browser (Brave, Chrome, etc.).
        // When someone actually visits the finished site, their own
        // browser sends its own real User-Agent; this one is only used
        // here, by this script, when it reaches out to grab preview
        // images ahead of time. It's set to look like a normal desktop
        // Chrome browser because some sites (arxiv included) apply bot
        // mitigation that keys off missing/unusual browser-like headers.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

    if (!res.ok) {
      // Some CDNs (GitHub Pages included) occasionally return a transient
      // 404/5xx on a cold cache hit that succeeds on a second try shortly
      // after. One retry, once, catches this without masking genuinely
      // broken links (a real 404 will fail again on retry too).
      if (!isRetry && (res.status === 404 || res.status >= 500)) {
        clearTimeout(timeout);
        await new Promise(resolve => setTimeout(resolve, 1500));
        return scrapeOne(url, true);
      }
      return fallbackFor(url, "HTTP " + res.status);
    }

    // Read the body, but stop early once we've passed </head> - that's
    // the real signal all meta tags have been seen, so there's no need
    // to keep downloading the rest of a multi-megabyte page. MAX_HTML_BYTES
    // is a safety ceiling for pages that never close </head> cleanly.
    const reader = res.body;
    let html = "";
    for await (const chunk of reader) {
      html += chunk.toString("utf8");
      if (html.includes("</head>")) break;
      if (html.length > MAX_HTML_BYTES) break;
    }

    const rawImage = extractImageFromHtml(html);
    if (!rawImage) {
      return fallbackFor(url, "no og:image found");
    }

    const resolved = resolveImageUrl(rawImage, res.url || url);
    if (!resolved) {
      return fallbackFor(url, "could not resolve image url");
    }

    return { image: resolved, source: "og" };
  } catch (e) {
    return fallbackFor(url, String(e.message || e));
  } finally {
    clearTimeout(timeout);
  }
}

/** Collects every unique primaryUrl across all sections of data.json. */
function collectAllUrls(data) {
  const urls = new Set();
  for (const section of data.sections || []) {
    for (const item of section.items || []) {
      if (item.primaryUrl) urls.add(item.primaryUrl);
    }
  }
  return Array.from(urls);
}

async function main() {
  if (!fs.existsSync(DATA_JSON_PATH)) {
    console.error("data.json not found at " + DATA_JSON_PATH);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_JSON_PATH, "utf8"));
  const allUrls = collectAllUrls(data);

  let cache = {};
  if (fs.existsSync(THUMBNAILS_JSON_PATH)) {
    try {
      cache = JSON.parse(fs.readFileSync(THUMBNAILS_JSON_PATH, "utf8"));
    } catch (e) {
      console.warn("Could not parse existing thumbnails.json, starting fresh: " + e.message);
      cache = {};
    }
  }

  // Retry logic: only truly-generic fallbacks get retried on future runs
  // (a real og:image or even a favicon is "good enough" to keep). This
  // means: if we previously found a favicon for a URL, we don't keep
  // re-hitting that site every run just hoping for a real og:image later.
  const cachedUrls = Object.keys(cache);
  const trueFallbackUrls = cachedUrls.filter(url => cache[url].source === "fallback");
  const urlsToScrape = allUrls.filter(
    url => !cache[url] || cache[url].source === "fallback"
  );
  console.log(
    `Found ${allUrls.length} unique URLs total. ` +
    `${cachedUrls.length - trueFallbackUrls.length} already have a real thumbnail or favicon cached. ` +
    `${urlsToScrape.length} will be (re)tried this run (new URLs + previous generic fallbacks).`
  );

  let scraped = 0;
  let usedYoutubeThumbnail = 0;
  let usedFavicon = 0;
  let failed = 0;

  for (const url of urlsToScrape) {
    const result = await scrapeOne(url);
    cache[url] = {
      ...result,
      fetchedAt: new Date().toISOString()
    };
    if (result.source === "og") {
      scraped++;
      console.log(`✅ ${url} -> ${result.image}`);
    } else if (result.source === "youtube-thumbnail") {
      usedYoutubeThumbnail++;
      console.log(`▶️  ${url} -> YouTube thumbnail CDN -> ${result.image}`);
    } else if (result.source === "favicon") {
      usedFavicon++;
      console.log(`🔹 ${url} -> favicon fallback (${result.error})`);
    } else {
      failed++;
      console.log(`⚠️  ${url} -> generic fallback (${result.error})`);
    }

    // Be a polite scraper: small delay between requests so we don't
    // trip rate-limiting (HTTP 429) on sites like lesswrong.com that
    // throttle rapid back-to-back requests from the same source.
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  fs.writeFileSync(THUMBNAILS_JSON_PATH, JSON.stringify(cache, null, 2));
  console.log(
    `\nDone. ${scraped} real thumbnails found, ${usedYoutubeThumbnail} used YouTube's thumbnail CDN, ` +
    `${usedFavicon} used a site favicon, ` +
    `${failed} fell back to fully generic, ` +
    `${allUrls.length - urlsToScrape.length} already cached.`
  );
}

main().catch(e => {
  console.error("Fatal error in fetch-thumbnails.js:", e);
  process.exit(1);
});
