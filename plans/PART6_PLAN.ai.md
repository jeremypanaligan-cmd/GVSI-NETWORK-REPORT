@PlannablePlan v0.1

ID=PART-006
PH=LUCIDE_ICON_SYSTEM
SCN=SCN-004,SCN-005
OUT=Every module's icons are Lucide, via a helper that survives re-render
DEP=[PART-004]

DICT:
G=goal; CTX=context; C=constraint; F=file(+=new, ~=modified, ?=maybe); T=task; AC=acceptance; V=verify; DONE=completion; S=stop

G:
- The 26 icons in the module scripts are Lucide, and the six duplicated export pairs become one call.

CTX:
- product: GVSI NetPulse — offline-first PWA whose tables are rebuilt with innerHTML
- phase: Lucide icon system (part 3/5)
- prior: PART-004 generated the subset; PART-005 did the shell
- next: PART-007 aligns sizes and colours in CSS
- these modules re-render whole tables on every refresh, so icons must be inline in the
  template strings — a one-shot createIcons() pass would leave them empty after a repaint

C:
- preserve-existing-work
- avoid-unrelated-edits
- ask-before-new-deps
- call lucide.icon() inside the template strings; do not add a re-initialisation hook
- keep every existing class name, id and onclick unchanged

F:
~ nap-module.js
~ lcp-module.js
~ olt-module.js
~ node-module.js
~ backbone-module.js
~ analytics-module.js
~ admin-module.js
~ notifications.js

T:
1 Export CSV -> download (14px) and Export PDF -> file-text (14px) in all six places.
2 Node and Backbone empty states: shield-check (40px), one language, no hardcoded stroke.
3 OLT zero state: circle-check-big (32px); the same icon serves the missing-data variant.
4 Analytics insight tiles: monitor, layers, server, shield, link (24px) and its export icon.
5 Admin: wrench (24px, maintenance), circle-slash, circle-check (16px), wrench (72px overlay).
6 Notifications: bell / bell-off (14px) — the filled bell becomes the same stroke set.

AC:
- No hand-drawn <svg> is left in any module script.
- Every call names an icon that exists in the generated table.
- A repaint produces the icons again, with no extra call site.

V:
- node tests/icons.test.js
- node tests/olt-empty-state.test.js
- for t in tests/*.test.js; do node "$t"; done

DONE:
- update MASTER_PLAN.md Part 6=[x]
- append PLAN_EVIDENCE.md#PART-006: summary+files+checks+notes

S:
- if a module builds markup before lucide-icons.js loads, the script tag order is the bug, not a fallback
