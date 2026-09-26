// ====================== MODULE CACHE STORE ======================
/* The last good payload of each module, kept in `localStorage` for the NEXT cold start.
 *
 * WHY THIS EXISTS. On every cold start the app begins with an empty `dataCache`, so the first
 * render waits on the network — and when the deployment is stalled (measured at 7.5 s, 16.0 s and
 * 30.8 s, PART-024) the wait ends in a failure with nothing to fall back on. PART-025 already
 * fixed the second half of that: a FAILED read keeps the screen it has. But a tab that has never
 * drawn anything still has nothing to keep, so the first load of a session could only say "this
 * report could not be loaded". This file is what that tab draws instead.
 *
 * WHY localStorage AND NOT IndexedDB. `getItem` is SYNCHRONOUS, so the payloads are in memory
 * before the first paint with no await and no frame delay. Measured payloads are ~3.9 KB in
 * total (nap 718 B, lcp 488 B, node 2 B, backbone 2,080 B, olt 643 B), against a ~5 MB budget.
 * Reaching for IndexedDB here would trade a synchronous read for an asynchronous one and make
 * the paint LATER, which is the whole thing being fixed.
 *
 * WHAT IS STORED is the POST-DECODE state — exactly what each module reads, not the bytes the
 * server sent. `dataCache[type]` for all five, plus `oltMeta` with the OLT rows, because OLT is
 * the one module whose rows and totals come from different places: `olt-module.js` reads the
 * table from the array and the cards from the meta, so persisting the rows alone would restore a
 * snapshot whose cards silently disagree with the list under them. An OLT payload whose meta did
 * not come with it is therefore NOT written and NOT restored.
 *
 * HOW OLD IT MAY BE is per type, in one table below, and it mirrors the interval the app already
 * refreshes that module on. A restored screen is thus never older than the age at which the app
 * would have replaced it anyway, and a payload that ages out across several sessions is dropped
 * on the next read instead of being drawn.
 *
 * IT FAILS OPEN, ALWAYS. Private mode, a disabled store, a quota error and a corrupt value are
 * all the same answer: behave exactly as this file did not exist. Nothing here may ever throw
 * into the load path, because the one thing a cache may not do is break the app it accelerates.
 *
 * Loaded after `fetch-gate.js` (it seeds that gate's clock) and before the page script, which
 * calls restoreModuleCache() at the top of loadInitialData().
 */
