# Changelog

All notable changes to **GVSI NetPulse** are recorded here.

The in-app **About → What's New** panel mirrors the most recent entries; this file is the
complete history, including work that has not been released yet.

Format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Versions follow the app's own numbering. Newest first.

---

## [Unreleased]

### Reliability
- **The retry no longer lands inside the stall that caused the failure.** A hard refresh was
  flooding the console with `script.googleusercontent.com/macros/echo` **404s** and making
  the app feel slow. Measured with `curl` — no cookies, no JS, no service worker —
  **3 of 15 calls returned 404 (20%), and every 404 took 8–33 s**, while every fast call
  (**1.1–1.3 s**) returned 200. A single cold call took **45.3 s**. Through node's `fetch`,
  while the endpoint was answering fast, **32 calls 404'd 0 times**.
  - So the 404 is **not a missing route and not this app's code**. It lands on the **redirect
    hop** (`/exec` answers `302`, then the echo URL fails), and the app's own script cannot
    produce a 404 at all because `ContentService` always answers **200**. It is a **stall
    signature**, which is why it correlates with duration and never with the URL.
  - What *was* ours is the reaction to it: a fixed **500 ms** backoff from **six callers at
    once** — the five modules plus the heartbeat, all started in the same tick by `showApp()`
    — turned one bad second into **~18 invocations, all inside the stall**. A retry 500 ms
    into an 8 s stall is a retry guaranteed to fail.
  - The wait now scales with the stall the attempt **actually observed** (`retryDelayMs()`,
    clamped **1.5 s–20 s**, so a stall is waited out at roughly 1.5× its own duration), and it
    is **shared**: one gate for the whole app, so the callers come back as a single trickle
    instead of six overlapping storms. A stalled attempt beats the old backoff at every
    attempt number — 500/1000/2000 ms are gone.
  - The heartbeat's first beat is **deferred 8 s** rather than firing in the boot tick. It is
    the least urgent of the six calls (the sheet drops a user only after 5 min idle), so the
    boot now opens **five** concurrent invocations instead of six. `startHeartbeat()` also
    refuses a second start, so re-showing the app cannot double the beat rate.
  - **Removed: the "Apps Script keep-alive" ping.** It never ran once — its
    `if (!window.APP_URL) return;` guard sits ~180 lines **above** the statement that assigns
    `window.APP_URL`. It would not have helped even wired up, because it fires in the same tick
    as the maintenance check and both requests land on the same cold instance; only a
    **periodic** ping could remove the cold start, and that spends backend budget.
  - A healthy boot never touches the gate, so the five modules still start together in one
    tick (kept honest by `tests/boot-parallel.test.js`), and `tests/api-stall.test.js` runs the
    real `retryDelayMs()` to prove a stalled attempt waits longer than the stall it saw.
- **The dashboard boots all five modules at once instead of one at a time.** It used to
  fire only NAP from `loadInitialData()` and launch the other four from inside NAP's own
  success branch, so **every load paid NAP's entire round trip before the other four had
  even started**. Measured live: NAP alone **1,058 ms**, then the four in parallel
  **1,121 ms** — a **2,179 ms** boot.
  - Five requests fired together measure **1,157 ms** wall while a single one measures
    **1,074 ms**, so the extra four cost about **83 ms**: each `/exec` runs on its own Apps
    Script instance and they overlap. **The ordering was the whole cost, not the number of
    requests.**
  - Measured after the change: the boot lands in **2,709 ms**, which is exactly the
    **slowest** module (OLT, 2,706 ms) — against a **9,522 ms** sum of the five individual
    times. The wall clock is the maximum, not the total. All five were observed starting
    within **1–4 ms** of each other.
  - A single combined `?type=all` endpoint was measured and **rejected**. Apps Script is
    single-threaded and `getValues()` blocks, so one execution would build the five
    payloads back to back: five sequential requests measure **5,324 ms**. The win comes
    from overlapping instances, not from reducing round trips.
  - The loader still hides when NAP lands — not when all five do — so the moment the UI
    becomes usable is unchanged.
- **Fixed: the daily trend snapshot was recording modules as zero.** It was written by a
  blind `setTimeout(…, 1000)` started alongside the four prefetches; by then OLT (~2.4 s),
  NODE (~2.3 s) and BACKBONE (~2.0 s) were still in flight, and `db.js` keeps only the
  **first** snapshot of each day — so the zero stood for the rest of it.
  - It now runs once all five **settle**, and additionally refuses to write at all unless
    every module cache has been filled. Settlement alone is not enough: a fetch that
    **fails** settles too, and no module writes its cache on its error path.
  - Observed live: two Apps Script `/exec` 404s (its documented transient stall, retried)
    produced a **2026-09-13** record reading `olt.total: 0` against **461 real OLTs** and
    `backbone.tickets: 0` against **7**. A snapshot is now skipped —
    `Snapshot skipped — not loaded yet: olt, backbone` — and the day stays open for the
    next complete load.
  - The same day's record can also be written twice: the date check is a read followed by
    a much later write, so two boots in one session could both see "no record yet" —
    which the console showed as two `Snapshot saved for 2026-09-13` lines. Now one write
    per session.
- **New: the trend history can be audited and a bad day repaired.** A record can never be
  fixed in place, because the first record of a day is the record for that day — so the
  data already stored was wrong for good until its record was removed.
  - `netpulseCache.auditTrendHistory()` lists the days that look incomplete, with the
    numbers that contradict them. `netpulseCache.rebuildTrendDay()` drops **today's** record
    and writes it again from the loaded data; `netpulseCache.dropTrendDay("YYYY-MM-DD")`
    removes a past day, leaving an honest gap rather than a false zero.
  - `rebuildTrendDay()` **refuses any date that is not today**, on purpose. The snapshot is
    built from the live module caches, so "repairing" an old date would delete that day and
    then write today's numbers over it — losing the real day and gaining nothing.
  - This is deliberately narrower than the existing `netpulseCache.clearIndexedDB()`, which
    drops the whole database: the wrong tool for one bad record, at a cost of all 90 days.
  - **The affected window is the whole history.** The once-per-day guard arrived with `db.js`
    in v3.1.0 (2026-08-23) at the same time as the 1.5 s blind timer, and the timer was
    tightened to **1.0 s** on 2026-08-27 — so every stored day up to 2026-09-12 was written
    by that path. Expect many flagged days, not one.
