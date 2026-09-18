# Kiosk Reference — retired from NetPulse

This folder holds the NOC wall display that used to ship **inside** the GVSI NetPulse
app. It is kept here as seed material for a standalone kiosk project. **The app no
longer loads any of it**: the `<script>`/`<link>` tags, the header KIOSK button, the
`#kioskRoot` markup and the toggle wiring have all been removed from `index.html`, and
`styles.css` no longer carries the button styles.

| File | Lines | What it is |
|---|---|---|
| `kiosk-module.js` | 1,889 | Presentation layer, rotation clock, change tracking, entry points |
| `kiosk.css` | 1,885 | Its own stylesheet — **fully self-contained, see below** |

Full history: `git log --follow kiosk-reference/kiosk-module.js`

---

## What comes across for free

**`kiosk.css` can be lifted as-is.** Verified before removing it from the app:

- Every design token it needs is declared **inside `.kiosk-root`**, not in the app's
  `styles.css`: `--k-void`, `--k-panel`, `--k-panel-raised`, `--k-line`, `--k-teal`,
  `--k-teal-dim`, `--k-amber`, `--k-amber-dim`, `--k-red`, `--k-red-dim`, `--k-violet`,
  `--k-violet-dim`, `--k-text`, `--k-text-dim`, `--k-text-faint`, `--k-body`,
  `--k-heading`, `--k-mono`.
- Every selector is rooted under `body.kiosk-mode` or `.kiosk-root`, and every class is
  `kiosk-` prefixed. A check of all top-level selectors found **zero** non-`kiosk-`
  rules, so nothing here can leak into another view.
- The only external custom property it reads is `--cause-color`, which the JS sets
  inline on the cause badge itself.

So a new project can adopt this file wholesale and only needs the `.kiosk-root` /
`body.kiosk-mode` host elements plus the markup skeleton.

---

## What must be re-provided

`kiosk-module.js` reads globals from the app it used to live in. A standalone project
needs its own equivalents:

| Dependency | Used by | Notes |
|---|---|---|
| `dataCache[type]` | `kioskCache()`, `kioskSource()`, `kioskWatchedRef()` | The app's in-memory store. Keys: `nap`, `lcp`, `olt`, `node`, `backbone`. The `olt` entry is a **decoded array of row objects** (see the shape note below). |
| `rawOltData` | `kioskSource('olt')` | Fallback when `dataCache.olt` is empty. |
| `fetchNapData`, `fetchLcpData`, `fetchOltData`, `fetchNodeData`, `fetchBackboneData` | `kioskFetch()` — resolved by name off `window` | The kiosk never fetches for itself; it kicks these and reads the store. A new project needs its own fetchers (or a shared data layer) hitting the same Apps Script endpoints. |

**Not needed** — verified as unused anywhere in `kiosk-module.js`: `BASE_API_URL`,
`fetchGate`, `sanitizeHTML`, `getAlertClass`, and IndexedDB. Don't port those.

---

## Polling profile — read this before wiring it back up

The kiosk did **not** have its own fetch path; it drove the app's module fetchers, which
are cache-first: a call renders from cache and then fires a *background refetch*. The
gate in the app deduped and throttled those to **once per 60 s per module**. The timers:

| Constant | Value | Effect |
|---|---|---|
| `KIOSK_DEFAULT_ROTATE_MS` | 9,000 | Slide changes; each new slide calls `kioskFetch(type)` |
| `KIOSK_REFRESH_MS` | 60,000 | Re-kicks the visible module on a loop |
| `KIOSK_WATCH_MS` | 2,000 | `kioskWatchData` — **cache-read only, no network** |
| `KIOSK_IDLE_RESUME_MS` | 30,000 | Resumes rotation after manual interaction |

Entering kiosk also called `kioskFetch` for **all five** modules at once
(`KIOSK_SLIDE_IDS.forEach(...)`), and `exitKioskMode()` cleared every timer.

Net effect in the app: a wall display left open pinned **every module to its 60 s
refresh ceiling, 24/7**. Removing kiosk from this app removed that constant polling —
if the standalone project reproduces the same loop, it hands the load straight back to
the Apps Script echo endpoint (which intermittently returns 404 on slow calls). Decide
deliberately how often the new display should re-pull.

---

## Entry points

All of these live in `kiosk-module.js`; the app's header button is gone, so a standalone
project will likely want URL auto-start instead:

- `?kiosk=true` — auto-enters once the login overlay is hidden; `&interval=5..300`
  sets seconds per slide.
- `Ctrl+Shift+K` — toggle (was bound to the removed header button).
- Inside kiosk: `Space` pause/resume, `←`/`→` slide, `Escape` ×3 to exit.
- `visibilitychange` auto-enters while the tab is hidden.

---

## Two things to fix in the new project

**1. Manifest / orientation.** NetPulse's `manifest.json` is
`"display": "standalone"` with `"orientation": "portrait"` — it is built for phones. A
TV/NOC wall display wants its own manifest with `"orientation": "landscape"` and
probably `"display": "fullscreen"`.

**2. OLT totals are computed from a problem-only payload.** The app fetches
`?type=olt&shape=3`, which returns **only rows whose status is not `UP`**, plus a `meta`
summary block. Kiosk's `kioskOltBuckets(rows)` sets `total: rows.length` and derives
`up` by elimination, so its "N OLTs tracked" and the 0%-up figure are computed over the
*problem rows only*.

Measured against the live endpoint on 2026-09-17:

```
shape=3 (problem-only)   596 bytes   meta: { total: 461, up: 457, ... }   4 problem rows
shape=2 (all rows)    26,220 bytes   461 rows, no meta
```

So the kiosk slide was reporting **4** tracked OLTs out of **461**. The standalone
project should either request the all-rows shape or read the `meta` block for its
denominators — do not use `rows.length` as the OLT total.

---

## Shape reference (for the new data layer)

`shape=3` payload:

```json
{
  "v": 3,
  "f": ["P", "M", "N", "S", "T", "AG", "RM", "DC", "CA"],
  "p": ["BENGUET", "CAGAYAN"],
  "m": ["ITOGON", "KIBUNGAN", "..."],
  "meta": { "total": 461, "up": 457, "down": 0, "lowPower": 0,
            "uplinkDown": 0, "degradation": 0, "clientsDown": 0,
            "builtAt": 1789720861701 },
  "r": [ [0, 0, "OLT-NAME", "DOWN", "TICKET", "12h 30m", "remarks", "FIBER", "42"] ]
}
```

- `f` is the field order for every row in `r` — read it, don't hardcode it.
- `P` and `M` in each row are **indices** into the `p` and `m` dictionaries.
- `v: 2` (no `meta`) is the all-rows compact shape; `shape=1` is the legacy
  array-of-objects form. `shape=2` carries `builtAt` as a **sibling key** of
  `v`/`f`/`p`/`m`/`r` instead of inside a `meta` block.
- **`meta.builtAt` (epoch ms) is a build stamp, and it rides INSIDE the cached
  payload rather than being attached to the response on the way out — so a cache
  HIT reports the time the data was built, not the time it was asked for. A dashboard that
  displays age should read this; using its own fetch time instead is what let a
  deleted ticket look fresh for 11 minutes (Sept 18, 2026). The app's own chip is
  `fetch-gate.js` (`noteBuiltAt` / `dataBuiltAt`), and it goes amber past
  10 minutes.

The app's own decoder is `decodeOltCompact()` in `olt-module.js` (27 lines) — worth
copying rather than rewriting.
