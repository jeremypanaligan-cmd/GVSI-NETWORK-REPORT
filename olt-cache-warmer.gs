/**
 * ==================== OLT CACHE WARMER ====================
 *
 * Pre-builds the OLT cache on a 15-minute trigger so user requests hit
 * CacheService instead of the 11-25 s cold-build path. The trigger is
 * registered by setupAllTriggers() in triggers.gs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TTL OVERRIDE MATTERS (this was the bug)
 *
 * Warming alone was not enough. doGet() writes the OLT entry with the normal
 * 60 s cacheTTL, and this trigger only runs every 15 minutes — so the entry it
 * built was dead for 14 of every 15 minutes and every user request still paid a
 * cold build. The warmer ran, reported success, and bought almost nothing.
 *
 * So the warmer now asks for a longer-lived entry by passing a TTL as doGet()'s
 * SECOND POSITIONAL ARGUMENT. That argument cannot come from outside: Apps
 * Script's HTTP entry point calls doGet(e) with the query-string event and
 * nothing else, so only in-process callers like this one can pass it. No client
 * can request a long-lived entry, and therefore no client can pin a stale
 * outage view.
 *
 * HOW LONG, AND WHAT THE REAL FRESHNESS IS
 *
 * The TTL must exceed the trigger interval or a run that is merely late leaves
 * a gap. 900 s interval + 180 s of slack for a delayed trigger = 1080 s.
 *
 * Note what the TTL is NOT: it does not set the staleness a user sees. A
 * successful trigger every 15 minutes refreshes the entry every 15 minutes
 * regardless of whether the TTL is 1080 s or 4000 s — the TTL is only
 * resilience against a missed run. Freshness is set by the cadence, so if
 * 15 minutes is too stale, change the TRIGGER, not this number.
 *
 * The failure mode is deliberate: if this trigger dies, the entry expires on
 * its own after 18 minutes and users start paying cold builds again (slow)
 * rather than being served an ever-staler outage view (wrong). Slow is
 * recoverable; wrong is not.
 * ---------------------------------------------------------------------------
 */

/* Cache lifetime for a warmed entry, in seconds.
   MUST stay above the warmOltCache trigger interval in triggers.gs (15 min =
   900 s) — a TTL shorter than the interval is exactly the bug this fixes.
   Ceiling in doGet() is 1800 s. */
var OLT_WARM_TTL_SECONDS = 1080;

function warmOltCache() {
  // Build the problem-only compact payload (shape=3) — the shape the OLT
  // module actually requests, so the warmed entry is the one users hit.
  var fakeEvent = {
    parameter: { type: 'olt', shape: '3' }
  };

  var start = Date.now();
  try {
    // Second argument = the warm TTL. See the header: unreachable over HTTP.
    var output = doGet(fakeEvent, OLT_WARM_TTL_SECONDS);
    var elapsed = Date.now() - start;
    var content = output.getContent();
    var size = content ? content.length : 0;

    Logger.log('✅ warmOltCache: OLT cache warmed in ' + elapsed + 'ms (' +
               size + ' bytes, TTL ' + OLT_WARM_TTL_SECONDS + 's)');

    // The build is only worth its cost if it finishes well inside the interval
    // it is covering. If it ever doesn't, the cache cannot stay warm and the
    // cadence (or the OLT branch itself) needs attention instead.
    if (elapsed > OLT_WARM_TTL_SECONDS * 1000) {
      Logger.log('⚠️ warmOltCache: build took ' + elapsed +
                 'ms — longer than the TTL it sets. The cache cannot stay warm.');
    }
  } catch (err) {
    Logger.log('❌ warmOltCache failed: ' + err.message);
  }
}
