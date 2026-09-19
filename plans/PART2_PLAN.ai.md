@PlannablePlan v0.1

ID=PART-002
PH=OLT_ZERO_STATE
SCN=SCN-002
OUT=Every empty filter is covered with its own copy
DEP=[PART-001]

DICT:
G=goal; CTX=context; C=constraint; F=file(+=new, ~=modified, ?=maybe); T=task; AC=acceptance; V=verify; DONE=completion; S=stop

G:
- A filter that matches nothing names that filter, and missing data is never called healthy.

CTX:
- product: GVSI NetPulse — a PWA dashboard for network operations
- phase: OLT zero state (part 2/3)
- prior: PART-001 built the component and the DOWN copy
- next: PART-003 adds tests and verification
- the filters reaching this table are ALL, DOWN, LOW POWER, UPLINK DOWN, DEGRADATION; UP routes to the healthy fleet panel instead

C:
- preserve-existing-work
- avoid-unrelated-edits
- ask-before-new-deps
- keep one component and one markup shape; only the copy varies by filter

F:
~ olt-module.js

T:
1 Add a copy map keyed by filter: LOW POWER / UPLINK DOWN / DEGRADATION give title "No {LABEL} OLTs" and a lede saying nothing in the snapshot matches that filter.
2 ALL with zero rows is the missing-data case: "No OLT data in this snapshot", telling the operator to REFRESH — it must NOT reuse the healthy wording, because filtered.length === 0 on ALL means no rows arrived at all.
3 DOWN keeps PART-001's copy and is the only filter that gets the metrics row and the CTA.
4 Give the empty state role="status" and aria-live="polite"; the icon SVG is aria-hidden="true" so the message text carries the meaning.

AC:
- Each of the three non-DOWN incident filters shows its own label in the title.
- ALL with zero rows shows the missing-data wording, not "no Down OLT".
- The empty state carries role="status" and aria-live="polite".
- No filter shows a healthy claim over missing data.

V:
- node tests/olt-empty-state.test.js
- for t in tests/*.test.js; do node "$t"; done

DONE:
- update MASTER_PLAN.md Part 2=[x]
- append PLAN_EVIDENCE.md#PART-002: summary+files+checks+notes

S:
- if a filter can reach the table that this map does not name, fall back to a generic sentence rather than the DOWN copy
