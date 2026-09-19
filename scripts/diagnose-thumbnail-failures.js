/**
 * diagnose-thumbnail-failures.js
 *
 * PURPOSE: run this from GitHub Actions to get a systematic, categorized
 * picture of WHY a batch of URLs fail to yield a real thumbnail - rather
 * than debugging one URL at a time and guessing at patterns.
 *
 * For each URL, this reports enough detail to tell apart:
 *   - GENUINELY_NO_TAG: the page has no og:image (and no twitter:image)
 *     anywhere in its HTML at all - true regardless of what network
 *     fetches it, not fixable by any client-side trick.
 *   - HTTP_ERROR: the server refused the request outright (403, 429,
 *     etc.) - may or may not be network-dependent.
 *   - NETWORK_ERROR: DNS failure, timeout, connection refused, etc.
 *   - HAS_OTHER_OG_TAGS_NO_IMAGE: the page has SOME Open Graph tags
 *     (title, description) but specifically no image tag - a strong
 *     signal the site just never set one, same as GENUINELY_NO_TAG but
 *     worth distinguishing since it rules out "the whole og: block is
 *     missing because of how we're fetching."
 *   - SUCCESS: found a usable image tag.
 *
 * Usage: node scripts/diagnose-thumbnail-failures.js
 * Reads URLs from a hardcoded list below - edit TEST_URLS to whatever
 * set you want to check (e.g. everything currently on favicon/generic
 * in thumbnails.json).
 */

const fetch = require("node-fetch");

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

// Edit this list to whatever URLs you want checked. Start with the ones
// we already know are failing, plus a spread of others for comparison.
const TEST_URLS = [
  "https://www.youtube.com/watch?v=pu4uL7deCNw",
  "https://youtu.be/uKxYdMODRSU?si=ny4j2YRvkOCkCrdq",
  "https://youtu.be/E9_kyXjtRHc?si=hwDPxTUFtZjlaVje",
  "https://scichemcode.github.io/alam-website/",
  // A spread of other categories from the doc, for comparison:
  "https://github.com/torvalds/linux",
  "https://arxiv.org/abs/2305.01582",
  "https://en.wikipedia.org/wiki/Special:Random",
  "https://www.lesswrong.com/posts/6hDvwJyrwLtxBLHWG/mechanisms-too-simple-for-humans-to-design"
];

function categorize(html) {
  const hasOgImage = /property=["']og:image["']/.test(html) || /name=["']twitter:image["']/.test(html);
  if (hasOgImage) return "SUCCESS";

  const hasAnyOgTag = /property=["']og:(title|description|type|url)["']/.test(html);
  if (hasAnyOgTag) return "HAS_OTHER_OG_TAGS_NO_IMAGE";

  return "GENUINELY_NO_TAG";
}

async function diagnoseOne(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: BROWSER_HEADERS
    });
    const elapsedMs = Date.now() - startedAt;

    if (!res.ok) {
      console.log(`[HTTP_ERROR] ${url}`);
      console.log(`   Status: ${res.status} | Time: ${elapsedMs}ms\n`);
      return;
    }

    const html = await res.text();
    const category = categorize(html);
    const icon = category === "SUCCESS" ? "✅" : category === "HAS_OTHER_OG_TAGS_NO_IMAGE" ? "🟡" : "⚠️ ";

    console.log(`${icon} [${category}] ${url}`);
    console.log(`   Status: ${res.status} | Time: ${elapsedMs}ms | Length: ${html.length} chars | Final URL: ${res.url}`);

    // Sanity check independent of the regex above: does the literal
    // substring "og:image" appear ANYWHERE in the response at all? If
    // this says true while the category above says GENUINELY_NO_TAG,
    // that's proof the regex itself is the bug, not the page/network.
    const rawSubstringIndex = html.indexOf("og:image");
    console.log(`   Raw substring "og:image" found at index: ${rawSubstringIndex}`);
    if (rawSubstringIndex > -1) {
      console.log(`   Context: ...${html.substring(Math.max(0, rawSubstringIndex - 60), rawSubstringIndex + 150)}...`);
    }

    if (category === "HAS_OTHER_OG_TAGS_NO_IMAGE") {
      // Show which og: tags DID make it through, as evidence the page
      // fetched fine overall - just genuinely never set an image tag.
      const foundTags = [...html.matchAll(/property=["'](og:[a-z:]+)["']/g)].map(m => m[1]);
      console.log(`   Open Graph tags present: ${[...new Set(foundTags)].join(", ")}`);
    }
    console.log("");
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.log(`❌ [NETWORK_ERROR] ${url}`);
    console.log(`   Failed after ${elapsedMs}ms: ${e.message}\n`);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  console.log(`Diagnosing ${TEST_URLS.length} URLs...\n`);

  const results = { SUCCESS: 0, HAS_OTHER_OG_TAGS_NO_IMAGE: 0, GENUINELY_NO_TAG: 0, HTTP_ERROR: 0, NETWORK_ERROR: 0 };

  for (const url of TEST_URLS) {
    await diagnoseOne(url);
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log("=== DONE. Review each category above. ===");
  console.log(
    "GENUINELY_NO_TAG and HAS_OTHER_OG_TAGS_NO_IMAGE both mean: the site " +
    "itself never published an og:image, and no client-side trick (headless " +
    "browser, different network, etc.) can fix that - favicon is the correct " +
    "permanent outcome for these.\n" +
    "HTTP_ERROR and NETWORK_ERROR are worth re-checking from a residential " +
    "connection for comparison - if they succeed there but fail here, THAT " +
    "is real evidence of a network-dependent difference worth investigating " +
    "further, rather than assuming."
  );
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
