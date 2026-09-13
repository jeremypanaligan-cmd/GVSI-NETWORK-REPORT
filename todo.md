# GVSI NetPulse — TODO

Live work board. `changelogs.md` records what shipped; this records what is
next and what is in flight. `GVSI_NetPulse_System_Roadmap.md` is the older
audit narrative — several of its HIGH findings are already fixed, so treat
this file as the source of truth for outstanding work.

Legend: ⬜ todo · 🔄 in progress · ✅ done · ⏸ blocked
Last updated: 2026-09-13 · Version: 3.9.0 · Backend suite: 94/94, script-order suite: 18/18,
OLT payload suite: 9/9 (121 total)
Buong app-weight batch (icons, kiosk storm, stale shell, NODE escaping, **OLT payload**): **tapos**,
hindi pa naka-commit at hindi pa naka-push. `code.gs` ay may pagbabago → **kailangan ng redeploy**
para gumana ang `shape=2`; hanggang doon, legacy payload pa rin ang natatanggap at walang
nagbabago sa paggana.

---

## 🔴 Now — P1 Phase 1: session tokens, accept-if-present

> **Why:** every `doGet` action is open to anyone holding the deployment URL,
> and `handleSetMaintenance` takes the actor name straight from the URL
> (`e.parameter.admin`) and stamps it into `AppSettings.UpdatedBy` — so a caller
> can both flip maintenance mode and forge the audit trail. The client-side
> `isAdmin()` check is cosmetic only.

**Shape:** a token minted at login, stored server-side, presented on protected
routes. Identity comes from the token, never the URL. `REQUIRE_SESSION = false`
keeps a *missing* token tolerated (so an old cached shell keeps working) while a
*present-but-invalid* token always fails. Phase 2 is one constant.

### Backend (`admin.gs` / `code.gs`)

- ✅ Token constants + helpers: `issueSessionToken` / `readSessionToken` /
  `revokeSessionToken` / `pruneExpiredTokens` / `requireSession` / `jsonOut`
- ✅ `handleLogin` returns a token; login throttling (5 fails → 5 min lockout)
- ✅ Gate `setMaintenance` + `getActiveUsers` (admin role), `heartbeat` and
  `removeActiveUser` (any session); `UpdatedBy` from the token, not `?admin=`
- ✅ New `logout` action in the router that revokes the token

### Tests (offline harness)

- ✅ Harness: `Utilities.getUuid`, recorded `Utilities.sleep`, `utilities`
  recreated on `reset()`
- ✅ 26 tests: mint / expiry / revoke / prune, role rejection, forged-username
  rejection, accept-if-present switch, throttling (85 total, up from 59)
- ✅ Mutation-check the new tests (delete the role check and the `UpdatedBy`
  override; each must fail) and restore `admin.gs` byte-for-byte

### Frontend

- ✅ Store the token; inject it in `fetchWithRetry` and the 3 raw `fetch` calls
- ✅ Detect the unauthorized marker → toast + forced re-login
- ✅ Revoke + `removeActiveUser` on logout, in the `handleLogout` that actually
  runs (the `admin-module` override was dead code — see Notes)
- ✅ Add `netpulse_session_token` to `_preserveKeys`

### Docs & rollout

- ✅ `changelogs.md` entry + security note on the token model and the flip
  (see `GVSI_NetPulse_Auth_Notes.md`)
- ⏸ **Redeploy the Apps Script web app** — required before any of this is live.
  Until then the deployed endpoint ignores `?token=` entirely and never issues
  one, so the client runs exactly as before (verified: un-tokened request URLs are
  byte-identical to the old ones).

---

## 🟡 Next — P1 Phase 2: enforce

- ✅ Flip `REQUIRE_SESSION` to `true` — done 2026-09-12 after the token path was
  verified against the deployed backend. **Backend change: needs a redeploy.**
