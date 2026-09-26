// ==================== THE EDGE READ PATH (CLIENT) ====================
// Run: node tests/cdn-read.test.js
//
// cdn-source.js is the only file that knows how to read a payload from the edge, and
// fetch-gate.js is the one place that decides whether to try. This suite holds the two rules that
// make that safe to ship:
//
//   1. THE EDGE CAN ONLY EVER BE FASTER. Every module call site still asks for its `/exec` URL;
//      the edge attempt is put in front of it and any refusal — no token, an expired token, 401,
//      a 404 for a type the trigger has not published, a timeout, an envelope, a body that will
//      not parse — drops straight through to the call this app has always made. Nothing here may
//      end with a module that has no data and no error.
//   2. AFTER TWO MISSES IT STANDS DOWN. A device against a worker that was deleted would otherwise
//      add a failed attempt to every read for the rest of the session.
//
// The freshness rule is asserted too, because it is the reason the edge path is worth having at
// all: the payload carries the time it was BUILT, and that is what the chip must report — not the
// time the browser asked.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const EDGE = 'https://edge.test';
const EXEC = 'https://script.google.com/macros/s/abc/exec';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); }, (err) => {
    failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message);
  });
}

function jsonResponse(body, opts) {
  const o = opts || {};
  const headers = o.headers || {};
  const status = o.status || 200;
  return {
    ok: status >= 200 && status < 300,
    status: status,
    headers: { get: (name) => (Object.prototype.hasOwnProperty.call(headers, name) ? headers[name] : null) },
    json: () => Promise.resolve(body)
  };
}

/* The payload /exec answers with, distinguishable from the edge's by the province name. */
function execPayloadFor(url) {
  if (url.indexOf('?type=lcp') !== -1) return { lcpAging: [{ A: 'LUZON', P: 'FROM-EXEC' }], lcpImpact: [] };
  if (url.indexOf('?action=bundle') !== -1) return { ok: true, bundle: { nap: [{ A: 'LUZON', P: 'FROM-EXEC-BUNDLE' }] } };
  return [{ A: 'LUZON', P: 'FROM-EXEC', H: 1, D1: 0, D3: 0, T: 1 }];
}

/**
 * @param {Object} cfg
 * @param {string} [cfg.cdn]            value of window.NETPULSE_CDN ('' = the feature off)
 * @param {Object} [cfg.storage]        seeded localStorage
 * @param {Array}  [cfg.edgeResponses]  one entry per edge call: a response, or {reject}
 */
function sandbox(cfg) {
  const o = cfg || {};
  const store = Object.assign({}, o.storage || {});
  const calls = [];
  const warnings = [];
  const queue = (o.edgeResponses || []).slice();

  const s = {
    console: {
      log: () => {}, error: () => {},
      warn: (message) => { warnings.push(String(message)); }
    },
    AbortSignal: { timeout: (ms) => ({ edgeTimeoutMs: ms }) },
    /* The gate and the bundle both race their own timeouts; a vm context has no timers of its
       own, and "setTimeout is not defined" would be reported as a failed read. */
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    document: {
      getElementById: () => null,
      createElement: () => ({
        className: '', textContent: '', headers: [],
        setAttribute() {}, getAttribute() { return null; }, appendChild() {}
      }),
      querySelector: () => null,
      querySelectorAll: () => []
    },
    localStorage: {
      getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
      clear: () => { Object.keys(store).forEach((k) => delete store[k]); }
    },
    BASE_API_URL: EXEC,
    dataCache: { nap: null, lcp: null, olt: null, node: null, backbone: null },
    applyOltPayload: (payload) => !!payload && typeof payload === 'object',
    NETPULSE_CDN: o.cdn === undefined ? EDGE : o.cdn,
    fetchWithRetry: (url) => {
      calls.push({ via: 'exec', url: url });
      return Promise.resolve(execPayloadFor(url));
    },
    fetch: (url, options) => {
      calls.push({ via: 'edge', url: url, options: options });
      const next = queue.shift();
      if (!next) return Promise.reject(new Error('the test planned no edge call for ' + url));
      if (next.reject) return Promise.reject(next.reject);
      return Promise.resolve(next);
    }
  };

  s.window = s;
  vm.createContext(s);
  vm.runInContext(read('fetch-gate.js'), s, { filename: 'fetch-gate.js' });
  vm.runInContext(read('cdn-source.js'), s, { filename: 'cdn-source.js' });
  vm.runInContext(read('boot-bundle.js'), s, { filename: 'boot-bundle.js' });

  s.__calls = calls;
  s.__warnings = warnings;
  s.__store = store;
  s.__edgeCalls = () => calls.filter((c) => c.via === 'edge');
  s.__execCalls = () => calls.filter((c) => c.via === 'exec');
  s.__lastEdge = () => calls.filter((c) => c.via === 'edge').slice(-1)[0];
  return s;
}

