# PLAN_EVIDENCE.md

Project: GVSI NetPulse — OLT module zero state (Phase 1) and the Lucide icon system (Phase 2)

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

## Phase 3 — module identity

### PART-009 — one glyph per module, and an active tab that says so

**How this phase started.** The Phase 2 migration preserved every drawing, because that is
what "tumutugma" asked for — and the user's next message was "hindi kapansin pansin ang
pagbabago sa mga icons". Both are true at once, and the honest answer was a measurement: I
rendered all 45 replaced sites side by side at 48px and read them. Roughly 40 are the same
drawing in a different pen: `activity`, `clock`, `eye`, `eye-off`, `arrow-right`, `moon`,
`sun`, `info`, `settings`, `monitor`, `link`, `shield`, `wrench`, `ban`, `file-text` and
`circle-check-big` are indistinguishable at a glance. The seven that DID change shape are the
OLT tab (`server`), CHARTS and analytics (`chart-column`), LCP (`layers`), every export button
(the arrow), the notification bell (filled to outline), the HIGH badge (filled to outline) and
the update overlay (`rocket`).

**Summary.** The glyph is no longer per-site but per-module, and there is one place that
says what it is. `MODULE_ICONS` in `index.html` maps every module to its drawing, and three
surfaces read it: the desktop tab row, the mobile bottom bar and the analytics snapshot cards.
NAP is a `radio-tower`, LCP is `boxes` (the enclosure that fans a fibre out), OLT stays
`server`, NODE is `shield-check`, BACKBONE is `cable`. NODE stopped borrowing the plain
`shield` the login panel uses, which is the case that made the map worth having. Glyphs are
22px in the phone bar (was 20), each sitting in a `.bottom-nav-icon` element so the active
tab can carry a **pill** behind it instead of a 10% tint across the whole button — a tint that
read as "pressed", not as "this is where you are". The desktop tab row got the same glyph in a
22×22 chip, and its ADMIN gear **emoji** is now a placeholder like every other icon.

**Files.** `index.html` (`MODULE_ICONS`, `moduleIconMarkup()`, both nav bars, the map comment)
· `scripts/build-icons.mjs` (+`radio-tower`, `boxes`, `cable`; −`monitor`, `layers`, `link`) ·
`lucide-icons.js` (regenerated, 30 icons, 12,911 bytes) · `analytics-module.js` (5 cards) ·
`styles.css` (`.tab-icon`, `.bottom-nav-icon`, `--nav-pill` / `--nav-pill-ring` per theme,
22px nav glyphs, `.admin-bottom-nav-btn svg`) · `tests/icons.test.js`.

**Checks.** Full suite **194 passed, 0 failed** (`icons.test.js` 19 → 21).

**Mutation check — 27 mutations, 27 caught, 0 missed, 0 broken anchors**, baseline re-verified
green. The five new ones are the ones this phase could get wrong:

```
the bottom bar shows a different glyph than the map      caught
the tab row shows a different glyph than the map         caught
the map points a module at a glyph not in the table      caught
a module is dropped from the map                         caught
the map gains a module with no button anywhere           caught
a card asks for something that is not a module           caught
```

**In the browser** (preview, service worker cleared): the two bars and the five module cards
agree — the same innerHTML length for a module's glyph in the nav and in its card, which is
what "one identity" means in bytes. Active pill measured `rgba(13,138,128,.13)` with
`rgba(13,138,128,.3)` ring in light and `rgba(20,184,166,.16)` / `.34` in dark, so the two-teal
token pair does what it was added for. Layout measured rather than eyeballed: the bottom bar
is 360/360 with no overflow at 360px (7 buttons, 48–66px each), the tab row 747/747 at 747px.

**Two things the measurements changed, both worth keeping.**

- The first chip was 26×22 with a 6px gap, which pushed the tab row to 776px against a 747px
  window — the row is `overflow-x: auto` with non-shrinking tabs, so it started scrolling for
  the sake of padding. At 22×22 with a 5px gap it fits again.
- The fake-data test for the bars first drove itself off `Object.keys(MODULE_ICONS)`, which
  means a module **removed** from the map would simply stop being checked — the mutation
  proves it: dropping `about` survived. It now iterates the union of the map's keys and the
  names actually found in the two bars, so both directions fail.
 — the generated subset, wired into the shell and the precache