- ✅ Drop the `?admin=` param from the client, and remove the server fallback so
  there is only one source of truth for `UpdatedBy`
- ✅ Tests updated for enforcement (87 total) + a tripwire test that fails if the
  switch is ever turned back off
- ⬜ Optional: sliding token refresh on heartbeat (no rotation today)
- ⬜ Optional: token TTL shortener — 24 h is aligned to the client session, not
  the shortest safe window
- ⬜ Optional: an active-sessions view in the admin panel so a token can be
  revoked without waiting out its 24 h TTL
- ⬜ Optional: gate the `?type=` data routes. **Now cheap** — a gated request
  costs **1** property read instead of **2 + N** since the sweep moved to login
  (see Done), so the quota objection no longer applies. The blocker is **token
  lifetime**: the kiosk is a 24/7 display with nobody to re-sign-in, and
  `SESSION_TOKEN_TTL_MS` is 24 h, so gating without a sliding refresh (or a
  long-lived display token) blanks the wall once a day. Do that first.

> **Confirmed deployed** the same day: a tokenless heartbeat answers `"Sign-in required"`, which
> only exists in the enforced version.
>
> **Rollout note.** A client whose session predates the flip holds no token, so
> its gated calls are refused. Data routes and the kiosk are unaffected, and the
> admin panel shows "Session expired" → one re-login mints a token. Also note the
> client stops sending `?admin=` **as soon as it reloads**, which is before the
> backend flip is redeployed — in that window a maintenance toggle from a
> tokenless session would record `unknown` as the actor. Harmless, but it is why
> the redeploy should follow promptly.

---

## 📉 App weight (sinukat 2026-09-13 · **3 sa 4 tapos na** 2026-09-13)

> **Baseline na sinukat** (huwag nang ulitin ang pagsukat, gamitin ito bilang "bago"):
>
> | Kaso | requests | decoded |
> |---|---|---|
> | Unang bisita, static | — | **~389 KB sa network** (607 KB raw text → 105 KB gzip, + 202 KB icons, + ~74 KB fonts, + ~8 KB DOMPurify) |
> | Pagbabalik na bisita | — | 0 app code (SW cache) |
> | Dashboard cold boot | 6 | 51.7 KB |
> | Dashboard, naka-idle 60 s | 2 | 0.4 KB |
> | Kiosk cold load | 10 | 102.5 KB |
> | Kiosk, tumatakbo 60 s | 11 | 198.7 KB |
>
> Paraan ng pagsukat (para maulit nang pareho): `performance.getEntriesByType('resource')` sa page
> para sa bilang at `decodedBodySize`; `curl -s -L --compressed -w '%{size_download}'` para sa
> totoong bytes sa wire; `caches.keys()` + `cache.keys()` para sa laman ng SW cache.
> Paalala: **hindi nagsi-gzip ang Live Server locally**, kaya ~2× na mas malala ang lokal na
> numero kaysa sa isang gzip-capable na host.

- ✅ **1. Putulin ang bigat ng icons** — ang `icon-512.png` at `apple-touch-icon.png` ay
  **byte-for-byte identical** (parehong md5 `9a198d5e958426cce8e654e8a7cc7b32`, 86.9 KB bawat isa),
  at **kapwa nasa `sw.js` `UNVERSIONED_ASSETS`** — kaya **87 KB ay dina-download nang dalawang beses**
  sa bawat SW install. Ang icons ay **202 KB = 52% ng unang load**, mas malaki pa sa buong JS.
  Ang `icon-192.png` ay 28.6 KB para sa 192×192, napakabigat para sa isang flat logo.
  **Gawin:** ihinto ang duplicate (isang 180×180 na `apple-touch-icon`), i-re-encode ang dalawa;
  isaalang-alang ang maskable/simpleng logo. Nasa precache → kailangang ma-revalidate.
  **Walang backend change.** **Tsek:** ang unang-load total ay bumababa, masukat sa parehong paraan.
  **RESULTA:** precache **202.4 KB → 89.8 KB (−112.6 KB)**, unang bisita ~389 → ~277 KB.
  `apple-touch-icon` ay 180×180 na (**86.9 → 16.1 KB**), `icon-512` 86.9 → **52.7 KB**,
  `icon-192` 28.6 → **21.1 KB**. Bagong tool: `tools/optimize-icons.js` (median-cut 128 colours,
  8-bit alpha, adaptive filtering, zlib 9) — **PSNR 46.9 / 44.1 / 46.2 dB**, MAE < 1/255.
  Hindi PNG-8: isang transparent index lang ang kaya nito, at may anti-aliased na gilid ang icons
  (187 distinct alpha). `STATIC_CACHE` → `v3.9.5` (precache-only asset, walang SWR path).

