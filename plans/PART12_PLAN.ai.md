@PlannablePlan v0.1

Part: PART-012 — the cold build removed from every module, not just OLT
Project: GVSI NetPulse
Phase: 6

DICT
  warm pass = one clock run of warmDataCaches(), which rebuilds every module's cache entry
  floor     = ~1.1 s, Apps Script startup + the 302 -> googleusercontent echo hop, paid by
              every request whether it hits the cache or not
  secondary = nap, lcp, node, backbone — the four modules with no warmer today

G
  A fresh app open is answered from the cache for every module instead of paying a cold
  build — so the data appears in about the time the app needs to draw it, not the time the
  spreadsheet needs to be re-read.

CTX
  Only OLT is warmed (warmOltCache, every 5 min). The other four rely on real traffic: the
  app prefetches all five on every load, so the only gap is the FIRST request after an idle
  period. Measured: OLT cold 2.97 / 3.21 s against a warm hit 1.09-1.52 s, with a cold-ish
  five-module burst at 3.235 s and a warm five-module burst at 1.156 s. Users open this app
  for about three minutes at a time and then close it, which is exactly the shape that pays
  a cold build on every session.

C
  - The floor is the bound. ~1.1 s of every call is startup plus the echo hop, and no amount
    of warming removes it. The gain is the BUILD, not the request.
  - warmOltCache() must stay byte-identical. tests/olt-warm-ttl.test.js asserts its TTL, its
    shape, its interval and the rebuild intent through it; a rewrite would move the meaning
    of five assertions to make room for new ones, which is not a trade this change needs.
  - One function, one trigger entry, sequential. Parallel builds contend on the same
    spreadsheet, and the app already learned this with the echo endpoint's 404s under
    parallel hits. In-process warm calls do not go over HTTP, but the contention is real.
  - TTL stays BELOW the interval. That is the rule this project fixed a real 11-minute
    incident with: with TTL > interval a hit can be served for longer than one cycle, and a
    dead warmer decays to stale instead of slow-but-current. TTL >= interval would guarantee
    a hit on every open, and it is the one-line change to make IF the day-1 log shows the
    four extra builds are as expensive as OLT's — which is unmeasured, so it is not taken.
  - A warm run must not touch the rev. bumpDataRev_ belongs to invalidateDataCache_ alone;
    a warmer that moved it would send every open dashboard to the sheet for nothing.
  - CacheService and PropertiesService are scoped to the SCRIPT, not the spreadsheet. This
    is why the warming has to happen inside the same project as the invalidation.

F
  olt-cache-warmer.gs            + SECONDARY_WARM_TYPES, SECONDARY_WARM_TTL_SECONDS,
                                 warmTypeCache_(), warmDataCaches(); header gains the cost
                                 table and the per-module build log format
  triggers.gs                    TRIGGER_PLAN: warmOltCache -> warmDataCaches (clock, every
                                 5 minutes); the SCHEDULE header line
  tests/cache-warmer.test.js     new suite, ten assertions
  tests/triggers.test.js         EXPECTED_PLAN: one entry added, one renamed
  tests/olt-warm-ttl.test.js     warmPlanEntry() resolves the entry that owns the OLT cadence
  plans/PART12_PLAN.ai.md        this artifact
  PLAN_EVIDENCE.md               PART-019, with the real per-type milliseconds
  TODO.md                        the P3 warmer item, closed with its numbers and its retune
  .freebuff/run.md               the .gs paste list and how to read the warm pass log

T
  1. Add the warm pass to olt-cache-warmer.gs without touching warmOltCache().
  2. Point TRIGGER_PLAN at it, and update the header table that records the schedule.
  3. Write the suite: order, params, per-type TTL, key identity, warm-then-hit, isolate the
     failures, the interval tie, shape=4 untouched.
  4. Update the two existing suites that state the plan, deliberately.
  5. Full suite green, then the mutation pass with a green baseline in the mutation
     workspace first.
  6. Paste both .gs files, run warmDataCaches() by HAND once before any trigger is touched,
     and read the five log lines. The interval is decided there, not here.

AC
  - One doGet per type, in the order olt, nap, lcp, node, backbone, one execution.
  - Non-OLT types carry no shape parameter; only OLT is warmed with shape=3.
  - A warm run followed by an HTTP call for the same type is a HIT with zero sheet reads.
  - The key a warm run writes is the key an HTTP caller reads, per type.
  - A throw in one type's build does not stop the rest, and the failure names its type.
  - The interval constant equals the TRIGGER_PLAN cadence, read as data.
  - Per-type TTL < interval, and interval <= 300 s. shape=4 is never warmed.
  - No client file changes, no version bump, no sw.js cache generation move.
  - Full suite green; no mutation surviving unproven.

V
  - `node tests/cache-warmer.test.js` -> 13 passed (all of them new; 3 more than sketched,
    see DONE)
  - full suite -> 259 passed across 16 suites, 0 failed (246 -> 259)
  - mutation check -> 15 caught, 0 missed, 0 unproven, baseline green first
  - NOT YET RUN (needs the Apps Script hand-off, which is a manual paste):
    `warmDataCaches()` by hand -> five per-type lines with the real build times
    `listTriggers()` -> "In sync" with warmDataCaches at every 5 minutes
    curl per type right after a warm run: the byte count equals the logged size, and the
    time sits at the floor instead of a cold 2-3 s

NOT
  - The 21.07 s origin 404 and the red "Error loading data." row. Warming cannot touch an
    error path, and this is the largest single source of a bad experience in the system.
  - Staleness visibility for the four new types: only OLT carries meta.builtAt, so the chip
    still falls back to when we ASKED for these four. An envelope for four bare-array
    payloads is a client release.

DONE
  Built and tested in the repo. One clock entry point, warmDataCaches, on the existing 5-minute
  cadence; warmOltCache() left byte-identical; per-type try/catch and an error-envelope check
  that turns a silent 74-byte "success" over an empty cache into a named failure.

  Three assertions more than planned, and each for a reason: a pass where OLT throws still warms
  the four behind it; the pass touches no revision counter and spends no forced-rebuild claim;
  and the error-envelope assertion was split from the throwing-sheet one, because the two fail by
  different mechanisms and a single test covering both would have passed while one was broken.

  No client bytes changed: no version bump, no sw.js cache-generation move, no PWA update risk.
  The client-side half of the three-second goal (the 21 s error path, and instant first paint from
  the device's last good payload) is out of scope here by the user's choice and stays queued.

  Open at the time, recorded rather than fixed: warmOltCache still logged success when its build
  answered with an error envelope. It predated the check, and rewriting a function in the same
  change that adds its replacement is how a rename turns into a rewrite.

  CLOSED by plans/PART13_PLAN.ai.md. The rewrite was its own change, on its own day, with the
  mutation pass re-run — which is the point of having deferred it rather than bundled it.
