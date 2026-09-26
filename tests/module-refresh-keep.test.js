// ==================== A FAILED REFRESH MUST NOT BLANK THE TABLE ====================
// Run: node tests/module-refresh-keep.test.js
//
// The symptom this suite exists for, reported from the live app by an operator watching it:
// press REFRESH (or let the background interval fire) and NAP's table came up "Error loading
// data." while its stat cards still showed the last read's numbers, and BACKBONE came up
// "All Backbone Links Operational" with zeros — on a tab whose incidents had just been on
// screen. Both are one defect, and the sequence is what makes it visible: the failed cycle's
// screen STAYS until the next success, so the gather chip that follows it appears on top of a
// tab that was already emptied.
//
// Cause: every refresh EMPTIES dataCache before it asks (refreshCurrentTab /
// backgroundRefresh), so a refresh that failed had nothing left to draw and fell through to
// the module's fallback — NAP's error row, BACKBONE's and NODE's ALL-CLEAR. The fix is two
// rules, and both are asserted here:
//
//   1. KEEP. A failed read keeps whatever the tab has already drawn. Those rows are still the
//      last read that answered, and blanking them made the report look empty.
//   2. NEVER INVENT AN ALL-CLEAR. A failure must not render node/backbone's all-clear screen,
//      which claims the fleet is clear AND stamps the current minute as its check time.
//
// LCP and OLT already behaved this way (their catch only logs). These tests hold the line
// where it was just restored rather than for the first time, so a later edit that "improves"
// the error handling by repainting cannot quietly take it away.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* The page's own module-state helpers are loaded FOR REAL rather than stubbed.
   showModuleLoading / hideModuleLoading / showSkeleton / renderModuleUnavailable live in
   index.html next to the tabs they paint, and half of what this suite asks is "did the
   gathering chip come down, and did the tab say anything true" — a stub would only prove the
   stub works. The block is bounded by two structural anchors, so the slice fails loudly if
   either moves, which is also how this suite notices that the helpers were renamed. */
const PAGE_HELPERS = (() => {
  const html = read('index.html');
  const from = html.indexOf('var MODULE_LOADING_LABELS');
  const to = html.indexOf('// ==================== CLIPBOARD COPY ====================');
  assert.ok(from !== -1, 'index.html no longer defines MODULE_LOADING_LABELS');
  assert.ok(to > from, 'the clipboard section no longer follows the module-state helpers');
  return html.slice(from, to);
})();

/* ------------------------------------------------------------------ *
   A fake DOM, sized to the queries the three modules actually make
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

/* The shape a real failure arrives in after the 5 s stall rule: the deployment sat still and the
   attempt was abandoned, so the module is handed a rejection with no envelope and no data. */
const STALLED = new Error('Failed after 1 attempt (origin stalled 7500ms, budget not spent): '
  + 'https://example.test/exec?type=nap (HTTP 500)');

function sandbox(moduleFile) {
  const tabs = { nap: el('div', 'tab-content'), backbone: el('div', 'tab-content'), node: el('div', 'tab-content') };
  const nodes = {
    'tab-nap': tabs.nap,
    'tab-backbone': tabs.backbone,
    'tab-node': tabs.node,
    napTableBody: el('tbody'),
    card24: el('div'), card13: el('div'), card3: el('div'), cardTotal: el('div')
  };

  /* console.error is CAPTURED, not let through: these tests drive failures on purpose, and a
     dozen stack traces in the middle of the run read like a broken suite. Capturing also lets
     one test below insist that keeping the screen did not mean going quiet about why. */
  const logs = [];
  const sink = (...args) => { logs.push(args); };

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
      refreshTicker: () => {}
    }
  };
  /* In a vm sandbox the context object IS the global, so `window` pointing back at it is what
     makes `window.fetchGate` the same object the modules call — the same trick the OLT suites
     use. */
  s.window = s;
  vm.createContext(s);
  vm.runInContext(PAGE_HELPERS, s, { filename: 'index.html (module state helpers)' });
  vm.runInContext(read(moduleFile), s, { filename: moduleFile });

  s.__tab = (name) => tabs[name];
  s.__nodes = nodes;
  s.__chips = (name) => tabs[name].querySelectorAll('.module-loading-screen').length;
  s.__logs = logs;
  return s;
}

function napRow(province) {
  return { A: 'LUZON', P: province || 'BENGUET', H: 4, D1: 1, D3: 0, T: 5 };
}
function bbRow() {
  return { P: 'BENGUET', S: 'DWDM', IS: 'LINK DOWN', I: 'HIGH', L: 'BB-1, BB-2',
           LC: 2, DT: '2h', T: 'T-1', AG: '2h', RM: '' };
}
function nodeRow() {
  return { P: 'IFUGAO', N: 'NODE-A,NODE-B', C: 2, I: 'HIGH', DC: 'FIBER',
           D: '1h', AG: '1h', T: 'T-9', RM: '' };
}

