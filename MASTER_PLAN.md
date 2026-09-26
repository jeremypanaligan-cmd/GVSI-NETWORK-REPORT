# MASTER_PLAN.md

## Product Goal

Give the OLT module an honest zero state, and give the whole app one icon language in
which each module is recognisable at a glance — by shape and by colour.

## Product Scenarios

### SCN-001: No OLT is down
Outcome: The OLT tab shows a titled, themed empty-state card in place of the incident
table, while the stat cards, donut and filter strip stay on screen and keep reporting
the real fleet numbers.

### SCN-002: A filter matches nothing
Outcome: Each filter's empty state names that filter, and the "no data at all" case is
worded differently from "the fleet is healthy" — never a healthy claim over missing data.

### SCN-003: The dashboard is trustworthy on that screen
Outcome: The freshness chip keeps ticking and the export buttons go quiet, so the empty
view cannot look frozen or hand out an empty file.

### SCN-004: One icon language
Outcome: Every icon in the app — navigation, login, tables, empty states, badges and the
sort indicators — comes from Lucide and looks like one set, including the twelve export
icons that are currently drawn six times over.

### SCN-005: Icons survive the re-render and the theme
Outcome: Icons drawn into innerHTML templates stay correct on every repaint without a
second initialisation pass, and keep the size, alignment and colour the theme gives them.

### SCN-006: The swap is provable, and it ships
Outcome: A hand-edited or stale icon file, an unknown icon name, and a leftover
hand-drawn SVG all fail a test; the new bytes reach an installed device.

### SCN-007: A module is named the same way everywhere
Outcome: NAP, LCP, OLT, NODE, BACKBONE, the Dashboard and About each own one glyph, and
that glyph is identical in the phone bar, the desktop tab row and the Module Snapshot
cards — a module that looks like two things at once is unreadable at a glance.

### SCN-008: The tab you are on says so without looking pressed
Outcome: The current module is marked by a pill behind its glyph and by its own label,
not by a tint across the whole button — a full-button fill is what a press looks like.

### SCN-009: The desktop tab row still fits
Outcome: The tab row is `overflow-x: auto` with non-shrinking tabs, so anything added to
a tab must not push eight of them past a 747px window and make the header scroll.

### SCN-010: A module is identifiable without being the one you are on
Outcome: Every module carries its own hue on its glyph at rest — the module you are
looking for is found by colour, not by reading eight small outlines at 22px, which is the
step that shape alone cannot carry.

### SCN-011: The module hue never makes a claim it cannot make
Outcome: The hues are categorical and never read as status: a module's colour at rest is
the same whether it is healthy or failing, and the admin chip keeps the treatment its own
filled gradient needs.

### SCN-012: The all-clear card asks nothing of the operator
Outcome: On a screen whose whole message is "nothing is wrong", the card reports and
stops. It does not hand over a button that duplicates a control already on screen above it.

### SCN-013: Good news is legible, and never motion a preference refused
Outcome: The all-clear reads as a steady signal being watched rather than a box that was
ticked once; the pulse is the slowest thing on the page, stops entirely for
`prefers-reduced-motion`, and never beats over missing data.

### SCN-014: The first request after an idle period is answered from the cache
Outcome: Every module is rebuilt on a clock, not only OLT. An operator who opens the app
for three minutes and closes it is served a warm entry instead of paying a cold build, and
what remains of the wait is the ~1.1 s floor that no warming removes.

### SCN-015: A warm run reports what it actually warmed
Outcome: A build that fails answers with an envelope instead of throwing, so the pass names
the module it could not warm rather than logging a small byte count over an empty cache; one
module's failure never stops the four behind it, and the healthy fleet is never warmed.

### SCN-016: A failing module is named, without a client release
Outcome: An admin can ask the server which module is failing and get the same four facts
that exist today on one Executions log line — which sheet, which stage, which revision, how
long it had been running — plus whether that module's cache is even holding a payload. The
route reads nothing, builds nothing and moves no revision, so asking while something is
broken cannot make it worse.

