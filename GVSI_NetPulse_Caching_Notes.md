# GVSI NetPulse — Caching Notes

There are **five** places data can sit between the Google Sheet and the screen. When something
looks stale (or refuses to update), it is almost always one of these. Read this before changing
anything that fetches, stores, or serves data.

---

## The layers, in the order a request passes through

```
Google Sheet
  └─ Apps Script (server)        CacheService          TTL 60s / 180s
       │                         PropertiesService     same TTL, hand-stamped
       │                                               (payloads >90KB only)
       ├─ network (HTTPS)
       │    └─ Service Worker    shell cache           SWR per asset; navigations
       │                                               network-first; API never cached
       │         └─ HTTP cache   browser, per-URL      bypassed with cache:'no-store'
       │              └─ fetchWithRetry()              in-flight de-dupe; the backoff is
       │                                               scaled by the stall the attempt
       │                                               measured, behind one shared gate
       │                                               (not a cache — see the Reliability
       │                                               entry in changelogs.md)
       │                   └─ dataCache                in memory, per session, never auto-expires
       │                        └─ renderers           admin tables + kiosk slides
       └─ IndexedDB              netpulse-db/snapshots one row per day, 90-day retention
```

## Who owns what

| Layer | Lives in | Lifetime | Invalidated by |
|---|---|---|---|
| **Apps Script cache** | `code.gs` (`CacheService`) | **60s** for `olt`/`node`/`backbone`, **180s** for `nap`/`lcp` | TTL only |
| **Apps Script fallback** | `code.gs` (`PropertiesService`) | same TTL as above, **enforced by hand** | TTL check on read (the entry is deleted when it expires) |
| **Service worker shell cache** | `sw.js`, cache name `gvsi-shell-v*` | until revalidated | SWR per asset (refreshed on every load); **navigations network-first** |
| **HTTP cache** | browser | server-dependent | bypassed by `cache: 'no-store'` / `'no-cache'` |
| **`dataCache`** | `index.html` (`const dataCache`) | the tab's lifetime | only when a fetcher writes it |
| **IndexedDB** | `db.js`, DB `netpulse-db`, store `snapshots` | 90 days | daily cleanup on save, `clearIndexedDB()` for the whole DB, or `rebuildTrendDay()` / `dropTrendDay(date)` for one record (note 8) |
| *(`localStorage`)* | — | until cleared | prefs only, **not** a data cache |

---

## One entry point: `netpulseCache`

`cache-control.js` is the single documented way to inspect and clear the layers. Use it instead
of clearing things by hand in five places:

```js
await netpulseCache.status()            // what is held where, layer by layer
netpulseCache.revalidateState()         // why a module is (not) re-fetching right now
await netpulseCache.payloadHeadroom()   // each module's size vs the 90 KB / 450 KB limits
await netpulseCache.invalidateAll()     // SAFE clear: dataCache + shell cache
await netpulseCache.invalidateAll({ indexedDB: true, storage: true })  // + destructive layers
await netpulseCache.clearEverything()   // all of the above + SW unregister + reload
```

`payloadHeadroom()` mirrors the thresholds in `code.gs` and measures by re-serializing the
parsed payload, which reproduces the backend's `JSON.stringify(resultData).length` **exactly**
(verified byte-for-byte against all five live endpoints). Keep the two in step if the limits
ever move.

It is **safe by default**: `indexedDB` and `storage` are opt-in, because clearing IndexedDB
throws away 90 days of trend history and clearing storage logs the user out. Only prefs
(`theme`, `netpulse_*`) are preserved by `clearStorage()`.

The same entry point is exposed in the app itself: **Admin Panel → Cache & Data Sync** shows this
report per layer ("Held now" live, "Last clear" recording what was removed) with a
**Clear Cache & Resync** button, so a support tech can see which layer was holding stale data
without opening devtools. It calls the *safe* default only — trend history and the login are
never touched.

What each layer answers to:

| Layer | Cleared by the entry point? |
|---|---|
| 1. Apps Script cache | **No.** There is no server-side auth to guard a purge endpoint, so it is deliberately not client-clearable. It is TTL-bound and self-heals within 180s. |
| 2. IndexedDB | Yes, opt-in (`indexedDB: true`). Destructive. |
| 3. Service worker / shell cache | Yes. The registration itself needs `serviceWorker: true`. |
| 4. HTTP cache | Not directly — it is bypassed by the SW on revalidate. |
| 5. `dataCache` | Yes, always (it is free and safe). |

---

## The eleven things that bite

1. **The service worker must never cache API responses.** `script.google.com` returns early in
   the `fetch` handler. **Do not move that branch below the static-asset branch** — the app
   would start serving frozen outage data.

2. **`dataCache` never expires on its own.** It is replaced only when a module fetcher writes
   it. A tab left open keeps showing what it last received, which is why a tab can look stale
   while a fresh reload looks correct.

