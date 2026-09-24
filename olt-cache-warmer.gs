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
 * THE PASS — five builds in one run, because the other four were never warmed
 * ---------------------------------------------------------------------------
 *
 * OLT was the only module with a warmer. The other four relied on real traffic: the
 * app prefetches all five on every load, so the gap is the FIRST request after an idle
 * period — and for an operator who opens this app for three minutes, checks the picture
 * and closes it, that gap is the whole of a session. Measured: OLT cold 2.97 / 3.21 s
 * against a warm hit 1.09-1.52 s, a cold-ish five-module burst at 3.235 s and the same
 * burst warm at 1.156 s.
 *
 * So one run now rebuilds every module, in ONE execution, in this order:
 *
 *   olt -> nap -> lcp -> node -> backbone
 *
 * OLT first (the heaviest build here, and the one a three-second budget can actually
 * miss), then the rest, which is also cheap to expensive. Sequentially, never in
 * parallel: five concurrent builds contend on the same spreadsheet, and this app has
 * already met that failure once as the echo endpoint's 404s under parallel hits. Each
 * type is wrapped on its own, so one module's bad day cannot starve the four behind it.
 *
 * WHAT THIS DOES NOT FIX
 *
 * The intermittent 21 s origin 404 — an 8 KB Google error page that reaches a module as
 * a red "Error loading data." row. That is an ERROR PATH, not a cache miss, and no
 * amount of warming touches it. It remains the largest single source of a bad experience
 * in this system, and it is still open.
 *
 * THE FLOOR
 *
 * ~1.1 s of every call is Apps Script startup plus the 302 -> googleusercontent echo
 * hop, paid whether the call hits the cache or not. Nothing here removes that. The
 * warming removes the BUILD.
 *
 * BUDGET
 *
 * 300 s cadence = 288 runs/day. Per run, sequentially: ~3.5 s (olt) + ~1.3 s (nap) +
 * ~1.3 s (lcp) + ~1.8 s (node) + ~1.8 s (backbone) ~= 10 s, so ~46 min/day against the
 * documented triggers-total-runtime quota of 90 min/day on consumer accounts (6 h/day on
 * Workspace), alongside the aging writers and the hourly backbone job at ~10 min/day.
 *
 * Only OLT's ~3.5 s is measured; the other four are estimates, and the pass log below is
 * what replaces them. Read it from the Executions page after the first day, recompute,
 * and set the interval from the arithmetic rather than from this paragraph. Every 10 min
 * halves the cost and the coverage; every 3 min is ~77 min/day. It is TRIGGER RUNTIME
 * that is the constraint, not request volume, because every run is a full rebuild.
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

/* ---------------- The other four modules ----------------

   One pass, five builds, one execution. The order is the point: OLT is the heaviest and
   the only one whose cold build has actually been measured against the three-second
   budget, so it goes first and cannot be starved by a slow module in front of it.

   These four ask for no `shape`. OLT is the only type whose payload has more than one
   shape, and the shape a warm run must write is the one the app reads — which is why
   warmOltCache() states shape=3 itself instead of being folded into warmTypeCache_().

   TTL is the same 180 s the OLT warmer writes, and it is deliberately BELOW the 300 s
   interval. That is the rule the 2026-09-18 incident was closed with: with a TTL longer
   than one cycle a cache HIT can be served for longer than the cadence that refreshes
   it, which is exactly how a deleted ticket stayed on a dashboard for 11 minutes. A dead
   warmer then decays to slow-but-current rather than stale. The alternative — TTL >=
   interval, so a hit exists at every moment and an open is never cold — is a real option
   and is NOT taken here, because it trades a documented fix away for coverage of four
   build costs that are still unmeasured. */

/* The modules this pass adds to the warmer, in the order they are built. */
var SECONDARY_WARM_TYPES = ['nap', 'lcp', 'node', 'backbone'];

/* Cache lifetime for a warmed secondary entry, in seconds. Same value as
   OLT_WARM_TTL_SECONDS on purpose — one number for "warm entry life" is one thing to
   reason about, and both sit under the one interval above. Ceiling in doGet() is 1800 s. */
var SECONDARY_WARM_TTL_SECONDS = 180;

/**
 * Is this response the origin's "the build could not run" envelope?
 *
 * A failed build does NOT throw out of doGet. code.gs catches it and answers
 * {error:"build_failed", retryable:true}, and that reply is a 200 with a perfectly
 * valid body — which is why fetchWithRetry() in index.html has to classify it at all.
 * A warmer has the same problem and a worse one: it would log a 74-byte "success" and
 * nothing would be cached, so a module could be reported warm every five minutes while
 * every user paid a cold build or an error.
 *
 * Matched on the leading bytes rather than by parsing: the payload is already a string
 * here, and a real payload can only start with `[` (a row array) or `{"v":` (the OLT
 * compact envelope).
 */
