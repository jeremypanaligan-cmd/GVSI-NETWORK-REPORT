// ==================== WARM PASS TESTS ====================
//
// Run: node tests/cache-warmer.test.js
//
// Zero dependencies. Loads the REAL code.gs and olt-cache-warmer.gs into a vm sandbox with
// stubbed Apps Script services and a sheet for every module, then checks the claims that
// cannot be verified any other way before this is pasted into a live spreadsheet:
//
//   1. The pass rebuilds every module, once each, in the declared order, in ONE execution.
//   2. OLT keeps the shape the app reads; the other four ask for no shape at all.
//   3. Each type is written with its own declared TTL, inside the range doGet accepts.
//   4. The key a warm run writes is the key an HTTP caller reads.
//   5. After a pass, an HTTP call for the same type is a HIT that touches no sheet. This is
//      the assertion that says the warming is worth anything: without it, a pass could be
//      writing a key nobody reads and every test above would still be green.
//   6. A live entry does not make the pass a no-op — the rebuild intent holds for all five,
//      which is the bug the OLT warmer shipped with (a warm run answered from the cache).
//   7. One module failing does not starve the four behind it, and the failure is named.
//   8. A build that answers with an error envelope is reported as a FAILURE. It does not
//      throw — code.gs catches it and answers {error:"build_failed"} with a 200 — so a
//      warmer that logged success here would claim a module is warm every five minutes
//      while every user paid a cold build.
//   9. The interval and the TTLs are the ones TRIGGER_PLAN declares, and the rule the
//      2026-09-18 incident was closed with: TTL strictly BELOW the interval.
//  10. shape=4 is never warmed: the healthy-fleet payload stays lazy.
//  11. The pass touches no revision counter and spends no forced-rebuild claim, so warming
//      cannot send every open dashboard to the sheet for nothing.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
   Apps Script service stubs
 * ------------------------------------------------------------------ */

/* "H2:M19" -> { r, c, nr, nc }. Enough of A1 for the two sheets that are
   addressed that way (the NAP and LCP branches); nothing else in this sandbox needs it. */
function a1Range_(a1) {
  const m = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(a1);
  if (!m) throw new Error('unsupported A1 range in this stub: ' + a1);
  const col = (letters) => letters.split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  return {
    r: parseInt(m[2], 10),
    c: col(m[1]),
    nr: parseInt(m[4], 10) - parseInt(m[2], 10) + 1,
    nc: col(m[3]) - col(m[1]) + 1
  };
}

/**
 * @param {Array} rows          sheet rows, 0-indexed, holes allowed
 * @param {Object} counters     shared read counter
 * @param {Object} [opts]
 * @param {boolean} [opts.throwOnRead] make getValues() throw — the transient Sheets failure
 *                                     that code.gs's build guard exists to catch
 */
function makeSheet(rows, counters, opts) {
  opts = opts || {};
  return {
    getLastRow: () => rows.length,
    getRange: (a, b, c, d) => {
      const spec = (typeof a === 'string') ? a1Range_(a) : { r: a, c: b, nr: c, nc: d };
      return {
        getValues: () => {
          counters.getRangeCalls++;
          if (opts.throwOnRead) throw new Error('Sheets service is temporarily unavailable');
          const out = [];
          for (let i = 0; i < spec.nr; i++) {
            const src = rows[spec.r - 1 + i] || [];
            const row = [];
            for (let j = 0; j < spec.nc; j++) {
              row.push(src[spec.c - 1 + j] === undefined ? '' : src[spec.c - 1 + j]);
            }
            out.push(row);
          }
          return out;
        }
      };
    }
  };
}

/* One real row per module, so every branch produces a NON-EMPTY payload. An empty payload
   would be cached just as happily, and half of these assertions would pass without ever
   having built anything. */
