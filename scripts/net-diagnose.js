/**
 * net-diagnose.js
 *
 * PURPOSE: To check how GitHub's runner network is treated by various external sites,
 *rather than guessing based on local-machine results (which use a residential IP
 *and will naturally behave differently).
 *
 * It's a diagnostic tool which tells whether 
 * "GitHub Actions gets a worse response than a local connection"
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

// A deliberately mixed set: known-successful sites (control group), the
// specific sites that failed in the real run, and the raw CDN domain we
// were considering routing around the problem with - all in one batch,
// fetched identically, so differences are attributable to the SITE, not
// to inconsistent test conditions.
const TEST_URLS = [
  // Control group - worked fine from GitHub Actions in the real run
  { label: "GitHub (control - known working)", url: "https://github.com/torvalds/linux" },
  { label: "arxiv.org (control - known working)", url: "https://arxiv.org/abs/2305.01582" },

  // The sites that failed in the real CI run
  { label: "YouTube watch page (failed in real run)", url: "https://www.youtube.com/watch?v=d9s9bQuG1qk" },
  { label: "youtu.be short link (failed in real run)", url: "https://youtu.be/d9s9bQuG1qk" },
  { label: "Medium (failed in real run)", url: "https://aldousdj.medium.com/doing-research-mathematics-is-like-aaf4ff0d9235" },
  { label: "LessWrong (failed/429 in real run)", url: "https://www.lesswrong.com/posts/6hDvwJyrwLtxBLHWG/mechanisms-too-simple-for-humans-to-design" },
  { label: "ACS Publications (failed/403 in real run)", url: "https://pubs.acs.org/jacsat/article/148/35/38153/5348920/Biphasic-Solar-Reforming-of-Lignin-to-Aromatics" },

  // The raw CDN domain being considered as a workaround for YouTube
  // specifically - if THIS also fails from Actions, the CDN-bypass idea
  // is dead on arrival and we need a different approach entirely.
  { label: "i.ytimg.com thumbnail CDN directly", url: "https://i.ytimg.com/vi/d9s9bQuG1qk/hqdefault.jpg" },

  // A couple of unrelated, ordinary sites with no known bot-mitigation
  // reputation, as an additional control - if these ALSO come back
  // degraded, the pattern is broader than "sites that specifically
  // guard against scrapers" and points at something more fundamental
  // about the runner's network reputation.
  { label: "Wikipedia (ordinary control)", url: "https://en.wikipedia.org/wiki/Special:Random" },
  { label: "A plain personal blog (ordinary control)", url: "https://drscotthawley.github.io/blog/posts/2017-05-04-Learning-Room-Shapes.html" }
];

async function identifyNetwork() {
  console.log("=== STEP 1: What network is this runner actually on? ===\n");
  try {
    const res = await fetch("https://ipinfo.io/json", { headers: BROWSER_HEADERS });
    const info = await res.json();
    console.log("Public IP:      ", info.ip);
    console.log("Hosting org/ASN:", info.org);
    console.log("Location:       ", `${info.city || "?"}, ${info.region || "?"}, ${info.country || "?"}`);
    console.log(
      "\nIf 'org' above mentions Microsoft, Azure, or a hosting/cloud provider " +
      "(rather than a residential ISP name), that's hard confirmation this is " +
      "a datacenter IP, not a guess.\n"
    );
  } catch (e) {
    console.log("Could not reach ipinfo.io to identify network:", e.message);
    console.log("(Not fatal - continuing with the URL tests below.)\n");
  }
}

async function testOne({ label, url }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: BROWSER_HEADERS
    });
    const elapsedMs = Date.now() - startedAt;
    const contentLength = res.headers.get("content-length");
    const contentType = res.headers.get("content-type");

    console.log(`${res.ok ? "✅" : "⚠️ "} ${label}`);
    console.log(`   URL: ${url}`);
    console.log(`   Status: ${res.status} | Time: ${elapsedMs}ms | Content-Type: ${contentType || "?"} | Content-Length: ${contentLength || "?"}`);

    // For HTML pages specifically, note whether an og:image tag is
    // present at all - without fully replicating the real scraper's
    // extraction logic, just a quick signal.
    if (contentType && contentType.includes("text/html")) {
      const text = await res.text();
      const hasOgImage = text.includes("og:image");
      console.log(`   Contains 'og:image' anywhere in response: ${hasOgImage} (response length: ${text.length} chars)`);
    }
  } catch (e) {
    const elapsedMs = Date.now() - startedAt;
    console.log(`❌ ${label}`);
    console.log(`   URL: ${url}`);
    console.log(`   FAILED after ${elapsedMs}ms: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }
  console.log("");
}

async function main() {
  await identifyNetwork();

  console.log("=== STEP 2: Fetching each test URL from THIS environment ===\n");
  for (const testCase of TEST_URLS) {
    await testOne(testCase);
    // Small delay between requests, consistent with the real scraper's
    // politeness delay, so we're not creating a DIFFERENT test condition
    // (e.g. tripping rate limits that wouldn't trip in the real run).
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log("=== DONE. Copy this entire output for review. ===");
}

main().catch(e => {
  console.error("Fatal error in diagnostic script:", e);
  process.exit(1);
});
