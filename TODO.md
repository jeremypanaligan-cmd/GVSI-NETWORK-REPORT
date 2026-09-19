# 📌 NetPulse — Live Work List

**This is the current, ordered queue of work** — not an audit. Read it top-down; P1 is next.

**Last updated:** September 20, 2026 · `main` is live at 3.9.15 (the Lucide icon set — see P2)

---

## How this file is used

- When asked *"what's on the to-do list"*, read **this file** and report in priority order, **P1 first**, with current status.
- Items move down or out when done. Dates and statuses are updated in place, not appended.
- **A to-do item lives on disk or it does not exist.** Conversation history does not survive between sessions, so anything decided in chat and worth keeping gets written here.

**Not the same as `GVSI_NetPulse_System_Roadmap.md`.** That file is a **dated audit** (Aug 26, 2026, against app v3.3.0) with its own signature and priority tables. Treat it as history: useful context, but **re-verify each item before working it** — several have already landed (see the bottom of this file).

---

## 🔴 P1 — Instant first paint (persist `dataCache`)

**Goal:** in a cold browser the app always starts with an empty `dataCache` (`index.html:898` is in-memory only), so the first render waits on the network. Restore the last known payload **before** the first render, then refresh in the background — honestly labelled, and bounded by age.

This removes the **whole first-load wait**. It does **not** recover the 1.5–2.1 s warm-cache delta, which is a separate and much smaller number (see P3 warmer item).

### Measured evidence (Sept 18, 2026)

| Module | Payload |
|---|---|
| nap | 718 B |
| lcp | 488 B |
| node | 2 B |
| backbone | 2,080 B |
| olt (`shape=3`) | 643 B |
| **total** | **~3.9 KB** |

~3.9 KB. **Use `localStorage`, not IndexedDB** — `getItem` is *synchronous*, so `dataCache` can be populated before the first paint with no frame delay. The repo already uses this pattern (`app_version`, `theme`).

> ⚠️ **This contradicts roadmap item 4.1** (*"IndexedDB for frontend caching — for larger payloads"*). That premise is stale: after the `shape=3` compaction the payloads are tiny. Reaching for IndexedDB here would trade a synchronous read for an async one and make the paint *later*. The ~5 MB localStorage budget is ~1,000× the need.

### Design decisions

1. **Persist the post-decode state** — exactly what each module reads: `dataCache[type]` for all five, **plus `oltMeta` separately**. Critical detail: OLT is the only module with a transform (`dataCache.olt = decodeOltCompact(data)` at `olt-module.js:27` and `:46`) and its meta lives in a module-level `var oltMeta` (`olt-module.js:18`), **not** in `dataCache`. Persisting `dataCache` alone restores `oltMeta = null` — and note that OLT's cache-first path (`olt-module.js:22`) re-renders from `dataCache.olt` **without** restoring meta, so the fallback at `olt-module.js:95` silently takes over and the totals shown differ from the pre-reload ones.
2. **One writer, zero call-site edits.** A 30 s interval plus `pagehide`/`visibilitychange:hidden`. This avoids touching ~14 assignment sites across 6 files; a persisted copy that is 30 s stale is irrelevant to the *next* page load.
3. **Per-type age cap, mirroring the app's own refresh cadence** (`loadInitialData`, `index.html:1214`) — never show data older than the interval at which the app itself would have refreshed it:

   | type | cap |
   |---|---|
   | nap | 60 min |
   | lcp | 30 min |
   | olt | 15 min |
   | node | 10 min |
   | backbone | 10 min |

   One table. If the NOC needs stricter, this is the single number to change.
4. **Seed the ticker honestly.** `fetchGate.lastFetchAt` is in-memory and empty after a reload, so a restored table would display a chip reading **"No data yet" while showing data**. Add `fetchGate.seedLastFetch(type, at)`.
5. **Clear on logout** (`handleLogout`, `index.html:1640`) — otherwise a second user on the same device is shown the first user's snapshot.
6. **Schema version stamp**, discard on mismatch.
7. **Fail open.** Wrap every storage call in `try/catch`: private mode, quota, and disabled storage must degrade to today's behaviour, never throw.

### Files

