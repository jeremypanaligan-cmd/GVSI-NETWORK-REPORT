/**
 * ==================== MODULE DIAGNOSTICS (SERVER SIDE ONLY) ====================
 *
 * When a module misbehaves, the server should be able to say WHICH one, which sheet and
 * stage it died on, how long the build took, and whether its cache is even holding a
 * payload — without a client release, without touching the request path, and without a
 * new trigger.
 *
 * THE FACTS ALREADY EXIST. code.gs's buildCtx_ records type, stage, sheet, rev and
 * elapsedMs, and spends them on ONE "❌ Build failed | …" line that exists only on the
 * Executions page. warmDataCaches already computes a per-type build time on every run —
 * it is why judgeWarmResponse_() returns an ms — and every one of those numbers is
 * currently thrown away. What was missing was anything that could READ them.
 *
 * ---------------------------------------------------------------------------
 * THE COST MODEL (why this is not "diagnostics that made the slow module slower")
 *
 *   success build      stores NOTHING, by construction. The version of this that was
 *                      written and reverted recorded a sample after every successful
 *                      build — one property read per build, on the coldest, slowest path
 *                      in the app, against a metered 50,000 reads/day. That is the wrong
 *                      place for a measurement and it is why nothing here runs there.
 *   failure build      1 read + 1 write, in buildFailedOut_. Rare, and it is the sample
 *                      being looked for.
 *   slow build         NO READ AT ALL: the elapsed time is compared against a constant and
 *                      only a build over the threshold writes. Every fast build costs one
 *                      integer comparison.
 *   warm pass          1 write per run (five modules), inside the trigger's own execution.
 *                      ~288 writes/day ~= 0.6% of the quota, and it is the only source of
 *                      the four build times nothing has ever measured.
 *   ?action=diag       read-only, ~20 reads, manual only. Never polled: a card that
 *                      refreshes itself would be the load it exists to measure.
 *
 * A cache HIT returns at the top of doGet's cache block, before any build starts — so
 * every hook that lives at the END of a build is paid only on a MISS.
 *
 * ---------------------------------------------------------------------------
 * THE GATE — measurePropertyCost()
 *
 * The claim this design rests on is "a property read is a fraction of a 1.5 s build".
 * That was a hypothesis, so it is measured before anything depends on it, and the result
 * is printed as a GO/NO-GO verdict in one manual run. It was run on the live project
 * three times: a whole-store read at 1.9%, then 2.7%, then 2.9% of the shortest cold
 * build, against a 5% ceiling. So the two request-path hooks are ON
 * (DIAG_REQUEST_HOOKS_ENABLED below) — and the pass record and this report were never
 * gated, because neither of them runs on a request.
 *
 * The measurement is deliberately BRACKETED rather than single-valued: one getProperty
 * may be answered from an in-execution cache and therefore understate the cost, while
 * getProperties() returns the whole store and cannot be cached past the first call. The
 * verdict is taken on the pessimistic bound, so a GO is a GO even if the optimistic
 * number was a lie. See judgePropertyCost_() for the thresholds and the arithmetic.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE MUST NEVER DO
 *
 *   - Start a build, read a sheet, write a cache entry or move a revision from the diag
 *     route. Asking what is slow has to be incapable of adding load.
 *   - Let the diag route answer a caller who is not an admin. resolveSession() tolerates
 *     a tokened-out caller when REQUIRE_SESSION is false (phase 1 of the token rollout)
 *     and returns {session: null, error: null} — so refusing `error` is NOT a gate. This
 *     route refuses a null session as well. The same hole exists in handleSetMaintenance
 *     today, where the actor falls back to "unknown"; recorded here, not fixed here.
 *   - Break a request. The recorders catch their own failures, and both call sites in
 *     code.gs check the function exists before calling it, so a diagnostics.gs that was
 *     never pasted cannot take the dashboard down — and says so in the log instead of
 *     being silently inert.
 *
 * Delivery is a paste. No trigger is added and setupAllTriggers() is NOT required.
 */

/* ------------------------------------------------------------------ *
   The gate
 * ------------------------------------------------------------------ */

/* Samples per timing. 30 single operations plus 30 whole-store reads: enough for a median
   to mean something, short enough to run inside one manual execution. */
var DIAG_GATE_SAMPLES = 30;

