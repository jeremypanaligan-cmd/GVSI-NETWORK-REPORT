# 📌 NetPulse — Live Work List

**This is the current, ordered queue of work** — not an audit. Read it top-down; P1 is next.

**Last updated:** September 26, 2026 · **3.9.28 is pushed** — the edge read path (`/publish` + `/data/*`, `cdn-source.js`, one switch), **built and dormant**, with **four Cloudflare steps owed by hand** — see the item immediately below · before it, **3.9.27** (the zero-total rows) and 3.9.26 (the Module Health header alignment), with 3.9.25 carrying everything that had queued up behind it (3.9.21–3.9.24), so client work that says *in the repo* below is now in the field · the NAP/LCP sheet ranges are committed and pushed too (`69fde49`, fixture moved with them) · **the server half is still owed, and all of it is pastes** · **Security Roadmap Phase 1 (Tier 0 + Tier 3) is scheduled for off-peak — see the security section below**

---

## How this file is used

- When asked *"what's on the to-do list"*, read **this file** and report in priority order, **P1 first**, with current status.
- Items move down or out when done. Dates and statuses are updated in place, not appended.
- **A to-do item lives on disk or it does not exist.** Conversation history does not survive between sessions, so anything decided in chat and worth keeping gets written here.

**Not the same as `GVSI_NetPulse_System_Roadmap.md`.** That file is a **dated audit** (Aug 26, 2026, against app v3.3.0) with its own signature and priority tables. Treat it as history: useful context, but **re-verify each item before working it** — several have already landed (see the bottom of this file).

---

## 🔴 P1 — Ang read path sa edge: BUILT at naka-push, apat na hakbang sa Cloudflare ang utang (Sept 26, 2026)

**Status.** Ang **buong code** ay nasa repo at naka-push (`ea712a4`, release **3.9.28**): ang worker
ay may bagong `/publish` at `/data/*`, may bagong paste na `publish-cache.gs`, may `cdn-source.js` ang
client, at may isang switch. **Wala pang naka-deploy** — at hindi ito kayang gawin mula sa checkout:
ang Cloudflare credential ng connector ay **read-only** (`10000: Authentication error` sa KV create at
sa worker upload), kaya ang provisioning ay sa iyo, gaya ng lahat ng paste sa proyektong ito.

**Bakit ito ginagawa.** Sinukat noong Sept 26 laban sa live `/exec`: `?type=nap` = **200 sa 1.36 s at
1.56 s** (950 B), `?action=bundle` = **200 sa 1.32 s** (1,040 B). Iyon ang 2-hop redirect papasok sa
serverless execution, at walang client-side tuning ang makakabawas nito. Sa edge, ang parehong
payload ay nasa KV na — walang Apps Script sa read path.

**Ang desisyon sa privacy, at ang dahilan.** Hindi pala naka-lock sa login ang data ngayon:
`resolveSession()` / `requireSession()` ay tinatawag lamang ng **isang** admin route (`admin.gs:291`)
at ng `diag` (`diagnostics.gs:459`) — ang limang `?type=` ay wala. Sarili nang komento ng app ang
nagsasabi nito. Kaya ang CDN path ay hindi pagbubukas: ito ay **pagpapakitid** — token-gated
(short-lived HMAC mula sa login, stateless na bini-verify sa edge), revocable sa isang secret
rotation, at walang per-caller quota. Ang pass-through ay **hindi** ginalaw, kaya ang `/exec` ay
nananatiling gumaganang fallback.

**Ang apat na hakbang (eksakto sa `proxy/README.md`):**

- [ ] **1. Gumawa ng KV namespace** — Workers & Pages → KV → Create, pangalan `NETPULSE_DATA`
- [ ] **2. I-deploy ang worker kasama ang binding** — i-paste ang `proxy/netpulse-proxy.mjs`, dagdagan
      ng KV binding na pinangalanang **`DATA`** (ito ang inaasahan ng code; ang ibang name → 503 na
      may `field: "DATA"`)
- [ ] **3. Dalawang secret, sa worker AT sa Script Properties** — `openssl rand -hex 32` ×2 para sa
      `PUBLISH_SECRET` / `READ_SECRET`, tapos isang beses sa editor:
      `setEdgeConfig_('<worker url>', '<publish secret>', '<read secret>')`
- [ ] **4. Mag-publish ng isang bagay** — umaakyat ang publish sa `warmDataCaches`, kaya kailangan
      ng 5-minutong trigger (o isang manual run mula sa editor)

**⚠️ Hard dependency, nasukat.** `?action=bundle` ay sumagot ng **lahat lima ay *not warm***, samantalang
ang `?type=nap` ay mainit ilang sandali lang pagkatapos — iyon ang lagda ng deployment na **walang
naka-install na warm trigger** (mabubuhay lang ang entry kapag may nag-build, at pagkatapos ng 330 s
na TTL ay wala na). Kung wala ang trigger, **wala ring mai-publish sa edge** kahit naka-set na ang mga
secret.

**Pagkatapos ng apat:** i-set ang `window.NETPULSE_CDN` sa `index.html` (nasa network-only listahan na
ng `sw.js` ang host). **I-off sa isang value:** blankuhin lang ito — ang `/exec` ang fallback ng bawat
type. Harder rollback: burahin ang KV keys → 404 `not_published` → bawat type ay babalik sa `/exec`.

**Nasa repo na, hindi pa:** `publish-cache.gs`, ang 17 linyang pagbabago sa `admin.gs` (token mint sa
loob ng umiiral na `withLock_`), ang 20 linyang `olt-cache-warmer.gs` (publish hook sa warm pass), at
`proxy/netpulse-proxy.mjs`. **Walang client byte ang nagbago sa field** hangga't blangko ang switch.

**Test:** tatlong bagong suite — `publish-auth` (18 cases, worker), `cdn-read` (client fallback +
network-only host), `publish-server` (ang `.gs` laban sa fake `UrlFetchApp`/`PropertiesService`/
`CacheService`, kasama ang **cross-check**: ang token na ini-mint ng `.gs` ay bini-verify ng worker).
Lahat may mutation check.

---

## 🟠 P1 — Ang bagal ng paglabas ng data: the client half is LIVE, three pastes still owed (Sept 26, 2026)

**Status.** The client half is **LIVE**, pushed as **3.9.24**, which carried 3.9.21–3.9.23 with it. What
remains is the backend half, and every item in it is a paste. The complaint was *"nagkakaproblema ako sa sobrang tagal ng
paglabas ng data sa app — LCP, NAP, BACKBONE kadalasan itong nangyayari"*, and the cause was
arithmetic rather than luck:

| what | before | after |
|---|---|---|
| warm TTL under a 300 s cadence | 180 s → **120 s of every cycle with NO cache entry at all (40%)** | 330 s → no moment without one |
| modules fetched on load | 1 (nap); the other four on first tab click | all five, in **one** request |
| round trips to glance at three tabs | 4 | 1 |
| bytes moved | 5,503, spread across those requests | 5,503, in one response |
| worst case when the timing is unlucky | a full cold build on top | none — the window is gone |

