// ==================== OLT REBUILD-INTENT / WARM-TTL TESTS ====================
//
// Run: node tests/olt-warm-ttl.test.js
//
// Zero dependencies. Loads the REAL code.gs and olt-cache-warmer.gs into a vm
// sandbox with stubbed Apps Script services, then checks the claims that cannot
// be verified any other way before deploying to a live spreadsheet:
//
//   1. A warm run REBUILDS even when a live cache entry exists.
//   2. An HTTP caller can still be served from that entry (the point of a cache).
//   3. ?fresh=1 can force a rebuild, but only once a minute, and cannot lengthen
//      an entry's life.
//   4. The build stamp rides inside the cached bytes, so a hit reports the
//      original build time.
//   5. A build whose revision moved while it was reading is never cached.
//
// Claim 1 used to be asserted the other way round — "a warmed entry inside its
// own TTL must be served, not rebuilt" — and that assertion was the bug. It made
// the warmer a no-op on every run that mattered: on 2026-09-18 a DOWN ticket was
// deleted from "OLT DOWN Tickets" at 14:06:09 and the dashboard still showed it
// at 14:17:09, because every refresh in between was answered from the 13:59
// entry and only the TTL running out ever produced a fresh build. The cache is a
// hit-served store; someone has to force the miss, and until this test changed
// nobody did.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
   Apps Script service stubs
 * ------------------------------------------------------------------ */

function makeSheet(rows, counters, onRead) {
  return {
    getLastRow: () => rows.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        counters.getRangeCalls++;
        if (onRead) onRead(counters.getRangeCalls);
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = rows[r - 1 + i] || [];
          const row = [];
          for (let j = 0; j < nc; j++) {
            row.push(src[c - 1 + j] === undefined ? '' : src[c - 1 + j]);
          }
          out.push(row);
        }
        return out;
      }
    })
  };
}

/* Absolute-column layout for the two sheets the OLT branch reads.
   Column A = index 0. Only the columns the branch actually touches. */
function oltSheets(counters, onRead) {
  const olt = [];
  olt[0] = [];                                  // row 1 — header
  olt[1] = [];                                  // row 2 — header
  const down = [];                              // row 3 — a DOWN OLT
  down[1] = 'BENGUET'; down[2] = 'ITOGON'; down[3] = 'OLT-A';
  down[5] = true;                               // col F — DOWN flag
  down[9] = 'TKT-1';                            // col J — DOWN ticket
  const up = [];                                // row 4 — an UP OLT
  up[1] = 'BENGUET'; up[2] = 'ITOGON'; up[3] = 'OLT-B';
  const up2 = [];                               // row 5 — an UP OLT
  up2[1] = 'BENGUET'; up2[2] = 'ITOGON'; up2[3] = 'OLT-C';
  olt[2] = down; olt[3] = up; olt[4] = up2;

  const tix = [];
  tix[0] = [];                                  // row 1 — header
  const t = [];                                 // row 2 — one ticket
  t[5] = 'TKT-1';                               // F — ticket no
  t[6] = 'FIBER';                               // G — cause
  t[20] = 'cut cable';                          // U — remarks
  t[23] = '12h';                                // X — aging
  t[25] = '42';                                 // Z — clients
  t[27] = 'OLT-A';                              // AB — OLT names
  tix[1] = t;

  return {
    'NLZ OLT Report': makeSheet(olt, counters, onRead),
    'OLT DOWN Tickets': makeSheet(tix, counters, onRead)
  };
}

/**
 * @param {Object} [opts]
 * @param {Object} [opts.cache]   pre-seeded CacheService entries (key -> string)
 * @param {Object} [opts.props]   pre-seeded script properties
 * @param {Function} [opts.onRead] called with the 1-based sheet-read count, so a
 *                                test can mutate state in the middle of a build
 * @param {boolean} [opts.propsThrow] make setProperty throw, to test fail-closed
 */