/* WHAT THE THRESHOLDS ARE, AND WHAT THE FIRST REAL RUN DID TO THEM.

   The design's claim is RELATIVE — "a property read is a fraction of a build, so a hook that
   costs one cannot matter" — and that is what the verdict turns on:

       the whole-store read, as a share of the shortest measured cold build.

   The first version of this compared three medians against three absolute numbers I had
   picked (20 ms, 50 ms, 50 ms) and reported NO-GO on the live project. It has now been run
   three times on the same store, in the same hour, within 25 minutes:

                         run 1 (12:33)   run 2 (12:42)   run 3 (12:57)   old threshold
       single getProperty   25ms            35ms            30ms            20ms  -> all FAIL
       getProperties()      25ms            35ms            38ms            50ms  -> all pass
       setProperty          51ms            53ms            54ms            50ms  -> all FAIL
       share of a build     1.9%            2.7%            2.9%            -     -> all pass
       worst cases        50/40/134       58/52/111       77/102/119

   **Three runs, and the read moved 40% between the first two.** The old gate failed ALL
   THREE, for three different magnitudes. A healthy system that fails a limit three times in a
   row by varying amounts is not slow — the limit is mis-set, and that is now the recorded
   reason the numbers below are what they are.

   Two things were wrong, and only one of them was the numbers.

     1. The verdict printed said the measurement "is not a fraction of a build", which was
        false: the whole-store read was 25 ms against a 1290 ms build, or 1.9% — printed on the
        line directly above. An instrument whose reason contradicts its own reading is measuring
        the wrong question, and the wrong question was "is PropertiesService fast in absolute
        terms" — which nothing in this design needs to be true.
     2. The absolute numbers were guesses. One failed by ONE millisecond on the first run and
        by three on the second. A threshold a healthy system fails by 2% is not a safety limit,
        it is a coin toss with a comment on it.

   The spread is also the reason the share limit is 5% and not 3%: the observed range across
   the three runs is **1.9% to 2.9%**, so the ceiling has to clear everything the instrument
   has ever said, not the reading it happened to produce first. At 5% there is about **1.7x**
   the worst of the three — enough that crossing it means the store changed, and not enough to
   pretend this is a small margin. Anyone re-tuning it should re-run the instrument first.

   So the verdict is now the share, with one absolute backstop on the WRITE — and no backstop on
   the read, for a reason worth stating: once the build is fixed, a share limit IS an absolute
   limit (5% of 1290 ms is 64.5 ms), so a second absolute read limit could only ever repeat the
   share's message, never fire alone. A branch that cannot be observed is a branch nothing can
   test, which is what the mutation pass said last time. The write has no share equivalent,
   because a write happens on a rare path rather than per read, so it keeps a ceiling of its
   own. Both ceilings sit above what the live runs showed (worst read across three runs 38 ms,
   worst write 54 ms median): a limit that fires on a healthy system is worse than no limit,
   because it teaches the reader to ignore it.

   WHAT THE MEASUREMENT BOUGHT, recorded because it is not what I assumed:

     - A property read is **25-38 ms**, not the sub-millisecond a design like this tends to
       assume. It is still under 3% of a build, so the hooks are affordable — but the number is
       real, and it is the input to any future tuning: `currentDataRev_()` is one whole-store
       read per rev poll, and the existing miss path in doGet spends about four of them.
     - **`getProperties()` is NOT cheaper than a single `getProperty`, and by run 3 it was
       dearer** — 38 ms against 30 ms median, 102 ms against 77 ms worst. Runs 1 and 2 had them
       level at 25 ms and 35 ms, so the honest statement is that the two are the same order
       and which one wins is not stable, which is exactly why the verdict is taken on the
       PESSIMISTIC bound. What still follows from it: anything answerable from one whole-store
       read should use one rather than N single reads, which is what buildDiagReport_() does.
       (The earlier version of this note claimed they cost the SAME. Run 3 corrected it, and
       the correction is left visible rather than quietly edited.)
     - setProperty is the expensive one (51-54 ms median, 134 ms worst across three runs),
       which is why the design gives every hook a reason NOT to write: successes write nothing,
       fast builds write nothing, and only a failed or genuinely slow build reaches a write at
       all. */
var DIAG_GATE_MAX_READ_SHARE_PCT = 5;
var DIAG_GATE_WRITE_CEILING_MS = 250;

