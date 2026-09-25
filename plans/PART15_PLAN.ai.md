@PlannablePlan v0.1

Part: PART-015 — the opening is one request, and the warm TTL stops leaving a cold window
Project: GVSI NetPulse
Phase: 8

DICT
  cold window = the seconds of a warm cycle in which no cache entry exists at all, so a
                request that lands there pays a full build instead of a hit
  the opening = what the app spends before an operator sees data: one request for nap on
                load, then one more for each of the other four on its first tab visit
  floor       = ~1.1-1.5 s of Apps Script startup plus the 302 -> googleusercontent echo
                hop, paid by every request whether it hits the cache or not

G
  The app stops being slow to show anything, for a reason that is stated as arithmetic rather
  than as an opinion: a warm cycle has no moment without an entry, and the whole opening
  arrives in one round trip instead of four or five.

CTX
  Reported by the operator as "sobrang tagal ng paglabas ng data sa app — LCP, NAP, BACKBONE
  kadalasan itong nangyayari". Measured and read before designing, not assumed:

    - olt-cache-warmer.gs writes a 180 s entry on a 300 s cadence. 180 under 300 leaves
      120 s of every cycle with NO entry: 40% of the time, all five modules cold. That is
      not a bug that slipped in — it is the trade PART-012 argued for explicitly in the
      file's own header, chosen while the four secondary build times were still unmeasured.
    - The pass log (.freebuff/run.md) gave the four unmeasured builds after all: nap 1310 ms,
      lcp 1290 ms, node 1740 ms, backbone 1660 ms, olt 3120 ms, ~9.1 s for the pass.
    - Payload sizes are trivial: 629 + 742 + 512 + 1980 + 1640 = 5,503 bytes for all five.
      So the opening was spending ~6 s of protocol overhead to move 5.5 KB.
    - index.html fetches ONE module on load. `prefetchOtherTabsInBackground()` — the sweep the
      warmer's own comments credit with covering the other four — is DEAD CODE: defined at
      index.html:1250 and called from nowhere. Its 5 s timer was also the only caller of the
      daily snapshot writer, so that had silently stopped running too.
    - A cache HIT returns at the top of doGet's cache block, before beginBuild_(). Everything
      at the end of a build is therefore paid only on a MISS.

C
  - THE TTL MUST OUTLIVE THE CADENCE. Freshness is the cadence, not the TTL: every warm run
    rebuilds unconditionally and overwrites, so a hit can never be older than one interval
    whatever the TTL says — a claim tests/olt-warm-ttl.test.js already asserts. That leaves
    the TTL exactly one job, bounding the degraded case (a dead trigger), and a TTL below the
    interval therefore buys nothing except a guaranteed cold window on every cycle. 330 s
    clears the 300 s interval by 30 s, which is the tolerance for a late run: the LAST write
    of a pass lands ~9.1 s in, so the binding constraint is interval - pass_duration.
  - SHORTENING THE CADENCE IS NOT THE ANSWER. The pass is a full rebuild of five modules; two
    minutes would be ~109 min/day against the documented 90 min/day trigger quota. The
    arithmetic is asserted in two suites so this cannot be re-litigated by accident.
  - THE OPENING BECOMES ONE REQUEST, READ-ONLY. `?action=bundle` answers all five from cache
    in one execution. It never builds, never opens the spreadsheet, never writes a cache
    entry and never moves a revision — so asking for everything is incapable of adding load.
    A version that built its missing modules inline would be a second, slower copy of the
    request path and would put up to five builds between an operator and the screen.
  - THE CLIENT HALF FAILS OPEN, ALWAYS. A missing route, an unknown-action envelope, a
    rejection, a hang, a wrong-shaped payload, a type this build has no module for — every
    one resolves to "load the modules the way this app did before the bundle existed". That
    is what makes the deploy order irrelevant and the change reversible by one <script> tag.
  - SHAPE IS CHECKED WHERE IT IS STORED. OLT goes through the module's OWN applyOltPayload(),
    and the four table modules are checked for the shape their loaders insist on. This app has
    already shipped the bug this prevents: an OLT prefetch stored the raw compact envelope
    where a decoded row array belongs, leaving the tables and the summary cards describing
    two different payloads.
  - THE GATE IS TOLD. A hydrated type is stamped in fetchGate, or the module's own loader sees
    no fetch history and goes straight back to the network — the one request that replaced
    five followed by five more.
  - No new query PARAMETER: the proxy whitelists `action` and the value is free, so no worker
    redeploy. The route is additive, so it is exercised by the app only after the release.
  - The 21 s origin 404 is NOT touched. It is an error path, still open, and the bundle merely
    removes one of the conditions that trigger it (three concurrent cold builds).

F
  olt-cache-warmer.gs       the two warm TTLs 180 -> 330; the header paragraph that argued for
                            the opposite rewritten around the arithmetic; the pass keeps the
                            per-type ms it already computed
  code.gs                   cacheKeyFor_ / cacheTtlFor_ / propStampKey_ / dashboardShapeFor_
                            extracted so the two read paths cannot drift; handleBundle and its
                            route line; the two recorder call sites, both guarded
  diagnostics.gs            new. The gate, the recorders, the cache-state reader, the report
                            and the admin-gated read-only ?action=diag
  boot-bundle.js            new. The client half: hydrate, stamp the gate, or fall back
  fetch-gate.js             noteHydrated() — the bundle delivered this type
  index.html                boot-bundle.js loaded; renderTabFromCache(); the opening becomes
                            one request; the daily snapshot call moved out of the dead function
  sw.js                     boot-bundle.js added to STATIC_ASSETS
  tests/                    diagnostics (36), boot-bundle (18), bundle (16) new; the five
                            build-running suites load diagnostics.gs; two TTL assertions
                            inverted in place
  plans/PART15_PLAN.ai.md   this artifact

