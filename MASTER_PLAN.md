# MASTER_PLAN.md

## Product Goal

Give the OLT module an honest zero state: when nothing is DOWN, the tab says so in a
clean, themed, responsive card instead of an empty seven-column table.

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

## Notes

- Authored by hand from `templates/` — the `plannable` CLI is not runnable in this
  checkout (no `plannable/dist`, no `plannable/node_modules`, no root `package.json`, no
  `plannable` on PATH). Do not assume `plannable create` / `plannable complete` work
  here; a part is complete when its evidence is in `PLAN_EVIDENCE.md`.
- Delivery is deliberately **not** part of Phase 1. `styles.css` and `olt-module.js` are
  unversioned precache entries, so this work reaches an installed device only when the
  release label or the cache generation moves with it — see TODO.md, which now carries
  the measured proof of that rule.