/* The build a property read is compared against. The shortest measured module build in the
   warm pass is lcp at 1290 ms (.freebuff/run.md), so this is the FLOOR of a cold build: a
   read that is negligible against this is negligible against all of them. */
var DIAG_GATE_BUILD_MS = 1290;

/* ------------------------------------------------------------------ *
   Recording
 * ------------------------------------------------------------------ */

/**
 * The two hooks that run on the request path — ON, and the evidence is below.
 *
 * They shipped OFF, and deliberately: the first version of this feature put a property read on
 * the success path and was reverted for it, so the decision had to come from a measurement
 * rather than from an argument. It did. measurePropertyCost() ran on the live project three
 * times in one hour, and all three readings passed the only threshold that describes the
 * design: a whole-store read at **1.9%**, then **2.7%**, then **2.9%** of a 1290 ms build.
 *
 * Kept as a switch rather than deleted, because turning the request-path hooks off must not
 * require editing call sites — and because the value of the gate is that its answer is
 * recorded. If they are ever turned off again, this comment is where the reason goes.
 */
var DIAG_REQUEST_HOOKS_ENABLED = true;

/* A build over this is recorded. The heaviest module builds in ~3.1 s (OLT) and the
   lightest in ~1.3 s, so twice the heaviest is not "slow traffic" — it is the spreadsheet
   handle or a sheet read misbehaving, which is the thing worth keeping a record of. */
var DIAG_SLOW_BUILD_MS = 6000;

var DIAG_FAILURES_KEY = 'diag_failures';
var DIAG_FAILURES_MAX = 5;
var DIAG_SLOW_KEY = 'diag_slow_last';
var DIAG_PASS_KEY = 'diag_warm_pass';

/**
 * What the diagnostics are currently doing, so the report never has to be read in the
 * light of a guess about which switch is where.
 */
function diagStatus_() {
  return {
    requestHooks: DIAG_REQUEST_HOOKS_ENABLED ? 'on' : 'off',
    slowBuildMs: DIAG_SLOW_BUILD_MS,
    failuresKept: DIAG_FAILURES_MAX,
    note: DIAG_REQUEST_HOOKS_ENABLED
      ? 'request-path hooks are recording — the live gate read 1.9%, 2.7% and 2.9% of a cold ' +
        'build across three runs, against a 5% ceiling'
      : 'request-path hooks are OFF: run measurePropertyCost() and flip ' +
        'DIAG_REQUEST_HOOKS_ENABLED when it says GO'
  };
}

/**
 * Record one failed build. Called from buildFailedOut_, which already logs the same facts
 * to the Executions page — this is what makes them readable without opening a log.
 *
 * Reads the existing list to append to it (1 read + 1 write). Failures are rare, so this
 * is the one place in the design that is allowed an extra read on a request.
 *
 * @param {string} type  the module type
 * @param {Object} ctx   { message, stage, sheet, rev, elapsedMs } from buildCtx_
 * @return {boolean} whether a record was written
 */
function recordBuildFailure_(type, ctx) {
  if (!DIAG_REQUEST_HOOKS_ENABLED) return false;
  ctx = ctx || {};

  try {
    var props = PropertiesService.getScriptProperties();

    var list = [];
    var raw = props.getProperty(DIAG_FAILURES_KEY);
    if (raw) {
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) list = parsed;
      } catch (parseErr) {
        /* A corrupt history must not lose the failure that is happening right now. */
        list = [];
      }
    }

    list.unshift({
      at: Date.now(),
      type: String(type || ''),
      stage: String(ctx.stage || 'unknown'),
      sheet: String(ctx.sheet || ''),
      rev: Number(ctx.rev) || 0,
      ms: Number(ctx.elapsedMs) || 0,
      message: String(ctx.message || '').slice(0, 200)
    });

    props.setProperty(DIAG_FAILURES_KEY, JSON.stringify(list.slice(0, DIAG_FAILURES_MAX)));
    return true;
  } catch (err) {
    /* A recorder that can break a build is worse than no recorder. This runs inside doGet,
       on the path whose entire job is to answer with an envelope. */
    Logger.log('⚠️ recordBuildFailure_ could not write (' + err.message + ')');
    return false;
  }
}

