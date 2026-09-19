@PlannablePlan v0.1

Part: PART-011 — the OLT all-clear, reworked
Project: GVSI NetPulse
Phase: 5

DICT
  all-clear card = the .olt-empty-state the DOWN filter shows when nothing is down
  pulse          = the ring on .olt-empty-icon::after, painted with currentColor

G
  A card that reports good news and stops, whose mark reads as a signal being watched rather
  than a box that was ticked once — and that goes still when the device asks it to.

CTX
  Phase 1 built the card with a "View All Healthy OLTs" button. The UP card and the UP filter
  open the same list from controls that sit above it and always will, so the button was a chore
  offered on the one screen with nothing to check. Its mark, circle-check-big, is a circle —
  drawn inside the card's own 64px circle, which reads as one smudged ring.

C
  - The pulse has to ride on ::after so the glyph keeps the circle's own 1.5px border as its
    edge, which is why the circle needs position: relative.
  - The app already says "live" with an expanding ring (statusPingGreen, nodePingRing). This is
    that idea at this circle's size, not a new one.
  - Reduced motion has to switch the ring OFF, not slow it: a ring that still fades in and out
    is still motion.
  - Removing the button removes .olt-empty-actions with it, or the CSS is dead on arrival.

F
  olt-module.js           oltEmptyStateMarkup_: activity in, circle-check-big out; the actions
                          block deleted
  styles.css              the pulse on .olt-empty-icon::after + keyframes + reduce block;
                          position: relative on the circle; the is-missing opt-out;
                          .olt-empty-actions removed
  tests/olt-empty-state.test.js  one test: no button, no fetch call, the numbers stay, the
                          pulse's name resolves to a real @keyframes block, reduced motion
                          switches it off, is-missing opts out, no dead wrapper CSS

T
  1. Swap the glyph and delete the actions block.
  2. Add the ring, keyframes, the reduce block and the is-missing opt-out; delete the dead rule.
  3. Extend the suite, and extend the mutation harness for the stylesheet before believing it.
  4. Sample the ring over time in the browser rather than reading that it is declared.

AC
  - 0 buttons in the card; loadHealthyOltList is not referenced; the badges stay.
  - The animation names a keyframe that exists — a rename fails, and so does a dangling name.
  - prefers-reduced-motion: reduce switches the pulse off, in exactly one block.
  - is-missing does not pulse and keeps circle-alert.
  - Full suite green, no mutation surviving.

V
  - `node tests/olt-empty-state.test.js` → 10 passed (1 of them new)
  - full suite → 196 passed, 0 failed
  - mutation check → 18 caught, 0 missed, 0 unproven
  - preview → activity's path, 0 buttons, pulse sampled three times and moving in light and
    dark, is-missing still

DONE
  - The card asks for nothing and the fleet is still one tap away, from the UP card and filter
  - The ring is the app's existing pulse vocabulary at this size
  - Released as 3.9.17
