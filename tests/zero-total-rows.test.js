// ==================== A ROW OF ZEROS IS NOT A ROW OF THE REPORT ====================
// Run: node tests/zero-total-rows.test.js
//
// What this holds: NAP's aging table, LCP's aging table and LCP's impact table must not draw a
// row whose figures are all zero, and when that filter leaves NOTHING they must say so in words
// ("No Pending NAP Ticket." / "No Pending LCP Ticket.") instead of drawing a TOTAL line whose
// every figure is zero.
//
// Why it exists: the sheet bands behind these tables are fixed — code.gs reads NAP A2:F19, LCP
// aging A24:F39, LCP impact A2:F18 — and the server drops a row only when its AREA cell is
// blank. An area with nothing pending is not blank: it reads back 0/0/0/0. So a quiet day put a
// line of zeros under AREA/PROVINCE that an operator reads as a count, and the meantime the
// widened bands also surface label rows ("AREA", "<24HOURS", …) whose numeric cells parse to
// zero — the same filter disposes of those.
//
// The load-bearing detail is what the guard tests. It is the COMPUTED total, never row.T: both
// modules replace a zero/blank TOTAL cell with the sum of the components (`row.T || h + d1 +
// d3`), so a row left blank in the TOTAL column while it still carries 24-hour counts stays a
// row of this report. A later edit that shortens this to `row.T !== 0` would silently delete
// real rows on exactly the days the sheet's formula is missing, which is why one case below
// pins it.
//
// The keep rule from 3.9.24 is untouched by all of this: the empty state IS a drawn screen, so a
// refresh that fails after it keeps it. The last two cases hold that seam.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* The page's own module-state helpers are loaded FOR REAL: showModuleLoading / hideModuleLoading
   live in index.html next to the tabs, and the keep-rule cases below drive them for real. The
   slice is bounded by two structural anchors, so it fails loudly if either moves. */
const PAGE_HELPERS = (() => {
  const html = read('index.html');
  const from = html.indexOf('var MODULE_LOADING_LABELS');
  const to = html.indexOf('// ==================== CLIPBOARD COPY ====================');
  assert.ok(from !== -1, 'index.html no longer defines MODULE_LOADING_LABELS');
  assert.ok(to > from, 'the clipboard section no longer follows the module-state helpers');
  return html.slice(from, to);
})();

/* ------------------------------------------------------------------ *
   A fake DOM, sized to the queries the two modules actually make
 * ------------------------------------------------------------------ */

