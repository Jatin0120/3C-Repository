// The front page: cover story, picks, and the topic index grid.
// ?view=fields|rings|roles picks the grouping; #t=CODE selects a tile.

import { buildEntries, viewOf } from './model.js';
import { setupThemeToggle } from './theme.js';

const LEVEL_NAME = { I: 'Intro', C: 'Core', A: 'Advanced' };
const LEVEL_RANK = { I: 0, C: 1, A: 2 };

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
};

let categories, editorial, entries, byUrl, stats, numberOf;
let viewKey = new URLSearchParams(location.search).get('view') || '';
let selected = (location.hash.match(/^#t=([A-Z]+)$/) || [])[1] || '';

// ---------- Derived data ----------

/** Per-topic entry counts, level split and a "read first" list (intro first, then doc order). */
function topicStats() {
  const s = {};
  for (const code of Object.keys(categories.topics)) s[code] = { n: 0, I: 0, C: 0, A: 0, items: [] };
  for (const e of entries) {
    const t = s[e.topic];
    if (!t) continue;
    t.n++;
    if (e.level) t[e.level]++;
    t.items.push(e);
  }
  for (const t of Object.values(s)) {
    t.items.sort((a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3) || a.order - b.order);
  }
  return s;
}

/** Topic numbers 01-26 follow the default view's order, and stay fixed when the view changes. */
function topicNumbers() {
  const def = viewOf(categories, categories.views.default);
  const m = {};
  def.groups.flatMap(g => g.topics).forEach((code, i) => { m[code] = String(i + 1).padStart(2, '0'); });
  return m;
}

const tier = n => (n >= 22 ? 4 : n >= 13 ? 3 : n >= 8 ? 2 : 1);

// ---------- Rendering ----------

function renderLead() {
  const lead = editorial.lead;
  const h = $('lead-h');
  const at = lead.accent ? lead.headline.indexOf(lead.accent) : -1;
  h.replaceChildren(...(at >= 0
    ? [lead.headline.slice(0, at), el('em', {}, lead.accent), lead.headline.slice(at + lead.accent.length)]
    : [lead.headline]));
  $('lead-kicker').textContent = lead.kicker;
  $('lead-dek').textContent = lead.dek;
  $('lead-cta').href = lead.url;
  $('lead-cta').textContent = `${lead.cta || 'Read it'} →`;

  const picks = editorial.picks.items.slice(0, 4).map(p => byUrl.get(p.url)).filter(Boolean);
  $('inside').replaceChildren(...picks.map(e => el('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer' },
    el('span', { class: 'label red' }, categories.topics[e.topic].name),
    el('span', { class: 'inside__title' }, e.title))));
}

function renderIndex() {
  const view = viewOf(categories, viewKey);
  $('view-note').textContent = `${view.name}: ${view.desc} Darker tiles hold more entries.`;
  $('view-chips').replaceChildren(...Object.entries(categories.views)
    .filter(([k]) => k !== 'default')
    .map(([k, v]) => el('button', {
      type: 'button', 'aria-pressed': String(view.key === k), title: v.bestFor,
      onclick: () => {
        viewKey = k === categories.views.default ? '' : k;
        const p = new URLSearchParams(location.search);
        if (viewKey) p.set('view', viewKey); else p.delete('view');
        history.replaceState(null, '', (p.toString() ? `?${p}` : location.pathname) + location.hash);
        renderIndex();
      },
    }, v.name.replace(' around the core', ''))));

  $('groups').replaceChildren(...view.groups.map(g => {
    const n = g.topics.reduce((s, c) => s + stats[c].n, 0);
    return el('div', { class: 'group' },
      el('div', { class: 'group__head' },
        el('h3', { class: 'display' }, g.name),
        el('span', { class: 'label muted' }, `${n} entries`)),
      el('div', { class: 'tiles' }, g.topics.map(code => tile(code, g.name))));
  }));
  renderStory(view);
}

function tile(code, groupName) {
  const t = stats[code];
  const name = categories.topics[code].name;
  return el('button', {
    type: 'button', class: `tile tile--${tier(t.n)}`, 'aria-pressed': String(code === selected),
    'aria-label': `${numberOf[code]} ${name}, ${t.n} entries in ${groupName}`,
    onclick: () => {
      selected = code;
      history.replaceState(null, '', `${location.search || location.pathname}#t=${code}`);
      renderIndex();
      $('story').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  },
    el('span', { class: 'tile__top' },
      el('span', { class: 'display tile__num' }, numberOf[code]),
      el('span', { class: 'tile__n' }, String(t.n))),
    el('span', { class: 'tile__name' }, name),
    el('span', { class: 'bar', 'aria-hidden': 'true' },
      el('span', { class: 'i', style: `flex: ${t.I} 1 0` }),
      el('span', { class: 'c', style: `flex: ${t.C} 1 0` }),
      el('span', { class: 'a', style: `flex: ${t.A} 1 0` })));
}

function renderStory(view) {
  const story = $('story');
  if (!selected || !stats[selected]) { story.replaceChildren(); story.hidden = true; return; }
  story.hidden = false;
  const t = stats[selected];
  const topic = categories.topics[selected];
  const group = view.groups.find(g => g.topics.includes(selected));
  story.replaceChildren(
    el('div', { class: 'story__main' },
      el('span', { class: 'label red' }, `Topic ${numberOf[selected]} · ${group ? group.name : ''}`),
      el('h2', { class: 'display' }, topic.name),
      el('p', { class: 'story__blurb' }, topic.blurb),
      el('div', { class: 'chips label' },
        el('span', {}, `${t.n} entries`),
        el('span', {}, `${t.I} intro`),
        el('span', {}, `${t.C} core`),
        el('span', { class: 'solid' }, `${t.A} advanced`))),
    el('div', { class: 'readfirst' },
      el('span', { class: 'label readfirst__head' }, 'Read first'),
      t.items.slice(0, 3).map(e => el('a', { class: 'item', href: e.url, target: '_blank', rel: 'noopener noreferrer' },
        el('span', { class: 'label muted' }, `${LEVEL_NAME[e.level] || 'New'} · ${e.host}`),
        el('span', {}, e.title))),
      el('a', { class: 'all', href: `library.html?topic=${selected}` }, `ALL ${t.n} ENTRIES →`)));
}

// ---------- Boot ----------

async function load() {
  setupThemeToggle($('theme-toggle'));
  try {
    const [data, cats, ed, thumbs] = await Promise.all(
      ['data.json', 'categories.json', 'editorial.json', 'thumbnails.json'].map(f => fetch(f).then(r => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); })));
    categories = cats;
    editorial = ed;
    entries = buildEntries(data, cats, thumbs);
    byUrl = new Map(entries.map(e => [e.url, e]));
    stats = topicStats();
    numberOf = topicNumbers();
    if (!selected) selected = viewOf(cats, cats.views.default).groups[0].topics[0];
    const updated = data.generatedAt ? new Date(data.generatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
    $('stamp').textContent = `${entries.length} entries · ${Object.keys(cats.topics).length} topics${updated ? ` · updated ${updated}` : ''}`;
    renderLead();
    renderIndex();
  } catch (err) {
    console.error(err);
    $('groups').replaceChildren(el('p', { class: 'muted' }, 'The index could not load. Please try again in a moment.'));
  }
}

load();