function makeSheets(counters, opts) {
  opts = opts || {};
  const readOpts = (name) => ({ throwOnRead: opts.throwOnSheet === name });

  // ---- NLZ OLT Report: two header rows, then one DOWN OLT and two UP
  const olt = [];
  olt[0] = []; olt[1] = [];
  const down = []; down[1] = 'BENGUET'; down[2] = 'ITOGON'; down[3] = 'OLT-A';
  down[5] = true; down[9] = 'TKT-1';                       // col F = DOWN flag, col J = ticket
  const up1 = []; up1[1] = 'BENGUET'; up1[2] = 'ITOGON'; up1[3] = 'OLT-B';
  const up2 = []; up2[1] = 'BENGUET'; up2[2] = 'ITOGON'; up2[3] = 'OLT-C';
  olt[2] = down; olt[3] = up1; olt[4] = up2;

  // ---- OLT DOWN Tickets
  const tix = []; tix[0] = [];
  const t = []; t[5] = 'TKT-1'; t[6] = 'FIBER'; t[10] = 'SA';
  t[20] = 'cut cable'; t[23] = '12h'; t[25] = '42'; t[27] = 'OLT-A';
  tix[1] = t;

  // ---- NLZ NAP Report: read as H2:M19, whose first row the branch skips as a header
  const nap = [];
  nap[1] = [];
  const napRow = []; napRow[7] = 'AREA-1'; napRow[8] = 'PROV-A';
  napRow[9] = 5; napRow[10] = 2; napRow[11] = 1; napRow[12] = 8;
  nap[2] = napRow;

  // ---- NLZ LCP Report: aging at G24:L39, impact at G2:K18
  const lcp = [];
  const lcpImpact = []; lcpImpact[6] = 'AREA-1'; lcpImpact[7] = 1; lcpImpact[8] = 2;
  lcpImpact[9] = 1; lcpImpact[10] = 3;
  lcp[2] = lcpImpact;
  const lcpAging = []; lcpAging[6] = 'AREA-1'; lcpAging[7] = 1; lcpAging[8] = 2;
  lcpAging[9] = 3; lcpAging[10] = 4; lcpAging[11] = 5;
  lcp[23] = lcpAging;

  // ---- Node DOWN Tickets
  const node = []; node[0] = [];
  const nodeRow = []; nodeRow[3] = 'BENGUET'; nodeRow[5] = 'ND-1'; nodeRow[24] = 2; nodeRow[26] = 'NODE-A';
  node[1] = nodeRow;

  // ---- Backbone Tickets
  const bb = []; bb[0] = [];
  const bbRow = []; bbRow[3] = 'BENGUET'; bbRow[5] = 'BB-1'; bbRow[10] = 'SA';
  bb[1] = bbRow;

  return {
    'NLZ OLT Report':    makeSheet(olt, counters, readOpts('NLZ OLT Report')),
    'OLT DOWN Tickets':  makeSheet(tix, counters, readOpts('OLT DOWN Tickets')),
    'NLZ NAP Report':    makeSheet(nap, counters, readOpts('NLZ NAP Report')),
    'NLZ LCP Report':    makeSheet(lcp, counters, readOpts('NLZ LCP Report')),
    'Node DOWN Tickets': makeSheet(node, counters, readOpts('Node DOWN Tickets')),
    'Backbone Tickets':  makeSheet(bb, counters, readOpts('Backbone Tickets'))
  };
}

/**
 * @param {Object} [opts]
 * @param {Object} [opts.cache]          pre-seeded CacheService entries (key -> string)
 * @param {string} [opts.throwOnSheet]   name of a sheet whose reads throw
 */
function freshSandbox(opts) {
  opts = opts || {};
  const counters = { getRangeCalls: 0, cacheGets: 0, propReads: 0, urlsFetched: 0 };
  const store = Object.assign({}, opts.cache || {});
  const puts = [];
  const removes = [];
  const props = {};
  const deleted = [];
  const logs = [];
  const order = [];
  const sheets = makeSheets(counters, opts);

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          counters.cacheGets++;
          return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
        },
        put: (key, value, ttl) => {
          puts.push({ key, value, ttl });
          store[key] = value;
          order.push('put:' + key);
        },
        remove: (key) => {
          removes.push(key);
          delete store[key];
          order.push('remove:' + key);
        }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => {
          counters.propReads++;
          return props[k] === undefined ? null : props[k];
        },
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
    Utilities: { formatDate: () => '01/01/2026 00:00:00' },
    Session: { getScriptTimeZone: () => 'Asia/Manila' },
    UrlFetchApp: { fetch: () => { counters.urlsFetched++; return { getResponseCode: () => 200 }; } }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'code.gs'), 'utf8'), sandbox, { filename: 'code.gs' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'olt-cache-warmer.gs'), 'utf8'), sandbox, { filename: 'olt-cache-warmer.gs' });

  sandbox.__puts = puts;
  sandbox.__removes = removes;
  sandbox.__store = store;
  sandbox.__props = props;
  sandbox.__deleted = deleted;
  sandbox.__logs = logs;
  sandbox.__order = order;
  sandbox.__counters = counters;
  return sandbox;
}