- ✅ **2. Paliitin ang OLT payload** — `?type=olt` ay **50,179 bytes decoded** (461 rows × 9 field)
  kumpara sa `nap` na 836 bytes lamang. Ito ang **96.9% ng lahat ng API bytes** (dashboard boot:
  50,059 sa 51,664). Ang mga field: `N` 33%, `P` 22%, `M` 22% ng chars — pero **16 distinct na
  province, 211 municipality, 3 status, 3 down-cause** lang, kaya sobrang redundant.
  **Gawin:** (a) server-side dictionary — ang `P`/`M` ay index sa isang header array, o
  (b) ipadala ang aggregates + ang mga down na row lang para sa kiosk, o (c) paikliin ang keys.
  **Tandaan:** ang gzip ay nagpapababa na sa **3,534 bytes sa wire** — kaya ang panalo dito ay
  pangunahin ang **decoded/parse** (~287 MB/araw sa kiosk) at ang CPU sa mahinang TV, hindi ang
  bytes sa wire. **Backend change → nangangailangan ng redeploy.**
  **Tsek:** `curl -L --compressed | wc -c` bago/kalaban, at dapat 461 row pa ring nagre-render.
  **RESULTA:** **50,179 → 26,304 bytes (52%)**, parehong 461 row. `shape=2` ay
  `{v, f, p, m, r}` — `P`/`M` bilang index sa dalawang dictionary, positional ang row, at ang
  field order ay sakay ng payload (`f`) para hindi magkahiwalay ang dalawang panig. Ang pinaka-
  malaking bahagi pala ay ang **paulit-ulit na pangalan ng field** (14,291 bytes = 28%): ang
  dictionary lang ay 89% pa, ang positional rows ang nagdala sa 52%. Legacy shape pa rin ang
  default, **sariling cache key** (`cache_v2_olt` vs `cache_v2_olt_c2`) dahil bago pa tiningnan
  ang `shape` ay may cache hit na — iisang key = maling shape sa pangalawang tumawag. Ang client
  (`decodeOltPayload`) ay sa fetch boundary lang nagde-decode, kaya walang ibang ginalaw, at
  tumatanggap pa rin ng legacy payload kung hindi pa na-redeploy. **Sinukat sa live sheet:**
  byte-for-byte identical ang round trip, at sa browser ay **kapareho** ang na-render na table.
  Nakatuklas din ng **dalawang ibang `?type=olt` fetch path** na sariling URL ang ginagawa
  (`prefetchOtherTabsInBackground()` at ang analytics cold-start) — lumalabag sa throttle at
  hindi na-de-dupe; pareho nang dumadaan sa module fetcher. Bagong suite:
  `tests/olt-payload.test.js` (9 tests). **Kailangan ng redeploy.**

