@PlannablePlan v0.1

Part: PART-010 — module colour, one hue per module
Project: GVSI NetPulse
Phase: 4

DICT
  module hue      = the colour that stands for a module, wherever its glyph is drawn
  resting state   = the tab you are NOT on; the state seven of the eight tabs are always in
  active pill     = the tint + ring behind the active tab's glyph (.tab-icon / .bottom-nav-icon)

G
  A module found by colour in the tab bar without being the module you are on, with the
  active tab marked in that same hue, and no hue anywhere that reads as a status claim.

CTX
  Part 9 gave every module its own glyph, and the verdict on it was "hindi kapansin pansin".
  The measurement said why: in the DOM every resting glyph was rgb(100, 116, 139) at 22px, so
  identity was carried by outline shape alone — and seven small monochrome outlines do not
  separate at that size. A second cause sat on top of it: the four commits holding Part 9 had
  never been pushed, and the live site was still serving 3.9.15, where the drawings were
  deliberately 1:1 with the icons they replaced.

C
  - The two nav bars are static markup, so the hue cannot come from MODULE_ICONS: it is a
    token set keyed on [data-module], which both bars already carry a key for, and which the
    Part 9 test now holds to the map.
  - The pill cannot be a per-module rgba token pair without either colour-mix() (too new for
    the installed devices) or 28 hand-written values. Both pseudos paint with currentColor at
    a fixed opacity instead, so the hue is declared once and the alpha lives in the CSS.
  - `inherit` is the fallback, not a literal: the ADMIN chip is white on a filled gradient and
    carries no hue, and a literal fallback repaints its glyph grey on that gradient.

F
  styles.css           --module-* tokens in both themes; [data-module] hue rules; the hue
                       applied to .tab-icon and .bottom-nav-icon in one rule; the pill's two
                       pseudo layers; the fixed teal --nav-pill / --nav-pill-ring removed
  index.html           data-module on both nav bars' module buttons (7 + 7); the ADMIN chip
                       deliberately without one
  tests/icons.test.js  one new test: hue present in both themes, named for every module in the
                       map, applied to both wrappers from a single rule, pill painted with
                       currentColor, and no fixed pill token returning

T
  1. Tokens in both themes; the static-markup bars cannot read a JS map.
  2. The [data-module] rules and the one wrapper rule that both surfaces share.
  3. The pill as two pseudo layers, with the glyph lifted over them by z-index.
  4. Extend the suite, then extend the mutation harness before believing the suite.
  5. Measure both themes in the browser, and measure the ADMIN chip specifically.

AC
  - 7 modules coloured; the module you are on and the ones you are not are equally coloured.
  - Active tab: label, underline, glyph and pill all in the module's own hue.
  - Light and dark both carry all 7 names; a hue declared in only one theme fails a test.
  - A tab row hue that differs from the bottom bar's for the same module fails a test.
  - The ADMIN chip stays white on its gradient (measured in the DOM, not assumed).
  - Full suite green, no mutation surviving.

V
  - `node tests/icons.test.js` → 22 passed (1 of them new)
  - full suite → 195 passed, 0 failed
  - mutation check → 38 caught, 0 missed, 0 broken anchors, baseline green
  - preview → bottom bar in light and dark; tab row light: 7 hues, ADMIN rgb(255, 255, 255);
    active pill background rgb(13, 138, 128) at opacity 0.14 with its ring; dark:
    rgb(52, 211, 153) at 0.14; magnified capture at 2.2x confirms no two hues collide

DONE
  - One hue per module, declared once, read by three surfaces
  - The fixed teal pill is gone; nothing in the app paints a module in another module's colour
  - Released as 3.9.16 together with Part 9, so one delivery carries both
