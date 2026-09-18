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

// Playwright is optional at require-time: if the browser binary was never
// installed (e.g. someone runs this script without the `npx playwright
// install` CI step), we still want the rest of the scraper to work,
// just without the headless-render tier. This require is wrapped so a
// missing/broken Playwright install degrades gracefully instead of
// crashing the whole script.
let chromium = null;
try {
  chromium = require("playwright").chromium;
} catch (e) {
  console.warn("Playwright not available - headless-render fallback tier will be skipped.");
}

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
 * PLATFORM-SPECIFIC THUMBNAIL STRATEGIES
 *
 * This table exists so that adding support for a future problem
 * platform (the way YouTube needed one) is "append one entry here,"
 * not "go modify scrapeOne's core logic again." The default path
 * (generic og:image scrape -> favicon -> fully generic) already
 * handles the vast majority of the web correctly and needs no
 * per-site changes - confirmed directly: a network diagnostic run
 * from inside GitHub Actions showed GitHub, arxiv, Wikipedia,
 * LessWrong, and an ordinary personal blog all scrape correctly with
 * zero special-casing. Deliberately bot-hostile sites (Medium, ACS
 * Publications, and similar publisher paywalls) block automated
 * requests outright regardless of network origin - that's a real,
 * permanent block, not something worth chasing with more code, and
 * landing on a favicon for those is the correct, accepted outcome
 * (every consumer link-preview tool - Slack, Discord, iMessage - hits
 * the same wall on these exact sites and shows a plain fallback too).
 *
 * A platform earns a place in this table only when BOTH are true:
 *   1. It's common enough in the doc to be worth the maintenance
 *      (YouTube has its own whole section - clearly qualifies)
 *   2. It exposes a STABLE, PUBLIC, predictable alternative path to
 *      its real thumbnail that doesn't depend on scraping its guarded
 *      main page (YouTube's i.ytimg.com CDN; a hypothetical future
 *      example would be Vimeo's public oEmbed endpoint)
 *
 * Each entry: { name, matches(url) -> bool, getThumbnail(url) -> result|null }
 * getThumbnail returning null means "this strategy didn't pan out for
 * this specific URL - fall through to the generic scrape/favicon path"
 * rather than giving up entirely.
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
  // Future platforms get added here as one more object, following the
  // same shape - e.g. a Vimeo entry using its public oEmbed API, if
  // Vimeo links ever became common enough in the doc to justify it.
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
 * need to fetch/parse the video's HTML page at all.
 *
 * WHY THIS EXISTS: scraping the actual youtube.com/watch page for
 * og:image works fine from a residential connection, but consistently
 * came back with NO og:image tag at all when run from GitHub Actions -
 * confirmed directly via a network diagnostic (real 200 response, full
 * 1.3MB+ page, genuinely missing the tag), not a guess. i.ytimg.com is
 * YouTube's own thumbnail CDN, built to be hotlinked across the entire
 * web (every embed player relies on it), and was separately confirmed
 * reachable with a real 200 + valid JPEG from the exact same network -
 * so going straight there sidesteps whatever variant of the watch page
 * this network gets served, rather than trying to fix that page fetch.
 *
 * We deliberately request "hqdefault.jpg" rather than the higher-res
 * "maxresdefault.jpg": maxresdefault only exists for videos uploaded at
 * sufficient source resolution, and YouTube silently serves a small
 * gray placeholder image (still HTTP 200, not an error) when it doesn't
 * exist - which would trick this script into treating a placeholder as
 * a real thumbnail. hqdefault has existed for virtually every video
 * since YouTube's early years and is never a placeholder. At the size
 * our cards actually display thumbnails (180px tall), the resolution
 * difference from maxresdefault is not visible anyway.
 */
async function getYouTubeThumbnail(videoId) {
  const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(thumbnailUrl, { method: "HEAD", signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      return { image: thumbnailUrl, source: "youtube-thumbnail" };
    }
    return null; // fall through to the normal scrape/favicon path
  } catch (e) {
    return null;
  }
}

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
 * SELF-HOSTED HEADLESS-BROWSER FALLBACK TIER
 *
 * WHY THIS EXISTS: some sites (Medium, ACS Publications, and similar
 * academic/publisher paywalls) return an outright HTTP 403 to our plain
 * fetch() request - not a JS challenge page, a hard server-side refusal.
 * Sophisticated bot-detection systems (PerimeterX, Akamai, Cloudflare's
 * bot management) often decide whether to serve that 403 based on
 * signals a bare fetch() can never fake: TLS handshake fingerprint,
 * HTTP/2 behavior, actual JavaScript execution capability. A real
 * headless Chrome instance (via Playwright) presents a genuinely
 * different, much more browser-like fingerprint - since it IS an
 * actual browser engine - so it has a real (not guaranteed) chance of
 * being served real content where a bare fetch() gets refused outright.
 *
 * HONEST LIMIT: if a site's block is a true network/edge-level 403 that
 * doesn't depend on client fingerprint at all (e.g. a blanket IP-range
 * block), a headless browser hitting the exact same URL gets the exact
 * same 403 - no client-side technique can conjure content a server
 * refuses to send. This tier is worth trying, not guaranteed to work;
 * treat its actual hit rate (once tested against the sites we know are
 * currently failing) as the real answer, not this comment.
 *
 * COST CONTROL: only ever called for URLs that already failed the
 * lightweight fetch-based scrape above, and the browser is launched
 * ONCE per script run (not once per URL) - see main(), where a single
 * `browser` instance is created and passed down, reused across every
 * call to this function, then closed at the very end.
 */
