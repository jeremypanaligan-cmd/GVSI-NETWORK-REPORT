// ==================== ORIGIN RESILIENCE TESTS ====================
//
// Run: node tests/origin-resilience.test.js
//
// Zero dependencies. A transient failure on the origin is only survivable if BOTH
// ends handle it, so this file drives both:
//
//   ORIGIN (code.gs) — a spreadsheet handle or a sheet read that throws must come
//   back as an ANSWER: a JSON envelope that says "hiccup, ask again". Apps Script
//   turns an escaped exception into an HTML error page, and the app asks for JSON,
//   so res.json() threw on it — which is how a transient Sheets failure was read
//   as a wrong deployment URL, and why a single one left a module with no data.
//
//   CLIENT (fetchWithRetry in index.html) — that envelope must count as a failure
//   instead of parsing as data, must be retried with jitter, must NOT be retried
//   when the origin says retrying cannot help, must still attach the session
//   token, and must not spend a second request when the first one works.
//
// The client half pulls the real function out of index.html rather than a copy,
// so the retry policy cannot drift away from this test without failing here.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const CODE_SRC = fs.readFileSync(path.join(ROOT, 'code.gs'), 'utf8');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
   CLIENT — the real fetchWithRetry, lifted out of index.html
 * ------------------------------------------------------------------ */

function extractFetchWithRetry() {
  const lines = HTML_SRC.split('\n');
  const start = lines.findIndex((l) => l.indexOf('async function fetchWithRetry') !== -1);
  assert.ok(start !== -1, 'fetchWithRetry is not in index.html');

  /* Line-based, not brace-matched: the function's own closing brace is the first
     line that is exactly two spaces and a brace, because every brace inside it is
     indented further. The assertions below then pin what was extracted, so a drift
     in either direction fails here instead of passing quietly. */
  const end = lines.findIndex((l, i) => i > start && l.replace(/\r$/, '') === '  }');
  assert.ok(end > start, 'fetchWithRetry has no closing brace at function indent');

  const src = lines.slice(start, end + 1).join('\n');
  assert.ok(src.indexOf('retries = 2') !== -1, 'the default retry budget must be 2');
  assert.ok(src.indexOf('retryable') !== -1, 'the origin envelope must be classified');
  assert.ok(src.indexOf('lastErr = err') !== -1, 'the last failure must be reported');
  assert.ok(src.indexOf('withAuthToken') !== -1, 'the token must still be attached');
  return src;
}

function clientHarness(responses) {
  const calls = [];
  const waits = [];
  const warnings = [];
  let i = 0;

  const sandbox = {
    console: {
      log: () => {},
      error: () => {},
      warn: (...a) => warnings.push(a.join(' '))
    },
    /* Immediate timers, recorded: the backoff is what is under test, not the
       waiting. */
    setTimeout: (fn, ms) => { waits.push(ms); fn(); return 0; },
    fetch: (url) => {
      calls.push(url);
      const spec = responses[Math.min(i, responses.length - 1)];
      i++;
      if (spec.networkError) return Promise.reject(new Error('Failed to fetch'));
      return Promise.resolve({
        ok: (spec.status || 200) >= 200 && (spec.status || 200) < 300,
        status: spec.status || 200,
        json: () => (spec.html
          ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
          : Promise.resolve(spec.body))
      });
    },
    withAuthToken: (u) => u + (u.indexOf('?') === -1 ? '?' : '&') + 'token=SESSION123',
    safeApiUrlForLog: (u) => u.replace(/token=[^&]*/, 'token=[redacted]')
  };

  vm.createContext(sandbox);
  vm.runInContext(
    extractFetchWithRetry() + '\n;globalThis.fetchWithRetry = fetchWithRetry;',
    sandbox,
    { filename: 'index.html:fetchWithRetry' }
  );

  return { sandbox, calls, waits, warnings };
}

async function callFetch(h, url) {
  try {
    return { data: await h.sandbox.fetchWithRetry(url, 2, 500) };
  } catch (error) {
    return { error };
  }
}