**Three things to know before touching any of it.**

1. The old TTL was not an oversight: `olt-cache-warmer.gs` argues for it in its own header, and it was
   chosen while the four secondary build times were still unmeasured. Both suites that encoded the old
   rule now assert the arithmetic the other way round, with the dead window computed rather than
   described — so this cannot be reverted quietly.
2. `prefetchOtherTabsInBackground()` in `index.html` was **dead code** — defined, called from nowhere —
   and the warmer's comments credited it with covering the other four modules. Worse than dead: its
   5 s timer was the **only** caller of the daily snapshot writer, so a once-a-day record that the
   spreadsheet can no longer be asked for had stopped being written, and nothing said so. Fixed: the
   call moved to `loadInitialData()`, and `tests/analytics-dashboard.test.js` pins the count.
3. The client half **fails open**. No route, an unknown-action envelope, a rejection, a hang, a
   wrong-shaped payload → the app loads exactly as it did before `boot-bundle.js` existed. Deploy order
   does not matter and a rollback is one `<script>` tag.

**Owed, in this order** (procedure in `.freebuff/run.md` §8):

- [x] **`measurePropertyCost()` has been RUN (Sept 26, live project).** Read 25 ms single, 25 ms
      whole-store, write 51 ms — the whole-store read is **1.9% of a cold build**, so the premise holds
      with room to spare. The verdict still printed **NO-GO**, because the thresholds were absolute
      numbers that had been picked (20 ms, 50 ms) and one of them failed by a single millisecond. The
      verdict is now the SHARE of a build, with one backstop on the write, and it is pinned to these
      numbers by a test so the calibration cannot drift back to guessing.
- [x] **`measurePropertyCost()` RUN THREE TIMES (Sept 26, 12:33 / 12:42 / 12:57 AM, live project)
      — GO.** Read 25/25/51 → 1.9%, then 35/35/53 → 2.7%, then 30/38/54 → **2.9%**, against a 5%
      ceiling. The single-read median moved **40%** between the first two runs, so the discarded
      absolute thresholds would have failed **all three** — which is the recorded reason they were
      replaced by a share rather than re-tuned. The ceiling clears the worst reading by about 1.7x.
- [x] **`diagnostics.gs` is pasted, with the switch ON.** Run 3's last line reads
      `→ nothing to do: DIAG_REQUEST_HOOKS_ENABLED is already true and the hooks are recording`.
      `DIAG_REQUEST_HOOKS_ENABLED` must stay **`true` in the repo** — a copy flipped by hand while the
      file still said `false` would silently turn the hooks back off at the next paste.
- [ ] **But that log does not prove the hooks are being CALLED, and it is worth knowing why.** Both
      call sites live in `code.gs` (`recordBuildFailure_` inside `buildFailedOut_`, `recordSlowBuild_`
      at the end of every build), and a run of `measurePropertyCost()` cannot see which file its
      constant was pasted beside. The `code.gs` paste is what makes a failed build write its stage,
      sheet, rev and elapsed ms — and `?action=diag`'s `failures[]` is how you confirm it did, since
      an empty list from a store that never failed looks exactly like a hook that is not there.
- [ ] **Paste `olt-cache-warmer.gs`.** The TTL change alone removes the 40% cold window. No trigger
      change, no `setupAllTriggers()`.
- [ ] **Paste `code.gs` + `diagnostics.gs`**, then curl `?action=bundle` and `?action=diag` with an
      admin token.
- [x] **Push the release — DONE (Sept 26, 2026).** The `sw.js` generation, the two `?v=` tokens and
      the three `manifest.json` fields moved with it; the guard is still 3.10.0. One push delivered
      every client part that had queued up behind it: the bundle route (3.9.21/22), the retry policy
      (3.9.23) and the keep-the-drawn-screen rule (3.9.24). 3.9.21–3.9.23 had never reached a device
      before this, so the field is seeing all of them at once — confirm the deploy by polling
      `version.json` until it reads the pushed release, never by assuming.

**And the fourth thing, since the last update: what the DEVICE waited (Part 16, same release).** The
server report names which module failed and on which sheet; it cannot name what this phone waited,
which is the half that decides what an operator experiences. The admin tab now has a **Module Health**
card drawn from `diag-store.js`: per module, the calls seen, wait p50/p95/worst, the retries, the
failures and the last error — in memory, this session, sent nowhere, with **no request and no timer**
when the tab opens.

  - **Read it like this.** The top row is the slowest module by p95. `Retries` above 0 on a row whose
    wait is far above its origin time means the phone and its network, not the origin. `Failed` with a
    hover for the error is a module that never rendered.
  - **`Origin p50` and `Overhead` are `—` right now, and that is correct, not broken.** Those two come
    from the Cloudflare worker's own headers (`x-netpulse-origin-ms`, `x-netpulse-attempts`), and the
    proxy has been OFF since Sept 15 — so the card says *edge timing unavailable* and shows this
    device's wall clock instead. It will fill itself in the day the proxy is turned back on, with no
    code change: the headers are already read on every response.
  - **A missing measurement is never drawn as 0.** That is one `|| 0` away and there is a test on each
    side of it, because "the origin took no time" is exactly the wrong answer to show a person.

**Measured, and now on the record.** A `PropertiesService` call costs **25–38 ms** across three live
runs. The first note here said a single-key `getProperty` costs the SAME as a whole-store
`getProperties()` — run 3 corrected that: the whole-store read came out **dearer** (38 vs 30 ms
median, 102 vs 77 ms worst), so the honest statement is that the two are the same order and which
wins is not stable. That is precisely what taking the verdict on the **pessimistic** bound protects
against. What still follows: anything answerable from one whole-store read should use one call rather
than N. A write costs **51–54 ms** (worst 134 ms).
Two live paths pay it constantly: the rev poll is one whole-store read per poll per device, and every
build spends two `dataRevOf_()` reads as its build-time witness. Both are priced and both are fine —
the point is that the number is now known rather than assumed, and it is the input to any future tuning
of either.

**Known and deliberately not fixed here.** The **60 s `cacheTtl`** a client-built `node`/`olt`/
`backbone` entry gets (against 180 s for nap/lcp, and 330 s when the warmer writes it). It only
matters once the warmer is dead, and changing it is a freshness trade rather than a bug fix.

---

## 🟢 P2 — The update trigger shipped in 3.9.20 (Sept 22, 2026)

**Status.** Released and pushed as **3.9.20** in three commits — `e5a1e11` (fix), `49d71cb` (docs),
`efdcdf9` (release: labels, tokens, manifest and cache generation together, guard untouched at
3.10.0). Live origin serves the new bytes on all four surfaces; verified with the **previous
release's own files**, not a simulation:

| the device was | it was given | it came back as |
|---|---|---|
| 3.9.19 shell, worker `sw.js?v=3.9.19`, cache `gvsi-shell-v3.9.19` | the 3.9.20 release at the same URL | 3.9.20 shell, `styles.css?v=3.9.20`, worker `?v=3.9.20`, no waiting worker |