async function tryHeadlessRender(url, browser) {
  if (!browser) return null; // Playwright unavailable - skip this tier entirely

  let context = null;
  try {
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: FETCH_TIMEOUT_MS
    });

    // Extract og:image from the LIVE, fully-rendered DOM - this also
    // catches sites that set the tag via client-side JavaScript, which
    // a static HTML fetch can never see regardless of bot-detection.
    const rawImage = await page.evaluate(() => {
      const tag =
        document.querySelector('meta[property="og:image"]') ||
        document.querySelector('meta[name="twitter:image"]');
      return tag ? tag.getAttribute("content") : null;
    });

    if (!rawImage) return null; // fall through to favicon as before

    const resolved = resolveImageUrl(rawImage, page.url());
    if (!resolved) return null;

    return { image: resolved, source: "og-headless" };
  } catch (e) {
    return null; // any failure here just means "this tier didn't help"
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

/**
 * Fetches a single URL and tries to extract its thumbnail image.
 * Returns { image: string, source: "og"|"og-headless"|"favicon"|"youtube-thumbnail"|"fallback", error?: string }
 */
async function scrapeOne(url, browser, isRetry = false) {
  // Check the platform-strategies table before falling back to the
  // generic scrape. This is a loop over DATA (the table above), not a
  // growing chain of hardcoded if-statements - adding a future platform
  // means adding one entry to PLATFORM_STRATEGIES, not touching this
  // function again.
  for (const strategy of PLATFORM_STRATEGIES) {
    if (strategy.matches(url)) {
      const result = await strategy.getThumbnail(url);
      if (result) return result;
      // If the strategy returns null (e.g. HEAD check failed), fall
      // through to the generic scrape below rather than giving up -
      // a platform-specific shortcut not panning out for one URL
      // shouldn't prevent the normal og:image/favicon path from trying.
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
        return scrapeOne(url, browser, true);
      }
      // Before giving up to favicon, try a real headless browser - a
      // 403 in particular is exactly the signature of bot-detection
      // that a different (more browser-like) request fingerprint might
      // get past. See tryHeadlessRender's comment for the honest limits.
      const headlessResult = await tryHeadlessRender(url, browser);
      if (headlessResult) return headlessResult;
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
      const headlessResult = await tryHeadlessRender(url, browser);
      if (headlessResult) return headlessResult;
      return fallbackFor(url, "no og:image found");
    }

    const resolved = resolveImageUrl(rawImage, res.url || url);
    if (!resolved) {
      return fallbackFor(url, "could not resolve image url");
    }

    return { image: resolved, source: "og" };
  } catch (e) {
    const headlessResult = await tryHeadlessRender(url, browser);
    if (headlessResult) return headlessResult;
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
  let scrapedHeadless = 0;
  let usedFavicon = 0;
  let usedYoutubeThumbnail = 0;
  let failed = 0;

  // Launch ONE shared browser instance for the whole run, only if there's
  // actually something to scrape and Playwright is available - avoids the
  // ~1-2s browser launch cost entirely on runs where everything's cached
  // (the common case), and avoids launching per-URL (which would be slow
  // and wasteful across many URLs in one run).
  let browser = null;
  if (urlsToScrape.length > 0 && chromium) {
    try {
      browser = await chromium.launch();
    } catch (e) {
      console.warn("Could not launch headless browser - continuing without that fallback tier:", e.message);
    }
  }

  for (const url of urlsToScrape) {
    const result = await scrapeOne(url, browser);
    cache[url] = {
      ...result,
      fetchedAt: new Date().toISOString()
    };
    if (result.source === "og") {
      scraped++;
      console.log(`✅ ${url} -> ${result.image}`);
    } else if (result.source === "og-headless") {
      scrapedHeadless++;
      console.log(`🎭 ${url} -> found via headless browser -> ${result.image}`);
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

  if (browser) await browser.close();

  fs.writeFileSync(THUMBNAILS_JSON_PATH, JSON.stringify(cache, null, 2));
  console.log(
    `\nDone. ${scraped} real thumbnails found, ${scrapedHeadless} found via headless browser, ` +
    `${usedYoutubeThumbnail} used YouTube's thumbnail CDN, ` +
    `${usedFavicon} used a site favicon, ${failed} fell back to fully generic, ` +
    `${allUrls.length - urlsToScrape.length} already cached.`
  );
}

main().catch(e => {
  console.error("Fatal error in fetch-thumbnails.js:", e);
  process.exit(1);
});
