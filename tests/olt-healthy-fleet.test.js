// Focused client tests for the lazy healthy-OLT drill-down.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'olt-module.js'), 'utf8');
let passed = 0;
let failed = 0;
function test(name, fn) {
  Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); }, (err) => {
    failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message);
  });
}

function sandbox() {
  let requests = 0;
  const s = {
    console,
    BASE_API_URL: 'https://example.test/exec',
    dataCache: { olt: null },
    rawOltData: [],
    fetchGate: { run: () => { requests++; return Promise.resolve({ v: 4, f: ['P', 'M', 'N', 'S'], p: ['BENGUET'], m: ['ITOGON'], meta: { up: 1, total: 1 }, r: [[0, 0, 'OLT-A', 'UP']] }); } },
    document: { getElementById: () => null, querySelector: () => null }
  };
  vm.createContext(s);
  vm.runInContext(source, s, { filename: 'olt-module.js' });
  s.__requests = () => requests;
  return s;
}

console.log('\nOLT healthy fleet\n');

test('UP summary opens without an API request', () => {
  const s = sandbox();
  let renders = 0;
  s.renderHealthyOltFleet = () => { renders++; };
  s.showHealthyOltFleet();
  assert.strictEqual(s.__requests(), 0);
  assert.strictEqual(s.oltView, 'healthy-summary');
  assert.strictEqual(renders, 1);
});

test('Shape 4 decodes into separate healthy-fleet state', () => {
  const s = sandbox();
  const ok = s.applyOltUpPayload({ v: 4, f: ['P', 'M', 'N', 'S'], p: ['BENGUET'], m: ['ITOGON'], meta: { up: 1 }, r: [[0, 0, 'OLT-A', 'UP']] });
  assert.strictEqual(ok, true);
  assert.strictEqual(s.oltUpData[0].N, 'OLT-A');
  assert.strictEqual(s.dataCache.olt, null, 'incident cache must not be overwritten');
});

test('View All Healthy OLTs fetches once and caches the decoded result', async () => {
  const s = sandbox();
  s.renderHealthyOltFleet = () => {};
  await s.loadHealthyOltList();
  await s.loadHealthyOltList();
  assert.strictEqual(s.__requests(), 1);
  assert.strictEqual(s.oltUpLoaded, true);
});

/* The origin can take 40s. A tap arriving mid-fetch must still move the view to the
   list, or the button reads as dead while oltView has already flipped to
   'healthy-list' and the summary is still the thing on screen. */
test('a tap while the fetch is in flight moves the view, and starts no second request', async () => {
  const s = sandbox();
  s.renderHealthyOltFleet = () => {};

  let calls = 0;
  let finish;
  s.fetchGate.run = () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  };

  const inFlight = s.loadHealthyOltList();
  assert.strictEqual(calls, 1);
  assert.strictEqual(s.oltUpLoading, true);

  let rendered = 0;
  s.renderHealthyOltFleet = () => { rendered++; };
  await s.loadHealthyOltList();

  assert.strictEqual(calls, 1, 'the in-flight fetch is re-used, not duplicated');
  assert.strictEqual(rendered, 1, 'but the view still moves — no silent no-op');
  assert.strictEqual(s.oltView, 'healthy-list');

  finish({ v: 4, f: ['P', 'M', 'N', 'S'], p: ['BENGUET'], m: ['ITOGON'], meta: { up: 1 }, r: [[0, 0, 'OLT-X', 'UP']] });
  await inFlight;
  assert.strictEqual(s.oltUpLoaded, true);
  assert.strictEqual(s.oltUpLoading, false);
});

/* ------------------------------------------------------------------ *
   The drill-down must not fight the operator
 * ------------------------------------------------------------------ */

/* Rebuilding the panel on every keystroke replaced the input that had focus, so a
   search for "NUEVA" lost the caret after the first letter. This is the guard: a
   search or a page change repaints rows, and never the shell that holds the field. */
test('typing repaints rows, never the shell that owns the search field', () => {
  const s = sandbox();
  let shell = 0;
  let paint = 0;
  s.renderHealthyOltFleet = () => { shell++; };
  s.paintHealthyOltRows = () => { paint++; };

  s.setHealthyOltSearch('BEN');
  assert.strictEqual(shell, 0, 'a search must not rebuild the panel — that is what stole the focus');
  assert.strictEqual(paint, 1);
  assert.strictEqual(s.oltUpQuery, 'BEN');
  assert.strictEqual(s.oltUpPage, 1, 'a new search starts on page 1');

  s.setHealthyOltPage(4);
  assert.strictEqual(shell, 0, 'paging must not rebuild it either');
  assert.strictEqual(paint, 2);
  assert.strictEqual(s.oltUpPage, 4);
});