T
  1. Measure first: the property read/write gate, with a GO/NO-GO verdict, run by hand.
  2. Raise the warm TTLs to outlive the interval, and invert the assertions that encoded the
     old rule.
  3. Extract the three key/TTL rules, then add the read-only bundle route.
  4. Add diagnostics.gs and the three hooks; the request-path hooks ship OFF, and go ON once
     the gate has passed on the live project (it did, three runs, 1.9% / 2.7% / 2.9%).
  5. The client half: boot-bundle.js, wired into the opening with a fallback.
  6. Suites green, then the mutation pass with a green baseline first.
  7. Release: the six labels move together, the guard does not.

VALIDATION
  - `?action=bundle` returns all five parsed payloads; it opens no spreadsheet and writes
    nothing; a cold module is named in `missing`, never built; the keys it asks for are the
    keys doGet asks for; an expired PropertiesService entry is missing, not served, and not
    deleted; a payload that will not parse is reported missing rather than shipped broken.
  - The bundle's read cost is one CacheService.getAll for five modules, and a successful
    build reads exactly as many properties as it did before diagnostics.gs existed — measured
    by running the same build with and without the file, not by counting lines.
  - `?action=diag`: no token, a null session and a valid NON-admin token are all refused and
    leak nothing; an admin gets a report that opened no spreadsheet, wrote no cache entry and
    moved no revision; the report states the TTL arithmetic and names a cold window in
    seconds when there is one.
  - The gate's verdict is a pure function, so it is tested here: a whole-store read that is
    not a fraction of a build is a NO-GO, the verdict is taken on the pessimistic bound,
    and no samples at all is not a pass.
  - boot-bundle: one request; five hydrated; OLT only through its applier; wrong shapes and
    unknown types refused; a missing route, a rejection and a hang all fall back.
  - Every suite that runs a build loads diagnostics.gs — asserted, because the slow-build
    hook sits inside doGet and a missing file is swallowed there.
  - Mutation pass: each new assertion has a mutation it catches, on a green baseline first.
  - From outside: `?action=bundle` and `?action=diag` by curl; `?type=nap` before and after a
    paste; the warm pass log read for the per-type TTL.

DONE
  Built, tested and mutation-checked in the repo, 2026-09-26. 19 suites, 336 cases, 0 failed
  (262 -> 336). 51 mutations attempted across the four affected suites and every one is now
  caught — but three were MISSED on the first pass and all three were real defects rather than
  noise: a test harness whose "wrote nothing" view was a snapshot taken at sandbox creation,
  which made every such assertion vacuous; an untested half of the payload shape check; and the
  gate's own branch for an unmeasured read, which the all-empty case could never reach because
  the write backstop catches it first. One production bug was found by the suite: the OLT branch
  of the hydrate loop stamped the gate nowhere, so the one request that replaced five would have
  been followed by an immediate OLT refetch.

  The gate was run on the live project, and its first verdict was wrong about itself. The live
  store answered 25 ms / 25 ms / 51 ms — a whole-store read is 1.9% of a 1290 ms cold build, so the
  premise holds with room to spare — and the verdict printed NO-GO on two absolute thresholds
  that had been picked rather than measured, one of them by a millisecond, with a reason that
  said the measurement "is not a fraction of a build". The verdict is now the SHARE, the write
  keeps an absolute backstop, and the live numbers are pinned by a test so the calibration cannot
  drift back to guessing.

  Then it was run AGAIN twice more on the same idle store, nine and twenty-four minutes after the
  first: 35/35/53 ms at 2.7%, then 30/38/54 ms at 2.9% — **GO**, both. Every absolute number had
  moved up and the single-read median by 40%, so the discarded thresholds would have failed all three
  runs, by different amounts. That is a mis-set limit rather than a slow store, and it is why the 5%
  ceiling was chosen to clear the instrument's own spread — about 1.7x the worst reading — instead of
  sitting just above the first one. All three live readings are pinned by tests (one for each run, and
  one for the headroom ratio, which is the assertion a lowered ceiling would break), and the verdict
  also refuses to tell an operator to flip a switch that is already on.

  Run 3 corrected a claim as well: `getProperties()` was level with a single `getProperty` on the
  first two runs and DEARER on the third (38 vs 30 ms median, 102 vs 77 worst), so the note that said
  they cost the same was wrong. Nothing in the design changed — the verdict already read the
  pessimistic bound, which is the one that turned out to be expensive — but the record did.

  **DIAG_REQUEST_HOOKS_ENABLED ships `true`**, because it passed twice. That is deliberate rather
  than incidental: a copy flipped by hand in the Apps Script editor while the file still said
  `false` would silently turn the request-path hooks back off at the next paste, which is the same
  class of failure the hook guards in PART-021 exist to prevent. The version moved 3.9.20 -> 3.9.21
  with the guard left at 3.10.0.

  NOT YET DONE, and it needs the operator:
    - the paste: olt-cache-warmer.gs, then code.gs + diagnostics.gs (no triggers, no
      setupAllTriggers()).
    - the release push, so an installed device receives the new bytes.
    - the 60 s cacheTtl for node/olt/backbone on a CLIENT-built entry is untouched: it only
      matters once the warmer is dead, and it is a freshness trade of its own.

  Deliberately NOT in this part:
    - the client half of the diagnostics (a Module Health card): a release, and it answers a
      different question — what THIS phone waited on.
    - the 21 s origin 404: still the largest single source of a bad experience in this system.
