/* ------------------------------------------------------------------
   NetPulse edge proxy — a Cloudflare Worker.

   WHY THIS EXISTS
   ---------------
   The app called the Apps Script deployment directly, and that call is a two-hop
   redirect: /exec answers 302 to script.googleusercontent.com/macros/echo, and THAT
   hop is the one that fails. Measured with tools/api-probe.js on 2026-09-13:

     hop 1  302  script.google.com             +400 - 3,100 ms
     hop 2  200  script.googleusercontent.com  +400 ms

   and during an origin stall, 3/15 = 20% of calls ended in a 404 from the redirect
   target — every one of them on a call that had already taken 8-33 s, against
   1.1-1.3 s for the calls that answered. curl reproduced it with no cookies, no JS
   and no service worker, which is what ruled the browser out as the cause.

   The browser can do nothing about that: it pays the whole chain, it sees the 404,
   and its own retry has to be visible and slow. This worker moves the chain off the
   client:

     browser --1 request--> worker --retries the flaky chain--> Apps Script

   WHAT IT DELIBERATELY DOES NOT DO: CACHE.
   A 24/7 NOC display showing a stale outage is worse than one that takes 1.2 s, so
   every request goes to the origin — but with up to three attempts that the caller
   never sees. If caching is ever wanted, key it on `type=` only and never on
   `action=`, which carries sessions and tokens.

   WHAT IT IS NOT: an open relay. The origin URL is fixed and only a whitelist of
   query parameters is forwarded, so a caller cannot make it fetch anything else.

   Observability: each response carries `x-netpulse-attempts` (1 = the origin answered
   first try) and `x-netpulse-origin-ms`. A slow call can therefore be told apart from
   a retried one without reading any logs.

   Deployment: see proxy/README.md.  Tests: tests/proxy.test.js.
 * ------------------------------------------------------------------ */

const ORIGIN = 'https://script.google.com/macros/s/AKfycby4y2cFYIYvwldcGk2l9FfV7Vd3Bka7ec3tk40h5z7Gb6QjShtVE8BkYw-T_wQMy4h5IA/exec';

const ATTEMPTS = 3;
// Apps Script answers in ~1.2 s warm and can stall for 30 s+; a per-attempt ceiling
// keeps one stalled attempt from eating the whole budget.
const ATTEMPT_TIMEOUT_MS = 20000;
const BACKOFF_MS = 250;
const ALLOWED_ORIGIN = '*';

/* Only these reach the origin. Anything else in the query is dropped, so the worker
   cannot be turned into a relay even though the origin itself is a public URL.

   THIS LIST MUST BE EXACTLY THE SET `code.gs` / `admin.gs` READ, because a dropped
   parameter is not an error the caller can see — Apps Script answers 200 with JSON
   either way. It shipped without `password`, and sign-in failed for everyone with
   "Invalid username or password" while the credentials were correct: the worker was
   stripping the password before the origin ever saw it. `enabled` was missing too, so
   `action=setMaintenance` could only ever turn maintenance OFF.

   `tests/proxy.test.js` now derives the expected set from `e.parameter.*` in the
   backend and fails if this list does not cover it, so the next route added to a .gs
   file cannot silently lose its inputs here. (`probe` is the worker's own.) */
const ALLOWED_PARAMS = new Set([
  'type', 'action', 'shape', 'token', 'username', 'password', 'fullName', 'enabled', 'probe'
]);

function corsHeaders() {
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,HEAD,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    // Without this the browser HIDES the x-netpulse-* headers from JavaScript on a
    // cross-origin response: measured from the app, res.headers.keys() returned none of
    // them while the same call from curl showed both. Devtools and the logs see them
    // either way — this is what makes them usable IN the app, so that "was that call
    // retried?" does not require a console.
    'access-control-expose-headers': 'x-netpulse-attempts, x-netpulse-origin-ms'
  };
}

function jsonResponse(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      // The app owns its own freshness (dataCache + the per-module throttle), and a
      // cached error page is worse than no cache at all.
      'cache-control': 'no-store'
    }, corsHeaders(), extraHeaders || {})
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* The origin URL the worker will call, built from the caller's query string. Exported
   so the test can assert the forwarding rule without a network. */