### SCN-017: The cadence's own numbers are kept, and the request path pays nothing
Outcome: The per-type build times the warm pass already computes stop being discarded, so
the four never-measured build times become measurable without a synthetic load test. A
successful build stores nothing, a failed one always does, and a slow one is written with
no read at all — the measurement lives in the trigger that was already running rather than
in the request an operator is waiting on.

### SCN-022: A cold start shows the last session's data, and says how old it is
Outcome: A launch that cannot reach the deployment draws the previous session's payloads in the
first frame instead of a screen saying the report could not be loaded, because they are read
synchronously and before anything is asked for. Each one is shown only while it is younger than the
interval the app would have refreshed it on anyway, its age is reported rather than hidden, and a
type the page is not holding is kept rather than dropped — so a refresh that failed cannot cost the
next launch the copy it needs. Nothing is shown before login, and a device whose storage is
unavailable, full or corrupt behaves exactly as it did before this existed.

### SCN-021: A refresh that fails keeps the screen it already drew
Outcome: A module whose refresh fails — a stalled deployment, an HTTP status, a body that is not
JSON — leaves the rows already on screen exactly as they are, because those rows are the last
read that answered and nothing better is available. A failure never renders an all-clear, so a
read that never completed cannot put "All Backbone Links Operational" on the one screen whose
whole message is that nothing is wrong. A tab that has never drawn anything says the report
could not be loaded rather than claiming either, and the freshness chip goes on ageing, so the
kept data is never passed off as fresh.

### SCN-020: A stalled deployment is not asked three times
Outcome: A request whose attempt failed slowly — after seven seconds or more — is not retried,
because a retry fired inside a stall is guaranteed to land inside the same stall; the origin's
own `retryable:true` still outranks the rule, and the report says the budget was cut short
rather than looking like a budget that ran out.

### SCN-019: The wait is attributed to the module, on the device that felt it
Outcome: An admin can open one screen and see, per module, how long THIS device waited, how much
of that the origin spent and how much the phone and its network added, how many attempts each call
took, and what failed — measured by the calls the app was already making, held in memory, sent
nowhere. A missing measurement is reported as missing rather than drawn as zero, and opening the
screen costs no request and starts no timer.

### SCN-018: The app shows data without paying for it five times, and never lands in a cold window
Outcome: The opening is one request that answers every module the server already has warm and
names the ones it does not, so no tab's first visit costs a round trip of its own. The warm
TTL outlives the cadence it sits under, so no cycle contains a moment with no cache entry and
a request cannot land on a full build by timing. A payload a module would refuse is refused
rather than stored, and if the route is not there the app loads exactly as it did before it
existed — which is what makes the deploy order irrelevant.

## Phase 1: OLT zero state

- [x] Part 1: Read `plans/PART1_PLAN.ai.md`
  - Scenario: SCN-001
  - Outcome: Zero state renders, and the table returns when rows do
  - Evidence: PLAN_EVIDENCE.md#PART-001

- [x] Part 2: Read `plans/PART2_PLAN.ai.md`
  - Scenario: SCN-002
  - Outcome: Every empty filter is covered with its own copy
  - Evidence: PLAN_EVIDENCE.md#PART-002

- [x] Part 3: Read `plans/PART3_PLAN.ai.md`
  - Scenario: SCN-003
  - Outcome: Tests, responsive/dark verification, and the deferred release are recorded
  - Evidence: PLAN_EVIDENCE.md#PART-003

## Phase 2: Lucide icon system — COMPLETE (released 3.9.15)

- [x] Part 4: Read `plans/PART4_PLAN.ai.md`
  - Scenario: SCN-004, SCN-006
  - Outcome: A generated subset of the installed package, wired into the shell and precache
  - Evidence: PART-004 in `PLAN_EVIDENCE.md` — 30 icons in 12 KB against a 436 KB bundle,
    `icons:check` green, `data-lucide` scan over index.html

- [x] Part 5: Read `plans/PART5_PLAN.ai.md`
  - Scenario: SCN-004
  - Outcome: Every icon in index.html is Lucide, sort indicators included
  - Evidence: PART-005 in `PLAN_EVIDENCE.md` — 16 placeholders + 3 `iconMarkup()` calls,
    one hand-drawn svg left (the brand mark), sort mask injected once