/* A marker written into a tab after a successful draw. Its survival is the only proof that a
   failed refresh did not repaint at all: re-rendering the same rows produces the same bytes, so
   an equality check alone cannot tell the two apart — and for the all-clear screens the
   difference is exactly the re-stamped check time. */
const SENTINEL = '<!--keep-->';
const markTab = (s, name) => { s.__tab(name).innerHTML += SENTINEL; };

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); }, (err) => {
    failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message);
  });
}

(async () => {
  console.log('\nA failed refresh keeps the table\n');

  /* ---------------------------------------------------------------- *
     NAP — the module that answered a failure with an error row
   * ---------------------------------------------------------------- */

  await test('NAP: a refresh that fails keeps the rows already on screen', async () => {
    const s = sandbox('nap-module.js');
    s.fetchGate.run = reader([{ data: [napRow('BENGUET'), napRow('IFUGAO')] }]);
    await s.fetchNapData(true);
    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf('BENGUET') !== -1, 'the first read draws the report');

    s.__nodes.napTableBody.innerHTML += SENTINEL;
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNapData(true);

    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf(SENTINEL) !== -1,
      'the failed refresh did not repaint the table at all');
    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf('BENGUET') !== -1,
      'and the rows it already had are still there');
    assert.strictEqual(s.__nodes.napTableBody.innerHTML.indexOf('Error loading data'), -1,
      'an error line must not replace rows that a real read put there');
  });

  await test('NAP: the keep rule is not a stale cache — the next read still goes to the network', async () => {
    const s = sandbox('nap-module.js');
    s.fetchGate.run = reader([{ data: [napRow()] }]);
    await s.fetchNapData(true);
    assert.ok(s.dataCache.nap, 'the successful read filled the cache');

    s.dataCache.nap = null;                 // what refreshCurrentTab / backgroundRefresh do first
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNapData(true);

    /* Keeping the screen must not be implemented by putting the payload back into dataCache: a
       cache hit renders WITHOUT asking, and "the last good read is still fresh" is exactly the
       claim a failed refresh has no right to make. The refresh contract stays as it was. */
    assert.strictEqual(s.dataCache.nap, null, 'the keep rule did not smuggle the payload back into dataCache');
    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf('BENGUET') !== -1, 'while the screen keeps its rows');
  });

  await test('NAP: the failure is still reported, not swallowed', async () => {
    const s = sandbox('nap-module.js');
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNapData(true);

    /* Keeping the old screen is only honest if the app also says the refresh failed. The
       freshness chip ageing towards stale is one signal; the console naming the reason is the
       other, and a silent catch here would leave a stale table with nothing pointing at it. */
    assert.ok(s.__logs.some((args) => String(args[0]).indexOf('Error fetching NAP data') !== -1),
      'the read that failed is named in the log');
  });

  await test('NAP: a FIRST read that fails has nothing to keep, and says so', async () => {
    const s = sandbox('nap-module.js');
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNapData(true);

    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf('Error loading data') !== -1,
      'a tab that has never drawn anything is the one case where the error row is the honest screen');
  });

  await test('NAP: the gathering chip comes down when the read it announced failed', async () => {
    const s = sandbox('nap-module.js');
    let reject;
    s.fetchGate.run = () => new Promise((_resolve, rejectPromise) => { reject = rejectPromise; });

    const inflight = s.fetchNapData(true);
    assert.strictEqual(s.__chips('nap'), 1, 'the chip is up while the read is in flight');

    reject(STALLED);
    await inflight;
    assert.strictEqual(s.__chips('nap'), 0, 'and it is gone once the read has settled either way');
  });

  await test('NAP: a tab reopened from cache repaints, and a failure after that still keeps it', async () => {
    const s = sandbox('nap-module.js');
    s.fetchGate.run = reader([{ data: [napRow('IFUGAO')] }]);
    await s.fetchNapData(true);

    /* A tab click with a payload still cached draws without asking. That path must not be
       mistaken for "nothing drawn yet", or a failure right after it would blank a table the
       operator had just opened. */
    await s.fetchNapData(false);
    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf('IFUGAO') !== -1, 'the cache draw paints the rows');

    s.dataCache.nap = null;                    // what every refresh does before it asks
    s.__nodes.napTableBody.innerHTML += SENTINEL;
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNapData(true);

    assert.ok(s.__nodes.napTableBody.innerHTML.indexOf(SENTINEL) !== -1, 'and the failed refresh kept them');
  });

  /* ---------------------------------------------------------------- *
     BACKBONE — the module that answered a failure with an all-clear
   * ---------------------------------------------------------------- */

  await test('BACKBONE: a refresh that fails keeps the report on screen', async () => {
    const s = sandbox('backbone-module.js');
    s.fetchGate.run = reader([{ data: [bbRow()] }]);
    await s.fetchBackboneData(true);
    assert.ok(s.__tab('backbone').innerHTML.indexOf('clickable-row') !== -1, 'the first read draws the table');

    markTab(s, 'backbone');
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchBackboneData(true);

    assert.ok(s.__tab('backbone').innerHTML.indexOf(SENTINEL) !== -1, 'the failed refresh did not repaint the tab');
    assert.ok(s.__tab('backbone').innerHTML.indexOf('clickable-row') !== -1, 'the incidents are still listed');
    assert.strictEqual(s.__tab('backbone').innerHTML.indexOf('All Backbone Links Operational'), -1,
      'AND IT MUST NOT BECOME AN ALL-CLEAR: that screen says every link is operational and stamps '
      + 'the current minute as the time it was checked');
    assert.strictEqual(s.__chips('backbone'), 0, 'and the gathering chip comes down');
  });

  await test('BACKBONE: a FIRST read that fails does not invent an all-clear', async () => {
    const s = sandbox('backbone-module.js');
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchBackboneData(true);

    const html = s.__tab('backbone').innerHTML;
    assert.strictEqual(html.indexOf('All Backbone Links Operational'), -1,
      'a read that never completed may not claim the fleet is clear');
    assert.ok(html.indexOf('could not be loaded') !== -1, 'it says what actually happened');
    assert.ok(html.indexOf('page-title-row') !== -1, 'and keeps the row the freshness chip attaches to');
    assert.strictEqual(s.__chips('backbone'), 0, 'and does not leave the gathering chip behind');
  });

  await test('BACKBONE: an all-clear that came from a real read is left exactly as it was', async () => {
    const s = sandbox('backbone-module.js');
    s.fetchGate.run = reader([{ data: [] }]);
    await s.fetchBackboneData(true);
    assert.ok(s.__tab('backbone').innerHTML.indexOf('All Backbone Links Operational') !== -1,
      'an empty answer is exactly what the all-clear screen is for');

    markTab(s, 'backbone');
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchBackboneData(true);

    assert.ok(s.__tab('backbone').innerHTML.indexOf(SENTINEL) !== -1,
      'a failed refresh leaves it alone — repainting it re-stamps its check time to now, '
      + 'which is the same false claim in a quieter form');
  });

  /* ---------------------------------------------------------------- *
     NODE — the same defect, the same two rules
   * ---------------------------------------------------------------- */

  await test('NODE: a refresh that fails keeps the incidents on screen', async () => {
    const s = sandbox('node-module.js');
    s.fetchGate.run = reader([{ data: [nodeRow()] }]);
    await s.fetchNodeData(true);
    assert.ok(s.__tab('node').innerHTML.indexOf('clickable-row') !== -1, 'the first read draws the table');

    markTab(s, 'node');
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNodeData(true);

    assert.ok(s.__tab('node').innerHTML.indexOf(SENTINEL) !== -1, 'the failed refresh did not repaint the tab');
    assert.ok(s.__tab('node').innerHTML.indexOf('clickable-row') !== -1, 'the incidents are still listed');
    assert.strictEqual(s.__tab('node').innerHTML.indexOf('All Node Systems Operational'), -1,
      'and a failed read never becomes an all-clear');
  });

  await test('NODE: a FIRST read that fails does not invent an all-clear', async () => {
    const s = sandbox('node-module.js');
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNodeData(true);

    const html = s.__tab('node').innerHTML;
    assert.strictEqual(html.indexOf('All Node Systems Operational'), -1,
      'no claim a read that never completed can support');
    assert.ok(html.indexOf('could not be loaded') !== -1, 'it says what happened instead');
  });

  await test('NODE: an all-clear that came from a real read is left exactly as it was', async () => {
    const s = sandbox('node-module.js');
    s.fetchGate.run = reader([{ data: [] }]);
    await s.fetchNodeData(true);
    assert.ok(s.__tab('node').innerHTML.indexOf('All Node Systems Operational') !== -1);

    markTab(s, 'node');
    s.fetchGate.run = reader([{ error: STALLED }]);
    await s.fetchNodeData(true);

    assert.ok(s.__tab('node').innerHTML.indexOf(SENTINEL) !== -1, 'and a later failure does not repaint it');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
