// The library page: search and filter every entry in the doc.
// State lives in the URL (?q=&view=&group=&topic=&level=&format=) so any
// filtered view can be shared as a link.

import { buildEntries, viewOf, groupEntries, search } from './model.js';
import { setupThemeToggle } from './theme.js';

const PAGE = 50;

// The format filter, labelled by what you do with an entry.
const FORMATS = [
  { key: 'Video', act: 'Watch', sub: 'videos & talks' },
  { key: 'Article', act: 'Read', sub: 'articles & notes' },
  { key: 'Code', act: 'Do', sub: 'code to run' },
  { key: 'Course & Book', act: 'Study', sub: 'courses & books' },
  { key: 'Paper', act: 'Papers', sub: 'research papers' },
];
const ACT = Object.fromEntries(FORMATS.map(f => [f.key, f.act]));
const LEVELS = [['I', 'Intro'], ['C', 'Core'], ['A', 'Advanced']];

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
};

let entries = [];
let categories = null;
let state = readState();
let shown = PAGE;

function readState() {
  const p = new URLSearchParams(location.search);
  return {
    q: p.get('q') || '',
    view: p.get('view') || '',
    group: p.get('group') || '',
    topic: p.get('topic') || '',
    level: p.get('level') || '',
    format: p.get('format') || '',
  };
}

function writeState() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v) p.set(k, v);
  const qs = p.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function update(patch) {
  state = { ...state, ...patch };
  shown = PAGE;
  writeState();
  render();
}

// ---------- Filtering ----------

function topicToGroup(view) {
  const m = {};
  for (const g of view.groups) for (const t of g.topics) m[t] = g.id;
  return m;
}

/** Entries matching search, level and format: the base the group/topic filters narrow further. */
function baseMatches() {
  let list = state.q ? search(entries, state.q) : entries;
  if (state.level) list = list.filter(e => e.level === state.level);
  if (state.format) list = list.filter(e => e.format === state.format);
  return list;
}

// ---------- Rendering ----------

function render() {
  const view = viewOf(categories, state.view);
  const t2g = topicToGroup(view);
  // A group or topic left over from another view (or a stale link) is ignored.
  const group = view.groups.find(g => g.id === state.group) || null;
  const topicOk = state.topic && categories.topics[state.topic] && (!group || t2g[state.topic] === group.id);
  const topic = topicOk ? state.topic : '';

  const base = baseMatches();
  const inGroup = group ? base.filter(e => t2g[e.topic] === group.id) : base;
  const results = topic ? inGroup.filter(e => e.topic === topic) : inGroup;

  renderViewChips(view);
  renderGroupChips(view, base, t2g, group);
  renderTopicSelect(view, group, inGroup, topic);
  renderLevelChips();
  renderFormatChips();
  renderResults(results, view, t2g);

  const filtered = state.q || state.group || state.topic || state.level || state.format;
  $('clear').hidden = !filtered;
}

function renderViewChips(view) {
  const box = $('view-chips');
  box.replaceChildren(...Object.entries(categories.views)
    .filter(([k]) => k !== 'default')
    .map(([k, v]) => el('button', {
      type: 'button', 'aria-pressed': String(view.key === k), title: v.desc,
      onclick: () => update({ view: k === categories.views.default ? '' : k, group: '', topic: '' }),
    }, v.name.replace(' around the core', ''))));
}

function renderGroupChips(view, base, t2g, group) {
  const counts = {};
  for (const e of base) counts[t2g[e.topic]] = (counts[t2g[e.topic]] || 0) + 1;
  const chip = (id, name, n, desc) => el('button', {
    type: 'button', class: 'pill', 'aria-pressed': String((group ? group.id : '') === id), title: desc || '',
    onclick: () => update({ group: id, topic: '' }),
  }, el('span', { class: 'pill__main' }, name, ' ', el('span', { class: 'count' }, String(n))));
  $('group-label').textContent = view.name === 'Fields' ? 'Field' : view.name === 'Roles' ? 'Role' : 'Ring';
  $('group-chips').replaceChildren(
    chip('', 'Everything', base.length),
    ...view.groups.map(g => chip(g.id, g.name, counts[g.id] || 0, g.desc)),
  );
}

function renderTopicSelect(view, group, inGroup, topic) {
  const counts = {};
  for (const e of inGroup) counts[e.topic] = (counts[e.topic] || 0) + 1;
  const codes = group ? group.topics : view.groups.flatMap(g => g.topics);
  const sel = $('topic');
  sel.replaceChildren(
    el('option', { value: '' }, group ? `All topics in ${group.name}` : 'All 26 topics'),
    ...codes.map(c => el('option', { value: c, selected: c === topic }, `${categories.topics[c].name} (${counts[c] || 0})`)),
  );
  sel.value = topic;
}

