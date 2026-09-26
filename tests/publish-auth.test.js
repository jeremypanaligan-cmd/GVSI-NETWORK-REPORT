// ==================== THE EDGE DATA PLANE ====================
// Run: node tests/publish-auth.test.js
//
// The worker's second job: the trigger publishes each built payload into KV, and the app reads
// it from the edge instead of waiting 1.2-1.8 s for an Apps Script execution. See PART-029.
//
// WHAT THIS SUITE IS ACTUALLY GUARDING
//
//   1. An unauthenticated caller cannot WRITE. The publish secret is checked before the body is
//      parsed, so a probe cannot make the worker spend anything.
//   2. An unauthenticated caller cannot READ. The read token is an HMAC the deployment minted at
//      login — the app's `?type=` data routes are not session-gated today, so this is the one
//      thing the CDN path adds that the obscure `/exec` URL does not have.
//   3. AN ERROR ENVELOPE IS NEVER PUBLISHED. `{error:"build_failed"}` is a perfectly parseable
//      body, and the app has shipped exactly this bug once (a prefetch that stored the raw
//      envelope where a decoded array belongs, so the tables drew nothing). An EMPTY payload is
//      not refused: "nothing to report" is how the OLT zero state and the NAP/LCP no-pending
//      screens are drawn.
//   4. The pass-through the app still depends on is not swallowed by the new routes.
//
// The KV namespace is faked, so this runs with no network and no Cloudflare account: what is
// under test is the worker's decisions, not Cloudflare's behaviour.

'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); }, (err) => {
    failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message);
  });
}

const READ_SECRET = 'read-secret-for-tests';
const PUBLISH_SECRET = 'publish-secret-for-tests';
const EDGE = 'https://edge.test';
const NOW = 1_800_000_000_000; // fixed clock, so "expired" means expired

/* ------------------------------------------------------------------ *
   A KV namespace, in a Map
 * ------------------------------------------------------------------ */

function fakeKv(seed) {
  const store = new Map();
  Object.keys(seed || {}).forEach((k) => store.set(k, { value: seed[k], metadata: {} }));
  return {
    store,
    writes: [],
    async getWithMetadata(key) {
      const found = store.get(key);
      if (!found) return { value: null, metadata: null };
      return { value: found.value, metadata: found.metadata };
    },
    async put(key, value, opts) {
      this.writes.push({ key, value, metadata: (opts && opts.metadata) || {} });
      store.set(key, { value, metadata: (opts && opts.metadata) || {} });
    }
  };
}

/* The deployment mints this at login with Utilities.computeHmacSha256Signature(payload,
   READ_SECRET); the worker verifies it with crypto.subtle. Same bytes either way — which is the
   whole reason the subject travels INSIDE the token: a signature over an unseen payload cannot
   be checked by anyone. */
function b64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function mintToken(subject, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
                                            { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(subject));
  return b64url(new TextEncoder().encode(subject)) + '.' + b64url(new Uint8Array(signature));
}

function dataRequest(path, options) {
  const o = options || {};
  return new Request(EDGE + path, {
    method: o.method || 'GET',
    headers: o.headers || {},
    body: o.body
  });
}

async function readJson(response) {
  return JSON.parse(await response.text());
}