- [x] Part 6: Read `plans/PART6_PLAN.ai.md`
  - Scenario: SCN-004, SCN-005
  - Outcome: Every module's icons are Lucide, via a helper that survives re-render
  - Evidence: PART-006 in `PLAN_EVIDENCE.md` — 26 sites in 8 files, `iconMarkup()` in the
    template string so a table repaint cannot wipe its own icons

- [x] Part 7: Read `plans/PART7_PLAN.ai.md`
  - Scenario: SCN-005
  - Outcome: One sizing rule, one stroke width scale, currentColor everywhere
  - Evidence: PART-007 in `PLAN_EVIDENCE.md` — one `.lucide-icon` rule, every existing
    per-component size rule left standing, measured stroke colours in both themes

- [x] Part 8: Read `plans/PART8_PLAN.ai.md`
  - Scenario: SCN-006
  - Outcome: Drift, typo and leftover-icon tests, browser proof, and release 3.9.15
  - Evidence: PART-008 in `PLAN_EVIDENCE.md` — 19 tests, 21/21 mutations caught, delivery
    measured in the preview, 6 labels moved to 3.9.15

**Two deviations, both recorded in `PLAN_EVIDENCE.md`:** the allowlist is 30 icons rather
than the 27 sketched here (the sort chevrons and `shield-check` were found while mapping the
sites), and `arrow-left-right` was dropped after the usage test proved nothing drew it.

## Phase 3: module identity — COMPLETE (released 3.9.16)

**Why this phase exists.** Phase 2 replaced 47 icons with the matching Lucide drawing and
kept the appearance deliberately — which is what "tumutugma" asked for, and it also meant the
migration was nearly invisible: about 40 of the 47 are the same drawing. The user's report was
"hindi kapansin pansin ang pagbabago sa mga icons", which is a correct reading of Phase 2 rather
than a fault in it. Asked how far to go, they chose module identity plus an active state.

- [x] Part 9: Read `plans/PART9_PLAN.ai.md`
  - Scenario: SCN-007, SCN-008, SCN-009
  - Outcome: One glyph per module everywhere, larger, with a pill on the active tab
  - Evidence: PART-009 in `PLAN_EVIDENCE.md` — a shared `MODULE_ICONS` map read by both nav
    bars and the analytics cards, the two bars' placeholders reconciled against it by test,
    194 tests, and 27/27 mutations caught

**The user's verdict on Part 9 was "hindi kapansin pansin ang pagbabago sa mga icons"** —
and it was correct, for a reason no test could see: at rest every module's glyph was the same
`#64748b` at 22px, so shape was the only carrier of identity and shape alone does not survive
that size. Measured before answering, `git rev-list --left-right --count origin/main...HEAD`
was `0 4` and the live site was still on 3.9.15, so the parity is: two causes, and the bigger
one was that none of it had been delivered yet.

## Phase 4: module colour — COMPLETE (released 3.9.16)

- [x] Part 10: Read `plans/PART10_PLAN.ai.md`
  - Scenario: SCN-010, SCN-011
  - Outcome: One hue per module on the glyph at rest, in both bars, in both themes, with the
    active pill painted from the same value
  - Evidence: PART-010 in `PLAN_EVIDENCE.md` — 7 hues declared once and read by three
    surfaces, 195 tests, 38/38 mutations caught, the admin chip proved still white in the DOM

## Phase 5: the OLT all-clear, reworked — COMPLETE (released 3.9.17)

**Why this phase exists.** The card PART-001 and PART-002 built was correct but over-equipped:
it offered "View All Healthy OLTs" on the one screen that has nothing to check, next to two
controls that already open the same list, and its mark was a tick inside a circle drawn inside
the card's own circle.

- [x] Part 11: Read `plans/PART11_PLAN.ai.md`
  - Scenario: SCN-012, SCN-013
  - Outcome: The card reports without a button, with a steady-signal glyph and a slow pulse
    that yields to `prefers-reduced-motion` and refuses to beat over missing data
  - Evidence: PART-011 in `PLAN_EVIDENCE.md` — 196 tests, 18/18 mutations caught, the pulse
    sampled live in both themes, `is-missing` proved still

