# Run doc — GVSI NetPulse (local preview)

A static PWA shell. The server only has to serve this directory over HTTP.

## 1. Reproduce the artifacts a fresh checkout needs

**Nothing is required to run the app.** There is no env file and no build step in the
serving path.

- No `.env*`. The deployment URL is inline in `index.html` (`window.APPS_SCRIPT_URL`),
  and `window.NETPULSE_PROXY` is deliberately blank while the Cloudflare worker is off.
- `index.html` loads `styles.css`, `lucide-icons.js` and every module script by name.

One generated file IS committed — `lucide-icons.js`, the tree-shaken Lucide subset the
icons are drawn from. It needs rebuilding only when the icon list changes or the package
is upgraded, and `node_modules` exists only for that:

```bash
npm install                 # lucide is a build-time dependency; node_modules/ is gitignored
node scripts/build-icons.mjs --check   # exit 1 if the committed file drifted
node scripts/build-icons.mjs           # rewrite it (npm run icons:build)
```

Running the app does **not** require `npm install`: the generated file is committed and
precached, so a fresh clone is already runnable. (`plannable/` is a separate, unbuilt npm
package and is not needed either.)

## 2. Run the server

Port **8080** is the project's own default (`serve-local.py`) and it was free.
This is the recipe that actually works on this machine (Windows, Git Bash):

```bash
powershell -NoProfile -Command "(Start-Process -FilePath 'C:\Users\Jeremy Panaligan\AppData\Local\Python\pythoncore-3.14-64\python.exe' -ArgumentList '-m','http.server','8080','--bind','127.0.0.1' -WorkingDirectory 'C:\Users\Jeremy Panaligan\Documents\GitHub\GVSI NETWORK REPORT' -RedirectStandardOutput '<LOG>' -RedirectStandardError '<LOG>.err' -WindowStyle Hidden -PassThru).Id"
```

It prints the pid. Confirm it survived, then confirm the URL answers:

```bash
powershell -NoProfile -Command "Get-Process -Id <pid>"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/index.html
```

Two mistakes the first attempt made, recorded so they are not repeated:

- **Use `-WorkingDirectory`, do not pass `--directory`.** `Start-Process -ArgumentList`
  joins its array with spaces and does **not** re-quote, so a path containing a space
  (`...\Jeremy Panaligan\...`) arrives as two arguments and the server exits with
  `unrecognized arguments: Panaligan\Documents\GitHub\GVSI NETWORK REPORT`.
- **`serve-local.py` is not the launcher.** It crashes on a cp1252 console
  (`UnicodeEncodeError` from its emoji `print()`, already logged as TODO.md P3).
  `python -m http.server` is the substitute. It needs no CORS header: the app calls
  Apps Script cross-origin, and Google answers for itself.

## 3. The one thing that makes the preview look stale

`sw.js` is **cache-first** for the entire shell, and its precache list holds the
UNVERSIONED names the page requests (`olt-module.js`, `styles.css`). Delivery therefore
depends on the release label or the cache generation moving together with the bytes — a
rule `sw.js`'s own header states. An edit that lands without that move keeps serving the
old bytes out of `gvsi-shell-v*` on every reload.

**The browser's own HTTP cache can lie first, before the worker gets a chance to.**
`python -m http.server` sends no `Cache-Control`, so the browser applies heuristic freshness and
may answer a plain reload of `index.html` with the PRE-EDIT copy — observed on a first load of a
fresh port, where the served file and the rendered DOM disagreed (the DOM still had
`oltCardClientsDown` while the server was returning `oltCardClientsSA`). Clearing the worker does
not clear that. Navigate once to the same page with a query string (`index.html?fresh=1`) — a
different URL, so the HTTP cache has nothing to answer with — and the reload is real.

The VERSIONED asset URLs are the sticky half of this. Measured on 2026-09-21: after the worker
was cleared, `olt-module.js` (unversioned) came back fresh while `styles.css?v=3.9.18` was still
answered from the browser's own HTTP cache — new markup, old stylesheet, which reads as "my CSS
change did nothing". One call fixes the entry, from a page whose worker no longer serves it:

```js
await fetch('styles.css?v=3.9.18', { cache: 'reload' });   // then navigate with ?something
```

Clear it in the preview **before reloading after an edit**:

