// ==================== ANALYTICS DASHBOARD: SELF-CONTAINED, NO TREND CHARTS ====================
//
// Run: node tests/analytics-dashboard.test.js
//
// The four IndexedDB trend charts (Incidents per Day, OLT Status Trend, Clients Affected Trend,
// Aging Distribution) were removed from the Analytics tab. What is left has to keep working
// while four things that were the charts' only reason to exist are gone with them, and each one
// fails in a way a screenshot would not show:
//
//   1. Chart.js is no longer loaded from a CDN, so the dashboard must render with `Chart`
//      undefined and no network at all. The sandbox below has neither, so a chart call creeping
//      back in is a ReferenceError rather than a blank box nobody notices.
//   2. `getSnapshots()` is not called any more, so the tab must render with no IndexedDB. The
//      sandbox has no `indexedDB` either.
//   3. The DONUT cards borrow `.analytics-charts-row` / `-card` / `-title` / `-body`. Those rules
//      read like the removed feature's own CSS, and deleting them takes the donuts with them —
//      so the classes and the rules are both pinned here.
//   4. The daily snapshot WRITER stays. Removing the reader is not removing the record: the
//      snapshot is captured once a day and never rewritten, and a day that has passed cannot be
//      read out of the sheet again. `saveDailySnapshot()` must still be called on boot.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'analytics-module.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const db = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const lucide = (function loadGeneratedIcons() {
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lucide-icons.js'), 'utf8'), box);
  return box.window.lucide;
})();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

/* The module icons come from index.html's own map, read out of the page rather than copied, so
   the Module Snapshot tiles are drawn with the glyphs the app really uses. */
const MODULE_ICONS = (function readModuleIcons() {
  const m = /const MODULE_ICONS = \{([^}]*)\}/.exec(page);
  assert.ok(m, 'MODULE_ICONS must be readable from index.html');
  const map = {};
  m[1].split(',').forEach((pair) => {
    const kv = /^\s*(\w+)\s*:\s*'([^']+)'\s*$/.exec(pair);
    if (kv) map[kv[1]] = kv[2];
  });
  return map;
})();

/* The whole tab is one innerHTML assignment, so the fake DOM only has to hold a string and the
   four donut targets. Nothing here defines `Chart` or `indexedDB` — that is the point. */
function sandbox() {
  const tab = { innerHTML: '' };
  const donut = () => ({ innerHTML: '', style: {} });
  const nodes = {
    'tab-analytics': tab,
    analyticsOltDonut: donut(),
    analyticsOltLegend: donut(),
    analyticsBbDonut: donut(),
    analyticsBbLegend: donut()
  };

  const s = {
    console: console,
    sanitizeHTML: (v) => String(v),
    iconMarkup: (name, options) => lucide.icon(name, options),
    moduleIconMarkup: (module, options) => lucide.icon(MODULE_ICONS[module], options),
    /* A snapshot of the live shapes: problems only for OLT, with the server's own summary. */
    dataCache: {
      nap: [{ P: 'BENGUET', A: '1-3 DAYS', T: 'T-1' }],
      lcp: { lcpAging: [{ P: 'IFUGAO', A: '>3 DAYS' }], lcpImpact: [] },
      /* '5 days' rather than '2d': the Critical OLT Tickets section only renders when at least
         one row is long-aging, and that section is one of the ones this suite is guarding. */
      olt: [{ S: 'DOWN', P: 'BENGUET', N: 'OLT-1', AG: '5 days', CA: 10 }],
      node: [{ P: 'ABRA', T: 'T-2' }],
      backbone: [{ S: 'DWDM', IS: 'LINK DOWN', P: 'PANGASINAN' }]
    },
    oltMeta: { total: 461, up: 457, down: 1, lowPower: 2, uplinkDown: 1, degradation: 1, clientsDown: 10, clientsSA: 45 },
    document: {
      getElementById: (id) => nodes[id] || null
    }
  };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(source, s, { filename: 'analytics-module.js' });
  s.__tab = tab;
  return s;
}

console.log('\nAnalytics dashboard (no trend charts)\n');

/* ------------------------------------------------------------------ *
   1. It renders at all, with none of the four crutches
 * ------------------------------------------------------------------ */

test('the dashboard renders with no chart library and no IndexedDB in reach', () => {
  const s = sandbox();
  /* If the module still reached for `Chart` or `indexedDB`, this line throws a ReferenceError
     and the suite stops — which is what a tab rendering an empty box in production looks like
     from the outside. */
  s.renderAnalyticsDashboard();

  const html = s.__tab.innerHTML;
  assert.ok(html.length > 500, 'the tab was actually rendered, not left as the stub');
  assert.strictEqual(typeof s.Chart, 'undefined', 'the sandbox never defines the library');
  assert.strictEqual(typeof s.indexedDB, 'undefined', 'nor the snapshot store');
});