## Phase 6: the warm pass — IN THE REPO, WAITING ON THE APPS SCRIPT HAND-OFF

**Why this phase exists.** OLT was the only module with a warmer. The other four relied on real
traffic — the app prefetches all five on every load — so the gap was the FIRST request after an
idle period, which is the whole of a session for an operator who opens this app for three minutes,
checks the picture and closes it. Measured: OLT cold **2.97 / 3.21 s** against a warm hit
**1.09–1.52 s**; a cold-ish five-module burst at **3.235 s** and the same burst warm at
**1.156 s**. The ask was *"i-warm ang apat pang module"*, and the stated goal was data on screen
within about three seconds.

**What this phase does NOT fix, stated before the work:** the intermittent **21 s origin 404**
that reaches a module as a red *"Error loading data."* row. That is an error path, not a cache
miss, and `TODO.md` already calls it the largest single source of a bad experience in the system.
Warming cannot touch it; it needs a client release and stays queued.

- [x] Part 12: Read `plans/PART12_PLAN.ai.md`
  - Scenario: SCN-014, SCN-015
  - Outcome: One clock trigger rebuilds all five modules in one execution, sequentially,
    OLT first; OLT's own warmer is left byte-identical, each type is wrapped on its own, and
    an error envelope is reported as a failure instead of a success
  - Evidence: PART-019 in `PLAN_EVIDENCE.md` — **259 tests across 16 suites** (13 new, 246 →
    259), **15/15 mutations caught, 0 missed, 0 unproven**, and the Apps Script hand-off
    checklist below, which has **not** been run yet

**Deviation, recorded rather than quietly taken:** the suite landed at **13 assertions** instead
of the 10 sketched in the plan. Two were added while writing it — a pass where OLT throws still
warms the four behind it, and the pass touches no revision counter and spends no forced-rebuild
claim — and one sketched assertion ("one module failing does not starve the four") was split,
because the throwing-sheet case and the error-envelope case fail by different mechanisms.

**No client bytes changed.** No version bump, no `sw.js` cache-generation move, no PWA update
path — this phase is a `.gs` paste plus one manual `setupAllTriggers()`.

- [x] Part 13: Read `plans/PART13_PLAN.ai.md`
  - Scenario: SCN-015
  - Outcome: OLT's own warmer reports through the same judgement as the other four, so a failed
    OLT build is named in the log instead of being logged as a success with a small byte count,
    and the pass counts what it rebuilt rather than what it attempted. This supersedes the
    "byte-identical" sentence in Part 12 — that was true of that change, and is not true of this
    one.
  - Evidence: PART-020 in `PLAN_EVIDENCE.md` — **262 tests across 16 suites** (3 new, 259 →
    262), **5/5 mutations caught, 0 missed, 0 unproven**

## Phase 7: module diagnostics, server side only — BUILT, NOT PASTED

**Why this phase exists.** The ask was *"dagdagan ng function ang admin module na kaya nitong
idetect ang module na nagca-cause ng pag bagal"*. The facts already exist and nothing can read
them: `buildCtx_` carries type, stage, sheet, rev and elapsed ms through every build and spends
them on one `❌ Build failed | …` line in the Executions log, and `warmDataCaches` computes a
per-type build time every five minutes and throws every number away.

**Why it is server-only.** The client half — sampling every call in `fetchWithRetry`, reading
the edge's `x-netpulse-origin-ms` and `x-netpulse-attempts`, the Module Health card — is a
release: a version bump and an update path across seven devices. This half is three files
pasted into the editor, reaches nobody's phone, and answers the question that a field report
actually asks first: which sheet and which module.

**The design decision that matters, and the mistake it corrects.** A first version of this
part recorded a sample after every successful build. That is one property read on the
coldest, slowest path in the app — a diagnostic that makes the slow thing slower. It is
removed by construction here: successes store nothing, failures always store, and a slow
build is written from a comparison against a constant with no read at all. Build times come
from the warm pass, which runs in its own trigger execution.

**What this phase does NOT do:** it does not fix the **21 s origin 404**, and it does not make
any module faster. It makes the next report attributable.

