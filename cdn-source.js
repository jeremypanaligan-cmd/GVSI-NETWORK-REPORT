// ====================== CDN SOURCE ======================
//
// The client half of the edge read path (see publish-cache.gs and proxy/netpulse-proxy.mjs).
//
// WHY THIS EXISTS
//
// Every module read used to be an Apps Script execution: ~1.2-1.8 s warm, a 302 to
// script.googleusercontent.com, and the ~20% 404 tail measured during a stall. The payload is
// 0.5-50 KB. The trigger now publishes each built payload to the edge at its own cadence, and
// this file reads it from there — tens of milliseconds, one hop, no execution.
//
// WHAT IT IS NOT ALLOWED TO DO
//
//   - It must never be the reason a screen is empty. Every read here is an ATTEMPT with a hard
//     timeout; fetch-gate.js puts the pre-existing /exec path behind it, and nothing in this file
//     can replace, delay or fail that path.
//   - It must never claim freshness it does not have. The edge answers with the time the payload
//     was BUILT (x-netpulse-built-at), and that is handed to the gate, so the chip says "Data as
//     of 09:12" about bytes that were not fetched at 09:12.
//   - It must not keep paying for an edge that is not there. Two consecutive misses and it stands
//     down for five minutes: a device whose token expired, or against a worker that was deleted,
//     reads through /exec instead of adding a failed attempt to every request forever.
//
// THE TWO SWITCHES
//
//   window.NETPULSE_CDN   the worker host. BLANK (the default) = this file is inert and every
//                         read goes to /exec exactly as before. One value = one rollback.
//   netpulse_cdn_token    the HMAC the deployment minted at login (localStorage). No token means
//                         no edge reads, which is what a device that logged in before this
//                         shipped will have.
//
// Depends on: fetchGate (for noteBuiltAt) and the page's localStorage keys. Reads no page global
// at load time, so it is safe to load before the page script.