```js
(await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
(await caches.keys()).forEach(k => caches.delete(k));
```

The next load re-fetches every asset from disk and re-precaches the NEW bytes, so this is
a per-edit step, not a permanent one.

This bites a NEW file hardest: a generation a device already holds has no
`lucide-icons.js` in its precache, so between an edit and the release that moves the label,
the page asks for a file the worker cannot answer from cache. Both a stale and a missing
answer are why the label has to move in the same commit as the bytes.

Where it bites, measured: the page asks for `styles.css?v=3.9.13`, and that VERSIONED URL is the
one the worker answers cache-first and re-caches, while `install` refreshes the UNVERSIONED
precache entry (`styles.css`). On a plain reload of an edited tree this was observed as
`transferSize: 0`, 454 rules, no `.olt-empty-*` selectors — with the 466-rule copy on disk.
Clearing caches and reloading can land the stale HTTP-cached response back into the worker, so if
the page still looks old after a clear, hard-reload it (Ctrl+Shift+R).

## 4. What the preview shows

The app boots to its **login gate**. No credentials are used or needed here.

On a brand-new browser profile it first shows the app's own *"App Update Available /
Refresh & Sync App"* overlay: `checkAppVersion()` compares `localStorage.app_version`
against `REQUIRED_APP_VERSION` (`3.10.0`), and a fresh profile has no such key. One tap
on its button clears it and reloads. That is first-visit behavior of the app itself, not
a fault introduced by the preview.

## 5. Checking a responsive rule without resizing the window

The preview viewport cannot be resized from a script, so a narrow-layout claim has to be
measured by constraining the element instead. Inject the constraint, measure, then remove
it — and **use `width`, not `max-width`**: on 2026-09-21 `max-width: 336px !important` left
the grid box at 336px while its three `1fr` tracks stayed at their desktop 258px, so the
tiles overflowed the grid and the probe measured a layout no phone has. `width` moved the
tracks to 106.7px, which is what a 360px viewport produces.

```js
const st = document.createElement('style');
st.textContent = '.olt-stats-grid { width: 336px !important; }';
document.head.appendChild(st);
// ...measure with getBoundingClientRect and Range.getClientRects()...
document.head.removeChild(st);
```

Two things worth measuring this way, because a box that is *tall enough* hides both: the
number of LINE BOXES a label actually takes (`document.createRange().selectNodeContents(el)`
then `.getClientRects().length` — a fixed `min-height` makes every label the same height
whether it wrapped or not, so height alone cannot tell you), and whether a label **escapes
its tile** (compare the label's rect against the tile's, left and right).

Note that the app's own tab switching lives on `switchTab('olt')`, and a background refresh
can paint another tab back over your measurement — re-check which tab is active immediately
before taking a screenshot, not once at the start.

### 5.1 Refreshing an UNVERSIONED module (the one that cost three reload cycles)

`index.html` loads the modules by bare name — `<script src="analytics-module.js"></script>`, no
`?v=`. So for those files the browser's HTTP cache is what answers the page, and **clearing the
worker does not clear it**. Observed on 2026-09-21 while removing the Analytics trend charts: with
the worker unregistered, every cache deleted, and a fresh query-string navigation, the page still
executed the PREVIOUS `analytics-module.js` after the file on disk had changed — because the
navigation's own script requests were served from the HTTP cache, while the worker's cache (whose
`install` uses `cache: 'reload'`) already held the new bytes. Every probe of "what will this load"
answered *new* and lied about what the page had actually run.

Refresh the modules themselves, then navigate:

```js
for (const m of ['analytics-module.js', 'olt-module.js', 'nap-module.js', 'db.js', 'index.html']) {
  await fetch('/' + m, { cache: 'reload' });
}
// then navigate to index.html?something-else
```