- [x] Part 14: Read `plans/PART14_PLAN.ai.md`
  - Scenario: SCN-016, SCN-017
  - Outcome: An admin-gated read-only `?action=diag` naming the sheet, stage, revision,
    elapsed time and cache state per module; a failure recorded whenever a build cannot run;
    a slow build recorded with no read on the hot path; and the warm pass keeping the
    per-type build times it already computes — all of it in one `.gs` paste, with no version
    bump, no client byte, no new trigger and no new query parameter
  - Evidence: PART-021 in `PLAN_EVIDENCE.md` — **336 tests across 19 suites** (74 new,
    262 → 336 for this part together with Part 15), **51/51 mutations caught** across both,
    and the gate **run on the live project THREE TIMES**: reads of 25 ms, 35 ms and 30 ms,
    writes of 51, 53 and 54 ms, and a whole-store read at **1.9%**, then **2.7%**, then
    **2.9%** of a cold build — which is the premise, confirmed with room. The first verdict
    printed NO-GO anyway, on absolute thresholds one of which failed by a millisecond; runs 2
    and 3 moved every number by up to 40% and would have failed those same thresholds again,
    which is what settled it. The verdict is now the share of a build, pinned to all three live
    readings by a test, and `DIAG_REQUEST_HOOKS_ENABLED` ships **true** — and run 3's own last
    line (`→ nothing to do`) proves the deployed `diagnostics.gs` carries that constant. The two
    hook CALL SITES live in `code.gs`, which the measurement cannot see; the `code.gs` paste and
    a `?action=diag` read are what settle those

**The gate is part of the deliverable, not a formality.** This part's whole cost model rests
on "a property read is a fraction of a build", which was a hypothesis until `measurePropertyCost()`
said otherwise. So the instrument ships with the feature, and the verdict is a pure function with its
own tests (a whole-store read that is NOT a fraction is a NO-GO; the verdict is taken on the
pessimistic bound; no samples at all is not a pass; the GO message does not tell an operator to do
what the file already does). The two request-path hooks shipped **off** until it passed. The pass
record and the report are not gated, because neither of them runs on a request.

**And the runs corrected the instrument rather than the design — and once, corrected the record of
what was measured.** The live store answered 25/25/51 ms — 1.9% of a cold build, so the premise holds
— and the verdict said NO-GO on thresholds that were absolute numbers nobody had measured against,
one of them by a single millisecond. Nine minutes later it answered 35/35/53 ms — 2.7% — and fifteen
minutes after that 30/38/54 ms — 2.9% — so those thresholds would have failed three times, by
different amounts, which is what a mis-set limit does and what a slow store does not. The third run
also broke a claim already written down: the whole-store read was **dearer** than a single-key one
(38 vs 30 ms, worst 102 vs 77), where the first two runs had them level. The note was corrected
rather than quietly edited. The verdict is now the share, which is the claim; the write keeps a
backstop because a write happens on a rare path rather than per read; all three live readings are
pinned by a test; and the ceiling is 5% rather than 3% so that it clears the worst of them by about
**1.7x** — enough that crossing it means the store changed.

**A silent-lie shape that was closed by construction.** The slow-build hook sits inside `doGet`,
so a suite that loads `code.gs` without `diagnostics.gs` exercises a hook that is inert and stays
green about it. Both call sites therefore check the function exists and log loudly when it does
not — and `tests/diagnostics.test.js` asserts that all five suites which run a build load the
file, because a convention is not enough for the failure that no test can see.

**The second half of this phase, and why the first half was not enough.** `?action=diag` could say
which module failed on which sheet at which stage, and it could not say what the operator waited.
Those are different questions with different fixes: a build that takes 3 s on the origin and 9 s on
a phone is not a slow module, it is a slow phone or a bad cell, and no server-side report can tell
them apart. So the edge's own timings — `x-netpulse-origin-ms` and `x-netpulse-attempts`, set by
the Cloudflare worker on every response and read by nothing until now — are recorded alongside this
device's wall clock, and the difference between the two is drawn per module.