- **New `cache-store.js`** (~70 lines, loaded after `fetch-gate.js`): `DATA_CACHE_MAX_AGE_MS`, `CACHE_STORE_VERSION = 1`, key `netpulse_datacache_v1`, and `serializeModuleCache` / `parseModuleCache` / `readModuleCache` / `writeModuleCache`. `parseModuleCache` judges age **per type** — it drops only the expired entries, not the whole store.
- **`fetch-gate.js`** — add `seedLastFetch(type, at)`: writes `lastFetchAt[type]` only for a positive finite value, and never overwrites a newer timestamp with an older one.
- **`index.html`** — `<script src="cache-store.js"></script>` beside the other module scripts (they are loaded **unversioned**, `index.html:783–792`); a `restoreModuleCache()` call at the **top of `loadInitialData()`**; the 30 s interval + `pagehide`; the logout clear.
- **`sw.js`** — add `./cache-store.js` to `STATIC_ASSETS`.
- **New `tests/cache-store.test.js`** and additions to `tests/fetch-gate.test.js`.

### Acceptance checks

1. Reload → data is present in the **first** frame, no skeleton.
2. The ticker chip shows the **restored age** ("Updated 20m ago"), not "No data yet".
3. Manual REFRESH still clears and refetches; logout clears the persisted key.
4. Auth ordering is unchanged — `loadInitialData()` is only reached from `showApp()` (`index.html:1662`), which is gated on `isLoggedIn()`. **Restored data must never be visible before login.**

### ⚠️ Delivery condition — never name a version by hand

When this was planned, `origin/main` was `b0c6563` (`gvsi-shell-v3.9.7`) and v3.9.8 was unpublished, so no generation bump was needed. **That note then said "this change MUST move the cache generation to `gvsi-shell-v3.9.9`" — and v3.9.9 has since been published for other work** (the auto-apply fix and the deployment swap). A hardcoded version in a plan is a bug waiting for its moment: following it now would re-install under a generation devices already hold, and deliver nothing.

`index.html`, `fetch-gate.js`, and the new `cache-store.js` are all **unversioned precache entries**, delivered only by `install` re-fetching every entry — so this change still needs a generation move, but the number comes from the tree, not from this document.

The release version now lives in exactly one place, `version.json`, and every label is moved by one command:

```bash
node scripts/bump-version.mjs --check   # exit 1 if any label disagrees with version.json
node scripts/bump-version.mjs patch     # move the generation, the manifest and every ?v= token together
```

`tests/version-sync.test.js` fails on drift, and `--check` also warns when the delivery set has changed while the release has not — the failure that produces no error anywhere at runtime.

> **This change MUST move the release version together with the bytes it describes, in the same push.** Without it, `install` reuses the same generation, `activate` evicts nothing, and installed devices keep the old bytes forever while the repo says otherwise.

---

## 🟢 P2 — The Lucide icon migration shipped in 3.9.15 (Sept 20, 2026)

**Built, tested and released.** Every icon in the app — the eight bottom-nav glyphs, both
export toolbars in all five modules, the header, the login panel, the zero-state cards and
the sorted-column chevrons — is now drawn from the installed `lucide@1.47.0` instead of 47
hand-written inline svgs. **192 tests pass, 19 of them new in `tests/icons.test.js`, and all
21 mutations of the change are caught by them.**

**How a package reaches a static app, since there is no bundler.** `scripts/build-icons.mjs`
reads `node_modules/lucide` and writes `lucide-icons.js`, which is committed and precached:
**30 icons in 12 KB**, against the shipped UMD bundle's **436 KB** — a precache list is
handed to every device again on every generation, so the difference is not cosmetic.
`node_modules/` stays gitignored and is only needed to regenerate; `npm run icons:check`
fails if the committed file drifts from the package.

**Two shapes of the same trap, both avoided by choice:**

| the risk | the choice |
|---|---|
| an icon that needs a second pass after the paint, in a table that repaints on every refresh | the modules get `lucide.icon()` **inline in the template string**; only the shell's static markup uses placeholders |
| a typo or a stale name rendering as a silent empty gap | `icon()` returns `''` for an unknown name, and the test walks call sites against the table **in both directions** |

**The sort indicator had no markup to swap.** It is a `::after` on `th.sortable`, so 38
headers carry it from CSS. It is now a Lucide mask painted with `background-color:
currentColor`, injected once at boot, with the original text glyphs left in `styles.css` as
the no-JS fallback — measured at `rgb(255,255,255)` in the dark theme and `rgb(13,138,128)`
in the teal headers in light.

**Delivery, again the same rule.** `lucide-icons.js` is an unversioned precache entry **and
a file no installed device holds**, so it arrives only with a new generation:
`bump-version --check` said so itself (`delivery set changed, release did not`) before the
bump, and all six labels moved to 3.9.15 with the bytes in one commit. The guard stayed at
**3.10.0** — no device is sent to the wipe overlay.

**Left behind, deliberately:** the GALLOPVISION mark in the login panel is still a
hand-drawn svg — it is the brand, not an interface glyph, and `tests/icons.test.js` asserts
it is the *only* one left, so a future inline icon fails the suite instead of quietly
passing review.

