/* ------------------------------------------------------------------ *
   GVSI NetPulse — cache control
   ONE entry point for inspecting and clearing the caching layers.

   Six layers sit between the Google Sheet and the screen. Clearing them by
   hand used to mean six separate ad-hoc steps scattered across the code; this
   file is the single documented way to do it. See
   GVSI_NetPulse_Caching_Notes.md for what each layer is and why.

   Console usage:
     await netpulseCache.status()                  // what is held where
     netpulseCache.revalidateState()               // why a module is (not) re-fetching
     netpulseCache.lastGood()                      // what a failure would fall back to
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
     6. Last known good           — clearable, and safe to clear: it holds one
                                    payload per module, kept only so a screen can
                                    show something honest while the API is down.
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

  /* ---------------- 6. last known good (localStorage) ---------------- */

  // NOT a cache of live data: one payload per module, written only so a failed fetch
  // can show the last known numbers with a banner saying how old they are (see
  // last-good.js). Safe to clear — the only cost is that a failure straight after has
  // nothing to fall back to, and the module will say so instead of inventing calm.
  function lastGood() {
    if (!window.netpulseLastGood) return 'last-good.js not loaded';
    return window.netpulseLastGood.report();
  }

  function clearLastGood() {
    if (!window.netpulseLastGood) return 'last-good.js not loaded';
    return window.netpulseLastGood.clearAll();
  }

  function lastGoodSummary() {
    if (!window.netpulseLastGood) return 'last-good.js not loaded';
    var reps = window.netpulseLastGood.report();
    var kept = [], stale = [];
    Object.keys(reps).forEach(function (type) {
      if (reps[type].remembered) kept.push(type);
      if (reps[type].showing === 'stale') stale.push(type);
    });
    return {
      remembering: kept.length ? kept.join(', ') : 'nothing yet',
      showingStale: stale.length ? stale.join(', ') : 'none'
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

  /* ---------------- 2b. Individual trend records (targeted, not destructive) ---- */

  // clearIndexedDB() above is the wrong tool for one bad day: it costs all 90 days
  // to fix one. These two work on single records, and they earn their place because
  // a snapshot can never be repaired in place — saveDailySnapshot() keeps the FIRST
  // record of each day, so a day written from an incomplete pass stays wrong until
  // its record is removed. See auditSnapshots() in db.js for what "incomplete" means.

  function auditTrendHistory() {
    if (typeof getSnapshots !== 'function' || typeof auditSnapshots !== 'function') {
      return Promise.resolve('db.js not loaded');
    }
    return getSnapshots(9999)
      .then(function (rows) {
        var all = auditSnapshots(rows);
        if (!all.length) return 'no snapshots';

        var bad = all.filter(function (r) { return r.suspect; });
        if (!bad.length) return all.length + ' snapshots, none look incomplete';

        return bad.length + ' of ' + all.length + ' look incomplete:\n' +
          bad.map(function (r) {
            return '  ' + r.date + ' — olt ' + r.oltTotal + ' against nap ' + r.napTotal +
                   ' (lcp ' + r.lcpTotal + ', backbone ' + r.bbTickets + ')';
          }).join('\n') +
          '\nRepair one with: netpulseCache.rebuildTrendDay("YYYY-MM-DD")';
      })
      .catch(function () { return 'unreadable'; });
  }

  // Rewrites TODAY's record from whatever is loaded right now, so only useful on a
  // boot that completed — otherwise the completeness guard skips it and the day is
  // left empty on purpose.
  function rebuildTrendDay(date) {
    if (typeof rebuildSnapshot !== 'function') return Promise.resolve('db.js not loaded');

    var today = new Date().toISOString().slice(0, 10);
    var target = date || today;

    return rebuildSnapshot(target)
      .then(function (r) {
        if (r.reason === 'past-day') {
          return r.date + ' is not today (' + today + '). A past day cannot be rebuilt: the\n' +
                 'snapshot is built from the live caches, which hold now, so rewriting it would\n' +
                 'replace that day with today\'s numbers. Either leave it, or drop it with\n' +
                 'netpulseCache.dropTrendDay("' + r.date + '") — a gap is more honest than a false zero.';
        }
        // All four combinations are spelled out, because "nothing to repair" and
        // "nothing was rewritten" are very different outcomes and a message that
        // conflates them reads as success when the day is still wrong.
        if (r.rewritten) {
          return r.deleted
            ? r.date + ': removed ' + r.deleted + ' and rewrote it from the loaded data'
            : r.date + ': no record was stored (nothing to remove); wrote one from the loaded data';
        }
        if (r.deleted) {
          return r.date + ': removed ' + r.deleted + ', but NOT rewritten — a module is still\n' +
                 'not loaded, so the guard skipped it and the day is now an honest gap.\n' +
                 'Reload, wait for all five modules, and run it again.';
        }
        return r.date + ': nothing removed and nothing written — a module is still not loaded';
      })
      .catch(function (e) { return 'failed: ' + e.message; });
  }

  // Remove a record without pretending to replace it. This is the ONLY thing that can
  // honestly be done to a past day, and the result is a gap in the trend line — which
  // is strictly better than a zero that reads as "the network was fine".
  function dropTrendDay(date) {
    if (typeof deleteSnapshots !== 'function') return Promise.resolve('db.js not loaded');
    if (!date) return Promise.resolve('pass a date: netpulseCache.dropTrendDay("2026-08-25")');

    return deleteSnapshots(date)
      .then(function (n) {
        if (!n) return date + ': no record stored';
        return date + ': removed ' + n + ' — the trend line now has a gap there instead of a zero';
      })
      .catch(function (e) { return 'failed: ' + e.message; });
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
            '5. dataCache': memory,
            '6. Last known good': lastGoodSummary()
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
    // Not destructive: a fallback payload is not user data. Cleared here so that
    // "invalidate everything" really does leave the next failure with nothing stale
    // to show — the version guard relies on that after a release.
    report['6. Last known good'] = clearLastGood();

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
    // What each module would fall back to if the API went away right now.
    lastGood: lastGood,
    clearLastGood: clearLastGood,
    // How close each module's payload is to the caching thresholds.
    payloadHeadroom: payloadHeadroom,
    // Individual layers, for when you only want one.
    clearMemory: clearMemory,
    clearShellCache: clearCacheStorage,
    clearIndexedDB: clearIndexedDB,
    // Individual trend records: audit first, then repair today or drop a past day.
    auditTrendHistory: auditTrendHistory,
    rebuildTrendDay: rebuildTrendDay,
    dropTrendDay: dropTrendDay,
    // Release the app's live IDB connection without deleting anything.
    closeIndexedDB: function () {
      return (typeof closeDB === 'function') ? closeDB() : Promise.resolve('db.js not loaded');
    },
    clearStorage: clearStorage,
    unregisterServiceWorkers: unregisterServiceWorkers
  };
})();