**The constraint that shaped the card, not a caveat about it.** The proxy is OFF (`NETPULSE_PROXY`,
2026-09-15), so those headers are absent on every live call. Every sample therefore keeps `originMs`
as **null** when the edge did not say, the card counts how many samples had edge timing, and it says
in words that the edge numbers are unavailable. A missing origin time rendered as `0ms` would be the
silliest lie in this app's history and it is one `|| 0` away — there is a test whose whole job is
that coercion.

**Also recorded, not fixed:** `sw.js` still carries `API_PROXY_HOST = 'holy-cloud-1d7a...'` while
`index.html`'s `NETPULSE_PROXY` is blank, and both files' own comments say the pair must move
together. Leaving it set is the safe side of that drift — it is inert while the proxy is off, and
removing it while a human re-enables `NETPULSE_PROXY` is the direction that hands a wall display a
cached outage.

## Phase 7b: what the device waited — BUILT, NOT PASTED

- [x] Part 16: Read `plans/PART16_PLAN.ai.md`
  - Scenario: SCN-019
  - Outcome: `diag-store.js` records one bounded, in-memory sample per API call from the single
    function every call already passes through; the admin screen draws a Module Health table of
    wait p50/p95/worst, the origin's own median, the per-call overhead, retries, failures and the
    last error; absent edge timing is named rather than drawn as 0; and the recording is guarded on
    both sides of the request path so a diagnostics fault cannot spend a retry or fail a call
  - Evidence: PART-023 in `PLAN_EVIDENCE.md` — **384 tests across 20 suites** (48 new, 336 →
    384), **38/38 mutations caught**, the card **looked at in a browser** as well as drawn in a
    test (which is how a ten-column table was caught hiding three of its columns behind a
    scroll), and the release label moved to **3.9.22** with the guard untouched at 3.10.0

## Phase 8: the opening, and the cold window — BUILT, NOT PASTED

**Why this phase exists.** The operator reported the app being slow to show anything, LCP/NAP/
BACKBONE most often. Two causes, both arithmetic rather than mystery:

  - the warm pass writes a **180 s** entry on a **300 s** cadence, which leaves **120 s of every
    cycle with no entry at all** — 40% of the time, all five modules cold, and a request that
    lands there pays a full build instead of a hit. That was PART-012's deliberate trade, argued
    in the file, taken while the four secondary build times were still unmeasured;
  - the opening fetched ONE module on load and each of the others on its first tab click, so a
    session glancing at three tabs spent four round trips — each paying the ~1.1-1.5 s floor in
    full — to move **5,503 bytes** in total.

**The finding that chose the fix.** `prefetchOtherTabsInBackground()` — the sweep the warmer's
own comments still credit with covering the four secondary modules — **is dead code**: defined at
`index.html:1250`, called from nowhere. Its 5 s timer was also the only caller of the daily
snapshot writer, so that had stopped running without anything saying so.

**What is NOT done here.** The **21 s origin 404** is untouched (an error path; the bundle only
removes one of the conditions that trigger it), and the **60 s `cacheTtl`** a client-built
`node`/`olt`/`backbone` entry gets is left alone — it only matters once the warmer is dead.

- [x] Part 15: Read `plans/PART15_PLAN.ai.md`
  - Scenario: SCN-018, and SCN-014 (the wait a warm entry removes)
  - Outcome: The two warm TTLs (180 → 330) outlive the interval they sit under, with the
    arithmetic asserted in two suites instead of argued in a comment; `?action=bundle` answers
    all five modules in one read-only execution; `boot-bundle.js` hydrates them and falls back
    to the previous path on every failure; the release label moves with the bytes and the guard
    does not
  - Evidence: PART-022 in `PLAN_EVIDENCE.md` — **336 tests across 19 suites**, 51 mutations
    across Parts 14 and 15, and the hand-off still owed: two pastes and one push (the gate is
    closed — GO on two live runs, so the request-path hooks now ship enabled)

## Phase 9: what a stalled deployment does to a retry policy — SHIPPED in 3.9.23

