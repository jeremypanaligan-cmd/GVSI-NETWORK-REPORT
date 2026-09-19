@PlannablePlan v0.1

Part: PART-009 — module identity, one glyph per module
Project: GVSI NetPulse
Phase: 3

DICT
  module identity = the one glyph that stands for a module, wherever the module is named
  tab row         = the desktop .nav-tabs-container buttons
  bottom bar      = the mobile .bottom-nav buttons

G
  A tab glyph that is the same drawing in every bar and every card, distinct enough from its
  neighbours to be recognised at a glance, and an active tab that reads as "you are here"
  without a full-button fill that looks like a press.

CTX
  Phase 2 gave the app one icon set but kept each drawing, which left NAP, LCP and BACKBONE
  sharing shapes with unrelated screens (NODE and the login panel both drew a plain shield),
  and left the active tab marked by a 10% tint across the whole button — the same treatment a
  pressed button would get.

C
  - The two nav bars are static markup and the cards are built in JS, so a single map cannot
    be the only source: the bars carry [data-lucide] placeholders and the cards call
    moduleIconMarkup(). The map is the arbiter and a test compares every placeholder to it.
  - Colour still comes from inheritance. The new pill is the only new colour, and it is a
    token pair because dark mode uses the lighter teal.

F
  index.html           MODULE_ICONS + moduleIconMarkup(); both nav bars re-glyphed;
                       the ADMIN tab's gear emoji replaced by a placeholder
  scripts/build-icons.mjs  allowlist: radio-tower, boxes, cable in; monitor, layers, link out
  analytics-module.js  the 5 module snapshot cards read the map
  styles.css           .tab-icon and .bottom-nav-icon, the active pill tokens, 22px nav glyphs
  tests/icons.test.js  placeholders and moduleIconMarkup calls checked against the map

T
  1. Extend the allowlist and regenerate; the dead-weight test fails until the call sites move.
  2. Add the map and the helper, re-glyph both bars, convert the cards.
  3. Add the pill CSS for both surfaces, in both themes.
  4. Extend the suite, then measure the row: at 747px the tab row must not start scrolling.

AC
  - 8 modules, 8 distinct glyphs, identical in both bars and in the cards.
  - Active tab: teal label + a pill behind the glyph, correct in light and dark.
  - Bottom bar fits 7 tabs at 360px with no overflow; tab row fits at 747px.
  - A module named with one glyph in one bar and another in the other fails a test.
  - Full suite green, mutation check shows no mutation surviving.

V
  - `node tests/icons.test.js` → 21 passed (2 of them new)
  - full suite → 194 passed, 0 failed
  - mutation check → 27 caught, 0 missed, 0 broken anchors, baseline green
  - preview → both bars, both themes, 360px and 864px, screenshots taken

DONE
  - Icons in the table: 30, with monitor/layers/link removed and radio-tower/boxes/cable added
  - No nav button in either bar disagrees with MODULE_ICONS
