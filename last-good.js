/* ------------------------------------------------------------------ *
   GVSI NetPulse — last known good

   The SIXTH caching layer, and the only one whose job is honesty rather than speed:
   what belongs on the screen when the API cannot be reached at all.

   Before this, a failed fetch left a hole. NAP wrote "Error loading data." into its
   table, LCP and OLT wrote nothing, and — worse than either — NODE and BACKBONE fell
   through to their EMPTY states: "All Node Systems Operational" and a row of zero
   cards. On a 24/7 wall display those are the three ways a screen can mislead:
   a hole, a lie, and a blank that reads as "no outages".

   So every successful payload is remembered per module, and a failed fetch degrades to
   the last known values **with a banner that says so and says since when**. Nothing is
   invented: a module with nothing remembered keeps an honest "could not be reached"
   state instead of inventing calm.

   Storage is two keys per module, on purpose:
     netpulse_lastgood_<type>     the payload — written only when the payload CHANGES
     netpulse_lastgood_<type>_at  when the API last answered — a few bytes, every time
   Splitting them keeps the big write off the hot path (a 50 KB OLT payload re-written
   every minute would be ~26 GB/year of writes on a display that never sleeps) while the
   timestamp stays exact, which is the part the banner depends on.

   This is NOT the dataCache and not the trend history: it is one payload per module,
   overwritten in place, and it exists only to be shown while the API is unreachable.

   Console usage:
     netpulseCache.lastGood()       // per module: how old the fallback is
     netpulseCache.clearLastGood()  // drop every remembered payload
 * ------------------------------------------------------------------ */