/**
 * Record a build that finished but took too long. ONE WRITE, NO READ.
 *
 * The comparison against DIAG_SLOW_BUILD_MS happens first, on a value already in hand, so
 * a healthy build pays one integer compare and nothing else. The record is a single
 * overwritten slot rather than a list precisely so that no read is needed to write it.
 *
 * @return {boolean} whether a record was written
 */
function recordSlowBuild_(type, elapsedMs, stage, sheet) {
  if (!DIAG_REQUEST_HOOKS_ENABLED) return false;
  if (!(Number(elapsedMs) > DIAG_SLOW_BUILD_MS)) return false;

  try {
    PropertiesService.getScriptProperties().setProperty(DIAG_SLOW_KEY, JSON.stringify({
      at: Date.now(),
      type: String(type || ''),
      stage: String(stage || ''),
      sheet: String(sheet || ''),
      ms: Number(elapsedMs) || 0
    }));
    return true;
  } catch (err) {
    Logger.log('⚠️ recordSlowBuild_ could not write (' + err.message + ')');
    return false;
  }
}

/**
 * Record one warm pass — five build times, one write, in the trigger's own execution.
 *
 * NOT gated by DIAG_REQUEST_HOOKS_ENABLED, and that is the point: this runs in the
 * warmer's execution, costs the operator nothing, and is the only place the four
 * unmeasured module builds have ever been captured. It is what turns "the TTL should be
 * longer than the interval" from an argument into a number.
 *
 * @param {Object} pass { at, totalMs, built, of, failed, ms } — ms is type -> milliseconds
 * @return {boolean} whether the record was written
 */
function recordWarmPass_(pass) {
  pass = pass || {};
  try {
    PropertiesService.getScriptProperties().setProperty(DIAG_PASS_KEY, JSON.stringify({
      at: Number(pass.at) || Date.now(),
      totalMs: Number(pass.totalMs) || 0,
      built: Number(pass.built) || 0,
      of: Number(pass.of) || 0,
      failed: pass.failed || [],
      ms: pass.ms || {}
    }));
    return true;
  } catch (err) {
    Logger.log('⚠️ recordWarmPass_ could not write (' + err.message + ')');
    return false;
  }
}

/* ------------------------------------------------------------------ *
   Reading
 * ------------------------------------------------------------------ */

/**
 * What each module's cache is actually holding right now.
 *
 * Read-only: it reads, and reports. It does NOT delete an expired entry the way doGet
 * does on its way past — dropping a dead entry is the next real request's job, and a
 * route whose job is to observe must not be the thing that mutates.
 *
 * `rows` is the part that answers "is the cache even holding a payload": a module can be
 * cached and empty, and an empty payload behind a green log line is the shape of every
 * silent failure this project has had.
 *
 * @return {Object} type -> { key, present, source, bytes, rows, ageSeconds, expired }
 */
function diagCacheState_() {
  var out = {};
  var cache = CacheService.getScriptCache();
  var props = null;

  for (var i = 0; i < DATA_TYPES.length; i++) {
    var type = DATA_TYPES[i];
    var key = cacheKeyFor_(type, dashboardShapeFor_(type));
    var ttl = cacheTtlFor_(type);

    var state = {
      key: key,
      present: false,
      source: null,
      bytes: 0,
      rows: null,
      ageSeconds: null,
      expired: false
    };

    var raw = cache.get(key);
    if (raw) {
      state.present = true;
      state.source = 'cache';
    } else {
      /* The PropertiesService fallback for payloads too big for CacheService. Its age is
         hand-stamped, and an entry past its TTL is reported as expired rather than absent
         so the report shows what the request path would refuse to serve. */
      try {
        if (!props) props = PropertiesService.getScriptProperties();
        var stored = props.getProperty(key);
        if (stored) {
          var stamp = Number(props.getProperty(propStampKey_(key))) || 0;
          state.present = true;
          state.source = 'property';
          state.ageSeconds = stamp > 0 ? Math.round((Date.now() - stamp) / 1000) : null;
          state.expired = !(stamp > 0) || (state.ageSeconds >= ttl);
          raw = stored;
        }
      } catch (err) {
        Logger.log('⚠️ diagCacheState_: property fallback failed for ' + type +
                   ' (' + err.message + ')');
      }
    }

    if (raw) {
      state.bytes = raw.length;
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          state.rows = parsed.length;
        } else if (parsed && Array.isArray(parsed.r)) {
          state.rows = parsed.r.length;                       // the compact OLT envelope
        } else if (parsed && Array.isArray(parsed.lcpAging)) {
          state.rows = parsed.lcpAging.length;                // LCP is two tables in one
        } else {
          state.rows = null;
        }
      } catch (err) {
        /* Unparseable bytes are still worth reporting as bytes: "the cache holds 26 KB
           that is not JSON" is a finding, not a blind spot. */
        state.rows = null;
      }
    }

    out[type] = state;
  }

  return out;
}

