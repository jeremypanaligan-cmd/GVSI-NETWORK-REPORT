// ==================== ORIGIN RESILIENCE TESTS ====================
//
// Run: node tests/origin-resilience.test.js
//
// Zero dependencies. A transient failure on the origin is only survivable if BOTH
// ends handle it. This file covers the ORIGIN end: a spreadsheet handle or a sheet
// read that throws must come back as an ANSWER — a JSON envelope that says
// "hiccup, ask again" — instead of an HTML error page. Apps Script turns an escaped
// exception into markup, and the app asks for JSON, so res.json() threw on it; that
// is how a transient Sheets failure came to look like a wrong deployment URL, and
// why one of them left a module with no data.
//
// The client end — the retry budget, the jitter, and the reading of this envelope —
// is covered by the commit that restores it.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CODE_SRC = fs.readFileSync(path.join(ROOT, 'code.gs'), 'utf8');

const ALL_TYPES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

/* ------------------------------------------------------------------ *
   ORIGIN — code.gs in a sandbox whose reads can be made to fail
 * ------------------------------------------------------------------ */

function originSandbox(opts) {
  opts = opts || {};

  const counters = { rangeReads: 0, sheetLookups: 0 };
  const logs = [];
  const store = {};
  const props = Object.assign({}, opts.props || {});

  /* The NAP branch reads a FIXED range and then loops from index 1 — so a data
     row has to be the second one to survive. */
  function napRows() {
    const rows = [];
    for (let i = 0; i < 18; i++) rows.push(['', '', '', '', '', '']);
    rows[1] = ['AREA-1', 'BENGUET', 'HUB-1', '1', '2', '3'];
    return rows;
  }

  const sheet = {
    getLastRow: () => 19,
    getRange: () => ({
      getValues: () => {
        counters.rangeReads++;
        if (opts.readThrows) throw new Error('Sheets service is temporarily unavailable');
        return napRows();
      }
    })
  };

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => {
        if (opts.handleThrows) throw new Error('Cannot open the spreadsheet right now');
        if (opts.handleNull) return null;
        return {
          getSheetByName: (n) => {
            counters.sheetLookups++;
            return n === 'NLZ NAP Report' ? sheet : null;
          }
        };
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        put: (k, v) => { store[k] = v; },
        remove: (k) => { delete store[k]; }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props[k] === undefined ? null : props[k]),
        getProperties: () => Object.assign({}, props),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: (k) => { delete props[k]; }
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
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200 }) },
    /* Stands in for admin.gs's jsonOut, exactly as the other code.gs tests do. */
    jsonOut: (obj) => ({ _obj: obj, getContent: () => JSON.stringify(obj) })
  };

  vm.createContext(sandbox);
  vm.runInContext(CODE_SRC, sandbox, { filename: 'code.gs' });

  sandbox.__logs = logs;
  sandbox.__counters = counters;
  sandbox.__props = props;
  return sandbox;
}

const NAP = () => ({ parameter: { type: 'nap' } });

function bodyOf(out) {
  return JSON.parse(out.getContent());
}

function logged(s, needle) {
  return s.__logs.join('\n').indexOf(needle) !== -1;
}

/* ------------------------------------------------------------------ *
   Harness
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

/* ==================== ORIGIN ==================== */

(async function run() {

  console.log('\n-- origin: a failed build is an answer, not a page --');

  await test('a sheet read that throws returns a retryable JSON envelope', () => {
    const s = originSandbox({ readThrows: true });

    let out;
    assert.doesNotThrow(() => { out = s.doGet(NAP()); },
      'the failure must not escape doGet — that is what produces the HTML page');

    const body = bodyOf(out);
    assert.strictEqual(body.error, 'build_failed');
    assert.strictEqual(body.retryable, true, 'a Sheets hiccup is worth retrying');
    assert.strictEqual(body.type, 'nap', 'the client must know which module failed');
    assert.ok(/temporarily unavailable/.test(body.message), 'the cause travels with it');
    assert.ok(logged(s, 'Build failed for nap'), 'and it is logged on the origin too');
  });

  await test('a spreadsheet handle that throws is covered by the same guard', () => {
    const s = originSandbox({ handleThrows: true });

    let out;
    assert.doesNotThrow(() => { out = s.doGet(NAP()); });

    const body = bodyOf(out);
    assert.strictEqual(body.error, 'build_failed');
    assert.strictEqual(body.retryable, true);
    assert.ok(/Cannot open the spreadsheet/.test(body.message));
  });

  await test('a null handle still fails as an envelope, not as a TypeError page', () => {
    const s = originSandbox({ handleNull: true });

    let out;
    assert.doesNotThrow(() => { out = s.doGet(NAP()); });
    assert.strictEqual(bodyOf(out).error, 'build_failed');
  });

  await test('a healthy build is untouched by the guard', () => {
    const s = originSandbox({});

    const out = s.doGet(NAP());
    const body = bodyOf(out);

    assert.ok(Array.isArray(body), 'a normal response is still the payload itself');
    assert.strictEqual(body.length, 1, 'and it still contains the row that was read');
    assert.strictEqual(body[0].A, 'AREA-1');
    assert.strictEqual(s.__counters.rangeReads, 1, 'exactly one sheet read, no retry loop');
  });

  await test('a cached entry is still served without touching the guard', () => {
    const s = originSandbox({});
    s.doGet(NAP());                       // builds and caches
    const readsAfterFirst = s.__counters.rangeReads;

    const body = bodyOf(s.doGet(NAP()));  // hit
    assert.strictEqual(s.__counters.rangeReads, readsAfterFirst, 'a hit reads nothing');
    assert.ok(Array.isArray(body));
  });

  console.log('\n-- origin: an unknown type is refused, not answered with NAP --');

  await test('an unrecognised type is rejected before any sheet access', () => {
    const s = originSandbox({});
    const body = bodyOf(s.doGet({ parameter: { type: 'oltt' } }));

    assert.strictEqual(body.error, 'Unknown type: oltt');
    assert.strictEqual(body.retryable, false, 'the same typo cannot start working');
    assert.strictEqual(s.__counters.rangeReads, 0, 'and it must cost no build at all');
    assert.strictEqual(s.__counters.sheetLookups, 0, 'not even a sheet lookup');
  });

  await test('a retired action is refused and marked not worth retrying', () => {
    const s = originSandbox({});
    const body = bodyOf(s.doGet({ parameter: { action: 'heartbeat' } }));

    assert.strictEqual(body.error, 'Unknown action: heartbeat');
    assert.strictEqual(body.retryable, false,
      'a route that no longer exists cannot start existing');
    assert.strictEqual(s.__counters.rangeReads, 0, 'and it must cost no build');
  });

  await test('a missing type still means nap', () => {
    const s = originSandbox({});
    const body = bodyOf(s.doGet({ parameter: {} }));
    assert.ok(Array.isArray(body), 'the default must keep working');
  });

  await test('every registered type passes the guard', () => {
    ALL_TYPES.forEach((type) => {
      const s = originSandbox({});
      const body = bodyOf(s.doGet({ parameter: { type: type } }));
      assert.ok(!(body && body.error && /Unknown type/.test(body.error)),
        type + ' must not be refused by the type guard');
    });
  });

  /* ------------------------------------------------------------------ */

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