---

## 🟢 P2 — The OLT zero state shipped in 3.9.14 (Sept 19, 2026)

**Built, tested and released.** When nothing is DOWN the OLT tab renders a themed card instead of
an empty seven-column table — that path was the tab's default view, and it used to be a bare
inline-styled `<td>` plus an early `return` that skipped the freshness chip and the export
toolbar. One component now covers every filter that matches nothing, and the "no rows arrived at
all" case says so instead of claiming a healthy fleet. 173 tests pass, 9 of them new in
`tests/olt-empty-state.test.js`, and all 11 mutations of the change are caught by them.

**The delivery rule, measured.** `styles.css` and `olt-module.js` are **unversioned precache
entries**, so the label has to move with the bytes. In the preview, on a plain reload of the
unpublished tree:

```
styles.css?v=3.9.13   transferSize: 0   454 rules, no .olt-empty-* selectors   <- what the page got
same file, cache:reload               466 rules, .olt-empty-* present         <- what is on disk
```

The URL the page actually requests is the one the service worker answers cache-first, while the
*unversioned* precache entry is the one `install` refreshes — so nothing evicts the former while
the label stands still. That is the rule `sw.js` states in its own header, observed rather than
assumed, and it is why the feature bytes alone would have reached nobody.

```bash
node scripts/bump-version.mjs --check   # exit 1 if any label disagrees, plus a drift warning
node scripts/bump-version.mjs patch     # generation, manifest and every ?v= token, in one commit
```

3.9.14 moved all six labels; the guard stayed at 3.10.0. For working on the tree between
releases, `.freebuff/run.md` records how to see unpublished bytes locally.

---

## 🟢 P2 — Freshness: in the repo, waiting on the Apps Script hand-off (Sept 18, 2026)

**The incident that prompted this:** a DOWN ticket was deleted from `OLT DOWN Tickets` at **14:06:09** and the dashboard still showed it at **14:17:09** — 11 minutes, while the app refreshed throughout. The cache HIT path (`code.gs`) returned the stored bytes and never rewrote them, so every one of those refreshes was answered from an entry built at ~13:59 and only its 1080 s TTL ever produced a fresh build. `1080 s = 18 min`, and `14:17:09 − 1080 s = 13:59:09`: the arithmetic and the observed timestamp agree, which is what identified the cache rather than the app.

**What the ceiling is now, per module:**

| | before | after |
|---|---|---|
| sheet edit (in-sheet, human) | up to ~19 min | **seconds** (`onEdit`/`onChange` drops the cache; the rev poll makes the app look) |
| OLT, formula/IMPORTRANGE-driven (no trigger fires) | up to 18 min of HIT | **≤ 5 min** (warm cadence), chip shows the real age |
| node / backbone | ≤ 60 s + client cadence | unchanged |
| nap / lcp | ≤ 180 s + client cadence | unchanged |
| REFRESH button | client cache only | real rebuild, rate-limited to 1/min/type |

**Four `.gs` files to paste** (nothing changes live until then): `code.gs`, `cache-invalidation.gs` **(new)**, `olt-cache-warmer.gs`, `triggers.gs` — then deploy a **new version** to the same deployment (keeps the `/exec` URL) and run `setupAllTriggers()`.

**Three triggers it must end up with** — the plan now declares event types, and `listTriggers()` reports a wrong one as drift:

| handler | type | what it is for |
|---|---|---|
| `warmOltCache` | clock, **every 5 min** (was 15) | covers what a trigger cannot see; freshness = cadence now |
| `handleSheetEdit` | **On edit** (installable) | drops one module's cache, bumps its rev |
| `handleSheetChange` | **On change** (installable) | structure change: drops every module's cache |

**Verify it landed** (the three checks that would have caught the original incident):

```bash
# 1. the payload is stamped — proves a hit can report its own age
curl -sL "$EXEC?type=olt&shape=3" | grep -o '"builtAt":[0-9]*'

# 2. the rev route exists and touches no sheet
curl -sL "$EXEC?action=rev"          # {"ok":true,"rev":{...}}

# 3. two requests two seconds apart report the SAME stamp — a hit reporting its build time
```

Then the end-to-end test: edit a cell in `OLT DOWN Tickets` and watch the chip — the rev should move within ~15 s and the OLT tab should repaint by itself, with the honest age on it.

**Deliberately left alone:** the aging writers stay at 15 min (their output is a static value, and `OLT DOWN Tickets` Column X can be up to 15 min behind regardless of how fresh the payload build is); the harder-to-undo decision about whether to give `OLT DOWN Tickets` its own shorter cycle belongs with the OLT UP-rows question below.