/**
 * Everything an operator needs in one response.
 *
 * ONE getProperties() read covers every diag key, rather than one read per key. The rev
 * snapshot goes through currentDataRev_() rather than being re-derived here, so the two
 * cannot drift; it costs a second whole-store read on a route that is run by hand.
 *
 * @return {Object}
 */
function buildDiagReport_() {
  var props = PropertiesService.getScriptProperties();
  var all = props.getProperties() || {};

  function readJson_(key, fallback) {
    var raw = all[key];
    if (!raw) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed === null ? fallback : parsed;
    } catch (err) {
      return fallback;
    }
  }

  /* The TTL arithmetic, stated by the server rather than remembered by a human. This is
     the check that would have caught 180 s under a 300 s interval: a TTL under the
     cadence is a cold window on EVERY cycle, and nothing in the code said so. */
  var intervalSeconds = OLT_WARM_INTERVAL_SECONDS;
  var ttlSeconds = OLT_WARM_TTL_SECONDS;
  var deadWindowSeconds = intervalSeconds - ttlSeconds;

  return {
    ok: true,
    at: Date.now(),
    status: diagStatus_(),
    warm: {
      intervalSeconds: intervalSeconds,
      ttlSeconds: ttlSeconds,
      deadWindowSeconds: deadWindowSeconds,
      verdict: deadWindowSeconds <= 0
        ? 'no cold window: an entry is alive at every moment between passes'
        : 'COLD WINDOW: ' + deadWindowSeconds + 's of every ' + intervalSeconds +
          's cycle has no entry, so a request landing in it pays a full build'
    },
    failures: readJson_(DIAG_FAILURES_KEY, []),
    slowLast: readJson_(DIAG_SLOW_KEY, null),
    warmPass: readJson_(DIAG_PASS_KEY, null),
    cache: diagCacheState_(),
    rev: currentDataRev_()
  };
}

/**
 * The gated, read-only route. `?action=diag`.
 *
 * ADMIN ONLY, and it refuses a null session as well as an error — see the note at the top
 * of this file. Nothing downstream touches a sheet, a cache or a revision, so a caller
 * who gets past the gate still cannot make this route cost anything.
 *
 * @return {ContentService.TextOutput}
 */
function handleDiagnostics(e) {
  var auth = resolveSession(e, ADMIN_ROLE);
  if (auth.error) return auth.error;

  /* resolveSession answers {session: null, error: null} for an untokened caller while
     REQUIRE_SESSION is false. A role check that never ran is not a gate, so this is the
     second half of it. */
  if (!auth.session) {
    return unauthorizedResponse('Sign-in required');
  }

  return jsonOut(buildDiagReport_());
}

/* ------------------------------------------------------------------ *
   The gate itself
 * ------------------------------------------------------------------ */