**Why this phase exists.** The standing complaint is that the app takes too long to show
data, and the standing question is which module is to blame. Measuring from outside the
deployment on 2026-09-26 answers both, and neither answer is a module:

  - **No module is slow.** Fifteen module requests on the hit path answered in 1.06–1.40 s,
    which is the bare `?action=rev` floor — one property read. The stack is live and healthy:
    `?action=bundle` returns 3,607 bytes in **1.18 s**, `?action=diag` is gated and answers in
    1.54 s, `?action=rev` in 1.83 s.
  - **The deployment stalls**, and by the time an operator notices it does not matter which
    route they asked for: failures arrived as Apps Script's 8 KB error page at **7.5 s, 16.0 s
    and 30.8 s**, and once as a redirect chain that outlived a 40 s cap. `?action=rev` — one
    property read, 80 bytes, normally 1.8 s — took **16.0 s** inside the same window.

**The finding that chose the fix.** The app made every stall worse. Its retry fires after
250–750 ms of jittered backoff, against a stall that lasted at least 30 s and cleared within
60 s, so attempt 2 was guaranteed to land inside the same stall and cost another full one —
three times the wait, three times the load, on a deployment that was already struggling. The
same request 60 s later answered in 1.48 s, which is longer than `fetch-gate`'s 30 s ceiling
can wait, so waiting the stall out inside the request is not an option either.

**What is NOT done here.** The 21 s origin 404 is the same family and is still open — but it is
no longer anonymous, which is the first step. And the two `?action=` failures seen at night
were this stall, **not** a missing paste: `?action=definitelynothere` answers
`{"error":"Unknown action: …"}` in 1.71 s, so the dispatch is reachable and the route table
holds bundle.

- [x] Part 17: Read `plans/PART17_PLAN.ai.md`
  - Scenario: SCN-020
  - Outcome: A failed attempt that consumed 5 s or more ends the retry loop, with the
    threshold derived from the live numbers rather than chosen (above the slowest successful
    attempt measured — 3.23 s — and below the fastest failing one, 7.5 s); an origin envelope
    is excluded from the rule so `retryable:true` still gets its retry; the report says
    `origin stalled 30800ms, budget not spent`; the release label moves and the guard does not
  - Evidence: PART-024 in `PLAN_EVIDENCE.md` — **389 tests across 20 suites**, 10 mutations all
    caught. The push has since landed (3.9.24 carried it); the paste is still owed

## Phase 10: what a failed refresh is allowed to draw — SHIPPED in 3.9.24

**Why this phase exists.** Reported from the live app, twice, with screenshots: refreshing NAP left
its table reading *"Error loading data."* while its stat cards still showed the last read's numbers,
and refreshing BACKBONE left *"All Backbone Links Operational"* with five zeroes — on a tab whose
incidents had just been on screen. The operator's question was the right one: **why can the last
data not stay until the new data arrives?**

**Cause, and it is not the loading state.** The v3.9.5 rework already made gathering additive: the
chip is inserted at the top of the tab and clears nothing, so a read in flight leaves the table
alone. What empties the tab is the refresh's own contract. `refreshCurrentTab()` and
`backgroundRefresh()` set `dataCache[type] = null` BEFORE they ask, so the next read has to come
from the network — and a refresh that FAILED therefore had nothing left to draw. It fell through to
the module's fallback, which in NAP is an error row written over the table and in BACKBONE and NODE
is the all-clear screen. That screen then stays until the next success, which is why the gather chip
of a later cycle appears on top of an already-emptied tab: the two frames are not one moment but two.

**The two rules this phase writes down.** First, a failed read keeps what is already drawn — LCP and
OLT were already written that way (their catch only logs) and nothing had ever said so out loud.
Second, a failure never renders an all-clear: those screens claim the fleet is clear AND stamp the
current minute as the time it was checked, and a read that never completed can support neither. A
tab with nothing drawn yet gets a third, smaller answer instead — that the report could not be
loaded — which is the first time either screen has been willing to say it cannot see.

**What was deliberately NOT changed.** `dataCache` is still emptied by every refresh, and the kept
rows are still not written back into it. A cache hit renders without asking, so leaving the payload
there would let a tab click redraw stale data as though it had just been fetched; the next read has
to go to the network. This is a display rule, not a caching one.