**Summary.** `scripts/build-icons.mjs` reads the icon modules out of the installed
`lucide@1.47.0` and writes `lucide-icons.js`: 30 icons in **12,264 bytes**, against the
shipped UMD bundle's 436 KB. Both are committed, because this is a static PWA with no
bundler and a device downloads the precache list again on every generation. The runtime it
emits has four entry points — `icon()` for template strings, `createIcons()` for the
shell's static markup, `sortIndicator()` for the CSS-driven thin/column headers, and
`names`. The generator has a `--check` mode that regenerates into memory and compares.

**Files.** `package.json` (the dependency declared, and how to run the tool) ·
`.gitignore` (`node_modules/`, so 3,696 icon files cannot be committed) ·
`scripts/build-icons.mjs` · `lucide-icons.js` (generated) · `index.html` (the script tag,
first, with the reason) · `sw.js` (`./lucide-icons.js` in `STATIC_ASSETS`).

**Checks.** `node scripts/build-icons.mjs --check` → exit 0. `node --check lucide-icons.js`
→ clean. The 30 names were verified to exist as files in the package before the allowlist
was written (0 missing), and the icon-node format was probed rather than assumed: flat
`[tag, attrs]` pairs, no nesting, across 20 sample icons.

**Notes.**

- **A missing name is silent by design.** `icon()` returns `''` for an unknown name, so a
  typo costs one glyph instead of the screen it sits on. The compensating control is
  `tests/icons.test.js`, which walks both directions — every call site against the table,
  and every table entry against the call sites.
- The mask for the sort indicator is built from the same geometry as the icons (percent-
  encoded, `#` included), so there is no second copy of any path data anywhere in the repo.

### PART-005 — the shell's icons, and the sort indicator that had none to replace

**Summary.** 16 placeholders and 3 dynamic glyphs in `index.html`, from 21 inline svgs down
to **one**: the GALLOPVISION mark in the login panel, left hand-drawn on purpose because it
is a brand, not an interface glyph. The password toggle became two placeholders carrying
their `id`s, which `createIcons()` moves onto the svg it builds (`#eyeIcon` /
`#eyeOffIcon` are addressed by id in `togglePasswordVisibility()`), and `#themeIcon` keeps
its id across the swap the same way.

**Files.** `index.html`.

**Checks.** Then-`grep -c '<svg'` on the file → 1 (the brand mark). All 16 placeholders
converted and 0 remaining in the live DOM; `#eyeIcon` exists as an `svg` with its id intact.

**Notes.**

- The sorted-header indicator turned out to be `th.sortable::after`, so all 38 headers get
  it from CSS and **no markup changed**. Turning it into Lucide therefore could not be done
  by placeholders (they would need a second pass after every table repaint); the geometry is
  injected once as a **mask** instead, painted with `background-color: currentColor`, which
  is what keeps light/dark and the hover state working. The original text glyphs stay in
  `styles.css` as the no-JS fallback and the injected rules come later in the cascade.
- `arrow-left-right` was dropped from the table: the usage test proved nothing drew it, so
  the analytics compare button uses the same `chart-column` glyph as the CHARTS tab.

### PART-006 — the modules' icons, inside the template strings

**Summary.** 26 sites in 8 files. Every glyph is produced by `iconMarkup()` **inline in the
template string** rather than in a placeholder, and that is the whole point: these modules
rebuild their tables with `innerHTML` on a refresh cycle, so an icon that needed a second
pass after the paint would be missing on every repaint after the first.

**Files.** `nap-module.js` (2) · `lcp-module.js` (2) · `node-module.js` (3) ·
`backbone-module.js` (3) · `olt-module.js` (5) · `analytics-module.js` (6) ·
`admin-module.js` (4) · `notifications.js` (2).

**Checks.** No `<svg` remains in any of them (`grep -ln '<svg' *.js` → `lucide-icons.js`
only). Eight of the 26 are the same two shapes repeated across the export toolbars
(`download`, `file-text`), which is what the shared table collapses.

**Notes.**

- The two vm-based OLT suites had to learn the page global: they now load the **real**
  generated file instead of stubbing `iconMarkup`, because `olt-empty-state.test.js`
  asserts the glyph's `aria-hidden` and a stub would only prove the stub works.
- `backbone-module.js`'s healthy card stroked its svg with `var(--badge-green-text)`, not
  `currentColor`; that is preserved as an inline `color:` style rather than dropped, since
  the parent tile paints its own background and inherits nothing usable.

### PART-007 — one rule for alignment, no rule for colour

