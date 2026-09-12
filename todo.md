# GVSI NetPulse — TODO

Live work board. `changelogs.md` records what shipped; this records what is
next and what is in flight. `GVSI_NetPulse_System_Roadmap.md` is the older
audit narrative — several of its HIGH findings are already fixed, so treat
this file as the source of truth for outstanding work.

Legend: ⬜ todo · 🔄 in progress · ✅ done · ⏸ blocked
Last updated: 2026-09-13 · Version: 3.9.0 · Backend suite: 87/87, script-order suite: 18/18 (105 total)

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
  rule**, or it accumulates the way the oversized-payload cache once did.
