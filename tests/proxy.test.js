/* ------------------------------------------------------------------
   The edge proxy — the failure it exists to absorb.

   The live 404 is intermittent: measured 3/15 = 20% during an origin stall, and 0/25
   on a healthy afternoon. So a single "it worked when I tried it" run proves nothing,
   which is exactly why this suite exists: it injects the failure the browser used to
   pay for and asserts that the CALLER never sees it.

   The proxy has no global dependencies by design (createProxy takes its fetch, its
   sleep and its logger), so the whole thing runs with no network and no clock.

   Run with:  node --test tests/proxy.test.js
 * ------------------------------------------------------------------ */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.dirname(__dirname);
const PROXY = path.join(REPO_ROOT, 'proxy', 'netpulse-proxy.mjs');

// The worker is an ES module (that is what Cloudflare deploys) while this suite is
// CommonJS, so it is imported dynamically once and shared.
let loaded = null;
function loadProxy() {
  if (!loaded) loaded = import(pathToFileURL(PROXY).href);
  return loaded;
}

const get = (url) => new Request(url, { method: 'GET' });

/* A scripted origin. Each entry answers one call; the last one repeats, so a script of
   one entry means "this always happens". */
function scriptedOrigin(steps) {
  const calls = [];
  const impl = async (url, options) => {
    const index = Math.min(calls.length, steps.length - 1);
    calls.push({ url, options });
    return steps[index]();
  };
  return { impl, calls };
}

const json = (body, status = 200) =>
  () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });

const html = (status = 200) =>
  () => new Response('<!doctype html><title>Error</title>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });

// Instant and deterministic: the real backoff is jittered, and a test must not wait it out.
const noSleep = async () => {};
const quiet = () => {};

/* Build the testable handler around a scripted origin. */
async function proxyWith(steps, overrides) {
  const { createProxy } = await loadProxy();
  const origin = scriptedOrigin(steps);
  const handle = createProxy(Object.assign({
    origin: 'https://script.google.com/macros/s/TEST/exec',
    fetchImpl: origin.impl,
    sleepImpl: noSleep,
    log: quiet
  }, overrides || {}));
  return { handle, origin };
}

test.describe('proxy: the origin failure the browser used to see', () => {
  test('a 404 on the first attempt is retried and the caller still gets 200', async () => {
    const { handle, origin } = await proxyWith([
      json({ error: 'stall' }, 404),
      json({ error: 'stall' }, 404),
      json({ type: 'nap', rows: 3 })
    ]);

    const res = await handle(get('https://netpulse.test/?type=nap'));

    assert.equal(res.status, 200, 'the caller must not be handed the origin 404');
    assert.deepEqual(await res.json(), { type: 'nap', rows: 3 });
    assert.equal(res.headers.get('x-netpulse-attempts'), '3', 'three attempts were made');
    assert.equal(origin.calls.length, 3);
    // Every attempt went to the fixed origin: the retry does not invent a new target.
    for (const call of origin.calls) {
      assert.equal(call.url, 'https://script.google.com/macros/s/TEST/exec?type=nap');
    }
  });

  test('a 200 carrying HTML is treated as a failure, not as data', async () => {
    const { handle, origin } = await proxyWith([
      html(200),
      json({ rows: 1 })
    ]);

    const res = await handle(get('https://netpulse.test/?type=lcp'));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { rows: 1 });
    assert.equal(origin.calls.length, 2, 'the HTML body was rejected and retried');
  });

  test('a thrown request (network failure) is retried too', async () => {
    const { handle, origin } = await proxyWith([
      () => { throw new Error('ECONNRESET'); },
      json({ rows: 9 })
    ]);

    const res = await handle(get('https://netpulse.test/?type=node'));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { rows: 9 });
    assert.equal(origin.calls.length, 2);
  });

  test('when every attempt fails the caller gets 503, never the origin 404', async () => {
    const { handle, origin } = await proxyWith([json({ error: 'stall' }, 404)]);

    const res = await handle(get('https://netpulse.test/?type=backbone'));
    const body = await res.json();

    assert.equal(res.status, 503, 'a retryable status, which the app already classifies');
    assert.equal(res.status === 404, false, 'the 404 class never reaches a module');
    assert.equal(body.offline, true);
    assert.equal(body.lastStatus, 404, 'the reason is reported instead of hidden');
    assert.equal(res.headers.get('x-netpulse-attempts'), '3');
    assert.equal(origin.calls.length, 3, 'exactly the attempt budget, no storm');
  });

  test('no failure pattern produces a 404 or a 500 to the caller', async () => {
    const patterns = [
      [json({}, 404), json({}, 404), json({}, 404)],
      [json({}, 500), json({}, 500), json({}, 500)],
      [() => { throw new Error('timeout'); }, () => { throw new Error('timeout'); }, () => { throw new Error('timeout'); }],
      [json({}, 429), html(502)]
    ];

    for (const steps of patterns) {
      const { handle } = await proxyWith(steps);
      const res = await handle(get('https://netpulse.test/?type=olt'));
      assert.ok(
        res.status === 200 || res.status === 503,
        'expected 200 or 503, got ' + res.status
      );
    }
  });
});

