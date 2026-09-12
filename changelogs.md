# Changelog

All notable changes to **GVSI NetPulse** are recorded here.

The in-app **About → What's New** panel mirrors the most recent entries; this file is the
complete history, including work that has not been released yet.

Format is loosely based on [Keep a Changelog](https://keepachangelog.com/).
Versions follow the app's own numbering. Newest first.

---

## [Unreleased]

### Fixed
- **API request storm / intermittent 404s.** A single call could stall ~15s and then return
  `HTTP 404` on `script.googleusercontent.com` while a sibling call succeeded — a transient
  Apps Script throttle, not a missing route. The client turned that brief window into a
  sustained failure:
  - `fetchWithRetry` now **de-duplicates in-flight requests** — identical URLs share one
    network call, so a burst (tab click + prefetch + visibility refresh) collapses into a
    single request instead of many.
  - Only **transient** failures are retried (network error, `429`, `5xx`, and `404` once),
    with jittered exponential backoff. `400`/`401`/`403` fail immediately instead of being
    retried three times.
  - The per-retry `console.warn` spam was removed.
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
  gated request, and the prune is prefix-scoped so it can never touch `cache_v2_*`. Data routes
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
