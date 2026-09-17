// ==================== OLT WARM-TTL OVERRIDE TESTS ====================
//
// Run: node tests/olt-warm-ttl.test.js
//
// Zero dependencies. Loads the REAL code.gs and olt-cache-warmer.gs into a vm
// sandbox with stubbed Apps Script services, then checks the two claims that
// cannot be verified any other way before deploying to a live spreadsheet:
//
//   1. A warmed entry gets a TTL that outlives the trigger interval (the bug).
//   2. An HTTP caller cannot ask for a long-lived entry (the security claim).
//
// Claims 1 and 2 pull in opposite directions — one wants a long TTL to be
// reachable, the other wants it unreachable — so they are worth asserting
// rather than reasoning about.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
   Apps Script service stubs
 * ------------------------------------------------------------------ */

function makeSheet(rows, counters) {
  return {
    getLastRow: () => rows.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        counters.getRangeCalls++;
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
function oltSheets(counters) {
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
    'NLZ OLT Report': makeSheet(olt, counters),
    'OLT DOWN Tickets': makeSheet(tix, counters)
  };
}

function freshSandbox() {
  const counters = { getRangeCalls: 0 };
  const puts = [];
  const props = {};
  const deleted = [];
  const logs = [];
  const sheets = oltSheets(counters);

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => sheets[n] || null })
    },
    // Always a miss, so every call takes the build path and records its TTL.
    CacheService: {
      getScriptCache: () => ({
        get: () => null,
        put: (key, value, ttl) => puts.push({ key, value, ttl })
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props[k] === undefined ? null : props[k]),
        setProperty: (k, v) => { props[k] = v; },
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
    Session: { getScriptTimeZone: () => 'Asia/Manila' }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'code.gs'), 'utf8'), sandbox, { filename: 'code.gs' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'olt-cache-warmer.gs'), 'utf8'), sandbox, { filename: 'olt-cache-warmer.gs' });

  sandbox.__puts = puts;
  sandbox.__props = props;
  sandbox.__deleted = deleted;
  sandbox.__logs = logs;
  sandbox.__counters = counters;
  return sandbox;
}

const OLT_HTTP = () => ({ parameter: { type: 'olt', shape: '3' } });

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

console.log('\nOLT warm-TTL override\n');

/* ------------------------------------------------------------------ *
   The TTL the warmed entry actually gets
 * ------------------------------------------------------------------ */

test('an HTTP-shaped call still writes the normal 60 s TTL', () => {
  const s = freshSandbox();
  s.doGet(OLT_HTTP());                       // exactly how the web app calls it
  assert.strictEqual(s.__puts.length, 1, 'expected exactly one cache write');
  assert.strictEqual(s.__puts[0].key, 'cache_v2_olt_c3');
  assert.strictEqual(s.__puts[0].ttl, 60, 'HTTP callers must keep the 60 s TTL');
});

test('the warmer writes the long TTL, so the entry outlives the trigger interval', () => {
  const s = freshSandbox();
  s.warmOltCache();
  assert.strictEqual(s.__puts.length, 1, 'expected exactly one cache write');
  assert.strictEqual(s.__puts[0].key, 'cache_v2_olt_c3');
  assert.strictEqual(s.__puts[0].ttl, s.OLT_WARM_TTL_SECONDS);
  assert.ok(s.__puts[0].ttl > 900,
    'warm TTL (' + s.__puts[0].ttl + 's) must exceed the 900 s trigger interval');
});

test('the warmer actually passes the override — not just a TTL constant that exists', () => {
  const s = freshSandbox();
  const calls = [];
  s.doGet = (e, ttl) => { calls.push({ e, ttl }); return { getContent: () => '{}' }; };
  s.warmOltCache();
  assert.strictEqual(calls.length, 1, 'warmer should call doGet exactly once');
  assert.strictEqual(calls[0].e.parameter.type, 'olt');
  assert.strictEqual(calls[0].e.parameter.shape, '3', 'must warm the shape users request');
  assert.strictEqual(calls[0].ttl, 1080, 'warmer must pass its TTL as the 2nd positional arg');
});

/* The cadence is read out of TRIGGER_PLAN as data rather than scraped from the
   source text, so the two files stay tied together by the schedule itself and
   not by how it happens to be written. */
function warmIntervalSecondsFromTriggerPlan() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'triggers.gs'), 'utf8'), sandbox, { filename: 'triggers.gs' });

  const entry = sandbox.TRIGGER_PLAN.filter((e) => e.fn === 'warmOltCache')[0];
  assert.ok(entry, 'TRIGGER_PLAN has no warmOltCache entry');

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

test('the warm TTL clears the interval declared in TRIGGER_PLAN', () => {
  const intervalSeconds = warmIntervalSecondsFromTriggerPlan();
  const s = freshSandbox();
  assert.ok(s.OLT_WARM_TTL_SECONDS > intervalSeconds,
    'warm TTL ' + s.OLT_WARM_TTL_SECONDS + 's does not cover the ' +
    intervalSeconds + 's trigger interval — this is the original bug');
});

/* ------------------------------------------------------------------ *
   The spoof resistance
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

test('the override is applied to the read path too, not just the write', () => {
  // An entry stamped 300 s ago: past the 60 s default, inside the warm TTL.
  const ageSeconds = 300;

  const warm = freshSandbox();
  warm.__props['cache_v2_olt_c3'] = '["from-properties"]';
  warm.__props['cache_v2_olt_c3_cached_at'] = String(Date.now() - ageSeconds * 1000);
  const warmOut = warm.doGet(OLT_HTTP(), warm.OLT_WARM_TTL_SECONDS).getContent();
  assert.strictEqual(warmOut, '["from-properties"]',
    'a warmed entry inside its own TTL must be served, not rebuilt');
  assert.strictEqual(warm.__counters.getRangeCalls, 0, 'serving it must not touch the sheet');

  const cold = freshSandbox();
  cold.__props['cache_v2_olt_c3'] = '["from-properties"]';
  cold.__props['cache_v2_olt_c3_cached_at'] = String(Date.now() - ageSeconds * 1000);
  const coldOut = cold.doGet(OLT_HTTP()).getContent();
  assert.notStrictEqual(coldOut, '["from-properties"]',
    'under the default TTL the same entry is stale and must be dropped');
  assert.ok(cold.__deleted.indexOf('cache_v2_olt_c3') !== -1, 'stale entry should be deleted');
  assert.ok(cold.__counters.getRangeCalls > 0, 'stale entry should force a rebuild');
});

/* ------------------------------------------------------------------ *
   The build still produces the right payload
 * ------------------------------------------------------------------ */

test('the warmed payload is the problem-only shape the OLT module expects', () => {
  const s = freshSandbox();
  s.warmOltCache();
  const payload = JSON.parse(s.__puts[0].value);
  assert.strictEqual(payload.v, 3);
  assert.deepStrictEqual(payload.f, ['P', 'M', 'N', 'S', 'T', 'AG', 'RM', 'DC', 'CA']);
  assert.strictEqual(payload.r.length, 1, 'only the DOWN row should be on the wire');
  assert.strictEqual(payload.meta.total, 3, 'meta still counts every OLT');
  assert.strictEqual(payload.meta.up, 2);
  assert.strictEqual(payload.meta.down, 1);
  assert.strictEqual(payload.meta.clientsDown, 42);
  assert.ok(s.__logs.some((l) => l.indexOf('TTL 1080s') !== -1),
    'the run should log the TTL it used');
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