/* Every module the pass is supposed to warm, with the cache key an HTTP caller reads for
   it and the exact event that caller sends. OLT is the odd one: its dashboard shape is 3,
   so the key is the compact variant. */
const CASES = [
  { type: 'olt',      key: 'cache_v2_olt_c3', http: () => ({ parameter: { type: 'olt', shape: '3' } }) },
  { type: 'nap',      key: 'cache_v2_nap',      http: () => ({ parameter: { type: 'nap' } }) },
  { type: 'lcp',      key: 'cache_v2_lcp',      http: () => ({ parameter: { type: 'lcp' } }) },
  { type: 'node',     key: 'cache_v2_node',     http: () => ({ parameter: { type: 'node' } }) },
  { type: 'backbone', key: 'cache_v2_backbone', http: () => ({ parameter: { type: 'backbone' } }) }
];

const WARM_ORDER = ['olt', 'nap', 'lcp', 'node', 'backbone'];

/* Replaces doGet with a recorder, for the assertions about how the pass CALLS it. */
function recordDoGet(s) {
  const calls = [];
  s.doGet = (e, ttl) => {
    calls.push({ type: e.parameter.type, shape: e.parameter.shape, ttl: ttl });
    return { getContent: () => '[]' };
  };
  return calls;
}

function logMatching(s, needle) {
  return s.__logs.filter((l) => l.indexOf(needle) !== -1);
}

/* The cadence is read out of TRIGGER_PLAN as data rather than scraped from the source
   text, so the two files stay tied together by the schedule itself and not by how it
   happens to be written. */
function warmPassPlanEntry() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'triggers.gs'), 'utf8'), sandbox, { filename: 'triggers.gs' });

  const entry = sandbox.TRIGGER_PLAN.filter((e) => e.fn === 'warmDataCaches')[0];
  assert.ok(entry, 'TRIGGER_PLAN has no warmDataCaches entry');
  return entry;
}

function warmIntervalSecondsFromTriggerPlan() {
  const entry = warmPassPlanEntry();

  let minutes = null;
  const clock = {
    everyMinutes(n) { minutes = n; return clock; },
    everyHours() { return clock; },
    atHour() { return clock; },
    everyDays() { return clock; },
    inTimezone() { return clock; }
  };
  entry.apply({ timeBased: () => clock });

  assert.ok(minutes, 'the warmDataCaches entry does not use everyMinutes()');
  return minutes * 60;
}

/* ------------------------------------------------------------------ *
   Harness
 * ------------------------------------------------------------------ */

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

console.log('\nThe warm pass: five modules, one run\n');

/* ------------------------------------------------------------------ *
   1. How the pass calls doGet
 * ------------------------------------------------------------------ */

test('the pass rebuilds every module exactly once, in the declared order', () => {
  const s = freshSandbox();
  const calls = recordDoGet(s);
  s.warmDataCaches();

  assert.deepStrictEqual(calls.map((c) => c.type), WARM_ORDER,
    'the pass must warm every module once, OLT first — the order is the schedule for a ' +
    'slow module, and a module missing from it is a module that is never warm');
});

test('only OLT is warmed with a shape; the other four send none', () => {
  const s = freshSandbox();
  const calls = recordDoGet(s);
  s.warmDataCaches();

  const olt = calls.filter((c) => c.type === 'olt')[0];
  assert.strictEqual(olt.shape, '3',
    'OLT must be warmed with the shape the dashboard asks for, or the pass writes a ' +
    'payload no user ever reads');

  calls.filter((c) => c.type !== 'olt').forEach((c) => {
    assert.strictEqual(c.shape, undefined,
      c.type + ' was warmed with shape=' + c.shape + '; these four have exactly one ' +
      'shape and doGet must not be handed one');
  });
});