**Summary.** A single `.lucide-icon` rule (`display: inline-block`, `vertical-align: middle`,
`flex-shrink: 0`). Nothing sets a colour: every icon is stroked with `currentColor`, so it
inherits from the button, badge or tile it sits in. The existing per-component size rules
(`.export-btn svg`, `.feature-item svg`, `.olt-empty-icon svg`, `.bottom-nav-btn svg`, …)
were left exactly as they were and still win over the `width`/`height` attributes.

**Files.** `styles.css`.

**Checks.** In the preview: `.export-btn svg` stroke `rgb(30, 41, 59)` in light and the nav
icon `rgb(13, 138, 128)` — inherited, not declared. `flex-shrink: 0` addresses the real
failure mode (a squeezed icon in a tight flex row), not a hypothetical one.

### PART-008 — the tests, the mutations, the browser, the release

**Summary.** `tests/icons.test.js` — 19 tests over the generated file and every call site —
plus the release. 3.9.15 moves all six labels in one commit with the bytes they describe.

**Checks.** Full suite **192 passed, 0 failed** (173 before; `icons.test.js` is +19).

**Mutation check — 21 mutations, 21 caught, 0 missed, 0 broken anchors**, each one reverted
in a temp copy of the tree and the baseline re-verified green afterwards:

```
index.html placeholder names an icon that does not exist      caught
module calls iconMarkup with a typo                          caught
index.html does not load the generated file                  caught
the generated file is not precached                          caught
an inline svg returns to a module                            caught
index.html keeps a second inline svg next to the brand mark  caught
the brand mark allowlist is widened by renaming it           caught
icon geometry embedded in styles.css                         caught
node_modules allowed to be committed                         caught
strokeWidth override dropped                                 caught
aria-hidden default dropped                                  caught
createIcons stops carrying the id across                     caught
createIcons stops carrying the inline style across           caught
createIcons stops carrying the class across                  caught
createIcons leaves the placeholder in the page               caught
sort mask loses its theme colour                             caught
sort mask is not URI-encoded                                 caught
runtime grows a surface the app does not use                 caught
an icon is dropped from the table                            caught
the table keeps an icon nothing draws                        caught
the generated file drifts from the package                   caught
```

The 13 that touch the runtime are applied to `scripts/build-icons.mjs` and **regenerated**,
so the file stays consistent; otherwise the drift test would catch every one of them and
prove nothing about the behaviour tests.

**In the browser** (preview on the real tree, service worker cleared first): 0 leftover
placeholders, 30 icons loaded, 17 svgs on the login screen, `#eyeIcon` an `svg` with its id,
the sort styles injected once. Screenshots in both themes show the login features
(activity / shield / clock), the export toolbars (download / file-text), the eight bottom-nav
glyphs (monitor / layers / server / shield / link / chart-column / info / settings) and the
sort chevrons in all three states — currentColor measured at `rgb(255,255,255)` in the dark
theme and `rgb(13,138,128)` in the teal header in light.

**What the clone found, after every commit was already written.** The suite was run in a
`git clone` of these commits, not in the working tree that produced them — and two checks
that passed here failed there. Both were mine, and neither would have shown up any other
way:

- `git` stores `lucide-icons.js` as LF and, under `core.autocrlf`, checks it out as CRLF,
  so a byte comparison reported a file that had **just been generated** as out of date —
  in the test and in `icons:check` alike. Newlines are now normalized before comparing;
  the generator still writes LF.
- `node_modules` is gitignored on purpose, because the generated file is committed and a
  fresh clone runs without an install — but the drift test read the missing package as a
  generator failure. It now reports which check it could not run and why, and the 18 that
  need only the tree still run, including every call-site scan. Verified both ways in the
  clone: 19/19 under CRLF with the package present, 18 with one check reported skipped.

Neither is a defect in the app; both are defects in the guard, which is the category that
survives longest unnoticed. Fixed in `c030239`.

**Notes.**

- The release had to move the label: `lucide-icons.js` is a file no installed device holds,
  so it arrives only with a new generation. `bump-version --check` said so in its own words
  before the bump (`delivery set changed, release did not`), which is the warning this repo
  added for exactly this mistake.
- The guard stayed at **3.10.0** — no device is sent to the wipe overlay.

## Phase 4 — module colour

**The report that started it: "hindi kapansin pansin ang pagbabago sa mga icons".** It was a
correct reading, and the useful part was finding out there were two causes rather than one.

