// ====================== BOOT BUNDLE ======================
//
// ONE request for the whole opening.
//
// WHAT THE OPENING COST BEFORE THIS FILE
//
// index.html fetches NAP on load and nothing else; LCP, NODE and BACKBONE are fetched on
// their first tab click, and OLT on its own. So a session opening the app and glancing at
// three tabs spent four round trips, and every one of them paid Apps Script's fixed cost
// in full: ~1.1-1.5 s of startup plus the 302 -> googleusercontent echo hop, whatever the
// payload was. Measured payload sizes from the warm pass:
//
//     olt 629 B    nap 742 B    lcp 512 B    node 1980 B    backbone 1640 B
//     ------------------------------------------------------------- 5,503 bytes total
//
// That is ~6 s of protocol overhead to move 5.5 KB. `?action=bundle` answers all five in
// one execution and one round trip, and this file is the client half of it.
//
// FAIL-OPEN, ALWAYS, AND THAT IS THE WHOLE SAFETY ARGUMENT
//
// Every path out of bootFromBundle() resolves with a summary — never a rejection, never a
// thrown error into a caller that is drawing the screen. If the route is missing (an older
// deployment), if the origin answers {error:"Unknown action: bundle"}, if the request hangs,
// if a payload is the shape its module would refuse, if the payload names a module this
// build does not have — the summary says so, nothing is hydrated, and every module loads
// through exactly the path it used before this file existed.
//
// Two consequences worth naming, because they are why this is safe to ship:
//   - The deploy order does not matter. A client that asks an older server for the bundle
//     takes the fallback; a server with the route and an older client is simply never asked.
//   - The change is reversible by removing one <script> tag.
//
// WHY THE SHAPE CHECKS ARE DUPLICATED FROM THE MODULES
//
// A bundle that stored a payload where a module expects a different shape would not fail
// loudly — it would draw an empty table. This app has shipped that bug once already: an OLT
// prefetch asked for the wrong shape and stored the raw envelope where a decoded array
// belongs, leaving the tables and the summary cards describing two different payloads. So
// the check each loader applies to its own response is applied here before anything is
// stored, and OLT goes through the module's own applier rather than a copy of it.
//
// Depends on: fetchWithRetry(), BASE_API_URL and dataCache from index.html; fetchGate;
// applyOltPayload() from olt-module.js.