/* A search term can contain a quote. It is written as a property, so it can never
   leave the value="…" it would otherwise be interpolated into. */
test('the list shell never interpolates the query into markup', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'olt-module.js'), 'utf8');
  assert.ok(src.includes("searchEl.value = oltUpQuery"),
    'the query belongs on the element, not in the HTML');
  assert.ok(!/value="\$\{[^}]*oltUpQuery/.test(src),
    'the query must not be interpolated into a value attribute');
});

/* The drill-down borrows the dashboard's components rather than styling a second
   visual language beside it, which is also how it inherits the dark-mode glass. */
test('the list uses the theme search bar and the theme debounce helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'olt-module.js'), 'utf8');
  assert.ok(src.includes('class="search-bar-container"'), 'theme search wrapper');
  assert.ok(src.includes('class="search-input"'), 'theme search input');
  assert.ok(src.includes('class="search-count"'), 'theme live count');
  assert.ok(src.includes("debounce('olt-healthy-search'"), 'the theme debounce helper');
  assert.ok(!src.includes('healthy-olt-search'), 'the bespoke field must be gone');
  assert.ok(src.includes('class="stat-card c-green"'), 'the summary reuses the stat tiles');
  assert.ok(src.includes('class="bar-chart-track"'), 'the share bar reuses the chart bar');
});

/* ------------------------------------------------------------------ *
   Pagination and filtering, driven through the real code
 * ------------------------------------------------------------------ */

function listSandbox(rows) {
  const nodes = {};
  ['healthyOltListBody', 'healthyOltSearchCount', 'healthyOltListRange', 'healthyOltListPager', 'healthyOltExport']
    .forEach((id) => { nodes[id] = makeEl(id); });

  // Ang CSV ay dinaanan ng Blob, kaya dito ito nakukuha para masuri.
  let csv = null;
  let download = null;
  const s = {
    console: console,
    BASE_API_URL: 'https://example.test/exec',
    dataCache: { olt: null },
    rawOltData: [],
    fetchGate: { run: () => Promise.resolve(null) },
    sanitizeHTML: (v) => String(v),
    Blob: function (parts) { csv = parts.join(''); },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => {} },
    document: {
      getElementById: (id) => nodes[id] || null,
      querySelector: () => null,
      createElement: () => ({ href: '', download: '', click: function () { download = this.download; } })
    }
  };
  vm.createContext(s);
  vm.runInContext(source, s, { filename: 'olt-module.js' });
  s.oltUpData = rows;
  s.oltUpLoaded = true;
  s.__nodes = nodes;
  s.__csv = () => csv;
  s.__download = () => download;
  return s;
}

test('a page holds 50 rows and paging clamps instead of blanking the table', () => {
  const rows = [];
  for (let i = 1; i <= 130; i++) rows.push({ P: i % 2 ? 'BENGUET' : 'IFUGAO', M: 'MUN' + i, N: 'OLT-' + i });
  const s = listSandbox(rows);
  const n = s.__nodes;
  const rendered = () => n.healthyOltListBody.innerHTML.split('<tr>').length - 1;

  s.setHealthyOltPage(1);
  assert.strictEqual(rendered(), 50, 'a page is capped at 50 rows');
  assert.strictEqual(n.healthyOltListRange.textContent, 'Showing 1\u201350 of 130');
  assert.strictEqual(n.healthyOltSearchCount.textContent, '130 found');
  assert.ok(n.healthyOltListPager.innerHTML.includes('disabled'), 'Previous is disabled on page 1');

  s.setHealthyOltPage(2);
  assert.strictEqual(n.healthyOltListRange.textContent, 'Showing 51\u2013100 of 130');

  s.setHealthyOltPage(99);
  assert.strictEqual(s.oltUpPage, 3, 'a page past the end clamps to the last page');
  assert.strictEqual(rendered(), 30, 'and still renders rows, not a blank table');
});