(function () {
  'use strict';

  var PREFIX = 'netpulse_lastgood_';
  var SHAPE = 1;
  var TYPES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

  // One OLT payload is ~50 KB decoded and localStorage holds ~5 MB, so the budget is not
  // the risk. A single runaway payload failing the write for every other module is, so
  // above this a module simply goes without a fallback — and says so.
  var MAX_BYTES = 512 * 1024;

  var _freshAt = {};   // type -> ms the API last answered, this session
  var _stale = {};     // type -> { at: ms|null } data currently on screen is old
  var _written = {};   // type -> the exact payload string in storage (skip identical writes)

  function store() {
    try { return window.localStorage; } catch (e) { return null; }
  }

  function payloadKey(type) { return PREFIX + type; }
  function timeKey(type) { return PREFIX + type + '_at'; }

  /**
   * The remembered payload, or null. A record that does not round-trip, or that carries
   * a shape this build does not know, is refused rather than guessed at — a wrong
   * number on a NOC display is worse than a missing one.
   */
  function readPayload(type) {
    var s = store();
    if (!s) return null;
    var raw;
    try { raw = s.getItem(payloadKey(type)); } catch (e) { return null; }
    if (!raw) return null;
    try {
      var rec = JSON.parse(raw);
      if (!rec || rec.v !== SHAPE || rec.payload === undefined || rec.payload === null) return null;
      return rec.payload;
    } catch (e) {
      return null;
    }
  }

  function readTime(type) {
    var s = store();
    if (!s) return null;
    var raw;
    try { raw = s.getItem(timeKey(type)); } catch (e) { return null; }
    var n = parseInt(raw, 10);
    return isFinite(n) && n > 0 ? n : null;
  }

  function writeTime(type, at) {
    var s = store();
    if (!s) return;
    try { s.setItem(timeKey(type), String(at)); } catch (e) {}
  }

  /* ---------------- staleness ---------------- */

  /** Data is on screen but the API has not answered since `at`.

      `hasData` is not decoration: it is the difference between "not loaded" and
      "loaded, but we cannot say how old" — and the banner must not claim the wrong
      one, because they call for different things from whoever is reading it. */
  function markModuleStale(type, at, hasData) {
    _stale[type] = {
      at: (typeof at === 'number' && at > 0) ? at : null,
      hasData: hasData !== false
    };
    renderStaleBanner();
  }

  function clearModuleStale(type) {
    if (_stale[type] === undefined) return;
    delete _stale[type];
    renderStaleBanner();
  }

  /** { type: { at, hasData } } for every module currently showing old data. */
  function moduleStaleness() {
    var out = {};
    TYPES.forEach(function (type) {
      if (_stale[type] !== undefined) out[type] = { at: _stale[type].at, hasData: _stale[type].hasData };
    });
    return out;
  }

  /** Shared with the module messages, so the banner and a module cannot disagree. */
  function lastGoodClock(at) {
    if (!at) return null;
    try {
      return new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } catch (e) {
      return null;
    }
  }

  function stalenessLine() {
    var stale = moduleStaleness();
    var names = TYPES.filter(function (t) { return stale[t] !== undefined; });
    if (!names.length) return '';

    var shown = names.slice(0, 3).map(function (t) {
      var clock = lastGoodClock(stale[t].at);
      if (clock) return t.toUpperCase() + ' ' + clock;
      return t.toUpperCase() + (stale[t].hasData ? ' (age unknown)' : ' (not loaded)');
    });
    var rest = names.length - shown.length;

    return 'STALE — live data unavailable · showing last known: ' +
      shown.join(' · ') + (rest > 0 ? ' · +' + rest + ' more' : '');
  }

  /**
   * Paint every banner in the document. There are two shells — the dashboard header and
   * the kiosk topbar — and they share one class rather than one id, so this is the only
   * place that knows how many there are.
   */
  function renderStaleBanner() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    var nodes = document.querySelectorAll('.stale-banner');
    if (!nodes.length) return;

    var text = stalenessLine();
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      node.classList.toggle('is-visible', !!text);
      var label = node.querySelector('.stale-banner-text');
      if (label) label.textContent = text;
    }
  }

  /* ---------------- the two calls the modules make ---------------- */

  /**
   * A fetch that worked. Remembers the payload for a future failure and clears any
   * stale mark. Safe to call on every success, including background revalidations.
   */
  function noteModuleFresh(type, payload) {
    var at = Date.now();
    _freshAt[type] = at;
    clearModuleStale(type);

    var s = store();
    if (!s || payload === undefined || payload === null) return;

    // The timestamp first: it is what the banner reads, and it must survive even if the
    // payload write below is skipped or refused.
    writeTime(type, at);

    var raw;
    try {
      raw = JSON.stringify({ v: SHAPE, payload: payload });
    } catch (e) {
      return; // unserializable: no fallback for this module, but nothing breaks
    }
    if (raw.length > MAX_BYTES) {
      console.warn('[LastGood] ' + type + ' payload is ' + raw.length +
        ' bytes — too large to keep as a fallback (limit ' + MAX_BYTES + ')');
      return;
    }
    if (_written[type] === raw) return; // unchanged: the timestamp was the only news
    try {
      s.setItem(payloadKey(type), raw);
      _written[type] = raw;
    } catch (e) {
      // Quota or a locked-down store. A missing fallback is survivable; a thrown
      // exception inside a fetch handler is not.
    }
  }

  /**
   * A fetch that failed: keep whatever is already on screen, or hydrate from the last
   * known good payload, and mark the module stale.
   *
   *   -> { payload, at, from }   payload: what to render, or null if there is nothing
   *                              at:      when the API last answered, or null
   *                              from:    'screen' | 'stored' | 'none'
   *
   * `at` is when we last HEARD FROM the API, not when the numbers changed, because that
   * is what "stale since" means to whoever is reading the screen.
   */
  function degradeModuleToLastGood(type, onScreen) {
    var onScreenHasData = false;
    if (onScreen !== undefined && onScreen !== null) {
      onScreenHasData = Array.isArray(onScreen) ? onScreen.length > 0 : true;
    }

    var payload = null;
    var at = _freshAt[type] || readTime(type) || null;
    var from = 'none';

    if (onScreenHasData) {
      payload = onScreen;
      from = 'screen';
    } else {
      var remembered = readPayload(type);
      if (remembered !== null) {
        payload = remembered;
        from = 'stored';
      }
    }

    markModuleStale(type, at, payload !== null);
    return { payload: payload, at: at, from: from };
  }

  /**
   * A fetch failed but nothing is being re-rendered: the screen already shows the best
   * data we have, it is only getting older. This is the background revalidation path,
   * where the honest change is the banner and nothing else.
   */
  function noteModuleFailed(type) {
    var at = _freshAt[type] || readTime(type) || null;
    // A background revalidation only happens once something is on screen, so the
    // data is there by definition; only its age is in question.
    markModuleStale(type, at, true);
    return at;
  }

  /** Is this module showing old data right now? Used by the kiosk to tell "still
      loading" apart from "could not be reached", which look identical without it. */
  function lastGoodStale(type) {
    return _stale[type] !== undefined;
  }

  /* ---------------- honest states: a module with nothing to show ---------------- */

  /* A failed fetch used to fall through to whatever a module's empty branch rendered,
     and for NODE and BACKBONE that is an all-clear card — so the app said "All Node
     Systems Operational" while blind. A wall display must never confuse "nothing is
     wrong" with "we could not check", so these are the only states a module with no
     remembered data may show. */
  var UNREACHABLE_TITLE = 'Live data unavailable';
  var UNREACHABLE_DETAIL = 'The API could not be reached and no earlier data was kept. This is not an all-clear.';

  /** A single honest row, for a module whose table already exists (NAP/LCP/OLT). */
  function unavailableRowHtml(colspan) {
    var n = parseInt(colspan, 10);
    if (!isFinite(n) || n < 1) n = 1;
    return '<tr class="unavailable-tr"><td colspan="' + n + '">' +
      '<div class="unavailable-cell">' +
      '<strong>' + UNREACHABLE_TITLE + '</strong>' +
      '<span>' + UNREACHABLE_DETAIL + '</span>' +
      '</div></td></tr>';
  }

  /* ---------------- inspection / console surface ---------------- */

  function report() {
    var out = {};
    TYPES.forEach(function (type) {
      var at = _freshAt[type] || readTime(type) || null;
      out[type] = {
        remembered: readPayload(type) !== null,
        lastAnsweredAt: at,
        ageMs: at ? Date.now() - at : null,
        showing: _stale[type] !== undefined ? 'stale' : 'live'
      };
    });
    return out;
  }

  function clearAll() {
    var s = store();
    var removed = 0;
    TYPES.forEach(function (type) {
      if (!s) return;
      try {
        if (s.getItem(payloadKey(type)) !== null) removed++;
        s.removeItem(payloadKey(type));
        s.removeItem(timeKey(type));
      } catch (e) {}
      delete _written[type];
    });
    return removed ? 'removed ' + removed + ' remembered payload(s)' : 'nothing was remembered';
  }

  // The module files are plain classic scripts and call these directly; they are on
  // window for that reason, not as a public API.
  window.noteModuleFresh = noteModuleFresh;
  window.noteModuleFailed = noteModuleFailed;
  window.degradeModuleToLastGood = degradeModuleToLastGood;
  window.lastGoodClock = lastGoodClock;
  window.lastGoodStale = lastGoodStale;
  window.renderStaleBanner = renderStaleBanner;
  window.unavailableRowHtml = unavailableRowHtml;

  window.netpulseLastGood = {
    report: report,
    staleness: moduleStaleness,
    lastGoodClock: lastGoodClock,
    staleTypes: function () {
      return TYPES.filter(function (t) { return _stale[t] !== undefined; });
    },
    line: stalenessLine,
    clearAll: clearAll,
    renderBanner: renderStaleBanner,
    noteModuleFresh: noteModuleFresh,
    noteModuleFailed: noteModuleFailed,
    degradeModuleToLastGood: degradeModuleToLastGood
  };
})();