function el(tag, className) {
  return {
    tagName: String(tag || 'div').toUpperCase(),
    className: className || '',
    id: '',
    innerHTML: '',
    textContent: '',
    attrs: {},
    children: [],
    parentNode: null,
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    insertBefore(child) { child.parentNode = this; this.children.push(child); return child; },
    remove() {
      if (!this.parentNode) return;
      const i = this.parentNode.children.indexOf(this);
      if (i !== -1) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    querySelector(sel) { const hits = this.querySelectorAll(sel); return hits.length ? hits[0] : null; },
    querySelectorAll(sel) {
      let tag = null;
      let cls = String(sel).trim();
      const dot = cls.indexOf('.');
      if (dot === 0) cls = cls.slice(1);
      else if (dot > 0) { tag = cls.slice(0, dot).toUpperCase(); cls = cls.slice(dot + 1); }
      return this.children.filter(
        (c) => (!tag || c.tagName === tag) && c.className.split(/\s+/).indexOf(cls) !== -1
      );
    }
  };
}

/* A read plan: one entry per fetchGate.run call, in order. A missing entry is a bug in the test
   rather than a silent success, so it rejects loudly. */
function reader(plan) {
  const calls = [];
  const fn = (type, url) => {
    calls.push({ type, url });
    const step = plan.shift();
    if (!step) return Promise.reject(new Error('the test planned no read for call ' + calls.length));
    return step.error ? Promise.reject(step.error) : Promise.resolve(step.data);
  };
  fn.calls = calls;
  return fn;
}

/* The shape a real failure arrives in after the 5 s stall rule. */
const STALLED = new Error('Failed after 1 attempt (origin stalled 7500ms, budget not spent): '
  + 'https://example.test/exec?type=nap (HTTP 500)');

function sandbox() {
  const tabs = { nap: el('div', 'tab-content'), lcp: el('div', 'tab-content') };
  const nodes = {
    'tab-nap': tabs.nap,
    'tab-lcp': tabs.lcp,
    napTableBody: el('tbody'),
    lcpAgingTableBody: el('tbody'),
    lcpImpactTableBody: el('tbody'),
    card24: el('div'), card13: el('div'), card3: el('div'), cardTotal: el('div'),
    lcpCard24: el('div'), lcpCard13: el('div'), lcpCard3: el('div'),
    lcpCardTT: el('div'), lcpCardLCP: el('div'), lcpCardClients: el('div')
  };

  /* Both modules insert their export toolbar before the tab's .table-card, so each tab needs
     one whose parentNode is the tab — otherwise the toolbar path is skipped and the suite would
     be asserting a screen the browser never builds. */
  const cards = { nap: el('div', 'table-card'), lcp: el('div', 'table-card') };
  tabs.nap.appendChild(cards.nap);
  tabs.lcp.appendChild(cards.lcp);

  /* console.error is CAPTURED, not let through: the keep-rule cases drive failures on purpose. */
  const logs = [];
  const sink = (...args) => { logs.push(args); };
  let tickerCalls = 0;

  const s = {
    console: { log: sink, error: sink, warn: sink, info: sink },
    BASE_API_URL: 'https://example.test/exec',
    dataCache: { nap: null, lcp: null, olt: null, node: null, backbone: null },
    _isInitialLoad: true,
    hideLoader: () => {},
    prefetchOtherTabsInBackground: () => {},
    sanitizeHTML: (v) => String(v),
    getBadgeHtml: (v) => String(v),
    iconMarkup: () => '',
    document: {
      createElement: (tag) => el(tag),
      getElementById: (id) => nodes[id] || null,
      querySelector: () => null,
      querySelectorAll: () => []
    },
    fetchGate: {
      run: () => Promise.reject(new Error('the test never installed a read')),
      fetchQueued: () => Promise.resolve(null),
      refreshTicker: () => { tickerCalls++; }
    }
  };
  /* In a vm sandbox the context object IS the global, so `window` pointing back at it is what
     makes `window.fetchGate` the same object the modules call. */
  s.window = s;
  vm.createContext(s);
  vm.runInContext(PAGE_HELPERS, s, { filename: 'index.html (module state helpers)' });
  vm.runInContext(read('nap-module.js'), s, { filename: 'nap-module.js' });
  vm.runInContext(read('lcp-module.js'), s, { filename: 'lcp-module.js' });

  s.__nodes = nodes;
  s.__tab = (name) => tabs[name];
  s.__logs = logs;
  s.__tickerCalls = () => tickerCalls;
  /* The fake DOM stores innerHTML as text rather than parsing it, so the toolbar is checked by
     looking at the element the modules insert and the markup they put in it. */
  s.__exportBar = (name) => tabs[name].querySelector('.export-toolbar');
  return s;
}

/* ------------------------------------------------------------------ *
   Rows, as the sheets hand them over
 * ------------------------------------------------------------------ */

function napRow(province, counts) {
  const c = counts || { H: 4, D1: 1, D3: 0, T: 5 };
  return { A: 'LUZON', P: province || 'BENGUET', H: c.H, D1: c.D1, D3: c.D3, T: c.T };
}
const zeroNapRow = (province) => ({ A: 'LUZON', P: province, H: 0, D1: 0, D3: 0, T: 0 });

function lcpAgingRow(province, counts) {
  const c = counts || { H: 2, D1: 3, D3: 1, T: 6 };
  return { A: 'LUZON', P: province || 'BENGUET', H: c.H, D1: c.D1, D3: c.D3, T: c.T };
}
const zeroLcpAgingRow = (province) => ({ A: 'LUZON', P: province, H: 0, D1: 0, D3: 0, T: 0 });

function lcpImpactRow(province, counts) {
  const c = counts || { TT: 3, LCP: 2, C: 40 };
  return { A: 'LUZON', P: province || 'BENGUET', TT: c.TT, LCP: c.LCP, C: c.C };
}
const zeroLcpImpactRow = (province) => ({ A: 'LUZON', P: province, TT: 0, LCP: 0, C: 0 });

const rowCount = (html) => (html.match(/<tr/g) || []).length;

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); }, (err) => {
    failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message);
  });
}

