// ====================== REV WATCH ======================
//
// Asks the server whether anything changed, so a dashboard updates by itself
// instead of waiting for its own refresh cadence or for someone to click.
//
// WHY A SEPARATE, CHEAP QUESTION
//
// The only way to learn "is this data current?" used to be to fetch the data:
// 26 KB and a possible 3-5 s rebuild, per module, to find out nothing had
// changed. ?action=rev answers the same question with one PropertiesService
// read, no spreadsheet access and no build, so the app can ask often enough to
// matter (~30 s) without paying for it — and when the answer IS "something
// changed", the real fetch goes out through fetchGate.run(): the foreground
// path, which is unthrottled and cancels any pending deferred refetch, so a
// change reaches the screen in seconds rather than at the next minute boundary.
//
// WHAT MOVES THE REVISION
//
// cache-invalidation.gs bumps a per-type counter when a sheet edit invalidates
// that module's cache. Both halves are needed and neither is sufficient: an
// edit the trigger cannot see (a formula or IMPORTRANGE recalculation, or a
// script write — Google does not fire triggers for those) leaves the revision
// alone, and is covered only by the warm cadence and the TTL in
// olt-cache-warmer.gs plus the honest age in the chip.
//
// WHY POLLING STOPS WHEN HIDDEN
//
// A hidden tab's problem is already solved elsewhere: index.html refreshes every
// module when the app returns to the foreground after 2+ minutes, and this
// watcher polls once immediately on that same event. So polling a hidden tab
// would spend the PropertiesService daily quota to duplicate that — and the
// quota is the real limit here (50,000 reads/day; one read per poll, so ~1,440
// reads per device per 12 h day at a 30 s interval).
//
// Depends on: fetchWithRetry() and BASE_API_URL from index.html, and fetchGate
// for the build stamps. Loaded after fetch-gate.js.

(function () {
  'use strict';

  var POLL_INTERVAL_MS = 30000;
  var FIRST_POLL_DELAY_MS = 5000; /* let the initial load finish first */
  var VERIFY_DELAY_MS = 6000;

  var _started = false;
  var _timer = null;
  var _url = '';
  var _types = [];
  var _refresh = null;
  var _seen = {};      /* type -> the revision we last acted on */
  var _polls = 0;      /* introspection, and useful in a console */

  function isVisible() {
    return (typeof document === 'undefined') || document.visibilityState !== 'hidden';
  }

  function builtAtOf(type) {
    return (window.fetchGate && window.fetchGate.dataBuiltAt)
      ? window.fetchGate.dataBuiltAt(type)
      : 0;
  }

  function schedule() {
    if (!_started) return;
    if (_timer) clearTimeout(_timer);
    if (!isVisible()) return;
    _timer = setTimeout(tick, POLL_INTERVAL_MS);
  }

  function tick() {
    if (!_started) return;
    if (!isVisible()) { schedule(); return; }

    _polls++;
    fetchWithRetry(_url, 0, 0).then(function (payload) {
      apply(payload);
      schedule();
    }, function () {
      /* Silent: a poll that fails costs a refresh cadence, not correctness —
         which is exactly what the previous behaviour was. */
      schedule();
    });
  }

  function apply(payload) {
    var rev = payload && payload.rev;
    if (!rev) return;

    for (var i = 0; i < _types.length; i++) {
      var type = _types[i];
      if (!Object.prototype.hasOwnProperty.call(rev, type)) continue;

      var value = rev[type];
      var previous = _seen[type];
      _seen[type] = value;

      if (previous === undefined) continue; /* first poll: the page just loaded */
      if (previous === value) continue;

      refreshType(type, previous, value);
    }
  }

  function refreshType(type, previous, value) {
    var builtBefore = builtAtOf(type);

    try {
      _refresh(type);
    } catch (err) {
      console.warn('[RevWatch] refresh failed for ' + type + ':', err.message);
      return;
    }

    /* Verification pass, not a repair.

       A rebuild reads the sheet for ~3-4 s, so an edit can land mid-read and the
       payload written just afterwards is a pre-edit snapshot — see the race note
       in cache-invalidation.gs, where the server-side guard refuses to cache a
       build whose revision moved. This is the residue of that window: the refresh
       we just issued answered with the pre-edit build, and its stamp will not
       have advanced. Re-fetching immediately would hit the same entry, so the
       only honest thing to do here is say so, once, and let the TTL (180 s) bound
       it. Quietly pretending the refresh worked is what made the original
       incident take 11 minutes to explain. */
    setTimeout(function () {
      var builtAfter = builtAtOf(type);
      if (!builtAfter || !builtBefore) return; /* no stamp for this module */
      if (builtAfter > builtBefore) return;
      console.warn('[RevWatch] ' + type + ': revision moved (' + previous + ' → ' +
                   value + ') but the payload build time did not. The server ' +
                   'answered with a snapshot built before the edit; the TTL bounds it.');
    }, VERIFY_DELAY_MS);
  }

  /**
   * @param {Object} opts
   * @param {string} opts.url       the rev route, e.g. BASE_API_URL + '?action=rev'
   * @param {string[]} opts.types   module types to watch
   * @param {Function} opts.refresh called with (type) to force a refetch; normally
   *                                index.html's backgroundRefresh
   * @param {number} [opts.intervalMs] override the poll interval (tests)
   */
  window.startRevWatch = function (opts) {
    if (_started) return;
    opts = opts || {};

    _url = opts.url || '';
    _types = opts.types || [];
    _refresh = opts.refresh || function () {};
    if (!_url || !_types.length) return;

    /* Timing knobs. Real values are the defaults; the overrides exist so the
       behaviour can be driven by tests without waiting real minutes for a poll
       or real seconds for a verification pass. */
    if (typeof opts.intervalMs === 'number' && opts.intervalMs > 0) {
      POLL_INTERVAL_MS = opts.intervalMs;
    }
    if (typeof opts.firstPollDelayMs === 'number' && opts.firstPollDelayMs >= 0) {
      FIRST_POLL_DELAY_MS = opts.firstPollDelayMs;
    }
    if (typeof opts.verifyDelayMs === 'number' && opts.verifyDelayMs >= 0) {
      VERIFY_DELAY_MS = opts.verifyDelayMs;
    }

    _started = true;

    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        /* A return to the foreground is a reason to look now, not in 30 s. */
        if (isVisible()) tick();
      });
    }

    setTimeout(tick, FIRST_POLL_DELAY_MS);
  };

  /* Introspection — console debugging, and what the tests drive. */
  window.revWatch = {
    pollNow: function () { if (_started) tick(); },
    stop: function () { _started = false; if (_timer) clearTimeout(_timer); },
    seen: function () { return _seen; },
    polls: function () { return _polls; },
    isRunning: function () { return !!_started; }
  };
})();
