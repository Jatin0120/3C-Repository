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
    `\nDone. ${scraped} real thumbnails found, ${usedFavicon} used a site favicon, ` +
    `${failed} fell back to fully generic, ` +
    `${allUrls.length - urlsToScrape.length} already cached.`
  );
}

main().catch(e => {
  console.error("Fatal error in fetch-thumbnails.js:", e);
  process.exit(1);
});