function isBuildErrorEnvelope_(text) {
  return /^\s*\{\s*"error"/.test(String(text || ''));
}

/**
 * Rebuild one module's cache entry, out of band, and report honestly.
 *
 * @param {string} type        a member of DATA_TYPES in code.gs
 * @param {number} ttlSeconds  the lifetime to write, and the instruction to rebuild
 * @return {number} elapsed ms, or -1 when the type could not be warmed
 */
function warmTypeCache_(type, ttlSeconds) {
  var start = Date.now();
  try {
    var fakeEvent = { parameter: { type: type } };
    var output = doGet(fakeEvent, ttlSeconds);
    var content = output.getContent();
    var elapsed = Date.now() - start;
    var size = content ? content.length : 0;

    /* A failed build answers with an envelope instead of throwing, and that reply is
       never cached (code.gs returns from its guard before the cache write). Reporting it
       as a warm success would be the silent-lie shape this project keeps having to hunt:
       "the module is warmed every five minutes" while a renamed tab sends every user to
       an empty payload or a cold build. */
    if (isBuildErrorEnvelope_(content)) {
      Logger.log('❌ warmCache ' + type + ': the build answered with an error envelope — ' +
                 'NOTHING was cached for it (' + size + ' bytes, ' + elapsed + 'ms). ' +
                 'Look for the matching "❌ Build failed" line above it.');
      return -1;
    }

    Logger.log('✅ warmCache ' + type + ': warmed in ' + elapsed + 'ms (' +
               size + ' bytes, TTL ' + ttlSeconds + 's)');

    // Same warning the OLT warmer makes, for the same reason: a build that cannot finish
    // inside the interval it covers cannot keep the cache warm at this cadence, and the
    // schedule becomes a fiction.
    if (elapsed > OLT_WARM_INTERVAL_SECONDS * 1000) {
      Logger.log('⚠️ warmCache ' + type + ': build took ' + elapsed +
                 'ms — longer than the ' + OLT_WARM_INTERVAL_SECONDS +
                 's interval it covers. The cache cannot stay warm at this cadence.');
    }

    return elapsed;
  } catch (err) {
    /* Per type, not per run. This is the only thing keeping any of these modules warm,
       so a module that cannot be built must not take the four behind it down with it. */
    Logger.log('❌ warmCache ' + type + ' failed after ' + (Date.now() - start) +
               'ms: ' + err.message);
    return -1;
  }
}

/**
 * The trigger entry point: rebuild every module's cache entry, in one execution.
 *
 * Registered in TRIGGER_PLAN (triggers.gs) as `warmDataCaches`, every 5 minutes, and
 * that entry is the only written record of the cadence — the Apps Script UI shows the
 * event type and never the schedule.
 *
 * OLT is built through warmOltCache(), the function that already existed and is already
 * asserted: it owns shape=3, its own TTL constant and its own log line, and this pass
 * does not restate any of that. What it does NOT get is the error-envelope check that
 * warmTypeCache_ makes: warmOltCache predates it and is left byte-identical here, so an OLT
 * build that fails still logs as a success with a small byte count. That asymmetry is
 * recorded as an open item rather than fixed by rewriting a tested function in the same
 * change that adds its replacement.
 */
function warmDataCaches() {
  var start = Date.now();
  var failed = [];
  var built = 0;

  /* OLT first: the heaviest build, and the one the three-second budget can actually
     miss. Wrapped on its own so anything thrown outside warmOltCache's own try/catch
     still leaves the four behind it scheduled. */
  try {
    warmOltCache();
    built++;
  } catch (err) {
    failed.push('olt');
    Logger.log('❌ warmDataCaches: warmOltCache threw: ' + err.message);
  }

  for (var i = 0; i < SECONDARY_WARM_TYPES.length; i++) {
    var type = SECONDARY_WARM_TYPES[i];
    if (warmTypeCache_(type, SECONDARY_WARM_TTL_SECONDS) >= 0) built++;
    else failed.push(type);
  }

  var total = Date.now() - start;

  /* One line per run that says what actually happened, because "the warmer ran" and "the
     warmer warmed something" are different claims and only this line separates them. */
  Logger.log('✅ warmDataCaches: pass finished in ' + total + 'ms — ' + built + ' of ' +
             (SECONDARY_WARM_TYPES.length + 1) + ' module(s) rebuilt' +
             (failed.length ? ' — FAILED: ' + failed.join(', ') : ''));

  if (total > OLT_WARM_INTERVAL_SECONDS * 1000) {
    Logger.log('⚠️ warmDataCaches: the pass took longer than the ' +
               OLT_WARM_INTERVAL_SECONDS + 's interval it covers. The cache cannot stay ' +
               'warm at this cadence — raise the interval or find the slow module above.');
  }
}
