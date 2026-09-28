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
      },

      /* Added for the write budget. publish-cache.gs labels every payload with the digest of the
         exact bytes, so the next pass can ask the edge "do you already hold this?" and skip a
         write it does not need. Same signed-byte convention as the HMAC above, because that is
         what both of Apps Script's digest functions return. */
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest: (algorithm, value) => {
        const digest = crypto.createHash('sha256').update(String(value), 'utf8').digest();
        return Array.from(digest).map((b) => (b > 127 ? b - 256 : b));
      },

      /* Only ever asked for the UTC day key that the write counter is kept under. */
      formatDate: (date) => new Date(date.getTime()).toISOString().slice(0, 10).replace(/-/g, '')
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

    /* TWO requests now, and the order is the point: whether a write is spent at all is decided
       from what the edge SAYS it holds, before anything is sent to it. */
    assert.strictEqual(sent.length, 2, 'one read of what the edge holds, then one write');
    assert.strictEqual(sent[0].url, WORKER + '/data/_meta',
      'the budget is decided from the edge\'s own account of itself, not from a local memory of it');

    const write = sent[1];
    assert.strictEqual(write.url.indexOf(WORKER + '/publish?type=nap&builtAt='), 0);
    assert.strictEqual(write.params.method, 'post');
    assert.strictEqual(write.params.payload, payload,
      'the bytes the build produced: the client parses one shape whether it came from here or /exec');
    assert.strictEqual(write.params.headers['x-netpulse-secret'], PUBLISH_SECRET);
    assert.strictEqual(write.params.contentType, 'application/json');
    assert.strictEqual(write.params.muteHttpExceptions, true,
      'a refusal is a body to read, not an exception to raise in the executions log');
  });

  await test('ONE read of the edge per execution, however many types the pass publishes', () => {
    /* The read is memoized because a pass decides five times and the answer cannot change inside
       one execution: five reads a pass would be 1,440 requests a day spent asking the same
       question, against an edge whose whole job is to answer it in microseconds. */
    const sent = [];
    const s = appsScriptSandbox(configured(), (url) => {
      sent.push(String(url));
      return { getResponseCode: () => 200, getContentText: () => '{"ok":true,"types":{}}' };
    }, []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    ['nap', 'lcp', 'olt', 'node', 'backbone'].forEach((t) => s.publishBuiltPayload_(t, '["' + t + '"]'));

    const metaReads = sent.filter((u) => u.indexOf('/data/_meta') !== -1);
    const writes = sent.filter((u) => u.indexOf('/publish?') !== -1);
    assert.strictEqual(metaReads.length, 1, 'one read');
    assert.strictEqual(writes.length, 5, 'and still one write per type the pass built');
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

    /* TWO lines for two failures. This assertion is inverted from what it was, on purpose —
       MEASURED 2026-09-27: the old rule was "one line per execution", and because OLT is always
       published first, four failures out of five were silent for an entire night. Five modules
       failing looked exactly like one module failing. */
    assert.strictEqual(logs.filter((l) => l.indexOf('edge publish failed') !== -1).length, 2,
      'every failed publish is named: one line per execution hid four of five');
    assert.ok(logs[0].indexOf('publish secret') !== -1, 'and the FIRST one names the likely cause of a 401');

    const throwing = appsScriptSandbox(configured(), () => { throw new Error('DNS lookup failed'); }, []);
    vm.runInContext(read('publish-cache.gs'), throwing, { filename: 'publish-cache.gs' });
    assert.strictEqual(throwing.publishBuiltPayload_('nap', '[]'), false,
      'the edge keeps serving the last payload it was given, and the build is not delayed');
  });

  /* ---------------------------------------------------------------- *
     THE WRITE BUDGET — what is NOT sent, and why that is the fix
   * ---------------------------------------------------------------- */

  /* The digest of a payload, computed the way this test can. The assertion that it agrees with
     publish-cache.gs's own Utilities-based encoder is a test of its own below, because a
     disagreement between the two is silent by construction: it would look like "changed". */
  function digestOf(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** An edge that reports what it holds, and accepts (or refuses) every write. */
  function edgeHolding(held, publishCode) {
    const calls = [];
    const fetchImpl = (url, params) => {
      const at = String(url);
      calls.push({ url: at, params: params });
      if (at.indexOf('/data/_meta') !== -1) {
        return { getResponseCode: () => 200,
                 getContentText: () => JSON.stringify({ ok: true, types: held || {} }) };
      }
      const code = publishCode || 200;
      return { getResponseCode: () => code,
               getContentText: () => (code === 200
                 ? '{"ok":true}'
                 : '{"error":"kv_write_failed","detail":"KV PUT failed: 429"}') };
    };
    return {
      fetchImpl: fetchImpl,
      writes: () => calls.filter((c) => c.url.indexOf('/publish?') !== -1),
      reads: () => calls.filter((c) => c.url.indexOf('/data/_meta') !== -1)
    };
  }

  function sandboxOn(fetchImpl, props) {
    const s = appsScriptSandbox(props || configured(), fetchImpl, []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });
    return s;
  }

  function kvWithWrites() {
    const store = new Map();
    return {
      writes: [],
      async getWithMetadata(key) {
        const found = store.get(key);
        return found ? { value: found.value, metadata: found.metadata } : { value: null, metadata: null };
      },
      async put(key, value, opts) {
        this.writes.push({ key: key, value: value, metadata: (opts && opts.metadata) || {} });
        store.set(key, { value: value, metadata: (opts && opts.metadata) || {} });
      }
    };
  }

  await test('a payload the edge ALREADY HOLDS is not written again — the whole point', () => {
    const payload = JSON.stringify([{ A: 'LUZON', P: 'BENGUET' }]);
    const edge = edgeHolding({ nap: { hash: digestOf(payload), publishedAt: Date.now() - 60 * 1000 } });
    const s = sandboxOn(edge.fetchImpl);

    assert.strictEqual(s.publishBuiltPayload_('nap', payload), false);
    assert.strictEqual(edge.writes().length, 0,
      'the same bytes are already there: this write is the 1,440th of a day that allows 1,000');
    assert.strictEqual(s.edgePublishSummary_(), ', 0 of 1 published to the edge (1 unchanged)');
  });

  await test('a CHANGED payload is published, one second after the last write', () => {
    const edge = edgeHolding({ nap: { hash: digestOf('[{"A":"OLD"}]'), publishedAt: Date.now() } });
    const s = sandboxOn(edge.fetchImpl);

    assert.strictEqual(s.publishBuiltPayload_('nap', '[{"A":"NEW"}]'), true,
      'the budget is spent on what changed, never saved on it');
    assert.strictEqual(edge.writes().length, 1);
  });

  await test('identical bytes are rewritten once the edge copy passes the heartbeat', () => {
    const young = edgeHolding({ nap: { hash: digestOf('[]'), publishedAt: Date.now() - 60 * 1000 } });
    const old = edgeHolding({ nap: { hash: digestOf('[]'), publishedAt: Date.now() - 9 * 60 * 1000 } });

    const a = sandboxOn(young.fetchImpl);
    a.publishBuiltPayload_('nap', '[]');
    assert.strictEqual(young.writes().length, 0, 'a minute old is young');

    const b = sandboxOn(old.fetchImpl);
    b.publishBuiltPayload_('nap', '[]');
    assert.strictEqual(old.writes().length, 1,
      'nine minutes is past the 8-minute heartbeat, so a current payload cannot age into a red chip');
  });

  await test("a healthy copy can never be named stale: heartbeat + one warm cycle < the chip's threshold", () => {
    /* Three numbers in three files, and not one of them means anything alone.

       An unchanged payload is rewritten only once the edge's copy is older than
       EDGE_PUBLISH_HEARTBEAT_MS, and the pass that asks that question runs every
       OLT_WARM_INTERVAL_SECONDS. So a HEALTHY copy arrives at the heartbeat question somewhere
       between 8 and 13 minutes old, and what the chip's STALE_AFTER_MS has to clear is THAT SUM —
       not the heartbeat. Merely staying above the heartbeat is how 10 minutes spent 2026-09-28
       naming a working edge stale in the seconds before every heartbeat: a red chip over good data,
       which is worse than no warning at all. */
    const gate = read('fetch-gate.js');
    const minutes = Number((gate.match(/STALE_AFTER_MS = ([0-9]+) \* 60 \* 1000/) || [])[1]);
    assert.ok(minutes > 0, 'fetch-gate.js no longer declares STALE_AFTER_MS = N * 60 * 1000');

    const warmer = read('olt-cache-warmer.gs');
    const cycleSeconds = Number((warmer.match(/OLT_WARM_INTERVAL_SECONDS = ([0-9]+)/) || [])[1]);
    assert.ok(cycleSeconds > 0, 'olt-cache-warmer.gs no longer declares OLT_WARM_INTERVAL_SECONDS = N');

    const s = sandboxOn(() => ({ getResponseCode: () => 200 }));
    const worstMs = s.EDGE_PUBLISH_HEARTBEAT_MS + cycleSeconds * 1000;
    assert.ok(worstMs < minutes * 60 * 1000,
      'the oldest a healthy copy can be when it is rewritten is ' + Math.round(worstMs / 60000) +
      ' min (heartbeat ' + Math.round(s.EDGE_PUBLISH_HEARTBEAT_MS / 60000) + ' + one ' +
      Math.round(cycleSeconds / 60) + '-min pass), and the chip names stale at ' + minutes + ' min');
  });

  await test('UNKNOWN means publish — and the pass says it was flying blind', () => {
    const blind = (url) => (String(url).indexOf('/data/_meta') !== -1
      ? { getResponseCode: () => 401, getContentText: () => '{"error":"unauthorized"}' }
      : { getResponseCode: () => 200, getContentText: () => '{"ok":true}' });
    const s = sandboxOn(blind);

    assert.strictEqual(s.publishBuiltPayload_('nap', '[]'), true,
      'a read the edge refused is not evidence that the bytes are already there');
    assert.ok(s.edgePublishSummary_().indexOf('did not report what it holds') !== -1,
      'and it is admitted rather than left to look like a quiet, thrifty pass: ' +
      s.edgePublishSummary_());
  });

  await test('a type the edge has never held, or holds unlabelled, is published', () => {
    const missing = edgeHolding({ lcp: null });
    const a = sandboxOn(missing.fetchImpl);
    assert.strictEqual(a.publishBuiltPayload_('lcp', '[]'), true);
    assert.strictEqual(missing.writes().length, 1);

    /* A payload stored by an OLDER worker carries no label. An absent label is not a match. */
    const unlabelled = edgeHolding({ nap: { builtAt: 1, publishedAt: Date.now() } });
    const b = sandboxOn(unlabelled.fetchImpl);
    assert.strictEqual(b.publishBuiltPayload_('nap', '[]'), true);
    assert.strictEqual(unlabelled.writes().length, 1);

    /* And a digest that cannot be computed here NEVER matches: unhashable is unknown. */
    const broken = appsScriptSandbox(configured(), edgeHolding({ nap: { hash: 'x', publishedAt: Date.now() } }).fetchImpl, []);
    vm.runInContext(read('publish-cache.gs'), broken, { filename: 'publish-cache.gs' });
    broken.Utilities.computeDigest = () => { throw new Error('no digest here'); };
    assert.strictEqual(broken.edgePayloadHash_('[]'), '', 'no digest, no label');
    assert.strictEqual(broken.publishBuiltPayload_('nap', '[]'), true,
      'an empty digest must never be read as "unchanged"');
  });

  await test('past the daily ceiling the heartbeat stops, and a change still publishes', () => {
    const props = configured();
    const same = edgeHolding({ nap: { hash: digestOf('[]'), publishedAt: Date.now() - 60 * 60 * 1000 } });
    const s = appsScriptSandbox(props, same.fetchImpl, []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });
    props['netpulse_publish_used_' + s.edgeUtcDay_()] = String(s.EDGE_PUBLISH_DAILY_CEILING);

    assert.strictEqual(s.publishBuiltPayload_('nap', '[]'), false, 'the heartbeat is what gives way');
    assert.strictEqual(same.writes().length, 0);
    assert.ok(s.edgePublishSummary_().indexOf('heartbeat paused') !== -1,
      'and the pass says so instead of looking like a thrifty healthy one: ' + s.edgePublishSummary_());

    const changed = edgeHolding({ lcp: { hash: digestOf('[{"A":"OLD"}]'), publishedAt: Date.now() - 60 * 60 * 1000 } });
    const t = appsScriptSandbox(props, changed.fetchImpl, []);
    vm.runInContext(read('publish-cache.gs'), t, { filename: 'publish-cache.gs' });
    assert.strictEqual(t.publishBuiltPayload_('lcp', '[{"A":"NEW"}]'), true,
      'the day being committed does not silence a change: a missed heartbeat costs the age in the ' +
      'chip, and a missed change costs a reader the truth');
    assert.strictEqual(changed.writes().length, 1);
  });

  await test('each write is counted against the same UTC day the plan counts', () => {
    const props = configured();
    const s = appsScriptSandbox(props, edgeHolding({}).fetchImpl, []);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    s.publishBuiltPayload_('nap', '[]');
    s.publishBuiltPayload_('lcp', '[]');
    assert.strictEqual(props['netpulse_publish_used_' + s.edgeUtcDay_()], '2');

    /* A refused write spent nothing, so it is not counted — the counter tracks the plan, not us. */
    const refused = appsScriptSandbox(props, edgeHolding({}, 503).fetchImpl, []);
    vm.runInContext(read('publish-cache.gs'), refused, { filename: 'publish-cache.gs' });
    refused.publishBuiltPayload_('olt', '[]');
    assert.strictEqual(props['netpulse_publish_used_' + refused.edgeUtcDay_()], '2');
  });

  await test('all five failures are named, and the pass line says none of them landed', () => {
    /* THE 2026-09-27 ASSERTION. Five publishes failed on every pass for about seven hours; the
       executions log showed one line, `edge publish failed for olt`, because OLT is published
       first and the old code logged one failure per execution. */
    const logs = [];
    const edge = edgeHolding({}, 503);
    const s = appsScriptSandbox(configured(), edge.fetchImpl, logs);
    vm.runInContext(read('publish-cache.gs'), s, { filename: 'publish-cache.gs' });

    const types = ['olt', 'nap', 'lcp', 'node', 'backbone'];
    types.forEach((t) => s.publishBuiltPayload_(t, '["' + t + '"]'));

    const failures = logs.filter((l) => l.indexOf('edge publish failed') !== -1);
    assert.strictEqual(failures.length, types.length, 'five modules failed: five lines');
    types.forEach((t) => assert.ok(failures.some((l) => l.indexOf('for ' + t + ':') !== -1),
      t + ' is named in the log — this is the whole fix for the silence'));

    const summary = s.edgePublishSummary_();
    assert.ok(summary.indexOf(', 0 of 5 published to the edge') === 0, summary);
    assert.ok(summary.indexOf('PUBLISH FAILED: 5') !== -1, summary);
    assert.ok(summary.indexOf('kv_write_failed') !== -1,
      'the worker\'s own words are relayed, not a bare status code: ' + summary);
  });

  await test('a mixed pass says exactly how many were written and how many were left alone', () => {
    const same = digestOf('[]');
    const edge = edgeHolding({
      nap: { hash: same, publishedAt: Date.now() - 60000 },
      lcp: { hash: same, publishedAt: Date.now() - 60000 },
      olt: { hash: same, publishedAt: Date.now() - 60000 },
      node: { hash: same, publishedAt: Date.now() - 60000 },
      backbone: { hash: digestOf('[{"A":"OLD"}]'), publishedAt: Date.now() - 60000 }
    });
    const s = sandboxOn(edge.fetchImpl);

    ['olt', 'nap', 'lcp', 'node', 'backbone'].forEach((t) => s.publishBuiltPayload_(t, '[]'));

    assert.strictEqual(edge.writes().length, 1, 'one write where five used to be spent');
    assert.strictEqual(edge.reads().length, 1, 'and one read to know which one it was');
    assert.strictEqual(s.edgePublishSummary_(), ', 1 of 5 published to the edge (4 unchanged)');
  });

  await test('the digest this half computes is byte-for-byte the label the worker stores', async () => {
    /* The seam, guarded the same way the token seam is: two implementations of one derivation —
       Apps Script's Utilities.computeDigest on this side, crypto.subtle on the worker's. A single
       byte of disagreement is not an error message anywhere; it is a payload that silently stops
       being republished until the heartbeat catches it. */
    const s = sandboxOn(() => ({ getResponseCode: () => 200 }));

    const payloads = ['[]', '{}', '[{"A":"BENGUET","T":5}]', JSON.stringify({ rows: 'x'.repeat(4096) })];
    for (const payload of payloads) {
      const here = s.edgePayloadHash_(payload);
      assert.ok(here && here.length === 43 && here.indexOf('=') === -1,
        'unpadded base64url of 32 bytes is 43 characters: ' + here);

      const kv = kvWithWrites();
      const plane = createDataPlane({ kv, readSecret: READ_SECRET, publishSecret: PUBLISH_SECRET });
      const res = await plane(new Request(WORKER + '/publish?type=nap', {
        method: 'POST', headers: { 'x-netpulse-secret': PUBLISH_SECRET }, body: payload
      }));

      assert.strictEqual(res.status, 200);
      assert.strictEqual(kv.writes[0].metadata.hash, here,
        'the two halves agree on one digest for ' + payload.slice(0, 32));
    }
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
