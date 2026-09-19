@PlannablePlan v0.1

ID=PART-001
PH=OLT_ZERO_STATE
SCN=SCN-001
OUT=Zero state renders, and the table returns when rows do
DEP=[]

DICT:
G=goal; CTX=context; C=constraint; F=file(+=new, ~=modified, ?=maybe); T=task; AC=acceptance; V=verify; DONE=completion; S=stop

G:
- No OLT is down, so the OLT tab says so in a themed card instead of an empty table.

CTX:
- product: GVSI NetPulse — a PWA dashboard for network operations; OLT is one of five module tabs
- phase: OLT zero state (part 1/3)
- prior: none — this is the first part
- next: PART-002 covers the other filters and accessibility
- renderOltTable (olt-module.js) is reached from processAndRenderOlt and setOltFilter; the tab's static markup is index.html:310-391

C:
- preserve-existing-work
- avoid-unrelated-edits
- ask-before-new-deps
- reuse the existing tokens and component classes (.stat-card, .badge, .healthy-olt-cta); define no second visual language
- [hidden] is the single source of truth for "not on screen" (styles.css:5-15): toggle el.hidden, never inline style
- do not move the release version or commit in this part

F:
~ olt-module.js
~ styles.css
? tests/olt-empty-state.test.js

T:
1 In renderOltTable, create once an .olt-empty-state element inside #oltIssuesTableCard, beside .table-wrapper.
2 Encode the DOWN copy: title "No Down OLT Right Now"; lede saying every tracked OLT is reporting up and the panel fills itself the moment one drops; a metrics row (UP / tracked / 0 DOWN) read from oltMeta when present and counted from rows when it is null; and a "View All Healthy OLTs" CTA that reuses .healthy-olt-cta and calls loadHealthyOltList().
3 Extract ensureOltExportToolbar_() out of the tail of renderOltTable.
4 Drop the early return: on filtered.length === 0 hide .table-wrapper, show the empty state and disable both export buttons with an explanatory title/aria-label; otherwise the reverse. Always run the shared tail so fetchGate.refreshTicker('olt') runs in both branches.
5 styles.css: .olt-empty-state / -icon / -title / -desc / -metrics / -actions built from theme tokens, with body.dark-mode rules and a @media (max-width: 640px) block. Static, no animation.

AC:
- meta.down = 0 on the DOWN filter: .olt-empty-state visible, .table-wrapper hidden, tbody holds no rows.
- down > 0: the table is visible, the empty state hidden, rows and the filtered total row render.
- The empty card's UP / tracked / DOWN numbers agree with the stat cards above it.
- fetchGate.refreshTicker('olt') runs in both branches.
- The export buttons are disabled in the zero state and enabled otherwise.

V:
- node tests/olt-empty-state.test.js
- node tests/olt-healthy-fleet.test.js
- for t in tests/*.test.js; do node "$t"; done

DONE:
- update MASTER_PLAN.md Part 1=[x]
- append PLAN_EVIDENCE.md#PART-001: summary+files+checks+notes

S:
- if oltMeta and the rows disagree, follow oltMeta — it is what the stat cards show
- if a style needs a colour the theme has no token for, state it per mode instead of inventing one