(function () {
  'use strict';

  /* The storage key carries the schema version, and so does the value inside it: a key is the
     only thing a future release can rename cheaply, but a value that says nothing about its own
     shape is what makes an old snapshot parse as a new one. Both, because they fail differently. */
  var KEY = 'netpulse_datacache_v1';
  var CACHE_STORE_VERSION = 1;

  /* How old a payload may be and still be painted before the network answers. Each number mirrors
     the interval `loadInitialData()` refreshes that module on, so this is a freshness rule the
     app already had — written down. One table, because this is the single number the NOC would
     change if it wanted stricter. */
  var DATA_CACHE_MAX_AGE_MS = {
    nap: 60 * 60 * 1000,
    lcp: 30 * 60 * 1000,
    olt: 15 * 60 * 1000,
    node: 10 * 60 * 1000,
    backbone: 10 * 60 * 1000
  };

  var TYPES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

  /* A snapshot every 30 s, plus the two events that actually precede a page going away. The
     interval is what makes this need NO call-site edits: a copy that is 30 s stale is irrelevant
     to the next page load, so there is no reason to write at each of the ~14 places a payload
     lands. */
  var WRITE_EVERY_MS = 30 * 1000;

  function nowMs() {
    return Date.now();
  }

  function storage_() {
    try {
      return (typeof localStorage !== 'undefined' && localStorage) ? localStorage : null;
    } catch (e) {
      return null; // Safari private mode throws on the accessor itself
    }
  }

  function isPositive_(n) {
    return typeof n === 'number' && isFinite(n) && n > 0;
  }

  function isObject_(v) {
    return !!v && typeof v === 'object';
  }

  /* `entries` is type -> { at, data, meta? }. Only what a module reads goes in, so
     JSON.stringify IS the encoder: every payload arrives from the API as JSON already. */
  function serializeModuleCache(entries) {
    var types = {};
    TYPES.forEach(function (type) {
      var entry = entries && entries[type];
      if (!isObject_(entry)) return;
      /* No honest age, no entry. A payload whose fetch time nobody recorded cannot be judged
         later, and `now` would claim it is fresher than it is. */
      if (!isPositive_(entry.at)) return;
      if (entry.data === undefined || entry.data === null) return;
      var out = { at: entry.at, data: entry.data };
      if (type === 'olt') {
        /* Rows without their meta are the mismatch described in the header. Refused here so the
           store never contains one. */
        if (!isObject_(entry.meta)) return;
        out.meta = entry.meta;
      }
      types[type] = out;
    });
    return JSON.stringify({ v: CACHE_STORE_VERSION, types: types });
  }

  /* Judges EVERY type separately and drops only what has expired, so one stale module cannot cost
     the four that are still useable. Returns {} for anything unusable — never a throw. */
  function parseModuleCache(raw, now) {
    var empty = {};
    if (!raw || typeof raw !== 'string') return empty;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return empty;
    }
    /* A schema move is a discard, not a migration: a snapshot is worth at most one paint, and a
       half-read old one is worth less than none. */
    if (!isObject_(parsed) || parsed.v !== CACHE_STORE_VERSION) return empty;
    if (!isObject_(parsed.types)) return empty;

    var t = isPositive_(now) ? now : nowMs();
    var out = {};
    TYPES.forEach(function (type) {
      var entry = parsed.types[type];
      if (!isObject_(entry)) return;
      if (!isPositive_(entry.at)) return;
      var age = t - entry.at;
      /* A STAMP IN THE FUTURE IS NOT FRESH DATA. A clock that moved backwards, or a stamp written
         by a device whose clock runs ahead, would read as a negative age and never expire — the
         opposite of the guard this is. Unusable rather than infinitely new. */
      if (age < 0) return;
      if (age > DATA_CACHE_MAX_AGE_MS[type]) return;
      if (entry.data === undefined || entry.data === null) return;
      var kept = { at: entry.at, data: entry.data };
      if (type === 'olt') {
        if (!isObject_(entry.meta)) return;
        kept.meta = entry.meta;
      }
      out[type] = kept;
    });
    return out;
  }

  function readModuleCache(now) {
    var s = storage_();
    if (!s) return {};
    var raw;
    try {
      raw = s.getItem(KEY);
    } catch (e) {
      return {};
    }
    return parseModuleCache(raw, now);
  }

  function writeModuleCache(entries) {
    var s = storage_();
    if (!s) return false;
    try {
      s.setItem(KEY, serializeModuleCache(entries));
      return true;
    } catch (e) {
      return false; // quota, private mode, a store switched off mid-session
    }
  }

  function clearModuleCache() {
    var s = storage_();
    if (!s) return;
    try {
      s.removeItem(KEY);
    } catch (e) { /* nothing to do, and never worth throwing over */ }
  }

  /* Snapshot what the page is holding. The stamps come from the gate, which is the ONE place a
     successful fetch is recorded, and a type with no stamp is left out rather than stamped with
     `now` — see serializeModuleCache. */
  function collectModuleCache_() {
    var entries = {};
    if (typeof dataCache === 'undefined' || !dataCache) return entries;

    var gate = (typeof fetchGate !== 'undefined' && fetchGate) ? fetchGate : null;
    TYPES.forEach(function (type) {
      var payload = dataCache[type];
      if (!payload) return; // null (never fetched) or [] (a real empty answer for node/backbone)
      var at = (gate && typeof gate.lastFetch === 'function') ? gate.lastFetch(type) : 0;
      var entry = { at: at, data: payload };
      if (type === 'olt') {
        if (typeof oltMeta === 'undefined' || !oltMeta) return;
        entry.meta = oltMeta;
      }
      entries[type] = entry;
    });
    return entries;
  }

  /* A TYPE THE PAGE IS NOT HOLDING IS CARRIED OVER, not dropped.

     This runs on a timer, and every refresh empties `dataCache[type]` BEFORE it asks — so a
     snapshot that lands in that window would otherwise write the modules it has and silently
     delete this one's only copy, which is the copy the next cold start needs. It is worst
     exactly when it matters: the read that just failed never put a payload back, so a store
     that replaces wholesale loses a good snapshot because a refresh did not answer.

     A carried-over entry keeps its own `at`, so it goes on ageing and expires by the same cap as
     anything else — it is not re-stamped as new, and this cannot make a payload immortal. */
  function persistModuleCache() {
    var entries = collectModuleCache_();
    var stored = readModuleCache(nowMs());
    TYPES.forEach(function (type) {
      if (entries[type]) return;
      if (stored[type]) entries[type] = stored[type];
    });
    /* Nothing held and nothing worth carrying: leave storage exactly as it is rather than write
       an empty snapshot over whatever is there. */
    if (!Object.keys(entries).length) return false;
    return writeModuleCache(entries);
  }

  /* Put the last session's payloads back where the modules read them, and tell the gate WHEN each
     one was fetched. Returns the types restored, which is what the caller needs to know to paint
     the visible tab before it asks the network for anything. */
  function restoreModuleCache() {
    var restored = [];
    if (typeof dataCache === 'undefined' || !dataCache) return restored;
    var entries = readModuleCache(nowMs());
    var gate = (typeof fetchGate !== 'undefined' && fetchGate) ? fetchGate : null;

    TYPES.forEach(function (type) {
      var entry = entries[type];
      if (!entry) return;

      if (type === 'olt') {
        /* All three, or none: the rows, the array the renderer actually walks (`rawOltData`), and
           the meta the cards read. OLT's cache-first path re-renders from `dataCache.olt` WITHOUT
           restoring meta, so a partial restore here silently falls through to the compute-from-rows
           fallback and the totals stop matching the list. */
        if (typeof rawOltData === 'undefined' || typeof oltMeta === 'undefined') return;
        dataCache.olt = entry.data;
        rawOltData = entry.data;
        oltMeta = entry.meta;
        /* The server's own build time rides inside the payload it sent, and OLT is the one module
           that carries it — so the chip can report the age of the DATA rather than of the fetch,
           which is the stronger claim and the one applyOltPayload() makes for the same payload. */
        var builtAt = entry.meta && entry.meta.builtAt;
        if (gate && isPositive_(builtAt) && typeof gate.noteBuiltAt === 'function') gate.noteBuiltAt('olt', builtAt);
      } else {
        dataCache[type] = entry.data;
      }

      /* Without this the restored table draws its freshness chip on an empty clock and reads
         "No data yet" while showing rows — the same lie as stamping it `now`, in the other
         direction. It is also what keeps the age GROWING across sessions instead of resetting. */
      if (gate && typeof gate.seedLastFetch === 'function') gate.seedLastFetch(type, entry.at);
      restored.push(type);
    });

    return restored;
  }

  /* The writer's clock, and the two events that come before a page goes away. `pagehide` is what
     a phone being closed fires; `visibilitychange` to hidden covers the tab that is backgrounded
     and then killed by the OS without one. */
  function startModuleCache() {
    if (typeof setInterval !== 'function') return null;
    var timer = setInterval(function () { persistModuleCache(); }, WRITE_EVERY_MS);
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', function () { persistModuleCache(); });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') persistModuleCache();
      });
    }
    return timer;
  }

  window.moduleCache = {
    KEY: KEY,
    VERSION: CACHE_STORE_VERSION,
    MAX_AGE_MS: DATA_CACHE_MAX_AGE_MS,
    types: TYPES,
    serializeModuleCache: serializeModuleCache,
    parseModuleCache: parseModuleCache,
    readModuleCache: readModuleCache,
    writeModuleCache: writeModuleCache,
    persistModuleCache: persistModuleCache,
    restoreModuleCache: restoreModuleCache,
    clearModuleCache: clearModuleCache,
    start: startModuleCache
  };
})();