test('each type is warmed with its own TTL, inside the range doGet accepts', () => {
  const s = freshSandbox();
  const calls = recordDoGet(s);
  s.warmDataCaches();

  calls.forEach((c) => {
    const expected = (c.type === 'olt') ? s.OLT_WARM_TTL_SECONDS : s.SECONDARY_WARM_TTL_SECONDS;
    assert.strictEqual(c.ttl, expected,
      c.type + ' was warmed with TTL ' + c.ttl + 's but the file declares ' + expected + 's');
    /* doGet only honours an override in (0, 1800]. Outside it the warmer would silently
       write the 60 s default and call it a warm entry. */
    assert.ok(c.ttl > 0 && c.ttl <= 1800,
      c.type + ': TTL ' + c.ttl + 's is outside the range doGet accepts, so the warm ' +
      'entry would be written with the 60 s default instead');
  });
});

/* ------------------------------------------------------------------ *
   2. What the pass actually writes
 * ------------------------------------------------------------------ */

test('the pass writes the key an HTTP caller reads, for every type', () => {
  const s = freshSandbox();
  s.warmDataCaches();

  assert.deepStrictEqual(Object.keys(s.__store).sort(), CASES.map((c) => c.key).sort(),
    'a warm run must land on exactly the keys the HTTP path reads; a payload written ' +
    'under any other key is a rebuild nobody is ever served');

  CASES.forEach((c) => {
    assert.ok(s.__store[c.key] && s.__store[c.key].length > 2,
      c.key + ' holds nothing that can be served');
  });
});

test('after the pass, an HTTP call for any type is a HIT that touches no sheet', () => {
  CASES.forEach((c) => {
    const s = freshSandbox();
    s.warmDataCaches();

    const warmed = s.__store[c.key];
    s.__counters.getRangeCalls = 0;

    const out = s.doGet(c.http()).getContent();

    assert.strictEqual(out, warmed,
      c.type + ': an HTTP caller was not served the payload the pass just wrote');
    assert.strictEqual(s.__counters.getRangeCalls, 0,
      c.type + ': an HTTP caller after a warm run still read the sheet — the warming ' +
      'is not reaching the request path');
  });
});

test('a live entry does not make the pass a no-op', () => {
  CASES.forEach((c) => {
    const seeded = {};
    seeded[c.key] = '["the 13:59 snapshot"]';
    const s = freshSandbox({ cache: seeded });

    s.warmDataCaches();

    assert.notStrictEqual(s.__store[c.key], '["the 13:59 snapshot"]',
      c.type + ' was answered from the entry the pass was supposed to replace — this is ' +
      'the bug the OLT warmer shipped with, at 11 minutes of stale ticket');
    assert.ok(s.__puts.some((p) => p.key === c.key),
      c.type + ': the pass did not write a fresh entry');
  });
});

/* ------------------------------------------------------------------ *
   3. Failure is isolation + honesty
 * ------------------------------------------------------------------ */

test('one module failing does not starve the four behind it', () => {
  const s = freshSandbox({ throwOnSheet: 'NLZ NAP Report' });
  s.warmDataCaches();

  assert.strictEqual(s.__store['cache_v2_nap'], undefined,
    'a build that failed must not look like a warm entry');
  assert.ok(s.__store['cache_v2_lcp'] && s.__store['cache_v2_node'] && s.__store['cache_v2_backbone'],
    'the modules behind the failed one must still be warmed — the pass is the only thing ' +
    'keeping any of them warm');
  assert.ok(s.__store['cache_v2_olt_c3'], 'OLT runs first and must be unaffected');

  assert.strictEqual(logMatching(s, '❌ warmCache nap').length, 1,
    'the failure must be logged against its type, not swallowed by the pass');
  assert.strictEqual(logMatching(s, 'FAILED: nap').length, 1,
    'the pass summary must name what it could not warm');
});

