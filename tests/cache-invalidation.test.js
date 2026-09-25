// ==================== CACHE INVALIDATION TESTS ====================
//
// Run: node tests/cache-invalidation.test.js
//
// Zero dependencies. Loads the REAL code.gs and cache-invalidation.gs into a vm
// sandbox with stubbed Apps Script services, and drives the trigger handlers the
// way Apps Script would.
//
// What is worth asserting here, and why:
//
//   * NARROWNESS. An edit to one sheet must clear that module and nothing else.
//     A blanket invalidate would turn any cell edit anywhere in the spreadsheet
//     into a rebuild of every module.
//   * NO SHEET ACCESS. The whole value of this trigger is that it costs a few
//     cache deletions and no spreadsheet read. A single getRange in here would
//     make every edit pay for a rebuild it is trying to avoid.
//   * ORDER. Cache keys are removed BEFORE the revision moves, so a client that
//     sees a new revision cannot be pointed at an entry that still holds the old
//     bytes.
//   * FAILURE CONTAINMENT. A malformed event, an unmapped sheet or a dead relay
//     must not surface as anything. The cost of staying quiet is a stale view
//     until its TTL; the cost of throwing is a broken sheet.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

const ALL_TYPES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

function oltsKeys() {
  return ['cache_v2_olt', 'cache_v2_olt_c2', 'cache_v2_olt_c3', 'cache_v2_olt_c4'];
}

function freshSandbox(opts) {
  opts = opts || {};

  const counters = { sheetLookups: 0, getActiveSpreadsheet: 0, urlFetches: 0, cacheRemoves: 0 };
  const store = {};
  const props = Object.assign({}, opts.props || {});
  const deleted = [];
  const logs = [];
  const order = [];         // ordered log of writes/removes, for the ordering claim
  const warnings = [];

  const sandbox = {
    /* The trigger must not print anything a user can see; console output is
       captured so a test can assert on it rather than on noise. */
    console: {
      log: (m) => warnings.push(String(m)),
      warn: (m) => warnings.push(String(m)),
      error: (m) => warnings.push(String(m))
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => {
        counters.getActiveSpreadsheet++;
        return {
          getSheetByName: (n) => { counters.sheetLookups++; return null; }
        };
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        put: (k, v) => { store[k] = v; },
        remove: (k) => { counters.cacheRemoves++; delete store[k]; order.push('remove:' + k); }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props[k] === undefined ? null : props[k]),
        getProperties: () => Object.assign({}, props),
        setProperty: (k, v) => { props[k] = v; order.push('set:' + k); },
        deleteProperty: (k) => { delete props[k]; deleted.push(k); }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        _text: text,
        setMimeType() { return this; },
        getContent() { return this._text; }
      })
    },
    Logger: { log: (m) => logs.push(String(m)) },
    UrlFetchApp: {
      fetch: () => {
        counters.urlFetches++;
        if (opts.relayThrows) throw new Error('relay is down');
        return { getResponseCode: () => 200 };
      }
    },
    /* Stands in for admin.gs's jsonOut, which the rev route calls. */
    jsonOut: (obj) => ({
      _obj: obj,
      getContent: () => JSON.stringify(obj)
    })
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'code.gs'), 'utf8'), sandbox, { filename: 'code.gs' });
  /* code.gs calls recordBuildFailure_/recordSlowBuild_ out of diagnostics.gs. Loading
     code.gs alone would exercise an INERT hook and stay green about it — the slow-build
     hook sits inside doGet, so its absence is swallowed. tests/diagnostics.test.js
     asserts this line exists in every suite that runs a build. */
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'diagnostics.gs'), 'utf8'), sandbox, { filename: 'diagnostics.gs' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'cache-invalidation.gs'), 'utf8'), sandbox, { filename: 'cache-invalidation.gs' });

  sandbox.__store = store;
  sandbox.__props = props;
  sandbox.__deleted = deleted;
  sandbox.__logs = logs;
  sandbox.__order = order;
  sandbox.__counters = counters;
  return sandbox;
}

/* A loaded CacheService, so a deletion is observable rather than a no-op. */
function loadedCache() {
  const seed = {};
  ['nap', 'lcp', 'node', 'backbone'].forEach((t) => {
    seed['cache_v2_' + t] = 'payload:' + t;
  });
  oltsKeys().forEach((k) => { seed[k] = 'payload:olt'; });
  return seed;
}