- **Fixed: `ALERT_THRESHOLDS` could be read inside its own dead zone.** Starting all five
  at once widened a *synchronous* path — `checkMaintenanceAndLogin()` (top-level call,
  early in the script) → `showApp()` → `loadInitialData()` → a module fetcher → a render →
  `getAlertClass()` — that reads a `const` declared further down the same script. The
  declaration now sits with the other application variables, above every statement that can
  reach it. Caught by `tests/inline-order.test.js` at the moment the boot changed, not by
  hand.

### Corrected
- **The OLT payload shrink was measured decoded, not on the wire — and it bought no
  bandwidth.** `?type=olt` was **96.9% of the decoded** bytes the app moved (461 rows x 9
  fields, **50,179 bytes**, of which the repeated field names alone were **14,291 (28%)**),
  and compaction took it to **26,208 decoded — a real 52%**.
  - But Apps Script already sends `Content-Encoding: gzip`, and the legacy shape's repeated
    keys compress extremely well. On the wire the compact shape is **4,242 bytes** against
    the legacy **4,116** — **126 bytes larger** — and OLT is **45%** of the five-module
    gzipped total, not 96.9%.
  - The work item that ordered this change *did* note the gzip (`3,534 bytes sa wire`) and
    justified the rest as **decoded/parse cost and TV CPU**. That measurement does not hold
    either: `JSON.parse` of the 26 KB payload is **0.50 ms** and `decodeOltPayload` is
    **0.23 ms** for all 461 rows. Neither the wire nor the CPU was the win.
  - What the compaction did buy: a payload whose shape travels with it, a decode that is
    trivially cheap, and the precondition for aggregating the 452 UP rows (~96.9% of the
    payload) away later — which is the change that would actually cut bandwidth, since a
    province-count aggregate gzips to **~468 bytes** against **4,242**.
  - **Lesson for the next measurement:** read the **transferred** column, not the decoded
    size, and time the parse before assuming it matters. A 52% cut in decoded bytes, a
    3% *increase* on the wire, and a 0.73 ms total CPU cost all look identical from the
    JSON string.
  - `?type=olt&shape=2` returns a compact envelope: `{ v, f, p, m, r }` — province and
    municipality as indices into two dictionaries, each row a positional array, and the
    field order carried in `f` so the two sides cannot drift apart.
  - **The row count is unchanged** — this is re-encoding, not aggregation. Nothing is
    summed away, and the kiosk and admin still see every OLT.
  - The legacy shape stays the **default** and gets its **own cache entry**
    (`cache_v2_olt` vs `cache_v2_olt_c2`), because a cache hit is returned before
    anything looks at `shape` — sharing one key would serve the wrong shape to whoever
    asked second. Old clients are untouched, and the new client falls back to the legacy
    payload if it gets one, so the frontend and backend can be deployed in either order.
  - Decoding happens once, at the fetch boundary (`decodeOltPayload` in `olt-module.js`),
    so the admin table, the details modal, the kiosk slide and analytics all keep reading
    the same rows they always have. A payload shape this build does not understand is
    refused with a warning rather than rendered.
  - **Measured on the live sheet**, not on a fixture: the real encoder in `code.gs` and
    the real decoder in `olt-module.js` round-trip 461 live rows **byte-for-byte** — and
    in the browser the compact path renders a table *identical* to the legacy one.
  - The `?type=olt` request still leaves immediately after boot, but now there is exactly
    **one** per boot: two other code paths built their own URL for the same module
    (`prefetchOtherTabsInBackground()` in `index.html` and the analytics cold-start
    fetch), which bypassed both the payload shape and the 60s revalidation throttle —
    and, because they used a different URL, the in-flight de-dupe could not collapse them
    either. Both now go through the module's own fetcher.
  - **Backend change → needs a redeploy.** Until then the endpoint ignores `shape`, the
    client receives the legacy array, and everything works exactly as before.
- **The PWA icons were 52% of the first load. Now 23%.** They shipped straight out of a design
  tool and one of them was a **byte-for-byte duplicate** — `icon-512.png` and
  `apple-touch-icon.png` shared one md5 and were both in the precache, so 87 KB was downloaded
  twice for an icon iOS draws at 180px. Measured on a cold install: **202.4 KB → 89.8 KB
  (−112.6 KB)**, against a total first visit that was ~389 KB.
  - `apple-touch-icon.png` is now an actual **180×180** (86.9 KB → **16.1 KB**), `icon-512.png`
    86.9 → **52.7 KB**, `icon-192.png` 28.6 → **21.1 KB**.
  - Re-encoded with a new dependency-free tool, `tools/optimize-icons.js` (the machine has no
    ImageMagick/pngquant/sharp and this project has no build step): median-cut to **128 colours**
    with 8-bit alpha kept, per-row adaptive filtering, zlib level 9. Quality measured against
    the originals: **PSNR 46.9 / 44.1 / 46.2 dB**, MAE under **1/255** — under 0.5% of pixels
    are off by more than 8/255. Palette (PNG-8) was rejected on purpose: it can express only ONE
    transparent index and these icons have anti-aliased edges with 187 distinct alpha values.
  - Icons are precache-only, so `STATIC_CACHE` moved to `v3.9.5` — see note 9 of
    `GVSI_NetPulse_Caching_Notes.md`.
