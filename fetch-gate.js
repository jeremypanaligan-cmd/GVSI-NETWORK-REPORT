// ====================== FETCH GATE ======================
// Shared per-module-type request gate.
//
// Solves the "duplicated fetch" problem at the single point every data path
// crosses. Two rules:
//
//   1. DEDUPE — one network round-trip per module type at a time. Any caller
//      (tab click, prefetch, analytics) that arrives while a
//      fetch for that type is in flight joins it instead of stacking a
//      duplicate request on the Apps Script echo endpoint.
//   2. THROTTLE — background refetches (the cached-path refresh modules fire
//      on tab switches) run at most once per
//      minIntervalMs per type. A refetch inside the window is deferred to the
//      end of the window instead of dropped, so freshness is delayed, never
//      lost.
//
// Foreground fetches (first load, force refresh) go through run(): unthrottled,
// throws on failure so the module's own error UI keeps working. Background
// fetches go through fetchQueued(): never rejects — resolves null on failure,
// exactly matching the old `.catch(() => {})` callers.
//
// Requires the page's fetchWithRetry() (index.html) — resolved at call time.

(function () {
  'use strict';

  var MIN_INTERVAL_MS = 60000; // one successful background fetch per type per minute
  /* Hard ceiling per request cycle. This has to cover the retry budget that
     fetchWithRetry() spends INSIDE the request it is given (index.html: 3 attempts
     with jittered backoff), because the gate dedupes per type and therefore counts
     all three attempts as one cycle. Warm build ~1.3 s, cold ~4 s: the worst case
     that still fits is roughly 4 s + 1 s + 4 s + 2 s + 4 s. An origin that cannot
     answer inside this is below the retry budget entirely, and the gate times out
     rather than holding the type busy — its promise is left to settle on its own. */
  var TIMEOUT_MS = 30000;

  var inflight = {};    // type -> raw fetch promise (rejects on failure)
  var lastFetchAt = {}; // type -> timestamp of last successful fetch (any path)
  var deferred = {};    // type -> timer handle of a throttled background refetch

  function nowMs() {
    return Date.now();
  }

  /* One place stamps success, so the ticker and the throttle always agree. */
  function stampSuccess(type) {
    lastFetchAt[type] = nowMs();
    tickerClearDeferred(type);
  }

  /* Rejects if the underlying fetch outlives TIMEOUT_MS, so a hung request can
     never wedge a module's loading state forever. */
  function withTimeout(promise, type) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('[FetchGate] timeout after ' + TIMEOUT_MS + 'ms: ' + type));
      }, TIMEOUT_MS);
      promise.then(
        function (value) { clearTimeout(timer); resolve(value); },
        function (error) { clearTimeout(timer); reject(error); }
      );
    });
  }

  function clearDeferred(type) {
    if (deferred[type]) {
      clearTimeout(deferred[type]);
      deferred[type] = null;
    }
    tickerClearDeferred(type);
  }

  function start(type, url) {
    var p = withTimeout(fetchWithRetry(url), type);
    inflight[type] = p;
    return p;
  }

  /* Detaches the bookkeeping handle once the promise settles, so the next
     caller starts a fresh request. */
  function settle(type, p) {
    return p.finally(function () {
      if (inflight[type] === p) delete inflight[type];
    });
  }

  /* Foreground path: dedupe only, no throttle. Rejects on failure. */
  function run(type, url) {
    if (inflight[type]) return inflight[type];
    clearDeferred(type); // a foreground fetch supersedes any pending background one

    var p = start(type, url);
    return settle(type, p).then(function (data) {
      stampSuccess(type);
      return data;
    });
    // rejection propagates untouched — callers keep their existing error UI
  }

  /* Background path: joins in-flight, throttled, never rejects. */
  function fetchQueued(type, url, apply) {
    if (inflight[type]) {
      // Join the same round-trip; the starter of the request owns its own
      // success handling, we only mirror it to this caller.
      return inflight[type].then(
        function (data) { if (apply) apply(data); return data; },
        function () { return null; }
      );
    }

    var since = nowMs() - (lastFetchAt[type] || 0);
    if (since < MIN_INTERVAL_MS) {
      scheduleDeferred(type, url, apply, MIN_INTERVAL_MS - since);
      return Promise.resolve(null);
    }

    return startQueued(type, url, apply);
  }

  function startQueued(type, url, apply) {
    var p = start(type, url);
    return settle(type, p).then(
      function (data) {
        stampSuccess(type);
        if (apply) apply(data);
        return data;
      },
      function () { return null; } // silent failure — same as the old `.catch(() => {})`
    );
  }

  function scheduleDeferred(type, url, apply, delay) {
    clearDeferred(type);
    tickerNoteDeferred(type, nowMs() + delay); // chip counts down to the refetch
    deferred[type] = setTimeout(function () {
      deferred[type] = null;
      tickerClearDeferred(type); // firing — a success will re-stamp the clock
      if (inflight[type]) return; // something newer took over the type
      startQueued(type, url, apply);
    }, delay);
  }

  /* ------------------------------------------------------------------ *
     Refresh ticker — per-module "Updated Xs ago / Refreshing in Ys" chip.
     State lives here (single source of truth); the chip element is
     recreated after every render, so modules just call
     fetchGate.refreshTicker(type) whenever their tab repaints.
     Self-healing by design: innerHTML wipes, re-renders and first loads
     all converge to exactly one chip per tab.
   * ------------------------------------------------------------------ */

  var TICKER_UPDATE_MS = 1000;
  var _tickerTimers = {};   /* type -> interval handle driving the countdown */
  var _tickerDeferred = {}; /* type -> timestamp when the deferred refetch fires */

  /* How old the DATA shown may get before the chip says so. Two warm intervals
     (see olt-cache-warmer.gs): late enough that a normal cycle never trips it,
     early enough to name a real problem — a missed trigger, a failed rebuild,
     or a revision the app was never told about. */
  var STALE_AFTER_MS = 10 * 60 * 1000;

  /* When the payload a module is showing was BUILT on the server, if the server
     said. Deliberately separate from lastFetchAt, which is when we ASKED: those
     two were the same thing only while every answer was a fresh build, and the
     11-minute incident on 2026-09-18 was eleven minutes of them being different
     while the chip reported the fetch. */
  var dataBuiltAt = {};

  function noteBuiltAt(type, ms) {
    var n = Number(ms);
    if (isFinite(n) && n > 0) dataBuiltAt[type] = n;
  }

  function tickerNoteDeferred(type, atMs) { _tickerDeferred[type] = atMs; }
  function tickerClearDeferred(type) { delete _tickerDeferred[type]; }

  function tickerState(type) {
    if (_tickerDeferred[type]) return 'deferred';
    var built = dataBuiltAt[type];
    if (built && (nowMs() - built) > STALE_AFTER_MS) return 'stale';
    return 'ok';
  }

  /* Wall clock, HH:MM. Minutes stop being useful exactly when staleness starts
     to matter — "Data as of 09:12" is actionable where "Data 41m ago" needs
     arithmetic — and the string still only changes once a minute, so the
     zero-write discipline in paintTicker is unaffected. */
  function clockLabel_(ms) {
    var d = new Date(ms);
    var hh = d.getHours(), mm = d.getMinutes();
    return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function ageText_(ms) {
    var sec = Math.max(0, Math.round((nowMs() - ms) / 1000));
    if (sec < 5) return 'just now';
    if (sec < 60) return sec + 's ago';
    return Math.round(sec / 60) + 'm ago';
  }

  function tickerText(type) {
    var at = _tickerDeferred[type];
    if (at) {
      var inSec = Math.max(1, Math.round((at - nowMs()) / 1000));
      return 'Refreshing in ' + inSec + 's';
    }

    /* Preferred form: the age of the DATA rather than of the request. The server
       stamps its payload (meta.builtAt), and because the stamp rides inside the
       cached bytes, a cache HIT reports the original build time — so this stays
       true through any number of refreshes, which is the whole point. */
    var built = dataBuiltAt[type];
    if (built) return 'Data as of ' + clockLabel_(built) + ' · ' + ageText_(built);

    /* No stamp (an older server, or a module that does not carry one): fall back
       to the fetch time, which is what this chip always reported. That is the
       weaker claim — "we asked recently" is not "what you see is recent" — and
       it is exactly how a deleted ticket sat on screen with a fresh-looking chip
       under it, so prefer the stamp wherever it exists. */
    var last = lastFetchAt[type] || 0;
    if (!last) return 'No data yet';
    var agoSec = Math.max(0, Math.round((nowMs() - last) / 1000));
    if (agoSec < 5) return 'Updated just now';
    /* Seconds only through the first minute, then minutes. The old boundary was
       an hour, so a tab left open long enough showed "Updated 2712s ago" —
       awkward to read, and (see paintTicker) a string that changed on every
       single tick. Freshness stays second-precise where it is actually read,
       right after a refresh, and stops ticking where it isn't. */
    if (agoSec < 60) return 'Updated ' + agoSec + 's ago';
    return 'Updated ' + Math.round(agoSec / 60) + 'm ago';
  }

  function paintTicker(type, chip) {
    /* Skip each write when the value has not changed.

       Measured in Chrome: setAttribute() with an identical value is NOT
       short-circuited — six calls, six attribute mutations. That was the real
       cost here, firing once a second per module for as long as its tab lived.
       (A same-value textContent assignment is already free in Blink, but
       firstChild.data = x is not, so the text guard is cheap insurance rather
       than the fix.)

       data-state only changes when a deferral starts or ends. Combined with the
       minute-granularity text above, a steady-state paint now builds two strings
       and touches nothing — measured 8 mutations over 5 ticks before, 1 after
       (and that one is a genuine minute rollover). */
    var text = tickerText(type);
    if (chip.textContent !== text) chip.textContent = text;

    var state = tickerState(type);
    if (chip.getAttribute('data-state') !== state) chip.setAttribute('data-state', state);
  }

  /* Called after every module render: restores the chip if the tab's HTML
     was wiped, paints current text, and keeps a 1s countdown running. */
  function refreshTicker(type) {
    var tab = document.getElementById('tab-' + type);
    if (!tab) return;

    var chip = tab.querySelector('.module-refresh-ticker');
    if (!chip) {
      var row = tab.querySelector('.page-title-row');
      if (!row) return; /* tab has not rendered its shell yet */
      chip = document.createElement('span');
      chip.className = 'module-refresh-ticker';
      row.appendChild(chip);
    }

    paintTicker(type, chip);

    if (!_tickerTimers[type]) {
      _tickerTimers[type] = setInterval(function () {
        var t = document.getElementById('tab-' + type);
        if (!t) { clearInterval(_tickerTimers[type]); delete _tickerTimers[type]; return; }
        var el = t.querySelector('.module-refresh-ticker');
        if (!el) return; /* mid re-render — the next refreshTicker() call repaints */
        paintTicker(type, el);
      }, TICKER_UPDATE_MS);
    }
  }

  window.fetchGate = {
    run: run,
    fetchQueued: fetchQueued,
    refreshTicker: refreshTicker,

    /* Server build time for the payload a module is showing. Modules call this
       with meta.builtAt from the response they just rendered. */
    noteBuiltAt: noteBuiltAt,

    /* Introspection / tuning */
    isBusy: function (type) { return !!inflight[type]; },
    lastFetch: function (type) { return lastFetchAt[type] || 0; },
    dataBuiltAt: function (type) { return dataBuiltAt[type] || 0; },
    shouldDefer: function (type) {
      return (nowMs() - (lastFetchAt[type] || 0)) < MIN_INTERVAL_MS;
    },
    configure: function (opts) {
      if (opts && typeof opts.minIntervalMs === 'number' && opts.minIntervalMs >= 0) {
        MIN_INTERVAL_MS = opts.minIntervalMs;
      }
      if (opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
        TIMEOUT_MS = opts.timeoutMs;
      }
      if (opts && typeof opts.staleAfterMs === 'number' && opts.staleAfterMs > 0) {
        STALE_AFTER_MS = opts.staleAfterMs;
      }
    }
  };
})();