- ✅ **3. Itigil ang kiosk re-fetch storm** — ang `fetchOltData()` ay cache-first **pero laging
  nagpapaputok ng background revalidation** (`olt-module.js:3-12`), at tinatawag ito ng kiosk sa
  **bawat rotation papunta sa OLT slide** (`kiosk-module.js:188-200`). Sinukat: **4 na 50 KB kada
  minuto**; ang kiosk ay 11 requests / 198.7 KB kada minuto laban sa dashboard na naka-idle na
  2 requests / 0.4 KB. Sa wire iyon ay ~927 KB/oras (~22 MB/araw).
  **Gawin:** i-throttle ang revalidation (galangin ang 15-minutong poll interval ng module), o
  hayaan ang kiosk rotation na mag-render mula sa cache nang hindi nagre-revalidate.
  **Tsek:** sa isang 60 s na window sa kiosk, bumaba sa ≤1 OLT fetch; hindi dapat masira ang live
  updates (hayaan ang `KIOSK_REFRESH_MS` na humawak ng refresh). **Walang backend change.**
  **RESULTA:** `shouldRevalidate()` sa `cache-control.js` — **isang revalidation kada module kada
  minuto**; `backgroundRefresh()` ay `forceRefresh` kaya hindi naaapektuhan ang module timers at
  tumatawag ng `markRevalidated()`. **10 sunod-sunod na `fetchNapData()` → 1 request** (9 ms).
  137 s na kiosk window na may 15 rotations: **11 requests**, OLT **3** (1 dito ay module timer).
  Check na hinihingi (≤1 OLT fetch kada 60 s): **pumasa**. Tingnan ang note 3 ng caching notes.

- ✅ **4. Ayusin ang stale-shell boot** ("state-shell") — isang always-on display ay nag-boot sa
  **lumang code** na may TDZ bug habang ang SW cache ay may **naayos** nang kopya:
  `runningCodeHasBuggyConst: true` at `cachedIndexHasFix: true` sa parehong page load. Ang SWR ay
  naghahatid ng cached shell at iniimbak ang bago para sa *susunod* na load, kaya ang isang fix ay
  maaaring mabulok sa cache ng isang 24/7 na display at manatili roon hangga't walang ikalawang load.
  **Gawin:** ang install ay may `skipWaiting()` + `clients.claim()` na; kailangan ang isang
  **kontroladong isahang reload kapag may bagong worker**, o gawing network-first ang shell na may
  cache fallback (laging online ang display). **Tsek:** pagkatapos i-edit ang `index.html`,
  **isang** reload lang ang magpapakita ng bagong code. **Walang backend change.**
  **RESULTA:** ang **navigation (`index.html`) ay network-first** na, cache fallback kapag offline,
  at **isang** kontroladong reload sa `controllerchange` kapag may bagong worker. Sinukat: isang
  load lang at naka-live na ang binagong `index.html` (dating kailangan ng dalawa).
  **Nahuli habang vine-verify:** ang version guard ay nag-clear at nag-re-register ng worker sa
  *bawat* load habang hinihintay ang "App Update Available" click — kung magre-reload din tayo
  doon, **mag-loop** ito. Kaya nilalaktawan ang reload kapag nakabukas ang overlay, at kapag
  first install (walang dating worker na pinapalitan).

- ✅ **5. (bagong nahanap na butas) NODE ay nagre-render ng limang sheet value bilang raw HTML** —
  `province`, `impact`, `DT cause`, `downtime`, `aging` ay direktang pumapasok sa `innerHTML`
  (`node-module.js:92,95,98,113,120`) habang ang node chips sa tabi nila ay sanitized. Reproduced:
  ang `<img src=x onerror=…>` ay **buhay ang `onerror`** sa lumang path; tanggal na ngayon.
  Hindi ginalaw ang raw value na pumapasok sa details modal, kaya raw text pa rin ang modal.

> **Hindi dapat galawin:** ang API responses ay `Cache-Control: no-store` — tama iyon, at doon
> nakasalalay ang in-memory `dataCache`. Huwag itong baguhin bilang "optimization".

---
## 🟢 Later