function renderLevelChips() {
  $('level-chips').replaceChildren(
    ...[['', 'All'], ...LEVELS].map(([k, name]) => el('button', {
      type: 'button', 'aria-pressed': String(state.level === k), onclick: () => update({ level: k }),
    }, name)));
}

function renderFormatChips() {
  $('format-chips').replaceChildren(
    ...[{ key: '', act: 'Any', sub: 'all formats' }, ...FORMATS].map(f => el('button', {
      type: 'button', class: 'pill', 'aria-pressed': String(state.format === f.key), onclick: () => update({ format: f.key }),
    }, el('span', { class: 'pill__main' }, f.act), el('span', { class: 'pill__sub' }, f.sub))));
}

function renderResults(results, view, t2g) {
  $('results-count').textContent = `${results.length} ${results.length === 1 ? 'entry' : 'entries'}`;
  const box = $('results');
  if (!results.length) {
    box.replaceChildren(el('p', { class: 'empty' }, 'Nothing matches. Try fewer words, or clear a filter.'));
    $('more').hidden = true;
    return;
  }
  const groupName = Object.fromEntries(view.groups.map(g => [g.id, g.name]));
  box.replaceChildren(...results.slice(0, shown).map(e => resultRow(e, groupName[t2g[e.topic]])));
  $('more').hidden = results.length <= shown;
  $('more').textContent = `Show ${Math.min(PAGE, results.length - shown)} more`;
}

function resultRow(e, groupName) {
  const levelName = e.level ? Object.fromEntries(LEVELS)[e.level] : null;
  const desc = e.summary || e.description;
  const topicName = categories.topics[e.topic] ? categories.topics[e.topic].name : e.topic;
  const linkAttrs = e.url ? { href: e.url, target: '_blank', rel: 'noopener noreferrer' } : {};
  return el('article', { class: 'result' },
    el('div', {},
      el('div', { class: 'result__meta' },
        levelName ? el('span', { class: `lv lv--${e.level}` }, levelName) : null,
        el('span', { class: 'act' }, ACT[e.format] || e.format),
        e.reviewed ? null : el('span', { class: 'unreviewed', title: 'Added to the doc after the last tagging pass' }, 'New · unreviewed'),
      ),
      el('h3', { class: 'result__title' }, e.url ? el('a', linkAttrs, e.title) : e.title),
      desc ? el('p', { class: 'result__desc' }, desc) : null,
      el('div', { class: 'result__where' },
        el('a', { href: `?topic=${encodeURIComponent(e.topic)}`, onclick: ev => { ev.preventDefault(); update({ topic: e.topic, group: '' }); window.scrollTo({ top: 0, behavior: 'smooth' }); } }, topicName),
        groupName ? ` · ${groupName}` : '',
        e.host ? ` · ${e.host}` : ''),
      e.links && e.links.length
        ? el('div', { class: 'result__links' }, e.links.map(l => el('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.label)))
        : null,
    ),
    e.image ? el('img', { class: 'result__thumb', src: e.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: ev => ev.target.remove() }) : null,
  );
}

// ---------- Wiring ----------

function wire() {
  const q = $('q');
  q.value = state.q;
  let timer = null;
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => update({ q: q.value.trim() }), 150); });
  $('search-form').addEventListener('submit', ev => { ev.preventDefault(); clearTimeout(timer); update({ q: q.value.trim() }); });
  $('topic').addEventListener('change', ev => update({ topic: ev.target.value }));
  $('clear').addEventListener('click', () => { q.value = ''; update({ q: '', group: '', topic: '', level: '', format: '' }); });
  $('more').addEventListener('click', () => { shown += PAGE; render(); });
  setupThemeToggle($('theme-toggle'));
}

async function load() {
  try {
    const [data, cats, thumbs] = await Promise.all(
      ['data.json', 'categories.json', 'thumbnails.json'].map(f => fetch(f).then(r => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); })));
    categories = cats;
    entries = buildEntries(data, cats, thumbs);
    const updated = data.generatedAt ? new Date(data.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    $('stamp').textContent = `${entries.length} entries · 26 topics${updated ? ` · updated ${updated}` : ''}`;
    render();
  } catch (err) {
    console.error(err);
    $('results').replaceChildren(el('p', { class: 'empty' }, 'The library could not load. Please try again in a moment.'));
    $('results-count').textContent = 'Unavailable';
  }
}

wire();
load();