const napExecUrl = () => EXEC + '?type=nap';

function seededToken(expiryOffsetMs) {
  return {
    netpulse_cdn_token: 'subject.signature',
    netpulse_cdn_expiry: String(Date.now() + (expiryOffsetMs === undefined ? 60000 : expiryOffsetMs))
  };
}

(async () => {
  console.log('\nThe edge read path\n');

  /* ---------------------------------------------------------------- *
     When it must not be used at all
   * ---------------------------------------------------------------- */

  await test('a blank host means the edge is never asked', async () => {
    const s = sandbox({ cdn: '', storage: seededToken() });
    const data = await s.fetchGate.run('nap', napExecUrl());

    assert.strictEqual(s.__edgeCalls().length, 0, 'the switch is one value, and this is it');
    assert.strictEqual(data[0].P, 'FROM-EXEC');
  });

  await test('no stored token means the edge is never asked', async () => {
    const s = sandbox({ storage: {} });
    await s.fetchGate.run('nap', napExecUrl());

    assert.strictEqual(s.cdnSource.enabled(), false);
    assert.strictEqual(s.__edgeCalls().length, 0, 'a device that logged in before this shipped');
    assert.strictEqual(s.__execCalls().length, 1);
  });

  await test('an EXPIRED token is treated as no token, and cleared', async () => {
    const s = sandbox({ storage: seededToken(-1000) });
    await s.fetchGate.run('nap', napExecUrl());

    assert.strictEqual(s.__edgeCalls().length, 0, 'the session it belonged to is over');
    assert.strictEqual(s.__store.netpulse_cdn_token, undefined, 'and it is not left lying around');
  });

  /* ---------------------------------------------------------------- *
     The read itself
   * ---------------------------------------------------------------- */

  await test('with a token, the read comes from the edge — one request, no /exec', async () => {
    const s = sandbox({
      storage: seededToken(),
      edgeResponses: [jsonResponse([{ A: 'LUZON', P: 'FROM-EDGE', H: 4, D1: 1, D3: 0, T: 5 }],
                                   { headers: { 'x-netpulse-built-at': '1700000000000' } })]
    });

    const data = await s.fetchGate.run('nap', napExecUrl());
    const call = s.__lastEdge();

    assert.strictEqual(data[0].P, 'FROM-EDGE', 'the payload is the edge\'s, not the origin\'s');
    assert.strictEqual(s.__execCalls().length, 0, 'and Apps Script was not asked at all');
    assert.strictEqual(call.url, EDGE + '/data/nap');
    assert.strictEqual(call.options.headers.authorization, 'Bearer subject.signature',
      'the token the deployment minted at login is what makes the copy readable');
    assert.strictEqual(call.options.cache, 'no-store',
      'the browser must not answer from disk: the copy that matters is the one at the edge');
    assert.ok(call.options.signal && call.options.signal.edgeTimeoutMs > 0,
      'and the attempt cannot hang — it has its own timeout');
  });

  await test('the payload\'s BUILD time is what the chip reports, not the fetch time', async () => {
    const builtAt = Date.now() - 7 * 60 * 1000;
    const s = sandbox({
      storage: seededToken(),
      edgeResponses: [jsonResponse([{ A: 'LUZON', P: 'BENGUET' }], { headers: { 'x-netpulse-built-at': String(builtAt) } })]
    });

    await s.fetchGate.run('nap', napExecUrl());

    assert.strictEqual(s.fetchGate.dataBuiltAt('nap'), builtAt,
      'the age of the DATA: a payload built seven minutes ago must not read as just fetched');
  });

  await test('a header with no stamp leaves the chip on its honest fallback', async () => {
    const s = sandbox({
      storage: seededToken(),
      edgeResponses: [jsonResponse([{ A: 'LUZON', P: 'BENGUET' }])]
    });

    await s.fetchGate.run('nap', napExecUrl());

    assert.strictEqual(s.fetchGate.dataBuiltAt('nap'), 0,
      '0 is "the source did not say", which the chip renders differently from a timestamp');
    assert.ok(s.fetchGate.lastFetch('nap') > 0, 'while the fetch itself is still stamped');
  });

  /* ---------------------------------------------------------------- *
     Every refusal falls through to the path that always existed
   * ---------------------------------------------------------------- */

  await test('a 401 falls back to /exec — the module still gets its data', async () => {
    const s = sandbox({ storage: seededToken(), edgeResponses: [jsonResponse({ error: 'unauthorized' }, { status: 401 })] });
    const data = await s.fetchGate.run('nap', napExecUrl());

    assert.strictEqual(data[0].P, 'FROM-EXEC');
    assert.strictEqual(s.__edgeCalls().length, 1, 'it was tried');
    assert.strictEqual(s.__execCalls().length, 1, 'and the pre-existing path answered');
  });

  await test('a 404 for a type that has not been published yet falls back too', async () => {
    const s = sandbox({ storage: seededToken(), edgeResponses: [jsonResponse({ error: 'not_published' }, { status: 404 })] });
    const data = await s.fetchGate.run('lcp', EXEC + '?type=lcp');

    assert.deepStrictEqual(data.lcpAging[0].P, 'FROM-EXEC',
      'the state of every type before the first trigger run after a deploy');
  });

  await test('an ENVELOPE is refused, even with a 200', async () => {
    const s = sandbox({ storage: seededToken(), edgeResponses: [jsonResponse({ error: 'build_failed', retryable: true })] });
    const data = await s.fetchGate.run('nap', napExecUrl());

    assert.strictEqual(data[0].P, 'FROM-EXEC',
      'a parseable envelope is how an empty table with no error on it gets drawn');
    assert.ok(s.__warnings.some((w) => w.indexOf('edge read refused') !== -1),
      'and the fallback is named in the console — a refusal nobody can see is a refusal nobody ' +
      'can fix');
  });

  await test('a rejected fetch (timeout, DNS, offline) falls back', async () => {
    const s = sandbox({ storage: seededToken(), edgeResponses: [{ reject: new Error('The operation was aborted') }] });
    const data = await s.fetchGate.run('nap', napExecUrl());

    assert.strictEqual(data[0].P, 'FROM-EXEC');
    assert.strictEqual(s.__execCalls().length, 1);
  });

  await test('a stored token is used by an adopt, and dropped by a logout', async () => {
    const s = sandbox({ cdn: EDGE, storage: {}, edgeResponses: [
      jsonResponse([{ A: 'LUZON', P: 'FROM-EDGE' }], { headers: { 'x-netpulse-built-at': '1700000000000' } }),
      jsonResponse([{ A: 'LUZON', P: 'FROM-EDGE-2' }])
    ] });

    assert.strictEqual(s.cdnSource.adoptToken('subject.signature', 60000), true);
    const first = await s.fetchGate.run('nap', napExecUrl());
    assert.strictEqual(first[0].P, 'FROM-EDGE');

    s.cdnSource.clearToken();
    assert.strictEqual(s.cdnSource.enabled(), false, 'a logout must not leave a readable credential behind');
    const second = await s.fetchGate.run('nap', napExecUrl());
    assert.strictEqual(second[0].P, 'FROM-EXEC');
  });

  /* ---------------------------------------------------------------- *
     Standing down
   * ---------------------------------------------------------------- */

  await test('after two misses it stands down, and reset() asks again', async () => {
    const s = sandbox({ storage: seededToken(), edgeResponses: [
      jsonResponse({ error: 'unauthorized' }, { status: 401 }),
      jsonResponse({ error: 'unauthorized' }, { status: 401 }),
      jsonResponse([{ A: 'LUZON', P: 'FROM-EDGE' }])
    ] });

    await s.fetchGate.run('nap', napExecUrl());
    await s.fetchGate.run('lcp', EXEC + '?type=lcp');
    assert.strictEqual(s.__edgeCalls().length, 2);

    const third = await s.fetchGate.run('node', EXEC + '?type=node');
    assert.strictEqual(third[0].P, 'FROM-EXEC');
    assert.strictEqual(s.__edgeCalls().length, 2,
      'a worker that is gone must not add a failed attempt to every read for the rest of the session');

    s.cdnSource.reset();
    const fourth = await s.fetchGate.run('nap', napExecUrl());
    assert.strictEqual(s.__edgeCalls().length, 3);
    assert.strictEqual(fourth[0].P, 'FROM-EDGE');
    assert.strictEqual(s.cdnSource.state().hits >= 1, true);
  });

  await test('one success wipes the slate — two misses must be consecutive', async () => {
    const s = sandbox({ storage: seededToken(), edgeResponses: [
      jsonResponse({ error: 'x' }, { status: 500 }),
      jsonResponse([{ A: 'LUZON', P: 'FROM-EDGE' }]),
      jsonResponse({ error: 'x' }, { status: 500 }),
      jsonResponse([{ A: 'LUZON', P: 'FROM-EDGE' }])
    ] });

    await s.fetchGate.run('nap', napExecUrl());
    await s.fetchGate.run('lcp', EXEC + '?type=lcp');
    await s.fetchGate.run('node', EXEC + '?type=node');
    const fourth = await s.fetchGate.run('backbone', EXEC + '?type=backbone');

    assert.strictEqual(fourth[0].P, 'FROM-EDGE',
      'an edge that answers most of the time is exactly the case the cooldown must not punish');
    assert.strictEqual(s.__edgeCalls().length, 4);
  });

  /* ---------------------------------------------------------------- *
     The gate is still the gate
   * ---------------------------------------------------------------- */

  await test('two callers still share ONE edge read — dedupe is unchanged', async () => {
    let resolveEdge;
    const s = sandbox({ storage: seededToken() });
    s.fetch = (url, options) => {
      s.__calls.push({ via: 'edge', url: url, options: options });
      return new Promise((resolve) => { resolveEdge = resolve; });
    };

    const first = s.fetchGate.run('nap', napExecUrl());
    const second = s.fetchGate.run('nap', napExecUrl());
    resolveEdge(jsonResponse([{ A: 'LUZON', P: 'FROM-EDGE' }], { headers: { 'x-netpulse-built-at': '1700000000000' } }));

    const [a, b] = await Promise.all([first, second]);
    assert.strictEqual(s.__edgeCalls().length, 1,
      'the gate dedupes per type, and a payload from the edge is counted exactly like one from /exec');
    assert.strictEqual(a[0].P, b[0].P);
  });

  await test('a module that fails with NOTHING to fall back to still rejects', async () => {
    /* The fallback is /exec, not a guarantee: if that path fails too the module's own error UI
       must still see a rejection, exactly as before this existed. */
    const s = sandbox({ storage: seededToken(), edgeResponses: [{ reject: new Error('edge down') }] });
    s.fetchWithRetry = () => Promise.reject(new Error('exec down too'));

    let threw = false;
    try { await s.fetchGate.run('nap', napExecUrl()); } catch (err) { threw = true; }
    assert.strictEqual(threw, true, 'a rejection must survive both attempts');
  });

  /* ---------------------------------------------------------------- *
     The opening
   * ---------------------------------------------------------------- */

  await test('the whole opening comes from the edge in ONE read, with per-type stamps', async () => {
    const builtAt = Date.now() - 3 * 60 * 1000;
    const s = sandbox({
      storage: seededToken(),
      edgeResponses: [jsonResponse({
        ok: true,
        bundle: {
          nap: [{ A: 'LUZON', P: 'FROM-EDGE-BUNDLE' }],
          lcp: { lcpAging: [{ A: 'LUZON', P: 'X' }], lcpImpact: [] },
          olt: { rows: [], meta: { total: 0 } },
          node: [],
          backbone: []
        },
        builtAt: { nap: builtAt, olt: builtAt + 1000 },
        missing: [],
        subject: 'operator'
      })]
    });

    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.used, true);
    assert.strictEqual(summary.source, 'edge', 'the fact that says which path the opening took');
    /* Compared as a string: the summary comes out of a vm context, so its array is from another
       realm and deepStrictEqual would fail on the prototype rather than on the contents. */
    assert.strictEqual(Array.from(summary.hydrated).sort().join(','), 'backbone,lcp,nap,node,olt');
    assert.strictEqual(s.__edgeCalls().length, 1, 'still one round trip for the whole opening');
    assert.strictEqual(s.__execCalls().length, 0, 'and no Apps Script execution');
    assert.strictEqual(s.dataCache.nap[0].P, 'FROM-EDGE-BUNDLE');
    assert.strictEqual(s.fetchGate.dataBuiltAt('nap'), builtAt,
      'the edge knows when each payload was built, so the chip can say it');
  });

  await test('an unusable edge bundle falls through to the origin bundle', async () => {
    const s = sandbox({
      storage: seededToken(),
      edgeResponses: [jsonResponse({ error: 'unauthorized' }, { status: 401 })]
    });

    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.source, 'origin', 'the request this app has always made');
    assert.strictEqual(s.__execCalls().length, 1);
    assert.strictEqual(s.__execCalls()[0].url.indexOf('?action=bundle') !== -1, true);
    assert.strictEqual(s.dataCache.nap[0].P, 'FROM-EXEC-BUNDLE');
  });

  await test('with the host blank the opening is the origin\'s, unchanged', async () => {
    const s = sandbox({ cdn: '', storage: seededToken() });
    const summary = await s.bootFromBundle();

    assert.strictEqual(summary.source, 'origin');
    assert.strictEqual(s.__edgeCalls().length, 0);
  });

  /* ---------------------------------------------------------------- *
     The delivery rules around it
   * ---------------------------------------------------------------- */

  await test('the service worker is told the edge host is network-only, and ships the new file', () => {
    const sw = read('sw.js');
    const html = read('index.html');

    const declared = sw.match(/const DATA_CDN_HOST = '([^']*)'/);
    assert.ok(declared, 'sw.js declares the edge host it must exclude');

    const branch = sw.slice(sw.indexOf('// 1. Google Apps Script API Requests'), sw.indexOf('// 2. THE RELEASE DOCUMENT'));
    assert.ok(branch.indexOf('DATA_CDN_HOST') !== -1,
      'the network-only branch consults it: a cache-first worker would serve a wall display a ' +
      'stale outage, which is the one failure this app cannot show');

    /* The two values are not written in the same shape, and that is deliberate: index.html wants
       a URL it can concatenate a path onto (`host() + '/data/nap'`), while sw.js matches with
       `url.includes(...)` and so wants a bare host — a value carrying the scheme still matches,
       but one carrying a PATH would not. Comparing them as strings would therefore fail on the
       correct tree and pass on a wrong one (`workers.dev` is a substring of both this host and
       every other Cloudflare worker). So the assertions below are the invariant itself: the two
       name the SAME host, and the string sw.js excludes really does occur in the URL the app
       builds. A switched-on app whose host sw.js does not exclude is the silent half of the
       delivery: a cache-first worker serving a wall display yesterday's outage. */
    const swHost = declared[1];
    const appHost = (html.match(/window\.NETPULSE_CDN = "([^"]*)"/) || [])[1];
    assert.notStrictEqual(appHost, undefined, 'index.html has the one-value switch');
    if (appHost) {
      const appHostname = appHost.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      assert.strictEqual(appHostname, swHost,
        'the app and the service worker must name the same host — the two values move together or ' +
        'not at all');
      assert.ok(appHost.indexOf(swHost) !== -1,
        'sw.js excludes a host by substring, so the app URL has to contain that exact string: ' +
        'otherwise the exclusion never fires and the edge response gets cached');
      assert.ok(appHostname.indexOf('.') !== -1 && appHostname.indexOf('workers.dev') !== -1,
        'a bare `workers.dev` would match every worker — the exclusion has to name this one');
    }

    assert.ok(/STATIC_ASSETS = \[[\s\S]*'\.\/cdn-source\.js'/.test(sw),
      'and the new file is precached, or an offline launch has no edge source at all');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
