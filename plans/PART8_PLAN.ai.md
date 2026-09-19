@PlannablePlan v0.1

ID=PART-008
PH=LUCIDE_ICON_SYSTEM
SCN=SCN-006
OUT=Drift, typo and leftover-icon tests, browser proof, and release 3.9.15
DEP=[PART-004, PART-005, PART-006, PART-007]

DICT:
G=goal; CTX=context; C=constraint; F=file(+=new, ~=modified, ?=maybe); T=task; AC=acceptance; V=verify; DONE=completion; S=stop

G:
- The icon swap is provable rather than asserted, and it reaches installed devices.

CTX:
- product: GVSI NetPulse — offline-first PWA delivered by a cache generation
- phase: Lucide icon system (part 5/5)
- prior: the icons and their CSS are in place
- next: nothing — this part ends with a published release
- measured earlier in this project: an unversioned precache entry reaches nobody until the
  release label moves (styles.css?v= was served with transferSize 0, 454 rules, while the
  file on disk had 466)

C:
- preserve-existing-work
- avoid-unrelated-edits
- ask-before-new-deps
- a test that cannot fail is not evidence: revert each behaviour and watch it go red
- do not hand-edit the generated icon file

F:
+ tests/icons.test.js
~ index.html
~ manifest.json
~ sw.js
~ version.json
~ TODO.md

T:
1 tests/icons.test.js: drift (regenerate and byte-compare), unknown names, leftover
   hand-drawn SVGs outside the brand allowlist, precache wiring, provenance, helper options.
2 Prove the suite is not vacuous: mutate each behaviour in a temp copy and confirm a failure.
3 Browser verification in light and dark: login, bottom nav, export toolbar, both empty
   states, sortable header, About page, and an icon rendered after a table repaint.
4 Release 3.9.15 with node scripts/bump-version.mjs patch and a What's New entry.
5 TODO.md: record the icon system and the measured size of what it replaced.

AC:
- All suites pass, and each new assertion fails when its behaviour is reverted.
- The new bytes are on the live site, and an installed client moves to the new generation.
- The generated file is under 40 KB where the full bundle is 436 KB.

V:
- node tests/icons.test.js
- for t in tests/*.test.js; do node "$t"; done
- node scripts/bump-version.mjs --check

DONE:
- update MASTER_PLAN.md Part 8=[x]
- append PLAN_EVIDENCE.md#PART-008: summary+files+checks+notes

S:
- if a part needed a change it did not declare, note it in PLAN_EVIDENCE.md instead of hiding it
