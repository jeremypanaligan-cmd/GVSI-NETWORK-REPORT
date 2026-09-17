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

const ORIGIN = 'https://script.google.com/macros/s/AKfycbxkIueic43_t792kofBTSK31w_0X_LelgVWJZOH2MmU8J_bepVa8hMRr8QhhzpPoN6r_Q/exec';

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

const defaultHandle = createProxy();

export default {
  fetch(request, env) {
    return defaultHandle(request);
  }
};