- ⬜ **P2** remove the plaintext password from `netpulse_remember`
- ⬜ **P2** salt + iterate password hashes (`sha256()` is one unsalted round)
- ⬜ **P2** stop the nightly `.xlsx` backup emailing the `Users` sheet
- ⬜ **P3** per-module "last updated" in the UI
- ⬜ Frontend / kiosk tests — still the largest uncovered surface
- ✅ Login boot no longer makes two sequential round trips: the maintenance check and the login run
  in parallel and are reconciled after (measured same-millisecond start, 2255 ms overlap). If
  maintenance wins, the freshly minted session is dropped but saved credentials are kept.
- ⬜ Consider making `isLoggedIn()` re-verify maintenance instead of short-circuiting the check —
  today a session skips it entirely, which is what the parallel-login teardown has to work around.
- ⬜ A visible backend-health / offline indicator, so a throttled Apps Script stops looking like
  an app bug. Measured cold start on this deployment: **36.9s** (warm requests: 1–4s).
- ⬜ Backend test coverage for the six `Extract*` / trigger `.gs` files

---

## ✅ Done

### 2026-09-13 — Session lookup is O(1) per request, not O(stored sessions)
- **The sweep moved off the request path.** `requireSession()` called `pruneExpiredTokens()`
  on every authenticated request, and three routes then read the same token a second time
  through `sessionFromRequest()`. A gated request cost **N + 3** Properties operations
  (**N** = stored `session_*` keys), and Properties read/write is metered at **50,000/day**
  (consumer) while heartbeat alone is **1,440 requests/day per client**. Measured for one
  client at N=26: **41,760 ops/day, 84% of the quota** — and ~8× over with ten clients.
  The symptom would not be slowness but `Service invoked too many times` and a dead app.
- `resolveSession()` now resolves the session **and** the gate decision in one pass;
  `requireSession()` wraps it, and `sessionFromRequest()` is deleted rather than left as a
  second way to do the same read. The sweep runs at login only, and `readSessionToken()`
  still deletes a stale token the moment one is presented, so nothing accumulates.
- **Measured before/after, same harness and same input** (the committed `admin.gs` vs the
  working tree): a gated request went from **N + 3 → a flat 1** read — **−92%** at N=10,
  **−97%** at N=26. Per client per day: **41,760 → 1,440** properties operations
  (**84% → 2.9%** of a 50,000/day quota; ten clients go from ~8× over to 29%).
- `tests/gs-harness.js` now **counts** property reads/writes, and the new `session lookup
  cost` suite pins the constant, proves it does not move from N=1 to N=26, and proves a
  request no longer sweeps while a login does. **98 backend tests, 125 total.**
- **Backend change → needs a redeploy of `admin.gs`.** Also makes the `?type=` gating
  decision cheap instead of expensive — the remaining blocker there is token lifetime, not
  cost (see the optional item in P1 Phase 2).

### 2026-09-13 — Script-order guard, and the kiosk NODE alert state
- **A test for the TDZ class, because it had shipped twice.** `tests/inline-order.js` walks
  every script `index.html` loads in load order, follows the call graph from each top-level
  call, and reports a top-level `const`/`let`/`class` read before it initialises.
  `tests/inline-order.test.js` has 18 tests — and the two that matter most re-introduce **each
  historical bug in its real shape** (`cache-control.js`'s guard removed; the late
  skeleton const restored) and fail if the checker stops seeing them. Two machinery gaps
  surfaced while writing them and are fixed: an IIFE body was being measured from the wrong
  depth (so **every** function in `cache-control.js` was invisible — the whole file went
  unanalysed), and a read that only happens *after an `await`* was reported, which would have
  been a false positive on the app's most common boot shape. Declarations are now collected
  across all scripts, not just the caller's, so the not-yet-loaded-script case is reachable.