The bulletproof cross-check is a **second origin**. `localhost:8080` and `127.0.0.1:8080` are
separate origins, so the second one has no worker registration, no cache generation and no HTTP
cache entries for this app — it loads the working tree as it is on disk, immediately. Use it to
confirm a change before spending more cycles on the first origin. (Cost of the trick: a fresh
origin has no session, so it lands on the login gate — fine for DOM measurements like "is this
section gone", not for screenshots of a dashboard.)

## 6. Proving a release reaches an installed shell (the service-worker E2E)

Run on 2026-09-22 to verify the update trigger. Nothing in the repo is edited: the "publish" is a
single line in a throwaway copy.

```bash
# 1. The shell has to be served from a SUB-PATH so its worker gets its own scope.
rm -rf _e2e && mkdir -p _e2e
cp index.html styles.css lucide-icons.js manifest.json version.json sw.js \
   nap-module.js lcp-module.js olt-module.js node-module.js backbone-module.js \
   analytics-module.js admin-module.js db.js fetch-gate.js rev-watch.js notifications.js \
   icon-192.png icon-512.png apple-touch-icon.png _e2e/
```

Then, in the preview panel:

1. Load `http://127.0.0.1:8080/_e2e/index.html?boot=1` — this installs the worker. It is claimed by
   `clients.claim()` but the page was loaded BEFORE that, so its `hadController` is false and the
auto-reload is not armed yet.
2. Load `...?boot=2` — a controller now exists at script time. **This is the load the test needs.**
3. **Publish**: `sed -i "s/gvsi-shell-v3.9.19/gvsi-shell-E2E-2/" _e2e/sw.js`. The URL does not
change (`sw.js?v=...` — a static server ignores the query, exactly as GitHub Pages does), which is
the point: the same script URL now answers with new bytes, as a real deploy does.
4. **Trigger it with one foreground event**, and skip the 15-minute throttle the way a wall display
   does — by waiting — without waiting:

   ```js
   const realNow = Date.now.bind(Date);
   Date.now = () => realNow() + 20 * 60 * 1000;
   Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
   document.dispatchEvent(new Event('visibilitychange'));
   ```

5. Wait ~5 s, then read the result. Expected: `caches.keys()` has the NEW generation and the old one
   is gone, `performance.getEntriesByType('navigation')[0].type === 'reload'`, the controller is
   `activated`, and `reg.waiting` / `reg.installing` are both null.
6. Cleanup: unregister the `/_e2e/` scope and delete the caches FROM THAT PAGE, then navigate back
   to the root app and `rm -rf _e2e`.

**Two traps, both hit on 2026-09-22:**

- **CacheStorage is per-origin, not per-scope.** The copy's `activate` deletes every cache except
  its own, so publishing it also deleted the root app's `gvsi-shell-*` generation. It heals (the
  cache-first branch re-caches on the next load — verify: 16 entries, `olt-module.js` present,
  exactly one registration), but a clean harness puts the copy on a **second origin**
  (`localhost:8080`) instead, where it cannot touch the app. Cost of that: the preview panel
  drives only the dev server it is attached to, so the second origin has to be driven by hand.
- **`preview_logs` will not show the `sw.js` fetch.** The registration and update fetches are
  browser-internal, so "did the launch ask?" cannot be answered from the network log — that claim
  belongs to `tests/sw-update.test.js`, which counts the calls.

## 7. The Apps Script hand-off (every backend change)

Nothing in a `.gs` file is live until it is pasted into the Apps Script editor, and **there is no
`clasp` in this repo** — `dir /a` finds no `.clasp.json` and no `appsscript.json`. So a backend
change is always: edit the `.gs` here (it is the source of truth and the thing the tests read),
then paste, then run.

The editor's project is **container-bound** to the same spreadsheet the app reads. That is why
`SpreadsheetApp.getActiveSpreadsheet()` appears across eleven `.gs` files, and it is why
`CacheService`, `PropertiesService` and the two invalidation triggers live with the script rather
than with the data — a fact that decides most architecture questions about this backend.

**Syntax-check before pasting.** The extension `.gs` is not something `node --check` accepts, so
copy it (the `.gitignore` already has `_chk.js` for exactly this):

```bash
cp olt-cache-warmer.gs _chk.js && node --check _chk.js && rm _chk.js && echo OK
```

**Order of operations, PART-012 as the example.** Step 2 exists to produce a measurement, and no
trigger is touched until step 4:

1. **Paste** the changed files — PART-012 and PART-013 both change `olt-cache-warmer.gs`;
   PART-012 also needs `triggers.gs`.
