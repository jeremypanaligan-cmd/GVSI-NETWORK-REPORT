# PLAN_EVIDENCE.md

Project: GVSI NetPulse — OLT module zero state

## Evidence Log

### PART-001 — the component, its styles, and the two duties that were skipped

**Summary.** The OLT tab's default view (`currentOltFilter` starts at `'DOWN'`) no longer
renders an empty seven-column table with a bare inline-styled `<td>` in it. An
`.olt-empty-state` card takes its place inside `#oltIssuesTableCard`, while the stat cards,
the donut and the filter strip stay on screen and keep reporting the real fleet. The
early `return` that skipped the freshness chip and the export toolbar is gone: those two
are now the function's tail and run before either branch.

**Files.** `olt-module.js` (helpers `oltEmptyCopy_`, `oltFleetCounts_`,
`oltEmptyStateMarkup_`, `oltEmptyStateHost_`, `showOltEmptyState_`, `hideOltEmptyState_`,
`setupOltExportToolbar_`, `setOltExportEnabled_`; `renderOltTable` re-ordered) ·
`styles.css` (`OLT ZERO STATE` block, light + dark + `@media (max-width: 640px)`).

**Checks.** `node tests/olt-healthy-fleet.test.js` → 20/20, after the suite's fake DOM was
taught the three queries the module now makes (`querySelector`, `querySelectorAll`,
`removeAttribute`, `createElement`). Full suite → 173 passed, 0 failed.

**Note — a deviation from the part's own `V` line.** It named
`tests/olt-empty-state.test.js`, which PART-003 creates; PART-001 was therefore verified
against the existing OLT suite plus the whole tree, and the new suite covers it afterwards.

### PART-002 — one card, four different facts

**Summary.** The copy map now covers every filter that can reach this table. LOW POWER,
UPLINK DOWN and DEGRADATION name themselves, because "this filter is empty" and "the
fleet is healthy" look identical on screen otherwise. ALL with no rows is the
missing-data case and says what happened, with an alert glyph and a neutral fill rather
than the all-clear green. The card is `role="status"` + `aria-live="polite"` with an
`aria-hidden` icon, so a filter tap that yields nothing is announced.

**Files.** `olt-module.js` (`OLT_EMPTY_COPY`, `oltEmptyStateMarkup_`) · `styles.css`
(`.olt-empty-state.is-missing …`).

**Checks.** `node tests/olt-empty-state.test.js` → 9/9. The copy is asserted per filter,
and the two mutations that flatten the distinction (missing-data wearing the healthy
copy, missing-data wearing the healthy green) are both caught — see PART-003.

### PART-003 — tests, verification, and the release that is still owed

**Summary.** A focused suite covers the zero state, its four copy variants, the two duties
that used to be skipped, and the stylesheet. Every piece of the change was then reverted
one at a time in a temp copy to prove the suite is not vacuous.

**Files.** `tests/olt-empty-state.test.js` (new, CRLF, 9 cases) ·
`tests/olt-healthy-fleet.test.js` (harness only) · `TODO.md` (the deferred release) ·
`.freebuff/run.md` (the cache trap, measured).

**Checks.**

```
for t in tests/*.test.js; do node "$t"; done     173 passed, 0 failed   (9 suites)
mutation check (11 reversions of this change)    11 caught, 0 missed, 0 unproven
node scripts/bump-version.mjs --check            exit 0; labels 3.9.13, guard 3.10.0
```

In the browser (preview, seeded `oltMeta` of the real fleet shape 461/457/0, no login):
host visible and `.table-wrapper` `display: none`; `#oltTableBody` empty; title
*"No Down OLT Right Now"* with badges `457 UP / 461 TRACKED / 0 DOWN`, agreeing with the
cards above it; both export buttons `disabled` with a title naming the filter; the icon
computes to 64px with the green tokens in **dark** (`#34d399`) and **light** (`#059669`);
`role="status"`, `aria-live="polite"`, `aria-hidden="true"`. Screenshots taken in both
themes. Structurally the card is a sibling of `.table-wrapper`, `closest('table')` is
null and it contains no `<td>`, so the `data-label` / card-view rules cannot deform it.

**Notes.**

- The ≤640px rules could **not** be rendered in the preview: the panel's viewport is a
  fixed 808px, and the app's own `guardCardView` disables the table's card view whenever
  `screen.width > 360`. They are verified in the CSSOM instead — the delivered sheet goes
  from 454 to 466 rules, and the `(max-width: 640px)` block contains `.olt-empty-state`,
  `.olt-empty-icon`, `.olt-empty-icon svg` and `.olt-empty-title`.
- **Delivery is owed, and the rule is now measured rather than quoted.** A plain reload
  of the edited tree served `styles.css?v=3.9.13` with `transferSize: 0` — 454 rules, no
  `.olt-empty-*` selectors — while the same file read with `cache: 'reload'` had 466
  rules. The page requests the *versioned* URL, which the worker answers cache-first;
  `install` refreshes the *unversioned* precache entry. Nothing evicts the former while
  the label stands still, exactly as `sw.js`'s header says. The browser evidence above was
  therefore taken against the bytes on disk (a cache-busted stylesheet URL inside the
  page), and no release was made: `TODO.md` records the command.