test.describe('proxy: request forwarding', () => {
  test('the query string is passed through unchanged', async () => {
    const { buildOriginUrl } = await loadProxy();
    const url = buildOriginUrl('https://netpulse.test/?type=olt&shape=2');

    assert.equal(url.href, 'https://script.google.com/macros/s/AKfycbxFrgXlnvqLrxPk672wYAMjdPaGfcpYFj77hUjS1zMvOLEtaV_MjfRpBSNpXXWVv3wjWA/exec?type=olt&shape=2');
  });

  test('only whitelisted parameters are forwarded, so it is not an open relay', async () => {
    const { buildOriginUrl } = await loadProxy();
    const url = buildOriginUrl('https://netpulse.test/?type=nap&token=abc&evil=https://example.com/steal&url=//x');

    assert.equal(url.searchParams.get('type'), 'nap');
    assert.equal(url.searchParams.get('token'), 'abc', 'the session token still travels');
    assert.equal(url.searchParams.get('evil'), null);
    assert.equal(url.searchParams.get('url'), null);
  });

  /* The bug this prevents, and it shipped: `password` was not whitelisted, so the worker
     stripped it and EVERY sign-in failed with "Invalid username or password" while the
     credentials were correct. Apps Script answers 200-with-JSON either way, so nothing
     anywhere reported an error — the parameter simply arrived empty.

     So the expected set is derived from the backend itself rather than from a hand-kept
     list: every `e.parameter.X` in code.gs/admin.gs must survive the hop. A new server
     route cannot lose its inputs here without turning this red. */
  test('every parameter the backend reads survives the hop', async () => {
    const { buildOriginUrl } = await loadProxy();

    const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    const params = new Set();
    for (const file of ['code.gs', 'admin.gs']) {
      for (const m of read(file).matchAll(/e\.parameter\.([A-Za-z_][A-Za-z0-9_]*)/g)) params.add(m[1]);
    }
    assert.ok(params.size >= 8, `expected to find the backend's parameters, found ${params.size}`);
    assert.ok(params.has('password'), 'the backend reads a password, so this test is looking at the right thing');

    const query = [...params].map((p) => p + '=' + encodeURIComponent('v-' + p)).join('&');
    const url = buildOriginUrl('https://netpulse.test/?' + query);

    const dropped = [...params].filter((p) => url.searchParams.get(p) !== 'v-' + p);
    assert.deepEqual(dropped, [],
      'these are read by the backend but stripped by the proxy — the caller sees a silent 200');
  });

  test('a sign-in keeps both credentials', async () => {
    const { buildOriginUrl } = await loadProxy();
    const url = buildOriginUrl('https://netpulse.test/?action=login&username=jsp&password=hunter2');

    assert.equal(url.searchParams.get('action'), 'login');
    assert.equal(url.searchParams.get('username'), 'jsp');
    assert.equal(url.searchParams.get('password'), 'hunter2',
      'without this the origin compares an empty password and refuses a correct one');
  });

  test('the maintenance toggle keeps its value', async () => {
    const { buildOriginUrl } = await loadProxy();
    const url = buildOriginUrl('https://netpulse.test/?action=setMaintenance&enabled=true&token=abc');

    assert.equal(url.searchParams.get('enabled'), 'true',
      'dropped here, `enabled === "true"` is never true and maintenance can only be turned OFF');
  });

  test('the origin host is fixed by the worker, not by the caller', async () => {
    const { handle, origin } = await proxyWith([json({ ok: true })]);
    const res = await handle(get('https://netpulse.test/?type=nap&fetch=https://attacker.test/'));

    assert.equal(res.status, 200);
    assert.equal(origin.calls.length, 1);
    assert.ok(
      origin.calls[0].url.startsWith('https://script.google.com/macros/s/TEST/exec?'),
      'the request must land on the configured origin'
    );
  });
});