function freshSandbox(opts) {
  opts = opts || {};
  const counters = { getRangeCalls: 0, cacheGets: 0, propReads: 0, urlsFetched: 0 };
  const store = Object.assign({}, opts.cache || {});   // CacheService entries
  const puts = [];
  const removes = [];
  const props = Object.assign({}, opts.props || {});
  const deleted = [];
  const logs = [];
  const order = [];
  const sheets = oltSheets(counters, opts.onRead);

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
        setProperty: (k, v) => {
          if (opts.propsThrow) throw new Error('properties store unavailable');
          props[k] = v;
          order.push('set:' + k);
        },
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

const OLT_HTTP = () => ({ parameter: { type: 'olt', shape: '3' } });
const COLD = () => ({ parameter: { type: 'olt', shape: '3', fresh: '1' } });

function skipLogPresent(s) {
  return s.__logs.some((l) => l.indexOf('Cache write skipped') !== -1);
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

console.log('\nOLT rebuild intent, warm TTL and build stamps\n');

/* ------------------------------------------------------------------ *
   1. The TTL the warmed entry actually gets
 * ------------------------------------------------------------------ */

test('an HTTP-shaped call still writes the normal 60 s TTL', () => {
  const s = freshSandbox();
  s.doGet(OLT_HTTP());                       // exactly how the web app calls it
  assert.strictEqual(s.__puts.length, 1, 'expected exactly one cache write');
  assert.strictEqual(s.__puts[0].key, 'cache_v2_olt_c3');
  assert.strictEqual(s.__puts[0].ttl, 60, 'HTTP callers must keep the 60 s TTL');
});

test('the warmer writes its own TTL, and it is the constant the file declares', () => {
  const s = freshSandbox();
  s.warmOltCache();
  assert.strictEqual(s.__puts.length, 1, 'expected exactly one cache write');
  assert.strictEqual(s.__puts[0].key, 'cache_v2_olt_c3');
  assert.strictEqual(s.__puts[0].ttl, s.OLT_WARM_TTL_SECONDS);
  assert.ok(s.__puts[0].ttl > 0 && s.__puts[0].ttl <= 1800,
    'warm TTL must stay inside the range doGet accepts');
});

test('the warmer actually passes the override — not just a TTL constant that exists', () => {
  const s = freshSandbox();
  const calls = [];
  s.doGet = (e, ttl) => { calls.push({ e, ttl }); return { getContent: () => '{}' }; };
  s.warmOltCache();
  assert.strictEqual(calls.length, 1, 'warmer should call doGet exactly once');
  assert.strictEqual(calls[0].e.parameter.type, 'olt');
  assert.strictEqual(calls[0].e.parameter.shape, '3', 'must warm the shape users request');
  assert.strictEqual(calls[0].ttl, 180, 'warmer must pass its TTL as the 2nd positional arg');
});

/* The cadence is read out of TRIGGER_PLAN as data rather than scraped from the
   source text, so the two files stay tied together by the schedule itself and
   not by how it happens to be written. */
function warmPlanEntry() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'triggers.gs'), 'utf8'), sandbox, { filename: 'triggers.gs' });

  const entry = sandbox.TRIGGER_PLAN.filter((e) => e.fn === 'warmOltCache')[0];
  assert.ok(entry, 'TRIGGER_PLAN has no warmOltCache entry');
  return { entry, sandbox };
}

function warmIntervalSecondsFromTriggerPlan() {
  const { entry } = warmPlanEntry();

  let minutes = null;
  const clock = {
    everyMinutes(n) { minutes = n; return clock; },
    everyHours() { return clock; },
    atHour() { return clock; },
    everyDays() { return clock; },
    inTimezone() { return clock; }
  };
  entry.apply({ timeBased: () => clock });

  assert.ok(minutes, 'the warmOltCache entry does not use everyMinutes()');
  return minutes * 60;
}