- **Kiosk NODE slide now has a real alert state.** A single node-down incident used to draw one
  list row at the top of an otherwise blank wall display, and showed only the *province* — the
  node name was never displayed at all. Now: a summary band, a spotlight card for one incident
  (node name as the headline), and the shared DOWN-OLT card grid for several. `-` cells render
  as a neutral `—`, and SA/NSA is a chip instead of the largest number on the slide.

### 2026-09-13 — Module skeletons, and the `404` diagnosis
- **Skeleton loading for all five modules, through one mechanism.** In-place: shimmer
  rows in the module's real tbody, a placeholder in place of each number. Column
  counts come from each table's own `<thead>`, so the two LCP tables draw 6 and 5
  cells per row respectively while NAP/NODE/BACKBONE draw 6/7/7. Export buttons are
  held back until there is data to export.
- **The whole-tab skeleton was deleted, not kept alongside.** `getSkeletonHTML` /
  `showSkeleton` swapped a tab for a fake div-table whose header and columns had
  nothing to do with the real one, and it was unusable on NAP/LCP/OLT (their markup
  is static in `index.html`, so a swap deletes it for good). NODE and BACKBONE used
  it only because they build their entire tab; their renderers now emit a shell
  (`nodeTableShellHtml` / `backboneShellHtml`) and fill its tbody instead. The
  fake-table CSS (`.skeleton-container`, `.skeleton-stats`, `.skeleton-table-card`,
  `.skeleton-row`, `.skeleton-cell*`, `.skeleton-donut`) went with it — verified
  unreferenced before deleting.
- **The intermittent `404` on `?type=` is Google-side, not configuration.**
  Reproduced deliberately — 1 failure in 20 rapid sequential requests, with a
  `200` on the immediate retry. Then ~250 follow-up requests, including a 60-way
  parallel burst, all returned `200`. Ruled out with evidence: CORS (both hops
  carry `Access-Control-Allow-Origin: *`, even with an `Origin` header), a cached
  `302` (it is `no-cache, no-store`), our code (the identical URL succeeds a second
  later), and the service worker (it can only synthesise 503/504, never 404).
  `404` retries widened to the caller's full budget, and a failure now names the
  hop that broke so the next occurrence is diagnosable.
- **A TDZ bug I introduced, caught on the real boot path** — see Notes.

### 2026-09-12 — Backend test harness (`tests/`)
59 tests, browser-free. See `tests/README.md` and `changelogs.md`.

### 2026-09-12 — P1 Phase 1: session tokens (accept-if-present)
`admin.gs` + `code.gs` + `index.html` + `admin-module.js`, 26 new tests, all
mutation-checked. Deployed and verified live the same day: a real login issued a
token, a role-gated route accepted it, and the heartbeat's raw fetch carried it.

### 2026-09-12 — Client reliability (SW + heartbeat)
Three client-side defects found while diagnosing a reported "CORS error" + slow login:
- Service worker's API passthrough had no `catch`, so a stalled/throttled response surfaced as an
  unhandled `Failed to fetch` that read like a CORS misconfiguration. Now a clean synthetic 503.