---

## 🟡 P2 — The intermittent 21 s 404

**This is the largest single source of a bad experience in the system.**

Measured once during testing: `lcp` returned **HTTP 404 after 21.07 s** — an 8 KB Google error page — then succeeded on the next attempt. In a later run of **40 consecutive requests, 0 failed**, so it is rare and not reproducible on demand.

Why it dominates:

| | time |
|---|---|
| worst cold build measured (OLT, 461 rows) | 3.2 s |
| **this failure** | **21.07 s** |

~7× worse than the worst cold build, and it ends in an error rather than a slow success.

**Warming cannot prevent it** — it is an error path, not a cache miss. Attack it with instrumentation: record type, whether the request was cold, how many requests were in flight, and the failure body, then correlate. Note that `fetch-gate.js` uses `retries = 0` and `TIMEOUT_MS = 30000`, so a 21 s failure lands inside the ceiling, is not timed out, and surfaces as a module-level "Error loading data".

---

## 🟡 P2 — Install the triggers in Apps Script

The `triggers.gs` safety fix **is in the repo but has not been pasted into Apps Script**, and nothing changes in the live project until `setupAllTriggers()` is run manually once.

1. Paste the current `triggers.gs`, `olt-cache-warmer.gs`, `code.gs` **and the new `cache-invalidation.gs`**.
2. Run **`listTriggers()` first** — read-only drift report.
3. Then run `setupAllTriggers()`.

The plan now also installs two **installable** spreadsheet triggers (`handleSheetEdit` → On edit, `handleSheetChange` → On change). `setupAllTriggers()` validates both handlers before it deletes anything, so a forgotten paste is a no-op rather than a trigger wipe — but a missing `cache-invalidation.gs` means the fastest freshness path silently does not exist.

Known drift: `autoExportSheetToExcel` (the daily 6 AM backup) **has no trigger at all**, and `processBackboneTickets` is registered **On-change** rather than hourly — which is how an on-change trigger hides a missing schedule. The previous `triggers.gs` said so itself: it logged `'It does NOT fire on IMPORTRANGE refresh.'` (line 71, before the rewrite in `628ea4c`).

Watch for: if the run reports *"cannot resolve function names in this runtime"*, the `triggerHandlerExists_()` self-check could not work and aborted by design — report it rather than forcing the setup.

---

## 🟡 P2 — Push protection, and the status of the leaked Supabase key

**The leaked key is already dead** — verified with a control, not assumed. The historical `sb_secret_` (41 chars, well-formed `sb_secret_<22>_<8>`) returns **HTTP 401**, while a freshly fetched live publishable key returns **200** on the same endpoint and request shape. If the secret were live it would bypass RLS and return rows.

So the remaining work is prevention, not remediation:

- **Enable GitHub push protection** (Settings → Security and quality → Advanced Security → Secret Protection → Push protection). GitHub **does** support this pattern: `supabase_secret_key` has `isPublic: true` and `hasPushProtection: true`, so it would have blocked the original push.
- While there, check **Security → Secret scanning** for an open alert on the old commits and mark it **Revoked**.

**History rewrite: decided against.** The value is inert, the repo has 0 forks, and the old blobs stay reachable by direct SHA on GitHub after a force-push anyway. The cost (rewriting every SHA, breaking clones, GitHub object retention) buys nothing.

Note: the value is still downloadable from `raw.githubusercontent.com` at `b0c6563` and `f8979f9`. That is accepted.

---

## 🟢 P3 — Copy the deploy URL into fewer places

A deployment's `/exec` id is minted when the deployment is **created**, so standing up a new one changes the URL and nothing follows automatically. The app's two fallbacks and the proxy's `ORIGIN` must move together — that was commit `d0f3032`.

The durable fix is to use **Deploy → Manage deployments → edit → New version**, which keeps the URL, so the three-line ritual stops being part of every backend release. Worth writing down somewhere the next person will see it.

---

## 🟢 P3 — `serve-local.py` crashes on startup

`UnicodeEncodeError` — an emoji in a `print()` against a cp1252 console. Pre-existing and unrelated to recent work, but it makes the repo's own dev server unusable; `python -m http.server 8080` was used as a substitute. Either drop the emoji or force `PYTHONIOENCODING=utf-8`.

---

## 🟢 P3 — 60 s `?action=getSettings` poll in `admin-module.js`

A pre-existing `setInterval` that polls `getSettings` and reloads. Unrelated to kiosk, but it is a permanent background request per open tab that nothing appears to need.

---

## 🟢 P3 — Generic scheduled warmer for nap / lcp / node / backbone