- **The kiosk made up to 4 × 50 KB OLT requests a minute.** Every module's cache-hit path
  re-renders from memory and then re-fetches, which is right for a tab click and wrong for a
  9-second rotation. Measured on the running display: **11 requests / 198.7 KB per minute**, of
  which `?type=olt` (50,059 B decoded, **96.9% of all API bytes**) was pulled **4×/min** —
  ~22 MB/day decoded on a TV stick that never sleeps.
  - `shouldRevalidate()` in `cache-control.js` now caps revalidation at **once per module per
    minute**, whatever asks for it. `backgroundRefresh()` passes `forceRefresh`, so the module
    timers are untouched; it calls `markRevalidated()` so the window restarts from its fetch
    instead of letting a cache hit fire straight after.
  - Measured after: **10 consecutive `fetchNapData()` calls → exactly 1 network request** (9 ms),
    and a 137 s kiosk window with 15 rotations made **11 requests** total, OLT **3** — one of
    which was the module timer, not the rotation. Live updates are unaffected: the kiosk's own
    60 s refresh still lands, and each module is still revalidated at least once a minute.

### Performance
- **One signed-in client was using 84% of the backend's daily property quota just to stay logged in.**
  The session gate ran the expired-session sweep on **every** request that presented a valid token,
  and three routes then read the same token a **second** time through `sessionFromRequest()`. The
  sweep is O(stored sessions) — `getKeys()` plus one read per `session_*` key — so a heartbeat cost
  **N + 3** Properties operations, not one.
  - Apps Script meters *Properties read/write* at **50,000/day** on a consumer account, and
    heartbeat alone is **1,440 requests/day per signed-in client**. At 26 stored sessions that was
    **41,760 operations/day from a single user — 84% of the quota** — and roughly **8× over** with
    ten. The failure mode is not slowness: the script throws *"Service invoked too many times"* and
    the app stops updating.
  - The sweep now runs **at login** (`issueSessionToken`), where it is naturally rare, and
    `readSessionToken()` still deletes a stale token the moment one is presented — so the store
    cannot fill up with abandoned entries.
  - `resolveSession()` replaces the gate-then-`sessionFromRequest()` pair, resolving the session
    and the decision in **one** pass. `requireSession()` is now a thin wrapper over it, and
    `sessionFromRequest()` is gone rather than left as a second way to do the same read.
  - Measured before/after with the same harness and the same input: a gated request went from
    **N + 3** property reads to a flat **1** (−92% at 10 stored sessions, −97% at 26). Per client
    per day: **41,760 → 1,440** operations. Locked in by the new `session lookup cost` suite.
  - This is also what makes gating the data routes affordable at all: `?type=` reads are **still
    open**, but each one would now cost **1** property read instead of **2 + N**.
  - **Backend change → needs a redeploy of `admin.gs`.**

### Fixed
- **The wall display could boot a build that had already been replaced.** Caught on the running
  display: the page had the build with the boot crash while the cache **already held the fix**.
  Stale-while-revalidate is right for assets but wrong for the one file with no `?v=` token, on a
  screen that may go days without a second load — it serves the old shell and only *stores* the
  new one.
  - **Navigations are now network-first**, with the cached shell as the offline fallback. Verified:
    a change to `index.html` is live on the **first** load — the one-load-late behaviour this was
    filed for no longer reproduces.
  - A **new worker** now triggers **one** reload via `controllerchange` (the worker takes charge
    of a page that already loaded its JS, so nothing else would ever pick the new code up). It is
    skipped on a first install, and skipped while the version-guard overlay is up — that guard
    clears and re-registers the worker on every load while it waits for a click, so reloading
    there too would have looped. Found by hitting it during verification.
- **NODE rendered five sheet values as raw HTML.** `province`, `impact`, `DT cause`, `downtime`
  and `aging` were interpolated straight into `innerHTML` while the node chips beside them went
  through the sanitizer. Reproduced: a value like `<img src=x onerror=…>` kept its **live
  `onerror` handler** verbatim on the old path; it is stripped now. Values used for the details
  modal are untouched, so the modal still shows raw text rather than entities.
- **Kiosk NODE slide with an active node-down incident.** With data present the slide led
  straight into the incident list, so a single incident drew one card across the top and left
  most of a wall display blank — it read as a broken layout rather than an alert. The slide now
  leads with a summary band (**active incidents · nodes affected · provinces affected · worst
  aging**) and then presents the incident itself:
  - **One incident** gets the whole stage as a spotlight — the node name (`ATB002-NPE-01`) is
    the headline, with nodes affected, aging, downtime-since and down cause as tiles. The node
    name was previously not shown at all, only its province.
  - **Several** share the stage using the same card idiom as the DOWN OLT list, worst blast
    radius first, so the two urgent slides read alike.
  - Empty sheet cells (`-`) render as a neutral `—` instead of a lone amber dash, and **SA /
    NSA** is now a chip rather than the largest number on the slide. Every figure still comes
    from the live feed, and the existing new/changed highlight chips are preserved.
  - The calm all-clear state (0 incidents) is unchanged.
- **API request storm / intermittent 404s.** A single call could stall ~15s and then return
  `HTTP 404` on `script.googleusercontent.com` while a sibling call succeeded — a transient
  Apps Script throttle, not a missing route. The client turned that brief window into a
  sustained failure:
  - `fetchWithRetry` now **de-duplicates in-flight requests** — identical URLs share one
    network call, so a burst (tab click + prefetch + visibility refresh) collapses into a
    single request instead of many.
  - Only **transient** failures are retried (network error, `429`, `5xx`, and `404`),
    with jittered exponential backoff. `400`/`401`/`403` fail immediately instead of being
    retried three times. A `404` used to be tolerated only **once**, so two consecutive stalls
    gave up — and the module then sat on "Error loading data." until its next poll, which is
    **up to an hour** for NAP (30 min LCP, 15 min OLT, 10 min NODE/BACKBONE). It now gets the
    caller's full retry budget. Reproduced deliberately: 1 failure in 20 rapid requests, gone on
    the very next one. A persistent `404` still fails after the budget, so a bad URL cannot loop.
  - A failed request now names the **hop that failed**. Every `/exec` call answers `302` and the
    payload arrives from `scriptusercontent.com`, so Chrome reports a failure on *either* hop
    against the request URL — which is why the same event looked like a `404` one day and a CORS
    error the next. `res.url` separates them: `… (failed hop: …/macros/echo)` means the redirect
    target rejected the content key, while no suffix means `/exec` itself throttled.
  - The per-retry `console.warn` spam was removed.