test('every section that remains is still on the page', () => {
  const s = sandbox();
  s.renderAnalyticsDashboard();
  const html = s.__tab.innerHTML;

  [
    'Module Snapshot',
    'Aging Timeline (NAP + LCP)',
    'Top Provinces by Incidents',
    'Critical OLT Tickets (Long Aging)',
    'OLT Status Distribution',
    'Backbone Service Type'
  ].forEach((title) => {
    assert.ok(html.indexOf(title) !== -1, title + ' must still render');
  });

  /* Comparison mode is a toggle, so its section is absent from the default render and has to
     be asked for — which also proves the toggle still re-renders a live tab. */
  assert.strictEqual(html.indexOf('Week-over-Week Comparison'), -1,
    'the comparison section is off by default');
  s.toggleAnalyticsComparison();
  assert.ok(s.__tab.innerHTML.indexOf('Week-over-Week Comparison') !== -1,
    'and the Compare Weeks button still brings it back');
});

/* ------------------------------------------------------------------ *
   2. The trend section, and everything that only existed for it
 * ------------------------------------------------------------------ */

test('no trend section survives: no canvases, no placeholder, no heading', () => {
  const s = sandbox();
  s.renderAnalyticsDashboard();
  const html = s.__tab.innerHTML;

  [
    'trendIncidentsChart',
    'trendOltChart',
    'trendClientsChart',
    'trendAgingChart',
    'trendNote',
    'Trend (Last 30 Days)',
    'Incidents per Day',
    'OLT Status Trend',
    'Clients Affected Trend',
    'Aging Distribution'
  ].forEach((token) => {
    assert.strictEqual(html.indexOf(token), -1, token + ' must be gone from the dashboard');
  });
});

test('the module names neither the chart library nor the snapshot store', () => {
  /* Named specifically rather than as the bare word "Chart", which still appears inside the
     `chart-column` icon the Compare Weeks button uses. */
  [
    'new Chart(',
    'loadChartJS',
    '_analyticsCharts',
    'chart.js',
    'cdn.jsdelivr',
    'getSnapshots'
  ].forEach((token) => {
    assert.strictEqual(source.indexOf(token), -1, token + ' must not survive in the module');
  });
  assert.ok(source.indexOf('analytics-charts-row') !== -1,
    'the donut cards still lay out in the shared chart row — only the trend markup went');
});

/* ------------------------------------------------------------------ *
   3. The donut cards, which borrow the removed feature's CSS
 * ------------------------------------------------------------------ */

test('the donut cards keep the chart-row classes, and the stylesheet keeps their rules', () => {
  const s = sandbox();
  s.renderAnalyticsDashboard();
  const html = s.__tab.innerHTML;

  ['.analytics-charts-row', '.analytics-chart-card', '.analytics-chart-title', '.analytics-chart-body']
    .forEach((sel) => {
      const cls = sel.slice(1);
      assert.ok(html.indexOf('"' + cls + '"') !== -1,
        cls + ' is still worn by the donut cards, so the class is not the removed feature\u2019s');
      const rule = new RegExp('(^|\\n)' + sel.replace(/\./g, '\\.') + '\\s*\\{');
      assert.ok(rule.test(css),
        sel + ' must stay in styles.css: the OLT and Backbone donuts are laid out by it');
    });
});

/* ------------------------------------------------------------------ *
   4. The record keeps being written
 * ------------------------------------------------------------------ */

test('the snapshot writer stays: removing the reader is not removing the record', () => {
  /* `\s*\(` rather than the bare name, which is a prefix of any rename — a reader renamed to
     `getSnapshots_gone` still satisfies /function getSnapshots/. */
  assert.ok(/function saveDailySnapshot\s*\(/.test(db), 'the capture is still there');
  assert.ok(/function getSnapshots\s*\(/.test(db),
    'and the reader stays for whatever history view comes next — the data cannot be rebuilt');

  /* The CALL, not the name: the name appears in comments and in the guard beside it, so a
     boot that stopped calling it would still read as present. Pinned as the whole guarded
     statement, which is what makes the capture reachable. */
  const call = /if \(typeof saveDailySnapshot === 'function'\) saveDailySnapshot\(\);/;
  assert.ok(call.test(page), 'and the app still calls it on boot, or the history stops growing');
  assert.strictEqual(page.split('saveDailySnapshot()').length - 1, 1,
    'exactly once: a second call would double-write the same day');
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