- `sw.js` could sit dormant for up to 24h (browser's per-navigation update throttle), keeping an
  old `admin-module.js` alive. `index.html` now calls `reg.update()` on every load.
- The heartbeat never stopped on a refused session — it beat every 60s forever against a
  throttling backend. Now it stops; a re-login restarts it.

### 2026-09-12 — P1 Phase 2: enforce
`REQUIRE_SESSION = true`; `?admin=` removed from the client **and** the server
fallback deleted, so `UpdatedBy` has exactly one source. 87 tests, mutation-checked
(turning the switch off, restoring the forgeable actor, or re-trusting the URL in
heartbeat each fail the suite). **Backend change: needs a redeploy.** Docs:
`GVSI_NetPulse_Auth_Notes.md`. See `changelogs.md` → Unreleased.

---

## 🔎 Notes & findings

- **The logout cleanup in `admin-module.js` (lines 494–520) was dead code.**
  `admin-module.js` loads at `index.html:717`, but `handleLogout` is declared in
  the *later* inline script at `index.html:1471`. At admin-module load time
  `typeof handleLogout === 'undefined'`, so the override never installed,
  `_originalHandleLogout` stayed `null`, and `adminHandleLogout()` was
  referenced nowhere. `?action=removeActiveUser` had **never** fired on logout —
  the 5-minute staleness prune in `handleGetActiveUsers` was doing the cleanup.
  Fixed by folding that intent into the `handleLogout` that really runs.
- **This is not a full auth system.** All `?type=` reads stay open, so anyone
  with the deployment URL can still read outage data. The token also travels in
  the query string (Apps Script only exposes `e.parameter`, and a JSON POST body
  triggers a CORS preflight the deployment does not answer), so it can surface
  in browser history / `Referer`.
  **Verified live 2026-09-13:** a tokenless `?action=heartbeat` answers
  `"Sign-in required"`, while **tokenless `?type=olt&shape=2` returns the whole
   461-row payload**. The Pages site is public and `BASE_API_URL` ships in the
  client, so the URL is not a secret — this is readable by anyone who loads the
  page. `code.gs` contains no reference to `token` at all; the gate lives in
  `admin.gs` and covers only the four `action=` routes.
- **A top-level `const` in the big inline script of `index.html` is a live trap**
  — now guarded by `tests/inline-order.test.js` (see Done), but worth
  understanding before adding one. The boot path runs from a statement *further
  up the same script* than the helpers declared near the bottom: the
  `loadInitialData()` → `fetchNapData()` chain is invoked around line 1249 while
  `const` tables declared near the skeleton helpers sit at ~1360, so at first
  paint they are still in their temporal dead zone and the module throws
  `Cannot access '…' before initialization`. It breaks **only** on a real boot —
  calling the same function from the console afterwards works fine, which is
  exactly how it survives manual testing. This bit the module-skeleton table and
  had already bit `dataCache` in `checkAppVersion()`. Declare such a table inside
  the function that reads it, or wrap the lookup the way `cache-control.js` wraps
  `dataCache`. The guard covers: same-script reads, cross-file reads, property
  calls into an IIFE-wrapped file, and declarations in a script that has not been
  evaluated yet. It does **not** cover computed keys or a name mentioned only in
  an arrow that is never called.
- **Anything new that lands in `PropertiesService` needs a prefix and a prune
  rule**, or it accumulates the way the oversized-payload cache once did — **and
  the prune has to sit somewhere rare.** It ran inside the session gate, i.e. on
  every authenticated request, which put an O(stored sessions) sweep on the
  busiest path in the app against a **metered daily quota** (`Properties
  read/write`, 50,000/day consumer). A heartbeat alone is 1,440 requests/day per
  client, so at 26 stored sessions one client burned **41,760 operations/day —
  84% of the quota** — and ten clients would be ~8× over. The symptom is not
  slowness, it is `Service invoked too many times` and a dead app. **Rule: a
  prune belongs on a rare path (login), and the request path should cost O(1).**
- **A `controllerchange` reload and the version guard fight each other.** The guard clears every
  worker and cache on each load while it waits for the user to press *Refresh & Sync*, then
  re-registers — so a new worker claims the page on *every* load in that state. A reload hooked
  to `controllerchange` therefore loops. The handler now skips when `#updateOverlay` is present
  and when no worker controlled the page at load. **Any future reload-on-update logic has to
  account for that guard.**
- **Refresh cadence has two separate clocks.** The `loadInitialData()` timers (NAP 60m … NODE 10m)
  are forced refreshes; `shouldRevalidate()` in `cache-control.js` is a 60s floor on everything
  the UI triggers (tab clicks, kiosk rotations). A cache hit inside the floor renders and returns
  **without** a network call — expected, not a bug, and `netpulseCache.revalidateState()` shows
  the countdown before you go hunting.