test('a search narrows the fleet and says so, including when nothing matches', () => {
  const rows = [];
  for (let i = 1; i <= 130; i++) rows.push({ P: i % 2 ? 'BENGUET' : 'IFUGAO', M: 'MUN' + i, N: 'OLT-' + i });
  const s = listSandbox(rows);
  const n = s.__nodes;

  s.setHealthyOltPage(2);
  s.setHealthyOltSearch('BENGUET');
  assert.strictEqual(s.oltUpPage, 1, 'a search from page 2 returns to page 1');
  assert.strictEqual(n.healthyOltSearchCount.textContent, '65 found');
  assert.strictEqual(n.healthyOltListRange.textContent, 'Showing 1\u201350 of 65');

  s.setHealthyOltSearch('benguet');
  assert.strictEqual(n.healthyOltSearchCount.textContent, '65 found', 'the match ignores case');

  s.setHealthyOltSearch('  BENGUET  '); // as a half-typed query arrives, with spaces
  assert.strictEqual(n.healthyOltSearchCount.textContent, '65 found', 'surrounding space is trimmed');

  s.setHealthyOltSearch('ZZZ-nothing-here');
  assert.strictEqual(n.healthyOltSearchCount.textContent, '0 found');
  assert.strictEqual(n.healthyOltListRange.textContent, 'No matching OLTs');
  assert.ok(n.healthyOltListBody.innerHTML.includes('healthy-olt-empty'),
    'the empty state is a themed row, not an inline-styled one');
});

/* ------------------------------------------------------------------ *
   Which OLT view is on screen, and which button says so
 * ------------------------------------------------------------------ */

/* Opening the fleet used to leave the toolbar visible with DOWN still highlighted,
   and the export bar showing, because `hidden` was toggled on flex containers.
   Two things have to hold, and they failed independently: the JS must hide the
   right elements, and `hidden` must actually hide them. This covers the first. */
function makeEl(id, classes) {
  const set = new Set(classes ? classes.split(' ') : []);
  const el = {
    id: id,
    hidden: false,
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    offsetLeft: 0,
    offsetWidth: 0,
    scrollLeft: 0,
    clientWidth: 0,
    attrs: {},
    setAttribute: function (name, value) { this.attrs[name] = value; },
    classList: {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c)
    }
  };
  el.__classes = set;
  return el;
}

function chromeSandbox() {
  const nodes = {
    oltHealthyFleetPanel: makeEl('oltHealthyFleetPanel'),
    oltIssuesTableCard: makeEl('oltIssuesTableCard'),
    oltTableBody: makeEl('oltTableBody'),
    healthyOltListBody: makeEl('healthyOltListBody'),
    healthyOltSearchCount: makeEl('healthyOltSearchCount'),
    healthyOltListRange: makeEl('healthyOltListRange'),
    healthyOltListPager: makeEl('healthyOltListPager'),
    btnFilterUp: makeEl('btnFilterUp'),
    btnFilterDown: makeEl('btnFilterDown', 'active')
  };
  const strip = makeEl('strip');
  const exportBar = makeEl('exportBar', 'export-toolbar');
  const filterBtns = [nodes.btnFilterUp, nodes.btnFilterDown];

  const s = {
    console: console,
    window: { fetchGate: { refreshTicker: () => {} } },
    BASE_API_URL: 'https://example.test/exec',
    dataCache: { olt: null },
    rawOltData: [],
    fetchGate: { run: () => Promise.resolve(null), refreshTicker: () => {} },
    sanitizeHTML: (v) => String(v),
    document: {
      getElementById: (id) => nodes[id] || null,
      querySelector: (sel) => {
        if (sel.indexOf('filter-toolbar') !== -1) return strip;
        if (sel.indexOf('export-toolbar') !== -1) return exportBar;
        return null;
      },
      querySelectorAll: (sel) => (sel.indexOf('filter-btn') !== -1 ? filterBtns : [])
    }
  };
  vm.createContext(s);
  vm.runInContext(source, s, { filename: 'olt-module.js' });
  s.oltMeta = { up: 457, total: 461 };
  s.__nodes = nodes;
  s.__strip = strip;
  s.__exportBar = exportBar;
  return s;
}

test('the healthy view drops the export bar but keeps the toolbar saying UP', () => {
  const s = chromeSandbox();
  s.showHealthyOltFleet();

  assert.strictEqual(s.__nodes.oltHealthyFleetPanel.hidden, false, 'the panel is on screen');
  assert.strictEqual(s.__nodes.oltIssuesTableCard.hidden, true, 'the incident table is not');
  assert.strictEqual(s.__exportBar.hidden, true, 'the export bar exports a table that is not on screen');
  assert.strictEqual(s.__strip.hidden, false, 'the filter strip stays — it is the way back');
  assert.ok(s.__nodes.btnFilterUp.classList.contains('active'), 'UP is the view you are in');
  assert.ok(!s.__nodes.btnFilterDown.classList.contains('active'), 'DOWN must not stay highlighted');
});

