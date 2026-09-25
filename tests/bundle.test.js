// ==================== OPENING BUNDLE TESTS ====================
//
// Run: node tests/bundle.test.js
//
// Zero dependencies. Loads the REAL code.gs into a vm sandbox with stubbed Apps Script
// services and checks the five claims the bundle route rests on:
//
//   1. All five modules are answered from ONE call, from the keys the app actually reads.
//   2. It BUILDS NOTHING: no spreadsheet, no cache write, no revision, no claim.
//   3. A module with no live entry is reported missing — never built inline.
//   4. It judges an entry alive by exactly the rules doGet uses, including the
//      PropertiesService fallback's hand-stamped expiry.
//   5. It fails OPEN onto the slow path (everything missing), never onto an error.
//
// Claim 2 is the one that would be easy to lose quietly. A bundle that built its own
// missing modules would look identical in a happy-path test and would be a second,
// slower copy of the request path — five sequential builds between an operator and the
// screen they just opened, which is the complaint this whole part exists to answer.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

const RAW = {
  nap: JSON.stringify([{ A: 'LUZON', P: 'BENGUET', T: 3 }]),
  lcp: JSON.stringify({ lcpAging: [{ A: 'LUZON' }], lcpImpact: [] }),
  node: JSON.stringify([{ D: 'BENGUET', NPE: 'N1' }]),
  backbone: JSON.stringify([{ D: 'BENGUET', LINK: 'BB-1' }]),
  olt: JSON.stringify({ v: 3, f: ['P'], m: [], p: [], r: [], meta: { builtAt: 1700000000000, up: 2 } })
};

const KEY = {
  nap: 'cache_v2_nap',
  lcp: 'cache_v2_lcp',
  node: 'cache_v2_node',
  backbone: 'cache_v2_backbone',
  olt: 'cache_v2_olt_c3'
};

function warmCache(types) {
  const out = {};
  (types || Object.keys(KEY)).forEach((t) => { out[KEY[t]] = RAW[t]; });
  return out;
}

/* ------------------------------------------------------------------ *
   Apps Script service stubs
 * ------------------------------------------------------------------ */

/**
 * @param {Object} [opts]
 * @param {Object} [opts.cache]        pre-seeded CacheService entries (key -> string)
 * @param {Object} [opts.props]        pre-seeded script properties
 * @param {boolean} [opts.getAllThrows] make CacheService.getAll throw
 */
function freshSandbox(opts) {
  opts = opts || {};
  const counters = { opens: 0, cacheGets: 0, getAlls: 0, propReads: 0 };
  const store = Object.assign({}, opts.cache || {});
  const puts = [];
  const removed = [];
  const props = Object.assign({}, opts.props || {});
  const propsWritten = [];
  const deleted = [];
  const logs = [];
  const keysRead = [];

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => {
        counters.opens++;
        /* No sheets at all: every branch answers its empty payload. That is deliberate —
           a bundle test must not need real sheet fixtures, and a branch that reaches for
           the spreadsheet is exactly what these tests count. */
        return { getSheetByName: () => null };
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          counters.cacheGets++;
          keysRead.push(k);
          return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
        },
        getAll: (ks) => {
          counters.getAlls++;
          ks.forEach((k) => keysRead.push(k));
          if (opts.getAllThrows) throw new Error('cache service unavailable');
          const out = {};
          ks.forEach((k) => {
            if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          });
          return out;
        },
        put: (key, value, ttl) => { puts.push({ key, value, ttl }); store[key] = value; },
        remove: (key) => { removed.push(key); delete store[key]; }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => { counters.propReads++; return props[k] === undefined ? null : props[k]; },
        getProperties: () => Object.assign({}, props),
        setProperty: (k, v) => { propsWritten.push(k); props[k] = v; },
        deleteProperty: (k) => { deleted.push(k); delete props[k]; }
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

    /* Stands in for admin.gs's jsonOut, exactly as the other code.gs suites do. admin.gs
       is not loaded here: it is not what this suite is testing, and its presence would put
       the whole login surface between the route and the assertion. */
    jsonOut: (obj) => ({
      _text: JSON.stringify(obj),
      setMimeType() { return this; },
      getContent() { return this._text; }
    })
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'code.gs'), 'utf8'), sandbox, { filename: 'code.gs' });

  sandbox.__puts = puts;
  sandbox.__removed = removed;
  sandbox.__propsWritten = propsWritten;
  sandbox.__deleted = deleted;
  sandbox.__props = props;
  sandbox.__logs = logs;
  sandbox.__keysRead = keysRead;
  sandbox.__counters = counters;
  return sandbox;
}