(async () => {
  console.log('\nA row of zeros is not a row of the report\n');

  /* ---------------------------------------------------------------- *
     NAP
   * ---------------------------------------------------------------- */

  await test('NAP: a zero-total row is not drawn while its neighbours are', () => {
    const s = sandbox();
    s.renderNapReport([napRow('BENGUET'), zeroNapRow('IFUGAO')]);

    const html = s.__nodes.napTableBody.innerHTML;
    assert.ok(html.indexOf('BENGUET') !== -1, 'the area with something pending is still a row');
    assert.strictEqual(html.indexOf('IFUGAO'), -1,
      'the area with nothing pending is not: drawing it put a line of zeros under AREA/PROVINCE');
  });

  await test('NAP: the dropped rows add nothing to the totals or the cards', () => {
    const s = sandbox();
    s.renderNapReport([
      napRow('BENGUET', { H: 4, D1: 1, D3: 0, T: 5 }),
      zeroNapRow('IFUGAO'),
      napRow('ABRA', { H: 2, D1: 0, D3: 1, T: 3 })
    ]);

    const html = s.__nodes.napTableBody.innerHTML;
    assert.ok(html.indexOf('class="total-row"') !== -1, 'a draw with rows still ends in TOTAL');
    /* A real DOM coerces textContent to a string on the way in; the fake keeps the number, so
       both sides go through String() and the assertion stays about the value. */
    assert.strictEqual(String(s.__nodes.card24.textContent), '6', '<24HOURS comes only from the kept rows');
    assert.strictEqual(String(s.__nodes.card13.textContent), '1', '1-3 DAYS likewise');
    assert.strictEqual(String(s.__nodes.card3.textContent), '1', 'and >3DAYS');
    assert.strictEqual(String(s.__nodes.cardTotal.textContent), '8', 'the grand total too');
    assert.strictEqual(rowCount(html), 3, 'two rows of data plus the TOTAL line, nothing else');
  });

  await test('NAP: every row zero is answered in words, with no TOTAL line under it', () => {
    const s = sandbox();
    s.renderNapReport([zeroNapRow('BENGUET'), zeroNapRow('IFUGAO')]);

    const html = s.__nodes.napTableBody.innerHTML;
    assert.strictEqual(rowCount(html), 1, 'one row, and it is not a data row');
    assert.ok(html.indexOf('No Pending NAP Ticket.') !== -1, 'the table says what the quiet means');
    assert.strictEqual(html.indexOf('total-row'), -1,
      'no TOTAL line: every figure under it would be zero, which is the thing being reported');
    assert.strictEqual(html.indexOf('class="table-empty-row"') !== -1, true,
      'the line carries the class the stylesheet centres and mutes');
    assert.strictEqual(String(s.__nodes.cardTotal.textContent), '0', 'the cards still read zero, not blank');
  });

  await test('NAP: the guard is the computed total — a blank TOTAL cell with counts is kept', () => {
    const s = sandbox();
    /* The sheet's own TOTAL formula can be absent or zero on a row that still has counts. Both
       modules already fall back to the component sum, and the filter must not undo that: a
       `row.T !== 0` guard would delete these rows on exactly the days the formula is missing. */
    s.renderNapReport([{ A: 'LUZON', P: 'IFUGAO', H: 3, D1: 0, D3: 0, T: 0 }]);

    const html = s.__nodes.napTableBody.innerHTML;
    assert.ok(html.indexOf('IFUGAO') !== -1, 'a row carrying 24-hour counts is a row of this report');
    assert.strictEqual(String(s.__nodes.card24.textContent), '3', 'and its counts reach the cards');
    assert.strictEqual(html.indexOf('No Pending NAP Ticket.'), -1, 'so this is not the empty state');
  });

  await test('NAP: a label row from the widened band is dropped as well', () => {
    const s = sandbox();
    /* The bands are fixed, so a sheet header inside A2:F19 arrives with a non-blank AREA cell —
       which is the only thing code.gs filters on. Its numeric cells parse to zero, so the same
       rule disposes of it. */
    s.renderNapReport([
      { A: 'AREA', P: 'PROVINCE', H: '<24HOURS', D1: '1-3 DAYS', D3: '>3DAYS', T: 'TOTAL' },
      napRow('BENGUET')
    ]);

    const html = s.__nodes.napTableBody.innerHTML;
    assert.strictEqual(html.indexOf('PROVINCE'), -1, 'the header row is not drawn as data');
    assert.ok(html.indexOf('BENGUET') !== -1, 'while the real row is');
  });

  await test('NAP: the empty state is a drawn screen — a later failure keeps it', async () => {
    const s = sandbox();
    s.renderNapReport([zeroNapRow('BENGUET')]);
    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf('No Pending NAP Ticket.') !== -1);

    /* 3.9.24's rule is "a failed refresh keeps whatever the tab has drawn", and this screen is
       something it has drawn. Repainting it as an error would be the same defect in a new suit. */
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNapData(true);

    const html = s.__nodes.napTableBody.innerHTML;
    assert.ok(html.indexOf('No Pending NAP Ticket.') !== -1, 'the keep rule still holds over it');
    assert.strictEqual(html.indexOf('Error loading data'), -1, 'a failure does not overwrite it');
  });

  await test('NAP: a FIRST read that fails still says the read failed', async () => {
    const s = sandbox();
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNapData(true);

    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf('Error loading data') !== -1,
      'the empty state is for a read that answered, not for one that never did');
  });

  /* ---------------------------------------------------------------- *
     LCP — aging
   * ---------------------------------------------------------------- */

  await test('LCP aging: a zero-total row is not drawn, and the totals ignore it', () => {
    const s = sandbox();
    s.renderLcpReport(
      [lcpAgingRow('BENGUET', { H: 2, D1: 3, D3: 1, T: 6 }), zeroLcpAgingRow('IFUGAO')],
      []
    );

    const html = s.__nodes.lcpAgingTableBody.innerHTML;
    assert.ok(html.indexOf('BENGUET') !== -1, 'the real row is drawn');
    assert.strictEqual(html.indexOf('IFUGAO'), -1, 'the row of zeros is not');
    assert.ok(html.indexOf('class="total-row"') !== -1, 'and the TOTAL line stands over the real rows');
    assert.strictEqual(String(s.__nodes.lcpCard24.textContent), '2', '<24HOURS from the kept rows');
    assert.strictEqual(String(s.__nodes.lcpCard13.textContent), '3', '1-3 DAYS');
    assert.strictEqual(String(s.__nodes.lcpCard3.textContent), '1', '>3DAYS');
  });

  await test('LCP aging: nothing left is answered with "No Pending LCP Ticket."', () => {
    const s = sandbox();
    s.renderLcpReport([zeroLcpAgingRow('BENGUET'), zeroLcpAgingRow('IFUGAO')], []);

    const html = s.__nodes.lcpAgingTableBody.innerHTML;
    assert.strictEqual(rowCount(html), 1, 'one row, the empty state');
    assert.ok(html.indexOf('No Pending LCP Ticket.') !== -1, 'it says what the quiet means');
    assert.strictEqual(html.indexOf('total-row'), -1, 'and it is not a TOTAL line of zeros');
    assert.strictEqual(String(s.__nodes.lcpCard24.textContent), '0', 'the cards still read zero');
  });

  await test('LCP aging: the guard is the computed total here too', () => {
    const s = sandbox();
    s.renderLcpReport([{ A: 'LUZON', P: 'ABRA', H: 0, D1: 0, D3: 2, T: 0 }], []);

    const html = s.__nodes.lcpAgingTableBody.innerHTML;
    assert.ok(html.indexOf('ABRA') !== -1, 'counts in a component keep the row');
    assert.strictEqual(String(s.__nodes.lcpCard3.textContent), '2', 'and they reach the cards');
  });

  /* ---------------------------------------------------------------- *
     LCP — impact
   * ---------------------------------------------------------------- */

  await test('LCP impact: a row of zeros is dropped, the rest kept, TOTAL drawn', () => {
    const s = sandbox();
    s.renderLcpReport([], [
      lcpImpactRow('BENGUET', { TT: 3, LCP: 2, C: 40 }),
      zeroLcpImpactRow('IFUGAO')
    ]);

    const html = s.__nodes.lcpImpactTableBody.innerHTML;
    assert.ok(html.indexOf('BENGUET') !== -1, 'the real row is drawn');
    assert.strictEqual(html.indexOf('IFUGAO'), -1, 'the row of zeros is not');
    assert.ok(html.indexOf('class="total-row"') !== -1, 'TOTAL stands over the rows that survived');
    assert.strictEqual(rowCount(html), 2, 'one row of data plus TOTAL');
    assert.strictEqual(String(s.__nodes.lcpCardClients.textContent), '40', 'CLIENTS from the kept rows');
    assert.strictEqual(String(s.__nodes.lcpCardTT.textContent), '3', 'likewise TT');
    assert.strictEqual(String(s.__nodes.lcpCardLCP.textContent), '2', 'and LCP');
  });

  await test('LCP impact: this table has no TOTAL column, so all three figures decide', () => {
    const s = sandbox();
    /* A row with one non-zero figure is still a row of the report — the filter must not be a
       clients-only check, which would drop a ticket line whose client count is still unknown. */
    s.renderLcpReport([], [
      { A: 'LUZON', P: 'IFUGAO', TT: 0, LCP: 0, C: 0 },
      { A: 'LUZON', P: 'ABRA', TT: 1, LCP: 0, C: 0 }
    ]);

    const html = s.__nodes.lcpImpactTableBody.innerHTML;
    assert.strictEqual(html.indexOf('IFUGAO'), -1, 'all three zero is nothing to report');
    assert.ok(html.indexOf('ABRA') !== -1, 'one figure set is something to report');
  });

  await test('LCP impact: an all-zero table is the same words, colspan and all', () => {
    const s = sandbox();
    s.renderLcpReport([], [zeroLcpImpactRow('BENGUET')]);

    const html = s.__nodes.lcpImpactTableBody.innerHTML;
    assert.strictEqual(rowCount(html), 1, 'one row, the empty state');
    assert.ok(html.indexOf('No Pending LCP Ticket.') !== -1, 'and it says so');
    assert.ok(html.indexOf('colspan="5"') !== -1, 'five columns in this table, not six');
    assert.strictEqual(html.indexOf('total-row'), -1, 'no TOTAL line of zeros');
    assert.strictEqual(String(s.__nodes.lcpCardClients.textContent), '0', 'CLIENTS reads zero');
  });

  await test('LCP impact: an EMPTY payload reaches the same screen', () => {
    const s = sandbox();
    /* This used to be guarded by `impactData.length > 0`, which suppressed the TOTAL line and
       left the table blank. The decision now belongs to the rows that survived the filter. */
    s.renderLcpReport([], []);

    const html = s.__nodes.lcpImpactTableBody.innerHTML;
    assert.ok(html.indexOf('No Pending LCP Ticket.') !== -1, 'an empty payload is the same answer');
    assert.strictEqual(html.indexOf('total-row'), -1, 'and there is still no line of zeros');
  });

  /* ---------------------------------------------------------------- *
     What must NOT have changed
   * ---------------------------------------------------------------- */

  await test('the export toolbar and the freshness ticker survive every path', () => {
    const s = sandbox();
    s.renderNapReport([zeroNapRow('BENGUET')]);
    s.renderLcpReport([zeroLcpAgingRow('BENGUET')], [zeroLcpImpactRow('BENGUET')]);

    const napBar = s.__exportBar('nap');
    const lcpBar = s.__exportBar('lcp');
    assert.ok(napBar, 'NAP still gets its export toolbar, even over an empty table');
    assert.ok(lcpBar, 'and so does LCP');
    assert.ok(napBar.innerHTML.indexOf('Export CSV') !== -1 && napBar.innerHTML.indexOf('Export PDF') !== -1,
      'both buttons are there');
    assert.ok(lcpBar.innerHTML.indexOf('Export CSV') !== -1, 'on the LCP side too');
    /* The chip is what tells the reader how old this screen is; an empty state is still a screen
       with an age, so the ticker is refreshed on it like any other draw. */
    assert.ok(s.__tickerCalls() >= 2, 'the ticker is refreshed for both tabs');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
