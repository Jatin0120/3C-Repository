// Sanity check for categories.json and editorial.json against the current data.json.
//   node scripts/check-editorial.mjs          -> summary + problems
//   node scripts/check-editorial.mjs --list   -> also lists every entry per group of the default view
//
// Fails (exit 1) if:
//   - editorial.json points at a URL that is no longer in data.json,
//   - categories.json uses a topic or level it doesn't define,
//   - a view leaves a topic out or puts it in two groups.
// Entries in the doc that are not yet tagged are reported but don't fail
// the check: the site shows them as unreviewed.

import { readFileSync } from 'node:fs';
import { buildEntries, viewOf, groupEntries } from '../js/model.js';

const read = f => JSON.parse(readFileSync(new URL('../' + f, import.meta.url), 'utf8'));
const data = read('data.json');
const categories = read('categories.json');
const editorial = read('editorial.json');
const thumbs = read('thumbnails.json');

const entries = buildEntries(data, categories, thumbs);
const byUrl = new Map(entries.map(e => [e.url, e]));
const list = process.argv.includes('--list');
const problems = [];

// Tags
for (const [url, t] of Object.entries(categories.entries)) {
  if (!categories.topics[t.topic]) problems.push(`unknown topic "${t.topic}" for ${url}`);
  if (!categories.levels[t.level]) problems.push(`unknown level "${t.level}" for ${url}`);
}
const stale = Object.keys(categories.entries).filter(u => !byUrl.has(u));
const untagged = entries.filter(e => !e.reviewed);

// Views
const viewKeys = Object.keys(categories.views).filter(k => k !== 'default');
if (!categories.views[categories.views.default]) problems.push(`default view "${categories.views.default}" does not exist`);
for (const k of viewKeys) {
  const seen = categories.views[k].groups.flatMap(g => g.topics);
  for (const t of Object.keys(categories.topics)) {
    const n = seen.filter(x => x === t).length;
    if (n !== 1) problems.push(`view "${k}" has topic ${t} ${n} times (should be 1)`);
  }
}

console.log(`${entries.length} entries · ${entries.length - untagged.length} tagged · ${untagged.length} untagged`);
const lv = { I: 0, C: 0, A: 0 };
for (const e of entries) if (e.level) lv[e.level]++;
console.log(`levels: intro ${lv.I} · core ${lv.C} · advanced ${lv.A}\n`);

for (const k of viewKeys) {
  const view = viewOf(categories, k);
  const mark = k === categories.views.default ? ' (default)' : '';
  console.log(`${view.name}${mark}`);
  for (const g of groupEntries(entries, view)) {
    console.log(`  ${String(g.items.length).padStart(4)}  ${g.name}   [I ${g.levels.I} · C ${g.levels.C} · A ${g.levels.A}]`);
    if (list && k === categories.views.default) for (const e of g.items) console.log(`          ${e.level || '?'} ${e.topic.padEnd(5)} ${e.title}`);
  }
  console.log('');
}

// Editorial references
const refs = [
  ['lead', editorial.lead.url],
  ...editorial.path.steps.map((s, i) => [`path step ${i + 1}`, s.url]),
  ...editorial.picks.items.map((s, i) => [`pick ${i + 1}`, s.url]),
  ...editorial.archive.items.map((u, i) => [`archive ${i + 1}`, u]),
];
for (const [where, u] of refs) if (!byUrl.has(u)) problems.push(`editorial ${where} points at a URL not in data.json: ${u}`);

if (untagged.length) {
  console.log('Untagged (shown as unreviewed on the site):');
  for (const e of untagged) console.log(`  ${e.title}  ${e.url}`);
}
if (stale.length) {
  console.log(`\n${stale.length} tagged URLs are no longer in the doc (harmless, can be removed):`);
  for (const u of stale) console.log(`  ${u}`);
}
if (problems.length) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`\nOK: ${refs.length} editorial references resolve, ${viewKeys.length} views are complete.`);
