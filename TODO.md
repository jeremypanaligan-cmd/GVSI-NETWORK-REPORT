# 📌 NetPulse — Live Work List

**This is the current, ordered queue of work** — not an audit. Read it top-down; P1 is next.

**Last updated:** September 18, 2026 · after v3.9.8 (`872e923`, live on `main`)

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

### ⚠️ Delivery condition — this has flipped since planning

When this was planned, `origin/main` was `b0c6563` (`gvsi-shell-v3.9.7`) and v3.9.8 was unpublished, so no generation bump was needed.

**v3.9.8 is now published** (`872e923` is live on `main`; the deployed `sw.js` reads `gvsi-shell-v3.9.8`). Devices therefore hold that generation. `index.html`, `fetch-gate.js`, and the new `cache-store.js` are all **unversioned precache entries**, so:

> **This change MUST move the cache generation to `gvsi-shell-v3.9.9`** — with the label and `?v=` tokens to match. Without it, `install` never re-runs, `activate` never evicts, and installed devices keep the old bytes forever while the repo says otherwise.

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

1. Paste the current `triggers.gs` (and `olt-cache-warmer.gs`, `code.gs` if not already done).
2. Run **`listTriggers()` first** — read-only drift report.
3. Then run `setupAllTriggers()`.

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

## ❓ Open question — OLT UP rows

**Unanswered:** *"If we bring back the UP rows in the OLT module, will it slow the OLT module's data load?"* — the turn investigating this was interrupted.

The relevant measurement is already in hand:

| shape | payload |
|---|---|
| `shape=3` (problem-only, what the app uses) | **643 B** |
| `shape=1` (legacy, all 461 rows) | **50,137 B** |

~78×, and 50 KB is close to the 90 KB CacheService threshold that `code.gs` guards with a `PropertiesService` fallback. What is **not** yet established is the client-side cost of rendering 461 rows versus the ~4 problem rows. Answer that before re-enabling UP rows.

---

## ✅ Verified as already landed (checked Sept 18, 2026)

Confirmed in the code during this session, so the roadmap's items for these are **done** — do not re-execute them blindly:

- **CacheService 100 KB overflow** (roadmap 1.1) — mitigated: `shape=3` cuts OLT to 643 B, and `code.gs` keeps a `PropertiesService` fallback with an explicit staleness stamp.
- **`performLogin()` extraction** (roadmap 1.5) — done; `handleLogin` calls `await performLogin(username, password, rememberMe)` (`index.html:1636`).
- **Hardcoded column indexes** (roadmap 2.1) — done; `COL` constants exist at the top of `code.gs`.
- **No time-driven triggers** (roadmap 3.1) — the mechanism now exists (`TRIGGER_PLAN` + `setupAllTriggers()` + `listTriggers()` in `triggers.gs`, plus `warmOltCache`). **The live installation is still outstanding — see P2.**

**Every other roadmap item needs re-checking** before it is treated as open. That audit is 3+ weeks and several releases old.
