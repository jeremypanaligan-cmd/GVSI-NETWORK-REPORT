@PlannablePlan v0.1

Part: PART-014 — the module that is failing, named from the server alone
Project: GVSI NetPulse
Phase: 7

DICT
  pass record = one property holding the last warm run: per-type build ms, built/of,
                failed[], and when it ran
  slow build  = a build that finished but exceeded DIAG_SLOW_BUILD_MS
  failure     = a build that could not run — code.gs answers {error:"build_failed"}
                with a 200 and throws nothing

G
  When a module is misbehaving, the server can say WHICH one, WHICH sheet and stage it
  died on, how long the build took, and whether its cache is even holding a payload —
  without a client release, without touching the request path, and without a new trigger.

CTX
  Measured and read before designing, not assumed:

    - The build path already records type, stage, sheet, rev and elapsedMs into buildCtx_
      (code.gs beginBuild_ / buildStage_ / openSheet_) and spends them on ONE
      "❌ Build failed | …" line that exists only on the Executions page. That is the
      whole of the missing capability: the facts exist and nothing can read them.
    - warmDataCaches ALREADY computes a per-type build time every run — it is why the
      warmers return their elapsed ms — and every one of those numbers is currently
      thrown away. The pass is the natural place to record build times, because it runs
      in its OWN trigger execution and therefore costs the operator nothing.
    - A cache HIT returns at the top of doGet's cache block, before any build. So
      anything placed at the END of a build is paid only on a MISS.
    - Properties read/write is metered at 50,000/day, and this project has already been
      bitten by that once: the session sweep was moved off the hot path for exactly this
      reason (see the note in admin.gs). The rev poll already spends ~14,000/day for ten
      devices out of the same budget.

C
  - NOTHING NEW ON THE REQUEST PATH THAT COSTS A READ. The version of this that was
    written and reverted recorded a sample after every successful build — one property
    read per build, on the coldest, slowest path in the app. That is the wrong place for
    a measurement, and it is the difference between "diagnostics" and "diagnostics that
    made the slow module slower".
  - A FAILURE is written every time: it is rare, and it is the sample being looked for.
  - A SLOW BUILD is written with NO READ AT ALL: the elapsed time is compared against a
    constant, and only a build over the threshold writes. Fast builds cost one compare.
  - BUILD TIMES ARE RECORDED BY THE PASS. One write per run (five modules), inside the
    trigger, and it is the only source of the four unmeasured build times.
  - The route is READ-ONLY: no sheet, no build, no rev bump, no cache write. Asking what
    is slow must be incapable of adding load.
  - The route is admin-gated with resolveSession(e, ADMIN_ROLE), AND refuses a null
    session as well as an error. resolveSession tolerates a tokened-out caller when
    REQUIRE_SESSION is false (phase 1 of the token rollout), and a role check that
    dereferences a null session is not a gate. NOTE, found while designing this: the same
    hole exists in handleSetMaintenance today, where the actor falls back to "unknown" —
    recorded here, not fixed here.
  - No new query parameter. The proxy forwards a whitelist and tests/proxy.test.js derives
    the expected set from the backend; `action` and `token` are already forwarded, so this
    needs no worker redeploy.
  - No new trigger and no client bytes: delivery is three files pasted into the editor.
    setupAllTriggers() is NOT required, and the release label does not move.

F
  diagnostics.gs            new. DIAG_* keys and thresholds, recordBuildFailure_,
                            recordSlowBuild_, recordWarmPass_, diagCacheState_,
                            buildDiagReport_, handleDiagnostics (admin-gated, read-only)
  code.gs                   + one route line; + recordBuildFailure_ in buildFailedOut_;
                            + recordSlowBuild_ at the end of the build (no read)
  olt-cache-warmer.gs       warmDataCaches keeps the per-type ms it already computes and
                            spends them on one recordWarmPass_ write per run
  tests/diagnostics.test.js new suite
  tests/{cache-invalidation,cache-warmer,olt-impact,olt-warm-ttl,origin-resilience}.test.js
                            one added load line each — see VALIDATION
  plans/PART14_PLAN.ai.md   this artifact
  MASTER_PLAN.md            SCN-016, SCN-017, Phase 7, Part 14
  PLAN_EVIDENCE.md          PART-021
  TODO.md, .freebuff/run.md where to curl it and how to read the report

T
  1. Write the plan artifacts.
  2. diagnostics.gs: the two recorders, the pass recorder, the cache-state reader, the
     report builder, and the gated route.
  3. code.gs: the route line, the failure hook, the slow-build hook.
  4. olt-cache-warmer.gs: capture per-type ms and write the pass record.
  5. tests/diagnostics.test.js — green before anything is pasted anywhere.
  6. Add the diagnostics.gs load to the five suites that run a build.
  7. Full suite, then the mutation pass with a green baseline in the workspace first.
  8. Docs, including the curl recipe and the quota arithmetic.

VALIDATION
  - ONE MEASUREMENT FIRST, because its absence is why the previous attempt was wrong:
    time a single PropertiesService read and write in a manual run (two Logger lines),
    so "a property read is a fraction of a 1.5 s build" stops being a hypothesis. If it
    is not a fraction, the hooks do not ship.
  - The route: no token, a valid NON-admin token, and an admin token — the first two
    must come back unauthorized and carry none of the internals.
  - Read-only, asserted: the diag request reads NO sheet, writes NO cache entry and
    moves NO revision.
  - A failed build reports stage and sheet; a build over the threshold reports its ms and
    is silent below it; two failures are both visible.
  - A recorder that THROWS does not break the build, because this runs inside doGet.
  - The five suites that load code.gs must load diagnostics.gs too. NOT OPTIONAL, and the
    reason is the interesting part: the slow-build hook sits inside doGet's cache
    try/catch, so a missing file is swallowed and the suite stays GREEN while the hook is
    dead. The failure hook is outside it and fails loudly. One of the two would have been
    a silent lie.
  - curl, from outside: `?action=diag` with a real admin token, and `?type=nap` before and
    after a paste to show the response bytes and time are unchanged on the hit path.
  - Mutation pass: each new assertion must have a mutation it catches.

DONE
  Not built yet. This artifact is the plan; nothing in it has been implemented or pasted.

  Deliberately NOT in this part, and each for its own reason:
    - the client half (sampling every call in fetchWithRetry, the edge's origin-ms and
      attempt count, the Module Health card, the copyable report). That is a release, with
      a version bump and an update path across seven devices, and it answers a different
      question: what THIS phone waited on.
    - the 21 s origin 404. Still the largest single source of a bad experience in this
      system. Nothing here touches an error path.