- **`isAdmin()` flooded the console on every tab change.** Six `console.log` lines per call, and
  it is called from `showTab()` *and* `showApp()` — nine tab switches printed ~54 lines and
  buried the real errors in the middle of them. The verdict is now silent; every error path in
  `admin-module.js` still logs.
- **Heartbeat load reduced.** Active-user heartbeat moved from every **30s to 60s** (the
  `ActiveUsers` sheet only drops a user after 5 minutes idle) and now **backs off two cycles
  after a failure** instead of hammering a struggling server.
- **Fixes could not reach the browser.** `db.js` and the eight `*-module.js` scripts had **no
  cache-busting query** (only `styles.css`, `kiosk.css` and `kiosk-module.js` did), and the
  service worker was cache-first — so a module fix kept serving from cache. All module scripts
  are now versioned, and (see below) the shell is served stale-while-revalidate so an edit
  lands on its own.
- **The oversized-payload cache never expired (latent freeze).** Payloads too large for
  `CacheService` (over ~90 KB) fall back to `PropertiesService`, which has **no native TTL and
  no invalidation anywhere** — that entry would have been served forever, silently freezing a
  module (OLT is the closest to the threshold at ~50 KB). Entries are now stamped with a
  `cache_v2_<type>_cached_at` write time and expired against the same per-type TTL as
  `CacheService` (60s OLT/NODE/BACKBONE, 180s NAP/LCP); an expired or **unstamped** entry is
  dropped and a fresh sheet read follows. Writing a small payload also clears any leftover
  oversized copy, so a module that shrinks back under the threshold can't be shadowed by it.
- **The version-guard update path was broken by the new cache entry point.** `checkAppVersion()`
  runs *before* the inline script that declares `const dataCache` (`index.html:796`), so
  `invalidateAll()` probed a variable sitting in its temporal dead zone — where even
  `typeof dataCache` **throws a `ReferenceError`** instead of returning `'undefined'`. The throw
  escaped `clearMemory()`, rejected the whole call and aborted `checkAppVersion`, so a required
  app update never cleared anything and **never showed the "App Update Available" prompt**. The
  lookup is now wrapped in `getDataCache()`, which cannot throw, and the guard is verified to
  run to completion (overlay shown, app booted, no exception).
- **Service worker precached keys nobody read.** `index.html` requests its assets as
  `styles.css?v=3.9.0`, `nap-module.js?v=3.9.0` and so on, but `STATIC_ASSETS` listed them
  **unversioned** — so the install-time precache warmed `nap-module.js` while the page asked for
  `nap-module.js?v=3.9.0`. The two never matched, and the offline shell was silently relying on
  stale-while-revalidate to fill the gaps. The precache now mirrors the page's tokens through a
  single `ASSET_VERSION` constant (verified an **exact 13-of-13 match** against `index.html`),
  and `pruneStaleAssets()` on `activate` clears stale variants such as the old unversioned keys
  or a copy left under an older token. The prune is deliberately narrow — it only touches keys
  whose pathname is an asset we manage, so the SWR navigation copy of `index.html?kiosk=true`
  and cached webfonts survive.
- **IndexedDB connections leaked, which made a database purge hang forever.** `openDB()`
  opened a **new connection on every call and never closed one** (`saveDailySnapshot` calls it
  twice, analytics on every render), and nothing handled `versionchange`. Connections therefore
  accumulated, and an external `deleteDatabase` could never release the database — the request
  sat pending with **no `success`, `error` or `blocked` event at all**, so any purge hung
  indefinitely. `db.js` now caches a single shared connection (`dbPromise`), closes it on
  `versionchange` and on abnormal close, and exposes `closeDB()`. `clearIndexedDB()` releases
  the connection before deleting and carries a 6s timeout as a backstop — a purge of
  `netpulse-db` went from hanging forever to completing in **19 ms**, and a fresh open
  afterwards recreates the schema and writes normally.
- **NODE "Monitored" count was inflated.** The tile reported 30 where the true figure was 16:
  the OLT feed returns provinces UPPERCASE (`BENGUET`) and the NAP feed Title_Case
  (`Benguet`), and the de-duplication key was not case-folded, so every shared province was
  counted twice. The key is now case-folded.

### Changed
- **Service worker shell strategy is now stale-while-revalidate.** The cached app shell paints
  instantly, the fresh copy is fetched and stored in the background, and the *next* load is
  current. Changing a file now reaches the browser on its own — no cache-name (`STATIC_CACHE`)
  or `?v=` bump needed per edit. Revalidation uses `cache: 'no-cache'` so it actually reaches
  the server rather than accepting a still-"fresh" HTTP-cache entry. Install precache is now
  per-file and non-fatal (a single missing asset can no longer fail the whole install), and
  the redundant service-worker retry around the API call was dropped — the app's own
  retry/backoff layer covers it. API responses are still never cached.
- **Kiosk NODE calm state wording.** The stat tile reads **"Monitored provinces"** (was
  "Monitored regions"), and the sub-headline matches.

### Added
- **Script-order guard against the temporal-dead-zone bug class.** A top-level `const` in a
  classic `<script>` throws `Cannot access 'X' before initialization` if a statement above it
  reads it — at first paint only, which is why the console afterwards looks fine. It has shipped
  twice (`dataCache`, then the module-skeleton table). `tests/inline-order.js` now walks every
  script `index.html` loads, in load order, follows the call graph from each top-level call, and
  reports any top-level `const`/`let`/`class` read too early. 18 tests: the app-clean gate, the
  rule cases (await, `try/catch`, `try/finally`, shadowing, callbacks), and a **re-introduction
  of each historical bug in its real shape** so the check cannot quietly stop working. Both
  readers lived in a separate file, so the walk is cross-file: it follows a property call
  (`netpulseCache.invalidateAll(`) into an IIFE-wrapped file, which is how the `dataCache` chain
  is found. Suite total: 105 tests.