Today **only OLT is warmed** (`warmOltCache`); the other four rely on real traffic. Every app load already prefetches all five modules (`prefetchOtherTabsInBackground`, `index.html:1060`, staggered 400 ms), so each user session warms everything — the gap is only the first request after an idle period.

**Measured gain is small.** Same cache key, OLT, 461 rows:

| | time |
|---|---|
| COLD (70 s after expiry) | 2.97 s · 3.21 s |
| WARM | 1.48 s · 1.52 s |
| WARM (best case) | 1.22 s · 1.09 s |

**~1.5–2.1 s saved, against a ~1.1 s irreducible floor** (Apps Script startup + the 302 → `googleusercontent` echo round trip). That floor is why warming is not the lever it looks like.

If pursued: warm sequentially (not in parallel — the echo endpoint 404s under parallel hits), reuse the `doGet(e, warmTtlOverride)` TTL override, and **check the trigger-runtime quota first**. Five builds per run against the ~90 min/day trigger budget is the constraint, and the real build time is logged by the warmer itself (`✅ warmOltCache: OLT cache warmed in Nms`) — read that from the Executions page before choosing an interval.

**Note:** the 11–25 s figures from the original investigation were measured during a degraded period (deployment/origin problem), **not** steady state. Do not size this work against them.

---

## 🟢 P3 — The standalone kiosk project

Kiosk mode was removed from this app (commit `c41b2ec`) and the NOC wall display is to become its own project. The controller and stylesheet were moved intact to `kiosk-reference/`, and `kiosk-reference/README.md` records the porting surface.

Worth remembering **why** it was removed, so it is not re-added for the wrong reason: the kiosk's only cross-device effect was **server cache warmth**, and that is measured to be worth ~1.5–2.1 s. It also pinned every module at the 60 s refresh ceiling 24/7, per device, and its parallel entry burst is the documented cause of the echo 404s.

---

## ✅ Answered — OLT UP rows (Sept 18, 2026)

**Question:** *"If we bring back the UP rows in the OLT module, will it slow the OLT module's data load?"*

**Answer: no, provided the UP rows stay off the dashboard's request path — and that is what shipped.** Measured against the live deployment:

| request | rows | bytes | who asks for it |
|---|---|---|---|
| `shape=3` — problem-only | 4 | **629 B** | the dashboard, on every load |
| `shape=4` — UP-only | 457 | **25,962 B** | only after *View All Healthy OLTs* |
| `shape=1` — legacy, all rows | 461 | **50,137 B** | nothing (kept as the default for old clients) |

The fleet is 461 OLTs and **457 report UP**, so a single UP-bearing payload is **41× the dashboard's** — the original worry was justified, and serving it eagerly would have put the heaviest response in the app behind the most frequently loaded tab. Two things bound the cost instead:

- **It is lazy.** The dashboard still requests `shape=3`, so its payload and parse are unchanged; `shape=4` is fetched once, on demand, and cached under its own key.
- **It is paginated** (50 rows a page), so the DOM work is capped at 50 rows no matter how large the fleet grows. This was the half the earlier note flagged as unestablished.

25,962 B also sits well under the 90 KB CacheService threshold, so `shape=4` never needs the `PropertiesService` fallback that `shape=1` was close to.

**Still unmeasured:** wall-clock render time for a 50-row page on a low-end phone, and whether `shape=4`'s cold rebuild is as slow as `shape=3`'s. The live origin returned a valid `shape=4` on **1 of 3 attempts**; the other two were the documented intermittent 404 / Apps Script error page, which the drill-down's retry state is there to absorb.

---

## ✅ Verified as already landed (checked Sept 18, 2026)

Confirmed in the code during this session, so the roadmap's items for these are **done** — do not re-execute them blindly:

- **CacheService 100 KB overflow** (roadmap 1.1) — mitigated: `shape=3` cuts OLT to 643 B, and `code.gs` keeps a `PropertiesService` fallback with an explicit staleness stamp.
- **`performLogin()` extraction** (roadmap 1.5) — done; `handleLogin` calls `await performLogin(username, password, rememberMe)` (`index.html:1636`).
- **Hardcoded column indexes** (roadmap 2.1) — done; `COL` constants exist at the top of `code.gs`.
- **No time-driven triggers** (roadmap 3.1) — the mechanism now exists (`TRIGGER_PLAN` + `setupAllTriggers()` + `listTriggers()` in `triggers.gs`, plus `warmOltCache`). **The live installation is still outstanding — see P2.**

**Every other roadmap item needs re-checking** before it is treated as open. That audit is 3+ weeks and several releases old.