test('the warmer and TRIGGER_PLAN state the same interval', () => {
  const intervalSeconds = warmIntervalSecondsFromTriggerPlan();
  const s = freshSandbox();
  assert.strictEqual(s.OLT_WARM_INTERVAL_SECONDS, intervalSeconds,
    'olt-cache-warmer.gs says ' + s.OLT_WARM_INTERVAL_SECONDS + 's but TRIGGER_PLAN ' +
    'says ' + intervalSeconds + 's — the Apps Script UI cannot show the cadence, so ' +
    'these two are the only record of it');
  assert.strictEqual(warmPlanEntry().entry.event, 'clock',
    'warmOltCache is time-driven; the plan must say so for the drift report');
});

test('the warm TTL is deliberately SHORTER than the interval it sits under', () => {
  const intervalSeconds = warmIntervalSecondsFromTriggerPlan();
  const s = freshSandbox();
  /* This inverts the rule the previous release was built on, so it is worth
     stating as an assertion rather than a comment: the warmer no longer needs a
     live entry to exist (it rebuilds unconditionally), so the TTL's job is now
     to bound how stale a HIT can be and to make a dead trigger decay to
     slow-but-fresh instead of stale. 1080 s is what let a deleted ticket stay on
     screen for 11 minutes. */
  assert.ok(s.OLT_WARM_TTL_SECONDS < intervalSeconds,
    'warm TTL ' + s.OLT_WARM_TTL_SECONDS + 's must stay under the ' + intervalSeconds +
    's interval: longer lets a hit be served for longer than one cycle, which is ' +
    'the staleness this release exists to remove');
  assert.ok(intervalSeconds <= 300,
    'a warm cadence above 5 min leaves formula-driven changes uncovered for too long');
});

/* ------------------------------------------------------------------ *
   2. The rebuild intent — the actual bug
 * ------------------------------------------------------------------ */

test('a warm run REBUILDS even while a live cache entry exists', () => {
  const s = freshSandbox({ cache: { cache_v2_olt_c3: '["the 13:59 snapshot"]' } });
  const out = s.doGet(OLT_HTTP(), s.OLT_WARM_TTL_SECONDS).getContent();

  assert.notStrictEqual(out, '["the 13:59 snapshot"]',
    'the warmer was answered from the cache — this is the bug: a warm run that hits ' +
    'does nothing, so the warm cadence is not the freshness it claims to be');
  assert.ok(s.__counters.getRangeCalls > 0, 'the rebuild must reach the sheet');
  assert.strictEqual(s.__puts.length, 1, 'and the fresh payload must be written back');
});

test('a client is still served from that live entry (the cache still caches)', () => {
  const s = freshSandbox({ cache: { cache_v2_olt_c3: '["the 13:59 snapshot"]' } });
  const out = s.doGet(OLT_HTTP()).getContent();

  assert.strictEqual(out, '["the 13:59 snapshot"]', 'an HTTP caller must keep hitting');
  assert.strictEqual(s.__counters.getRangeCalls, 0, 'a hit must not touch the sheet');
  assert.strictEqual(s.__puts.length, 0, 'a hit must not rewrite the entry');
});

test('the incident: the next warm run reflects an edit made after the previous build', () => {
  const s = freshSandbox({ cache: { cache_v2_olt_c3: '["TKT-1 was still DOWN here"]' } });
  const out = s.doGet(OLT_HTTP(), s.OLT_WARM_TTL_SECONDS).getContent();

  const payload = JSON.parse(out);
  assert.strictEqual(payload.v, 3);
  assert.ok(out.indexOf('TKT-1 was still DOWN here') === -1,
    'the stale snapshot survived the refresh — this is the 11-minute lag');
  assert.strictEqual(payload.meta.total, 3);
});

