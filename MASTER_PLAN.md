# MASTER_PLAN.md

## Product Goal

Give the OLT module an honest zero state, and give the whole app one icon language.

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