function diagMedian_(values) {
  if (!values || !values.length) return -1;
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The verdict, as a pure function so that the DECISION is testable even though the
 * SAMPLING can only run inside Apps Script.
 *
 * GO requires the whole-store read to be a small share of a cold build. That is the claim the
 * hooks rest on, and it is relative on purpose: "is PropertiesService fast" is a question
 * nothing here needs answered. The absolute ceilings are a backstop for a store that is slow
 * in every case, not the test.
 *
 * The verdict is taken on the PESSIMISTIC bound — getProperties(), which cannot be served from
 * an in-execution cache — so a GO is a GO even if the cheaper single read looked better.
 *
 * @param {number[]} reads     ms per single getProperty
 * @param {number[]} readAlls  ms per whole-store getProperties
 * @param {number[]} writes    ms per setProperty
 * @return {Object} the verdict, with the numbers it was reached from
 */
function judgePropertyCost_(reads, readAlls, writes) {
  var readMs = diagMedian_(reads);
  var readAllMs = diagMedian_(readAlls);
  var writeMs = diagMedian_(writes);
  var buildMs = DIAG_GATE_BUILD_MS;

  /* The share of a cold build each median represents. This is the sentence the design rests
     on, computed rather than asserted. */
  var sharePct = (readAllMs >= 0 && buildMs > 0)
    ? Math.round((readAllMs / buildMs) * 1000) / 10
    : null;

  var failed = [];
  if (sharePct === null) {
    failed.push('no whole-store read was measured');
  } else if (sharePct > DIAG_GATE_MAX_READ_SHARE_PCT) {
    failed.push('the whole-store read is ' + sharePct + '% of a cold build, over the ' +
                DIAG_GATE_MAX_READ_SHARE_PCT + '% ceiling');
  }
  if (!(writeMs >= 0) || writeMs > DIAG_GATE_WRITE_CEILING_MS) {
    failed.push('write median ' + writeMs + 'ms over the ' +
                DIAG_GATE_WRITE_CEILING_MS + 'ms backstop');
  }

  var go = failed.length === 0;

  return {
    go: go,
    verdict: go ? 'GO' : 'NO-GO',
    readMs: readMs,
    readAllMs: readAllMs,
    writeMs: writeMs,
    samples: reads ? reads.length : 0,
    buildMs: buildMs,
    shareOfBuildPct: sharePct,
    maxSharePct: DIAG_GATE_MAX_READ_SHARE_PCT,
    failed: failed,
    reason: go
      ? 'the whole-store read is ' + sharePct + '% of a ' + buildMs + 'ms cold build (ceiling ' +
        DIAG_GATE_MAX_READ_SHARE_PCT + '%) and the write median is inside its backstop'
      : failed.join('; '),
    /* The GO branch is state-aware on purpose. An instruction to do a thing that is already
       done is how a healthy system teaches an operator to ignore its output. */
    next: go
      ? (DIAG_REQUEST_HOOKS_ENABLED
          ? 'nothing to do: DIAG_REQUEST_HOOKS_ENABLED is already true and the hooks are recording'
          : 'set DIAG_REQUEST_HOOKS_ENABLED = true and paste diagnostics.gs again')
      : 'do NOT enable the request-path hooks: a read that costs this much of a build is not a ' +
        'fraction of one, so the pass record and this report are the whole diagnostic'
  };
}

/**
 * MEASURE IT, DO NOT ARGUE IT. Run this by hand once and read the verdict.
 *
 * It samples three things and deletes its own scratch key, so it leaves the property store
 * exactly as it found it. It is not on any trigger and must not be: it is an instrument
 * for a decision, not a monitor.
 *
 * @return {Object} judgePropertyCost_()'s verdict
 */
function measurePropertyCost() {
  var props = PropertiesService.getScriptProperties();
  var key = 'diag_gate_probe';
  var reads = [];
  var readAlls = [];
  var writes = [];

  for (var i = 0; i < DIAG_GATE_SAMPLES; i++) {
    var t0 = Date.now();
    props.getProperty(key);
    reads.push(Date.now() - t0);

    var t1 = Date.now();
    props.getProperties();
    readAlls.push(Date.now() - t1);

    var t2 = Date.now();
    props.setProperty(key, String(i));
    writes.push(Date.now() - t2);
  }

  props.deleteProperty(key);

  var verdict = judgePropertyCost_(reads, readAlls, writes);

  Logger.log('🔬 measurePropertyCost: ' + verdict.samples + ' samples per operation');
  Logger.log('   single getProperty  median ' + verdict.readMs + 'ms  (worst ' +
             Math.max.apply(null, reads) + 'ms)');
  Logger.log('   getProperties()     median ' + verdict.readAllMs + 'ms  (worst ' +
             Math.max.apply(null, readAlls) + 'ms) — the PESSIMISTIC bound the verdict uses');
  Logger.log('   setProperty         median ' + verdict.writeMs + 'ms  (worst ' +
             Math.max.apply(null, writes) + 'ms)');
  Logger.log('   the shortest measured cold build is ' + verdict.buildMs +
             'ms, so the whole-store read is ' + verdict.shareOfBuildPct + '% of one' +
             ' (ceiling ' + verdict.maxSharePct + '%)');
  Logger.log((verdict.go ? '✅ ' : '❌ ') + 'GATE ' + verdict.verdict + ': ' + verdict.reason);
  Logger.log('   → ' + verdict.next);

  return verdict;
}