(async () => {
  console.log('\nThe edge data plane\n');

  const { createDataPlane, planeFor } = await import('../proxy/netpulse-proxy.mjs');

  const plane = (kv, extra) => createDataPlane(Object.assign({
    kv,
    readSecret: READ_SECRET,
    publishSecret: PUBLISH_SECRET,
    now: () => NOW
  }, extra || {}));

  /* ---------------------------------------------------------------- *
     /publish — writes
   * ---------------------------------------------------------------- */

  await test('a publish with no secret is refused, and writes nothing', async () => {
    const kv = fakeKv();
    const res = await plane(kv)(dataRequest('/publish?type=nap', {
      method: 'POST', body: JSON.stringify([{ A: 'LUZON' }])
    }));

    assert.strictEqual(res.status, 401, 'the caller learns only that it was refused');
    assert.strictEqual(kv.writes.length, 0, 'and nothing reached the store');
  });

  await test('a publish with the WRONG secret is refused the same way', async () => {
    const kv = fakeKv();
    const res = await plane(kv)(dataRequest('/publish?type=nap', {
      method: 'POST', headers: { 'x-netpulse-secret': 'not-the-secret' }, body: '[]'
    }));

    assert.strictEqual(res.status, 401);
    assert.strictEqual(kv.writes.length, 0);
  });

  await test('the right secret writes the payload byte-for-byte, with its stamp', async () => {
    const kv = fakeKv();
    const payload = JSON.stringify([{ A: 'LUZON', P: 'BENGUET', H: 4, D1: 1, D3: 0, T: 5 }]);
    const res = await plane(kv)(dataRequest('/publish?type=nap&builtAt=' + NOW + '&rev=7', {
      method: 'POST',
      headers: { 'x-netpulse-secret': PUBLISH_SECRET, 'content-type': 'application/json' },
      body: payload
    }));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(kv.writes.length, 1, 'one write, one type');
    assert.strictEqual(kv.writes[0].key, 'nap');
    assert.strictEqual(kv.writes[0].value, payload,
      'the bytes are stored as built — the client parses exactly what /exec would have sent');
    assert.strictEqual(kv.writes[0].metadata.builtAt, NOW, 'the build stamp rides with it');
    assert.strictEqual(kv.writes[0].metadata.rev, '7', 'and the revision, for later invalidation');
    assert.strictEqual(kv.writes[0].metadata.bytes, payload.length);
  });

  await test('an ERROR ENVELOPE is never published', async () => {
    const kv = fakeKv();
    const res = await plane(kv)(dataRequest('/publish?type=nap', {
      method: 'POST',
      headers: { 'x-netpulse-secret': PUBLISH_SECRET },
      body: JSON.stringify({ error: 'build_failed', retryable: true })
    }));

    assert.strictEqual(res.status, 400, 'a failed build is refused, not stored');
    assert.strictEqual((await readJson(res)).error, 'refused_error_envelope');
    assert.strictEqual(kv.writes.length, 0,
      'publishing it would put a crash on every screen and keep serving it until the next run');
  });

  await test('an EMPTY payload is published — that is what "nothing to report" looks like', async () => {
    const kv = fakeKv();
    const empty = JSON.stringify([]);
    const res = await plane(kv)(dataRequest('/publish?type=nap', {
      method: 'POST', headers: { 'x-netpulse-secret': PUBLISH_SECRET }, body: empty
    }));

    assert.strictEqual(res.status, 200, 'empty is data: the NAP/LCP no-pending screen and the ' +
      'OLT zero state are both drawn from a payload with no rows in it');
    assert.strictEqual(kv.writes[0].value, empty);
  });

  await test('a body that is not JSON is refused', async () => {
    const kv = fakeKv();
    const res = await plane(kv)(dataRequest('/publish?type=nap', {
      method: 'POST', headers: { 'x-netpulse-secret': PUBLISH_SECRET }, body: '<html>nope</html>'
    }));

    assert.strictEqual(res.status, 400);
    assert.strictEqual(kv.writes.length, 0);
  });

  await test('an unknown type is refused, and a GET cannot publish', async () => {
    const kv = fakeKv();
    const unknown = await plane(kv)(dataRequest('/publish?type=oltreport', {
      method: 'POST', headers: { 'x-netpulse-secret': PUBLISH_SECRET }, body: '[]'
    }));
    assert.strictEqual(unknown.status, 400);

    const get = await plane(kv)(dataRequest('/publish?type=nap', {
      headers: { 'x-netpulse-secret': PUBLISH_SECRET }
    }));
    assert.strictEqual(get.status, 405);
    assert.strictEqual(kv.writes.length, 0);
  });

  await test('an oversized body is refused before it is parsed', async () => {
    const kv = fakeKv();
    const huge = 'x'.repeat(600 * 1024);
    const res = await plane(kv)(dataRequest('/publish?type=nap', {
      method: 'POST', headers: { 'x-netpulse-secret': PUBLISH_SECRET }, body: huge
    }));

    assert.strictEqual(res.status, 413, 'the largest payload this app builds is ~50 KB');
    assert.strictEqual(kv.writes.length, 0);
  });

  await test('a missing secret or namespace answers 503, not 401', async () => {
    const notConfigured = createDataPlane({ kv: fakeKv(), readSecret: READ_SECRET, publishSecret: '', now: () => NOW });
    const noSecret = await notConfigured(dataRequest('/publish?type=nap', { method: 'POST', body: '[]' }));
    assert.strictEqual(noSecret.status, 503, 'a worker that has not been given its secrets says so');
    assert.strictEqual((await readJson(noSecret)).field, 'PUBLISH_SECRET');

    const noKv = createDataPlane({ kv: null, readSecret: READ_SECRET, publishSecret: PUBLISH_SECRET, now: () => NOW });
    const noBinding = await noKv(dataRequest('/publish?type=nap', {
      method: 'POST', headers: { 'x-netpulse-secret': PUBLISH_SECRET }, body: '[]'
    }));
    assert.strictEqual(noBinding.status, 503);
    assert.strictEqual((await readJson(noBinding)).field, 'DATA');
  });

  /* ---------------------------------------------------------------- *
     /data — reads
   * ---------------------------------------------------------------- */

  const seeded = () => fakeKv({
    nap: JSON.stringify([{ A: 'LUZON', P: 'BENGUET', H: 4 }]),
    olt: JSON.stringify({ rows: [], p: {}, m: {}, meta: { total: 0 } })
  });
  const withMeta = (kv, key, metadata) => {
    const entry = kv.store.get(key);
    kv.store.set(key, { value: entry.value, metadata: metadata });
    return kv;
  };

  await test('a read with no token, a bad signature or an expired one is refused — and says which', async () => {
    const kv = withMeta(seeded(), 'nap', { builtAt: NOW - 1000, rev: '3' });
    const handle = plane(kv);

    const none = await handle(dataRequest('/data/nap'));
    assert.strictEqual(none.status, 401);
    assert.strictEqual((await readJson(none)).reason, 'no_token');

    const wrongKey = await mintToken('operator|' + (NOW + 60000), 'the-other-secret');
    const bad = await handle(dataRequest('/data/nap', { headers: { authorization: 'Bearer ' + wrongKey } }));
    assert.strictEqual(bad.status, 401, 'a signature from any other secret is not a signature');
    assert.strictEqual((await readJson(bad)).reason, 'bad_signature');

    const stale = await mintToken('operator|' + (NOW - 1), READ_SECRET);
    const expired = await handle(dataRequest('/data/nap', { headers: { authorization: 'Bearer ' + stale } }));
    assert.strictEqual(expired.status, 401);
    assert.strictEqual((await readJson(expired)).reason, 'expired');
  });

  await test('a token that is not base64url at all is a refusal, not a 500', async () => {
    const handle = plane(seeded());

    /* This one has a dot, so it passes the shape check, and then `atob` meets `basura`. MEASURED
       2026-09-26 against the DEPLOYED worker, before the decode was guarded: `Bearer
       basura.token` answered `1101` — a Worker exception surfaced as a 500. A client reads a 500
       as "the edge is broken" and a 401 as "fall back to /exec", so that inverted the one
       decision this function exists to make. The suite had no such case: it covered no_token,
       bad_signature and expired, and every one of those is well-formed base64url. */
    const garbage = await handle(dataRequest('/data/nap', { headers: { authorization: 'Bearer basura.token' } }));
    assert.strictEqual(garbage.status, 401, 'a decode failure is a refusal, never a throw');
    assert.strictEqual((await readJson(garbage)).reason, 'malformed');

    /* The rest of the shapes a bad paste can take. None may throw, and every refusal is named. */
    for (const token of ['a.', 'ok.', '***.***', 'AAAA.!!!!', 'x.y.z', '%%%%']) {
      const res = await handle(dataRequest('/data/nap', { headers: { authorization: 'Bearer ' + token } }));
      assert.strictEqual(res.status, 401, '`' + token + '` is refused, never thrown');
      const body = await readJson(res);
      assert.strictEqual(body.error, 'unauthorized');
      assert.ok(typeof body.reason === 'string' && body.reason.length > 0,
        'the reason is always named, so the client can log once and stop asking');
    }
  });

  await test('a valid token reads the payload, with the build stamp the chip uses', async () => {
    const kv = withMeta(seeded(), 'nap', { builtAt: NOW - 1000, rev: '3' });
    const token = await mintToken('operator|' + (NOW + 60000), READ_SECRET);

    const res = await plane(kv)(dataRequest('/data/nap', { headers: { authorization: 'Bearer ' + token } }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), kv.store.get('nap').value,
      'byte-identical to what /exec would have sent: the client parses one shape, not two');
    assert.strictEqual(res.headers.get('x-netpulse-built-at'), String(NOW - 1000),
      'so the freshness chip can report the age of the DATA rather than of the request');
    assert.strictEqual(res.headers.get('x-netpulse-rev'), '3');
    assert.strictEqual(res.headers.get('cache-control'), 'no-store',
      'the browser must not keep a copy past the edge TTL it was served from');
  });

  await test('a token is only good for its own subject-matter: it is verified, not trusted', async () => {
    const kv = withMeta(seeded(), 'nap', { builtAt: NOW, rev: '1' });
    const token = await mintToken('operator|' + (NOW + 60000), READ_SECRET);

    const res = await plane(kv)(dataRequest('/data/_meta', { headers: { authorization: 'Bearer ' + token } }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await readJson(res)).subject, 'operator',
      'the reader is named back, so a future audit has something to log');
  });

  await test('a PADDED token is accepted too — the two halves are separate pastes', async () => {
    const expiry = NOW + 60000;
    const token = await mintToken('operator|' + expiry, READ_SECRET);
    /* Apps Script's base64EncodeWebSafe pads; publish-cache.gs strips it so a token has one
       canonical form. The decoder here re-pads from the length it is given, and that leniency is
       deliberate: a half-pasted pair must fail on the SIGNATURE, never on a trailing '='. */
    const [subject, signature] = token.split('.');
    const padded = subject + '=' + '.' + signature;

    const res = await plane(seeded())(dataRequest('/data/nap', { headers: { authorization: 'Bearer ' + padded } }));
    assert.strictEqual(res.status, 200);
  });

  await test('an unpublished type answers 404 not_published, not an error', async () => {
    const token = await mintToken('operator|' + (NOW + 60000), READ_SECRET);
    const res = await plane(seeded())(dataRequest('/data/backbone', { headers: { authorization: 'Bearer ' + token } }));

    assert.strictEqual(res.status, 404, 'this is the state of every type before the first ' +
      'trigger run after a deploy, and the client reads it from /exec');
    assert.strictEqual((await readJson(res)).error, 'not_published');
  });

  await test('an unknown type is a 400, and a missing token cannot reach it anyway', async () => {
    const token = await mintToken('operator|' + (NOW + 60000), READ_SECRET);
    const res = await plane(seeded())(dataRequest('/data/analitycs', { headers: { authorization: 'Bearer ' + token } }));
    assert.strictEqual(res.status, 400);

    const untokened = await plane(seeded())(dataRequest('/data/analitycs'));
    assert.strictEqual(untokened.status, 401, 'the gate runs first, so probing types is not free');
  });

  await test('_bundle answers everything in ONE read and names what is missing', async () => {
    const kv = withMeta(withMeta(seeded(), 'nap', { builtAt: NOW - 500, rev: '9' }), 'olt', { builtAt: NOW - 200, rev: '9' });
    const token = await mintToken('operator|' + (NOW + 60000), READ_SECRET);

    let reads = 0;
    const counting = Object.create(kv);
    counting.getWithMetadata = async (key, opts) => { reads++; return kv.getWithMetadata(key, opts); };

    const res = await plane(counting)(dataRequest('/data/_bundle', { headers: { authorization: 'Bearer ' + token } }));
    const body = await readJson(res);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(reads, 5, 'five payloads, read at the edge — the caller still pays ONE round trip');
    assert.deepStrictEqual(Object.keys(body.bundle).sort(), ['nap', 'olt']);
    assert.deepStrictEqual(body.missing.sort(), ['backbone', 'lcp', 'node'],
      'what was never published is named, so the client loads those the way it always did');
    assert.strictEqual(body.builtAt.nap, NOW - 500, 'and the per-type stamps come with it');
  });

  await test('_bundle skips a stored body that will not parse, instead of handing it on', async () => {
    const kv = seeded();
    kv.store.set('node', { value: '{not json', metadata: { builtAt: NOW } });
    const token = await mintToken('operator|' + (NOW + 60000), READ_SECRET);

    const body = await readJson(await plane(kv)(dataRequest('/data/_bundle', { headers: { authorization: 'Bearer ' + token } })));

    assert.strictEqual(body.bundle.node, undefined,
      'a module handed unparseable bytes stores them and draws an empty table — the bug this ' +
      'whole app keeps re-learning');
    assert.ok(body.missing.indexOf('node') !== -1, 'so it is reported missing instead');
  });

  await test('_meta lists the stamps WITHOUT the payloads', async () => {
    const kv = withMeta(seeded(), 'nap', { builtAt: NOW - 42, rev: '5', bytes: 21 });
    const token = await mintToken('operator|' + (NOW + 60000), READ_SECRET);

    const body = await readJson(await plane(kv)(dataRequest('/data/_meta', { headers: { authorization: 'Bearer ' + token } })));

    assert.strictEqual(body.types.nap.builtAt, NOW - 42);
    assert.strictEqual(body.types.nap.rev, '5');
    assert.strictEqual(body.types.nap.bytes, 21);
    assert.strictEqual(body.types.backbone, null, 'a type with nothing published reads as null');
    assert.strictEqual(JSON.stringify(body).indexOf('BENGUET'), -1, 'and no row data is in it');
  });

  /* ---------------------------------------------------------------- *
     The pass-through the app still depends on
   * ---------------------------------------------------------------- */

  await test('the app\'s own routes still reach the proxy, and only /data and /publish do not', () => {
    const cases = [
      ['/', 'proxy'],
      ['/index.html', 'proxy'],
      ['/?type=nap', 'proxy'],
      ['/?action=login', 'proxy'],
      ['/?action=bundle', 'proxy'],
      ['/data/nap', 'data'],
      ['/data/_bundle', 'data'],
      ['/publish', 'data'],
      ['/datazone', 'proxy']
    ];
    cases.forEach(([path, expected]) => {
      assert.strictEqual(planeFor(path), expected,
        path + ' must reach the ' + expected + ' plane — a new route that swallows the ' +
        'pass-through is a silent app-wide regression');
    });
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