test('going back to the overview restores the table, its export bar and DOWN', () => {
  const s = chromeSandbox();
  s.showHealthyOltFleet();
  s.showOltOverview();

  assert.strictEqual(s.__nodes.oltHealthyFleetPanel.hidden, true, 'the fleet panel steps aside');
  assert.strictEqual(s.__nodes.oltIssuesTableCard.hidden, false, 'the incident table returns');
  assert.strictEqual(s.__exportBar.hidden, false, 'and so does its export bar');
  assert.strictEqual(s.__strip.hidden, false);
  assert.ok(s.__nodes.btnFilterDown.classList.contains('active'));
  assert.ok(!s.__nodes.btnFilterUp.classList.contains('active'));
});

/* UP is the last pill in a strip that scrolls sideways on a phone, so the highlight
   can end up off-screen with the strip reading as "nothing selected". The nudge must
   move the strip and never the page. */
test('the highlighted pill is scrolled into the strip, not the page', () => {
  const s = chromeSandbox();
  s.__strip.clientWidth = 200;
  s.__strip.scrollLeft = 0;
  s.__nodes.btnFilterUp.offsetLeft = 300;
  s.__nodes.btnFilterUp.offsetWidth = 60;

  s.showHealthyOltFleet();
  assert.strictEqual(s.__strip.scrollLeft, 160, 'just enough to reveal the pill');
  assert.strictEqual(s.__nodes.btnFilterUp.offsetLeft >= s.__strip.scrollLeft, true,
    'and it is inside the visible part afterwards');

  const src = fs.readFileSync(path.join(__dirname, '..', 'olt-module.js'), 'utf8');
  assert.ok(!/scrollIntoView|\.scrollTo\(/.test(src),
    'opening the fleet must never scroll the dashboard out from under the operator');
});

/* ------------------------------------------------------------------ *
   The fleet's own CSV export
 * ------------------------------------------------------------------ */

/* The point of a separate exporter: the table shows 50 of 457 rows, so reusing the
   incident table's DOM-reading exporter would hand back one page and look complete. */
test('the CSV carries every matching row, not just the page on screen', () => {
  const rows = [];
  for (let i = 1; i <= 130; i++) rows.push({ P: i % 2 ? 'BENGUET' : 'IFUGAO', M: 'MUN' + i, N: 'OLT-' + i });
  const s = listSandbox(rows);
  s.setHealthyOltPage(1);                       // ang listahan ay nasa screen
  const before = s.__nodes.healthyOltListBody.innerHTML.split('<tr>').length - 1;

  s.exportHealthyOltCsv();
  const lines = s.__csv().split('\n');

  assert.strictEqual(before, 50, 'the page holds 50 rows');
  assert.strictEqual(lines[0], '"PROVINCE","MUNICIPALITY","OLT NAME","STATUS"');
  assert.strictEqual(lines.length, 131, 'but the file holds all 130 rows plus the header');
  assert.strictEqual(lines[1], '"BENGUET","MUN1","OLT-1","UP"');
  assert.strictEqual(lines[130], '"IFUGAO","MUN130","OLT-130","UP"');
  assert.ok(String(s.__download()).indexOf('OLT_Healthy_Fleet_') === 0,
    'named like the app\u2019s other exports');
  assert.ok(/\.csv$/.test(String(s.__download())));
});

test('the CSV follows the search and quotes like the rest of the app', () => {
  const rows = [
    { P: 'BENGUET', M: 'ITOGON', N: 'OLT "MAIN", 01' },
    { P: 'IFUGAO', M: 'LAGAWE', N: 'OLT-B' }
  ];
  const s = listSandbox(rows);

  const toasts = [];
  s.showToast = (msg) => toasts.push(msg);

  s.setHealthyOltSearch('BENGUET');
  s.exportHealthyOltCsv();
  const lines = s.__csv().split('\n');

  assert.strictEqual(lines.length, 2, 'only what the search matches');
  assert.strictEqual(lines[1], '"BENGUET","ITOGON","OLT ""MAIN"", 01","UP"',
    'inner quotes doubled, so a comma inside a name cannot break the file');
  assert.deepStrictEqual(toasts, ['CSV exported successfully!'], 'and it says so');
});

test('an empty result writes nothing and quiets the button', () => {
  const s = listSandbox([{ P: 'BENGUET', M: 'ITOGON', N: 'OLT-A' }]);
  s.setHealthyOltPage(1);
  assert.strictEqual(s.__nodes.healthyOltExport.disabled, false);
  assert.strictEqual(s.__nodes.healthyOltExport.title, 'Export 1 listed OLT as CSV');

  s.setHealthyOltSearch('nothing-matches-this');
  assert.strictEqual(s.__nodes.healthyOltExport.disabled, true, 'no rows, no export');
  assert.strictEqual(s.__nodes.healthyOltExport.title, 'Export 0 listed OLTs as CSV');

  s.exportHealthyOltCsv();
  assert.strictEqual(s.__csv(), null, 'and the handler refuses too, not just the button');
});

/* The panel hides "the first .export-toolbar in #tab-olt" when it opens. A second one
   inside the panel would therefore hide itself on arrival. */
test('the fleet export button is not an .export-toolbar', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'olt-module.js'), 'utf8');
  const button = src.slice(src.indexOf('function healthyExportButton_'), src.indexOf('var OLT_UP_CSV_COLUMNS'));
  assert.ok(button.includes('class="export-btn"'), 'it borrows the theme\u2019s export button');
  assert.ok(button.includes('id="healthyOltExport"'), 'and carries its own id');
  assert.ok(!button.includes('export-toolbar'), 'but never the class the panel chrome hides');
});

