/* ------------------------------------------------------------------ *
   The boot-graph guard.

   The five dashboard modules used to boot SERIALLY without anyone meaning
   them to. loadInitialData() fired only NAP, and the other four were started
   from inside NAP's own success branch, so the wall display paid NAP's whole
   round trip before the other four had even begun.

   Measured against the live API:

     NAP alone            1,074 ms
     five in parallel     1,157 ms     <- the extra four cost ~83 ms
     five sequential      5,324 ms     <- the cost of chaining them

   So the ordering was the entire cost. Each /exec runs on its own Apps Script
   instance, which is why four extra requests are nearly free when they
   overlap — and why they are not free at all when they wait on each other.

   A single combined ?type=all endpoint was the other candidate. It loses:
   Apps Script is single-threaded and getValues() blocks, so one execution
   would build the five payloads back to back — roughly 1,275 ms warm and
   2,400 ms on a cold cache, against the 1,157 ms of five parallel requests.

   Two things are easy to reintroduce by accident and impossible to see in a
   diff, so they are asserted here rather than left to a comment:

     1. A module fetcher starting another module fetcher. That is exactly the
        shape the bug had, and it is a one-line "helpful" prefetch away from
        coming back.
     2. The daily snapshot on a bare timer. saveDailySnapshot() reads every
        module cache, and db.js keeps only the FIRST snapshot of each day — so
        a snapshot that runs before the modules land records them as zero for
        the rest of that day. It used to be a blind setTimeout(..., 1000)
        started alongside the four prefetches, by which point OLT (~2.4 s),
        NODE (~2.3 s) and BACKBONE (~2.0 s) were still in flight.

   Following the same rule as inline-order.test.js: the first test is the gate
   on the shipping app, and the rest re-introduce each historical bug in its
   real shape (a real file, the real call chain) so the suite fails if the
   checker stops seeing it. A checker that cannot fail on the bug it exists to
   catch reads as coverage without being any.

   What this does NOT cover: whether the boot is actually fast. It cannot —
   that needs a browser and the live API. It catches the two ways the boot
   silently goes serial again.
 * ------------------------------------------------------------------ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  loadScriptUnits,
  maskLiterals,
  depthMap,
  collectFunctions,
  ownBody,
  calleesIn,
  readOffsets,
  matchingParen
} = require('./inline-order.js');

const ROOT = path.join(__dirname, '..');

/** The five modules, in the order loadInitialData() starts them. */
const BOOT_FETCHERS = [
  'fetchNapData',
  'fetchLcpData',
  'fetchOltData',
  'fetchNodeData',
  'fetchBackboneData'
];

/** Files whose functions must never touch the app loader. */
const MODULE_FILE = /-module\.js$/;

/* ==================================================================== *
   The analysis
 * ==================================================================== */

/** 1-based line number in the original file for an offset into masked source. */
function lineOf(unit, masked, offset) {
  return unit.startLine + masked.slice(0, offset).split('\n').length - 1;
}

/**
 * Index every top-level function in every unit, so a call can be followed
 * across files (nap-module.js calling into index.html is the whole point).
 *
 * A name can be declared in more than one unit, so each name maps to a list of
 * definitions and every check unions over them. Erring toward "more reachable"
 * keeps the guard on the failing side.
 */
function indexFunctions(units) {
  const index = new Map();

  for (const unit of units) {
    const masked = maskLiterals(unit.code);
    const depths = depthMap(masked);
    const fns = collectFunctions(masked, depths);

    for (const [name, span] of fns) {
      if (!index.has(name)) index.set(name, []);
      index.get(name).push({
        unit,
        masked,
        fns,
        bodyStart: span.bodyStart,
        bodyEnd: span.bodyEnd
      });
    }
  }

  return index;
}

/**
 * Inspect a set of script units and report every way the boot has gone serial.
 * Returns empty collections for a healthy boot — see the assertions below.
 */