export function buildOriginUrl(requestUrl, origin = ORIGIN) {
  const incoming = new URL(requestUrl);
  const target = new URL(origin);
  for (const [key, value] of incoming.searchParams) {
    if (ALLOWED_PARAMS.has(key)) target.searchParams.append(key, value);
  }
  return target;
}

/* One attempt at the origin, classified the way the failure actually presents:
   Apps Script always answers 200 with JSON (ContentService cannot set a status), so a
   stall shows up as a 404/5xx from the redirect target OR as a body that is not JSON.
   Both must be retried; a 200 carrying HTML would otherwise be parsed by the app as a
   crash. */
async function attemptOnce(url, fetchImpl, timeoutMs) {
  const started = Date.now();
  const res = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch (err) {
    body = null;
  }
  return {
    status: res.status,
    body,
    ms: Date.now() - started,
    usable: res.ok && body !== null
  };
}

/* The testable core: no globals except the ones injected here. */
export function createProxy({
  origin = ORIGIN,
  fetchImpl = fetch,
  attempts = ATTEMPTS,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
  backoffMs = BACKOFF_MS,
  sleepImpl = sleep,
  log = (message) => console.warn(message)
} = {}) {
  async function handle(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return jsonResponse({ error: 'method not allowed' }, 405);
    }

    const url = new URL(request.url);

    // Liveness: answers without touching the origin, so "is the worker up" and "is the
    // origin healthy" stay separable when something is wrong.
    if (url.searchParams.get('probe') === '1') {
      return jsonResponse({
        ok: true,
        origin,
        attempts: attempts,
        attemptTimeoutMs: timeoutMs,
        time: new Date().toISOString()
      }, 200);
    }

    const target = buildOriginUrl(request.url, origin);
    let last = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const result = await attemptOnce(target.href, fetchImpl, timeoutMs);
        last = result;
        if (result.usable) {
          return jsonResponse(result.body, 200, {
            'x-netpulse-attempts': String(attempt),
            'x-netpulse-origin-ms': String(result.ms)
          });
        }
        log('attempt ' + attempt + '/' + attempts + ' unusable: HTTP ' + result.status +
            ' after ' + result.ms + ' ms');
      } catch (err) {
        last = { status: 0, ms: timeoutMs, body: null, usable: false };
        log('attempt ' + attempt + '/' + attempts + ' threw: ' + (err && err.message));
      }

      if (attempt < attempts) {
        // Jittered so parallel callers do not line up on the same retry instant.
        await sleepImpl(backoffMs * attempt + Math.floor(Math.random() * 250));
      }
    }

    /* Exhausted. Answer with the same shape the service worker uses for an offline API,
       so the app's existing classification (503 => server busy, retryable) applies and
       a 404 never reaches a module: a module that saw one used to sit on
       "Error loading data." until its next poll. */
    return jsonResponse({
      offline: true,
      message: 'Upstream Apps Script did not answer after ' + attempts + ' attempts',
      lastStatus: last ? last.status : 0
    }, 503, {
      'x-netpulse-attempts': String(attempts)
    });
  }

  return handle;
}

/* ==================================================================
   THE DATA PLANE — the second job this worker does

   The pass-through above exists to absorb a bad hop. This half exists to REMOVE the hop: the
   trigger publishes each built payload here, the app reads it from the edge in tens of
   milliseconds, and Apps Script is not in the read path at all.

   Route map
     POST /publish?type=nap     header x-netpulse-secret      -> KV write, returns {ok,bytes}
     GET  /data/nap             Authorization: Bearer <tok>   -> the payload, edge-cached 60 s
     GET  /data/_bundle         same                       -> all five in ONE read
     GET  /data/_meta           same                       -> {types, builtAt, rev, bytes}

   WHY A TOKEN AND NOT JUST AN OBSCURE PATH

   The app's `?type=` data routes are NOT session-gated today: `resolveSession()` is called
   only by the admin and diag routes, and index.html says so in its own comment. So "the data
   is behind the login" is true of the UI only. A CDN path would add the two things the
   obscure `/exec` URL does not have — it can be found, and it can be cached and copied — so
   the read is gated by a short-lived HMAC the deployment mints at login. The worker verifies
   it with no state and no call back to Apps Script, which is the whole point of moving the
   read out here.

   `u|exp` is signed with READ_SECRET (Utilities.computeHmacSha256Signature on the Apps
   Script side, crypto.subtle here). The subject is carried IN the token because a signature
   over an unseen payload cannot be checked.

   WHAT IT REFUSES, AND WHY THAT MATTERS

   - A body that is an ERROR ENVELOPE (`{error:...}`) is never published. An empty payload is
     still a cacheable payload, and the app has shipped exactly that bug once (a prefetch that
     stored the raw envelope where a decoded array belongs).
   - A request without the publish secret is refused BEFORE the body is parsed.
   - A read without a valid, unexpired token is refused with 401, and the client falls back to
     the `/exec` path it came from — this worker can never be the reason a screen goes blank.
   - An unpublished type answers 404 `not_published`, not an error, because "not published
     yet" is the state every type is in before the first trigger run after a deploy.

   Secrets live in Worker settings (PUBLISH_SECRET, READ_SECRET) and in Script Properties on
   the Apps Script side. They are deliberately absent from this repository.
 * ================================================================== */