The only thing that page was given was **one foreground event** — the sole trigger a 3.9.19 build
has — with its 5-minute throttle skipped by moving the clock. No uninstall, no cache clear, no new
browser, and the app came back rendering live data.

**What that means for the devices already out there.** 3.9.18 and 3.9.19 both carry the
`controllerchange` reload, so a device on either updates itself on its next foreground return — or
on its next launch. A device older than that has no reload handler: it still receives the new
worker, and takes the new shell on the next launch instead of in place. **Neither needs an
uninstall.**

**What was wrong.** Two gaps, each invisible on its own:

1. **Nothing ever asked.** The page called `reg.update()` on exactly one event — a return to the
   foreground — so a launch and a dashboard left open never checked, and Chrome floors its own
   check-on-navigation rule at 24 hours per registration. There was no launch trigger, no timer,
   and no in-flight guard, so adding the obvious triggers would have made every device fetch
   `sw.js` several times per minute.
2. **A worker left in `waiting` was never told to go.** A device whose running worker predates
   `skipWaiting()` can hold a new one in `waiting` indefinitely, because an installed app is never
   closed and so never releases it. The page now watches for that worker (at launch, and on
   `updatefound`) and posts `SKIP_WAITING`; `sw.js` answers it.

**Also in this batch (already in the tree from the previous turn, same delivery):** `sw.js`'s fetch
handler is now network-first for **navigations** and never-caches `version.json`. That is the other
half of the same symptom — while navigations were answered cache-first and pinned, the one document
that could move a device forward was the one document the cache refused to refresh, which is the
deadlock an uninstall was breaking.

**Measured.** 246 tests across 15 suites, 0 failed (231 → 246; new `tests/sw-update.test.js` with
15). Mutation check **17/17 caught, 0 missed, 0 unproven**, baseline green in the mutation workspace
first. See PART-018 of `PLAN_EVIDENCE.md` for the numbers and `.freebuff/run.md` for the recipe —
including the trap that made the first end-to-end attempt unreadable: a **polluted origin**, where a
registration left over from an earlier session parked the new worker in `waiting`. The upgrade
verdict above comes from a **pristine** origin, which is the only place it means anything.

---

## 🟢 P2 — OLT Active Incidents view, IMPACT column and Affected Clients (SA) — SHIPPED in 3.9.19 (Sept 21, 2026)

**Status.** Done. `code.gs` was deployed to Apps Script, and the client shipped as **3.9.19** with
its labels, tokens, manifest and cache generation moved together (commit `7e06b04`). The two steps
that were owed here are recorded below as history, not as work.

**What changed.** `ALL OLTs` → **`Active Incidents`**, now the landing view. A new **IMPACT**
column directly after CLIENTS, joined from `OLT DOWN Tickets` column K by ticket number.
`Affected Clients (Down)` → **`Affected Clients (SA)`**, scoped by the ticket's IMPACT and not by
the row's status. The rename is a correction: the payload was already problem-rows-only under
`shape=3`, so the old label described a view that did not exist.

### The two steps that were owed, both done

1. **`code.gs` deployed to Apps Script** — done by the user. Without it the client would render
   `–` in every impact cell and **0** on the SA card, because `IM` and `meta.clientsSA` do not
   exist on the old script.
2. **Client released with the version tooling** — done as **3.9.19**, What's New in the same
   commit. `olt-module.js` is an unversioned precache entry, so until the label moved the new
   bytes reached nobody.

**Measured.** 212 tests pass across 12 suites (196 → 212). Mutation check 21/21 caught, 0 missed,
0 unproven. In the browser: 4 incident rows on the landing view, impacts SA/NSA/NSA/SA, 8 cells
per row, footer `FILTERED TOTAL (ACTIVE INCIDENTS)` with `colspan="7"`, and the SA card reading
165 while `clientsDown` in the same payload was 150.

### Also in this batch — fixed-size chips (OLT STATUS, Backbone SERVICE)

Both columns carry data-driven labels, so a chip sized by its own text gave every row a
different box and let the longest label set the column width. `styles.css` now fixes a width
**and** a height for `.status-chip` (`width`, never `min-width` — a minimum still lets the long
label widen the column), with `.status-chip.is-long` for the OLT vocabulary. Measured in the
browser: four OLT chips at 132×31.9px (one distinct size, STATUS column 181px → 156px) and eight
Backbone chips at 55×31.9px. The full label rides in `title`, so a wrapped chip is not a
truncation, and the value itself is unchanged because the filter and the CSV export read it.
The OLT fleet list keeps its small `UP` badge on purpose — its only value is `UP`.

**Then the column itself:** the OLT table's `STATUS` header is now **`INCIDENT`**, and its labels
lost the module prefix (`OLT UPLINK DOWN` → `UPLINK DOWN`, `OLT SERVICE DEGRADATION` →
`SERVICE DEGRADATION`, `OLT UPLINK LOW POWER` → `UPLINK LOW POWER`, `DOWN` retained). Display
only: the payload, the filters, the cards and `meta` still read the raw status, and the cell's
`title` keeps it. Two things follow from that and are deliberate: the **CSV export now carries
the trimmed labels** (it reads the DOM), and the **detail modal still shows the raw status**.

**`code.gs` was deployed on Sept 21** (the live payload now carries `clientsSA`, and the card
read 58 against the live meta). The client release below is the part still owed.

### Also in this batch — ACTIVE INCIDENTS, the IMPACT chip, and the tile labels

**The summary tile the tab is named after.** `TOTAL OLT` is now **`ACTIVE INCIDENTS`** and the six
tiles were reordered into the ladder they describe — `UP / ACTIVE INCIDENTS / DOWN`, then
`LOW POWER / UPLINK DOWN / SERVICE DEGRADATION`. The middle tile is **`total − up`**, not the sum
of the four counting arms: those arms are a hand-written list, and a status the sheet spells
differently increments none of them while still being counted in the fleet total and rendered in
the table — so a sum would read one fewer than the table beside it. `total − up` is the same test
the server used to pick the rows it sent and the same one the ACTIVE filter re-applies. The tile
keeps `c-total`: red would dress a clean fleet as an alarm. Its id is now `oltCardActive`; the old
`oltCardTotal` is gone from the markup, so nothing can quietly keep writing the fleet size into it.

**The IMPACT and the two long labels, both fixed boxes.** IMPACT got `.status-chip.is-impact`
(4.2em), sized **under** its own header so the chip can never widen the column — measured at 46.2px
against a 72px column, header-set. And the two labels wider than a phone's third — ACTIVE INCIDENTS
and SERVICE DEGRADATION — now wrap **inside** the tile: the shared `.stat-card .label` rule is
`nowrap`, so a scoped `.olt-stats-grid` rule reserves `min-height: 2.2em` (two lines at
`line-height: 1.1`) and bottom-aligns, which keeps the six values on one baseline per row even when
one tile's label takes two lines and its neighbour's takes one.

