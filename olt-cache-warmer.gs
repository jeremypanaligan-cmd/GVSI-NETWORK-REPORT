/**
 * ==================== OLT CACHE WARMER ====================
 *
 * Rebuilds the OLT cache on a time-driven trigger so user requests hit
 * CacheService instead of the 3-5 s cold-build path. The trigger is registered
 * by setupAllTriggers() in triggers.gs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TTL IS NOW SHORTER THAN THE INTERVAL (it used to be the other way)
 *
 * The old rule was "TTL must exceed the trigger interval, or a run that is late
 * leaves a gap" — true of a warmer that only builds on a MISS. This one does not
 * build on a miss; it builds unconditionally (doGet's warm override now means
 * "ignore the cache and rebuild"), which changes what the TTL is for:
 *
 *   - Freshness is the CADENCE, not the TTL. Every run overwrites the entry, so
 *     the snapshot a user can be shown is at most one interval old.
 *   - The TTL only bounds the DEGRADED case: if this trigger dies, the entry it
 *     left behind stays served until it expires. 180 s — shorter than the 300 s
 *     interval — means the entry dies before the next run, so a client that asks
 *     after it expires pays a rebuild and gets CURRENT data (slow, recoverable)
 *     instead of an ever-older snapshot (wrong). The old 1080 s made that window
 *     18 minutes, which is how a deleted DOWN ticket stayed on a dashboard for
 *     11 minutes on 2026-09-18 with the app refreshing the whole time.
 *   - The cost of the shorter TTL is one small share of requests paying a cold
 *     build instead of a hit. Measured on the live route: ~4 s cold, ~1.3 s hit,
 *     510 bytes for shape=3. That trade is the right way round for an outage
 *     dashboard: never freeze, even at the price of speed.
 *
 * NOTIFICATION DOES THE FAST PATH
 *
 * Neither number is the answer to "how fast does an edit show up". That is
 * cache-invalidation.gs (seconds, on the trigger) plus the app's rev poll, with
 * olt-cache-warmer.gs and this TTL covering only what a trigger cannot see:
 * formula and IMPORTRANGE recalculations, and script writes.
 *
 * BUDGET
 *
 * 300 s cadence = 288 runs/day. A build is ~4 s, so ~19 min/day against the
 * documented triggers-total-runtime quota of 90 min/day on consumer accounts
 * (6 h/day on Workspace), alongside the aging writers and the hourly backbone
 * job. Going tighter is a one-line change with the arithmetic to match:
 * every 3 min is ~32 min/day, every 2 min is ~48 min/day. Both still fit, and
 * both will raise the Sheets read load in step.
 * ---------------------------------------------------------------------------
 */

/* How often the trigger runs. MUST match the warmOltCache entry in
   TRIGGER_PLAN (triggers.gs) — that table is the record the Apps Script UI
   cannot show, and tests/olt-warm-ttl.test.js asserts the two agree, so this
   copy cannot drift from it unnoticed. */
var OLT_WARM_INTERVAL_SECONDS = 300;

/* Cache lifetime for a warmed entry, in seconds. Deliberately BELOW the
   interval: see the header. Ceiling in doGet() is 1800 s. */
var OLT_WARM_TTL_SECONDS = 180;

function warmOltCache() {
  // Build the problem-only compact payload (shape=3) — the shape the OLT
  // module actually requests, so the warmed entry is the one users hit.
  var fakeEvent = {
    parameter: { type: 'olt', shape: '3' }
  };

  var start = Date.now();
  try {
    // Second argument = the warm TTL, and (since the rebuild-intent change in
    // code.gs) also the instruction to rebuild even if a live entry exists. It
    // is unreachable over HTTP: only an in-process caller can pass it.
    var output = doGet(fakeEvent, OLT_WARM_TTL_SECONDS);
    var elapsed = Date.now() - start;
    var content = output.getContent();
    var size = content ? content.length : 0;

    Logger.log('✅ warmOltCache: OLT cache warmed in ' + elapsed + 'ms (' +
               size + ' bytes, TTL ' + OLT_WARM_TTL_SECONDS + 's)');

    // The build has to finish well inside the interval it is covering, or the
    // cadence cannot hold and the schedule is a fiction. Compared against the
    // INTERVAL, not the TTL: the TTL is now shorter than the build's own order
    // of magnitude and would warn on every healthy run.
    if (elapsed > OLT_WARM_INTERVAL_SECONDS * 1000) {
      Logger.log('⚠️ warmOltCache: build took ' + elapsed +
                 'ms — longer than the ' + OLT_WARM_INTERVAL_SECONDS +
                 's interval it covers. The cache cannot stay warm at this cadence.');
    }
  } catch (err) {
    Logger.log('❌ warmOltCache failed: ' + err.message);
  }
}