- **Skeleton loading while a module fetches — all five modules, one mechanism.** Earlier on load
  a module showed a row of `0`s above an empty table, which reads as "no outages" rather than
  "not loaded yet". Now every module shimmers while its first fetch is in flight: NAP (4 stats +
  table), LCP (6 stats + the aging and impact tables), OLT (6 stats + table + the donut total and
  its legend), NODE and BACKBONE (stats + table). Export buttons are deliberately held back until
  there is something to export.
- **The old whole-tab skeleton is gone.** It swapped a whole tab for a fake table built from
  `div`s, so the loading state had a header and a column count with nothing to do with the table
  it stood in for — and it could not be used on NAP/LCP/OLT at all, because those keep their
  markup in `index.html` and their renderers fill only the tbody and the cards, so swapping the
  tab would have deleted markup nothing puts back. NODE and BACKBONE used it only because they
  build their entire tab. Their renderers now emit their shell (`nodeTableShellHtml` /
  `backboneShellHtml`) and fill its tbody, so all five modules go through the same shimmer rows
  inside the module's **real** table, with column counts read from each table's own `<thead>` —
  the LCP aging skeleton draws 6 cells per row and the impact one draws 5, matching their headers
  exactly. `getSkeletonHTML`/`showSkeleton` and the fake-table CSS were deleted. Every render
  assigns `textContent`/`innerHTML` and so overwrites its own placeholder; a failed fetch clears
  the skeleton instead of leaving the table shimmering as if it were still loading.
- **Browser-free backend test harness.** `tests/` runs the real `code.gs` and
  `admin.gs` inside a Node `vm` against faked Google services, so `doGet` routing
  and every caching layer can be checked **without deploying to Apps Script**.
  Zero dependencies (Node built-ins only — the repo has no `package.json`), run
  with `node --test`. 59 tests cover routing, per-type cache TTLs, the
  `PropertiesService` overflow/expiry paths, per-module data-shape parsing, and
  the admin handlers; the fakes reproduce the details that hide bugs (empty cells
  read as `''`, `computeDigest` returns **signed** bytes, `CacheService` entries
  really expire, and the clock is controllable so expiry is deterministic).
  Verified to have teeth by mutation testing: flattening the per-type TTL fails
  **7** tests, dropping the type suffix from the cache key fails **15**, and
  removing the stale-property delete fails **1** — the test written specifically
  to isolate it. See `tests/README.md`.
- **`netpulseCache` — one documented entry point for the caching layers.** `cache-control.js`
  replaces five ad-hoc clearing steps with one call: `status()` reports what is held where,
  layer by layer; `invalidateAll()` is the **safe** clear (`dataCache` + shell cache); adding
  `{ indexedDB: true, storage: true }` takes the destructive layers, and `clearEverything()`
  does all of it plus the service-worker unregister and a reload. Safe by default on purpose —
  clearing IndexedDB discards 90 days of trend history and clearing storage logs the user out,
  while `localStorage` prefs (`theme`, `netpulse_*`) are always preserved. The Apps Script
  server cache is deliberately **not** client-clearable, since no server-side auth exists to
  guard a purge endpoint; it stays TTL-bound and self-heals. `GVSI_NetPulse_Caching_Notes.md`
  documents the whole thing.
- **"Clear Cache & Resync" in the admin panel.** A new **Cache & Data Sync** section exposes
  `netpulseCache` to a support tech without devtools: a live per-layer table (server cache,
  IndexedDB, service worker, shell cache, HTTP cache, `dataCache`, localStorage) plus one button
  that clears the safe layers and force-refetches every module. The table has two value columns —
  **"Held now"** is live, and **"Last clear"** records what was actually removed
  (e.g. `deleted: gvsi-shell-v3.9.4`, `cleared: nap, lcp, olt, node, backbone`), which is the
  part that shows *what was stale*. The resync reports per module (`5 of 5 modules refetched`),
  naming any that failed instead of failing silently, and the report is kept in `sessionStorage`
  so it survives a reload. Only the safe layers are touched — trend history (IndexedDB) and the
  login are never cleared, and the UI says so, including why the backend cache cannot be purged
  from the client.
- **Payload size headroom in the admin panel.** The Cache & Data Sync section now also shows how
  close each module's payload is to the backend's caching thresholds — payload, a usage bar
  against the 90 KB CacheService line, and the remaining headroom — with the tightest module
  called out by name. This is a **silent** failure mode rather than an error: past 90 KB a module
  quietly changes route onto the hand-expired `PropertiesService` fallback, and past 450 KB it
  stops being cached at all so every request re-reads the sheet. Measured live, OLT is the only
  module anywhere near it at **50,056 B — 55.6% of the limit, 39.9 KB headroom** (NAP 837 B,
  LCP 378 B, NODE 2 B, BACKBONE 1,627 B). The measurement needs no backend change: re-serializing
  the parsed payload reproduces `code.gs`'s `JSON.stringify(resultData).length` **exactly**,
  verified byte-for-byte against all five live endpoints. Exposed as
  `netpulseCache.payloadHeadroom()` and wired into the existing Refresh Status / Clear & Resync
  actions.
- **Kiosk OLT down-count card.** The OLT slide now states how many OLTs are down as its own
  compact card with a hard red accent, placed immediately *before* the client-impact figure,
  so the device count and the people count can never be read as one number. It is live-derived
  from the same status buckets as the donut, colour-coded red/teal, pluralised correctly, and
  wired into the change highlighting.
- **Kiosk change highlighting.** Values that moved since the previous refresh are marked with
  `▲ +N` / `▼ −N` chips, brand-new outages get a `NEW` chip plus a ring flash, and the ticker
  narrates what changed. Highlights expire after 90s, and the first load is deliberately quiet.