/* The PropertiesService staleness stamps that go with those entries. They live
   in the properties store, not in the cache, which is exactly why invalidation
   has to delete both: a stamp left behind would let an oversized payload
   outlive its own invalidation. */
function loadedStamps() {
  const stamps = {};
  oltsKeys().forEach((k) => { stamps[k + '_cached_at'] = '999'; });
  return stamps;
}

function load(s) {
  Object.assign(s.__store, loadedCache());
  return s;
}

function editEvent(sheetName) {
  return { range: { getSheet: () => ({ getName: () => sheetName }) } };
}

function keysOf(sandbox) {
  return Object.keys(sandbox.__store).sort();
}

/* ------------------------------------------------------------------ */

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

console.log('\nCache invalidation on sheet edit\n');

/* ------------------------------------------------------------------ *
   Narrowness: one sheet, one module
 * ------------------------------------------------------------------ */

test('an OLT sheet edit clears all OLT shapes and their stamps', () => {
  const s = load(freshSandbox({ props: loadedStamps() }));
  s.handleSheetEdit(editEvent('OLT DOWN Tickets'));

  const left = keysOf(s);
  assert.ok(left.indexOf('cache_v2_olt') === -1, 'the legacy key must go too');
  assert.ok(left.indexOf('cache_v2_olt_c2') === -1, 'shape=2 must go too');
  assert.ok(left.indexOf('cache_v2_olt_c3') === -1, 'the shape users request must go');
  assert.ok(left.indexOf('cache_v2_olt_c4') === -1, 'the lazy healthy-fleet shape must go too');
  assert.ok(s.__deleted.indexOf('cache_v2_olt_c3_cached_at') !== -1,
    'the PropertiesService staleness stamp must go with it');
  assert.ok(left.indexOf('cache_v2_node') !== -1,
    'nothing else may be cleared: a rebuild of every module per edit is the cost this is avoiding');
});

test('a Node sheet edit touches Node only — the OLT entries survive', () => {
  const s = load(freshSandbox());
  s.handleSheetEdit(editEvent('Node DOWN Tickets'));

  const left = keysOf(s);
  assert.ok(left.indexOf('cache_v2_node') === -1, 'node must be cleared');
  assert.ok(left.indexOf('cache_v2_olt_c3') !== -1, 'OLT must be untouched');
});

test('every mapped sheet is mapped to something that exists', () => {
  const s = freshSandbox();
  const mapped = Object.keys(s.SHEET_TO_DATA_TYPES);
  assert.ok(mapped.length >= 6, 'expected the five report sheets plus the OLT ticket sheet');
  mapped.forEach((sheet) => {
    const types = s.SHEET_TO_DATA_TYPES[sheet];
    assert.ok(Array.isArray(types) && types.length > 0, sheet + ' maps to nothing');
    types.forEach((t) => {
      assert.ok(ALL_TYPES.indexOf(t) !== -1, sheet + ' maps to unknown type ' + t);
    });
  });
});

test('an unmapped (renamed) sheet clears nothing and says so', () => {
  const s = load(freshSandbox());
  s.handleSheetEdit(editEvent('OLT DOWN Tickets (old)'));

  assert.strictEqual(keysOf(s).length, Object.keys(loadedCache()).length,
    'an unknown sheet must not clear anything — a blanket invalidate would make every ' +
    'unrelated edit a rebuild of every module');
  assert.ok(s.__logs.some((l) => l.indexOf('not mapped') !== -1), 'and it must be logged');
  assert.ok(s.__props.data_rev_olt === undefined, 'no revision bump either');
});

test('the admin sheets are ignored on purpose, quietly', () => {
  ['Users', 'AppSettings'].forEach((sheet) => {
    const s = load(freshSandbox());
    s.handleSheetEdit(editEvent(sheet));
    assert.strictEqual(keysOf(s).length, Object.keys(loadedCache()).length,
      sheet + ' must not trigger any data invalidation');
  });
});

test('a malformed event is a no-op, not an exception', () => {
  [
    undefined,
    {},
    { range: {} },
    { range: { getSheet: () => ({}) } },
    { range: { getSheet: () => null } },
    { range: { getSheet: () => ({ getName: () => '' }) } }
  ].forEach((event) => {
    const s = load(freshSandbox());
    s.handleSheetEdit(event);
    assert.strictEqual(keysOf(s).length, Object.keys(loadedCache()).length,
      'event ' + JSON.stringify(event) + ' must change nothing');
  });
});