function analyseBoot(units) {
  const index = indexFunctions(units);

  const defs = (name) => index.get(name) || [];

  /** Every definition's body, INCLUDING nested callbacks. */
  const rawBodies = (name) => defs(name).map((d) => d.masked.slice(d.bodyStart, d.bodyEnd));

  /** The body INCLUDING nested callbacks — for structural checks on one function. */
  const rawBody = (name) => rawBodies(name)[0] || '';

  /** Direct callees, with callbacks blanked, so only what runs on entry counts. */
  const calleesOf = (name) => {
    const out = new Set();
    for (const d of defs(name)) {
      const body = ownBody(d.masked, d.bodyStart, d.bodyEnd);
      for (const c of calleesIn(body, d.fns)) out.add(c.name);
    }
    return out;
  };

  /**
   * `name` is NAMED (called or referenced) inside any definition of `fnName`.
   *
   * Named rather than called is the whole point. The historical bug did not call
   * fetchLcpData() — it registered the function as a VALUE:
   *
   *     const allModules = [['lcp', fetchLcpData], ...];
   *     allModules.forEach(([type, fetcher]) => { fetcher(); });
   *
   * The call itself is `fetcher()`, invisible to any callee walk, so a checker
   * that only follows calls cannot see the bug it exists to catch.
   */
  const namesIn = (fnName, name) =>
    rawBodies(fnName).some((body) => readOffsets(body, name).length > 0);

  /** Everything `start` can reach by calling, plus `start` itself. */
  const callClosure = (start, maxDepth = 8) => {
    const seen = new Set([start]);
    const queue = [[start, 0]];

    while (queue.length) {
      const [name, depth] = queue.shift();
      if (depth >= maxDepth) continue;

      for (const next of calleesOf(name)) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push([next, depth + 1]);
      }
    }
    return seen;
  };

  /* 1. No module fetcher may start another module fetcher — directly or by
        handing it to a helper as a value. */
  const chainedFetchers = [];
  for (const from of BOOT_FETCHERS) {
    for (const via of callClosure(from)) {
      for (const to of BOOT_FETCHERS) {
        if (to === from) continue;
        if (!namesIn(via, to)) continue;
        chainedFetchers.push(from + ' → ' + to + ' (via ' + via + '())');
      }
    }
  }

  /* 2. The boot itself must be what starts all five. */
  const bootFound = defs('loadInitialData').length > 0;
  const bootBody = rawBody('loadInitialData');
  const missingFromBoot = BOOT_FETCHERS.filter((name) => bootBody.indexOf(name) === -1);

  /* 3. The loader belongs to the boot and to nothing else. A module that hides
        the loader reports a finished boot that has not finished.

        Checked by NAME against the unit's own source, not against a per-unit
        callee map: hideLoader() is declared in index.html, so it is not in a
        module file's own function index and a callee walk would never see it. */
  const loadersFromModules = [];
  for (const unit of units) {
    if (!MODULE_FILE.test(unit.name)) continue;

    const masked = maskLiterals(unit.code);
    const fns = collectFunctions(masked, depthMap(masked));

    for (const [name, span] of fns) {
      const body = masked.slice(span.bodyStart, span.bodyEnd);
      for (const loader of ['hideLoader', 'showLoader']) {
        if (readOffsets(body, loader).length > 0) {
          loadersFromModules.push(unit.name + ' · ' + name + '() names ' + loader + '()');
        }
      }
    }
  }

  /* 4. The snapshot must never be scheduled by a bare timer. */
  const snapshotOnTimer = [];
  for (const unit of units) {
    const masked = maskLiterals(unit.code);
    const re = /setTimeout\s*\(/g;
    let m;

    while ((m = re.exec(masked))) {
      const open = masked.indexOf('(', m.index);
      const close = matchingParen(masked, open);

      if (close === -1) {
        snapshotOnTimer.push(unit.name + ' — unbalanced setTimeout at line ' + lineOf(unit, masked, m.index));
        continue;
      }

      // Masked source, so a paren inside a string or a regex cannot fool this.
      const args = masked.slice(open, close + 1);
      if (args.includes('saveDailySnapshot')) {
        snapshotOnTimer.push(unit.name + ' line ' + lineOf(unit, masked, m.index));
      }
    }
  }

  return {
    chainedFetchers,
    bootFound,
    missingFromBoot,
    loadersFromModules,
    snapshotOnTimer,
    bootUsesTimer: /setTimeout\s*\(/.test(bootBody),
    snapshotStillCalled: units.some((u) => maskLiterals(u.code).includes('saveDailySnapshot'))
  };
}

/* ==================================================================== *
   Fixtures — the historical bugs, in the shape they actually had.
 * ==================================================================== */

/** The four fetchers that were launched from NAP's success branch. */
const STUB_FETCHERS = BOOT_FETCHERS.slice(1)
  .map((name) => 'async function ' + name + '() { return; }')
  .join('\n');

/** Before the fix: NAP fired the others, and a timer took the snapshot. */
const fixtureSerialBoot = () => ([
  {
    name: 'index.html (inline #1)',
    code: [
      'function loadInitialData() {',
      '  fetchNapData();',
      '}',
      'function prefetchOtherTabsInBackground() {',
      "  const allModules = [['lcp', fetchLcpData], ['olt', fetchOltData], ['node', fetchNodeData], ['backbone', fetchBackboneData]];",
      '  allModules.forEach(([type, f]) => { f(); });',
      '  setTimeout(() => { saveDailySnapshot(); }, 1000);',
      '}',
      'async function fetchNapData() {',
      "  const data = await fetchWithRetry(BASE_API_URL + '?type=nap');",
      '  if (data) { dataCache.nap = data; renderNapReport(data); prefetchOtherTabsInBackground(); }',
      '}',
      'function fetchWithRetry() {}',
      'function renderNapReport() {}',
      'function saveDailySnapshot() {}',
      'function hideLoader() {}',
      STUB_FETCHERS
    ].join('\n')
  }
]);

/** Before the fix, the loader was hidden from inside the NAP module. */
const fixtureModuleHidesLoader = () => ([
  {
    name: 'nap-module.js',
    code: [
      'async function fetchNapData() {',
      '  try { renderNapReport(await fetchWithRetry(URL)); }',
      '  finally { hideLoader(); }',
      '}',
      'function fetchWithRetry() {}',
      'function renderNapReport() {}'
    ].join('\n')
  },
  {
    name: 'index.html (inline #1)',
    code: [
      'function loadInitialData() {',
      '  var boot = [' + BOOT_FETCHERS.map((n) => n + '()').join(', ') + '];',
      '  boot[0].then(hideLoader);',
      '  boot.forEach(function (p) { p.then(onSettle, onSettle); });',
      '}',
      'function onSettle() { saveDailySnapshot(); }',
      'function hideLoader() {}',
      'function saveDailySnapshot() {}'
    ].join('\n')
  },
  ...BOOT_FETCHERS.slice(0, 1).map(() => ({ name: 'modules.js', code: STUB_FETCHERS }))
]);

/* ==================================================================== *
   1. The gate — this is the assertion that protects the app.
 * ==================================================================== */

test('the shipping app boots all five modules in parallel', () => {
  const report = analyseBoot(loadScriptUnits(ROOT));

  assert.deepEqual(
    report.chainedFetchers, [],
    'a module fetcher starts another module fetcher, so the chain waits on the first one:\n' +
    report.chainedFetchers.map((c) => '  ' + c).join('\n')
  );

  assert.deepEqual(
    report.missingFromBoot, [],
    'loadInitialData() does not start these, so nothing does until they are asked for:\n' +
    report.missingFromBoot.map((n) => '  ' + n).join('\n')
  );

  assert.deepEqual(
    report.loadersFromModules, [],
    'a module file drives the app loader, so it can report a boot that has not finished:\n' +
    report.loadersFromModules.map((c) => '  ' + c).join('\n')
  );

  assert.deepEqual(
    report.snapshotOnTimer, [],
    'saveDailySnapshot() is scheduled by a bare timer; db.js keeps only the FIRST\n' +
    'snapshot of each day, so any module still in flight is recorded as zero:\n' +
    report.snapshotOnTimer.map((c) => '  ' + c).join('\n')
  );

  assert.ok(report.bootFound, 'loadInitialData() was not found, so nothing below it was checked');

  assert.ok(
    report.snapshotStillCalled,
    'saveDailySnapshot() is not called from anywhere any more — the trend history has silently stopped'
  );

  assert.ok(
    !report.bootUsesTimer,
    'loadInitialData() reaches for a timer; the snapshot must be tied to the five modules settling'
  );
});

/* ==================================================================== *
   2. Teeth — each bug, re-introduced, must be caught.
 * ==================================================================== */

test('the old NAP-anchored prefetch is caught', () => {
  const report = analyseBoot(fixtureSerialBoot());

  assert.deepEqual(
    report.chainedFetchers,
    [
      'fetchNapData → fetchLcpData (via prefetchOtherTabsInBackground())',
      'fetchNapData → fetchOltData (via prefetchOtherTabsInBackground())',
      'fetchNapData → fetchNodeData (via prefetchOtherTabsInBackground())',
      'fetchNapData → fetchBackboneData (via prefetchOtherTabsInBackground())'
    ],
    'the checker missed fetchNapData() reaching the other four through the prefetch helper — ' +
    'note that helper calls them as VALUES, so only a name check can see this'
  );
  assert.deepEqual(
    report.missingFromBoot, [ 'fetchLcpData', 'fetchOltData', 'fetchNodeData', 'fetchBackboneData' ],
    'the checker missed that the old boot started only NAP'
  );
  assert.equal(report.snapshotOnTimer.length, 1, 'the checker missed the timer-scheduled snapshot');
  assert.ok(report.bootUsesTimer === false, 'the old boot had no timer of its own — only the prefetch helper did');
});

test('a module hiding the loader is caught', () => {
  const report = analyseBoot(fixtureModuleHidesLoader());

  assert.deepEqual(
    report.loadersFromModules, [ 'nap-module.js · fetchNapData() names hideLoader()' ],
    'the checker missed a module file driving the loader'
  );
  assert.deepEqual(report.chainedFetchers, [], 'this fixture has no chained fetchers to report');
  assert.deepEqual(report.snapshotOnTimer, [], 'this fixture has no timer snapshot to report');
});

/* ==================================================================== *
   3. The invariants the fix depends on.
 * ==================================================================== */

test('all five boot fetchers are async, so a throw cannot break the boot array', () => {
  const units = loadScriptUnits(ROOT);
  const source = units.map((u) => maskLiterals(u.code)).join('\n');

  for (const name of BOOT_FETCHERS) {
    assert.match(
      source,
      new RegExp('async\\s+function\\s+' + name + '\\s*\\('),
      name + '() is not an async function, so a synchronous throw would stop loadInitialData() ' +
      'from reaching the remaining modules'
    );
  }
});

/* ==================================================================== *
   4. The snapshot must not record a module that never loaded.

   Waiting for all five to SETTLE is necessary but not sufficient: a fetch that
   FAILS settles too, and no module writes its cache on its error path. Because
   db.js keeps only the first snapshot of each day, a settled-but-failed module is
   recorded as zero for the rest of that day.
 * ==================================================================== */

const dbSandbox = (() => {
  const source = fs.readFileSync(path.join(ROOT, 'db.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'db.js' });

  if (typeof sandbox.unloadedModules !== 'function') {
    throw new Error('unloadedModules is no longer a top-level function in db.js');
  }
  if (typeof sandbox.auditSnapshots !== 'function') {
    throw new Error('auditSnapshots is no longer a top-level function in db.js');
  }
  if (typeof sandbox.rebuildSnapshot !== 'function') {
    throw new Error('rebuildSnapshot is no longer a top-level function in db.js');
  }
  return sandbox;
})();

test('repair refuses a past day, so history cannot be overwritten with today', async () => {
  const { rebuildSnapshot } = dbSandbox;

  // A snapshot is built from the live module caches, which hold NOW. "Repairing" a
  // past date without this guard would delete that day and then write today's numbers
  // over it — losing the real day and gaining nothing. This branch returns before it
  // touches IndexedDB, which is why it is testable here at all.
  assert.deepEqual(
    await rebuildSnapshot('2020-01-01'),
    { date: '2020-01-01', deleted: 0, rewritten: false, reason: 'past-day' }
  );
});

test('a settled-but-failed module is not recorded as zero', () => {
  const { unloadedModules } = dbSandbox;

  // The live case: OLT and BACKBONE 404'd (three attempts each, retried and still
  // exhausted), so they settled with an empty cache. The snapshot for 2026-09-13 read
  // olt.total 0 against 461 real OLTs and backbone.tickets 0 against 7.
  assert.deepEqual(
    unloadedModules({ nap: [{}], lcp: { lcpAging: [] }, olt: null, node: [], backbone: null }),
    [ 'olt', 'backbone' ]
  );

  // Loaded, and genuinely nothing to report. That is real data, not a missing load,
  // and it must not block the snapshot forever on a quiet day.
  assert.deepEqual(
    unloadedModules({ nap: [], lcp: { lcpAging: [] }, olt: [], node: [], backbone: [] }),
    []
  );

  // A boot that has not reached its fetchers yet.
  assert.equal(
    unloadedModules({ nap: null, lcp: null, olt: null, node: null, backbone: null }).length,
    5
  );
});

test('auditSnapshots flags the days written from an incomplete load', () => {
  const { auditSnapshots } = dbSandbox;

  const record = (date, oltTotal, napTotal, lcpTotal) => ({
    date,
    nap: { total: napTotal, critical: 9 },
    lcp: { total: lcpTotal, clients: 1902 },
    olt: { total: oltTotal, up: oltTotal, down: 0, lowPower: 0, uplinkDown: 0, degradation: 0, clientsDown: 0 },
    node: { tickets: 0, equipment: 0 },
    backbone: { tickets: 7, links: 7 }
  });

  const rows = auditSnapshots([
    record('2026-09-13', 0, 56, 77),    // the live one: 461 OLTs exist, 0 recorded
    record('2026-09-14', 461, 56, 77),  // a good day
    record('2026-09-15', 0, 0, 0)       // nothing to contradict it — not flagged
  ]);

  assert.deepEqual(
    rows.map((r) => [ r.date, r.suspect ]),
    [ [ '2026-09-13', true ], [ '2026-09-14', false ], [ '2026-09-15', false ] ],
    'NAP and OLT come from the same spreadsheet in the same pass, so NAP having rows ' +
    'while OLT has none is what makes a day suspect'
  );

  // The flagged day still carries its real nap/lcp numbers through, so the report is
  // usable without opening devtools on the raw record.
  assert.equal(rows[0].oltTotal, 0);
  assert.equal(rows[0].napTotal, 56);
  assert.equal(rows[0].lcpTotal, 77);
  assert.equal(rows[0].bbTickets, 7);

  // An older record with no olt object at all must not crash the audit.
  assert.equal(auditSnapshots([ { date: '2026-01-01', nap: { total: 4 } } ])[0].suspect, true);
  assert.deepEqual(auditSnapshots([]), []);
  assert.deepEqual(auditSnapshots(undefined), []);
});

test('the boot starts modules through their own fetchers, never a raw fetchWithRetry', () => {
  const units = loadScriptUnits(ROOT);
  const boot = units
    .map((u) => maskLiterals(u.code))
    .filter((code) => /\bfunction\s+loadInitialData\s*\(/.test(code))
    .join('\n');

  const body = boot.slice(boot.indexOf('function loadInitialData'), boot.indexOf('function checkMaintenanceAndLogin'));

  assert.ok(
    !/fetchWithRetry\s*\(/.test(body),
    'loadInitialData() fetches directly instead of through a module fetcher. A raw fetch here ' +
    'bypasses the payload decoder (OLT needs one) and the revalidation throttle, and it builds ' +
    'a different URL, so the in-flight de-dupe cannot collapse it either.'
  );
});
