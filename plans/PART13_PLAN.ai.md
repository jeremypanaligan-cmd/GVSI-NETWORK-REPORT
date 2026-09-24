@PlannablePlan v0.1

Part: PART-013 — one judge for every warm build
Project: GVSI NetPulse
Phase: 6

DICT
  judge   = judgeWarmResponse_(label, content, elapsed, ttl), the single place that decides
            whether a build warmed anything
  envelope = the origin's answer to a failed build: {error:"build_failed", retryable:true},
            returned with HTTP 200 and a valid body

G
  OLT is the module the three-second budget can actually miss, and it is the only one whose
  warm result nobody checked. After this change every build in the pass is judged by the same
  code, so a green line in the Executions log means a cache entry was written — for OLT too.

CTX
  PART-012 added the pass with isBuildErrorEnvelope_() and per-type error reporting, and left
  warmOltCache() byte-identical on purpose: it is covered by the olt-warm-ttl suite, and
  rewriting a tested function in the same change that adds its replacement is how a rename
  turns into a rewrite. That left an asymmetry with consequences rather than cosmetics:

    - warmOltCache logged "✅ OLT cache warmed in 40ms (74 bytes)" for a build that failed.
    - warmDataCaches counted OLT as rebuilt because it "did not throw", so a failed OLT build
      printed "5 of 5 module(s) rebuilt" with nothing under FAILED:.
    - Both lies are in the log an operator reads to size the cadence, and OLT's build time is
      the one number in that log that is actually measured.

C
  - A failed build does NOT throw. code.gs catches it and answers the envelope with a 200, so
    "did anything throw" is not a test of anything and must not be the pass's counter.
  - One judge, not two. warmOltCache keeps stating shape=3 and OLT_WARM_TTL_SECONDS itself —
    that is what the existing assertions are about — but it does not keep its own verdict.
  - The detector must not overreach. OLT's payload is an object envelope that starts with a
    brace, exactly the shape the detector looks for, so a "real build is still a success"
    assertion is not decoration: it is what stops the check from reporting every healthy run
    as a failure.
  - warmOltCache returns a value now (ms, or -1). Nothing in production read it before; the
    pass does, and that is the whole mechanism of the corrected count.
  - No client bytes. No version bump, no sw.js cache-generation move, no PWA update path.

F
  olt-cache-warmer.gs       + judgeWarmResponse_(); warmOltCache() and warmTypeCache_() both
                            report through it; warmDataCaches() counts OLT from its verdict;
                            the asymmetry note in the docstring replaced by what is now true
  tests/olt-warm-ttl.test.js    + two assertions: an envelope is a failure with no success
                                line; a real build is still a success and still writes
  tests/cache-warmer.test.js    + one assertion: a pass whose OLT build fails names OLT and
                                counts "4 of 5"
  plans/PART13_PLAN.ai.md   this artifact
  MASTER_PLAN.md            Part 13
  PLAN_EVIDENCE.md          PART-020
  TODO.md, .freebuff/run.md the log lines an operator will actually see

T
  1. Add judgeWarmResponse_() beside isBuildErrorEnvelope_().
  2. Route warmOltCache() and warmTypeCache_() through it; return -1 from warmOltCache's catch.
  3. Count OLT in warmDataCaches() from the warmer's return value, not from the absence of a
     throw.
  4. Add the three assertions, then run all 16 suites.
  5. Mutation pass: 5 mutations, each naming the assertion that must catch it, with a green
     baseline in the workspace first.
  6. Update the docs that recorded the asymmetry as open.

VALIDATION
  - A mutation that removes "return -1" from the judge, and one that bypasses the judge from
    warmOltCache entirely, are both caught by the OLT envelope assertion.
  - A detector that returns true unconditionally is caught by the "real build is a success"
    assertion.
  - Counting OLT from "did not throw" is caught by the "4 of 5" assertion.
  - The throw path is still named: dropping failed.push('olt') is caught too.

DONE
  Built, tested and mutation-checked in the repo. One judge for all five builds; warmOltCache()
  keeps shape=3 and its own TTL constant; the pass counts what it rebuilt.

  262 tests across 16 suites, 0 failed (259 -> 262, 3 new). 5/5 mutations caught, 0 missed,
  0 unproven, baseline green in the mutation workspace before any mutation was believed.

  Still not run: the Apps Script hand-off. The pass is in the repo and the live project still
  runs the old warmer until olt-cache-warmer.gs is pasted and warmDataCaches() is run by hand.

  Still not fixed: the 21 s origin 404 behind "Error loading data." No amount of warming
  touches an error path.