2. **Run `warmDataCaches()` by hand.** Nothing but cache entries changes. The editor's execution log
   prints the pass immediately, and this single run is the measurement the interval should come
   from:

   ```
   ✅ warmOltCache: warmed in 3120ms (629 bytes, TTL 180s)
   ✅ warmCache nap: warmed in 1310ms (742 bytes, TTL 180s)
   ✅ warmCache lcp: warmed in 1290ms (512 bytes, TTL 180s)
   ✅ warmCache node: warmed in 1740ms (1980 bytes, TTL 180s)
   ✅ warmCache backbone: warmed in 1660ms (1640 bytes, TTL 180s)
   ✅ warmDataCaches: pass finished in 9120ms — 5 of 5 module(s) rebuilt
   ```

   (Those numbers are **illustrative** — the shape of the lines is the point, and only OLT's build
   time was measured before this ran.) If a type answers with
   `❌ warmCache <type>: the build answered with an error envelope` — or, for OLT,
   `❌ warmOltCache: …`, since every build is judged in the same place — nothing was cached for it
   and the matching `❌ Build failed | type=… | stage=… | sheet="…"` line above it names the sheet.
   A type named under `FAILED:` in the closing line was not rebuilt, whatever the cadence says.
3. **`listTriggers()`** — read-only drift report. PART-012 changed the plan entry from
   `warmOltCache` to `warmDataCaches`, so a live project still showing the old name is expected
   before this step and wrong after it.
4. **`setupAllTriggers()`** — off-peak. It deletes and recreates **every** trigger, including the
   two invalidation handlers, so there are a few seconds with no `onEdit`/`onChange` coverage. It
   validates every handler name before it deletes anything, so a forgotten paste is a no-op rather
   than a trigger wipe.
5. **`listTriggers()` again** — it must say `✅ In sync`.

**Verifying the warming from outside.** A warmed entry must be the bytes an HTTP caller is served,
so compare the two:

```bash
EXEC="https://script.google.com/macros/s/<id>/exec"
for t in nap lcp node backbone; do
  curl -sL "$EXEC?type=$t" -o /dev/null -w "$t %{time_total}s %{size_download}B\n"
done
```

Right after a warm run the byte count must equal what the pass logged, and the time must sit near
the ~1.1 s floor instead of a cold 2–3 s. Two things that look like success and are not: a
`Cache write skipped` line means an edit landed mid-build and **nothing** was cached, and
`⚠️ Sheet not found` means a renamed tab answered `[]` — an empty payload that caches exactly as
happily as a real one.

## 8. The cold window, the bundle and the diagnostics hand-off (Sept 26, 2026)

Four steps, in this order. Each one pays off on its own, so a stop after any of them leaves the live
project better than it was.

### 8.1 Paste `olt-cache-warmer.gs` — thirty seconds, and the 40% is gone

The two warm TTLs are now **330 s** (`OLT_WARM_TTL_SECONDS`, `SECONDARY_WARM_TTL_SECONDS`) against the
**300 s** cadence. Nothing else in that file changed shape, no trigger moved, and
`setupAllTriggers()` is **not** needed.

Run `warmDataCaches()` by hand once and read the log — the TTL printed in it is the proof the paste
landed:

```
✅ warmOltCache: warmed in 3120ms (629 bytes, TTL 330s)
✅ warmDataCaches: pass finished in 9120ms — 5 of 5 module(s) rebuilt
```

Then measure the thing the change is actually about, **from outside and more than once**:

```bash
EXEC="https://script.google.com/macros/s/<id>/exec"
for i in 1 2 3 4 5 6 7 8 9 10; do
  for t in nap lcp node backbone; do
    curl -sL "$EXEC?type=$t" -o /dev/null -w "$t %{time_total}s %{size_download}B\n"
  done
  sleep 30
done
```

A HIT sits near the ~1.1 s floor; a MISS is a cold 2–3 s. Spread over six minutes, count the slow rows:
before this change roughly **40%** of them are (that is the 120 s of every 300 s with no entry at all),
and after it there should be none. **One pair of calls cannot tell you this** — the entire claim is
about timing, and a single sample of a 40% window misses it 60% of the time.

### 8.2 Run the gate before enabling anything

Paste `diagnostics.gs` and `code.gs`, then run this once in the editor:

```
measurePropertyCost()
```