3. **Two independent clocks decide how old the data looks:** the Apps Script TTL (60s/180s) and
   `dataCache`. Refresh cadence is per module in `loadInitialData()` — NAP 60m, LCP 30m,
   OLT 15m, NODE 10m, BACKBONE 10m — plus kiosk re-pulling the visible slide every 60s.

   Those intervals are **not** the same clock as the revalidation throttle. Every module's
   cache-hit path re-renders from memory and then re-fetches in the background, so any UI event
   that calls a fetcher (a tab click, a kiosk rotation) asks for a refresh. `shouldRevalidate()`
   in `cache-control.js` caps that at **once per module per minute**; the `loadInitialData()`
   timers pass `forceRefresh`, skip the cache-hit path, and call `markRevalidated()` so the
   window restarts from their fetch. `netpulseCache.revalidateState()` shows the countdown.

   Keep this in mind when reading a module: a cache hit inside the window renders and returns
   **without** a network call, and that is correct — not a bug, and not the reason data looks
   old.

4. **The `PropertiesService` fallback has no native TTL, so we stamp and expire it by hand.**
   Payloads over ~90 KB (too big for `CacheService`) are stored there with a
   `cache_v2_<type>_cached_at` timestamp. The read path treats anything older than the type's
   TTL as expired, deletes both keys and falls through to a fresh sheet read. **A missing stamp
   counts as expired**, so a legacy entry written before this existed can never be served
   indefinitely.

   **Watch the headroom — and mind which size you are reading.** For OLT the number
   the client can compute (re-serializing `dataCache.olt`) is the size of the *decoded*
   rows, **not** what the server measured and cached. Since `shape=2` the server sees
   **26,304 bytes** where the client's re-serialization still shows ~50,179, so
   **Admin Panel → Payload Size Headroom** over-reports OLT by roughly 2x. The thresholds
   below are the server's, so treat that row as a conservative upper bound, not a
   mirror. The other four modules have no wire encoding and are exact.

   Measured live, the sizes are far from the line except for OLT:
   NAP 837 B · LCP 378 B · **OLT 50,056 B (55.6% of the 90 KB limit, 39.9 KB headroom)** ·
   NODE 2 B · BACKBONE 1,627 B. OLT is the only module that could plausibly cross, and
   crossing is a silent change of route, not an error. **Admin Panel → Payload Size Headroom**
   shows this per module (with `netpulseCache.payloadHeadroom()` underneath), so you can see
   it coming rather than discover it. Past 90 KB a module moves onto the fallback above;
   past 450 KB it stops being cached at all and every request re-reads the sheet.

   If you ever add another `PropertiesService` cache, it needs the same treatment — there is
   still no native expiry.

5. **The `?v=` query on an asset is its per-file cache key.** Editing a file without bumping
   its token can leave the old copy in play. This is the first suspect when "my change didn't
   apply".

   `sw.js` carries `ASSET_VERSION`, which **must stay in step with those tokens**. The precache
   has to warm the *same keys the page requests*: caching `./nap-module.js` while the page asks
   for `./nap-module.js?v=3.9.0` stores a copy nobody ever reads and quietly leaves the offline
   shell depending on SWR alone. `pruneStaleAssets()` on `activate` removes the stale variants.

6. **A versioned asset lands on its own; the shell lands immediately.** Assets are
   stale-while-revalidate: load N serves the previous copy instantly and stores the new one,
   load N+1 serves the new one — no cache-name bump needed, and the `?v=` token covers a
   release that wants it on the current load.

   `index.html` is **not** SWR: navigations are network-first with the cached shell as the
   offline fallback. SWR was wrong for the one file with no `?v=` token to key on, and a wall
   display can go days without a second load — measured on the display, the running page had a
   build whose fix was already in the cache, waiting for a reload that never came. With
   network-first, an edit to `index.html` is live on the **first** load, no reload needed.

   A **new worker** is a separate case and still needs one reload, because
   `skipWaiting()`/`clients.claim()` put it in charge of a page that has already loaded its JS.
   `index.html` therefore reloads **once** on `controllerchange`, but only when a worker was
   already controlling the page (a first install has nothing older to replace) and only when the
   version-guard overlay is *not* up — that guard clears and re-registers the worker on every
   load while it waits for the user, so reloading there as well would loop.

7. **`sw.js` does not update on its own — it is the one asset SWR cannot fix.** The browser
   re-checks a service worker script on a *navigation* at most once every 24 hours, and the
   registration URL (`./sw.js?v=3.9.0`) no longer changes now that we stopped bumping versions.
   So a fix to the worker itself can sit dormant for a day while every app asset updates
   normally — which is how a client ends up running an old `admin-module.js` long after the fix
   shipped. `index.html` therefore calls `reg.update()` on every load, which bypasses the 24h
   throttle (the update fetch also bypasses the HTTP cache and the old worker), and the worker's
   own `skipWaiting()` / `clients.claim()` promote it, and `index.html` turns the takeover into
   one automatic reload (see note 6). Before that reload existed the page kept running its
   already-loaded JS no matter how new the worker was. If you change `sw.js` and it does not
   appear to take effect, it is this — not the HTTP cache.

   **Observed while adding the reload:** with a worker already controlling the page, the
   replacement sat in `waiting` (state `installed`) for as long as the page stayed open, and only
   activated on the next load — so a change to `sw.js` can land one load later than you expect.
   `clients.claim()` then fires `controllerchange`, and the reload in note 6 brings the new code
   in with no human involved. If you are chasing a worker change that "did not apply", check
   `registration.waiting` before assuming the file is not being served.

