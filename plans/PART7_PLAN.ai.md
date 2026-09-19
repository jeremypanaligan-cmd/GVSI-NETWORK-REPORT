@PlannablePlan v0.1

ID=PART-007
PH=LUCIDE_ICON_SYSTEM
SCN=SCN-005
OUT=One sizing rule, one stroke width scale, currentColor everywhere
DEP=[PART-005, PART-006]

DICT:
G=goal; CTX=context; C=constraint; F=file(+=new, ~=modified, ?=maybe); T=task; AC=acceptance; V=verify; DONE=completion; S=stop

G:
- The new icons keep their alignment, and stop competing with CSS that sizes them differently.

CTX:
- product: GVSI NetPulse — light and dark themes from CSS tokens
- phase: Lucide icon system (part 4/5)
- prior: the icons are in place but sized by a mix of inline attributes and CSS overrides
- next: PART-008 tests, verifies in the browser, and releases
- today: sizes 12/14/16/20/24/40/56/72, stroke widths 1.5/1.8/2/2.2, one hardcoded stroke

C:
- preserve-existing-work
- avoid-unrelated-edits
- ask-before-new-deps
- one rule for the shared geometry, and no CSS rule that fights the element's own size
- colours come from currentColor so both themes and every state keep working

F:
~ styles.css
~ index.html
~ olt-module.js

T:
1 Add one .lucide-icon rule (display, vertical-align, flex-shrink) and drop the per-site
  inline styles it replaces.
2 Reconcile the CSS overrides (.export-btn svg, .node-empty-icon-circle svg, .olt-empty-icon
  svg and the <=640px block) so they set size in one place only.
3 Stroke width: 2 through 24px, 1.5 at 40px and above.
4 Replace stroke="var(--badge-green-text)" with currentColor and let the parent colour it.
5 aria-label on every icon-only control (theme, password toggle, close, alert badge);
   aria-hidden on decorative icons.

AC:
- No rule sets a width on an icon that also carries its own width attribute.
- Every icon inherits colour; no icon hardcodes a token as its stroke.
- Icon-only controls have accessible names.

V:
- node tests/icons.test.js
- browser check in light and dark at desktop and phone widths
- for t in tests/*.test.js; do node "$t"; done

DONE:
- update MASTER_PLAN.md Part 7=[x]
- append PLAN_EVIDENCE.md#PART-007: summary+files+checks+notes

S:
- if a size change would move surrounding layout, fix the layout in CSS rather than shrinking the icon back