const DATA_TYPES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

/* How long the EDGE may keep a payload without re-reading KV. Cloudflare's floor is 60 s and
   the publish cadence is 300 s, so this cannot serve a copy the trigger has already replaced
   by more than one cycle — and it is what keeps an edge read in the single-digit milliseconds
   instead of a KV round trip. Freshness for the reader is the chip's job, not the cache's. */
const READ_CACHE_TTL_SECONDS = 60;

/* The largest payload this app builds is OLT at ~50 KB (shape=2/3). 512 KB leaves room for a
   shape that grows and still refuses anything that is not this app. */
const MAX_PUBLISH_BYTES = 512 * 1024;

const TOKEN_SEPARATOR = '.';

function dataCorsHeaders() {
  return {
    'access-control-allow-origin': ALLOWED_ORIGIN,
    'access-control-allow-methods': 'GET,HEAD,OPTIONS,POST',
    // `authorization` is not a CORS-safelisted header, so without it the preflight fails and
    // every read arrives as a network error on the client — which the app would then read as
    // "the CDN is down" and fall back from, silently, forever.
    'access-control-allow-headers': 'authorization, content-type, x-netpulse-secret',
    'access-control-max-age': '86400',
    'access-control-expose-headers': 'x-netpulse-built-at, x-netpulse-rev, x-netpulse-published-at, x-netpulse-attempts'
  };
}

function dataJson(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }, dataCorsHeaders(), extraHeaders || {})
  });
}

function b64urlToBytes(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* Length-independent, value-independent comparison. The secret's length is not a secret, but
   "did the first byte match" is the kind of thing a caller can average out over enough
   requests, so this does not return early on a mismatch. */
function equalBytes(a, b) {
  if (!a || !b) return false;
  const left = a instanceof Uint8Array ? a : new TextEncoder().encode(String(a));
  const right = b instanceof Uint8Array ? b : new TextEncoder().encode(String(b));
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }
  return diff === 0;
}

/* Verify `<b64url(subject)>.<b64url(hmac)>` against the read secret, and check its expiry.
   Returns { ok, subject } — never throws, so a malformed token is a refusal rather than a
   500 that the client would read as "the edge is broken". */