test('the rebuild intent bypasses the PropertiesService copy too, and clears it', () => {
  // 30 s old: inside both the 60 s default and the warm TTL, so the ONLY thing
  // that can decide this is the rebuild intent itself.
  const fresh30s = String(Date.now() - 30 * 1000);
  const seededCopy = () => ({
    props: { cache_v2_olt_c3: '["from-properties"]', cache_v2_olt_c3_cached_at: fresh30s }
  });

  const hit = freshSandbox(seededCopy());
  const hitOut = hit.doGet(OLT_HTTP()).getContent();
  assert.strictEqual(hitOut, '["from-properties"]', 'inside its TTL the copy is served');
  assert.strictEqual(hit.__counters.getRangeCalls, 0, 'serving it must not touch the sheet');

  const warm = freshSandbox(seededCopy());
  const warmOut = warm.doGet(OLT_HTTP(), warm.OLT_WARM_TTL_SECONDS).getContent();
  assert.notStrictEqual(warmOut, '["from-properties"]',
    'a warm run must not be answered by the copy it is about to replace');
  assert.ok(warm.__counters.getRangeCalls > 0, 'the rebuild must read the sheet');
  assert.ok(warm.__deleted.indexOf('cache_v2_olt_c3') !== -1,
    'the oversized-payload copy must be cleared, or it outlives the fresh write');
});

test('an expired PropertiesService copy is dropped exactly as before', () => {
  const s = freshSandbox({
    props: {
      cache_v2_olt_c3: '["from-properties"]',
      cache_v2_olt_c3_cached_at: String(Date.now() - 300 * 1000)
    }
  });
  const out = s.doGet({ parameter: { type: 'olt', shape: '3' } }).getContent();
  // 300 s is past the 60 s default, so this is a rebuild (the copy is only kept
  // alive by a caller that asked for a long TTL).
  assert.notStrictEqual(out, '["from-properties"]', 'stale copy must not be served');
  assert.ok(s.__deleted.indexOf('cache_v2_olt_c3') !== -1, 'the stale copy should be deleted');
});

/* ------------------------------------------------------------------ *
   3. The spoof resistance (unchanged behaviour, re-asserted)
 * ------------------------------------------------------------------ */

test('query parameters cannot raise the TTL', () => {
  const s = freshSandbox();
  s.doGet({ parameter: { type: 'olt', shape: '3', ttl: '99999', warmTtl: '99999', TTL: '99999', warmTtlOverride: '99999' } });
  assert.strictEqual(s.__puts[0].ttl, 60,
    'a caller-controlled parameter must never lengthen the cache lifetime');
});

test('an out-of-range or absent override falls back to the default', () => {
  const bad = [999999, 1801, 0, -1, null, undefined, NaN];
  for (const value of bad) {
    const s = freshSandbox();
    s.doGet(OLT_HTTP(), value);
    assert.strictEqual(s.__puts[0].ttl, 60,
      'override ' + String(value) + ' should have been rejected');
  }
});

/* ------------------------------------------------------------------ *
   4. ?fresh=1 — the REFRESH button's escalation
 * ------------------------------------------------------------------ */

test('fresh=1 rebuilds and writes the normal 60 s TTL, not a longer one', () => {
  const s = freshSandbox({ cache: { cache_v2_olt_c3: '["cached"]' } });
  const out = s.doGet(COLD()).getContent();

  assert.notStrictEqual(out, '["cached"]', 'fresh=1 must reach the sheet');
  assert.strictEqual(s.__counters.getRangeCalls > 0, true, 'expected a real rebuild');
  assert.strictEqual(s.__puts[0].ttl, 60,
    'a client-triggered rebuild must not be able to lengthen the entry it writes');
});

test('a second fresh=1 inside the window is refused and served from cache', () => {
  const s = freshSandbox();
  s.doGet(COLD());
  assert.strictEqual(s.__counters.getRangeCalls > 0, true, 'the first claim rebuilds');
  const readsAfterFirst = s.__counters.getRangeCalls;

  const second = s.doGet(COLD()).getContent();
  assert.strictEqual(s.__counters.getRangeCalls, readsAfterFirst,
    'the second claim inside the minute must not read the sheet again');
  assert.strictEqual(second, s.__puts[0].value,
    'and it must be answered from the entry the first one wrote');
});