- **Kiosk calm-state heartbeat.** The `.kiosk-calm-icon` (NODE all-clear, backbone all-clear,
  OLT no-data) now pulses with a soft double-thump and an outward-sweeping ring, so an
  all-clear state reads as *still checking* rather than *idle*. Honours
  `prefers-reduced-motion`.
- **Session tokens (P1, phase 1 of the auth rollout).** `handleLogin` now mints a token and
  stores the session server-side (`PropertiesService: session_<token>` = `{u, name, role, exp}`,
  24 h TTL); the four write routes that could break the system or lie about who did it —
  `setMaintenance`, `getActiveUsers`, `heartbeat`, `removeActiveUser` — now verify it, and a new
  `logout` action revokes it. `UpdatedBy` is taken **from the token**, so the audit trail can no
  longer be forged; heartbeat identity likewise comes from the token rather than `?username=`.
  Rollout is deliberately **"accept-if-present"**: a *missing* token is still tolerated so a
  cached shell keeps working, while a *present-but-invalid* token is always refused — the
  backend can therefore be deployed before every client has the new shell. Login is throttled
  (5 failures → 5-minute lockout, checked before any sheet read), tokens are pruned on every
  gated request *(superseded 2026-09-13 — the sweep now runs at login only; see Unreleased)*, and
  the prune is prefix-scoped so it can never touch `cache_v2_*`. Data routes
  (`?type=`) are untouched, so no stale token can blank the kiosk. 26 new tests cover minting,
  expiry, revocation, pruning, role rejection, forged-username rejection and the throttle;
  mutation-tested (disabling the role check, the `UpdatedBy` override, the expiry check, the
  invalid-token rejection or the prune filter each fail the suite). See
  `GVSI_NetPulse_Auth_Notes.md`, and `todo.md` for the remaining work.
- **Backend test harness now fakes `Utilities.getUuid` and records `Utilities.sleep`.** The
  fakes are recreated on `reset()` like the others, so the recorded sleeps cannot leak between
  tests — the same isolation guarantee the stubbed cache methods needed.

### Changed
- **Signing in now costs one round trip instead of two.** The boot awaited the maintenance check and
  only then started the login, so the wait was paid twice — measured **2.27 s + 2.26 s** on a warm
  backend, and a cold start on this deployment can be ~37 s. Both calls are now fired together and
  the result is reconciled afterwards: if maintenance came back **on**, the session the parallel
  login minted is dropped (otherwise `isLoggedIn()` would short-circuit the maintenance check on the
  next load and let the user straight in) while the saved credentials are deliberately kept, so
  auto-login works again the moment maintenance ends. `performLogin()` takes a `deferShow` flag so
  the app is not flashed on screen while the race is still undecided. Measured after the change:
  both requests start on the **same millisecond** and overlap by 2255 ms — wall clock 2266 ms where
  sequential would be 4521 ms.
- **Session tokens are now enforced (P1 phase 2).** `REQUIRE_SESSION` was flipped to `true`
  after the token path was verified against the deployed backend — a real login issued a token,
  a role-gated route accepted it, and the heartbeat's raw `fetch` carried it. A caller with **no**
  token is now refused as well as one with a bad token, so the four write routes are closed rather
  than merely forge-proof. The `?admin=` param is gone from the client **and** its server-side
  fallback was deleted, so `UpdatedBy` has exactly one source; with no token the actor is recorded
  as `unknown` rather than guessed. A client whose session predates the flip holds no token and
  will be asked to sign in again — data routes and the kiosk are unaffected, since they were never
  gated. The switch stays a named constant so the change is auditable and one line can revert it,
  and a tripwire test fails if it is ever set back to `false`.

### Fixed
- **The maintenance page's "Auto-refresh every 60 seconds" never fired.** Its check used
  `ADMIN_API_URL`, which is empty until an admin tab renders — so the request went out as a bare
  `?action=getSettings`, resolved against the *app's own* origin, 404'd, and was swallowed by an
  empty `catch`. A user left on the maintenance page stayed there after maintenance ended. It now
  takes the URL from the page (`window.BASE_API_URL`).
- **A stalled or throttled API call surfaced as a bogus CORS error.** The service worker's API
  passthrough was a bare `fetch()` with no `catch`, so when Google answered a stalled request
  (this deployment throttles, and can come back with a page carrying no CORS header) the promise
  rejected unhandled: the console showed `blocked by CORS policy` plus
  `Uncaught (in promise) TypeError: Failed to fetch`, and the failure looked like a header
  misconfiguration rather than a transient network fault. It now returns a clean synthetic **503**,
  so `fetchWithRetry` classifies and retries it the way it already handles a busy server. Verified
  by pointing the worker at a host that never resolves: the call now comes back
  `503 {"offline":true}` instead of throwing.
- **The heartbeat beat forever against a refused session.** A refused session answers `200` with a
  marker body (ContentService cannot set a status code), so `res.ok` was true and the old code
  never backed off — a client whose token was gone would hit `/exec` every 60s indefinitely and
  never learn why. It now stops on `unauthorized`; a re-login restarts it via
  `showApp()` → `startHeartbeat()`.
- **Safety-worker fixes could sit dormant for up to 24 hours.** The browser only re-checks `sw.js`
  on a navigation once every 24h, and the registration URL no longer changes now that versions are
  not bumped per edit — so an old worker (and an old `admin-module.js` with it) could keep running
  long after the fix shipped. `index.html` now calls `reg.update()` on every load, which bypasses
  the throttle and lands the worker immediately. See trap #7 in `GVSI_NetPulse_Caching_Notes.md`.
- **Logging out never removed the user from `ActiveUsers`.** The "cleanup on logout" override in
  `admin-module.js` could not have run: that file loads *before* the inline script in
  `index.html` that declares `handleLogout`, so at load time `typeof handleLogout === 'undefined'`,
  the assignment was skipped, `_originalHandleLogout` stayed `null`, and the function holding the
  removal was referenced nowhere. `?action=removeActiveUser` had therefore **never** fired on
  logout — the 5-minute staleness prune in `handleGetActiveUsers` was quietly doing the cleanup.
  Revocation and the row removal now live in the `handleLogout` that actually executes, which
  also stops the heartbeat interval (it previously kept ticking after logout, idling forever).
