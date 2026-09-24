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

## Phase 7: module diagnostics, server side only — PLANNED

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

- [ ] Part 14: Read `plans/PART14_PLAN.ai.md`
  - Scenario: SCN-016, SCN-017
  - Outcome: An admin-gated read-only `?action=diag` naming the sheet, stage, revision,
    elapsed time and cache state per module; a failure recorded whenever a build cannot run;
    a slow build recorded with no read on the hot path; and the warm pass keeping the
    per-type build times it already computes — all of it in one `.gs` paste, with no version
    bump, no client byte, no new trigger and no new query parameter
  - Evidence: PLAN_EVIDENCE.md#PART-021

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