It prints three medians (single `getProperty`, whole-store `getProperties()`, `setProperty`), the share
of the shortest measured build the whole-store read represents, and a verdict. **It has already been
run three times on the live project — 1.9%, 2.7%, 2.9% — so `DIAG_REQUEST_HOOKS_ENABLED` ships
`true`** and the pasted copy is recording; this section stays because the verdict is state-aware and
because a re-run is how you would find out that the store changed:

```
🔬 measurePropertyCost: 30 samples per operation
   single getProperty  median 30ms  (worst 77ms)
   getProperties()     median 38ms  (worst 102ms) — the PESSIMISTIC bound the verdict uses
   setProperty         median 54ms  (worst 119ms)
   the shortest measured cold build is 1290ms, so the whole-store read is 2.9% of one (ceiling 5%)
✅ GATE GO: the whole-store read is 2.9% of a 1290ms cold build (ceiling 5%) and the write median is
   inside its backstop
   → nothing to do: DIAG_REQUEST_HOOKS_ENABLED is already true and the hooks are recording
```

The three runs behind that line — **1.9%** (25/25/51), **2.7%** (35/35/53), **2.9%** (30/38/54),
twenty-five minutes apart on the same store in the same hour — are the whole justification for the 5%
ceiling, and they are read below.

On a copy that has not been flipped yet, the last line reads `→ set DIAG_REQUEST_HOOKS_ENABLED = true`
instead — an instrument that tells you to do a thing you have already done is how a healthy system
teaches an operator to stop reading it.

or

```
❌ GATE NO-GO: <which measurement failed, and by how much>
   → do NOT enable the request-path hooks: a read that costs this much of a build is not a fraction of
     one, so the pass record and this report are the whole diagnostic
```

**The verdict is the SHARE, not the milliseconds, and that is a correction rather than a preference.**
The first version of this compared the medians against absolute numbers (20 ms, 50 ms) and came back
NO-GO on a live store whose whole-store read was **1.9%** of a build — while printing a reason that
said the measurement "is not a fraction of a build". Those lines were above and below each other in
the same log. What the design needs is not "PropertiesService is fast" but "a read is negligible
against a build", and only the share answers that. The write keeps an absolute backstop because a
write happens on a rare path rather than per read; the numbers above are pinned by a test, so a future
run that fails them means the gate was mis-set, not that the store got slower.

**Three runs chose the ceiling, and the third corrected a claim.** Run 1 read 25/25/51 ms; run 2,
nine minutes later on the same idle store, 35/35/53 ms — the single-read median moved 40%; run 3,
fifteen minutes after that, 30/38/54 ms. All under 3% of a build, but the old absolute thresholds
would have failed all three, by one millisecond and then by three. Two other things run 3 settled:

  - **`getProperties()` is not the cheap one.** Runs 1 and 2 had it level with a single `getProperty`
    (25/25, then 35/35); run 3 had it **dearer** (38 against 30 ms median, 102 against 77 ms worst).
    The verdict was already reading the pessimistic bound, which is the one that turned out to be
    expensive — that is the bracketing doing its job rather than a lucky guess.
  - **the ceiling has to clear everything measured, not the first reading.** 5% against a worst of
    2.9% is about 1.7x. Re-tune these numbers only from fresh runs, never from one, and re-run the
    instrument before touching the ceiling at all.

The verdict is taken on the **pessimistic** bound — `getProperties()` reads the whole store and cannot
be served from an in-execution cache — so a GO is a GO even if the cheaper number looked better. Run 3
is why that is not a formality: the two were level on the first two runs and the whole-store read was
the dearer one on the third, which is exactly the case an optimistic verdict would have missed.

**Turning the request-path hooks off again** is one line, `DIAG_REQUEST_HOOKS_ENABLED = false`, and
must be paired with a reason written next to it. The pass record and the report keep working either
way; only the failed-build record and the slow-build record stop, and a failed build still answers the
same envelope to the client.

### 8.3 The two new routes, by curl

```bash
ADMIN_TOKEN="<a token from a real login as an admin>"

# The whole opening in one response: { ok, at, bundle:{...}, missing:[...] }
curl -sL "$EXEC?action=bundle" -o /dev/null -w "bundle %{time_total}s %{size_download}B\n"

# The report. Admin only: the first two must answer unauthorized and leak nothing.
curl -sL "$EXEC?action=diag"
curl -sL "$EXEC?action=diag&token=not-an-admin"
curl -sL "$EXEC?action=diag&token=$ADMIN_TOKEN"
```