(function () {
  'use strict';

  /* The edge answers in tens of milliseconds. Three seconds is generous for a cold worker start
     on a bad mobile connection and still short enough that a dead host costs one blip per read
     rather than a stall — the gate gives this attempt its own 30 s ceiling on top. */
  var EDGE_TIMEOUT_MS = 3000;

  /* Stand down after this many consecutive misses, for this long. Two, not one: a single miss is
     a token that expired mid-session or a publish that has not happened yet, and both recover on
     their own. Five minutes is one publish cadence. */
  var COOLDOWN_AFTER = 2;
  var COOLDOWN_MS = 5 * 60 * 1000;

  var TOKEN_KEY = 'netpulse_cdn_token';
  var EXPIRY_KEY = 'netpulse_cdn_expiry';

  var state = {
    hits: 0,
    misses: 0,
    lastMs: 0,
    lastError: '',
    streak: 0,
    cooledUntil: 0,
    lastBuiltAt: 0
  };

  /* Said once per page, not once per read: a device in cooldown that logged a line per module
     per minute would make the console useless for everything else. */
  var _noted = {};

  function nowMs() { return Date.now(); }

  function host() {
    return String(window.NETPULSE_CDN || '').replace(/\/+$/, '');
  }

  function readToken() {
    try {
      var token = localStorage.getItem(TOKEN_KEY);
      if (!token) return '';
      var expiry = parseInt(localStorage.getItem(EXPIRY_KEY) || '0', 10) || 0;
      if (expiry && nowMs() > expiry) {
        /* Expired here rather than discovered as a 401 at the edge: one less round trip, and the
           session it belonged to is over anyway. */
        clearToken();
        return '';
      }
      return token;
    } catch (err) {
      return ''; // storage unavailable (private mode): the edge path is simply not used
    }
  }

  function adoptToken(token, ttlMs) {
    var value = String(token || '');
    if (!value) return false;
    try {
      localStorage.setItem(TOKEN_KEY, value);
      localStorage.setItem(EXPIRY_KEY, String(nowMs() + (Number(ttlMs) > 0 ? Number(ttlMs) : 24 * 60 * 60 * 1000)));
      state.streak = 0;
      state.cooledUntil = 0;
      return true;
    } catch (err) {
      return false;
    }
  }

  function clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(EXPIRY_KEY);
    } catch (err) { /* nothing to do: there was nothing to clear */ }
  }

  function enabled() {
    return !!host() && !!readToken() && nowMs() > state.cooledUntil;
  }

  function dataUrl(type) { return host() + '/data/' + encodeURIComponent(type); }
  function bundleUrl() { return host() + '/data/_bundle'; }
  function metaUrl() { return host() + '/data/_meta'; }

  function noteOnce(key, message) {
    if (_noted[key]) return;
    _noted[key] = true;
    console.warn('[CDN] ' + message);
  }

  function noteMiss(type, err) {
    state.misses++;
    state.streak++;
    state.lastError = (err && err.message) ? err.message : String(err);

    if (state.streak >= COOLDOWN_AFTER && state.cooledUntil <= nowMs()) {
      state.cooledUntil = nowMs() + COOLDOWN_MS;
      noteOnce('cooldown', 'the edge answered nothing twice — reading every module from /exec for ' +
        Math.round(COOLDOWN_MS / 60000) + ' min (' + state.lastError + ')');
    }
  }

  function noteHit(ms) {
    state.hits++;
    state.lastMs = ms;
    state.streak = 0;
    state.cooledUntil = 0;
  }

  /**
   * One payload from the edge, or a rejection.
   *
   * The rejection is the contract: fetch-gate.js catches it and calls /exec, so a refusal here
   * is a slower read, never a missing one.
   *
   * @param {string} type  module type, used only for the gate's build stamp
   * @param {string} url
   * @return {Promise<*>} the parsed payload
   */
  function fetchJson(type, url) {
    var started = nowMs();
    var token = readToken();

    if (!token) return Promise.reject(new Error('no edge token'));

    var options = {
      method: 'GET',
      headers: { authorization: 'Bearer ' + token },
      /* The browser's own cache must not answer this: the copy that matters is the one at the
         edge (60 s behind the trigger), and a disk copy could be a whole session old. */
      cache: 'no-store'
    };

    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      options.signal = AbortSignal.timeout(EDGE_TIMEOUT_MS);
    }

    return fetch(url, options).then(function (res) {
      if (!res.ok) throw new Error('edge HTTP ' + res.status);

      var builtAt = Number(res.headers.get('x-netpulse-built-at') || 0) || 0;

      return res.json().then(function (data) {
        /* An envelope is not data. The worker refuses to publish one, so seeing one here means
           something else answered — a proxy error page that happened to be JSON, an older worker.
           Either way it must not reach a module: the app has shipped exactly this bug once. */
        if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
          throw new Error('edge envelope: ' + data.error);
        }

        noteHit(nowMs() - started);

        /* The age of the DATA, not of the request. A payload built four minutes ago and read now
           is exactly what the chip is for. */
        if (builtAt > 0 && window.fetchGate && typeof fetchGate.noteBuiltAt === 'function') {
          fetchGate.noteBuiltAt(type, builtAt);
          state.lastBuiltAt = builtAt;
        }

        return data;
      });
    }).catch(function (err) {
      noteMiss(type, err);
      throw err;
    });
  }

  /** The whole opening in one read: {ok, bundle, builtAt, rev, missing}. See boot-bundle.js. */
  function fetchBundle() {
    return fetchJson('_bundle', bundleUrl());
  }

  window.cdnSource = {
    enabled: enabled,
    dataUrl: dataUrl,
    bundleUrl: bundleUrl,
    metaUrl: metaUrl,
    fetchJson: fetchJson,
    fetchBundle: fetchBundle,
    adoptToken: adoptToken,
    clearToken: clearToken,
    hasToken: function () { return !!readToken(); },

    /* Introspection for the admin card and for tests. Never used to decide anything. */
    state: function () {
      return {
        host: host(),
        enabled: enabled(),
        token: readToken() ? 'yes' : 'no',
        hits: state.hits,
        misses: state.misses,
        lastMs: state.lastMs,
        lastError: state.lastError,
        lastBuiltAt: state.lastBuiltAt,
        coolDownForMs: Math.max(0, state.cooledUntil - nowMs())
      };
    },

    /* A manual "try the edge again now", for the REFRESH button and for a test. */
    reset: function () {
      state.streak = 0;
      state.cooledUntil = 0;
      _noted = {};
    },

    configure: function (opts) {
      if (opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) EDGE_TIMEOUT_MS = opts.timeoutMs;
      if (opts && typeof opts.cooldownMs === 'number' && opts.cooldownMs >= 0) COOLDOWN_MS = opts.cooldownMs;
      if (opts && typeof opts.cooldownAfter === 'number' && opts.cooldownAfter >= 0) COOLDOWN_AFTER = opts.cooldownAfter;
    }
  };
})();
