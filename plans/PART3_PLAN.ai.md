@PlannablePlan v0.1

ID=PART-003
PH=OLT_ZERO_STATE
SCN=SCN-003
OUT=Tests, responsive/dark verification, and the deferred release are recorded
DEP=[PART-001, PART-002]

DICT:
G=goal; CTX=context; C=constraint; F=file(+=new, ~=modified, ?=maybe); T=task; AC=acceptance; V=verify; DONE=completion; S=stop

G:
- The zero view can be trusted, and the work can actually be delivered later.

CTX:
- product: GVSI NetPulse — a PWA dashboard for network operations
- phase: OLT zero state (part 3/3)
- prior: PART-001 built the component and fixed the two early-return defects; PART-002 added the per-filter copy
- next: delivery — a release that moves the label or the cache generation
- tests run as plain node scripts (no runner, no root package.json); tests/olt-healthy-fleet.test.js is the vm-sandbox precedent

C:
- preserve-existing-work
- avoid-unrelated-edits
- ask-before-new-deps
- a test must fail when the behaviour it describes is reverted, or it is not evidence

F:
+ tests/olt-empty-state.test.js
~ TODO.md

T:
1 Seven cases: down = 0 shows the empty state and hides the table wrapper; down > 0 is the reverse with rows and the total row; each non-DOWN filter names itself; ALL with no rows gives the missing-data wording; legacy shape=1 with no meta still recognises the zero case from the rows; the ticker runs and the export buttons are disabled in the zero state; the numbers are not invented when meta is null.
2 Mutation check: revert each half of the change and confirm the case that covers it fails.
3 Browser verification by driving the module directly with a seeded payload — desktop, <=640px and <=340px (the card-view breakpoint), light and dark.
4 TODO.md: one line for the deferred release, with the reason (unversioned precache entries) and the command.

AC:
- node tests/olt-empty-state.test.js passes with all seven cases, and each fails under its mutation.
- for t in tests/*.test.js; do node "$t"; done reports no regression.
- node scripts/bump-version.mjs --check still exits 0 (no label moved).
- Screenshots exist for the three widths and both themes.

V:
- node tests/olt-empty-state.test.js
- for t in tests/*.test.js; do node "$t"; done
- node scripts/bump-version.mjs --check

DONE:
- update MASTER_PLAN.md Part 3=[x]
- append PLAN_EVIDENCE.md#PART-003: summary+files+checks+notes

S:
- do not move the release version in this part; record it in TODO.md instead
