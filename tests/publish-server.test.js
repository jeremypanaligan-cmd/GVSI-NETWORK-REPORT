// ==================== THE PUBLISH HALF (APPS SCRIPT) ====================
// Run: node tests/publish-server.test.js
//
// publish-cache.gs is the only thing that writes to the edge, and it runs inside the trigger that
// already builds every module. Two properties make it worth a suite of its own:
//
//   1. IT IS THE ONLY WRITER, so what it refuses to send is what no reader ever sees. An error
//      envelope published once would sit on every screen in the fleet until the next successful
//      pass.
//   2. IT MINTS THE READ TOKEN, and the worker verifies it with a DIFFERENT implementation of
//      HMAC (Apps Script's Utilities.computeHmacSha256Signature on one side, crypto.subtle on the
//      other). That is the seam most likely to be wrong in a way no single-side test can see, so
//      the token produced here is handed to the REAL worker handler in the last cases below.
//
// The warm-pass wiring is asserted too: publish fires from the same verdict the pass counts, so a
// build that answered an error envelope is never handed to a reader.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const WORKER = 'https://edge.test';
const PUBLISH_SECRET = 'publish-secret-for-tests';
const READ_SECRET = 'read-secret-for-tests';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); }, (err) => {
    failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message);
  });
}

/**
 * Apps Script's globals, faked to the depth publish-cache.gs uses them.
 *
 * `computeHmacSha256Signature` returns Apps Script's SIGNED byte array (values -128..127), and
 * base64EncodeWebSafe takes those bytes — the two quirks that make this half different from the
 * worker's, and the reason the last cases hand a real token across.
 */
function appsScriptSandbox(props, fetchImpl, logs) {
  const s = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    Logger: { log: (m) => (logs || []).push(String(m)) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : null),
        setProperty: (k, v) => { props[k] = String(v); }
      })
    },
    Utilities: {
      base64EncodeWebSafe: (value) => {
        const buf = typeof value === 'string'
          ? Buffer.from(value, 'utf8')
          : Buffer.from(Uint8Array.from(Array.prototype.map.call(value, (b) => b & 0xff)));
        // Apps Script pads; the worker's decoder re-pads from the length it is given, which is
        // why publish-cache.gs strips it. Left padded here so the strip is actually exercised.
        return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
      },
      computeHmacSha256Signature: (value, key) => {
        const digest = crypto.createHmac('sha256', String(key)).update(String(value), 'utf8').digest();
        return Array.from(digest).map((b) => (b > 127 ? b - 256 : b));
      }
    },
    UrlFetchApp: { fetch: fetchImpl }
  };
  vm.createContext(s);
  return s;
}

function configured() {
  return {
    netpulse_worker_url: WORKER,
    netpulse_publish_secret: PUBLISH_SECRET,
    netpulse_read_secret: READ_SECRET
  };
}