const URL_NAP = 'https://script.google.com/macros/s/XXX/exec?type=nap';

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
    assert.ok(logged(s, 'Build failed'), 'and it is logged on the origin too');
  });

  console.log('\n-- origin: a failure log names the place, not just the module --');

  await test('the failure log carries type, stage, sheet, rev and elapsed time', () => {
    const s = originSandbox({ readThrows: true, props: { data_rev_nap: '7' } });
    s.doGet(NAP());

    const line = s.__logs.find((l) => l.indexOf('Build failed') !== -1) || '';
    assert.ok(/type=nap/.test(line), 'which module: ' + line);
    assert.ok(/stage=nap/.test(line), 'which branch, not just which module: ' + line);
    assert.ok(/sheet="NLZ NAP Report"/.test(line),
      'the sheet being read, which is the whole point: ' + line);
    assert.ok(/rev=7/.test(line), 'the revision the build started against: ' + line);
    assert.ok(/after \d+ms/.test(line), 'and how long it had been running: ' + line);
    assert.ok(/temporarily unavailable/.test(line), 'the cause stays too');
  });

  await test('the stage survives a failure that happens after the lookup', () => {
    /* The read throws inside getValues(), which is past openSheet_ — so this is the
       case where a bare exception would name nothing at all. */
    const s = originSandbox({ readThrows: true });
    s.doGet(NAP());
    const line = s.__logs.find((l) => l.indexOf('Build failed') !== -1) || '';
    assert.ok(/stage=nap/.test(line) && /sheet="NLZ NAP Report"/.test(line),
      'the record has to be written BEFORE the read it describes: ' + line);
  });

  await test('a handle that cannot be opened names the sheet it could not reach', () => {
    const s = originSandbox({ handleNull: true });
    s.doGet(NAP());

    const line = s.__logs.find((l) => l.indexOf('Build failed') !== -1) || '';
    assert.ok(/stage=nap/.test(line), line);
    assert.ok(/sheet="NLZ NAP Report"/.test(line), line);
    assert.ok(/No spreadsheet handle/.test(line),
      'and says what actually happened, not "Cannot read properties of null": ' + line);
  });

  await test('a missing sheet is logged, not silently answered with nothing', () => {
    /* The question this answers: ?type=node returning [] is the same answer whether
       the sheet is missing, empty, or renamed — and until this log, nothing said
       which. */
    const s = originSandbox({});
    const body = bodyOf(s.doGet({ parameter: { type: 'node' } }));

    assert.deepStrictEqual(body, [], 'the payload is unchanged — still an empty list');
    const line = s.__logs.find((l) => l.indexOf('Sheet not found') !== -1) || '';
    assert.ok(/"Node DOWN Tickets"/.test(line), 'the sheet is named: ' + line);
    assert.ok(/type=node/.test(line) && /stage=node/.test(line), line);
  });

  await test('a sheet that exists and is empty logs nothing', () => {
    const s = originSandbox({});
    s.doGet(NAP());
    assert.strictEqual(s.__logs.filter((l) => l.indexOf('Sheet not found') !== -1).length, 0,
      'the warning has to stay rare enough to mean something');
  });

  await test('the diagnostics stay in the log and out of the response', () => {
    const s = originSandbox({ readThrows: true, props: { data_rev_nap: '7' } });
    const body = bodyOf(s.doGet(NAP()));

    assert.deepStrictEqual(Object.keys(body).sort(), ['error', 'message', 'retryable', 'type'],
      'the envelope is a contract with fetchWithRetry() and does not grow fields');
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

  /* ==================== CLIENT ==================== */

  console.log('\n-- client: fetchWithRetry spends its budget on transient failures --');

  await test('a non-OK status is retried and then reported', async () => {
    const h = clientHarness([{ status: 404 }]);   // the echo hop's 404
    const r = await callFetch(h, URL_NAP);

    assert.strictEqual(h.calls.length, 3, 'three attempts, not one');
    assert.ok(/HTTP 404/.test(r.error.message), 'the status must survive into the error');
  });

  await test('a non-JSON body is a failure, never data', async () => {
    const h = clientHarness([{ html: true }]);    // the ~8 KB error page
    const r = await callFetch(h, URL_NAP);

    assert.strictEqual(r.data, undefined, 'an error page must not be returned as data');
    assert.strictEqual(h.calls.length, 3);
  });

  await test('a retryable origin envelope is retried, not rendered', async () => {
    const h = clientHarness([{ body: { error: 'build_failed', retryable: true } }]);
    const r = await callFetch(h, URL_NAP);

    assert.strictEqual(r.data, undefined, 'the envelope must not reach the module as data');
    assert.strictEqual(h.calls.length, 3, 'a hiccup is worth the whole budget');
    assert.ok(/origin: build_failed/.test(r.error.message));
  });

  await test('a non-retryable envelope stops after one attempt', async () => {
    const h = clientHarness([{ body: { error: 'Unknown type: oltt', retryable: false } }]);
    const r = await callFetch(h, URL_NAP);

    assert.strictEqual(h.calls.length, 1, 'the same request cannot start working');
    assert.ok(/origin: Unknown type: oltt/.test(r.error.message));
    assert.ok(/Failed after 1 attempt:/.test(r.error.message),
      'and the message must not claim attempts that never happened');
  });

  await test('a transient failure recovers inside the request', async () => {
    const h = clientHarness([
      { status: 404 },
      { body: { A: 'AREA-1' } }
    ]);
    const r = await callFetch(h, URL_NAP);

    assert.deepStrictEqual(r.data, { A: 'AREA-1' }, 'the second attempt must reach the caller');
    assert.strictEqual(h.calls.length, 2, 'and stop there');
  });

  await test('a network error is retried like any other transient', async () => {
    const h = clientHarness([{ networkError: true }, { body: [] }]);
    const r = await callFetch(h, URL_NAP);

    assert.deepStrictEqual(r.data, []);
    assert.strictEqual(h.calls.length, 2);
  });

  await test('a working first attempt costs exactly one request', async () => {
    const h = clientHarness([{ body: { ok: true } }]);
    const r = await callFetch(h, URL_NAP);

    assert.deepStrictEqual(r.data, { ok: true });
    assert.strictEqual(h.calls.length, 1, 'no speculative extra request');
    assert.deepStrictEqual(h.waits, [], 'and no backoff at all');
  });

  await test('the session token is still attached', async () => {
    const h = clientHarness([{ body: [] }]);
    await callFetch(h, URL_NAP);
    assert.ok(/token=SESSION123/.test(h.calls[0]), 'every attempt must carry it');
  });

  await test('backoff is bounded per attempt and jittered across runs', async () => {
    for (let n = 0; n < 20; n++) {
      const h = clientHarness([{ status: 500 }]);
      await callFetch(h, URL_NAP);

      assert.strictEqual(h.waits.length, 2, 'two waits for three attempts');
      assert.ok(h.waits[0] >= 250 && h.waits[0] <= 750,
        'attempt 1 waits half-to-1.5x of 500ms, got ' + h.waits[0]);
      assert.ok(h.waits[1] >= 500 && h.waits[1] <= 1500,
        'attempt 2 doubles that, got ' + h.waits[1]);
    }

    /* Twenty identical draws from a continuous interval would mean the jitter is
       not being applied — and lockstep retries are what this is here to avoid. */
    const drawn = new Set();
    for (let n = 0; n < 20; n++) {
      const h = clientHarness([{ status: 500 }]);
      await callFetch(h, URL_NAP);
      drawn.add(h.waits[0]);
    }
    assert.ok(drawn.size >= 5, 'the first backoff must vary between runs, saw ' + drawn.size);
  });

  await test('the redacted URL reaches the log, never the token', async () => {
    const h = clientHarness([{ status: 404 }]);
    await callFetch(h, URL_NAP);

    assert.ok(h.warnings.length === 3, 'one warning per attempt');
    assert.ok(h.warnings.every((w) => w.indexOf('token=[redacted]') !== -1));
    assert.ok(h.warnings.every((w) => w.indexOf('SESSION123') === -1),
      'the session token must never be printed');
  });

  /* ------------------------------------------------------------------ */

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
