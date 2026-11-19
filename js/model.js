// Pure data logic for the 3C site: no DOM access, so it can be
// unit-checked from Node (see scripts/check-editorial.mjs) as well as
// run in the browser.

const FORMAT_BY_SECTION = {
  'github repositories': 'Code',
  'youtube resources': 'Video',
  'papers': 'Paper',
  'lectures & books': 'Course & Book',
};

const PAPER_HOSTS = [
  'arxiv.org', 'biorxiv.org', 'chemrxiv.org', 'pnas.org', 'iopscience.iop.org',
  'link.springer.com', 'pubs.acs.org', 'pubs.rsc.org', 'onlinelibrary.wiley.com',
  'journals.aps.org', 'nature.com', 'tsapps.nist.gov', 'apps.dtic.mil',
  'dataspace.princeton.edu', 'archive.computerhistory.org',
];

export const FORMATS = ['Video', 'Code', 'Paper', 'Course & Book', 'Article'];

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Best-guess format for an item. Uses the doc's own section first, then the host. */
export function formatOf(item, sectionTitle) {
  const host = hostOf(item.primaryUrl);
  if (/(^|\.)youtu(\.be|be\.com)$/.test(host)) return 'Video';
  const bySection = FORMAT_BY_SECTION[(sectionTitle || '').toLowerCase()];
  if (bySection) return bySection;
  if (host === 'github.com' || host === 'gitlab.com' || host === 'pypi.org') return 'Code';
  if (PAPER_HOSTS.some(h => host === h || host.endsWith('.' + h))) return 'Paper';
  if (/\.pdf($|\?)/i.test(item.primaryUrl || '')) return 'Paper';
  return 'Article';
}

/** Everything searchable about an item, lowercased. */
export function haystackOf(item) {
  return [
    item.title,
    item.searchTitle,
    item.description,
    item.searchDescription,
    ...(item.keywords || []),
  ].filter(Boolean).join(' • ').toLowerCase();
}

/** Topic given to entries that are in the doc but not yet tagged in categories.json. */
export const UNTAGGED_TOPIC = 'MISC';

/**
 * Flattens data.json + categories.json into one list of entries, each with
 * a topic, a level, a format, and precomputed search text. Order is the
 * doc's own order, which is roughly "most recently added last" within a
 * section. Entries added to the doc after the last tagging pass get
 * UNTAGGED_TOPIC, no level, and reviewed: false, so the site can still show
 * them and a reviewer can find them.
 */
export function buildEntries(data, categories, thumbnails = {}) {
  const tags = categories.entries || {};
  const entries = [];
  const seen = new Set();
  let order = 0;

  for (const section of data.sections || []) {
    for (const item of section.items || []) {
      if (!item || !item.title) continue;
      const url = item.primaryUrl || null;
      // The doc occasionally lists the same link twice; keep the first.
      if (url && seen.has(url)) continue;
      if (url) seen.add(url);

      const haystack = haystackOf(item);
      const tag = url ? tags[url] : null;

      const thumb = url ? thumbnails[url] : null;
      entries.push({
        id: 'e' + order,
        order: order++,
        url,
        title: item.title.trim(),
        longTitle: item.searchTitle || null,
        description: cleanDescription(item.description),
        summary: item.searchDescription || null,
        keywords: item.keywords || [],
        links: item.links || [],
        section: section.title,
        format: formatOf(item, section.title),
        host: hostOf(url),
        topic: tag ? tag.topic : UNTAGGED_TOPIC,
        level: tag ? tag.level : null,
        reviewed: !!tag,
        // Only real preview images; favicons look broken at card size.
        image: thumb && thumb.source !== 'favicon' && thumb.image ? thumb.image : null,
        haystack,
      });
    }
  }
  return entries;
}

/**
 * Resolves a view key ("fields", "rings", "roles") to its definition,
 * falling back to the default view for unknown or missing keys (e.g. a
 * stale ?view= link).
 */
export function viewOf(categories, key) {
  const views = categories.views;
  const k = key && key !== 'default' && views[key] ? key : views.default;
  return { key: k, ...views[k] };
}

/** Groups entries by the given view, in the view's group order, with counts per level. */
export function groupEntries(entries, view) {
  const groupOfTopic = {};
  for (const g of view.groups) for (const t of g.topics) groupOfTopic[t] = g.id;
  return view.groups.map(g => {
    const items = entries.filter(e => groupOfTopic[e.topic] === g.id);
    const levels = { I: 0, C: 0, A: 0 };
    for (const e of items) if (e.level) levels[e.level]++;
    return { ...g, items, levels };
  });
}

/** The doc's "description" field is often a bare label like "Blog" or "(N. Bohr)". */
function cleanDescription(d) {
  if (!d) return null;
  const t = d.trim().replace(/^\((.*)\)$/, '$1').trim();
  return t || null;
}

/** Token-AND search with simple relevance: title hits beat body hits. */
export function search(entries, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return entries;
  const scored = [];
  for (const e of entries) {
    let score = 0;
    let ok = true;
    const title = (e.title + ' ' + (e.longTitle || '')).toLowerCase();
    for (const t of tokens) {
      if (title.includes(t)) score += 3;
      else if (e.haystack.includes(t)) score += 1;
      else { ok = false; break; }
    }
    if (ok) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.order - b.e.order);
  return scored.map(s => s.e);
}