- **An admin could not remove another user from `ActiveUsers`.** Deriving the target purely from
  the session made the admin branch of the role check unreachable — the handler always tried to
  delete the caller's own row. The requested name is now the target, with self-removal always
  allowed and removing somebody else admin-only.

---

## [3.9.0]

### Added
- **Kiosk Mode Redesign.** The NOC/TV wall display is now its own presentation layer:
  severity band and hotspot provinces for NAP, a client-impact hero for LCP, a status donut
  with down-OLT alert cards for OLT, a calm all-clear state for NODE, and DWDM/MPLS link
  cards for BACKBONE. Admin tables, export buttons and sorting are unchanged.
- **Live Slides with Auto-Rotation.** Slides read the same live data source and refresh on
  their own — no manual reload needed. Auto-rotate every 9 seconds with progress dots,
  pause-on-interaction, prev/pause/next controls, and a live-data ticker.

---

## [3.8.2]

### Added
- **Dark Mode Default** — dark theme on first load, no more white flash (anti-FOUC script).
- **Frosted Glassmorphism UI** — cards, header, nav and modals use backdrop blur with
  crystal borders and metallic top-edge accents.
- **Live Activity Ticker** — scrolling status bar below the header showing real-time system
  events. Pauses on hover to read.
- **Kiosk Mode Toggle Button** — monitor icon in the header for quick activation.
- **Status Pulse Animations** — animated ping/pulse indicators for Operational (green),
  Degraded (amber) and Critical (red).
- **Ambient Glow Orbs** — subtle teal and indigo radial gradients behind the stats grid.
- **Kiosk Mode / Fullscreen Presentation** — fullscreen NOC/TV display that auto-cycles the
  NAP, LCP, OLT, NODE and BACKBONE tabs every 15 seconds with live clock, countdown timer and
  pause/play controls. Activate with `Ctrl+Shift+K` or `?kiosk=true`.
- **Node Module DT Cause Column** — color-coded "DT CAUSE" column in the Node DOWN table.

### Fixed
- **Mobile Header** — hid the KIOSK button and "| CONVERGE" text on mobile (only
  "GALLOPVISION" shows); compacted header spacing for small screens.
- **Node Modal Ticket** — ticket number now shows in Node Incident Details (reads Column F).
- **OLT Modal Syntax** — fixed a `SyntaxError` when clicking MOUNTAIN PROVINCE rows by
  properly escaping newlines in the remarks field.
- **Backbone Links Text Wrap** — long link descriptions now wrap instead of overflowing.

### Changed
- **Vignette Removed** — removed the dark edge vignette overlay for a cleaner dashboard.
- **OLT Modal Latest Update** — renamed "Remarks" to "LATEST UPDATE:" and moved it to the
  bottom in paragraph form, matching the Node modal.

---

## [3.5.0]

### Added
- **OLT DT Cause Column** — color-coded "DT CAUSE" in the OLT DOWN table: FIBER (red),
  POWER (orange), EQUIPMENT (yellow), TBD (gray), FIBER AND POWER (violet).

### Changed
- **Backend Cleanup** — admin/login functions moved into `admin.gs`; `code.gs` now only
  handles data fetching.

### Fixed
- **Login Speed** — Apps Script keep-alive ping reduces cold-start delay; returning users log
  in under a second.
- **Heartbeat** — active-user tracking now works for non-admin users, so all logged-in users
  appear in the admin panel.

---

## [3.4.0]

### Added
- **Admin Panel** — dedicated module for the Tech admin/Dev role with Maintenance Mode and
  Active Users tracking.
- **Maintenance Mode** — admins can temporarily disable app access for all users.
- **Active Users** — real-time tracking with online/idle/offline status.
- **Parallel Prefetch** — all modules fetch simultaneously instead of sequentially.
- **Role-Based Access** — the Admin tab is visible only to the 'Tech admin/Dev' role.

### Fixed
- **Login** — fixed a failure caused by the Apps Script POST redirect; now uses GET params.

### Changed
- **Firebase Disabled** — removed Firebase messaging due to console errors (re-enable later).

---

## [3.3.1]

### Fixed
- **XSS Security** — DOMPurify now sanitizes all dynamic data across NAP, LCP, OLT,
  Analytics, Node and Backbone.
- **CacheService Overflow** — large payloads (460+ OLT rows) fall back to PropertiesService
  (500KB limit) instead of failing silently.
- **Chart.js Memory Leak** — analytics charts destroy old instances before re-creating.
- **Version Guard** — deploy updates no longer wipe settings; theme, notifications and
  session are preserved.

### Added
- **Column Constants** — backend uses named column indexes (`COL`) to survive Sheet changes.
- **Search Debounce** — 200ms debounce on search inputs.
- **Smart Prefetching** — preloads only LCP and OLT on startup instead of all tabs.
- **Batch DOM Updates** — modules build HTML strings and set `innerHTML` once.
- **Auto-Refresh Triggers** — aging-duration scripts run automatically via time-driven
  triggers (no manual execution).

---

## [3.3.0]

### Added
- **Login Module** — secure authentication with SHA-256 hashed passwords stored in Google
  Sheets; session persists 24 hours.
- **Logout Button** — sign out from the header.
- **Per-OLT Client Lookup** — Apps Script reads Column AB (OLT names) and matches each OLT to
  its client count in the NLZ OLT Report.

### Fixed
- **PWA Card-View** — table no longer breaks into vertical card view on some Android devices
  in standalone mode (lowered media-query threshold + JS viewport guard).
- **OLT Affected Clients Double-Count** — each OLT now shows its individual client count
  rather than summing duplicates when multiple OLTs share a ticket.
- **Modal Affected Clients** — the OLT modal shows the selected OLT's individual count.

---

## [3.2.0]

### Added
- **Keyboard Shortcuts** — `R` to refresh, `1`–`7` to switch tabs, `Esc` to close a modal,
  `?` for help.