(async () => {
  console.log('\nThe publish half\n');

  const { createDataPlane } = await import('../proxy/netpulse-proxy.mjs');

  /* ---------------------------------------------------------------- *
     Configuration
   * ---------------------------------------------------------------- */

  await test('with no properties at all it publishes nothing, once, and never throws', () => {
    const logs = [];
    let calls = 0;
    const s = appsScriptSandbox({}, () => { calls++; return { getResponseCode: () => 200 }; }, logs);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    assert.strictEqual(s.publishBuiltPayload_('nap', '[]'), false);
    assert.strictEqual(calls, 0, 'an unconfigured deployment is the state it ships in');
    assert.strictEqual(logs.length, 1, 'and it says so exactly once per execution, not once per module');
    assert.ok(logs[0].indexOf('not configured') !== -1);
    assert.strictEqual(s.mintEdgeToken_('operator', Date.now() + 1000), '',
      'and no token is minted, so no client will try the edge');
  });

  await test('setEdgeConfig_ stores the three values and trims what was pasted', () => {
    const props = {};
    const s = appsScriptSandbox(props, () => ({ getResponseCode: () => 200 }), []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    s.setEdgeConfig_('  ' + WORKER + '/  ', ' ' + PUBLISH_SECRET + ' ', READ_SECRET + '\n');

    assert.strictEqual(props.netpulse_worker_url, WORKER, 'no trailing slash: the path is appended to it');
    assert.strictEqual(props.netpulse_publish_secret, PUBLISH_SECRET,
      'a secret with a trailing space fails as a 401 nobody can explain');
    assert.strictEqual(props.netpulse_read_secret, READ_SECRET);
  });

  /* ---------------------------------------------------------------- *
     What it sends
   * ---------------------------------------------------------------- */

  await test('a configured publish sends the exact bytes, the type, the stamp and the secret', () => {
    const sent = [];
    const s = appsScriptSandbox(configured(), (url, params) => {
      sent.push({ url: url, params: params });
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true}' };
    }, []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    const payload = JSON.stringify([{ A: 'LUZON', P: 'BENGUET', H: 4, D1: 1, D3: 0, T: 5 }]);
    assert.strictEqual(s.publishBuiltPayload_('nap', payload), true);

    assert.strictEqual(sent.length, 1, 'one type, one write');
    assert.strictEqual(sent[0].url.indexOf(WORKER + '/publish?type=nap&builtAt='), 0);
    assert.strictEqual(sent[0].params.method, 'post');
    assert.strictEqual(sent[0].params.payload, payload,
      'the bytes the build produced: the client parses one shape whether it came from here or /exec');
    assert.strictEqual(sent[0].params.headers['x-netpulse-secret'], PUBLISH_SECRET);
    assert.strictEqual(sent[0].params.contentType, 'application/json');
    assert.strictEqual(sent[0].params.muteHttpExceptions, true,
      'a refusal is a body to read, not an exception to raise in the executions log');
  });

  await test('an ERROR ENVELOPE is never published — the refusal is made on this side', () => {
    let calls = 0;
    const logs = [];
    const s = appsScriptSandbox(configured(), () => { calls++; return { getResponseCode: () => 200 }; }, logs);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });
    vm.runInContext(read('olt-cache-warmer.gs'), s, { filename: 'olt-cache-warmer.gs' });

    assert.strictEqual(s.publishBuiltPayload_('nap', '{"error":"build_failed","retryable":true}'), false);
    assert.strictEqual(calls, 0, 'asking the worker to reject it would spend a request to learn nothing');
    assert.ok(logs.some((l) => l.indexOf('error envelope') !== -1));
  });

  await test('FAIL-OPEN: an HTTP refusal and a thrown connection both return, never raise', () => {
    const logs = [];
    const refused = appsScriptSandbox(configured(), () => ({
      getResponseCode: () => 401, getContentText: () => '{"error":"unauthorized"}'
    }), logs);
    vm.runInContext(read('publish-cache.gs'), refused, { filename: 'publish-cache.gs' });

    assert.strictEqual(refused.publishBuiltPayload_('nap', '[]'), false);
    assert.strictEqual(refused.publishBuiltPayload_('lcp', '{}'), false);
    assert.strictEqual(logs.filter((l) => l.indexOf('edge publish failed') !== -1).length, 1,
      'one line per execution: a worker down for an hour must not bury the log in 25 warnings');
    assert.ok(logs[0].indexOf('publish secret') !== -1, 'and it names the likely cause of a 401');

    const throwing = appsScriptSandbox(configured(), () => { throw new Error('DNS lookup failed'); }, []);
    vm.runInContext(read('publish-cache.gs'), throwing, { filename: 'publish-cache.gs' });
    assert.strictEqual(throwing.publishBuiltPayload_('nap', '[]'), false,
      'the edge keeps serving the last payload it was given, and the build is not delayed');
  });

  /* ---------------------------------------------------------------- *
     The warm pass wiring
   * ---------------------------------------------------------------- */

  await test('the publish rides the pass\'s own verdict: only a counted build reaches the edge', () => {
    const published = [];
    const s = appsScriptSandbox(configured(), () => ({ getResponseCode: () => 200 }), []);
    s.publishBuiltPayload_ = (type, json) => { published.push({ type: type, json: json }); return true; };
    s.doGet = (event) => ({ getContent: () => s.__next });
    vm.runInContext(read('olt-cache-warmer.gs'), s, { filename: 'olt-cache-warmer.gs' });

    s.__next = '[{"A":"LUZON"}]';
    assert.ok(s.warmTypeCache_('nap', 330) >= 0);
    assert.strictEqual(published.length, 1, 'a build the pass counted as a success is published');
    assert.strictEqual(published[0].type, 'nap');
    assert.strictEqual(published[0].json, '[{"A":"LUZON"}]');

    s.__next = '{"error":"build_failed","retryable":true}';
    assert.strictEqual(s.warmTypeCache_('lcp', 330), -1, 'a failed build is still a failed build');
    assert.strictEqual(published.length, 1,
      'and it is NOT published: publishing it would put a crash on every screen until the next pass');
  });

  /* ---------------------------------------------------------------- *
     The seam: does the token this half mints actually verify over there?
   * ---------------------------------------------------------------- */

  await test('the token minted here is accepted by the REAL worker verifier', async () => {
    const s = appsScriptSandbox(configured(), () => ({ getResponseCode: () => 200 }), []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    const exp = Date.now() + 60 * 1000;
    const token = s.mintEdgeToken_('operator', exp);
    assert.ok(token && token.indexOf('.') > 0, 'subject.signature');
    assert.strictEqual(token.indexOf('='), -1,
      'unpadded, so a token minted here and one minted by the worker\'s own test are the same ' +
      'string — which is the only way two halves can be compared when something is wrong');

    /* The payloads the worker serves, in a map, so the whole read can be driven end to end. */
    const store = new Map([['nap', { value: '[{"A":"LUZON","P":"BENGUET"}]', metadata: { builtAt: exp - 5000, rev: '4' } }]]);
    const kv = {
      async getWithMetadata(key) {
        const found = store.get(key);
        return found ? { value: found.value, metadata: found.metadata } : { value: null, metadata: null };
      },
      async put() {}
    };
    const plane = createDataPlane({ kv, readSecret: READ_SECRET, publishSecret: PUBLISH_SECRET });

    const res = await plane(new Request(WORKER + '/data/nap', { headers: { authorization: 'Bearer ' + token } }));
    assert.strictEqual(res.status, 200,
      'the two implementations of HMAC agree — Apps Script signs the subject, crypto.subtle verifies it');
    assert.strictEqual(await res.text(), store.get('nap').value);
    assert.strictEqual(res.headers.get('x-netpulse-built-at'), String(exp - 5000));
  });

  await test('and a token this half minted for an EXPIRED moment is refused over there', async () => {
    const s = appsScriptSandbox(configured(), () => ({ getResponseCode: () => 200 }), []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    const stale = s.mintEdgeToken_('operator', Date.now() - 1000);
    const kv = { async getWithMetadata() { return { value: '[]', metadata: {} }; }, async put() {} };
    const plane = createDataPlane({ kv, readSecret: READ_SECRET, publishSecret: PUBLISH_SECRET });

    const res = await plane(new Request(WORKER + '/data/nap', { headers: { authorization: 'Bearer ' + stale } }));
    assert.strictEqual(res.status, 401, 'a shut laptop does not keep reading the fleet');
    assert.strictEqual(JSON.parse(await res.text()).reason, 'expired');
  });

  await test('a token minted with the WRONG secret is refused — it is verified, not merely shaped', async () => {
    const s = appsScriptSandbox({ netpulse_worker_url: WORKER, netpulse_publish_secret: PUBLISH_SECRET,
                                  netpulse_read_secret: 'a-different-read-secret' }, () => ({ getResponseCode: () => 200 }), []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    const token = s.mintEdgeToken_('operator', Date.now() + 60000);
    const kv = { async getWithMetadata() { return { value: '[]', metadata: {} }; }, async put() {} };
    const plane = createDataPlane({ kv, readSecret: READ_SECRET, publishSecret: PUBLISH_SECRET });

    const res = await plane(new Request(WORKER + '/data/nap', { headers: { authorization: 'Bearer ' + token } }));
    assert.strictEqual(res.status, 401, 'a secret that has drifted apart on one side fails closed');
  });

  await test('edgeTokenForLogin_ is the login response\'s cdnToken, and empty without a secret', () => {
    const withSecret = appsScriptSandbox(configured(), () => ({ getResponseCode: () => 200 }), []);
    vm.runInContext(read('publish-cache.gs'), withSecret, { filename: 'publish-cache.gs' });
    const token = withSecret.edgeTokenForLogin_('operator');
    assert.ok(token.indexOf('.') > 0);

    const without = appsScriptSandbox({ netpulse_worker_url: WORKER }, () => ({ getResponseCode: () => 200 }), []);
    vm.runInContext(read('publish-cache.gs'), without, { filename: 'publish-cache.gs' });
    assert.strictEqual(without.edgeTokenForLogin_('operator'), '',
      'no token means the client reads every module from /exec — the pre-existing behaviour');
  });

  await test('a PLACEHOLDER stored as a secret is reported as a placeholder, not as configured', () => {
    /* The exact run that cost an hour: the wrapper's template arguments were left in place, and
       `setEdgeConfig_` answered `publishSecret=set, readSecret=set` — true of the literal text
       "<read secret>", which is a non-empty string. Nothing anywhere said otherwise. */
    const props = {
      netpulse_worker_url: WORKER,
      netpulse_publish_secret: 'stale',
      netpulse_read_secret: 'stale'
    };
    const logs = [];
    const s = appsScriptSandbox(props, () => ({ getResponseCode: () => 200 }), logs);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    s.setEdgeConfig_(WORKER, '<publish secret>', '<read secret>');
    const text = logs.join('\n');
    assert.ok(text.indexOf('PLACEHOLDER') !== -1, 'the placeholder is named rather than accepted: ' + text);
    assert.strictEqual(text.indexOf('✅'), -1, 'and the run does not report success');

    /* The guard must not cry wolf: a real generated secret still reads as written. */
    const clean = [];
    const good = appsScriptSandbox(props, () => ({ getResponseCode: () => 200 }), clean);
    vm.runInContext(read('publish-cache.gs'), good, { filename: 'publish-cache.gs' });
    good.setEdgeConfig_(WORKER, 'a'.repeat(64), 'b'.repeat(64));
    assert.ok(clean.join('\n').indexOf('✅') !== -1, 'a real secret still reads as written');
  });

  await test('the diagnostic names the spelling the worker holds, and cannot write anything', async () => {
    /* The measured shape of the bug this exists for: the value that reached the WORKER carries the
       newline the terminal selection had, and the value `setEdgeConfig_` stored does not, because
       it trims. Repeated five times in one sitting, every attempt looked correct on both screens. */
    const WORKER_READ = READ_SECRET + '\n';
    const WORKER_PUBLISH = PUBLISH_SECRET + '\n';
    const calls = [];

    const fetchImpl = (url, opts) => {
      const headers = (opts && opts.headers) || {};
      calls.push({ url: String(url), headers: headers });

      if (String(url).indexOf('/data/_meta') !== -1) {
        const token = String(headers.authorization || '').replace(/^Bearer /, '');
        const dot = token.indexOf('.');
        const subject = Buffer.from(token.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/'), 'base64')
          .toString('utf8');
        const expected = crypto.createHmac('sha256', WORKER_READ).update(subject, 'utf8').digest('base64')
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return { getResponseCode: () => (token.slice(dot + 1) === expected ? 200 : 401),
                 getContentText: () => '' };
      }

      /* The worker's real order: method, kv, secret, THEN the allow-list. So a matching secret
         reaches the allow-list and is refused 400, and nothing is ever stored. */
      if (headers['x-netpulse-secret'] !== WORKER_PUBLISH) {
        return { getResponseCode: () => 401, getContentText: () => '' };
      }
      const type = String(url).split('?')[1];
      return { getResponseCode: () => (type === 'type=__probe__' ? 400 : 200), getContentText: () => '' };
    };

    const logs = [];
    const s = appsScriptSandbox(configured(), fetchImpl, logs);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });
    s.diagnoseEdgeSecrets_();

    const lines = logs.join('\n').split('\n');
    const found = lines.find((l) => l.indexOf('with a trailing newline') !== -1);
    assert.ok(found && found.indexOf('✅') !== -1,
      'the row that works is NAMED, which is the whole point of the diagnostic: ' + found);

    const notFound = lines.find((l) => l.indexOf('no trailing newline') !== -1);
    assert.ok(notFound && notFound.indexOf('✅') === -1,
      'and the spelling that does not work is not claimed as if it did: ' + notFound);

    /* READ-ONLY is the property that makes this safe to run against production, so it is asserted
       rather than described in a comment: every request is the index, or a type that does not
       exist. A probe that published to a REAL type would put a test payload in front of readers. */
    assert.ok(calls.length > 0, 'it actually probed something');
    calls.forEach((c) => {
      assert.ok(/\/data\/_meta$/.test(c.url) || /\/publish\?type=__probe__$/.test(c.url),
        'the diagnostic only ever touches ' + c.url);
    });
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