What to read in the report, in the order it matters:

| field | what it answers |
|---|---|
| `status.hooks` | whether the request-path recorders are live, with the measurement they were flipped on. If it says `off`, the failed-build and slow-build records are simply absent — and absent is not the same as none. |
| `warm.verdict` | whether the current TTL still clears the interval, in seconds. This is the check that would have named 180-under-300. |
| `warmPass.ms` | the five build times, per module — the four secondary ones are measured nowhere else. |
| `failures[]` | the last five failed builds with stage, sheet, rev and elapsed ms: the `❌ Build failed` line, readable over HTTP. |
| `cache.<type>.rows` | whether the cache is holding a PAYLOAD, not just bytes. An empty cached payload behind a green warm line is the shape of every silent failure here. |
| `cache.<type>.expired` | a property-backed entry the request path would refuse to serve. |
| `slowLast` | the last build over `DIAG_SLOW_BUILD_MS`, which cost the request path no read at all. |

The route is read-only in the strict sense: no spreadsheet, no build, no cache write, no revision
move. It is **manual only** and must stay that way — a card that refreshed itself would be the load it
exists to measure.

`?action=bundle` costs one `CacheService.getAll` for five modules and answers `missing` for whatever is
cold rather than building it. A `bundle: 3 of 5 published — missing: node, backbone` line in the
Executions log means the warmer is not keeping up, not that the route is broken.

### 8.4 The release

`boot-bundle.js`, `fetch-gate.js`, `diag-store.js`, `index.html`, `sw.js` and the five version labels
are **one commit**. The labels were moved by `node scripts/bump-version.mjs patch` (3.9.20 → **3.9.22**,
guard untouched at 3.10.0), and moving the labels without the bytes — or the bytes without the labels —
is a publish that delivered nothing. §6 is how you prove the new bytes reached an installed device.

**One push carries three parts**, because 3.9.21 was never pushed and therefore never existed in the
field: the `?action=bundle` opening, the warmer's 180 → 330 s TTL, and the Module Health card. If one
of them has to be backed out, each is independently removable — the server routes are additive, the
TTL is two constants, and `diag-store.js` is one `<script>` tag plus one call site.

### 8.5 The Module Health card — what to read, and what “—” means

Admin tab → **Module Health**. It is drawn from `diag-store.js` and it costs **no request and no
timer**: the samples were already being taken by the calls the app was making.

| column | what it answers |
|---|---|
| `Wait p50` / `p95` / `Worst` | this device's own wall clock for that module's calls, retries and backoff included. The top row is the worst module by p95, so the answer is the first line. |
| `Calls` | how many samples the row rests on. `p95 4s` from one call is a different claim from the same number from twenty. |
| `Origin p50` / `Overhead` | the edge's own timing, and the difference between it and the wait — the only way to tell a slow deployment from a slow phone. |
| `Retries` | calls that took more than one attempt, highlighted. Three attempts through the backoff looks exactly like a slow module from the server side; here it does not. |
| `Failed` | calls that never returned data, with the last error on hover. |
| `Last` | how long ago, so a stale row is visibly stale. |

**`Origin p50` and `Overhead` are `—`, and that is the honest reading, not a bug.** Both come from the
Cloudflare worker's headers, and the proxy has been OFF since Sept 15, so no live response carries
them. The card says *edge timing unavailable* and shows the wait anyway. The day the proxy is turned
back on they fill themselves in — the headers are already read on every response, and absent is
recorded as `null`, never as `0`.

The footer counts what the store dropped, because it is bounded on purpose: **20 samples per module,
24 labels**, in memory, this session, sent nowhere. Reloading the app is a clean slate; `Clear` is a
before/after in one tap, which is the way to compare a paste against the state before it.

### 8.6 Looking at the card without a login

`test-module-health.html` draws the card with the **real** `styles.css`, `diag-store.js` and
`admin-module.js`, against a seeded fake session — no route, no token, no login. Serve the folder
(§2, port 8080) and open `/test-module-health.html`.

