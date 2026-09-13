/* ------------------------------------------------------------------ *
   GVSI NetPulse — cache control
   ONE entry point for inspecting and clearing the caching layers.

   Five layers sit between the Google Sheet and the screen. Clearing them by
   hand used to mean five separate ad-hoc steps scattered across the code; this
   file is the single documented way to do it. See
   GVSI_NetPulse_Caching_Notes.md for what each layer is and why.

   Console usage:
     await netpulseCache.status()                  // what is held where
     netpulseCache.revalidateState()               // why a module is (not) re-fetching
     await netpulseCache.invalidateAll()           // safe clear (keeps user data)
     await netpulseCache.invalidateAll({ indexedDB: true, storage: true })
                                                   // full nuke, see warnings below

   What each layer is, and whether this can clear it:
     1. Apps Script server cache  — NOT clearable from here (no server-side auth
                                    exists to guard an endpoint). It is TTL-bound
                                    (60s/180s) so it self-heals. Don't expect it.
     2. IndexedDB snapshots       — clearable, but DESTRUCTIVE: it is 90 days of
                                    trend history, not a cache of live data.
     3. Service worker shell      — clearable.
     4. HTTP cache                — bypassed by the SW; not directly purgeable.
     5. dataCache (in memory)     — clearable, and the cheapest place to look.
 * ------------------------------------------------------------------ */

