// ==================== BOOT BUNDLE TESTS ====================
//
// Run: node tests/boot-bundle.test.js
//
// Zero dependencies. Loads the REAL boot-bundle.js into a vm sandbox with the globals
// index.html gives it, and checks the four things the opening now depends on:
//
//   1. ONE request, and all five modules come out of it — with OLT through the module's own
//      applier, because a payload stored in the wrong shape draws an empty table rather than
//      failing loudly. This app has already shipped that bug once.
//   2. A module the server could not answer, or a payload a module would refuse, is left
//      ALONE — never stored where a loader expects good data.
//   3. The gate is told, or the one request that replaced five is followed by five more.
//   4. It ALWAYS falls back. A missing route, an unknown-action envelope, a rejection, a
//      hang, a response with nothing usable in it — every one of them resolves to "load the
//      modules the way this app did before the bundle existed", which is what makes the
//      deploy order irrelevant and the change removable.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'boot-bundle.js'), 'utf8');

const OLT_ENVELOPE = { v: 3, f: ['P'], m: [], p: [], r: [], meta: { builtAt: 1700000000000 } };
const OLT_DECODED = [{ P: 'BENGUET', S: 'UP' }];

const PAYLOADS = () => ({
  nap: [{ A: 'LUZON', T: 3 }],
  lcp: { lcpAging: [{ A: 'LUZON' }], lcpImpact: [] },
  node: [{ D: 'BENGUET' }],
  backbone: [{ D: 'BENGUET', LINK: 'BB-1' }],
  olt: OLT_ENVELOPE
});

/**
 * @param {Object} [opts]
 * @param {Object} [opts.bundle]   the payloads the response carries
 * @param {string[]} [opts.missing] what the server said it could not answer
 * @param {Function} [opts.respond] replaces the whole response: returns the value to resolve
 * @param {Error} [opts.reject]     fetchWithRetry rejects with this
 * @param {boolean} [opts.never]    fetchWithRetry never settles (for the timeout path)
 * @param {Object} [opts.fetchGate] override the gate (e.g. one with no noteHydrated)
 * @param {Function} [opts.applier] override applyOltPayload
 */
function freshSandbox(opts) {
  opts = opts || {};

  const calls = { fetches: 0, urls: [], noteHydrated: [], applier: [] };
  const logs = [];
  const dataCache = { nap: null, lcp: null, olt: null, node: null, backbone: null };

  const defaultRespond = () => ({
    ok: true,
    at: 1700000000000,
    bundle: opts.bundle === undefined ? PAYLOADS() : opts.bundle,
    missing: opts.missing || []
  });

  const sandbox = {
    console: {
      log: (m) => logs.push('log:' + String(m)),
      warn: (m) => logs.push('warn:' + String(m))
    },
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    BASE_API_URL: 'https://example.invalid/exec',
    dataCache: dataCache,
    fetchWithRetry: function (url) {
      calls.fetches++;
      calls.urls.push(url);
      if (opts.never) return new Promise(function () {});
      if (opts.reject) return Promise.reject(opts.reject);
      return Promise.resolve((opts.respond || defaultRespond)());
    },
    fetchGate: opts.fetchGate || {
      noteHydrated: (type, builtAt) => { calls.noteHydrated.push({ type, builtAt }); }
    },
    applyOltPayload: opts.applier || function (payload) {
      calls.applier.push(payload);
      if (!payload || payload.v !== 3 || !payload.meta) return false;
      dataCache.olt = OLT_DECODED;
      return true;
    }
  };

  /* In a browser `window` IS the global object, so `window.bootFromBundle = fn` makes it
     callable as a bare global. A plain sandbox object would put the function somewhere the app
     can never reach it and leave the suite testing a shape the browser does not have. */
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'boot-bundle.js' });

  sandbox.__calls = calls;
  sandbox.__logs = logs;
  sandbox.__dataCache = dataCache;
  return sandbox;
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

function sorted(list) {
  return list.slice().sort().join(',');
}