const BUNDLE_REQ = () => ({ parameter: { action: 'bundle' } });

function bundleOf(s) {
  return JSON.parse(s.doGet(BUNDLE_REQ()).getContent());
}

function sorted(list) {
  return list.slice().sort().join(',');
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

console.log('\nThe opening bundle — one call, five modules, no builds\n');

/* ------------------------------------------------------------------ *
   1. What it answers
 * ------------------------------------------------------------------ */

test('one call answers all five modules, parsed, with nothing reported missing', () => {
  const s = freshSandbox({ cache: warmCache() });
  const res = bundleOf(s);

  assert.strictEqual(res.ok, true, 'the route must answer with ok:true');
  assert.ok(typeof res.at === 'number' && res.at > 0, 'and stamp when it answered');
  assert.deepStrictEqual(res.missing, [], 'a warm cache has nothing missing');

  ['nap', 'lcp', 'node', 'backbone', 'olt'].forEach((t) => {
    assert.ok(res.bundle[t] !== undefined, t + ' must be in the bundle');
  });

  assert.deepStrictEqual(res.bundle.nap, JSON.parse(RAW.nap), 'nap payload must survive intact');
  assert.strictEqual(res.bundle.olt.v, 3, 'the OLT envelope must come through as the client reads it');
  assert.strictEqual(res.bundle.olt.meta.builtAt, 1700000000000,
    'and the build stamp inside it, which is how the age chip stays honest');
});

test('the payloads are embedded as JSON, not as escaped strings', () => {
  /* The whole point of this route is to move fewer bytes. Passing each cached value
     through as a string would escape every quote in it and roughly double those bytes,
     and hand the client a second parse to do. */
  const s = freshSandbox({ cache: warmCache() });
  const body = s.doGet(BUNDLE_REQ()).getContent();

  const rawBytes = Object.keys(RAW).reduce((n, t) => n + RAW[t].length, 0);
  assert.ok(body.length < rawBytes * 1.6,
    'the response is ' + body.length + ' bytes for ' + rawBytes + ' bytes of payload — ' +
    'that is doubled, which is what escaping looks like');
  assert.ok(body.indexOf('\\"') === -1, 'no escaped quotes: the values are parsed objects');
});

test('?action=bundle is a route, not an unknown action', () => {
  const s = freshSandbox({ cache: warmCache() });
  assert.strictEqual(bundleOf(s).error, undefined,
    'the unknown-action guard would answer {error:"Unknown action: bundle"}');
});

test('an action that really is unknown still gets the envelope it always got', () => {
  /* Sits next to the route test on purpose: inserting a route must not swallow the guard
     that protects the data branch from a typo'd or retired action. */
  const s = freshSandbox({ cache: warmCache() });
  const res = JSON.parse(s.doGet({ parameter: { action: 'bundleX' } }).getContent());

  assert.strictEqual(typeof res.error, 'string', 'an unknown action must still be refused');
  assert.strictEqual(res.retryable, false, 'and non-retryably, so the client spends one request');
});

/* ------------------------------------------------------------------ *
   2. What it must NOT do
 * ------------------------------------------------------------------ */

test('it opens no spreadsheet: the bundle is incapable of building anything', () => {
  const s = freshSandbox();          // no cache at all — the tempting case to build for
  const res = bundleOf(s);

  assert.strictEqual(s.__counters.opens, 0,
    'the bundle reached for the spreadsheet; a route whose job is to answer fast must not ' +
    'be able to start a build');
  assert.strictEqual(s.__counters.propReads > 0, true,
    'it should still have looked in the PropertiesService fallback before giving up');
  assert.strictEqual(res.missing.length, 5, 'and then told the truth about all five');
});

test('a cold module is reported missing, not built inline', () => {
  const s = freshSandbox({ cache: { [KEY.nap]: RAW.nap } });
  const res = bundleOf(s);

  assert.strictEqual(res.bundle.nap !== undefined, true, 'the warm one is served');
  assert.strictEqual(sorted(res.missing), 'backbone,lcp,node,olt',
    'the four cold ones must be named, not built: got ' + sorted(res.missing));
  assert.strictEqual(s.__counters.opens, 0, 'and nothing may be built to fill the gap');
});

test('it writes nothing: no cache entry, no revision, no forced-rebuild claim', () => {
  const s = freshSandbox({ cache: warmCache() });
  bundleOf(s);

  assert.strictEqual(s.__puts.length, 0, 'no cache put');
  assert.strictEqual(s.__removed.length, 0, 'no cache remove');
  assert.strictEqual(s.__propsWritten.length, 0,
    'no property written at all — which covers the revision counters and the ?fresh=1 ' +
    'claim without this test having to know their names');
  assert.strictEqual(s.__deleted.length, 0, 'and nothing deleted');
});

/* ------------------------------------------------------------------ *
   3. The keys — the app's keys, not a second list
 * ------------------------------------------------------------------ */

test('the keys the bundle asks for are exactly the keys doGet asks for', () => {
  /* The drift this catches is silent in production: a bundle that asks for cache_v2_olt
     instead of cache_v2_olt_c3, or that misses a type added to DATA_TYPES later, simply
     reports those modules missing forever and the app quietly refetches them one by one. */
  const s = freshSandbox();

  const wanted = s.bundleKeys_().map((e) => e.key);
  const perType = [];
  ['nap', 'lcp', 'node', 'backbone'].forEach((t) => {
    s.__keysRead.length = 0;
    s.doGet({ parameter: { type: t } });
    perType.push(s.__keysRead[0]);
  });
  s.__keysRead.length = 0;
  s.doGet({ parameter: { type: 'olt', shape: '3' } });
  perType.push(s.__keysRead[0]);

  assert.strictEqual(sorted(wanted), sorted(perType),
    'bundle keys [' + sorted(wanted) + '] must be the keys the request path reads [' +
    sorted(perType) + ']');
});

test('OLT is read from the shape the dashboard asks for, never the legacy key', () => {
  const legacy = freshSandbox({
    cache: { cache_v2_olt: RAW.olt, cache_v2_olt_c4: RAW.olt }
  });
  assert.strictEqual(bundleOf(legacy).missing.indexOf('olt') !== -1, true,
    'the legacy shape and shape=4 have no caller on load and must not satisfy the bundle');

  const right = freshSandbox({ cache: { [KEY.olt]: RAW.olt } });
  assert.strictEqual(bundleOf(right).bundle.olt.v, 3, 'shape=3 is what the app reads');
});

/* ------------------------------------------------------------------ *
   4. The expiry rules, which are doGet's rules
 * ------------------------------------------------------------------ */

test('the PropertiesService fallback is served when live, and expired by the same TTL', () => {
  const now = Date.now();

  const live = freshSandbox({
    props: { [KEY.lcp]: RAW.lcp, [KEY.lcp + '_cached_at']: String(now - 10 * 1000) }
  });
  assert.strictEqual(bundleOf(live).bundle.lcp !== undefined, true,
    'a property-backed entry inside its TTL is live — this is the >90 KB fallback path');

  const dead = freshSandbox({
    props: { [KEY.lcp]: RAW.lcp, [KEY.lcp + '_cached_at']: String(now - 400 * 1000) }
  });
  assert.strictEqual(bundleOf(dead).missing.indexOf('lcp') !== -1, true,
    '400 s old against a 180 s TTL is expired');
});

test('an expired property entry is not DELETED — a read must not be a write', () => {
  const s = freshSandbox({
    props: { [KEY.lcp]: RAW.lcp, [KEY.lcp + '_cached_at']: String(Date.now() - 400 * 1000) }
  });
  bundleOf(s);

  assert.strictEqual(s.__deleted.length, 0,
    'doGet drops a dead entry on its way past; this route must leave it. Dropping it is ' +
    'the next real request\'s job, or asking what is cached becomes a mutation');
  assert.strictEqual(s.__props[KEY.lcp], RAW.lcp, 'and the value is still there');
});

test('an unstamped property entry is not trusted', () => {
  /* Covered by the same comparison as the test above it, by construction: the stamp IS
     the age, and a missing stamp reads as 0, which is 19700 days against any TTL. The
     assertion is kept because it pins down the behaviour a reader would want to check —
     no path may answer "I cannot tell how old this is, so here it is". The mutation that
     catches it is the one that removes the expiry comparison entirely. */
  const s = freshSandbox({ props: { [KEY.node]: RAW.node } });
  assert.strictEqual(bundleOf(s).missing.indexOf('node') !== -1, true,
    'without a stamp there is no way to know its age, and an unreadable age is not a licence ' +
    'to serve it');
});

test('the TTL a client build is written with is the TTL the bundle judges by', () => {
  /* One function, two callers. If these ever come apart, one route calls a payload live
     while the other calls it expired — and the bundle would serve bytes the request path
     refuses to. */
  ['nap', 'lcp', 'node', 'backbone', 'olt'].forEach((t) => {
    const s = freshSandbox();
    const event = { parameter: { type: t } };
    if (t === 'olt') event.parameter.shape = '3';
    s.doGet(event);

    assert.ok(s.__puts.length >= 1, t + ' must have written its entry');
    assert.strictEqual(s.__puts[0].ttl, s.cacheTtlFor_(t),
      t + ' was cached with TTL ' + s.__puts[0].ttl + 's but cacheTtlFor_ says ' +
      s.cacheTtlFor_(t) + 's');
  });
});

/* ------------------------------------------------------------------ *
   5. How it fails
 * ------------------------------------------------------------------ */

test('a cached payload that will not parse is reported missing, not shipped broken', () => {
  const s = freshSandbox({ cache: { [KEY.lcp]: 'not json{', [KEY.nap]: RAW.nap } });
  const res = bundleOf(s);

  assert.strictEqual(res.missing.indexOf('lcp') !== -1, true,
    'an unreadable payload must be reported as unavailable rather than handed over');
  assert.strictEqual(res.bundle.lcp, undefined, 'and must not appear in the bundle');
  assert.ok(s.__logs.some((l) => l.indexOf('lcp') !== -1 && l.indexOf('not JSON') !== -1),
    'and the log must say which module and why');
});

test('a CacheService that throws degrades to all-missing rather than to an error', () => {
  /* Fail open onto the slow path. The client then fetches the five modules one at a time,
     which is exactly what it did before this route existed — so the worst case of this
     route failing is the app as it was, not an app with no data. */
  const s = freshSandbox({ cache: warmCache(), getAllThrows: true });
  const res = bundleOf(s);

  assert.strictEqual(res.ok, true, 'still a valid response');
  assert.strictEqual(res.missing.length, 5, 'with every module named missing');
  assert.ok(s.__logs.some((l) => l.indexOf('cache read failed') !== -1),
    'and a log line, because a bundle that silently serves nothing is the failure this ' +
    'project keeps having to hunt');
});

test('one read answers all five — this is the entire point of the route', () => {
  const s = freshSandbox({ cache: warmCache() });
  bundleOf(s);

  assert.strictEqual(s.__counters.getAlls, 1,
    'expected exactly one CacheService.getAll for five modules, got ' + s.__counters.getAlls);
  assert.strictEqual(s.__counters.cacheGets, 0,
    'and no per-key reads: five reads is the behaviour this route replaces');
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