**Cause one, and the bigger one: none of it had been delivered.** Measured before answering:
`git rev-list --left-right --count origin/main...HEAD` → `0 4`; live `version.json` **3.9.15**;
live `sw.js` label `gvsi-shell-v3.9.15`; live `styles.css` **0** occurrences of
`bottom-nav-icon` against local's; live `index.html` 17 `data-lucide` against local's 26;
live `olt-module.js` 36,948 bytes, byte-identical to local. So the only files that differed
were the two Part 9 touched — meaning the module-identity change existed only on this machine,
and what was being judged was 3.9.15: the release where roughly 40 of 47 icons are the same
drawing, deliberately, because "tumutugma" asked for exactly that.

**Cause two: identity was carried by shape alone.** Read from the DOM before changing
anything — every resting glyph, all seven, was `rgb(100, 116, 139)` at 22px. Seven small
monochrome outlines do not separate at that size; the module you want cannot be found without
reading them one by one.

**What the phase does.** One hue per module, declared once as a token in both themes and read
by three surfaces: the resting glyph, the active tab's label and underline, and the active
pill. The last of those is why no per-module rgba value exists anywhere — the two pseudo
layers paint `currentColor` at 14% and 32%, so the alpha lives in the CSS and the hue is
declared once. That the hues are **categorical** is the design decision worth recording: the
app already has green/yellow/red/purple/orange on the analytics cards, and they mean *how many
are down*. A nav tab cannot make that claim — a permanently red OLT tab would read as "OLT is
down right now" on every screen, forever — so the badges were deliberately not reused.

**Files.** `styles.css` (`--module-*` × 7 in both themes, the `[data-module]` hue rules, the
one wrapper rule, the pill's two pseudo layers, `--nav-pill`/`--nav-pill-ring` deleted) ·
`index.html` (`data-module` on both bars, 7 + 7, and a comment on the map saying why the hue
is not in it) · `tests/icons.test.js` (one new test).

**Checks.** Full suite **195 passed, 0 failed** (`icons.test.js` 21 → 22).

**Mutation check — 38 mutations, 38 caught, 0 missed, 0 broken anchors**, baseline re-verified
green. Ten are new, and they are the ten ways this can rot:

```
a module gets no hue in dark mode                                   caught
dark mode names a module something light mode does not              caught
a module's hue rule points at another module's token                caught
a module never names a hue at all                                   caught
the hue reaches the tab row but not the bottom bar                  caught
the active pill goes back to a fixed teal                           caught
the fixed teal pill tokens come back                                caught
a bottom bar button loses the key its colour is read from           caught
a tab row button borrows another module's colour                    caught
the admin chip takes a resting hue it must not have                 caught
a literal fallback repaints the admin chip grey on its gradient     caught
```

**In the browser** (service worker cleared, both themes measured through `getComputedStyle`):
the bottom bar resolves `--module-hue` per button — nap `#0d8a80`, lcp `#4338ca`, olt `#c026d3`,
node `#1d4ed8`, backbone `#b45309`, analytics `#e11d48`, about `#64748b` — and every glyph
paints in its own. Labels stay `rgb(100, 116, 139)` at rest, so the tab you are on is still
the only one whose **label** moves. Active NAP: pill `rgb(13, 138, 128)` at `0.14` with
`rgb(13, 138, 128)` ring, in dark `rgb(52, 211, 153)` at `0.14`. Magnified 2.2×, no two hues
collide at nav size.

**The one thing the browser caught that no test would have.** The first version of the shared
wrapper rule used `color: var(--module-hue, var(--text-muted))`. The ADMIN tab row chip is white
on a filled indigo/violet gradient via `color: white !important` on the *button*, and carries no
hue — so a literal fallback repainted its glyph `#64748b` on that gradient. The fallback is
`inherit` now, the admin chip measures **`rgb(255, 255, 255)`** in the DOM, and a mutation pins
it there. Its class name was never the problem; the fallback was, which is exactly the kind of
defect that ships looking deliberate.

**Two documentation defects found while doing this, both mine, both fixed.** `MASTER_PLAN.md`
Phase 3 cited `SCN-007`, `SCN-008` and `SCN-009` while the scenario list stopped at SCN-006 — a
plan naming scenarios it never states. They are defined now, together with SCN-010 and SCN-011
for this phase.

**Released as 3.9.16 rather than as a new version.** The four commits holding Part 9 and the
release label had not been pushed, so folding the colour in costs nothing and avoids two
What's New entries describing one user-visible change. The rewrite was local-only, taken after
`git branch -f backup/3.9.16-icons-identity`, and every stage was re-verified in a clone before
pushing.
