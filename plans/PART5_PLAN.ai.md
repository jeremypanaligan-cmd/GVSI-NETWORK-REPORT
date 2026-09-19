@PlannablePlan v0.1

ID=PART-005
PH=LUCIDE_ICON_SYSTEM
SCN=SCN-004
OUT=Every icon in index.html is Lucide, sort indicators included
DEP=[PART-004]

DICT:
G=goal; CTX=context; C=constraint; F=file(+=new, ~=modified, ?=maybe); T=task; AC=acceptance; V=verify; DONE=completion; S=stop

G:
- The shell's own icons are one set, including the sort indicators that are still text.

CTX:
- product: GVSI NetPulse — offline-first PWA
- phase: Lucide icon system (part 2/5)
- prior: PART-004 generated lucide-icons.js and exposed window.lucide
- next: PART-006 does the module files
- index.html holds 21 of the app's 47 inline SVGs

C:
- preserve-existing-work
- avoid-unrelated-edits
- ask-before-new-deps
- the brand mark (index.html:48, 48x48 GALLOPVISION) is NOT an icon: it stays
- ids the JS toggles (#themeIcon, #eyeIcon, #eyeOffIcon) must survive on the new element
- static markup uses data-lucide + one createIcons() at boot; strings built in JS use lucide.icon()

F:
~ index.html
~ styles.css

T:
1 Login feature list: activity, shield-check, clock (20px).
2 Password toggle: eye / eye-off (20px) keeping both ids.
3 Sign In: arrow-right (20px); logout: log-out (12px).
4 Theme toggle: moon / sun (16px) replacing the MOON_ICON and SUN_ICON string constants.
5 Bottom nav (8): monitor, layers, server, shield, link, chart-column, info, settings (24px).
6 Update overlay: sparkles (56px). Alert badge: triangle-alert (12px), stroke only.
7 Sort indicators: drop the th.sortable::after glyphs (styles.css) and let sortTable() paint
   chevrons-up-down at rest, chevron-up / chevron-down when sorted, with aria-sort on the th.

AC:
- No hand-drawn <svg> survives in index.html except the brand mark.
- The theme toggle and the password toggle still work (ids intact).
- Sorting a table shows an icon, not a glyph, and the th carries aria-sort.

V:
- node tests/icons.test.js
- for t in tests/*.test.js; do node "$t"; done

DONE:
- update MASTER_PLAN.md Part 5=[x]
- append PLAN_EVIDENCE.md#PART-005: summary+files+checks+notes

S:
- if an icon's replacement changes the control's meaning, fix the label rather than the icon