- **Custom Date Range** — Analytics supports 7/30/90-day filters.
- **Comparison Mode** — week-over-week comparison in Analytics.
- **PDF Export** — export any module table as PDF.

### Fixed
- **Modal Link-Chip** — affected links in the Backbone modal wrap properly with no overlap.

---

## [3.1.1]

### Added
- **Skeleton Loading** — shimmer placeholders replace the spinner.
- **Clipboard Copy** — click a ticket number in the OLT, Node or Backbone modal to copy it,
  with toast confirmation.
- **Alert Thresholds** — rows and stat cards auto-highlight when incidents exceed thresholds
  (red for high, yellow for medium).
- **Bottom Navigation (Mobile)** — fixed bottom tab bar with per-module icons.
- **Tab Animations** — smooth fade-in transitions between tabs.

---

## [3.0.0]

### Added
- **IndexedDB Offline Storage** — daily snapshots stored locally for an offline-first
  experience, with up to 90 days retention.
- **Trend Charts** — Incidents per Day, OLT Status Trend, Clients Affected Trend and Aging
  Distribution using Chart.js.
- **Push Notifications** — Firebase Cloud Messaging for critical alerts (OLT DOWN, new
  backbone incidents).
- **Notification Toggle Button** — bell icon in the header.
- **Daily Snapshot System** — automatic capture of daily metrics from all modules.

### Security
- **DOMPurify XSS Protection** — all dynamic data from Google Sheets is sanitized before
  rendering.

---

## [2.5.0] — Analytics Dashboard

### Added
- **Analytics Dashboard** — unified view aggregating NAP, LCP, OLT, Node and Backbone.
- **Module Snapshot Cards** — quick-glance summary cards with icons per module.
- **Donut Charts** — OLT Status Distribution and Backbone Service Type breakdown.
- **Aging Timeline** — horizontal progress bars for NAP + LCP aging distribution.
- **Top Provinces Chart** — top 10 provinces by incident count.
- **Critical Tickets Table** — OLT tickets with the longest aging, highlighted.
- **Responsive Analytics Layout** — charts adapt to mobile.

---

## [2.4.1] — Performance & Stability

### Added
- **CSV Export on All Tabs** — export buttons for LCP, OLT, NODE and Backbone.
- **Smart Search Bar Injection** — search bars auto-attach to dynamically rendered tables.
- **Centralized Loader Control** — eliminated loader flicker from parallel fetches.
- **Error Logging in Catch Blocks** — silent catch blocks now log to the console.

### Fixed
- **App Startup Crash** — resolved a `ReferenceError` that prevented data loading on open.
- **Instant Cache Rendering** — cached data displays immediately on tab switch.

### Changed
- **Parallel Prefetch** — all tabs prefetch within 1 second (previously ~7.5s sequential).
- **Smart Foreground Refresh** — refreshes only after 2+ minutes in the background.

---

## [2.4.0] — Modularization & UX

### Added
- **Pull-to-Refresh** — swipe down on mobile to refresh the current tab.
- **Error Toast/Snackbar** — visible error and success messages.
- **Search/Filter** — real-time search bars on all data tables.
- **CSV Export** — one-click export for any tab.
- **Retry with Backoff** — automatic retry on failed API requests (3 attempts, exponential
  backoff).
- **External CSS** — all styles extracted to `styles.css`.
- **styles.css Service Worker Cache** — added to PWA static assets for instant offline load.

### Changed
- **Modular Architecture** — NAP, LCP and OLT extracted into separate `.js` files.
- **Debounced Refresh** — 500ms debounce on the refresh button prevents API spam.

---

## [2.3.2]

### Added
- **Backbone Modal — Affected Links** section in the Backbone Link Details modal.

---

## [2.3.1]

### Changed
- **Mobile Responsive Stat Cards** — Backbone stat cards use a 3+2 grid on mobile.
- **Mobile Link Chips** — long link descriptions scroll horizontally.
- **Link Chip Compact Styling** — reduced font size and padding.

### Fixed
- **Mobile Table Layout** — Backbone table exempted from ultra-small card-view mode.

---

## [2.3.0]

### Added
- **Backbone Summary Stat Cards** — Total Links Affected, DWDM Low Power, DWDM Link Down,
  MPLS Low Power and MPLS Link Down.
- **Backbone Empty State** — clean landing page when no incidents are pending, with a green
  checkmark, "All Backbone Links Operational" and DWDM/MPLS status indicators.
- **Backbone Downtime & Aging in Modal** — added Col N (Downtime) and Col X (Aging Duration).

### Fixed
- **Residual Data Filter** — excluded phantom rows from stale Links (Y) and Count (Z) values
  when source ticket data is deleted.

### Changed
- **Backbone Table Cleanup** — removed the Downtime column; aligned the total links count to
  the Aging column.

---

## [2.2.0]

### Added
- **Backbone Links Module** — new monitoring tab reading live ticket data from the "Backbone
  Tickets" sheet: Province, Service Type (DWDM/MPLS), affected links as chips, link count and
  status, with a modal on click.
- **Backbone Modal Details** — slide-up modal per ticket with Province, Ticket No, Service
  Type, Status, Aging Duration and Remarks.
- **Backbone Service Transformation** — "NPE" is displayed as "MPLS"; DWDM stays as-is.
- **Background Auto-Refresh & Prefetching** — Backbone refreshes every 10 minutes, preloads
  7.5s after initial load, and syncs instantly when the app returns from minimized.

---

## [2.1.1]

### Added
- **OLT Impact & Client Tracking** — real-time affected-client count per ticket via backend
  LNOC sync, with an "Affected Clients" column and an "Affected Clients (DOWN)" summary card.
- **Visual Status Distribution** — pure CSS donut chart for OLT status (UP, DOWN, Low Power,
  Uplink Down, Degradation) with counts and percentages.
- **LCP Impact Summary Row** — streamlined top metrics plus a bottom summary row showing
  Total Clients Affected, Total Tickets and Total LCPs without extra fetch latency.