**Why this exists and why it is not optional.** Rendered for the first time, the card had **ten
columns** and pushed `Retries`, `Failed` and the age off the right edge behind a horizontal scroll —
on the screen the card is read from. Every assertion in `tests/diag-store.test.js` was green at the
time. A DOM assertion can prove a card drew a number; only looking at it proves a person can see it.

**Use it for colour and theme too.** The card is drawn inside `styles.css`, so this is also the
fastest way to check it in the dark theme (`test-olt-shape3.html` is the same idea for a table).

If the bundle has to be backed out in a hurry: delete the `<script src="boot-bundle.js"></script>`
line and move the label. The server route is additive and can stay — an older client never asks for it.

### 8.7 Telling a slow MODULE from a stalled DEPLOYMENT, from outside (Sept 26, 2026)

`?action=diag` needs an admin token. This recipe needs nothing, and it is the same instrument the
warm pass uses: time each route and compare. The point is to hold two kinds of answer apart.

```bash
EXEC="https://script.google.com/macros/s/AKfycby4y2cFYIYvwldcGk2l9FfV7Vd3Bka7ec3tk40h5z7Gb6QjShtVE8BkYw-T_wQMy4h5IA/exec"
for q in "action=rev" "action=bundle" "action=diag" "type=olt&shape=1" "type=olt&shape=3"; do
  rm -f /tmp/probe.txt            # a stale body is how a 0-byte 302 reads as JSON
  out=$(curl -sL --max-time 45 "$EXEC?$q" -o /tmp/probe.txt -w "%{http_code} %{time_total} %{size_download} %{num_redirects}")
  printf "%-22s http=%s %6ss %7sB redirects=%s\n" "$q" $(echo $out|awk '{print $1, $2, $3, $4}')
  head -c 120 /tmp/probe.txt; echo
done
```

What the routes are, and why each one is the right control:

| route | what it does | healthy reading |
|---|---|---|
| `?action=rev` | ONE property read, 80 bytes | ~1.8 s — **this is the floor, and nothing can be faster** |
| `?action=bundle` | ONE cache read of all five modules | ~1.2 s, ~3.6 KB of real bundle |
| `?type=olt&shape=1` | the heaviest builder: 461 rows | ~2.9 s, ~54 KB |
| `?type=olt&shape=3` | the same fleet, problem-only | ~2.1 s, **216 B when every OLT is UP** |
| `action=definitelynothere` | proves the dispatch is reachable | `{"error":"Unknown action: …"}` in ~1.7 s |

**How to read it.** A slow MODULE is one route being slow while `rev` and `bundle` stay at ~1.5 s. A
stalled DEPLOYMENT is `rev` itself taking seconds — measured **16.0 s** on 2026-09-26 — or an 8 KB
error page instead of JSON. Seen on 2026-09-26: `?type=nap` 404 in 7.5 s, `rev` in 16.0 s, `?type=olt`
404 in **30.8 s**, one redirect chain past a 40 s cap, then everything healthy again inside a minute.
Fifteen module requests in the same session answered in **1.06–1.40 s**.

**`?type=olt&shape=3` returning `p`, `m` and `r` as `[]` is CORRECT, not broken.** shape=3 is
**problem-only** by design (`kiosk-reference/README.md`), and `meta.total: 461, up: 461` means there is
nothing to report. Check `shape=1` for the full fleet before filing that as a bug — it is the same
216 bytes either way, and the difference is the whole question.

**The rule this measurement bought** (PART-017, shipped in 3.9.23): in `fetchWithRetry`, a FAILED
attempt that consumed **5 s or more** ends the retry loop. A retry 250–750 ms after a 30 s stall lands
inside the same stall. The threshold is derived — above the slowest successful attempt ever measured
(3.23 s), below the fastest failing one (7.5 s) — and an origin envelope is excluded from it, because
`retryable:true` is the server asking for the retry by name. Expected console line during a stall:

```
[Retry 1/3] <?type=olt>: HTTP 404 (after 30800ms - stalled, not retrying)
Failed after 1 attempt (origin stalled 30800ms, budget not spent): <?type=olt> (HTTP 404)
```

**Why this lives in run.md and not only in the file it measures:** the previous session spent time on
a `?action=bundle` 404 that was this stall, and was one step from reporting a missing paste for a file
that was already pasted. Time `rev` first; it costs one request and it settles the question.