async function verifyReadToken(token, readSecret, now, subtle) {
  const raw = String(token || '').trim();
  if (!raw || !readSecret) return { ok: false, reason: 'no_token' };

  const dot = raw.indexOf(TOKEN_SEPARATOR);
  if (dot <= 0) return { ok: false, reason: 'malformed' };

  const subjectBytes = b64urlToBytes(raw.slice(0, dot));
  const signature = b64urlToBytes(raw.slice(dot + 1));
  const subject = new TextDecoder().decode(subjectBytes);

  let key;
  try {
    key = await subtle.importKey('raw', new TextEncoder().encode(readSecret),
                                 { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  } catch (err) {
    return { ok: false, reason: 'key_unusable' };
  }

  const valid = await subtle.verify('HMAC', key, signature, subjectBytes);
  if (!valid) return { ok: false, reason: 'bad_signature' };

  const exp = Number(subject.split('|')[1]);
  if (!isFinite(exp) || exp <= now()) return { ok: false, reason: 'expired' };

  return { ok: true, subject: subject.split('|')[0], exp: exp };
}

/**
 * The data plane, as a factory so the whole thing is testable without a network or a KV.
 *
 * @param {Object}   opts
 * @param {Object}   opts.kv               the KV namespace binding (`env.DATA`)
 * @param {string}   opts.readSecret       READ_SECRET
 * @param {string}   opts.publishSecret    PUBLISH_SECRET
 * @param {Function} [opts.now]
 * @param {Function} [opts.log]
 * @param {Object}   [opts.subtle]         crypto.subtle, injectable for tests
 */
export function createDataPlane({
  kv = null,
  readSecret = '',
  publishSecret = '',
  now = () => Date.now(),
  log = (message) => console.warn(message),
  subtle = (typeof crypto !== 'undefined' && crypto.subtle) || null
} = {}) {
  async function readPayload(type) {
    const entry = await kv.getWithMetadata(type, { type: 'text', cacheTtl: READ_CACHE_TTL_SECONDS });
    const value = entry && entry.value;
    if (typeof value !== 'string' || !value.length) return null;
    return { value, metadata: (entry && entry.metadata) || {} };
  }

  function stampHeaders(metadata, extra) {
    const meta = metadata || {};
    return Object.assign({
      'x-netpulse-built-at': meta.builtAt ? String(meta.builtAt) : '',
      'x-netpulse-rev': (meta.rev === undefined || meta.rev === null) ? '' : String(meta.rev),
      'x-netpulse-published-at': meta.publishedAt ? String(meta.publishedAt) : ''
    }, extra || {});
  }

  /* One place decides whether a caller may read, so every route below cannot forget it. */
  async function gateRead(request) {
    if (!kv) return { error: dataJson({ error: 'edge_not_configured', field: 'DATA' }, 503) };
    if (!readSecret) return { error: dataJson({ error: 'edge_not_configured', field: 'READ_SECRET' }, 503) };

    const header = request.headers.get('authorization') || '';
    const token = header.toLowerCase().indexOf('bearer ') === 0 ? header.slice(7).trim() : '';
    const verdict = await verifyReadToken(token, readSecret, now, subtle);
    if (!verdict.ok) {
      /* Named, never echoed: the client logs the reason once and stops asking (the token is
         either expired or the secret moved), and nothing about the token itself is repeated
         back to the caller. */
      return { error: dataJson({ error: 'unauthorized', reason: verdict.reason }, 401) };
    }
    return { session: { subject: verdict.subject, exp: verdict.exp } };
  }

  async function handlePublish(request, url) {
    if (request.method !== 'POST') return dataJson({ error: 'method not allowed' }, 405);
    if (!kv) return dataJson({ error: 'edge_not_configured', field: 'DATA' }, 503);
    if (!publishSecret) return dataJson({ error: 'edge_not_configured', field: 'PUBLISH_SECRET' }, 503);

    /* Before the body is read: an unauthenticated caller must not be able to make this worker
       spend anything at all, including parsing. */
    const offered = request.headers.get('x-netpulse-secret') || '';
    if (!equalBytes(offered, publishSecret)) {
      return dataJson({ error: 'unauthorized' }, 401);
    }

    const type = url.searchParams.get('type') || '';
    if (DATA_TYPES.indexOf(type) === -1) {
      return dataJson({ error: 'unknown type', type: type }, 400);
    }

    const text = await request.text();
    if (text.length > MAX_PUBLISH_BYTES) {
      return dataJson({ error: 'payload too large', bytes: text.length }, 413);
    }

    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return dataJson({ error: 'body is not JSON' }, 400);
    }

    /* THE ONE REFUSAL THAT PROTECTS THE READERS. A build that failed answers with
       {error:...}; publishing that would put a crash on every screen in the fleet and keep
       serving it until the next successful run. An empty ARRAY or OBJECT is not refused:
       "nothing to report" is real data (it is how the OLT zero state and the NAP/LCP
       "no pending" screens are drawn). */
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
      return dataJson({ error: 'refused_error_envelope', upstream: String(parsed.error) }, 400);
    }

    const builtAt = Number(url.searchParams.get('builtAt') || request.headers.get('x-netpulse-built-at') || 0) || 0;
    const rev = url.searchParams.get('rev') || request.headers.get('x-netpulse-rev') || '';

    await kv.put(type, text, {
      metadata: {
        builtAt: builtAt,
        rev: rev,
        bytes: text.length,
        publishedAt: now()
      }
    });

    return dataJson({ ok: true, type: type, bytes: text.length, builtAt: builtAt, rev: rev },
                    200, stampHeaders({ builtAt: builtAt, rev: rev, publishedAt: now() }));
  }

  async function handleRead(request, url, gate) {
    const rest = url.pathname.slice('/data/'.length);

    if (rest === '_bundle') {
      /* ONE read for the whole opening. The five KV reads happen AT THE EDGE, so this costs
         the caller a single round trip of the same tens of milliseconds a single payload
         does — and it keeps `?action=bundle`'s one-request property without asking Apps
         Script to execute anything. */
      const found = await Promise.all(DATA_TYPES.map(async (type) => ({ type: type, entry: await readPayload(type) })));
      const payloads = {};
      const builtAt = {};
      const rev = {};
      const missing = [];

      for (const item of found) {
        if (!item.entry) { missing.push(item.type); continue; }
        let value = null;
        try {
          value = JSON.parse(item.entry.value);
        } catch (err) {
          /* A stored body that will not parse is never handed to a module: the client would
             store it and draw an empty table. Skipped, and named in `missing`. */
          log('bundle: ' + item.type + ' holds unparseable bytes — skipped');
          missing.push(item.type);
          continue;
        }
        payloads[item.type] = value;
        if (item.entry.metadata.builtAt) builtAt[item.type] = item.entry.metadata.builtAt;
        if (item.entry.metadata.rev) rev[item.type] = item.entry.metadata.rev;
      }

      return dataJson({
        ok: true,
        bundle: payloads,
        builtAt: builtAt,
        rev: rev,
        missing: missing,
        subject: gate.session.subject
      }, 200);
    }

    if (rest === '_meta') {
      const found = await Promise.all(DATA_TYPES.map(async (type) => ({ type: type, entry: await readPayload(type) })));
      const index = {};
      for (const item of found) {
        index[item.type] = item.entry
          ? { builtAt: item.entry.metadata.builtAt || 0,
              rev: item.entry.metadata.rev || '',
              bytes: item.entry.metadata.bytes || item.entry.value.length,
              publishedAt: item.entry.metadata.publishedAt || 0 }
          : null;
      }
      return dataJson({ ok: true, types: index, subject: gate.session.subject }, 200);
    }

    if (DATA_TYPES.indexOf(rest) === -1) {
      return dataJson({ error: 'unknown type', type: rest }, 400);
    }

    const entry = await readPayload(rest);
    if (!entry) {
      /* 404, and named as a state rather than a failure: the client treats it as "not
         published" and reads the type from `/exec` exactly as it did before this existed. */
      return dataJson({ error: 'not_published', type: rest }, 404);
    }

    return new Response(entry.value, {
      status: 200,
      headers: Object.assign({
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      }, dataCorsHeaders(), stampHeaders(entry.metadata))
    });
  }

  return async function handle(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: dataCorsHeaders() });
    }

    const url = new URL(request.url);

    if (url.pathname === '/publish' || url.pathname === '/publish/') {
      return handlePublish(request, url);
    }

    if (url.pathname.indexOf('/data/') === 0) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return dataJson({ error: 'method not allowed' }, 405);
      }
      const gate = await gateRead(request);
      if (gate.error) return gate.error;
      return handleRead(request, url, gate);
    }

    return dataJson({ error: 'not found' }, 404);
  };
}

/* Path routing is additive: the app's existing calls all carry their route in the QUERY
   (`/?type=nap`, `/?action=login`), so nothing that works today can reach the data plane by
   accident, and the data plane can only answer `/publish` and `/data/*`.

   Exported so the test can assert WHICH plane a path reaches without making a request — the
   failure this guards is the quiet one, where a new worker route swallows the pass-through
   the app still depends on. */
export function planeFor(pathname) {
  const path = String(pathname || '');
  if (path.indexOf('/data/') === 0 || path.indexOf('/publish') === 0) return 'data';
  return 'proxy';
}

const defaultHandle = createProxy();

export default {
  fetch(request, env) {
    if (planeFor(new URL(request.url).pathname) === 'data') {
      return createDataPlane({
        kv: (env && env.DATA) || null,
        readSecret: (env && env.READ_SECRET) || '',
        publishSecret: (env && env.PUBLISH_SECRET) || ''
      })(request);
    }
    return defaultHandle(request);
  }
};