/* ------------------------------------------------------------------ *
   The stylesheet contract
 * ------------------------------------------------------------------ */

/* A var() naming a token that does not exist is not a style that falls back: the
   whole declaration is dropped, so a shadow disappears and a colour silently
   becomes whatever was inherited. Three of them shipped in the first pass. */
test('every token the healthy panel uses is actually defined', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const start = css.indexOf('HEALTHY OLT DRILL-DOWN');
  assert.ok(start !== -1, 'the panel block must exist');
  const end = css.indexOf('DARK MODE SUPPORT', start);
  const block = css.slice(start, end === -1 ? undefined : end);

  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = [...new Set([...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  const missing = used.filter((v) => !defined.has(v));
  assert.deepStrictEqual(missing, [], 'undefined tokens silently drop the declaration');
});

/* White on bright mint is 1.5:1 in dark mode. The fill is stated per mode instead. */
test('the healthy CTA does not paint white on a light-mode text token', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const cta = css.slice(css.indexOf('.healthy-olt-cta {'), css.indexOf('.healthy-olt-cta:hover'));
  assert.ok(/background:\s*#/.test(cta), 'the light fill is an explicit colour');
  assert.ok(!/background:\s*var\(--badge-green-text\)/.test(cta),
    '--badge-green-text is a text token: it is mint in dark mode, where white on it is unreadable');
  assert.ok(/body\.dark-mode \.healthy-olt-cta/.test(css), 'the dark fill is stated too');
});

/* The root cause of the toolbar bug, and the one an attribute check cannot see: an
   author `display: flex` outranks the browser's `[hidden] { display: none }`, so
   `el.hidden = true` is a no-op and the element stays on screen. */
test('the [hidden] attribute actually beats a display:flex container', () => {
  // Comments first: the note above the rule quotes it, and matching that instead of
  // the rule itself is exactly how this test passed on paper while the rule was absent.
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = css.match(/\[hidden\][^{]*\{[^}]*\}/);
  assert.ok(rule, 'there must be a [hidden] rule');
  assert.ok(/display:\s*none\s*!important/.test(rule[0]),
    'without !important, .filter-toolbar and .export-toolbar (both display:flex) stay visible');

  const src = fs.readFileSync(path.join(__dirname, '..', 'olt-module.js'), 'utf8');
  assert.ok(src.includes('exportToolbar.hidden = true'), 'which the OLT module relies on');
});

/* Without this the panel is the one flat opaque card in a screen of blurred ones. */
test('the panel joins the dark-mode frosted-glass family', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const block = css.slice(css.indexOf('body.dark-mode .healthy-olt-panel'), css.indexOf('body.dark-mode .healthy-olt-cta'));
  assert.ok(/backdrop-filter:\s*blur\(/.test(block), 'it must blur like .table-card');
  assert.ok(/rgba\(14, 22, 34, 0\.75\)/.test(block), 'and use the same glass fill');
});

setTimeout(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
}, 20);