test('the force-fresh claim is per type', () => {
  const s = freshSandbox();
  assert.strictEqual(s.claimForcedRebuild('olt'), true, 'first claim for olt is granted');
  assert.strictEqual(s.claimForcedRebuild('olt'), false, 'the second inside the minute is not');
  assert.strictEqual(s.claimForcedRebuild('node'), true,
    'a claim on one module must not spend another module\'s allowance');
});

test('an unusable properties store refuses the claim instead of throwing', () => {
  const s = freshSandbox({ propsThrow: true });
  assert.strictEqual(s.claimForcedRebuild('olt'), false, 'must fail closed');
  const out = s.doGet(COLD()).getContent();
  assert.ok(JSON.parse(out), 'doGet must still answer with data when the claim fails');
});

/* ------------------------------------------------------------------ *
   5. The build stamp
 * ------------------------------------------------------------------ */

test('the shape=3 payload carries a build stamp inside its meta summary', () => {
  const before = Date.now();
  const s = freshSandbox();
  const payload = JSON.parse(s.doGet(OLT_HTTP()).getContent());

  assert.ok(payload.meta && typeof payload.meta.builtAt === 'number',
    'meta.builtAt is how a client can tell how old what it is showing really is');
  assert.ok(payload.meta.builtAt >= before && payload.meta.builtAt <= Date.now(),
    'the stamp must be the build time');
});

test('a cache HIT reports the ORIGINAL build time, not the time of the hit', () => {
  /* The whole reason the stamp lives inside the cached bytes. If it were added to
     the response envelope instead, a hit would restamp it as "just now" — which
     is the lie that made an 11-minute-old view look fresh. */
  const oldStamp = 1700000000000;
  const cached = JSON.stringify({ v: 3, f: ['P'], p: [], m: [], meta: { builtAt: oldStamp }, r: [] });
  const s = freshSandbox({ cache: { cache_v2_olt_c3: cached } });

  const payload = JSON.parse(s.doGet(OLT_HTTP()).getContent());
  assert.strictEqual(payload.meta.builtAt, oldStamp,
    'a hit must report when the data was built, not when it was asked for');
  assert.strictEqual(s.__counters.getRangeCalls, 0, 'a hit does not rebuild');
});

test('shape=2 carries the stamp as a sibling key, leaving the rows untouched', () => {
  const s = freshSandbox();
  const payload = JSON.parse(s.doGet({ parameter: { type: 'olt', shape: '2' } }).getContent());

  assert.deepStrictEqual(Object.keys(payload).sort(),
    ['builtAt', 'f', 'm', 'p', 'r', 'v'],
    'decodeOltCompact reads only f/p/m/r, so an extra sibling key is compatible');
  assert.strictEqual(payload.r.length, 3, 'all three OLTs, not just the problem rows');
});

/* ------------------------------------------------------------------ *
   6. The mid-build race
 * ------------------------------------------------------------------ */

test('a build whose revision moved while it was reading is not cached', () => {
  /* A rebuild reads the sheet for seconds; an edit can land in the middle of it.
     Caching what such a build read would install a pre-edit snapshot into a cache
     the invalidation trigger has just cleared — the same failure, narrower window. */
  const s = freshSandbox({
    props: { data_rev_olt: '7' },
    onRead: (readCount) => {
      if (readCount === 1) s.__props.data_rev_olt = '8';   // an edit lands mid-build
    }
  });
  const out = s.doGet(OLT_HTTP(), s.OLT_WARM_TTL_SECONDS).getContent();

  assert.strictEqual(s.__puts.length, 0, 'nothing may be cached from a raced build');
  assert.ok(skipLogPresent(s), 'the skip must be logged, not silent');
  assert.strictEqual(JSON.parse(out).v, 3, 'the caller still gets the payload it waited for');
});

test('a build whose revision held still is cached normally', () => {
  const s = freshSandbox({ props: { data_rev_olt: '7' } });
  s.doGet(OLT_HTTP(), s.OLT_WARM_TTL_SECONDS);
  assert.strictEqual(s.__puts.length, 1, 'an un-raced build must still warm the cache');
  assert.strictEqual(skipLogPresent(s), false, 'and must not log a skip');
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