**Measured.** Full suite **225 passed across 13 suites**; the OLT suite **13 → 19**. Mutation check
**19/19 caught, 0 missed, 0 unproven**. In the browser against the live payload (`up: 457`,
`total: 461`): tiles `UP 457 · ACTIVE INCIDENTS 4 · DOWN 0 · LOW POWER 2 · UPLINK DOWN 1 ·
SERVICE DEGRADATION 1`; IMPACT chips SA and NSA both **46.2 × 31.9px**; and at a phone's width
(106.7px tiles) the two long labels wrap with **no clipping, no label outside its tile, and one
baseline per row**.

**Flagged, not changed:** the DOWN tile drops its colour when it reads 0
(`getAlertClass('oltDown', 0)` returns `''` and overwrites the class). Pre-existing, untouched, and
now easy to see beside the new middle tile.

**This batch also needs the client release**, for the same reason as the rest: `olt-module.js`,
`index.html` and **the versioned `styles.css?v=`** all have to move together or a phone gets new
markup against an old stylesheet — a state that measures like "my CSS never loaded".

**And the zero-state export bar.** With nothing to export — any filter that matches no rows,
including the whole-fleet all-clear — the **EXPORT CSV / EXPORT PDF row leaves the screen**, so the
zero-state card sits directly under the filter strip: measured **+39px** for the card. The bar is
still built (every other path assumes it exists) and its buttons are still muted behind the hidden
attribute, which is deliberate: it is never one reveal away from exporting a header line. It comes
back on its own when a row does. `olt-empty-state.test.js` now pins hidden **and** muted, the child
order, and the empty → filled return; mutation check **7/7 caught**. No CSS change — the app's
`[hidden] { display: none !important }` was already what makes `el.hidden = true` win against
`.export-toolbar { display: flex }`.

### Also in this batch — the Analytics trend charts are gone

The four IndexedDB charts (**Incidents per Day, OLT Status Trend, Clients Affected Trend, Aging
Distribution**) were removed from the Analytics tab with `renderTrendCharts()`, `loadChartJS()` and
the **Chart.js CDN script**. The tab now renders from the app's own caches alone — no external
script, no IndexedDB read, no network — and a new `tests/analytics-dashboard.test.js` runs it in a
sandbox with no `Chart` and no `indexedDB`, so a chart call creeping back is a ReferenceError.

**Three things that look like the same feature and were kept on purpose:** the **snapshot writer**
(`saveDailySnapshot()` still runs on boot; the reader stays for a future history view — the record
cannot be rebuilt once the day is gone), the **`.analytics-charts-*` CSS** (the OLT and Backbone
**donuts** are laid out by it), and the **What's New entries** naming Trend Charts (versioned
history is not documentation of the present).

**One loose end, flagged and not fixed:** the **7 / 30 / 90 Days** filter buttons are **already
inert** — `analyticsDateRange` is written and never read, so all three re-render an identical
dashboard. Pre-existing, but the trend charts were their stated purpose, so they now have no job at
all. Removing them is a small follow-up if you want it.

**Checks.** Full suite **231 passed across 14 suites**; mutation check **9/9 caught**. Measured on
the live origin: `window.Chart` undefined, no `jsdelivr` tag in the document, **0 canvases**, the 2
donut cards intact, and the five remaining section headings present.

### Deliberately NOT done (decided with the user, Sept 21)

- **Analytics and the daily snapshot stay on the DOWN definition.** They read
  `meta.clientsDown`, which keeps its meaning; a snapshot is never corrected after the fact.
  If the two screens must agree one day, that is a separate change with a history question.
- **The OLT detail modal was not given an IMPACT row.** The value is in the row that was clicked.
- **The Backbone service chip was left at 5em** (a 4-character value gets ~15px of slack). Fine
  for DWDM/MPLS; tighten to ~4.2em if the column looks padded out next to its neighbours.

---

## ✅ P1 — Instant first paint (persist `dataCache`) — SHIPPED in 3.9.25 (Sept 26, 2026)

**Status.** Built as `cache-store.js` (PART-026), and it closes both halves of the operator's report:
3.9.24 stopped a *failed* refresh from blanking a tab, and this one makes a cold start draw the last
session's payloads **before** it asks for anything. The design below was written before the code and
was followed; **three things it did not foresee** are recorded because they were the real work:

1. **A failed refresh would have erased the copy it needed.** Every refresh empties `dataCache[type]`
   before it asks, so a snapshot landing in that window writes the modules the page has and silently
   deletes the one whose read failed. The writer now **carries over** any type the page is not
   holding, at its original `at` — so it goes on ageing and expires by the same cap.
2. **A stamp in the future had to be refused.** A clock that moved backwards makes the age negative,
   which never expires: an eternally-fresh stale screen, the opposite of the guard.
3. **Restoring is not enough — the first frame has to be drawn from it.** Handing the payloads to the
   opening request's promise means the restored data appears only when that request settles, i.e. at
   the exact moment it was meant to replace. The visible tab is now drawn synchronously from the
   snapshot; the cost is one background refresh for that tab, which the gate joins and throttles.

**Verified** (PART-026): 425 tests across 22 suites, 15 mutations all caught, and a real-browser cold
start against an opening request stubbed **never to resolve** — first frame held the restored rows,
the chip read `Updated 20m ago`, `lastFetch('nap')` equalled the stored stamp, and OLT came back with
its meta, its rows and its 6-minute build stamp. Then a failed refresh kept the screen, and the writer
firing with `dataCache.nap` empty still left nap in the store at its original 20-minute age.

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

### Acceptance checks — all four confirmed in a real browser (PART-026)

1. ✅ Reload → data is present in the **first** frame, no skeleton. It is drawn synchronously, before
   the opening request is awaited, so a stalled deployment cannot delay it either.
2. ✅ The ticker chip shows the **restored age** ("Updated 20m ago"), not "No data yet" —
   `fetchGate.seedLastFetch()` restores the fetch time, and OLT's chip reports the server's own build
   time because that stamp rides inside the payload.
3. ✅ Manual REFRESH still clears and refetches (the restore never writes back into `dataCache`, so a
   tab click cannot redraw stale data as though it had just been fetched); logout clears the key, and
   so does the version guard's wipe.
4. ✅ Auth ordering is unchanged — `loadInitialData()` is only reached from `showApp()`, which is
   gated on `isLoggedIn()`. **Restored data must never be visible before login.**