/* ------------------------------------------------------------------ *
   Structure changes: the one case that clears everything
 * ------------------------------------------------------------------ */

test('a structure change clears every module and bumps every revision', () => {
  const s = load(freshSandbox({ props: loadedStamps() }));
  s.handleSheetChange({ changeType: 'REMOVE_ROW' });

  assert.deepStrictEqual(keysOf(s), [],
    'a removed row or column invalidates the layout every payload was built against');
  ALL_TYPES.forEach((t) => {
    assert.strictEqual(Number(s.__props['data_rev_' + t]), 1, t + ' revision must move');
  });
});

/* ------------------------------------------------------------------ *
   Cost: what the trigger must NOT do
 * ------------------------------------------------------------------ */

test('the handlers never touch the spreadsheet', () => {
  const s = load(freshSandbox());
  s.handleSheetEdit(editEvent('OLT DOWN Tickets'));
  s.handleSheetChange({ changeType: 'OTHER' });

  assert.strictEqual(s.__counters.sheetLookups, 0,
    'a getRange in here would make every edit pay for the rebuild it is trying to avoid');
  assert.strictEqual(s.__counters.getActiveSpreadsheet, 0,
    'the sheet name comes from the event, not from the spreadsheet');
});

test('the revision moves AFTER the cache is cleared, never before', () => {
  const s = load(freshSandbox());
  s.handleSheetEdit(editEvent('OLT DOWN Tickets'));

  const firstSet = s.__order.findIndex((op) => op.indexOf('set:data_rev_') === 0);
  const lastRemove = s.__order.map((op, i) => (op.indexOf('remove:') === 0 ? i : -1))
    .reduce((a, b) => Math.max(a, b), -1);

  assert.ok(firstSet > -1, 'the revision must move');
  assert.ok(lastRemove > -1, 'the cache must be cleared');
  assert.ok(firstSet > lastRemove,
    'a client that sees the new revision must be looking at an already-empty cache');
});

/* ------------------------------------------------------------------ *
   The optional relay
 * ------------------------------------------------------------------ */

test('the relay is off until it is configured — no call is attempted', () => {
  const s = load(freshSandbox());
  s.handleSheetEdit(editEvent('OLT DOWN Tickets'));
  assert.strictEqual(s.__counters.urlFetches, 0,
    'an unconfigured relay must cost nothing, not a failing request per edit');
});

test('when configured, the relay is called once with the revisions', () => {
  const s = load(freshSandbox({ props: { notify_webhook_url: 'https://example.invalid/notify' } }));
  s.handleSheetEdit(editEvent('OLT DOWN Tickets'));
  assert.strictEqual(s.__counters.urlFetches, 1, 'exactly one POST per invalidation');
});

test('a dead relay does not undo the invalidation or throw', () => {
  const s = load(freshSandbox({
    props: { notify_webhook_url: 'https://example.invalid/notify' },
    relayThrows: true
  }));
  s.handleSheetEdit(editEvent('OLT DOWN Tickets'));

  assert.ok(keysOf(s).indexOf('cache_v2_olt_c3') === -1,
    'the local invalidation already happened and must stand');
  assert.ok(s.__logs.some((l) => l.indexOf('notify relay failed') !== -1),
    'and the failure must be visible in the logs');
});

/* ------------------------------------------------------------------ *
   The rev route
 * ------------------------------------------------------------------ */

test('the rev route reports every module, defaulting untouched ones to zero', () => {
  const s = freshSandbox({ props: { data_rev_olt: '12', data_rev_node: '3' } });
  const out = JSON.parse(s.handleGetRev().getContent());

  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(Object.keys(out.rev).sort(), ALL_TYPES.slice().sort(),
    'the client iterates this, so every module has to appear');
  assert.strictEqual(out.rev.olt, 12);
  assert.strictEqual(out.rev.node, 3);
  assert.strictEqual(out.rev.nap, 0, 'never bumped reads as zero, not undefined');
  assert.strictEqual(s.__counters.sheetLookups, 0,
    'the poll must stay cheap: one properties read, no spreadsheet access');
});

test('the rev route reflects a bump immediately', () => {
  const s = load(freshSandbox());
  const before = JSON.parse(s.handleGetRev().getContent()).rev.olt;
  s.handleSheetEdit(editEvent('OLT DOWN Tickets'));
  const after = JSON.parse(s.handleGetRev().getContent()).rev.olt;
  assert.strictEqual(after, before + 1, 'the app can only learn about the edit if this moves');
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