(async () => {
  console.log('\nThe opening bundle — one request, five modules, always a fallback\n');

  /* ---------------------------------------------------------------- *
     1. One request, five modules
   * ---------------------------------------------------------------- */

  await test('the opening is exactly one request, to ?action=bundle', async () => {
    const s = freshSandbox();
    await s.bootFromBundle();

    assert.strictEqual(s.__calls.fetches, 1, 'expected one request, got ' + s.__calls.fetches);
    assert.ok(s.__calls.urls[0].indexOf('?action=bundle') !== -1,
      'asked for ' + s.__calls.urls[0]);

    /* Arrays built inside the vm have that realm's Array.prototype, so deepStrictEqual against
       a Node array fails on the prototype even when the contents match. Compare contents. */
    assert.strictEqual(sorted(s.__calls.noteHydrated.map((c) => c.type)),
      'backbone,lcp,nap,node,olt');
  });

  await test('all five modules land in dataCache', async () => {
    const s = freshSandbox();
    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.used, true);
    assert.strictEqual(sorted(summary.hydrated), 'backbone,lcp,nap,node,olt');
    assert.deepStrictEqual(s.__dataCache.nap, PAYLOADS().nap);
    assert.deepStrictEqual(s.__dataCache.lcp, PAYLOADS().lcp);
    assert.deepStrictEqual(s.__dataCache.node, PAYLOADS().node);
    assert.deepStrictEqual(s.__dataCache.backbone, PAYLOADS().backbone);
  });

  await test('OLT goes through the module\'s own applier, not into the cache raw', async () => {
    /* The bug this prevents has shipped here before: an OLT prefetch stored the raw compact
       envelope where a decoded row array belongs, so the tables and the summary cards
       described two different payloads. There is no second decoder — the bundle hands the
       envelope to the same function the ?type=olt path uses. */
    const s = freshSandbox();
    await s.bootFromBundle();

    assert.strictEqual(s.__calls.applier.length, 1, 'applyOltPayload must be called exactly once');
    assert.deepStrictEqual(s.__calls.applier[0], OLT_ENVELOPE, 'with the envelope as it arrived');
    assert.deepStrictEqual(s.__dataCache.olt, OLT_DECODED,
      'and dataCache.olt must hold what the applier decoded, not the envelope');
  });

  await test('the gate is told about every hydrated type, so nothing refetches what it was given', async () => {
    const s = freshSandbox();
    await s.bootFromBundle();

    assert.strictEqual(sorted(s.__calls.noteHydrated.map((c) => c.type)),
      'backbone,lcp,nap,node,olt',
      'a module that is not stamped goes straight back to the network');

    /* 0 is the honest built time for the four modules that carry no stamp, and noteBuiltAt()
       ignores a non-positive value — so this cannot overwrite OLT's real build time, which the
       applier took from the payload. */
    s.__calls.noteHydrated.forEach((c) => {
      assert.strictEqual(c.builtAt, 0, c.type + ' was stamped with a build time nobody measured');
    });
  });

  /* ---------------------------------------------------------------- *
     2. What must NOT be stored
   * ---------------------------------------------------------------- */

  await test('a module the server could not answer is left alone', async () => {
    const bundle = PAYLOADS();
    delete bundle.nap;

    const s = freshSandbox({ bundle: bundle, missing: ['nap'] });
    const summary = await s.bootFromBundle();

    assert.strictEqual(s.__dataCache.nap, null,
      'an absent module must stay absent, or the loader draws a table from nothing');
    assert.strictEqual(summary.hydrated.indexOf('nap'), -1);
    assert.strictEqual(sorted(summary.missing), 'nap');
  });

  await test('a payload of the wrong shape is refused, not stored', async () => {
    /* lcp is an object of two tables; its loader checks data.lcpAging before it stores. An
       array here would be stored happily and then draw an empty panel. */
    const bundle = PAYLOADS();
    bundle.lcp = [{ A: 'LUZON' }];

    const s = freshSandbox({ bundle: bundle });
    const summary = await s.bootFromBundle();

    assert.strictEqual(s.__dataCache.lcp, null, 'a wrong-shaped payload must not be stored');
    assert.strictEqual(sorted(summary.refused), 'lcp');
    assert.strictEqual(summary.hydrated.indexOf('lcp'), -1);
  });

  await test('a module that expects rows is refused an object', async () => {
    /* nap, node and backbone are row arrays and only lcp is an object, so the shape check has
       two halves — and a rule with one tested half is a rule nothing enforces. This is the
       other half: a table module handed an envelope must not store it and try to draw rows
       from it. */
    const s = freshSandbox({ bundle: Object.assign(PAYLOADS(), { backbone: { rows: [] } }) });
    const summary = await s.bootFromBundle();

    assert.strictEqual(s.__dataCache.backbone, null);
    assert.strictEqual(sorted(summary.refused), 'backbone');
    assert.strictEqual(sorted(summary.hydrated), 'lcp,nap,node,olt');
  });

  await test('an OLT payload its applier refuses is not half-hydrated', async () => {
    const s = freshSandbox({ bundle: Object.assign(PAYLOADS(), { olt: [] }) });
    const summary = await s.bootFromBundle();

    assert.strictEqual(sorted(summary.refused), 'olt');
    assert.strictEqual(s.__dataCache.olt, null, 'nothing may be written when the applier says no');
  });

  await test('a type this build has no module for is refused', async () => {
    /* A server that grows a module the client does not have yet must not be able to write into
       dataCache under a name nothing reads — and the client must not fall over either. */
    const s = freshSandbox({ bundle: Object.assign(PAYLOADS(), { analytics: [{ x: 1 }] }) });
    const summary = await s.bootFromBundle();

    assert.strictEqual(sorted(summary.refused), 'analytics');
    assert.strictEqual(s.__dataCache.analytics, undefined);
    assert.strictEqual(summary.used, true, 'an unknown type must not spoil the four that work');
  });

  await test('hydration still happens when the gate has no noteHydrated (a half-updated client)', async () => {
    /* Both files ship in one release and are precached in one generation, but a device caught
       mid-update can hold one of each. The bundle must not depend on a method that might not be
       there yet — it is bookkeeping, not the payload. */
    const s = freshSandbox({ fetchGate: {} });
    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.used, true);
    assert.strictEqual(sorted(summary.hydrated), 'backbone,lcp,nap,node,olt');
  });

  await test('an OLT payload is refused rather than stored raw when the module is not loaded', async () => {
    const s = freshSandbox({ applier: undefined });
    s.applyOltPayload = undefined;          // the module file never loaded
    const summary = await s.bootFromBundle();

    assert.strictEqual(s.__dataCache.olt, null,
      'storing the envelope here is exactly the wrong-shape bug, with a comment on top');
    assert.strictEqual(sorted(summary.refused), 'olt');
  });

  /* ---------------------------------------------------------------- *
     3. The fallback, which is the safety argument
   * ---------------------------------------------------------------- */

  await test('an older deployment answering "Unknown action" falls back', async () => {
    const s = freshSandbox({
      respond: () => ({ error: 'Unknown action: bundle', retryable: false })
    });
    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.used, false);
    assert.strictEqual(summary.hydrated.length, 0);
    assert.deepStrictEqual(s.__dataCache, { nap: null, lcp: null, olt: null, node: null, backbone: null },
      'nothing may be hydrated from a response that is not a bundle');
  });

  await test('an error envelope that fetchWithRetry throws on is caught, not propagated', async () => {
    /* fetchWithRetry() classifies {error:...} as a failure and throws. The bundle must not be
       the first thing in the app that turns that into an unhandled rejection. */
    const s = freshSandbox({ reject: new Error('origin: Unknown action: bundle') });
    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.used, false);
    assert.ok(summary.reason.indexOf('Unknown action') !== -1, 'the reason must be carried: ' + summary.reason);
  });

  await test('a hung request times out into the fallback instead of holding the opening', async () => {
    const s = freshSandbox({ never: true });
    s.bootBundle.configure({ timeoutMs: 20 });

    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.used, false);
    assert.ok(summary.reason.indexOf('timed out') !== -1, 'got: ' + summary.reason);
  });

  await test('a response with no bundle in it is not treated as one', async () => {
    const s = freshSandbox({ respond: () => ({ ok: true, at: 1 }) });
    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.used, false);
    assert.deepStrictEqual(s.__dataCache, { nap: null, lcp: null, olt: null, node: null, backbone: null });
  });

  await test('an ok response with an empty bundle is a fallback, not a silent empty app', async () => {
    const s = freshSandbox({ bundle: {} });
    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.used, false);
    assert.ok(summary.reason.indexOf('nothing usable') !== -1, 'got: ' + summary.reason);
  });

  await test('it says which path it took, in the console', async () => {
    /* The only evidence in the field that the route is being used at all. */
    const ok = freshSandbox();
    await ok.bootFromBundle();
    assert.ok(ok.__logs.some((l) => l.indexOf('5 module(s) in one request') !== -1),
      'a successful bundle must report itself: ' + ok.__logs.join(' | '));

    const bad = freshSandbox({ reject: new Error('boom') });
    await bad.bootFromBundle();
    assert.ok(bad.__logs.some((l) => l.indexOf('falling back to per-module loads') !== -1),
      'and a fallback must say so: ' + bad.__logs.join(' | '));
  });

  await test('the timeout is 15 s by default and configurable for tests', async () => {
    const s = freshSandbox();
    assert.strictEqual(s.bootBundle.timeoutMs(), 15000);
    s.bootBundle.configure({ timeoutMs: 5 });
    assert.strictEqual(s.bootBundle.timeoutMs(), 5);
    s.bootBundle.configure({ timeoutMs: 0 });
    assert.strictEqual(s.bootBundle.timeoutMs(), 5, 'a non-positive timeout must be ignored');
  });

  /* ---------------------------------------------------------------- */

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