(function () {
  'use strict';

  /* Long enough for a cold origin (~2.5-3 s measured for a first call) plus one retry, short
     enough that a hung request cannot hold the opening hostage. The fallback is the app's
     own five-request path, so the cost of giving up early is a slower opening, never a
     broken one. */
  var BUNDLE_TIMEOUT_MS = 15000;

  function nowMs() { return Date.now(); }

  /* The shape each module's own loader insists on before it stores a response. OLT is absent
     on purpose: applyOltPayload() is that check, and it is the module's, not a copy. */
  function shapeOk_(type, payload) {
    if (type === 'lcp') {
      return !!payload && typeof payload === 'object' && Array.isArray(payload.lcpAging);
    }
    return Array.isArray(payload);
  }

  /* Rejects if the fetch outlives BUNDLE_TIMEOUT_MS.
     The underlying request is NOT aborted — fetchWithRetry() has no signal to pass it — so a
     late response is simply ignored. That is harmless here for a specific reason: this call
     does not go through fetchGate.run(), so nothing is holding a module's in-flight slot, and
     a straggler cannot block or duplicate the per-module path it fell back to. */
  function withTimeout_(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('bundle timed out after ' + ms + 'ms'));
      }, ms);
      promise.then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) { clearTimeout(timer); reject(e); }
      );
    });
  }

  /**
   * Put each payload where its module already expects to find it.
   *
   * `refused` is not a failure list to hide: it is how a wrong-shaped or unknown payload is
   * kept out of the cache instead of being drawn as an empty table.
   *
   * @param {Object} payloads     type -> payload
   * @param {Object} [builtAtMap]  type -> the server's build time, when the source knows it
   * @return {{hydrated: string[], refused: string[]}}
   */
  function hydrate_(payloads, builtAtMap) {
    var hydrated = [];
    var refused = [];
    var types = Object.keys(payloads || {});

    for (var i = 0; i < types.length; i++) {
      var type = types[i];
      var payload = payloads[type];
      var stored = false;

      if (type === 'olt') {
        /* The module's own applier: it decodes the compact envelope, sets oltMeta, points the
           age chip at the server's build time, and answers false for anything unusable. There is
           deliberately no second decoder here. */
        stored = (typeof applyOltPayload === 'function') && applyOltPayload(payload) === true;
      } else if ((type in dataCache) && shapeOk_(type, payload)) {
        /* `in` against the live cache object: a type the server sends but this build has no
           module for is refused rather than stored under a name nothing will ever read. */
        dataCache[type] = payload;
        stored = true;
      }

      if (!stored) {
        refused.push(type);
        continue;
      }

      /* Tell the gate this type was fetched, or its own loader sees no fetch history, goes
         straight back to the network for bytes it already has, and the opening is five round
         trips again.

         OLT is included here on purpose — it is the module whose loader is most eager to refetch
         (its cached path queues a refresh every time it is drawn), and stamping it is what makes
         the bundle actually replace that request rather than precede it.

         The built time comes from the source when it has one: the edge publishes it per type, and
         a real stamp is what lets the chip say "Data as of 09:12" instead of "we asked just now".
         The origin bundle carries no per-type stamp, so it passes 0 — an honest "unknown" that
         noteBuiltAt() ignores, leaving OLT with the real stamp applyOltPayload() just took from
         its own payload. */
      var stamp = (builtAtMap && Number(builtAtMap[type])) || 0;
      if (typeof fetchGate !== 'undefined' && fetchGate && typeof fetchGate.noteHydrated === 'function') {
        fetchGate.noteHydrated(type, stamp);
      }

      hydrated.push(type);
    }

    return { hydrated: hydrated, refused: refused };
  }

  /* THE EDGE FIRST, WHEN ONE IS CONFIGURED.

     Same shape checks and the same fail-open as the origin path below, and `null` is the entire
     contract: a refusal of any kind — no token, 401, 404, a timeout, an unusable bundle — means
     the caller's next move is the request this app has always made. What it buys is the
     difference between one Apps Script execution (~1.2-1.8 s) and one edge read (tens of
     milliseconds) for the whole opening, and because the payloads are assembled AT the edge this
     is still ONE round trip — the property `?action=bundle` was built for. */
  function bootFromEdge_() {
    if (!window.cdnSource || typeof window.cdnSource.enabled !== 'function' || !window.cdnSource.enabled()) {
      return Promise.resolve(null);
    }

    var started = nowMs();

    return withTimeout_(window.cdnSource.fetchBundle(), BUNDLE_TIMEOUT_MS)
      .then(function (env) {
        if (!env || env.ok !== true || !env.bundle || typeof env.bundle !== 'object') return null;

        var put = hydrate_(env.bundle, env.builtAt || {});
        if (!put.hydrated.length) {
          console.warn('[BootBundle] the edge answered nothing usable — asking the origin');
          return null;
        }

        console.log('[BootBundle] ' + put.hydrated.length + ' module(s) from the edge in ' +
                    (nowMs() - started) + 'ms: ' + put.hydrated.join(', ') +
                    (put.refused.length ? ' — refused: ' + put.refused.join(', ') : '') +
                    (Array.isArray(env.missing) && env.missing.length ? ' — not published: ' + env.missing.join(', ') : ''));

        return {
          used: true,
          source: 'edge',
          hydrated: put.hydrated,
          refused: put.refused,
          missing: Array.isArray(env.missing) ? env.missing : [],
          reason: ''
        };
      })
      .catch(function (err) {
        console.warn('[BootBundle] edge read gave nothing (' +
                     (err && err.message ? err.message : err) + ') — asking the origin');
        return null;
      });
  }

  /**
   * Ask the ORIGIN for the whole opening at once. See bootFromBundle().
   *
   * @return {Promise<Object>}
   */
  function bootFromOrigin_() {
    var started = nowMs();

    return withTimeout_(fetchWithRetry(BASE_API_URL + '?action=bundle', 1, 800), BUNDLE_TIMEOUT_MS)
      .then(function (res) {
        if (!res || res.ok !== true || !res.bundle || typeof res.bundle !== 'object') {
          return { used: false, source: 'none', hydrated: [], refused: [], missing: [],
                   reason: 'no bundle in the response' };
        }

        var put = hydrate_(res.bundle);
        var summary = {
          used: put.hydrated.length > 0,
          source: 'origin',
          hydrated: put.hydrated,
          refused: put.refused,
          missing: Array.isArray(res.missing) ? res.missing : [],
          reason: put.hydrated.length ? '' : 'the bundle answered nothing usable'
        };

        if (put.hydrated.length) {
          console.log('[BootBundle] ' + put.hydrated.length + ' module(s) in one request in ' +
                      (nowMs() - started) + 'ms: ' + put.hydrated.join(', ') +
                      (put.refused.length ? ' — refused: ' + put.refused.join(', ') : '') +
                      (summary.missing.length ? ' — not warm: ' + summary.missing.join(', ') : ''));
        } else {
          console.warn('[BootBundle] nothing usable (' + put.refused.join(', ') +
                       ') — every module will load the way it did before the bundle existed');
        }
        return summary;
      })
      .catch(function (err) {
        /* The expected case, not an exceptional one: an older deployment, the documented
           cold-start 404, or a phone on a bad connection. */
        console.warn('[BootBundle] falling back to per-module loads: ' +
                     (err && err.message ? err.message : err));
        return { used: false, source: 'none', hydrated: [], refused: [], missing: [],
                 reason: err && err.message ? err.message : String(err) };
      });
  }

  /**
   * The whole opening, from whichever source can answer it.
   *
   * NEVER REJECTS. The resolved summary is:
   *   { used, source, hydrated[], refused[], missing[], reason }
   * `source` is 'edge', 'origin' or 'none' — the single fact that says which path the opening
   * actually took, so "is the edge being read at all?" is answerable without a network panel.
   *
   * @return {Promise<Object>}
   */
  window.bootFromBundle = function () {
    return bootFromEdge_().then(function (summary) {
      return summary || bootFromOrigin_();
    });
  };

  /* Introspection and the timeout knob, matching fetchGate.configure(). Real values are the
     defaults; the override exists so the timeout path can be driven by a test without
     waiting fifteen seconds for it. */
  window.bootBundle = {
    configure: function (opts) {
      if (opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
        BUNDLE_TIMEOUT_MS = opts.timeoutMs;
      }
    },
    timeoutMs: function () { return BUNDLE_TIMEOUT_MS; }
  };
})();