**Stricter than planned, not looser:** an entry is judged per type (nap 60 min, lcp 30, olt 15,
node 10, backbone 10 — the app's own refresh cadence), a type with no recorded fetch time is not
stored at all rather than stamped `now`, and OLT rows without their meta are neither stored nor
restored, because those cards would then disagree with the table under them.

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

## 🔴 P1 — Security Roadmap Phase 1 — the gate the client can see (Tier 0 + Tier 3)

**Scheduled for off-peak hours.** Nothing here is applied yet; this section is the resume point.

**Why it is first.** Every data route is open to anyone holding the deployment URL — which is
hardcoded in the public `index.html` on GitHub Pages. Probed live with no token, no cookie:
`?type=nap` → 200 with 12 real rows · `?type=olt&shape=3` → 200 · `?action=rev` → 200 ·
`?action=getSettings` → 200. Only `?action=setMaintenance` gates. `requireSession()` exists in
`admin.gs` and has **zero callers**; `resolveSession()` is called from exactly one place
(`admin.gs:291`). The comment above it claims *"Phase 2: ENFORCED … flipped on 2026-09-12"* —
the code says otherwise.

Phase 1 does **not** close the gate. It makes the gate **safe to close**, by giving the client a
way to see a rejected session, and removes two leaks that cost nothing to remove.

### TIER 0 — the unauthorized envelope the client can actually see

- `admin.gs` `unauthorizedResponse()` (`admin.gs:30`): add `error: "unauthorized"` and
  `retryable: false`. **Additive** — `success:false`, `unauthorized:true` and `message` stay, so
  a stale client that reads `success` is unaffected.
- `index.html` `fetchWithRetry()` (`index.html:1047`): tag the envelope when
  `data.unauthorized === true`, treat it as fatal (one attempt, no retry), then clear the session
  and return to the sign-in screen **with the envelope's `message` shown** — instead of the blank
  table the current parse produces.

**Why this has to come first.** `fetchWithRetry` only treats `data.error` as a failure, and
`unauthorizedResponse()` has no `error` field. An unauthorized reply therefore parses perfectly
and is *rendered as data*: an empty table with no error on it. Close the gate without this and
every expired token becomes a silent blank screen.

### TIER 3 — two leaks that cost zero runtime

- `admin.gs` `generateHash()` (`admin.gs:362`): delete `Logger.log('Password: ' + plainTextPassword)`.
  Plaintext passwords currently reach the Executions log, readable by anyone with Editor access.
- `index.html` `handleLogout()` (`index.html:1882`): revoke server-side before clearing local state.
  The route already exists and works (`admin.gs:342`, `?action=logout`), so **this half needs no
  server deploy**.

### Constraints measured from the code, before any edit

- `generateHash()` has **zero callers** in the repo — the leak is latent, and the fix is provably
  zero-risk. Its sibling `Logger.log('Hash: ' + hash)` is the same defect class in the same dead
  function (a SHA-256 hash without a salt is crackable); one extra line, flagged for a decision.
- `fetchWithRetry` is also the login path (`index.html:1831`), so the unauthorized handler must make
  **no API call** and must not retry, or it recurses into itself.
- `isLoggedIn()` calls `handleLogout()` and reads its result, so `handleLogout()` must stay
  **synchronous in effect** — fire the revoke, do not await it, and clear local state regardless of
  the outcome. An offline logout that *appears* broken is worse than a token that lives to its TTL.
- `tests/origin-resilience.test.js` extracts the **real** `fetchWithRetry` from `index.html` by line
  slicing and pins its contents. The new handler must be exported on `window` so that harness can
  stub it; an undefined name there is a `ReferenceError` in every existing client test.

### Deploy order — decided

**The client release first, then `admin.gs`.** The client change is inert until the server emits the
new field, so nothing can regress; once `admin.gs` is deployed, every updated shell already handles
it. The reverse order hands a still-stale shell a fatal envelope error where it used to show a nice
message — admin-only and rare, but avoidable.

Two delivery channels that move separately: `admin.gs` through the Apps Script editor (manual paste
+ deploy), `index.html` through the release label — a precached shell entry, so it reaches an
installed device **only when the version moves**.

### Still owed at the end of Phase 1

- A new suite — **no test covers `admin.gs` today** — asserting the envelope shape, that the
  plaintext password never appears in a log capture while `generateHash` runs, and that logout
  revokes. Plus a client-side case in `tests/origin-resilience.test.js` proving one attempt, session
  cleared, login shown.
- A mutation check over the new assertions, so they are not vacuous.
- **A release** (`chore(release)`, 6 labels + one What's New entry) — without it the client half
  never reaches a device.
- Plan parts, by the `MASTER_PLAN.md` convention: **PART-012** (Tier 0) · **PART-013** (Tier 3) ·
  **PART-014** (tests, evidence, release).

### Phase 2 of the roadmap — for later, deliberately not in this item

- **Tier 1 (the gate itself).** Wire `requireSession()` into the five `?type=` routes and
  `getSettings`. Validate through a **`CacheService` session mirror** first — unmetered, unlike
  `PropertiesService` (50,000 read/write per day), and the data route already does a `CacheService`
  read — with the durable `PropertiesService` copy as the fallback. A look-up against a ~1.1–1.3 s
  warm request is **<1 %**; in the worst case it is *faster*, because it removes the anonymous cold
  builds (1.2–3.2 s) that produce the documented echo 404s.
- **Tier 2 — leave `?action=rev` open.** It is the busiest route (~960 of ~1,200 requests/device/8 h)
  and leaks only `{ok, rev}` — "something changed", never the data. Gating it would multiply
  look-ups on the hottest path for nothing. `keepalive` stays open; it is a warm-up ping.
- **Tier 4 — the Cloudflare worker** (`proxy/README.md`, currently off) is the only place a
  **per-IP rate limit, WAF and a shared secret** can live without spending Apps Script quota. It adds
  a proxy hop, so **measure before turning it on**.
- **Do not add a rate limiter inside Apps Script.** It reads and writes on *every* request,
  accelerating the exhaustion of the very quota it is meant to protect. Traffic is not the problem:
  ~1,200 requests/device/8 h, ~7 users, usually 2 concurrent — nowhere near any ceiling.
- Minor, unmeasured: login lockout is per-username with no IP or global backoff, so five bad guesses
  can lock a real user out.

---

## 🟢 P3 — The OLT all-clear card, reworked in 3.9.17 (Sept 20, 2026)

**What changed.** Three things, all on the card the DOWN filter shows when nothing is down:

- **The "View All Healthy OLTs" button is gone.** It duplicated the UP card and the UP filter,
  which open the same list from controls that sit above it and always will. On the one screen
  with nothing to check, the last thing it should do is hand over a chore. `.olt-empty-actions`
  went with it rather than sitting there as dead CSS, and a test fails if the button returns.
- **The mark is `activity`, not `circle-check-big`.** The tick was itself a circle, drawn inside
  the card's own 64px circle — two rings reading as one smudge. `activity` is the steady signal
  line, and already the glyph the login screen uses for real-time monitoring.
- **It pulses.** A `::after` ring painting `currentColor`, 2.6s, `scale(1)` → `1.5` as opacity
  falls `0.55` → `0` — the app's existing pulse vocabulary (`statusPingGreen`, `nodePingRing`)
  at this circle's size. Slow on purpose: it is the only thing moving on a good-news screen.

**Two refusals are built in.** `prefers-reduced-motion: reduce` switches the ring **off**, not
slower — a ring that still fades in and out is still motion. And `is-missing` never pulses: a
beat over "no rows arrived" would suggest something is being watched when nothing is.

**Verified.** **196 tests, 0 failed**, **18/18 mutations caught**, and the pulse **sampled three
times in the browser** rather than assumed — moving in both themes, `is-missing` proved still.

**A test weakness the mutations caught in my own work.** The first assertion matched
`@keyframes oltEmptyPulse` as a substring, which still passes on
`@keyframes oltEmptyPulseRenamed` — the one rename that kills the pulse while the card looks
correct. The test now reads the name out of the `animation:` declaration and requires a
`@keyframes` block with that name.

---

## 🟢 P2 — Module identity and module colour shipped in 3.9.16 (Sept 20, 2026)

**Why it exists.** 3.9.15 was a faithful swap — each old glyph replaced by the matching
Lucide drawing — and the report back was *"hindi kapansin pansin ang pagbabago sa mga
icons"*. That reading is correct and it is not a fault in 3.9.15: measured by rendering all
45 replaced sites side by side, **about 40 are the same drawing in a different pen** (the old
ones were already Feather/Lucide lineage). Only seven changed shape. So this release changes
what the icons *mean*, not how they are stroked.

**The same report had a second cause, and it was the bigger one.** Measured before answering
it: `git rev-list --left-right --count origin/main...HEAD` → `0 4`, live `version.json` **3.9.15**,
live `sw.js` `gvsi-shell-v3.9.15`, live `styles.css` with **0** occurrences of `bottom-nav-icon`
against local's, live `olt-module.js` byte-identical to local. The module-identity change had
never been pushed, so what was being judged was the 1:1 swap. Then, in the DOM, every resting
glyph measured `rgb(100, 116, 139)` at 22px — all seven the same colour, so shape was the only
carrier of identity, and seven small outlines do not separate at that size.

**One glyph per module, and one place that says so.** `MODULE_ICONS` in `index.html` maps
every module to its drawing, and three surfaces read it: the desktop tab row, the mobile
bottom bar, and the analytics **Module Snapshot** cards. The old set had NODE wearing the same
plain `shield` as the login panel, and NAP/LCP/BACKBONE drawn from shapes shared with
unrelated screens.

| module | was | now |
|---|---|---|
| NAP | `monitor` | `radio-tower` |
| LCP | `layers` | `boxes` — the enclosure that fans a fibre out |
| OLT | `server` | `server` (unchanged) |
| NODE | `shield` | `shield-check` |
| BACKBONE | `link` | `cable` |
| CHARTS / ABOUT / ADMIN | `chart-column` / `info` / `settings` | unchanged, and the ADMIN tab's ⚙️ emoji is now a real icon |

**One colour per module.** Every module now carries its own hue on its glyph **at rest** — the
state seven of the eight tabs are always in — so a module is found by colour instead of by
reading seven outlines. NAP `#0d8a80` · LCP `#4338ca` · OLT `#c026d3` · NODE `#1d4ed8` ·
BACKBONE `#b45309` · CHARTS `#e11d48` · ABOUT `#64748b`, with lighter values in dark mode
because a hue that passes contrast on white disappears on `#0f172a`. Declared once on the
button as `[data-module] { --module-hue: … }` and read by three surfaces: the resting glyph,
the active tab's label and underline, and the active pill.

The hues are **categorical, and deliberately not the `--badge-*` tokens**. Those already mean
*how many are down* on the analytics cards, and a nav tab cannot make that claim — a
permanently red OLT tab would read as "OLT is down right now" on every screen, forever.

**The active tab.** A 10% wash across the whole button became a **pill behind the glyph**, and
the pill now paints in the module's own hue rather than a fixed teal: two pseudo layers using
`currentColor` at 14% and 32%, which is the only way to get hue-and-alpha without `color-mix()`
(too new for the installed devices) or a hand-written rgba pair per module per theme. The old
`--nav-pill` / `--nav-pill-ring` pair is gone — it was one fixed teal, the wrong hue under six
of the seven tabs. Phone glyphs went 20 → 22px.

**Verified.** **195 tests, 0 failed** (3 new in `tests/icons.test.js`), **38/38 mutations
caught** — including the eleven that attack identity and colour specifically — and measured in
the browser in both themes: every glyph resolves its own hue, the active pill is
`rgb(13,138,128)` at `0.14` in light and `rgb(52,211,153)` at `0.14` in dark, and the bars and
the cards still agree on a module's glyph (bar 360/360 at 360px, tab row 747/747 at 747px).

**One defect the browser caught that no test would have.** The shared wrapper rule first used
`color: var(--module-hue, var(--text-muted))`. The ADMIN tab row chip is white on a filled
gradient via `color: white !important` on the *button* and carries no hue, so a literal
fallback repainted its glyph `#64748b` on that gradient. The fallback is `inherit` now, the
chip measures `rgb(255, 255, 255)` in the DOM, and a mutation pins it there.

**Two things the measurements changed.** The first chip (26×22 with a 6px gap) pushed the tab
row to 776px against a 747px window and made it scroll for the sake of padding; 22×22 fits.
And the new test originally iterated `Object.keys(MODULE_ICONS)`, so a module **removed** from
the map stopped being checked — the mutation proved it (dropping `about` survived). It now
walks the union of the map's keys and the names found in the bars, so both directions fail.

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
| `warmDataCaches` | clock, **every 5 min** (was 15) | rebuilds all five modules in one execution; covers what a trigger cannot see — freshness = cadence now |
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

**One of its conditions was removed on Sept 26, 2026.** The app used to fire three of its five module
fetches within 800 ms of each other — three concurrent cold builds against one spreadsheet, which is
exactly the hammering the comments name as the trigger. `?action=bundle` answers all five in one
execution instead, so that burst no longer happens. The 404 itself is untouched and still open: this
narrows when it can occur, and does not fix it.

**Measured from outside, same day — and it is not about a module.** Fifteen module requests on the hit
path answered in **1.06–1.40 s**, which is the bare `?action=rev` floor: the data cost nothing worth
attributing. The failures in that window were Apps Script's 8 KB error page after **7.5 s, 16.0 s and
30.8 s**, and one redirect chain that outlived a 40 s cap. The decisive one is `?action=rev` itself —
**one property read, 80 bytes, normally 1.8 s — taking 16.0 s inside the same window.** A module
cannot slow down a route that reads no sheets, so this is the DEPLOYMENT stalling, and the correct
name for the 21 s 404 is "the same stall, seen on a module route". The number is no longer anonymous;
it is still unfixed.

**And the night's `?action=bundle` / `?action=keepalive` 404s were this stall, not a missing paste.**
`?action=bundle` answers **200, 1.18 s, 3,607 bytes** with a real five-module bundle, and
`?action=definitelynothere` answers `{"error":"Unknown action: …"}` in **1.71 s** — so the dispatch is
reachable and the route table contains bundle. Recorded because "the paste did not happen" and "the
deployment stalled" produce the same 8 KB error page, and one of them would have sent someone to the
Apps Script editor to paste a file that was already there.

---

## 🟢 P2 — The retry that made a stall worse — SHIPPED in 3.9.23 (Sept 26, 2026)

**Shipped in 3.9.23.** `fetchWithRetry` spent its two spare attempts regardless of
how long the failed one took. Against a stall that lasts 30 s and clears inside 60 s, and a backoff of
250–750 ms, attempt 2 was guaranteed to land inside the same stall: three times the wait and three
times the load, on a deployment that was already struggling. Four consecutive OLT requests inside one
stall window all failed; the same request 60 s later answered in 1.48 s.

- The rule: a **failed** attempt that consumed **5 s or more** ends the loop. 5 s is derived, not
  chosen — above the slowest SUCCESSFUL attempt measured from outside (3.23 s) and below the fastest
  failing one (7.5 s).
- An **origin envelope is excluded**: `retryable:true` is the server asking for a retry by name, and
  `build_failed` arrives at build duration, inside the window the rule would otherwise swallow.
- The report says **`origin stalled 30800ms, budget not spent`** and the console says
  `stalled, not retrying`. "Failed after 1 attempt" alone is indistinguishable from a budget that ran
  out, and that distinction is the whole reason the message exists.
- 389 tests across 20 suites, 0 failed; 10 mutations, all caught.

**Owed (server side only):** the pastes in the list below — this part changes no server byte, and the
push it was waiting on has landed.

**Also still owed, and deliberately not guessed:** reading the live `?action=diag` report. It is
admin-gated, there is no credential in the workspace, and the login route has a lockout. One line in
the Apps Script editor produces it without a token:

```js
Logger.log(JSON.stringify(buildDiagReport_(), null, 2))
```

That report holds `failures[]`, `slowLast`, `cache.<type>` and `warmPass.ms`. What is in the working
tree *has* been measured from outside instead — see the numbers above.

---

## 🟢 P2 — The Module Health headers did not sit over their own columns — SHIPPED in 3.9.26 (Sept 26, 2026)

**Reported from the live app with a screenshot** and one question: *“tila'y hindi naka-align yung
data sa column?”* The admin **Module Health** card's header row was left-aligned while every number
under it was right-aligned.

**Why it was worth fixing rather than shrugging at.** Each column stretches to the card's width, so
the label and its value sat at opposite ends of the same column: `10s` floated between `Wait p50` and
`Wait p95` with nothing saying which one it measured. Comparing modules is the whole point of the
card, and the numbers could not be attributed one at a time.

- **The header now carries its own column's alignment** — numeric headers are built over their own
  numbers (`headNum_()`), `Module` stays left because its data is text.
- **Measured, not eyeballed:** in a real browser at the card's width, each numeric header's right
  edge is **0.0 px** from its column's value right edge (it was 41–77 px off).
- **No other table was touched.** The module tables' headers already read left with their data —
  checked against the real stylesheet, not assumed.
- **It was not a broken table.** That same screenshot reports **0 failed calls** on every module and
  waits of 1.0–10 s; NAP's earlier `Error loading data.` row is a cold start with nothing to draw,
  which is what 3.9.25 addresses. The two are independent.
- 22 suites, 0 failed; 3 mutations all caught (one header flipped back, everything flipped left, and
  `Module` right-aligned over left-aligned names).

**Full write-up:** PART-027 in `PLAN_EVIDENCE.md`.

---

## 🟢 P2 — The NAP/LCP bands moved to columns A–F, and the fixture moved with them — done, unpushed (Sept 26, 2026)

`code.gs` in the working tree was changed to read **NAP `A2:F19`**, **LCP aging `A24:F39`**, **LCP
impact `A2:F18`** — from `H2:M19`, `G24:L39` and `G2:K18`. The new Apps Script version is **already
deployed**, so the live server and the repo now disagree, and the change has never been committed.

**The consequence, measured at the time.** `node tests/cache-warmer.test.js` →
*“the pass writes the key an HTTP caller reads, for every type”* fails with *“cache_v2_nap holds
nothing that can be served”*. Its fake sheet put the NAP row in columns H–M
(`tests/cache-warmer.test.js`, the fixture at line ~119) and the two LCP blocks in column G, and the
new ranges never read those columns — so the
warm pass builds an empty payload. **23 suites: 1 failed, and that one is this.** Every other suite
is green, including the new one from 3.9.27.

**Do not fix it by editing `code.gs` back.** The ranges are the truth; the fixture was what was
stale. The fixture half is **done and green**, uncommitted, waiting on the `code.gs` commit:

- [x] `tests/cache-warmer.test.js`: the fake NAP row moved from H–M to **A–F** on sheet row 3, the
      LCP impact row from G–K to **A–E** on sheet row 3, the LCP aging row from G–L to **A–F** on
      sheet row 24 — the rows the two loops actually read (both skip their band's first row as a
      header; LCP aging reads its band from the first row).
- [x] The suite now **parses what the warm pass actually wrote**, per band: `cache_v2_nap` must be a
      non-empty list, and `lcpAging` *and* `lcpImpact` each non-empty. The old length check could not
      see it — a payload of `{"lcpAging":[],"lcpImpact":[]}` is thirty-odd characters, so it passed
      the assertion and every test behind it while the LCP bands read nothing at all.
- [x] 4 mutations caught: NAP back on H–M, impact back on G–K, aging back on G–L, and the impact
      row moved onto the band's header row. **23 suites, 0 failed.**
- [x] Committed **together** as `69fde49` — the ranges and the fixture cannot be split, because a
      test-only commit would leave the committed `code.gs` reading `H2:M19` / `G24:L39` / `G2:K18`
      while the fixture expected the new columns, i.e. HEAD red.
- [ ] Push it: the repo is **one commit ahead of `origin/main`**.

**Related.** The client half of the same change shipped as 3.9.27 (the item directly above) and does
not depend on this one landing first: the filter works against the currently deployed server already.

---

## 🟢 P2 — A row of zeros is not a row of the report — SHIPPED in 3.9.27 (Sept 26, 2026)

**Asked directly.** The NAP and LCP sheet ranges in `code.gs` were widened and a new Apps Script
version deployed, with the follow-up: *“ang magiging adjustment sa site ay dapat hindi ilalabas ng
nap at lcp module ang 0 ang total sa bawat table.”*

**Why the zeros were there.** The bands are fixed row ranges, and the server drops a row only when
its AREA cell is blank. An area with nothing pending is not blank — it arrives as `0/0/0/0` — so the
table drew a line of zeros under AREA / PROVINCE that reads as a count instead of as nothing to
report. The widened bands add a second source: a label row inside the band is kept by the same
non-blank rule, and all of its numeric cells parse to zero.

- **Three tables filter, not two:** NAP aging, LCP aging, and LCP impact — which has no TOTAL column,
  so its rows are judged on TT, LCP and Clients together, and a still-unknown client count cannot hide
  a ticket line that has one.
- **When nothing is left it is said in words:** `No Pending NAP Ticket.` / `No Pending LCP Ticket.`,
  with **no TOTAL line** — every figure under it would be zero, which is the fact being reported.
  That line is a `table-empty-row` class now (`styles.css`), muted and centred, not an inline style.
- **The guard is the computed total, never `row.T`** — both modules already fall back to the sum of the
  components when the sheet's TOTAL cell is zero or blank, and a `row.T !== 0` guard would silently
  delete rows that carry real 24-hour counts on exactly those days.
- **`code.gs` was not touched** and no server-side filter was added; the ask was for the site. OLT,
  BACKBONE and NODE were left alone — they are problem-only by construction.
- **The keep rule still holds over it:** the empty state is a drawn screen, so a refresh that fails
  after it leaves it alone, and a *first* read that fails still says `Error loading data.`
- 15 new cases in `tests/zero-total-rows.test.js`; 6 mutations all caught (guard removed, guard cut to
  `row.T`, empty state made unreachable, impact judged on Clients alone, aging guard removed, copy
  changed); driven in a real browser on a fresh origin — 4 rows in / 3 rows out with cards `6/1/1/8`,
  then the empty states at `colspan` 6/6/5, centred and muted even in the handset card view.

**Full write-up:** PART-028 in `PLAN_EVIDENCE.md`. **Not part of this release:** the server-side row
filter and the `code.gs` ranges themselves — the client filter already handles the deployed server.

---

## 🟢 P2 — A failed refresh blanked the table; it now keeps the last drawn screen — SHIPPED in 3.9.24 (Sept 26, 2026)

**Reported from the live app with two screenshots** and one question: *“sa NAP at BACKBONE kapag
gathering data ang app, nace-clear din ang data na nasa table. Maari bang habang hindi pa lumalabas
ang latest data ay ang last fetched data muna ang nasa display?”* NAP's table read **Error loading
data.** while its stat cards still held the previous read's numbers; BACKBONE showed **All Backbone
Links Operational** with five zeroes.

**The loading state was innocent.** Gathering is already additive — `showModuleLoading()` inserts a
chip and clears nothing. What emptied the tab was the **refresh contract**: `refreshCurrentTab()` and
`backgroundRefresh()` null `dataCache[type]` *before* they ask, so a refresh that failed had nothing
left to draw and fell through to the module's fallback. That screen then stays until the next
success, which is why a later cycle's gather chip appears on top of an already-emptied tab.

- **A failed read keeps what is already drawn** — in NAP, BACKBONE and NODE. LCP and OLT already
  behaved this way (their catch only logs); the rule had simply never been written down.
- **A failure never renders an all-clear.** Those screens claim the fleet is clear *and* stamp the
  current minute as `LAST CHECKED`, and a read that never completed can support neither. On a
  monitoring tool a screen that goes green when it cannot see is the one failure nobody can spot.
- **A tab that has never drawn anything says so:** *“This report could not be loaded. Press REFRESH
  to ask again now.”* (`renderModuleUnavailable()` in `index.html`).
- **`dataCache` keeps its contract** — still emptied by every refresh, and the kept rows are NOT
  written back into it, or a tab click would redraw stale data as though it had just been fetched.
- 401 tests across 21 suites, 0 failed; 4 mutations, all caught; the keep rule also driven in a real
  browser against the local server (rows byte-identical after a stalled refresh, no error row).

**Full write-up:** PART-025 in `PLAN_EVIDENCE.md`. **Related:** the P1 *Instant first paint* item
below is the other half of the same complaint — this one keeps the screen inside a running session,
that one keeps it across a cold start.

---

## 🟡 P2 — Install the triggers in Apps Script

The `triggers.gs` safety fix **is in the repo but has not been pasted into Apps Script**, and nothing changes in the live project until `setupAllTriggers()` is run manually once.

1. Paste the current `triggers.gs`, `olt-cache-warmer.gs`, `code.gs` **and the new `cache-invalidation.gs`**.
2. Run **`warmDataCaches()` once by hand** — nothing but the cache changes yet, and this is the run
   that produces the five per-type build times the interval should be chosen from (PART-012).
3. Run **`listTriggers()`** — read-only drift report.
4. Then run `setupAllTriggers()`. It now expects **`warmDataCaches`**, not `warmOltCache`, and it
   deletes and recreates **every** trigger including the two invalidation handlers — off-peak, for
   that few seconds with no `onEdit`/`onChange` coverage.

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

## ✅ Done (Sept 24, 2026) — the warm pass covers all five modules

**Shipped as PART-012, in the repo and waiting on the Apps Script hand-off.** Before: only OLT was
warmed (`warmOltCache`); the other four relied on real traffic, and every app load already prefetches
all five (`prefetchOtherTabsInBackground`, `index.html:1060`, staggered 400 ms) — so the gap was only
the first request after an idle period. That gap *is* the whole session for an operator who opens
this app for three minutes, checks the picture and closes it.

Now one clock trigger (`warmDataCaches`, every 5 min) rebuilds **all five in one execution** —
`olt → nap → lcp → node → backbone`, sequentially, TTL 180 s each, OLT first because it is the
heaviest and the one a three-second budget can actually miss. `warmOltCache()` still owns `shape=3`
and its own TTL constant, and since **PART-013** it also reports through the same judgement as the
other four (`judgeWarmResponse_`) — so a failed OLT build is named `❌` instead of logged as a
success with a small byte count.

**Measured gain is small.** Same cache key, OLT, 461 rows:

| | time |
|---|---|
| COLD (70 s after expiry) | 2.97 s · 3.21 s |
| WARM | 1.48 s · 1.52 s |
| WARM (best case) | 1.22 s · 1.09 s |

**~1.5–2.1 s saved, against a ~1.1 s irreducible floor** (Apps Script startup + the 302 → `googleusercontent` echo round trip). That floor is why warming is not the lever it looks like.

**What the pass costs, and the retune that is part of it.** Per run, sequentially: ~3.5 s (olt,
measured) + ~1.3 s (nap) + ~1.3 s (lcp) + ~1.8 s (node) + ~1.8 s (backbone) **≈ 10 s**, so
~**46 min/day** at 288 runs — against **90 min/day** on consumer accounts (6 h/day Workspace),
alongside the aging writers and the hourly backbone job at ~10 min/day. **Only OLT's ~3.5 s is
measured; the other four are estimates and the pass log is what replaces them.** Trigger runtime is
the constraint, not request volume, because every run is a full rebuild.

Read the Executions log and set the interval from the arithmetic, not from this paragraph. One line
per type — `✅ warmOltCache: warmed in Nms (N bytes, TTL Ns)` and
`✅ warmCache <type>: warmed in Nms (N bytes, TTL Ns)` — and the run closes with
`✅ warmDataCaches: pass finished in Nms — N of 5 module(s) rebuilt`. Every 10 min halves the cost
and the coverage; every 3 min is ~77 min/day. A module named under `FAILED:` is not warm, whatever
the cadence says: the origin answers a failed build with a 200 and an envelope, which is why the
pass recognises it instead of logging a small byte count over an empty cache.

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
