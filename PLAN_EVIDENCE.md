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

## Phase 5 — the OLT all-clear, reworked

### PART-011 — no button, and a pulse

**Summary.** The zero state's all-clear card carried a **View All Healthy OLTs** button that
duplicated the UP card and the UP filter — both open the same list, from controls that are on
screen above it and always will be. It is gone, so the card now reports without asking the
operator to go and check. The mark changed from `circle-check-big` to `activity`, and it pulses.

**Two reasons for the glyph, and the first is the one that mattered.** The tick was *itself a
circle*, drawn inside the card's own 64px circle, so the two rings read as one smudged ring — a
circle glyph inside a circle chip is a shape collision before it is a taste question. `activity`
is the steady signal line, and it is already the glyph the login screen uses for real-time
monitoring, which is what this card reports on. It was already in the table, so nothing needed
regenerating.

**The pulse reuses what the app already says.** `statusPingGreen` (the table's status dots) and
`nodePingRing` (the node cards) are the same idea, so this is that ring at this circle's size: a
`::after` painting `currentColor`, 2.6s, `scale(1)` → `1.5` while opacity falls `0.55` → `0`.
Deliberately slow — it is the only thing moving on a screen whose whole message is good news.
Two refusals are built in: `prefers-reduced-motion: reduce` **switches it off** rather than
slowing it (a ring that still fades in and out is still motion), and `is-missing` never pulses —
a beat over "no rows arrived" would suggest something is being watched when nothing is.

**Files.** `olt-module.js` (`oltEmptyStateMarkup_`) · `styles.css` (the pulse on
`.olt-empty-icon::after`, its keyframes, the reduce block, the `is-missing` opt-out, `position:
relative` on the circle, and the now-dead `.olt-empty-actions` rule removed) ·
`tests/olt-empty-state.test.js` (+1 test).

**Checks.** Full suite **196 passed, 0 failed** (the zero-state suite 9 → 10). **Mutation check
18/18 caught, 0 missed, 0 unproven** — the 12 pre-existing ones, five for the stylesheet, and
the button's return.

**A test weakness the mutations caught, in my own work.** The first assertion was
`assert.ok(/@keyframes oltEmptyPulse/.test(css))` — a **substring** test, which passes on
`@keyframes oltEmptyPulseRenamed`: the exact rename that kills the pulse and leaves the card
looking correct. The test now reads the name out of the `animation:` declaration and requires a
`@keyframes` block with that name, so the rename and the dangling reference both fail.

**The mutation harness was stale, and said so.** It did not stage `lucide-icons.js`, which the
suite has loaded since Phase 2, so every run was red at the baseline — a false red, which is the
one thing that trains a reader to ignore red. Fixed before any of its verdicts were trusted.

**In the browser**, from the delivered bytes: `activity`'s path, **0 buttons**, `healthy-olt-cta`
absent, `loadHealthyOltList` absent, and the badges still `457 UP / 461 TRACKED / 0 DOWN`. The
pulse was **sampled three times rather than assumed** — `animationName oltEmptyPulse`, `2.6s`,
transform and opacity moving at every sample, colour `rgb(5,150,105)` in light and
`rgb(52,211,153)` in dark. `is-missing`: `animationName none`, `opacity 0`, **not moving**.

**Two limits, stated rather than glossed.** The preview viewport is 566px, so both screenshots
are the phone layout (54px box, 26px glyph); desktop is the base 64/32 rule, read from the
stylesheet and not measured. And `prefers-reduced-motion` is verified by the test and the CSS,
not by emulating the media feature in a browser — the tooling has no switch for it.

**Released as 3.9.17.**

**A copy change, requested after that release.** The DOWN card's wording became **"All OLT
Systems Operational"** with "All tracked OLTs are functional. Incident alerts will automatically
render here in real time." The three tests that named the old string moved with it — one asserts
the DOWN card says the new title, and two assert that the partial filters and the no-rows case do
NOT borrow it. Worth recording for whoever reads this next: the title now makes a wider claim
than "No Down OLT Right Now" did, while the donut directly above it can still count LOW POWER /
UPLINK DOWN / DEGRADATION units. The badges under the sentence are what scope it. PART-001's
evidence above keeps the wording that release actually shipped with; only the copy moved.

## Phase 6 — Active Incidents, the IMPACT column, and Affected Clients (SA)

### PART-012 — the label that was lying, a column that was already in the sheet

**Summary.** `ALL OLTs` became **`Active Incidents`**, and became the landing view; a new
**IMPACT** column sits directly after CLIENTS; and **Affected Clients (Down)** became
**Affected Clients (SA)**, counting the per-OLT clients of SA tickets only.

**The rename was a correction, not a change of behaviour.** The branch already answers
`?type=olt&shape=3`, and shape=3 filters the payload to `row.S !== "UP"` before it leaves the
server — so the button labelled "ALL OLTs" was already showing exactly DOWN + LOW POWER +
UPLINK DOWN + DEGRADATION, and nothing else. The old label was the only thing wrong with it.
That is why the view is now the landing page at no cost: no second request, no extra rows, and
the four per-status pills stay exactly where they were.

**Column K is the whole feature.** `COL.OLT_IMPACT = 10` — the same absolute column
`NODE_IMPACT` and `BB_IMPACT` have read all along — is joined onto each row by TICKET NUMBER,
normalised for case and whitespace, and carried as `IM`. The join is per-row and not per-ticket:
the ticket's own Z cell holds one client count per line aligned with the OLT names in AB, so two
OLTs sharing an SA ticket contribute **their own** numbers. A fallback to the ticket cell would
have charged each of them the first number and inflated the fleet total — the new server suite
pins both the per-OLT value and the resulting 95, so that fallback cannot come back quietly.

**`meta.clientsSA` is new; `meta.clientsDown` is untouched.** The Analytics tab
(`analytics-module.js:132` and its chart) and the daily snapshot in `db.js` read `clientsDown`,
and a snapshot is never corrected after the fact — so changing what that field means would
rewrite history. The card reads the new field, the old one keeps its own meaning, and the two are
different numbers by construction (135 vs 95 in the server fixture; 150 vs 45 in the client one),
which is what makes a swap between them a failing test rather than a silent lie.

**The zero state's missing-data case stopped depending on a filter token.** It used to hang off
`'ALL'`, which meant the one screen it described depended on which button had been tapped. With
`'ALL'` gone it is chosen from the DATA: an empty list over a payload that carried neither a
summary nor a row is the missing snapshot, and an empty list over any other payload is a fleet
at peace. `'ACTIVE'` and `'DOWN'` now share **one** all-clear object — the sentence is written
once, and a test counts the occurrences to keep it that way.

**Files.** `code.gs` (`COL.OLT_IMPACT`, `impactMap`, the `IM` field, `OLT_ROW_FIELDS`,
`meta.clientsSA`) · `index.html` (the pill, the landing default, the SA card's label and id, the
two new `sortTable` indices, the totals colspan) · `olt-module.js` (`'ACTIVE'` in the button map
and the filter predicate, `oltFilterLabel_`, the shared all-clear copy, `OLT_MISSING_COPY`,
`oltEmptyCopy_`, `processAndRenderOlt`, the impact cell) · `test-olt-shape3.html` (mock wire
shape) · `tests/olt-impact.test.js` (new, server) · `tests/olt-active-incidents.test.js` (new,
client) · `tests/olt-empty-state.test.js`, `tests/olt-healthy-fleet.test.js` (the default view
moved; the overview's back button now returns to it).

**Checks.** Full suite **212 passed, 0 failed across 12 suites** (196 → 212: +6 server, +10
client, −0 lost). **Mutation check 21/21 caught, 0 missed, 0 unproven**, with the baseline
verified green inside the mutation workspace first — the false-red failure this repo has already
paid for once. It caught two real things: the cross-realm array comparison that made
`deepStrictEqual` reject an order it had just been handed, and one anchor that matched zero
times, which is a mutation that never ran and would otherwise have been counted as a pass.

**In the browser**, from the served bytes at `127.0.0.1:8080` with a shape=3 payload carrying
`IM` and a `clientsSA` (165) deliberately different from `clientsDown` (150): the **SA card read
165**, the landing view rendered **4 incident rows**, the impact cells read **SA, NSA, NSA, SA**,
each row had **8 cells**, and the footer read `FILTERED TOTAL (ACTIVE INCIDENTS)` with
`colspan="7"`. Against the **live** deployment — which does not send the new field yet — the same
screen renders **`–`** in every impact cell and **0** on the SA card. That is the intended
pre-deploy state and not a defect, but it is the reason the Apps Script deployment has to follow
the client.

**Two limits.** `IM` is additive and last, and `v` is unchanged, so an installed shell decodes
the extra field and ignores it — but nothing can prove that against a device that has not
reloaded. And the served table had a horizontal scrollbar at the preview's 566px viewport; the
8th column does not change that the wrapper already scrolls, but nobody has measured it on a
phone.

### PART-013 — the same ragged pill, in two more columns

**Summary.** The OLT table's STATUS cell and the Backbone table's SERVICE cell became
fixed-size chips. `status-chip` fixes a width and a height; `is-long` is the wider variant the
STATUS column needs.

**This is the cause pill's problem, one column over.** `dt-cause-badge` was written for exactly
this: a data-driven label with no floor gives every row its own box, so the column reads as
ragged noise AND is as wide as its longest label. The same was true of "DOWN" beside "OLT
SERVICE DEGRADATION" beside "OLT UPLINK LOW POWER", and of a service column that resized when
the mix of incidents changed.

**`width`, never `min-width`.** A minimum is the version of this that looks right in review and
fails in use: it still lets the longest label drag the column wider, which is the whole thing
being fixed. The height is fixed too, sized to hold exactly two lines at this font size, so a
chip that wraps and a chip that does not are the same box — and every chip carries its full
label in `title`, because a box that wraps must not become a truncation. The **value** is
untouched: `OLT UPLINK LOW POWER` is the string the filter matches and the CSV export reads out
of the DOM, so only the box is fixed.

**Two widths, on purpose.** SERVICE holds four characters (DWDM, MPLS) and STATUS holds phrases
up to twenty-three; one width for both would either clip the phrases or pad the service column
out. The OLT fleet list keeps its small `UP` badge: its only value is `UP`, so a fixed box there
buys uniformity nobody can see and would widen that column for a two-letter word.

**Files.** `styles.css` (`STATUS_CHIP` block with `.status-chip` and `.status-chip.is-long`) ·
`olt-module.js` (the STATUS cell, plus `statusTitle` with the attribute's quotes escaped the way
the onclick parameters are) · `backbone-module.js` (the SERVICE cell, reusing the `safeService`
that is already escaped) · `tests/status-chip.test.js` (new) · `tests/olt-active-incidents.test.js`
(+1).

**Checks.** Full suite **217 passed, 0 failed across 13 suites**. **Mutation check 9/9 caught, 0
missed, 0 unproven** — `width` swapped for `min-width`, the height dropped, the long variant
made narrower than the base, the label un-centred, and each module losing the class or the
title. Baseline verified green inside the mutation workspace first.

**Measured in the browser**, from the served bytes and against the LIVE deployment (which by
then had the new `code.gs`: the SA card read **58**, matching `meta.clientsSA`): all four OLT
STATUS chips **132 × 31.9px, one distinct size**, `inline-flex`, centred, wrapped labels inside
the fixed height, full label in `title`; the STATUS column **181px → 156px**, and no longer a
function of the longest label. All eight Backbone SERVICE chips **55 × 31.9px**, likewise one
distinct size, over live DWDM/MPLS rows.

### PART-014 — the column is INCIDENT now, and the label is trimmed

**Summary.** The OLT table's last column is titled **INCIDENT** instead of STATUS, and its labels
lost the module prefix: `OLT UPLINK DOWN` → **UPLINK DOWN**, `OLT SERVICE DEGRADATION` →
**SERVICE DEGRADATION**, `OLT UPLINK LOW POWER` → **UPLINK LOW POWER**, and `DOWN` retained.

**Why the rename and the trim are the same change.** Under a STATUS header, "OLT UPLINK DOWN"
reads as a status called *OLT UPLINK DOWN*; under INCIDENT it reads as an incident of type
*UPLINK DOWN* — and every row in this table is already an OLT, so the first word was repeating
the tab you are standing in. Trimming it also removes the wrapping the fixed chip was built to
absorb: the longest label is now nineteen characters, which fits one line, so the chips are
uniform *and* single-line. `DOWN` is retained exactly as it arrives, with or without the prefix,
because it is the one status whose label is already the whole story.

**A display transform, and only that.** `oltIncidentLabel_` runs at render time. The payload,
the filters (`st.includes('LOW POWER')`), the stat cards and `meta` all keep reading the raw
status the server sends — verified in the browser by reading `dataCache.olt` after the repaint
and finding `OLT UPLINK LOW POWER` still there under a cell that reads `UPLINK LOW POWER`. The
cell's `title` keeps the sheet's own wording, so the tooltip is the record and the label is the
reading. Two consequences worth stating rather than discovering: **the CSV export now carries the
trimmed labels**, because `exportTableToCSV` reads the DOM, and the **detail modal still shows
the raw status** (its own field is labelled `Status:` and is untouched).

**Files.** `index.html` (the header) · `olt-module.js` (`oltIncidentLabel_`, the `statusLabel`
binding, `data-label="Incident"` so the phone card layout prints the same name the header does) ·
`tests/olt-active-incidents.test.js` (+2, and the header-order expectation moved).

**Checks.** OLT suite **13 passed**, full suite **220 passed across 13 suites**. **Mutation
check 17/17 caught, 0 missed, 0 unproven** — the header left as STATUS, the card layout still
labelled Status, the display left untrimmed, a trim that eats the word but leaves its space,
the DOWN retention removed and narrowed to the bare word, the trim reaching the payload, and the
title trimmed along with the cell.

**Measured in the browser**: header `INCIDENT`; cells reading `DOWN`, `SERVICE DEGRADATION`,
`UPLINK LOW POWER`, `UPLINK DOWN`; titles still the server's values; all four chips **132 × 32px,
one distinct size**; the INCIDENT column **181px → 156px → 148px** across the three states.

**The delivery mechanism bit twice while verifying the chips, and the run doc now says how to get
out.** A service worker held the previous `olt-module.js`, and after that was cleared the
VERSIONED `styles.css?v=3.9.18` was still answered from the browser's own HTTP cache while the
unversioned module came fresh — so the markup arrived and the stylesheet did not, and the chips
measured 117/148/163px, i.e. sized by their own text. `fetch(url, { cache: 'reload' })` onthe versioned URL replaces that entry, and the reload after it is real. Recorded in
`.freebuff/run.md` beside the worker-cache recipe.

### PART-015 — the tile the tab is named after, and two more fixed boxes

**Summary.** Three changes that are one claim. The IMPACT value got the same fixed box the
INCIDENT column already had; **TOTAL OLT became ACTIVE INCIDENTS** and the six summary tiles were
reordered into the ladder they describe (`UP / ACTIVE INCIDENTS / DOWN`, then
`LOW POWER / UPLINK DOWN / SERVICE DEGRADATION`); and the two long tile labels were given a
reserve so they wrap **inside** the tile instead of leaving it.

**ACTIVE INCIDENTS is `total − up`, not the sum of the four arms.** The server's four counting arms
(`down`, `lowPower`, `uplinkDown`, `degradation`) are a hand-written list of the statuses anyone
thought of, and a row the sheet spells differently increments **none** of them — it is counted in
the fleet total, and the table renders it like any other incident. A tile built by adding the four
together would therefore read one fewer than the table beside it, on screen, with no error. The
card is derived from the fleet size instead, which is the same comparison the server used to choose
which rows to send (`row.S !== "UP"`) and the same one the ACTIVE filter re-applies when it renders.
The middle tile can no longer disagree with the view it opens.

**Why it keeps `c-total`.** The aggregate colour is not a compliment — it says *this is the whole*,
and it is what the tile held as TOTAL OLT. Red would dress a clean fleet as an alarm, and the four
tiles underneath it already carry the alarm colours.

**Why the labels needed a reserve rather than a rename.** The shared `.stat-card .label` rule is
`nowrap`, which was fine while every tile label was one word; ACTIVE INCIDENTS and SERVICE
DEGRADATION are both wider than a third of a phone. The new scoped rule lets them wrap and reserves
`min-height: 2.2em` — exactly two lines at this label's `line-height: 1.1` — bottom-aligned, so a
two-line label and a one-line label in the same row put their values on the **same baseline**. It
is scoped to `.olt-stats-grid`, because every other tab's tiles still have room on one line, and it
is the reason this change did not have to alter the shared rule for four other tabs.

**Files.** `index.html` (the six tiles, their order, and the middle tile's id) · `olt-module.js`
(`countActive` derived in both the meta and legacy paths, and the IMPACT cell) · `styles.css`
(`.status-chip.is-impact`, the scoped label rule, and the chip comment corrected from two widths to
three) · `tests/olt-active-incidents.test.js` (+6) · `tests/status-chip.test.js` (the width test
now covers all three vocabularies).

**Checks.** Full suite **225 passed across 13 suites, 0 failed** — the OLT suite went **13 → 19**.
**Mutation check 19/19 caught, 0 missed, 0 unproven**, baseline verified green inside the mutation
workspace first: the chip class halved or dropped, the tile reverting to the fleet size, the four
arms added instead of derived, the legacy count narrowed to DOWN, the id left behind, the tile
pointing at the DOWN filter or dressed in the alarm colour, the order swapped, the label reverting
to the filter token, the filter opened with a token no filter answers, `width` back to `min-width`,
the IMPACT width made the widest of the three, `white-space` back to `nowrap`, the reserve short by
a line, and the labels top-aligned.

**Measured in the browser**, against the LIVE deployment (`meta.up: 457`, `meta.total: 461`): the six
tiles read **UP 457 · ACTIVE INCIDENTS 4 · DOWN 0 · LOW POWER 2 · UPLINK DOWN 1 · SERVICE
DEGRADATION 1**, and 461 − 457 = **4** — the card, the table and the filter are the same claim. The
IMPACT chips over live rows: **SA and NSA both 46.2 × 31.9px, one distinct size**, neither clipped,
and the column stays **72px, set by its own header** — the fixed chip never widens it, which was the
point of sizing it under the header rather than over it.

**And the reserve, at a phone's width.** Constrained to a 336px grid (a 360px viewport gives
106.7px tiles): ACTIVE INCIDENTS and SERVICE DEGRADATION render on **two lines**, the other four on
one — and all three values in each row still land on **one baseline** (254.8 and 329.6), the six
tiles are the same height, **no label is clipped and none escapes its tile**. Without the reserve the
middle tile of the first row would have sat a line below its neighbours.

**One thing this made more visible, and did not change.** The DOWN tile loses its colour when it
reads 0, because the module assigns `getAlertClass('oltDown', countDown)` over the tile's class and
that helper returns an empty string at zero — so with the fleet clean, DOWN is the one incident tile
without its colour while LOW POWER and the rest keep theirs. That behaviour is **pre-existing** and
untouched here; it is noted because the new ACTIVE INCIDENTS tile beside it now makes the
inconsistency easy to see.

### PART-016 — the export bar leaves the screen with the table

**Summary.** When the OLT table comes up empty — nothing matches the filter, which includes the
whole-fleet all-clear — the **EXPORT CSV and EXPORT PDF buttons are no longer on screen**, so the
zero-state card sits directly under the filter strip instead of under a row of controls that
cannot be used. Measured on the live page: the card rises **39px** (the bar's 29px line plus its
margins).

**Hidden, not removed.** The bar is still constructed by `setupOltExportToolbar_()` on every
render, because every other path assumes it exists — the healthy-fleet panel hides and re-reveals
it, and `renderOltTable` re-shows it at the top of every filled render. Hiding it is a state, and
the state is reversed by the same function that set it: a fresh sandbox starts with a visible bar,
so only the **empty → filled sequence on the same tab** can catch a missing un-hide. That sequence
is now a test.

**Muted as well as hidden, on purpose.** `setOltExportEnabled_` still disables both buttons in the
empty arm. Nothing on screen shows it, and that is the point: the bar is never one reveal — by a
future caller, a stylesheet change, or a developer inspecting the DOM — away from exporting a
header line and a PDF of the card itself.

**One detail that looks like a no-op and is not.** The empty arm hides the bar **returned by**
`setupOltExportToolbar_()`, not the `exportToolbar` queried at the top of the function. On the very
first render the bar does not exist yet, so that captured value is `null` — and a hide against it
silently does nothing exactly when the tab opens straight into the zero state. The mutation that
swaps the two references is caught; this is the line that catches it.

**Files.** `olt-module.js` (the empty arm, and the two comments that stated the old "built so it can
be muted" rule) · `tests/olt-empty-state.test.js` (the tail test now asserts hidden **and** muted,
also that the bar follows the filter strip in the tab's child order and that it returns when a row
does) · no stylesheet change — `[hidden] { display: none !important }` was already the app's single
source of truth for "not on screen", and it is what makes `el.hidden = true` win against
`.export-toolbar { display: flex }`.

**Checks.** Full suite **225 passed across 13 suites, 0 failed**. **Mutation check 7/7 caught,
0 missed, 0 unproven**, baseline green in the mutation workspace first: the hide dropped, flipped to
`false`, aimed at the pre-build `null`, the setup call dropped, the un-hide dropped, the
`!important` removed from `[hidden]`, and the buttons left live behind the hidden bar.

**Measured in the browser, both directions, on the same tab.** Empty (live sheet had zero
incidents at that moment, and the seed matched it): `bar.hidden === true`, bar height **0px**, both
buttons present and **disabled**, `.olt-empty-state` present, table wrapper hidden, bar directly
after the filter strip in the tab's child order. A/B on the same page — revealing the bar by hand
moved the card from **611.6px** to **650.6px**, i.e. the zero-state card gains **39px**. Then a
DOWN row arriving: bar **visible at 29px**, both buttons **enabled**, empty state gone, wrapper
back. A reload returned the tab to the live 4-incident view with the bar visible.

### PART-017 — the Analytics trend charts are gone, and so is the CDN they needed

**Summary.** The four IndexedDB trend charts — **Incidents per Day, OLT Status Trend, Clients
Affected Trend, Aging Distribution** — were removed from the Analytics tab, together with
`renderTrendCharts()`, `loadChartJS()` and the Chart.js script the dashboard pulled from a CDN.
**164 lines** came out of `analytics-module.js` (749 → 585).

**What the tab gains, not just loses.** Chart.js was loaded per chart session — a third-party
library fetched from `cdn.jsdelivr.net` before anything could be drawn. The dashboard now renders
from the app's own caches alone: **no external script, no IndexedDB read, no network**. The suite
below runs it in a sandbox where `Chart` and `indexedDB` do not exist at all, so a chart call
creeping back is a ReferenceError rather than a box that silently stays blank.

**What was deliberately NOT removed, and why each one looks like the same feature:**

- **The daily snapshot writer.** `saveDailySnapshot()` is still called on boot and
  `getSnapshots()` is still in `db.js`. A snapshot is the record of what the sheet said that day
  and is **never rewritten** — once the day has passed the sheet cannot be asked again. Removing
  the reader is not removing the record, so the capture keeps running and the reader waits for
  whatever history view comes next. `db.js`'s header comment now says exactly that.
- **`.analytics-charts-row` / `-card` / `-title` / `-body`.** These read as the removed feature's
  own CSS — the comment above the first one says *"Donut Charts Row — 2 columns"* — and the OLT and
  Backbone **donut** cards are laid out by them. Deleting them with the feature would have taken the
  donuts with it, which is the one mistake this change was most likely to make.
- **The What's New entries** naming Trend Charts (v3.3.1's Chart.js memory-leak fix, and the
  later "Trend Charts (New)"). They are **versioned history**, not documentation of the present:
  a changelog that erases a release is no longer a changelog.

**The one loose end, stated rather than quietly fixed.** The **7 / 30 / 90 Days** buttons in the
Analytics filter bar were added "for trend analysis" and are **already inert** — `analyticsDateRange`
is written by `setAnalyticsDateRange()` and read by **nothing**; all three buttons re-render an
identical dashboard. That was true before this change, and the trend charts were their stated
purpose, so they are now a control with no job at all. Left in place because they were not what was
asked for, and flagged because the next reader will assume they filter something.

**Files.** `analytics-module.js` (the section markup, the render call, both functions) ·
`db.js` (header comment) · `GVSI_NetPulse_Analytics_Documentation.md` (section 8 deleted, sections
renumbered, TOC, data-source list, and the architecture tree) · `GVSI_NetPulse_System_Roadmap.md`
(one capability row) · **new** `tests/analytics-dashboard.test.js`.

**Checks.** Full suite **231 passed across 14 suites, 0 failed**. **Mutation check 9/9 caught,
0 missed, 0 unproven**, baseline green in the mutation workspace first: the trend heading and its
chart rows put back, a trend canvas put back, the library called again, the snapshot store read
again, the shared chart-row rule deleted, the donut cards losing the class their layout comes from,
a surviving section dropped, the boot capture neutered, and the reader renamed away.

**Two assertions had to be fixed before they meant anything**, and both were the kind that passes
while proving nothing: `/function saveDailySnapshot/` also matches `saveDailySnapshot_gone`, and
`page.indexOf('saveDailySnapshot()')` also matches a call sitting behind `if (false)`. They are now
`/function saveDailySnapshot\s*\(/` and the whole guarded call statement. The mutation pass is what
surfaced them — a check that had been counted as green twice.

**Measured in the browser** on the live deployment origin: `typeof window.Chart === 'undefined'`,
**no `jsdelivr` script tag anywhere in the document**, **0 canvases** in the tab, **2** donut cards,
and the section headings reading `Module Snapshot · OLT Status Distribution · Backbone Service
Type · Aging Timeline (NAP + LCP) · Top Provinces by Incidents` — with **every** removed token
(`trendIncidentsChart`, `trendNote`, `Trend (Last 30 Days)`, `Incidents per Day`, …) absent from the
rendered 14,383 characters.

**The verification itself was the hard part, and it is worth reading before the next removal.**
The preview kept executing the OLD module for three full clear-and-reload cycles: unregistering the
worker, deleting every cache, and navigating to a new query string were **not enough** — the
navigation's own script requests are answered by the **browser's HTTP cache** before the freshly
registered worker has a say, and the page then runs yesterday's module while the worker's cache
already holds today's bytes (so any probe of "what will this load" answers *new* and lies). What
worked: `fetch(url, { cache: 'reload' })` for **each unversioned module**, then navigate — plus a
cross-check on a second origin (`localhost` vs `127.0.0.1`), which has no cache state at all and
showed the new code immediately. Recorded in `.freebuff/run.md`, because the existing recipe there
covered only the versioned `styles.css?v=` half.

---

### PART-018 — the update trigger an installed PWA never had

**Summary.** An installed PWA could keep the release it was installed with until the user
uninstalled and reinstalled it. Two gaps, each invisible on its own:

1. **Nothing ever asked for an update check.** `reg.update()` was called on exactly one event —
   `visibilitychange` back to visible, throttled to 5 minutes. Chrome's own check-on-navigation
   rule is presumably why that looked like enough: except that a home-screen launch navigates
   **once**, a dashboard left open navigates **never**, a phone resuming the app from the task
   switcher does not navigate at all (that is a `visibilitychange`, not a check), and the rule is
   floored at **24 hours per registration** on top of that. `index.html` now asks on the launch, on
   a return to the foreground, and on a **15-minute timer** for the display that is never hidden.
   All three share one throttled body with an in-flight guard, because they overlap by design.
2. **A worker left in `waiting` was never told to go.** A device whose running worker predates
   `skipWaiting()` can hold the new one in `waiting` indefinitely: a waiting worker stays waiting
   until every controlled tab goes away, and an installed app is never closed. The page now nudges
   one already waiting at launch, and watches `updatefound` → `installing.statechange` for one that
   starts waiting afterwards; `sw.js` answers `{type:'SKIP_WAITING'}` by calling `skipWaiting()`.

**The other half, from the previous turn, is in the same delivery set.** `sw.js`'s fetch handler now
answers **navigations** network-first (cache only as the offline fallback) and never stores
`version.json`. The old cache-first navigation branch pinned the release document under its own
versioned URL, so the page kept the old `?v=` tokens, kept asking for the old generation, and the
one document that could have moved the device forward was the one document the cache refused to
refresh. That is the deadlock an uninstall was breaking.

**The throttle is the part that had to be right.** Three reasons to ask collide constantly — an
installed app launched *is* a foreground event — and without the guard this fix would have become a
request generator on every device. Measured in the sandbox: a launch followed by three more reasons
in the same minute costs **one** `reg.update()`; a hidden tab costs **none**; a check that is
already in flight is not repeated, and the flag is cleared by the ANSWER rather than left set.

**Checks.** Full suite **246 passed across 15 suites, 0 failed** (231 → 246). New
`tests/sw-update.test.js` — 15 tests that slice the **real** registration block out of `index.html`
and run it in a vm with a fake `navigator`/`document`/clock, so the triggers cannot drift away from
the test. **Mutation check 17/17 caught, 0 missed, 0 unproven**, with the baseline green in the same
workspace first: the launch call removed, the timer removed, the foreground trigger removed, the
throttle removed, the in-flight guard removed, the flag never cleared, the failure path made noisy,
the hidden-tab guard removed, the first-install guard removed, the double-reload guard removed, the
blur guard removed, the launch nudge removed, the `updatefound` wiring removed, the nudge sent
before the install finished, a non-versioned registration URL, the `sw.js` message handler removed,
and `sw.js` activating on any message at all.

**One assertion was wrong before the mutation pass, and it is worth recording**: the
"an installing worker that is not installed yet is left alone" test passed with `reg.waiting`
`null`, where *no* nudge is possible anyway — green, and proving nothing. It now parks an older
worker in `waiting` first, which is the state the guard actually exists for.

**End to end, in the real browser, with no uninstall.** A copy of the shell was served at a
sub-path of the preview origin and loaded twice (the second load is the one that has a controller,
which is what arms the auto-reload):

| | before | after |
|---|---|---|
| `caches.keys()` | `['gvsi-shell-v3.9.19']` | `['gvsi-shell-E2E-PUBLISH-2']` |
| `performance…navigation[0].type` | `navigate` | **`reload`** |
| `navigator.serviceWorker.controller.state` | `activated` | `activated` (the new worker) |
| waiting / installing | — | none |

The publish was a `STATIC_CACHE` generation change in the served `sw.js` at the **same URL** (a
static server ignores the query string, exactly as GitHub Pages does). The only thing the page was
then given was one foreground event — with the 15-minute throttle skipped by moving the clock
forward, which is what a wall display does by waiting. The reload was confirmed both by the
navigation type and by a marker that lived on the pre-update document and was gone afterwards, and
the app came back rendering live data.

**Files.** `index.html` (the registration block: three triggers, one throttled body, the waiting
worker nudge) · `sw.js` (the `SKIP_WAITING` message handler) · **new** `tests/sw-update.test.js`.

**Two things said out loud rather than quietly fixed.** The E2E copy shared the preview's **origin**,
so its `activate` deleted the preview app's cache generation as well as its own — the root worker
re-populated it on the next load (verified: 16 entries, `olt-module.js` present, one registration),
but a second origin would have been the cleaner harness and is recorded in `.freebuff/run.md`. And
the release is still owed: `node scripts/bump-version.mjs --check` reports `delivery set changed,
release did not (HEAD published 3.9.19)` for `index.html` and `sw.js` — until the label moves, none
of this reaches an installed device.

**The upgrade path, measured after the release (2026-09-22), with the real files rather than a
working-tree copy.** A throwaway copy of the **3.9.19** tree was extracted at a sub-path of a
**pristine** origin — its own worker, its own cache generation, its own `?v=3.9.19` tokens, and no
`checkForShellUpdate` in the document — loaded twice so it was controlled at script time, and then
the **3.9.20** tree was extracted over it at the same paths: a publish at the same URLs, which is
what a Pages deploy is. The page was then given one foreground event, the only trigger a 3.9.19
build has, with its 5-minute throttle skipped by moving the clock.

| | before | after |
|---|---|---|
| shell | 3.9.19 (no new trigger, no 3.9.20 What's New) | **3.9.20** (both present) |
| `styles.css?v=` | 3.9.19 | **3.9.20** |
| worker scriptURL | `sw.js?v=3.9.19` | **`sw.js?v=3.9.20`** |
| navigation type | `navigate` | **`reload`** |
| the marker left on the old document | present | **gone** |
| waiting / installing | none | none |

So a device on 3.9.18 or 3.9.19 — the builds carrying the `controllerchange` reload — updates
itself on its next foreground return, and anything older still receives the new worker and takes the
new shell on its next launch. **Neither needs an uninstall, a cache clear, or a new browser.**

**A false trail worth recording, because it cost a cycle.** The first attempt at this same test ran
on the dev origin the preview panel uses, which still had a registration from an earlier session
(worker `sw.js?v=3.9.18`, with a newer one parked in `waiting`). There the published update *was*
fetched and installed — a new cache generation appeared — and then sat in `waiting` while the old
worker kept serving the page; neither that worker's own install-time `skipWaiting()` nor a
hand-sent `SKIP_WAITING` promoted it. I did not explain that, and did not chase it, because the
same sequence on a clean origin behaves exactly as designed. Two things follow: a verification
origin must be **pristine** (a second `python -m http.server` on a free port is the cheap way), and
that stuck `waiting` state is not hypothetical — it is the state the nudge exists for.

---

# PART-019 — the warm pass: five modules, one run (2026-09-24)

**The question that led here.** *"Kung ginawan ko ng tig-i-isang database sheet ang bawat module sa
NetPulse, makakatulong ba ito sa pagbilis ng data loading?"* — **no**, and the evidence is the
reason: every module already reads only its own sheet, so splitting the file removes no read; the
cost that dominates is the **~1.1 s floor** (Apps Script startup plus the `302 →
googleusercontent` echo hop), which is paid whether a call hits the cache or not and is untouched
by the number of spreadsheets; and `CacheService`, `PropertiesService` and the two invalidation
triggers are scoped to the **script**, not the spreadsheet, so a split breaks the change-notification
path that closed the 11-minute staleness incident. The measured shape of the same five calls is the
cleanest answer: **one warm module (1,096 ms) costs about what all five warm together cost
(1,156 ms)**.

**What was built instead.** The user's stated goal was *data on screen within about three seconds*
for operators who open the app for three minutes at a time. One clock trigger, `warmDataCaches`,
now rebuilds every module in one execution — `olt → nap → lcp → node → backbone`, sequentially,
TTL 180 s per type, OLT first. `warmOltCache()` is left **byte-identical**; it still owns `shape=3`,
`OLT_WARM_TTL_SECONDS` and its log line, and the five assertions that cover it keep their meaning.
TTL stays **below** the interval — the rule the 2026-09-18 incident was closed with — so a dead
warmer decays to slow-but-current rather than stale.

**Files.** `olt-cache-warmer.gs` (`warmDataCaches`, `warmTypeCache_`, `isBuildErrorEnvelope_`, two
constants, and a header that now states the pass, the floor and the budget) · `triggers.gs`
(`TRIGGER_PLAN` entry renamed, SCHEDULE header) · **new** `tests/cache-warmer.test.js` ·
`tests/triggers.test.js` and `tests/olt-warm-ttl.test.js` (the plan entry they assert).
**No client file changed** — no version bump, no `sw.js` generation move, no PWA update risk.

**One thing found while writing it, and it is the reason the detector exists.** A failed build does
not throw out of `doGet`: `code.gs` catches it and answers `{error:"build_failed", retryable:true}`
with a **200**. So a warmer that only wrapped `doGet` in a `try` would have logged a 74-byte
*success* over an empty cache, every five minutes, while every user paid a cold build — the same
silent-lie shape as the stale chip and the silent empty payload this project has had to hunt
twice. `isBuildErrorEnvelope_()` classifies the answer by its leading bytes and the pass reports
`FAILED: <type>` instead. (The OLT warmer predates the check and still logs success on a failed
build; that asymmetry is deliberate — changing a tested function in the same change that adds its
replacement is how a rename turns into a rewrite — and it is recorded rather than fixed here.)

**Checks.** Full suite **259 passed across 16 suites, 0 failed** (246 → 259; 13 new).
**Mutation check 15/15 caught, 0 missed, 0 unproven**, baseline verified green in the mutation
workspace before any mutation was believed. The mutations were aimed at the assertions that would
otherwise be decorative: a module dropped from the pass; OLT warmed with the wrong shape; a
secondary handed a shape; a secondary TTL outside the range `doGet` accepts; a type warmed whose
payload nobody reads; the build override no longer rebuilding; every call rebuilding (the cache
stopping caching); the pass stopping at the first failure; the error envelope ignored, **and** the
detector firing on any object payload; OLT's own throw no longer contained; the plan cadence
drifting from the file; the OLT TTL growing past the interval; the healthy fleet warmed; and the
pass bumping a revision counter (which would send every open dashboard to the sheet for nothing).

**The assertion that carries the change** is the one that would fail if the pass were writing a key
nobody reads: *after a pass, an HTTP call for any type is a HIT that touches no sheet*. It is run
per type, over the exact key the HTTP path computes, and it is what makes "warmed" a claim about
the request path rather than about a byte count in a log.

**Not run yet.** The Apps Script hand-off: paste `olt-cache-warmer.gs` and `triggers.gs`, run
`warmDataCaches()` **once by hand** (which is what produces the four unmeasured build times), then
`listTriggers()` → `setupAllTriggers()` → `listTriggers()` off-peak. Until that happens nothing is
warm that was not warm before, and `TODO.md`'s freshness item still waits on the same hand-off.

**Not fixed, and this is the honest part.** The intermittent **21 s origin 404** that reaches a
module as a red *"Error loading data."* row. Warming cannot touch an error path, and at ~7× the
worst cold build it remains the largest single source of a bad experience in this system. The
three-second goal is only partly served by this part, and the rest of it is a client release.

### PART-020 — one judge for every warm build (2026-09-24)

**The asymmetry PART-019 recorded as open, and why it was not cosmetic.** PART-012 left
`warmOltCache()` byte-identical on purpose — rewriting a function that five assertions cover, in
the same change that adds its replacement, is how a rename turns into a rewrite. The cost of that
deferral was specific and worth writing down: OLT's build failure was the one failure in the pass
that **threw nothing**, because `code.gs` catches it and answers the envelope with a 200. So a
failed OLT build logged *"✅ OLT cache warmed in 3120ms (74 bytes)"* and the closing line read
**"5 of 5 module(s) rebuilt"** with nothing under `FAILED:`. Both of those are the numbers an
operator reads to decide the cadence, and OLT's build time is the only one of the five that is
actually measured — so the one module whose result nobody verified was the module the whole
budget is sized around.

**What changed.** One function, `judgeWarmResponse_(label, content, elapsed, ttlSeconds)`, is now
the single place that decides what "warmed" means: envelope check, success line, cadence warning,
and the return value (`ms`, or `-1` when nothing was cached). `warmOltCache()` and
`warmTypeCache_()` both report through it — the OLT warmer keeps the two things its assertions are
actually about (`shape=3` and `OLT_WARM_TTL_SECONDS`) and gives up its own verdict. The pass then
counts OLT from that verdict rather than from *"it did not throw"*, which is what turns the
closing line back into a description of what happened: **"4 of 5 module(s) rebuilt — FAILED:
olt"**.

**The assertion that keeps the detector honest.** OLT's payload is an object envelope beginning
with a brace — exactly the shape `isBuildErrorEnvelope_()` looks for — so *"a real OLT build is
still read as a success, and writes its entry"* is not decoration. Without it, a detector that
fired on any object payload would report every healthy OLT run as a failure and the mutation pass
would not notice.

**Files.** `olt-cache-warmer.gs` (`judgeWarmResponse_` added; `warmOltCache`, `warmTypeCache_` and
`warmDataCaches` all rewired; the docstring paragraph that recorded the asymmetry replaced by what
is now true) · `tests/olt-warm-ttl.test.js` (+2) · `tests/cache-warmer.test.js` (+1) ·
`plans/PART13_PLAN.ai.md` · `MASTER_PLAN.md` (Part 13) · `TODO.md` and `.freebuff/run.md` (the log
lines an operator will actually see). **No client file changed** — no version bump, no `sw.js`
generation move, no PWA update risk.

**Checks.** Full suite **262 passed across 16 suites, 0 failed** (259 → 262; 3 new). **Mutation
check 5/5 caught, 0 missed, 0 unproven**, baseline verified green in the mutation workspace before
any mutation was believed. The five mutations: the judge returning `elapsed` instead of `-1` for
an envelope; `warmOltCache()` bypassing the judge entirely with the old unconditional success
line; the detector returning `true` for everything; OLT counted from the absence of a throw; and
the throw path no longer naming OLT. The second of those is the one that proves the wiring rather
than the helper — it restores the pre-change body verbatim and the new assertion still fails.

**Still not run.** The same Apps Script hand-off PART-019 left open: paste `olt-cache-warmer.gs`,
run `warmDataCaches()` **once by hand** (still the only source of the four unmeasured build
times), then `listTriggers()` → `setupAllTriggers()` → `listTriggers()`. Until that happens the
live project runs the old warmer, and its log will look correct for a reason that is no longer
true.

**Still not fixed.** The **21 s origin 404** behind *"Error loading data."* — untouched here, as
in PART-019, and still the largest single source of a bad experience in this system.

### PART-021 — module diagnostics, server side only (2026-09-26)

**The ask, and what it turned out to need.** *"Dagdagan ng function ang admin module na kaya
nitong idetect ang module na nagca-cause ng pag bagal."* The facts already existed and nothing could
read them: `buildCtx_` carries type, stage, sheet, rev and elapsed ms through every build and
spends them on one `❌ Build failed | …` line in the Executions log, and `warmDataCaches` computes a
per-type build time every five minutes and throws every number away. What was missing was a reader —
and the discipline that the reader must not cost the thing it measures.

**The cost model, which is the design.** A first version of this recorded a sample after every
SUCCESSFUL build: one property read on the coldest, slowest path in the app, which is a diagnostic
that makes the slow thing slower. It is removed by construction rather than by care. Successes store
nothing. A failure stores — one read plus one write, rare, and it is the sample being looked for. A
slow build is written with **no read at all**: the elapsed time is compared against a constant and
only a build over it writes, so a healthy build pays one integer comparison. The warm pass writes
once per run, in the trigger's own execution, and it is the only source of the four build times
nothing had ever measured. Against the documented 50,000 properties/day that is ~288 writes, sharing
the budget with the ~14,000/day rev poll.

**The claim that had to be measured before it could be relied on.** "A property read is a fraction
of a 1.5 s build" was a hypothesis, so it shipped with an instrument instead of an argument:
`measurePropertyCost()`, run by hand, with a GO/NO-GO verdict. It is deliberately BRACKETED — one
`getProperty` can be answered from an in-execution cache and understate the cost, while
`getProperties()` reads the whole store and cannot — and the verdict is taken on the **pessimistic**
bound, so a GO is a GO even if the optimistic number was a lie. `DIAG_REQUEST_HOOKS_ENABLED` shipped
`false` while the gate was unrun; it now ships **`true`**, because the gate has been run on the live
store three times and every run after the first passed — and run 3's own `→ nothing to do` line proves
the deployed copy carries the constant. (It proves nothing about the `code.gs` side: the two hook call
sites live there, and only the `code.gs` paste and a `?action=diag` read show that they are called.) The pass record and the report were never gated behind that switch,
because neither of them runs on a request — gating them would hide the very number the switch is
waiting for.

**It was run on the live project three times in one hour — and the first verdict was wrong about
itself.**

```
                        run 1 (12:33)   run 2 (12:42)   run 3 (12:57)
   single getProperty   25ms (worst 50)  35ms (worst 58)  30ms (worst 77)
   getProperties()      25ms (worst 40)  35ms (worst 52)  38ms (worst 102)  <- the PESSIMISTIC bound
   setProperty          51ms (worst 134) 53ms (worst 111) 54ms (worst 119)
   share of a build     1.9%             2.7%             2.9%             (ceiling 5%)
❌ GATE NO-GO on all three, against thresholds that were guesses (20 ms read, 50 ms write)
✅ GATE GO on runs 2 and 3: 2.7% and then 2.9% of a 1290ms cold build, writes inside their backstop
```

The premise the design rests on came back at **1.9%**, then **2.7%**, then **2.9%** — a property read
is a fraction of a build. The NO-GO came from the thresholds being absolute numbers I had picked (20
ms, 50 ms) while the claim is relative, and from a failure message that said the measurement "is not
a fraction of a build" when the line directly above it printed 1.9%. **An instrument whose reason
contradicts its own reading is measuring the wrong question**, and one of those thresholds failed by a
single millisecond — a limit a healthy system fails by 2% is not a safety limit, it is a coin toss
with a comment on it.

**Runs 2 and 3 are what turned that from a correction into evidence.** Nine minutes after run 1 the
single-read median had moved **40%** (25 → 35 ms) with every absolute number moving up with it, so the
discarded thresholds would have failed **all three** runs, by one millisecond and then by three. A
healthy system failing the same limit three times, by different amounts, is not a slow store: that is
a mis-set limit, and it is the recorded reason the verdict is a share plus one write backstop rather
than three invented ceilings. The three readings are also why the ceiling is **5%** and not 3%: the
observed range is 1.9% to 2.9%, so the limit has to clear everything the instrument has ever said —
about **1.7x** the worst reading — and anyone re-tuning it should re-run it first.

**Run 3 also corrected a note I had already written, and the correction is kept visible.** The note
said a single-key `getProperty` costs the SAME as a whole-store `getProperties()` (25 ms both on run
1, 35 ms both on run 2), and concluded that there is no cheap single-key read. On run 3 the
whole-store read came out **dearer** — 38 ms against 30 ms median, 102 ms against 77 ms worst. The
honest statement is that the two are the same order and which one wins is not stable, which is
exactly what taking the verdict on the **pessimistic** bound protects against, and it is the bound
that turned out to be the expensive one. What still follows: anything answerable from one
whole-store read should use one rather than N single reads, which is what `buildDiagReport_()` does.

The verdict is now the **share of a cold build**, with one absolute backstop on the WRITE and none on
the read, because once the build is fixed a share limit *is* an absolute limit (5% of 1290 ms is
64.5 ms) — a second read ceiling could only ever repeat the share's message, never fire alone, and a
branch that cannot be observed is a branch nothing can test. The recalibration is recorded here and in
the file's own header rather than quietly applied, and it is **pinned to these numbers by a test**:
25 ms / 25 ms / 51 ms must come back GO, 35 ms / 35 ms / 53 ms must come back GO with headroom under
the ceiling, and a ceiling tightened past the observed spread must fail. If a future run of these
numbers fails, the gate has been mis-set again — not the property store gone bad.

The GO verdict is also **state-aware**, because run 2 exposed a second, smaller version of the same
illness: the message an operator sees after flipping the switch was still telling them to flip it.
`judgePropertyCost_()` now answers `nothing to do: DIAG_REQUEST_HOOKS_ENABLED is already true` when it
is, and the instruction only appears on a copy that has not been flipped. Both arms are asserted — the
one that keeps an instruction honest is otherwise unobservable.

**Three things the measurement bought, none of which were assumed.**

| | |
|---|---|
| a property read is 25–38 ms | not the sub-millisecond a design like this tends to assume, and its own spread between two runs nine minutes apart was 40%. Under 3% of a build in every run, so affordable — but the rev poll (`currentDataRev_()`) and the build-time witness (`dataRevOf_()` twice per build) each pay it on a path that runs constantly, and that number is now their input rather than a guess. |
| a whole-store read is NOT the cheap one | 25 ms both on run 1 and 35 ms both on run 2 — and then **38 ms against a single read's 30 ms on run 3**, with worst cases 102 ms against 77 ms. The equality did not hold, and this note was corrected rather than quietly edited. The verdict was already reading the pessimistic bound, which is the one that turned out to be dearer; what still follows is that anything answerable from one `getProperties()` should use one call rather than N — which is why `buildDiagReport_()` reads the store once for every key it needs. |
| `setProperty` is the expensive one | 51–54 ms median, 134 ms worst across three runs. This is the case for the design's central discipline rather than against it: successes write nothing, fast builds write nothing, and only a failed or genuinely slow build reaches a write at all. |

**The silent-lie shape, closed twice.** The slow-build hook sits inside `doGet`, so a suite that
loads `code.gs` without `diagnostics.gs` exercises a hook that is inert and **stays green about it** —
the same shape as the 74-byte "warmed" line PART-020 fixed. So: both call sites check the function
exists and log loudly when it does not (once per execution, not once per build, or the warning
becomes noise), the recorders catch their own failures so a diagnostics fault cannot turn the one
path whose job is to answer into an HTML error page, and `tests/diagnostics.test.js` asserts that all
five suites which run a build load the file. A convention would not have survived the first honest
refactor; an assertion does.

**The gate is the part that matters most and is the least visible.** `?action=diag` is admin-gated
with `resolveSession(e, ADMIN_ROLE)` **and refuses a null session as well as an error** — because
`resolveSession` answers `{session: null, error: null}` for an untokened caller while
`REQUIRE_SESSION` is false, and a role check that never ran is not a gate. The suite drives that exact
case by flipping the switch in the sandbox. Both the no-token and the NON-admin cases assert that the
body carries none of the internals. The route is read-only in the strict sense: no spreadsheet, no
build, no cache write, no revision move — asking what is slow must be incapable of adding load.

**Found while designing, recorded and not fixed here.** The same null-session hole exists in
`handleSetMaintenance`, where the actor falls back to `"unknown"`. It is written into the file's own
header, where the next reader will meet it.

**Files.** `diagnostics.gs` (new: `measurePropertyCost`, `judgePropertyCost_`, `diagMedian_`,
`recordBuildFailure_`, `recordSlowBuild_`, `recordWarmPass_`, `diagCacheState_`, `buildDiagReport_`,
`handleDiagnostics`, `diagStatus_`) · `code.gs` (the route line; `recordBuildFailure_` in
`buildFailedOut_`; `recordSlowBuild_` at the end of every build; `cacheKeyFor_`, `cacheTtlFor_`,
`propStampKey_` and `dashboardShapeFor_` extracted to one place each) · `olt-cache-warmer.gs`
(`warmDataCaches` keeps the per-type ms it already computed) · `tests/diagnostics.test.js` (+36) ·
the five build-running suites load `diagnostics.gs` · `plans/PART14_PLAN.ai.md` · `MASTER_PLAN.md` ·
`TODO.md` · `.freebuff/run.md`. No client byte, no version bump, no new trigger, no
`setupAllTriggers()`.

**Checks.** Full suite **336 passed across 19 suites, 0 failed** (262 → 336, together with PART-022).
30 mutations for this part, every one caught — including the two that guard the flipped switch (a
`DIAG_REQUEST_HOOKS_ENABLED` turned back to `false`, and a report whose note drops either live
reading). Three were caught only after something real was fixed, and each one is worth naming because
none of them was in the feature:

  - the first pass reported **one MISSED** — removing a hook's own off-switch left the suite green —
    and the cause was in the harness: `__propsWritten` was `writes.map(...)`, a snapshot taken at
    sandbox creation, so every "it wrote nothing" assertion had been comparing against an empty array
    forever. It is an accessor now, and that fix immediately exposed a second vacuous assertion in the
    same file (`measurePropertyCost` obviously writes its own probe; the assertion had to say "wrote no
    RECORD", not "wrote nothing").
  - the recalibrated gate's own branch for an unpaid reading — an unmeasured whole-store read while the
    writes were fine — had **no test**, because the all-empty case is caught by the write backstop and
    therefore proves nothing about the read. `null > 5` is false, so that shape would have read as a
    PASS on the strength of a measurement the gate never took.

That is the value of the pass, stated plainly: a mutation nobody notices is the only way to find an
assertion that cannot fail.

**The gate, closed — and `diagnostics.gs` is pasted.** It has been run three times, the instrument was
recalibrated against its own numbers rather than the other way round, and every run after the first
passes. `DIAG_REQUEST_HOOKS_ENABLED` is **`true` in the shipped file**, and run 3 proves the PASTED
copy agrees: its last line reads `→ nothing to do: DIAG_REQUEST_HOOKS_ENABLED is already true and the
hooks are recording`.

**What that does and does not prove, because the difference is the whole point of this section.** It
proves `diagnostics.gs` is deployed and its switch is on. It does **NOT** prove the two request-path
hooks are being called: those call sites live in `code.gs` (`recordBuildFailure_` inside
`buildFailedOut_`, `recordSlowBuild_` at the end of a build), and a gate that reads a constant cannot
see which file the constant was pasted beside. The `code.gs` paste settles it, and `?action=diag`'s
`failures[]` is how you see that it did — an empty list from a store that has never failed is
indistinguishable from a hook that is not there, which is why the route is read AFTER a paste and not
instead of one.

That the repo and the editor agree on the constant matters beyond this repository: a copy flipped by
hand while the file still said `false` would silently turn the hooks back off at the next paste, which
is why the constant and its reason live in the file rather than in a note. **Still owed, and it needs
the operator:** paste `code.gs` + the current `diagnostics.gs` (the routes, the bundle, and the two
hook call sites — no trigger change, no `setupAllTriggers()`), curl `?action=diag` with an admin token
to read the new record, and paste `olt-cache-warmer.gs` for PART-022's two constants — see
`.freebuff/run.md` §8.

### PART-022 — the cold window, and the opening in one request (2026-09-26)

**What the operator reported.** *"Nagkakaproblema ako sa sobrang tagal ng paglabas ng data sa app —
LCP, NAP, BACKBONE kadalasan itong nangyayari."* Two causes, both arithmetic:

  - `olt-cache-warmer.gs` writes a **180 s** entry on a **300 s** cadence. The entry dies at T+180
    and the next pass is at T+300, so **120 s of every 300 s has no entry at all** — 40% of the
    time, all five modules cold, and every request in that window pays a full build instead of a
    hit. This was not an oversight: PART-012's header argues for it explicitly, and chose it while
    the four secondary build times were still unmeasured.
  - index.html fetched **one** module on load. Each of the other four arrived on its first tab click,
    so a session glancing at three tabs spent four round trips — every one paying the ~1.1-1.5 s
    floor in full. Measured payload sizes sum to **5,503 bytes**: ~6 s of protocol overhead to move
    5.5 KB. And lcp's build is **16 rows** — the cost was never the data.

**The finding that decided the shape of this part.** `prefetchOtherTabsInBackground()` — the staggered
sweep the warmer's own comments still credit with covering the other four modules — **is dead code**.
It is defined at `index.html:1250` and called from nowhere, so the app had been fetching each module
on first tab visit for however long, and the comment claiming otherwise was load-bearing fiction in
`olt-cache-warmer.gs` and in `code.gs`. It was worse than dead: its 5 s timer was the **only** caller
of the daily snapshot writer, so a once-a-day record that the spreadsheet can no longer be asked for
had stopped being written, and nothing said so. The call moved to `loadInitialData()`, where its
reason is a visible line, and `tests/analytics-dashboard.test.js` — which pins the count at exactly
one — caught the first draft of the comment that moved with it.

**The TTL, and why raising it does not re-open the 2026-09-18 incident.** Freshness is the CADENCE,
not the TTL: every warm run rebuilds unconditionally and overwrites, so a hit can never be older than
one interval whatever the TTL says — a claim `tests/olt-warm-ttl.test.js` already asserted before this
change. That leaves the TTL one job, bounding the DEGRADED case, and a TTL under the interval
therefore buys nothing except a guaranteed cold window on every cycle. 180 → 330 s. The binding
constraint is the LAST write of a pass, not the first: five builds take ~9.1 s, so the entry written
last must outlive `interval - pass_duration ≈ 291 s`, and 330 leaves ~39 s for a late or drifted run.
Shortening the cadence instead would be ~109 min/day against the documented 90 min/day trigger quota,
which is asserted rather than remembered.

**Two assertions were INVERTED, not added.** Both suites carried a test that encoded the old rule —
`assert.ok(OLT_WARM_TTL_SECONDS < intervalSeconds)` and "every warmed TTL stays under the interval" —
so the change could not be made quietly. They now assert the arithmetic in the other direction, with
the dead window computed rather than described: `interval - ttl <= 0`, and a margin assertion that
catches a TTL of exactly 300 as well, because a margin of zero has no tolerance for a late pass.

**The opening, in one request.** `?action=bundle` answers all five modules from cache in one
execution. It is **read-only**: no spreadsheet, no build, no cache write, no revision move, and it
does not even delete a property entry it judges expired — dropping a dead entry is the next real
request's job, or asking what is cached becomes a mutation. A module it cannot answer is named in
`missing`, and the client fetches it over the route it already had. The keys are derived from
`DATA_TYPES` rather than restated, and `cacheKeyFor_`/`cacheTtlFor_`/`dashboardShapeFor_` were
extracted so the two read paths cannot come to disagree about whether a payload is alive.

**The client half fails open, always, and that is the safety argument.** `boot-bundle.js` hydrates
`dataCache`, sends OLT through the module's **own** `applyOltPayload()`, stamps `fetchGate` so a
hydrated type does not go straight back to the network, and resolves — never rejects — for a missing
route, an unknown-action envelope, a rejection, a hang, a wrong-shaped payload, or a type this build
has no module for. If the route is not there, the app loads exactly as it did before the file existed:
that makes the deploy order irrelevant and the change removable by one `<script>` tag. The shape
checks are duplicated from the loaders on purpose, because the bug they prevent is the one this app
has already shipped — an OLT prefetch that stored the raw compact envelope where a decoded row array
belongs, leaving the tables and the summary cards describing two different payloads.

**The bug the suite found in my own client code.** The hydrate loop's OLT branch `continue`d before
stamping the gate, so the one request that replaced five would have been followed by an immediate OLT
refetch — OLT being the module whose loader queues a refresh every time it draws. "the gate is told
about every hydrated type" is what caught it.

**Files.** `olt-cache-warmer.gs` (two constants; the header paragraph rewritten around the
arithmetic) · `code.gs` (the route line, `handleBundle`, the extracted key/TTL/shape helpers; the
stale "the app prefetches all five on every load" claim corrected) · `boot-bundle.js` (new) ·
`fetch-gate.js` (`noteHydrated`) · `index.html` (`boot-bundle.js` loaded, `renderTabFromCache()`,
the opening, the snapshot call restored, the dead sweep removed) · `sw.js` (`boot-bundle.js`
precached) · `tests/bundle.test.js` (+16) · `tests/boot-bundle.test.js` (+18) · the two TTL
assertions inverted · `plans/PART15_PLAN.ai.md` · `MASTER_PLAN.md` · `TODO.md` · `.freebuff/run.md`.

**Release.** Version **3.9.20 → 3.9.21** with the guard left at **3.10.0**: `sw.js` generation, both
`index.html` `?v=` tokens, the three `manifest.json` fields and `version.json`, moved together by
`scripts/bump-version.mjs`. `--check` confirmed the guard did not move, and confirmed the delivery set
had changed while the release had not — the failure that produces no error anywhere at runtime.

**Checks.** 19 suites, **336 cases, 0 failed**. 23 mutations for this part, every one caught. Two
first-pass results are worth recording rather than smoothing over: the array half of the payload shape
check had **no test at all** (the only wrong-shape case was lcp's, which exercises the other half), and
it took a mutation to reveal it — a removed check that the suite did not notice because nothing tested
it. Both halves are covered now. The two cases beyond PART-021's count are the two that close the gate
over here: the TTL arithmetic (`interval - ttl <= 0`, with a margin assertion that catches a TTL of
exactly 300) and the inverted `332`-era premise — they live in the suites this part changed.

**Still owed.** The paste (`olt-cache-warmer.gs`, then `code.gs` + `diagnostics.gs` for the routes)
and the push. Until the push, the live app still loads one module at a time and still has a 120 s cold
window every cycle. The **gate** is no longer part of what is owed: it read GO three times on the live
store and the pasted copy is recording, so the request-path hooks are **live**. The release label is
now **3.9.22** — 3.9.21 was never pushed, so one push carries this part and PART-023 together.

**Still not fixed.** The **21 s origin 404** — untouched by all of this, and the bundle only removes
one of the conditions that produce it (three concurrent cold builds). The **60 s `cacheTtl`** a
CLIENT-built `node`/`olt`/`backbone` entry receives is also untouched: it only matters once the warmer
is dead, and it is a freshness trade of its own rather than a bug.

### PART-023 — what the device waited (2026-09-26)

**What was asked for.** The client half of the diagnostics: read the edge's own timings, sample every
call in `fetchWithRetry`, and put a Module Health card in the admin module.

**Why the server half was not enough — the whole reason this part exists.** `?action=diag` answers
what the ORIGIN spent, on which sheet, at which stage, and it never sees the phone. Those are
different questions with different fixes. A build that takes 3 s on the origin and 9 s on a handset is
not a slow module; it is a slow phone or a bad cell, and three attempts through a jittered backoff do
the same thing to a fast origin. The number that separates them is **this device's wall clock minus
the origin's own time**, and only the device can compute it.

**The measurement was already being taken and read by nothing.** The Cloudflare worker sets
`x-netpulse-origin-ms` and `x-netpulse-attempts` on every response and already exposes both to
JavaScript in its CORS headers. `grep` found no reader anywhere in the app — the same shape as
`buildCtx_`, which carried type/stage/sheet/rev/elapsed through every build and spent them on one log
line.

**The constraint that chose the design, rather than a caveat about it.** The proxy is OFF
(`window.NETPULSE_PROXY = ""`, 2026-09-15), so those headers are ABSENT on every live call — which is
also why this part has to be useful without them. So `originMs` is **null** when the edge did not say,
the summary **counts** how many samples carried edge timing, and the card says in words that the
edge numbers are unavailable. `0ms` for a measurement nobody took is one `|| 0` away, and there are
tests on both sides of that boundary — the parser and the column.

**What shipped.**

| | |
|---|---|
| a bounded store | 20 samples per label, 24 labels, and a SHOWN count of what was dropped. Memory only: no localStorage, no IndexedDB, nothing sent anywhere — a persisted history would survive the app wipe and then describe a session that ended days ago as if it were now. |
| one sample per call, not per attempt | recorded at both exits of `fetchWithRetry` — the one function every module, admin and auth call already passes through. `attempts` is kept because "slow" and "slow but retried" have different fixes. |
| the label rule | `?type=lcp` → `lcp`, `?action=diag` → `action:diag`, anything else → `other`. Derived from the request the app actually made, so a module added later is measured without anyone remembering; sanitized to `[A-Za-z0-9:_-]` because the label reaches `innerHTML`; and never carrying a query value. The login call the app builds puts the password in its query string, so a test records exactly that URL and searches the whole snapshot for it. |
| the card | worst module first, with calls, wait p50/p95/worst, the origin's median, the per-call overhead, retries, failures, the last error and the age. Refresh re-reads memory. No timer, no request, no storage. |
| a released file | `diag-store.js` added to `sw.js` precache, and a test that every local script tag in `index.html` is precached — an invariant that until now depended on a human remembering. |

**Two defects the suite found, neither of them in the feature's happy path.**

  - `tests/origin-resilience.test.js` lifts the real `fetchWithRetry` out of `index.html` by line
    slicing. Adding two helpers ABOVE the function broke it — and the way it broke was the finding:
    the recording call sits inside the `try` that decides whether to retry, so the ReferenceError was
    caught as an origin failure, spent three attempts, and ended with the module reported as having no
    data for a request that had succeeded. That is a diagnostic breaking the thing it measures. The
    fix is a guard at the call site as well as inside the store, the slice now starts at the hooks so
    it cannot silently test a client this app does not have, and a new test drives a store whose
    `record()` throws and asserts the data still arrives on one request.
  - the label whitelist and the case fold were composed wrongly: lowercasing the value and then
    stripping everything outside `[a-z0-9:_-]` would have renamed `action:setMaintenance` to
    `action:etaintenance`. A mangled name is worse than two spellings of one, because only the intact
    one is visible on the card.

**Checks.** 20 suites, **384 cases, 0 failed** (336 → 384). 38 mutations for this part, every one
caught — including the ring bound, the label cap and its counter, the case fold, the `|| 0`
coercion, the even-count median, nearest-rank p95, per-call overhead, error truncation, a
`record()` that rethrows, a snapshot that hands back its live arrays, each of the two exits of
`fetchWithRetry`, the call-site guard, the card's no-store branch, its sort order, its escaping, its
column count, the call count beside each label, and `diag-store.js` missing from the precache. The
card is also **drawn** in a sandbox with a stand-in document: reading a template is how a card ships
with an undefined column that renders as a dash and looks like "no data".

**And it was looked at, which is not the same as being tested.** Rendered in a browser against the
real `styles.css`, the first version had **ten columns** and pushed `Retries`, `Failed` and the age
off the right edge behind a horizontal scroll — on the very screen the card is read from. No text
assertion could have seen that. The fix is not a dropped number: `Calls` folded into the module cell
where it reads better anyway ("backbone · 7"), `Worst` moved to the p95 cell's title, and the edge
column labelled and titled rather than spelled out. Eight columns, nothing lost, and the screenshot
is why.

**The release folds two parts.** 3.9.21 was never pushed — PART-015/022's `?action=bundle` and the
TTL change have existed only in the working tree — so the label moves once to **3.9.22** and the
single push delivers the bundle, the warmer TTL and this card together. The guard is untouched at
3.10.0, as it must be.

**Still owed.** The paste (`olt-cache-warmer.gs`, then `code.gs` + `diagnostics.gs`) and the push.
`diag-store.js` arrives with the push; a device that gets the new `index.html` before the new file is
cached has a hook that records nothing rather than one that fails, and that case is asserted.

**Deliberately not here.** Merging `?action=diag` into the same card: it is a request, and this
card's rule is that opening the tab costs nothing. The two reports are read side by side. And the
**21 s origin 404** is still open — but the card can now SEE it (attempts above 1 with a large
overhead), which is the first step toward fixing an error path nobody could attribute.

### PART-024 — the spare attempts are for blips, not for stalls (2026-09-26)

**What was asked for.** Read the live `?action=diag` report and the warm-pass log after a few days of
real traffic, then fix whichever module the collected failures and slow-build records point at.

**What could not be read, and the substitute.** `?action=diag` is admin-gated, there is no credential
in the workspace, and the login route has a lockout — so the report was not read, and asking for a
token was not an option. The substitute was to measure the same facts from OUTSIDE the deployment,
which is the instrument the warm pass already uses: time each route, and compare a route that does one
property read (`?action=rev`) against one that does one cache read (`?action=bundle`) against the
heaviest builder (`?type=olt&shape=1`, 461 rows).

**The finding, which was not a module.** Fifteen module requests on the hit path answered in
**1.06–1.40 s** — the bare `?action=rev` floor, i.e. the app's own data cost nothing worth
attributing. What the failures had in common was that they were not about a module at all: they were
Apps Script's 8 KB error page after **7.5 s, 16.0 s and 30.8 s**, once a redirect chain that outlived a
40 s cap, and — the decisive one — `?action=rev`, a single property read of 80 bytes, taking **16.0 s**
inside the same window. A module cannot slow down a route that reads no sheets.

**The bug the measurements found in our own code.** `fetchWithRetry` retries after 250–750 ms of
jittered backoff, against stalls that lasted at least 30 s and cleared inside 60 s. Four consecutive
OLT requests inside one stall window all failed; the same request 60 s later answered in 1.48 s. So the
retry was guaranteed to land INSIDE the same stall: three times the wait, three times the load, on a
deployment that was already struggling. Waiting the stall out inside the request is not available
either — `fetch-gate`'s ceiling is 30 s, shorter than the stall it would have to wait through.

**The threshold is derived, not chosen.** 5000 ms sits above the slowest SUCCESSFUL attempt ever
measured here (3.23 s, `shape=4`) and below the fastest failing one (7.5 s). The rule reads a marker on
the error, not a status code, because `retryable:true` is the origin asking for a retry BY NAME and it
arrives at build duration — inside the window a naive duration threshold would swallow.

**A false finding, caught before it was recorded.** `?type=olt&shape=3` returns **216 bytes** with `p`,
`m` and `r` all empty while `meta` claims `total: 461, up: 461`, which reads exactly like a module
sending no rows for 461 live OLTs. It is not: shape=3 is **problem-only by design**, and all 461 were
UP. `?type=olt&shape=1` returns all 461 rows (54,077 bytes) in the same minute, and `shape=4` returns
28 KB. Recorded here because "empty array" and "nothing sent" are the same 216 bytes on the wire and
the difference is the whole question.

**And the night's `?action=bundle` 404 was the same stall, not a missing paste.** `?action=bundle`
answers **200, 1.18 s, 3,607 bytes** with a real five-module bundle, and
`?action=definitelynothere` answers `{"error":"Unknown action: …"}` in 1.71 s — so the dispatch is
reachable and the route table contains bundle. Nothing was owed on that route after all.

**Checks.** Full suite **389 passed across 20 suites, 0 failed** (385 → 389). Ten mutations for this
part, every one caught: the rule removed entirely, `>=` weakened to `>`, the threshold moved to 1 s and
to 30 s, the envelope marker dropped, the envelope never marked, the per-attempt clock reset removed,
`stalledAt` never set, the report's stall clause removed, and the warning's. Two earlier mutations were
**not** caught and both were correct findings rather than test gaps: the `retryable` flag was redundant
beside `fatal` (replaced by one `envelope` flag that is observable), and nothing asserted the warning's
presence (added). The clock that makes a 30.8 s stall testable without waiting 30.8 s is a fake
`Date.now` in the harness — the same trick the suite already used for `setTimeout`.

**Release.** 3.9.22 → **3.9.23**; guard untouched at 3.10.0. No server byte, no new request, no new
query parameter, no worker redeploy — the one line that changed is the retry policy.

**Still owed.** The paste (`code.gs`, `diagnostics.gs`, `olt-cache-warmer.gs`) and the push — and one
line in the Apps Script editor to read the report this part could not read:
`Logger.log(JSON.stringify(buildDiagReport_(), null, 2))`.

---

### PART-025 — a failed refresh keeps the screen it already drew (2026-09-26)

**What was asked for.** Two screenshots from the live app, and one question in Taglish: *“sa NAP at
BACKBONE kapag gathering data ang app, nace-clear din ang data na nasa table. Maari bang habang hindi
pa lumalabas ang latest data ay ang last fetched data muna ang nasa display?”* — while the latest data
has not arrived yet, can the last fetched data be what is on screen. The screenshots show NAP's table
reading **Error loading data.** while its four stat cards still hold the previous read's numbers
(35 / 15 / 1 / 51), and BACKBONE showing **All Backbone Links Operational** with five zeroes.

**The loading state was not the culprit, and that was worth establishing first.** The v3.9.5 rework
already made gathering additive — `showModuleLoading()` inserts a chip at the top of the tab and
clears nothing — so a read in flight leaves a table alone. The screenshots are therefore not one
moment but two frames: the failed cycle's screen STAYS until the next success, and the gather chip of
a later cycle lands on top of it. The chip and the emptied table are never simultaneous by design.

**The cause is the refresh's own contract.** `refreshCurrentTab()` and `backgroundRefresh()` set
`dataCache[type] = null` **before** they ask, deliberately, so the next read has to come from the
network rather than from a payload the renderer may draw without asking. So a refresh that FAILED had
nothing left to draw, and fell through to each module's fallback — which in NAP is an error row written
straight over the table, and in BACKBONE and NODE is the all-clear screen. Three modules answered a
read that never completed with a screen that said something. The other two did not: LCP's and OLT's
catch only logs, which is the behaviour the user was asking for, already shipped, and never written
down anywhere.

**Why the fallbacks were worse than a blank.** BACKBONE's and NODE's empty screens do not merely omit
the incidents: they assert *“All Backbone Links Operational”* / *“All Node Systems Operational”* and
stamp the current minute as `LAST CHECKED`. A failed read has no standing to make either claim, and
this is a monitoring tool — a screen that goes green when it cannot see is the one failure an operator
cannot detect by looking. NAP's error row is honest but destructive: it discarded rows that were still
the best information anyone had.

**The fix is two rules, plus one honest third answer.**

1. **A failed read keeps what is already drawn.** Nothing repaints on the failure path, so the rows,
the sort state and the scroll position all survive a refresh that failed. The rule is keyed on a
module-local `hasDrawn` flag rather than on `dataCache`, because `dataCache` is exactly what the
refresh empties — reading the answer back out of it was the bug.
2. **A failure never renders an all-clear.** The screens that claim the fleet is clear are reachable
only from a successful empty payload.
3. **A tab that has never drawn anything says so.** New `renderModuleUnavailable(tabName, title)` in
`index.html`, beside the other module-state helpers: *“This report could not be loaded. Press REFRESH
to ask again now.”* Unreachable for any tab that has drawn once, which is why it is the tab shell
(including the `page-title-row` the freshness chip attaches to) rather than a per-module screen.

**What was deliberately NOT changed.** `dataCache` is still emptied by every refresh, and the kept
rows are still not written back into it — a cache hit renders without asking, and *“the last good read
is still fresh”* is precisely the claim a failed refresh has no right to make. The refresh contract,
the gather chip's lifecycle and the existing `console.error` all stay as they were; keeping a stale
screen is only honest if the app still says the refresh failed, and the freshness chip ageing towards
`stale` is the other half of that. The change is a display rule, not a caching one.

**Checks.** Full suite **401 passed across 21 suites, 0 failed** (389 → 401), and
`bump-version.mjs --check` clean. The new suite is `tests/module-refresh-keep.test.js` (12 cases); it
loads the page's real module-state helpers out of `index.html` rather than stubbing them, because half
of what it asks is whether the gathering chip came down and whether the tab said anything true. A
sentinel marker is appended after each successful draw, since re-rendering the same rows produces the
same bytes and an equality check alone cannot tell a repaint from a no-op. Four mutations, every one
caught: NAP's keep rule disabled (`if (true)`), BACKBONE's failure rendering the all-clear again,
NODE's the same, and `backboneHasDrawn` never set. Three of the twelve cases are the *opposite* the
fix could easily have caused — a real empty answer still shows the all-clear, an all-clear from a real
read is left byte-identical rather than re-stamped, and `dataCache` is still empty after a failure.

**Verified in a real browser, not only in the vm.** Against the local server (serving this working
tree): NAP drawn with two areas then refreshed against a rejecting `fetchGate.run` → **3 rows still
present, byte-identical, no error row, gather chip 0, `dataCache.nap === null`**; BACKBONE and NODE
with nothing drawn yet → **no all-clear, the “could not be loaded” state instead, chip 0**; with a
report drawn, a failed refresh left both tabs byte-identical and still free of the all-clear. Two
probes came before the fix was trusted: `httpbingo.org/delay/8` returns JSON, so in-browser it
*succeeds* and proves nothing about failure — the real slow failure is
`httpbingo.org/drip?duration=7&numbytes=8`, which is 200, ~9 s, and a `text/plain` body that
`res.json()` rejects.

**Release.** 3.9.23 → **3.9.24**; guard untouched at 3.10.0. Client bytes only: three module files,
one page helper, one new suite, and the labels that describe them.

**Still owed.** The server-side pastes listed under PART-024 — this part changes no server byte, and
the fix is complete on the client.

---

### PART-026 — the last session paints the first frame (2026-09-26)

**What was asked for.** The other half of PART-025's complaint, and the half PART-025 deliberately
left open: *persist the last good module payloads across a cold start so a stalled first load shows
the last known data instead of the unavailable screen.* PART-025 made a FAILED read keep the screen it
has; a cold start has no screen yet, and the tab that has never drawn anything is exactly the one that
says **"This report could not be loaded"**.

**The design was already on disk, and this part followed it** — TODO.md's P1 item *Instant first paint
(persist `dataCache`)* had the reasoning, the ~3.9 KB of measured payloads, the per-type age caps and
the reason for `localStorage` (synchronous `getItem`, so the payloads are in memory before the first
paint rather than after an await). Three things the plan did not have, all found while building it:

1. **A failed refresh would have ERASED the copy it needed.** The plan's writer snapshots
`dataCache` on a timer. But every refresh empties `dataCache[type]` *before* it asks — that is the
refresh contract PART-025 diagnosed — so a snapshot landing in that window writes the modules the page
is holding and silently deletes the one whose read failed. The writer now carries over any type the
page is not holding, at its original `at`, so it keeps ageing and expires by the same cap: a refresh
that failed cannot cost the next launch its only snapshot, and nothing becomes immortal.
2. **A stamp in the FUTURE had to be refused.** A device whose clock moved backwards, or a stamp
written by one running ahead, would read as a negative age and therefore never expire — an
eternally-fresh stale screen, which is the opposite of what the guard is for. Anything ahead of the
local clock is unusable, not infinitely new.
3. **Restoring is not enough; the first frame has to be drawn from it.** The restored payloads were
handed to `bootFromBundle()`'s promise like everything else, which is the wrong order for the case
this exists for: against a stalled deployment the opening request holds the screen for the gate's
whole 30 s ceiling before the restored data appears — at the exact moment it was meant to replace.
So the visible tab is drawn from the snapshot synchronously, and the opening request re-renders it
when it settles. That costs ONE background refresh for the visible tab (the gate joins and throttles
it), which is the price of the first frame not waiting.

**What is stored, and why OLT is the odd one.** The post-decode state each module reads —
`dataCache[type]`, not the bytes the server sent. OLT additionally carries `oltMeta`, because its list
reads the array and its cards read the meta: storing the rows alone would restore a snapshot whose
totals disagree with the table under them, and OLT's cache-first path re-renders without restoring
meta, so the mismatch would be silent. An OLT payload whose meta did not come with it is neither
written nor restored. Its server build stamp is restored too — it rides inside the payload, so the
chip can report the age of the DATA (`Data as of 09:12`) instead of falling back to the fetch time.

**The expiry rule is one table, and it is the app's own cadence written down:** nap 60 min, lcp 30,
olt 15, node 10, backbone 10 — the intervals `loadInitialData()` already refreshes those modules on,
so a restored screen is never older than one the app would have replaced anyway. It is judged PER
TYPE and only the expired entries are dropped, so one stale module cannot cost the other four. A
snapshot also keeps its original fetch time across sessions, which is why a payload that is never
refreshed ages out instead of being treated as new on every launch.

**The ticker had to be told, or the fix would have introduced its own lie.** `fetchGate.lastFetchAt`
is in-memory, so a restored table would have drawn its age chip on an empty clock and read **"No data
yet"** over a table full of rows. New `fetchGate.seedLastFetch(type, at)` restores the fetch time, and
only ever moves the stamp backwards — a newer stamp already in memory is left alone, which is what
makes it safe to seed before the opening bundle has had its say.

**Storage failing is always the same answer: behave as if this file did not exist.** Private mode
(where the accessor itself throws), a quota error on write, a corrupt value, a schema mismatch, no
`localStorage` at all — every one of them degrades to the previous behaviour rather than throwing
into the load path. A cache may not break the app it accelerates. The snapshot is also cleared on
logout (one user's view of the network must not be handed to the next) and by the version guard's
`localStorage.clear()`, which is right: a wipe should take the snapshot with it.

**Auth ordering is unchanged.** `restoreModuleCache()` sits inside `loadInitialData()`, which is only
reached from `showApp()`, which is gated on `isLoggedIn()` — so restored data cannot be on screen for
a user who has not logged in.

**Checks.** Full suite **425 passed across 22 suites, 0 failed** (401 → 425), `bump-version.mjs
--check` clean. New `tests/cache-store.test.js` (21 cases) drives the shipped file against a fake
localStorage that includes both ways storage really fails on a phone; `tests/fetch-gate.test.js`
gained three cases for `seedLastFetch`. Fifteen mutations, every one caught: the age cap, the
future-stamp guard, the missing-fetch-time rule, the OLT-meta requirement, the empty-snapshot guard,
the gate seeding, `rawOltData` on restore, the OLT build stamp, the schema check, the serializer
itself, the carry-over, a carry-over that re-stamps the entry as fresh, a restore that ignores its own
caps, and both halves of `seedLastFetch` (backwards and junk). One attempted mutation was NOT a
mutation — passing `Infinity` as the parse clock is rejected by the same `isFinite` check the code
already had, so it changed nothing; recorded because "no test caught it" and "the mutation was a
no-op" look identical from the summary line.

**A vacuous assertion, caught by that pass.** The first version of the carry-over test asserted the
carried entry kept its own `at` — but it never advanced the harness clock between the two writes, so
`re-stamp it as fresh` and `keep the original age` produced the same number and the assertion could
not fail. It does now.

**Verified in a real browser, and the numbers.** Against a local server on a fresh origin (no service
worker to serve a stale script): a snapshot written through the shipped serializer, memory cleared,
and `bootFromBundle` stubbed to **never resolve** — modelling the stalled deployment this exists for.
The **first frame** already held the 3 restored NAP rows with BENGUET in the table, the chip read
**"Updated 20m ago"**, `lastFetch('nap')` equalled the stored `at`, and OLT came back with its meta
(`total: 462`), its rows in `rawOltData` and its build stamp 6 minutes old — exactly what was stored.
Then a refresh that FAILED on top of the restored data left the rows byte-identical with no error row
and the chip cleared, and the 30 s writer, firing with `dataCache.nap` empty, still left nap in the
store with 2 rows at its original 20-minute age.

**Release.** 3.9.24 → **3.9.25**; guard untouched at 3.10.0. Client bytes only: one new file
(`cache-store.js`, precached and therefore a delivery-set change), one gate function, three call
sites in `index.html`, and the labels that describe them.

**Still owed.** The server-side pastes listed under PART-024. Nothing here depends on them.

---

### PART-027 — a header sits over its own column (2026-09-26)

**What was asked.** *"tila'y hindi naka-align yung data sa column?"* — one screenshot of the admin
**Module Health** card, and the complaint is exact: the header row was **left-aligned** while every
number beneath it was **right-aligned**.

**Why that is a reporting defect and not a cosmetic nit.** A column is as wide as the card leaves
for it, so the label and its value sat at opposite ends of the same column: `10s` floated between
`Wait p50` and `Wait p95` with nothing saying which one it measured. Comparing modules is the only
thing this card exists for, and the misalignment made each number unattributable on its own.

**The fix is the rule, not the column.** Numeric headers are now built over their own numbers
(`headNum_()` in `admin-module.js`); `Module` keeps the left-aligned builder because its data is
text. Measured in a real browser at the card's own width, the text right edge of each numeric header
is now **0.0 px** from the right edge of its values, where it had been 41–77 px off (`Wait p50` 63,
`Overhead` 71.5, `Age` 76.9 — the gap is proportional to how much the column was stretched).

**Test.** `tests/diag-store.test.js` draws the card and compares, column by column, the alignment of
each header with the alignment of the data drawn under it — and asserts the table is genuinely
mixed, so an all-left table cannot satisfy the rule while quietly throwing the numbers away. Three
mutations, all caught: one header flipped back to left (the reported bug), every data cell flipped
to left (the vacuous case), and `Module` right-aligned over left-aligned names.

**Not reproduced, and named as such.** The card in that same screenshot reports **0 failed calls**
on every module, and its waits are 1.0–10 s, so nothing here was a broken table: the numbers were
where they should have been, only unreadable. A `failed` count of zero also means NAP's
**Error loading data.** row in the earlier screenshot cannot have been written in that page life —
it is a cold start with nothing to draw, which is the case 3.9.25 addresses. The alignment defect is
independent of both screens. No table outside this card was touched: the module tables' headers
already read left with their data, checked against the real stylesheet rather than assumed, since a
browser's default header alignment is a thing people remember wrongly.

**Release.** 3.9.25 → **3.9.26**; guard untouched at 3.10.0. `admin-module.js` is a precached,
unversioned entry, so the label moved in the same commit as the bytes. 22 suites, 0 failed.

**Still owed.** The server-side pastes listed under PART-024. Nothing here depends on them.