8. **IndexedDB is a history store, not a read cache.** Clearing it loses trend charts and
   snapshots, not live data. Nothing on the live path reads from it.

   Because of that, `clearIndexedDB()` is the wrong tool for one bad record — it costs all 90
   days to fix a single day. Use the narrow one instead:

   ```js
   await netpulseCache.auditTrendHistory()        // which days look incomplete, and why
   await netpulseCache.rebuildTrendDay()          // TODAY only: drop and rewrite from the caches
   await netpulseCache.dropTrendDay('2026-08-25') // a past day: remove it, leaving an honest gap
   ```

   **A record can never be repaired in place.** `saveDailySnapshot()` keeps the FIRST record of
   each day, so a day written from an incomplete load stays wrong until its record is removed.
   That is also why `rebuildTrendDay()` refuses any date that is not today: a snapshot is built
   from the live module caches, which hold *now*, so rewriting an old date would delete that day
   and write today's numbers over it. For a past day the only honest choices are to leave it or
   to drop it — a gap reads as "no data" where a false zero reads as "the network was fine".

9. **Precache-only assets have no SWR path, so they need `STATIC_CACHE` bumped.** The icons and
   `manifest.json` are warmed by the `install` handler; the page never requests them, so
   stale-while-revalidate never touches them and an edit can sit in the cache forever. They only
   refresh when a worker installs, and an install only happens when `sw.js`'s own bytes change —
   which is why the icons were re-encoded alongside a `STATIC_CACHE` bump to `v3.9.5`. Bumping
   costs nothing extra (`install` re-adds every entry either way) and lets `activate` drop the
   old copy in one step.

10. **A live IDB connection blocks deletion, so release it first.** `db.js` caches one shared
   connection in `dbPromise` and closes it on `versionchange`; `closeDB()` releases it on demand.
   `netpulseCache.clearIndexedDB()` calls `closeDB()` before deleting for exactly this reason.
   Do **not** reintroduce a raw `indexedDB.deleteDatabase()` — while a connection is held the
   request can sit pending with no `success`, `error` *or* `blocked` event, and the caller hangs
   forever. The entry point also carries a 6s timeout as a backstop.

11. **`shape=` is a cache key, not just a hint.** `cache_v2_olt` and `cache_v2_olt_c2` hold
   the legacy and compact OLT payloads separately, and both sit under the `cache_v2_`
   prefix the admin prune and `payloadHeadroom()` key off. The cache is consulted *before*
   `shape` is, so one shared key would serve whichever payload was cached first to
   whoever asks next. Add a shape, add its own key.

---

## Debugging "why is it stale?"

| Symptom | Suspect | Check |
|---|---|---|
| Everything is old, everywhere, even a hard reload | Apps Script cache | `curl` the endpoint directly and compare |
| One file/asset is old, the rest are fine | `?v=` token / HTTP cache | Look at the token in `index.html` |
| Only a long-open tab is old | `dataCache` | Compare against a fresh reload |
| Data updates, then freezes for good | `PropertiesService` fallback | Should no longer happen — it is TTL-stamped now. Look for a missing `_cached_at` key |
| A versioned asset is a load behind | normal SWR | Expected — see note 6 (that is what `?v=` is for) |
| An **icon** is old, everything else is fine | precache-only asset | `STATIC_CACHE` was not bumped — see note 9 |
| A module stops refreshing as often as it used to | revalidation throttle | Expected, up to 1/min/module — see note 3 |
| `deleteDatabase` never returns | a held IDB connection | Use `netpulseCache.clearIndexedDB()`; it releases the connection first (note 10) |

`dataCache` is in-memory only, so **a hard reload always clears it** and is the fastest way to
rule it out.

---

## Checking the backend without deploying

The server-side layers described above are covered by an offline test harness. It runs the real
`code.gs` and `admin.gs` in a Node `vm` against faked Google services, so routing and every cache
path can be checked in seconds instead of by redeploying:

```bash
node --test
```

It asserts the things that are easy to get wrong here: the per-type TTLs (60s vs 180s), the
`PropertiesService` overflow threshold and its hand-rolled expiry (including the unstamped
legacy entry), and that a cache hit never re-reads a sheet. The fakes reproduce the details that
hide bugs — `computeDigest` returns **signed** bytes, empty cells read as `''`, and both
`CacheService` and the clock are controllable. See `tests/README.md`, including its list of
what the harness deliberately does *not* cover.
