// ====================== FETCH GATE ======================
// Shared per-module-type request gate.
//
// Solves the "duplicated fetch" problem at the single point every data path
// crosses. Two rules:
//
//   1. DEDUPE — one network round-trip per module type at a time. Any caller
//      (tab click, kiosk rotation, prefetch, analytics) that arrives while a
//      fetch for that type is in flight joins it instead of stacking a
//      duplicate request on the Apps Script echo endpoint.
//   2. THROTTLE — background refetches (the cached-path refresh modules fire
//      on tab switches and kiosk slide changes) run at most once per
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
  var TIMEOUT_MS = 30000;      // hard ceiling per request cycle — proxy handles retries server-side

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

  function tickerNoteDeferred(type, atMs) { _tickerDeferred[type] = atMs; }
  function tickerClearDeferred(type) { delete _tickerDeferred[type]; }

  function tickerState(type) {
    return _tickerDeferred[type] ? 'deferred' : 'ok';
  }

  function tickerText(type) {
    var at = _tickerDeferred[type];
    if (at) {
      var inSec = Math.max(1, Math.round((at - nowMs()) / 1000));
      return 'Refreshing in ' + inSec + 's';
    }
    var last = lastFetchAt[type] || 0;
    if (!last) return 'No data yet';
    var agoSec = Math.max(0, Math.round((nowMs() - last) / 1000));
    if (agoSec < 5) return 'Updated just now';
    if (agoSec < 3600) return 'Updated ' + agoSec + 's ago';
    return 'Updated ' + Math.round(agoSec / 60) + 'm ago';
  }

  function paintTicker(type, chip) {
    chip.textContent = tickerText(type);
    chip.setAttribute('data-state', tickerState(type));
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

    /* Introspection / tuning */
    isBusy: function (type) { return !!inflight[type]; },
    lastFetch: function (type) { return lastFetchAt[type] || 0; },
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
    }
  };
})();