test.describe('proxy: surface', () => {
  test('a session-bearing action is never cached anywhere in the path', async () => {
    const { handle } = await proxyWith([json({ token: 'secret' })]);
    const res = await handle(get('https://netpulse.test/?action=login&username=someone'));

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  test('a successful passthrough is not cacheable either', async () => {
    const { handle } = await proxyWith([json([{ P: 'BENGUET' }])]);
    const res = await handle(get('https://netpulse.test/?type=nap'));

    assert.equal(res.headers.get('cache-control'), 'no-store',
      'a cached outage view is worse than a slow one');
    assert.equal(res.headers.get('x-netpulse-attempts'), '1');
  });

  test('CORS is answered for the browser, including the preflight', async () => {
    const { handle } = await proxyWith([json({ ok: true })]);

    const preflight = await handle(new Request('https://netpulse.test/?type=nap', { method: 'OPTIONS' }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);

    const normal = await handle(get('https://netpulse.test/?type=nap'));
    assert.equal(normal.headers.get('access-control-allow-origin'), '*');
  });

  test('the retry counters are exposed to the app, not just to devtools', async () => {
    const { handle } = await proxyWith([json({ ok: true })]);
    const res = await handle(get('https://netpulse.test/?type=nap'));

    // A cross-origin response hides every header that is not CORS-safelisted, so without
    // this the app can read reply headers from curl but not its own call's attempt count.
    const exposed = res.headers.get('access-control-expose-headers') || '';
    assert.match(exposed, /x-netpulse-attempts/);
    assert.match(exposed, /x-netpulse-origin-ms/);
  });

  test('a non-GET method is refused', async () => {
    const { handle, origin } = await proxyWith([json({ ok: true })]);
    const res = await handle(new Request('https://netpulse.test/?type=nap', { method: 'POST' }));

    assert.equal(res.status, 405);
    assert.equal(origin.calls.length, 0, 'and the origin is not touched');
  });

  test('probe=1 answers without calling the origin', async () => {
    const { handle, origin } = await proxyWith([json({ ok: true })]);
    const res = await handle(get('https://netpulse.test/?probe=1'));

    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(origin.calls.length, 0, 'liveness and origin health stay separable');
  });

  test('the attempt budget is configurable, and it is respected', async () => {
    const { handle, origin } = await proxyWith([json({}, 503)], { attempts: 2 });
    const res = await handle(get('https://netpulse.test/?type=nap'));

    assert.equal(res.status, 503);
    assert.equal(origin.calls.length, 2);
  });
});

/* ------------------------------------------------------------------
   The wiring, which is the part that can silently rot.

   Pointing the app at the proxy needs TWO files to agree: window.NETPULSE_PROXY in
   index.html, and the host in sw.js's network-only API branch. Change one and forget
   the other and nothing throws — the service worker quietly starts
   stale-while-revalidating API responses, and a wall display is handed a stale outage.
   So the two are asserted to agree, in both directions, including after a revert.
 * ------------------------------------------------------------------ */

test.describe('proxy: the app and the service worker agree', () => {
  const read = (file) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const pick = (source, re, label) => {
    const match = source.match(re);
    assert.ok(match, 'could not find ' + label);
    return match[1];
  };

  const html = read('index.html');
  const sw = read('sw.js');

  const proxyValue = pick(html, /window\.NETPULSE_PROXY\s*=\s*"([^"]*)"/, 'window.NETPULSE_PROXY in index.html');
  const appsScript = pick(html, /window\.APPS_SCRIPT_URL\s*=\s*"([^"]+)"/, 'window.APPS_SCRIPT_URL in index.html');
  const swHost = pick(sw, /const API_PROXY_HOST = '([^']*)'/, 'API_PROXY_HOST in sw.js');

  test('the app keeps one place to point the API at', () => {
    assert.match(appsScript, /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec$/,
      'the Apps Script deployment URL must stay the fallback');
    assert.match(html, /window\.BASE_API_URL\s*=\s*window\.NETPULSE_PROXY \|\| window\.APPS_SCRIPT_URL;/,
      'BASE_API_URL must derive from the two constants, not repeat a literal');
    assert.match(html, /window\.APP_URL\s*=\s*window\.BASE_API_URL;/,
      'APP_URL must derive too, or reverting needs two edits and someone will miss one');
  });

  test('the service worker host matches the proxy the app uses', () => {
    if (proxyValue) {
      const host = new URL(proxyValue).host;
      assert.equal(swHost, host,
        'sw.js must exclude ' + host + ' from stale-while-revalidate');
    } else {
      assert.equal(swHost, '',
        'NETPULSE_PROXY is empty (direct to Apps Script), so API_PROXY_HOST must be blanked too');
    }
  });

  test('the API branch is network-only for whichever host is in use', () => {
    assert.match(sw,
      /url\.includes\('script\.google\.com'\) \|\| \(API_PROXY_HOST && url\.includes\(API_PROXY_HOST\)\)/,
      'the network-only branch must cover both hosts');

    // And it must sit above the stale-while-revalidate path: a later branch would catch
    // the API first and cache it.
    const apiBranch = sw.indexOf("url.includes('script.google.com')");
    const swrBranch = sw.indexOf('STALE-WHILE-REVALIDATE');
    assert.ok(apiBranch > 0 && swrBranch > 0, 'both branches must be present');
    assert.ok(apiBranch < swrBranch, 'the API branch must come first');
  });
});