test('an error envelope is reported as a failure, and nothing is cached for it', () => {
  /* The origin answers a failed build with a 200 and a perfectly valid body, so this does
     NOT throw — it has to be recognised. */
  const envelope = JSON.stringify({ error: 'build_failed', type: 'node', message: 'boom', retryable: true });

  const s = freshSandbox();
  s.doGet = () => ({ getContent: () => envelope });

  const elapsed = s.warmTypeCache_('node', s.SECONDARY_WARM_TTL_SECONDS);

  assert.strictEqual(elapsed, -1, 'a failed build must not report an elapsed time');
  assert.strictEqual(logMatching(s, '❌ warmCache node').length, 1,
    'the envelope must be logged as a failure');
  assert.strictEqual(logMatching(s, 'NOTHING was cached').length, 1,
    'and it must say plainly that the cache was not written');
  assert.strictEqual(s.__puts.length, 0, 'nothing may be cached from a failed build');

  // The detector must not fire on a real payload: a row array, or the OLT compact envelope.
  assert.strictEqual(s.isBuildErrorEnvelope_('[{"A":"AREA-1"}]'), false, 'a row array is data');
  assert.strictEqual(s.isBuildErrorEnvelope_('{"v":3,"f":["P"],"r":[]}'), false,
    'the OLT compact envelope starts with a brace and is data');
  assert.strictEqual(s.isBuildErrorEnvelope_('{"error":"build_failed"}'), true);
});

test('a pass where OLT throws still warms the four behind it', () => {
  const s = freshSandbox();
  s.warmOltCache = () => { throw new Error('boom'); };
  s.warmDataCaches();

  CASES.filter((c) => c.type !== 'olt').forEach((c) => {
    assert.ok(s.__store[c.key], c.type + ' must still be warmed when OLT throws');
  });
  assert.strictEqual(logMatching(s, 'warmDataCaches: warmOltCache threw').length, 1);
  assert.strictEqual(logMatching(s, 'FAILED: olt').length, 1, 'and OLT must be named as the failure');
});

/* ------------------------------------------------------------------ *
   4. The plan tie, and the rules the numbers have to obey
 * ------------------------------------------------------------------ */

test('the warmer and TRIGGER_PLAN state the same interval', () => {
  const intervalSeconds = warmIntervalSecondsFromTriggerPlan();
  const s = freshSandbox();

  assert.strictEqual(s.OLT_WARM_INTERVAL_SECONDS, intervalSeconds,
    'olt-cache-warmer.gs says ' + s.OLT_WARM_INTERVAL_SECONDS + 's but TRIGGER_PLAN says ' +
    intervalSeconds + 's — the Apps Script UI cannot show the cadence, so these two are ' +
    'the only record of it');
  assert.strictEqual(warmPassPlanEntry().event, 'clock',
    'the warm pass is time-driven; the plan must say so for the drift report');
});

test('every warmed TTL stays under the interval, and the interval is at most 5 minutes', () => {
  const intervalSeconds = warmIntervalSecondsFromTriggerPlan();
  const s = freshSandbox();

  [s.OLT_WARM_TTL_SECONDS, s.SECONDARY_WARM_TTL_SECONDS].forEach((ttl) => {
    assert.ok(ttl > 0 && ttl < intervalSeconds,
      'warm TTL ' + ttl + 's must stay under the ' + intervalSeconds + 's interval: a TTL ' +
      'longer than one cycle lets a HIT be served for longer than the cadence that ' +
      'refreshes it, which is the 11-minute staleness this project already fixed once');
  });
  assert.ok(intervalSeconds <= 300,
    'a warm cadence above 5 min leaves formula-driven changes uncovered for too long');
});

/* ------------------------------------------------------------------ *
   5. What the pass must NOT do
 * ------------------------------------------------------------------ */

test('shape=4, and the legacy shape, are never warmed', () => {
  const s = freshSandbox();
  s.warmDataCaches();

  assert.strictEqual(s.__store['cache_v2_olt_c4'], undefined,
    'the healthy fleet is lazy by design; warming it would put a 26 KB payload on a ' +
    'five-minute clock for a view almost nobody opens');
  assert.strictEqual(s.__store['cache_v2_olt'], undefined,
    'the legacy shape has no caller left and must stay cold');
});

test('the pass touches no revision counter and spends no forced-rebuild claim', () => {
  const s = freshSandbox();
  s.warmDataCaches();

  const touched = Object.keys(s.__props).filter((k) =>
    k.indexOf('data_rev_') === 0 || k.indexOf('force_fresh_at_') === 0);

  assert.deepStrictEqual(touched, [],
    'a warm run must not bump a revision (that would send every open dashboard to the ' +
    'sheet) and must not spend the REFRESH button\'s once-a-minute claim (' + touched + ')');
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