(function () {
  'use strict';

  /* Keys that must survive a storage clear, or the user is logged out and the
     app loses its theme. Mirrors the preserve list in the version guard. */
  var PRESERVE_BY_DEFAULT = [
    'theme',
    'notif_enabled',
    'fcm_token',
    'netpulse_remember',
    'netpulse_session',
    'netpulse_session_expiry'
  ];

  /* ---------------- 5. dataCache (in memory) ---------------- */

  // `dataCache` is declared with `const` in an index.html inline script that runs
  // AFTER the version guard which calls invalidateAll() — so at that moment it sits
  // in its temporal dead zone, where even `typeof dataCache` throws a
  // ReferenceError instead of returning 'undefined'. The lookup therefore has to be
  // inside a try/catch, and every access re-guarded: this code genuinely does run
  // before the app boots.
  function getDataCache() {
    try {
      return (typeof dataCache !== 'undefined' && dataCache) ? dataCache : null;
    } catch (e) {
      return null;
    }
  }

  function clearMemory() {
    var cache = getDataCache();
    if (!cache) return 'not available (app not booted yet)';
    var cleared = [];
    Object.keys(cache).forEach(function (key) {
      if (cache[key] !== undefined) {
        cache[key] = null;
        cleared.push(key);
      }
    });
    return cleared.length ? 'cleared: ' + cleared.join(', ') : 'already empty';
  }

  /* ---------------- revalidation throttle ---------------- */

  // Every module's cache-hit path paints from memory and then fires a background
  // fetch, so a visible tab is always being refreshed. The kiosk rotates through
  // all five modules every 9s and drives those same fetchers, which turned that
  // habit into a request storm on a display that never sleeps: measured 4 x 50 KB
  // `?type=olt` payloads per minute (~199 KB/min decoded, ~22 MB/day) against a
  // backend whose own poll intervals are 10-60 minutes.
  //
  // One rule replaces per-caller guesswork: a module is revalidated at most once a
  // minute, however many UI events ask for it. The kiosk's own 60s refresh still
  // lands, a tab click inside the window re-renders from memory instead, and the
  // module timers in loadInitialData() are unaffected because they pass
  // forceRefresh — which skips the cache-hit path entirely and calls
  // markRevalidated() so a cache hit right after them does not fetch again.
  var REVALIDATE_MIN_MS = 60000;
  var _revalidatedAt = {};

  /** True at most once per module per REVALIDATE_MIN_MS; marks the moment when it is. */
  function shouldRevalidate(type) {
    var now = Date.now();
    var last = _revalidatedAt[type];
    if (last !== undefined && now - last < REVALIDATE_MIN_MS) return false;
    _revalidatedAt[type] = now;
    return true;
  }

  /** Record a fetch that bypassed the throttle (a forced refresh), so the window
      starts there instead of letting a cache hit fire once more straight after. */
  function markRevalidated(type) {
    _revalidatedAt[type] = Date.now();
  }

  /** Per-module countdown, for the console and for the admin panel. */
  function revalidateState() {
    var now = Date.now();
    var out = {};
    Object.keys(_revalidatedAt).forEach(function (type) {
      var age = now - _revalidatedAt[type];
      out[type] = { msSinceLastRevalidation: age, msUntilNextAllowed: Math.max(0, REVALIDATE_MIN_MS - age) };
    });
    return out;
  }

  /* ---------------- payload size headroom ---------------- */

  // Mirrors the thresholds in code.gs: a payload up to 90 KB goes to CacheService,
  // up to 450 KB falls back to PropertiesService, and anything larger is not cached
  // at all — so every request re-reads the sheet. These must stay in step with the
  // `payloadSize <= 90000` / `<= 450000` checks there.
  var CACHE_SERVICE_LIMIT = 90000;
  var PROPERTIES_LIMIT = 450000;
  var PAYLOAD_MODULES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

  // code.gs measures JSON.stringify(resultData).length, so re-serializing the
  // parsed payload reproduces that same number without touching the backend.
  function measurePayload(value) {
    if (value === null || value === undefined) return null;
    try { return JSON.stringify(value).length; } catch (e) { return null; }
  }

  /**
   * Per-module payload size against the caching thresholds.
   * Returns { available, cacheServiceLimit, propertiesServiceLimit, modules } where
   * each module is { type, bytes, tier, severity, percentOfCacheLimit, headroomBytes }.
   * `bytes` and the derived fields are null while a module is not loaded.
   */
  function payloadHeadroom() {
    var cache = getDataCache();

    var modules = PAYLOAD_MODULES.map(function (type) {
      var bytes = cache ? measurePayload(cache[type]) : null;
      var pct = bytes === null ? null : bytes / CACHE_SERVICE_LIMIT;

      var tier, severity;
      if (bytes === null) {
        tier = 'unknown';
        severity = 'muted';
      } else if (bytes <= CACHE_SERVICE_LIMIT) {
        // Still on CacheService: 60% is "watch it", 85% is "about to move".
        tier = 'cache-service';
        severity = pct >= 0.85 ? 'danger' : (pct >= 0.6 ? 'warn' : 'ok');
      } else if (bytes <= PROPERTIES_LIMIT) {
        tier = 'properties-fallback';
        severity = 'warn';
      } else {
        tier = 'uncached';
        severity = 'danger';
      }

      return {
        type: type,
        bytes: bytes,
        tier: tier,
        severity: severity,
        percentOfCacheLimit: pct === null ? null : Math.round(pct * 1000) / 10,
        headroomBytes: bytes === null ? null : CACHE_SERVICE_LIMIT - bytes
      };
    });

    return {
      available: !!cache,
      cacheServiceLimit: CACHE_SERVICE_LIMIT,
      propertiesServiceLimit: PROPERTIES_LIMIT,
      modules: modules
    };
  }

  /* ---------------- 3. service worker + shell cache ---------------- */

  function unregisterServiceWorkers() {
    if (!('serviceWorker' in navigator)) return Promise.resolve('not supported');
    return navigator.serviceWorker.getRegistrations()
      .then(function (regs) {
        return Promise.all(regs.map(function (r) { return r.unregister(); }));
      })
      .then(function () { return 'unregistered'; })
      .catch(function (e) { return 'failed: ' + e.message; });
  }

  function clearCacheStorage() {
    if (!('caches' in window)) return Promise.resolve('not supported');
    return caches.keys()
      .then(function (keys) {
        if (!keys.length) return 'already empty';
        return Promise.all(keys.map(function (k) { return caches.delete(k); }))
          .then(function () { return 'deleted: ' + keys.join(', '); });
      })
      .catch(function (e) { return 'failed: ' + e.message; });
  }

  /* ---------------- 2. IndexedDB snapshots (DESTRUCTIVE) ---------------- */

  function clearIndexedDB() {
    if (!('indexedDB' in window)) return Promise.resolve('not supported');
    var name = (typeof DB_NAME !== 'undefined') ? DB_NAME : 'netpulse-db';

    // The app holds a live connection. An external delete is blocked by it until
    // it is released, so ask db.js to close first — otherwise the request sits
    // pending with no success/error/blocked event at all and this never returns.
    var release = (typeof closeDB === 'function')
      ? Promise.resolve(closeDB()).catch(function () {})
      : Promise.resolve();

    return release.then(function () {
      return new Promise(function (resolve) {
        var settled = false;
        var finish = function (msg) { if (!settled) { settled = true; resolve(msg); } };

        var req;
        try { req = indexedDB.deleteDatabase(name); }
        catch (e) { return finish('failed: ' + e.message); }

        req.onsuccess = function () { finish('deleted ' + name + ' (trend history lost)'); };
        req.onerror = function () { finish('failed: ' + (req.error && req.error.message)); };
        req.onblocked = function () {
          finish('blocked — another tab still has ' + name + ' open; close other tabs of the app and retry');
        };

        // Safety net: a held connection can leave the request pending with no
        // event at all. Never hang the caller.
        setTimeout(function () {
          finish('timed out — a connection is still held open (close other tabs of the app and retry)');
        }, 6000);
      });
    });
  }

  function countSnapshots() {
    if (!('indexedDB' in window)) return Promise.resolve('n/a');
    if (typeof getSnapshots === 'function') {
      return getSnapshots(9999)
        .then(function (rows) {
          if (!rows.length) return '0 snapshots';
          return rows.length + ' snapshots (' + rows[0].date + ' → ' + rows[rows.length - 1].date + ')';
        })
        .catch(function () { return 'unreadable'; });
    }
    return Promise.resolve('db.js not loaded');
  }

  /* ---------------- 4. local / session storage (DESTRUCTIVE) ---------------- */

  function clearStorage(preserve) {
    var keep = preserve || PRESERVE_BY_DEFAULT;
    var preserved = {};
    try {
      keep.forEach(function (k) {
        var v = localStorage.getItem(k);
        if (v !== null) preserved[k] = v;
      });
      localStorage.clear();
      Object.keys(preserved).forEach(function (k) { localStorage.setItem(k, preserved[k]); });
      sessionStorage.clear();
      return 'cleared (kept ' + Object.keys(preserved).length + ' keys)';
    } catch (e) {
      return 'failed: ' + e.message;
    }
  }

  /* ---------------- inspection ---------------- */

  function status() {
    var memory = {};
    var cacheRef = getDataCache();
    if (cacheRef) {
      Object.keys(cacheRef).forEach(function (k) {
        var v = cacheRef[k];
        memory[k] = v === null || v === undefined
          ? 'empty'
          : (Array.isArray(v) ? v.length + ' rows' : 'object');
      });
    }

    var shell = 'n/a';
    var shellPromise = ('caches' in window)
      ? caches.keys().then(function (names) {
          return Promise.all(names.map(function (n) {
            return caches.open(n).then(function (c) { return c.keys(); })
              .then(function (ks) { return n + ' (' + ks.length + ' entries)'; });
          })).then(function (list) { return list.length ? list.join(', ') : 'empty'; });
        })
      : Promise.resolve('not supported');

    var swPromise = ('serviceWorker' in navigator)
      ? navigator.serviceWorker.getRegistrations().then(function (r) { return r.length + ' registration(s)'; })
      : Promise.resolve('not supported');

    var storageKeys = [];
    try { storageKeys = Object.keys(localStorage); } catch (e) {}

    return shellPromise.then(function (shellInfo) {
      return swPromise.then(function (swInfo) {
        return countSnapshots().then(function (idbInfo) {
          return {
            '1. Apps Script server cache': 'ttl-bound (60s olt/node/backbone, 180s nap/lcp) — not client-clearable',
            '2. IndexedDB snapshots': idbInfo,
            '3. Service worker': swInfo,
            '3. Shell cache': shellInfo,
            '4. HTTP cache': 'bypassed by the SW (cache: no-cache on revalidate)',
            '5. dataCache': memory
          };
        });
      });
    });
  }

  /* ---------------- the single entry point ---------------- */

  function invalidateAll(options) {
    var opts = options || {};

    // The two destructive layers are opt-in. Clearing IndexedDB throws away 90
    // days of trend history, and clearing storage logs the user out — neither
    // should happen just because someone asked for "a cache clear".
    var report = {};
    report['5. dataCache'] = clearMemory();

    return (opts.serviceWorker ? unregisterServiceWorkers() : Promise.resolve('skipped (pass serviceWorker: true)'))
      .then(function (r) { report['3. service worker'] = r; return clearCacheStorage(); })
      .then(function (r) { report['3. shell cache'] = r;
        return opts.indexedDB ? clearIndexedDB() : Promise.resolve('skipped (destructive — pass indexedDB: true)'); })
      .then(function (r) { report['2. IndexedDB'] = r;
        return opts.storage ? clearStorage(opts.preserve) : Promise.resolve('skipped (destructive — pass storage: true)'); })
      .then(function (r) {
        report.storage = r;
        report['1. Apps Script server cache'] = 'not clearable from the client (no server auth); self-expires in <=180s';
        report['4. HTTP cache'] = 'bypassed on next load';
        if (opts.reload) {
          report.action = 'reloading…';
          setTimeout(function () { location.reload(); }, 250);
        }
        return report;
      });
  }

  // The modules are plain classic scripts and call these two directly; they are on
  // window for that reason, not as a public API.
  window.shouldRevalidate = shouldRevalidate;
  window.markRevalidated = markRevalidated;

  window.netpulseCache = {
    // One call. Safe by default; add the destructive layers explicitly.
    invalidateAll: invalidateAll,
    // Why a fetch did or did not happen: per-module throttling countdown.
    revalidateState: revalidateState,
    shouldRevalidate: shouldRevalidate,
    markRevalidated: markRevalidated,
    // Nothing held anywhere.
    clearEverything: function () {
      return invalidateAll({ serviceWorker: true, indexedDB: true, storage: true, reload: true });
    },
    // What is cached, where. Use this to find the stale layer before clearing.
    status: status,
    // How close each module's payload is to the caching thresholds.
    payloadHeadroom: payloadHeadroom,
    // Individual layers, for when you only want one.
    clearMemory: clearMemory,
    clearShellCache: clearCacheStorage,
    clearIndexedDB: clearIndexedDB,
    // Release the app's live IDB connection without deleting anything.
    closeIndexedDB: function () {
      return (typeof closeDB === 'function') ? closeDB() : Promise.resolve('db.js not loaded');
    },
    clearStorage: clearStorage,
    unregisterServiceWorkers: unregisterServiceWorkers
  };
})();