- [x] Part 18: Read `plans/PART18_PLAN.ai.md`
  - Scenario: SCN-021
  - Outcome: A failed read keeps the drawn screen in NAP, BACKBONE and NODE (the three that did
    not already behave this way); a failure never draws an all-clear; a tab that has never drawn
    anything says so in `renderModuleUnavailable()`; the gathering chip still clears and the
    failure is still logged at the moment it happens; `dataCache` keeps its refresh contract, so
    the next read still goes to the network; the release label moves and the guard does not
  - Evidence: PART-025 in `PLAN_EVIDENCE.md` — **401 tests across 21 suites**, 4 mutations all
    caught, the keep rule verified in a real browser against the local server, and the hand-off
    still owed: the pastes on the server side (this part changes no server byte)

## Phase 11: the cold start, and what it may show before it knows — SHIPPED in 3.9.25

**Why this phase exists.** It is the second half of the report Phase 10 answers. PART-025 stopped a
FAILED read from blanking a tab, which covers every refresh in a running session — but a launch has no
screen yet, and the tab that has never drawn anything is exactly the one that says *"this report could
not be loaded"*. On a deployment that stalls for 7.5 s to 30.8 s, that is the first thing an operator
sees in the morning.

**The cause is structural, not a bug.** The module cache is in-memory only, so every launch begins
with nothing to draw and the first render waits on the network. The user's own words for what they
want are already in the phase's scenario: *habang hindi pa lumalabas ang latest data, ang last
fetched data muna ang nasa display*.

**What shipped.** `cache-store.js` writes each module's last good payload to `localStorage` — the
post-decode state each module reads, plus OLT's meta beside its rows, because OLT's list reads the
array and its cards read the meta and restoring one without the other puts numbers on screen that
disagree with the table under them. `loadInitialData()` restores it at the top, draws the visible tab
from it **before** awaiting the opening request, and starts a 30 s writer. The freshness chip is told
when each payload was fetched, so a restored table reports a real age instead of *"No data yet"*.

**The three things the written plan did not have.** (1) The writer must CARRY OVER a type the page is
not holding: a refresh empties `dataCache[type]` before it asks, so a snapshot in that window would
otherwise delete the copy the next launch needs — which is worst exactly when the read just failed.
(2) A stamp in the FUTURE has to be refused, or a clock that moved backwards yields an age that never
expires and an eternally-fresh stale screen. (3) Restoring is not enough — the first frame has to be
drawn from the snapshot rather than after the opening request, or the restored data arrives at the
exact moment it was meant to replace.

**What was deliberately NOT done.** No payload older than the app's own refresh cadence is restored
(nap 60 min, lcp 30, olt 15, node 10, backbone 10), the snapshot is cleared on logout so one user's
view is not handed to the next, and nothing is read before login — the restore sits inside a function
only reachable from `showApp()`.

- [x] Part 19: Read `plans/PART19_PLAN.ai.md`
  - Scenario: SCN-022, and SCN-021 (the failure rule it builds on)
  - Outcome: A cold start draws the last session's payloads in the first frame, per-type age caps
    judged against the app's own cadence, a future stamp refused, the gate seeded so the chip reports
    a real age, OLT restored with its meta and build stamp, the writer carrying over what the page is
    not holding, every storage failure failing open, and the release label moving with the new
    precache entry
  - Evidence: PART-026 in `PLAN_EVIDENCE.md` — **425 tests across 22 suites**, 15 mutations all
    caught (and one attempted mutation identified as a no-op rather than a gap), the cold start
    driven in a real browser against a stalling origin, and the hand-off still owed: the pastes on
    the server side (this part changes no server byte)

## Notes

- Authored by hand from `templates/` — the `plannable` CLI is not runnable in this
  checkout (no `plannable/dist`, no `plannable/node_modules` build, nothing on PATH). Do
  not assume `plannable create` / `plannable complete` work here; a part is complete when
  its evidence is in `PLAN_EVIDENCE.md`.
- Delivery is a step, not an afterthought: `lucide-icons.js` is an unversioned precache
  entry, so it reaches an installed device only when the release label moves with it.
  That rule is measured in TODO.md, not quoted from documentation — and it was measured
  again for this release, because `lucide-icons.js` is a file that did not exist in any
  generation a device is currently holding.
