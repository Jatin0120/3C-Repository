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
const MAX_HTML_BYTES = 500_000; // don't download entire huge pages, og tags are always in <head>
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
 * Fetches a single URL and tries to extract its thumbnail image.
 * Returns { image: string, source: "og"|"fallback", error?: string }
 */
async function scrapeOne(url) {
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
      return { image: GENERIC_FALLBACK, source: "fallback", error: "HTTP " + res.status };
    }

    // Read only a bounded amount of the body — og:image is always in
    // <head>, so we never need the full page, even for huge documents.
    const reader = res.body;
    let html = "";
    for await (const chunk of reader) {
      html += chunk.toString("utf8");
      if (html.length > MAX_HTML_BYTES) break;
    }

    const rawImage = extractImageFromHtml(html);
    if (!rawImage) {
      return { image: GENERIC_FALLBACK, source: "fallback", error: "no og:image found" };
    }

    const resolved = resolveImageUrl(rawImage, res.url || url);
    if (!resolved) {
      return { image: GENERIC_FALLBACK, source: "fallback", error: "could not resolve image url" };
    }

    return { image: resolved, source: "og" };
  } catch (e) {
    return { image: GENERIC_FALLBACK, source: "fallback", error: String(e.message || e) };
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

  const urlsToScrape = allUrls.filter(url => !cache[url]);
  console.log(
    `Found ${allUrls.length} unique URLs total, ${urlsToScrape.length} not yet cached.`
  );

  let scraped = 0;
  let failed = 0;

  for (const url of urlsToScrape) {
    const result = await scrapeOne(url);
    cache[url] = {
      ...result,
      fetchedAt: new Date().toISOString()
    };
    if (result.source === "og") {
      scraped++;
      console.log(`${url} -> ${result.image}`);
    } else {
      failed++;
      console.log(`${url} -> fallback (${result.error})`);
    }
  }

  fs.writeFileSync(THUMBNAILS_JSON_PATH, JSON.stringify(cache, null, 2));
  console.log(
    `\nDone. ${scraped} thumbnails found, ${failed} fell back to generic, ` +
    `${allUrls.length - urlsToScrape.length} already cached.`
  );
}

main().catch(e => {
  console.error("Fatal error in fetch-thumbnails.js:", e);
  process.exit(1);
});
