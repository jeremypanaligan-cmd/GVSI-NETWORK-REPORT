@PlannablePlan v0.1

Part: PART-018 — a failed refresh keeps the screen it already drew
Project: GVSI NetPulse
Phase: 10 (what a failed refresh is allowed to draw)

DICT
  refresh      = the path that ASKS the network even with a payload in hand: `refreshCurrentTab()`
                 (the REFRESH button) and `backgroundRefresh()` (the per-module intervals). Both
                 null `dataCache[type]` first, so the read that follows cannot be a cache hit
  drawn screen = what a module has already put on its tab. For NAP that is rows in `#napTableBody`
                 plus the four stat cards; for BACKBONE and NODE it is the whole tab (stat cards +
                 table), which those modules build with one `innerHTML` write
  keep rule    = a FAILED read does not repaint. The rows on screen are the last read that
                 answered, so nothing on the failure path touches the DOM
  all-clear    = the screen a module shows when its payload has no rows. For BACKBONE and NODE it
                 does not merely omit the incidents — it asserts "All Backbone Links
                 Operational" / "All Node Systems Operational" and stamps the CURRENT MINUTE as
                 `LAST CHECKED`, which is a claim a read that never completed cannot support
  failure      = a rejection out of `fetchGate.run()`: a stalled deployment (see PART-024), an
                 HTTP status, a body that is not JSON, a dropped connection

G
  A refresh that fails stops destroying the screen it was refreshing. Before this part, pressing
  REFRESH on NAP replaced rows that were on screen a second earlier with "Error loading data.",
  and on BACKBONE or NODE it replaced the incident list with an all-clear screen claiming the
  fleet is clear and stamped with the current minute. Both screens then stayed until the next
  success — which is why a later cycle's "Gathering data" chip landed on top of an already-empty
  tab and made the loading state look like the culprit.

CTX
  - Reported from the live app on 2026-09-26 with two screenshots. NAP: table reads "Error loading
    data." while the cards still read 35 / 15 / 1 / 51 — i.e. a previous read HAD rendered, and
    only the table was destroyed. BACKBONE: "All Backbone Links Operational", five zeroes, and a
    `LAST CHECKED` of the moment of the failure.
  - The two frames of that screenshot are NOT simultaneous. `showModuleLoading()` was reworked in
    v3.9.5 to insert a chip at the top of the tab and clear nothing, so a read in flight leaves a
    table alone; the chip is removed by `hideModuleLoading()` in the `finally`. What the screenshot
    shows is the PREVIOUS failed cycle's screen, still standing, with a later cycle's chip on top.
    Without this, the gathering state is where anyone would look first.
  - The cause is a contract, not an oversight: `refreshCurrentTab()` and `backgroundRefresh()` set
    `dataCache[type] = null` deliberately, so the next read goes to the network rather than to a
    payload the renderer may draw without asking. That is also exactly why the failure path had
    nothing left to draw.
  - LCP and OLT already behave the way the user asked for — their `catch` only logs. Three modules
    did not: NAP (error row over the table), BACKBONE and NODE (the all-clear). One rule, two
    behaviours, nothing written down.
  - `renderBackboneEmptyState()` and `renderNodeEmptyState()` are legitimate on a SUCCESSFUL empty
    payload — an empty answer is exactly what those screens are for. The defect is only that a
    FAILED read reached them too.
  - Cold start is the one case with nothing to keep, and it matters here: PART-024 measured Apps
    Script stalls arriving at 7.5 s, 16.0 s and 30.8 s, so "the first read of the session failed"
    is a live scenario, not a thought experiment.

C
  - A FAILED READ KEEPS WHAT IS DRAWN. Nothing on the failure path writes DOM; the operator's scroll
    position and sort state survive a refresh that failed.
  - A FAILURE NEVER DRAWS AN ALL-CLEAR. The two screens that claim the fleet is clear are reachable
    only from a successful empty payload.
  - A TAB WITH NOTHING DRAWN YET SAYS SO. `renderModuleUnavailable(tabName, title)` — a page global
    beside `showModuleLoading()`, because it is a module-state screen and three modules ask for it.
    It keeps the `.page-title-row`, so the freshness chip still has somewhere to attach.
  - THE KEEP FLAG IS NOT READ OUT OF `dataCache`. A module-local `hasDrawn` boolean, set where the
    render happens: every refresh empties `dataCache`, so reading the answer back out of it was the
    bug rather than the fix.
  - THE REFRESH CONTRACT IS UNCHANGED. `dataCache` is still emptied, and the kept rows are still not
    written back into it — a cache hit renders WITHOUT asking, so leaving the payload there would
    let a tab click redraw stale data as though it had just been fetched.
  - KEEPING A STALE SCREEN IS ONLY HONEST IF THE APP STILL SAYS SO. The `console.error` stays, the
    gather chip still clears, and the freshness chip keeps ageing towards `stale`.
  - The release label moves (client bytes changed). The guard does not.

F
  index.html                            renderModuleUnavailable() with its reason; the release
                                        tokens
  nap-module.js                         napHasDrawn; the catch keeps the drawn table, and writes
                                        the error row only when there is nothing to keep
  backbone-module.js                    backboneHasDrawn (set by BOTH the report and the all-clear
                                        render, because an all-clear is a drawn screen too); the
                                        catch hides the chip and keeps the tab
  node-module.js                        the same, for the tab where a missed incident matters most
  tests/module-refresh-keep.test.js     12 cases over the three modules, loading the page's REAL
                                        module-state helpers out of index.html
  sw.js                                 the cache generation
  plans/PART18_PLAN.ai.md               this artifact
  MASTER_PLAN.md                        Part 18, SCN-021
  PLAN_EVIDENCE.md                      PART-025
  TODO.md                               the fix recorded, the push item closed, and the related
                                        cold-start item cross-referenced
  .freebuff/run.md                      the browser recipe for driving a module's failure path

T
  1. The keep flag and the guarded catch in each of the three modules.
  2. renderModuleUnavailable(), bounded by the reason it is not the empty state.
  3. The twelve cases, including the three that guard against over-correcting.
  4. Version bump 3.9.23 -> 3.9.24, guard untouched at 3.10.0.

VALIDATION
  - NAP: rows drawn, then a refresh that fails, leaves the table byte-identical and free of the
    error row.
  - NAP: a refresh that fails leaves `dataCache.nap` empty, so the next read still goes to the
    network — the keep rule must not be implemented as a stale cache.
  - NAP: a FIRST read that fails still writes the error row. That is the one case with nothing to
    keep, and the row is the honest screen there.
  - NAP: the gathering chip is present while the read is in flight and gone once it has settled,
    whichever way it settled.
  - BACKBONE / NODE: a refresh that fails keeps the report and does NOT become an all-clear.
  - BACKBONE / NODE: a FIRST read that fails does not invent an all-clear; it says the report could
    not be loaded.
  - BACKBONE / NODE: an all-clear that came from a real read is left byte-identical — repainting it
    would re-stamp its check time to now, the same false claim in a quieter form.
  - A sentinel marker appended after a successful draw, because re-rendering the same rows produces
    the same bytes: byte-equality alone cannot tell a repaint from a no-op.
  - Mutation pass on a green baseline: NAP's keep rule disabled (`if (true)`), BACKBONE rendering the
    all-clear again, NODE rendering the all-clear again, and `backboneHasDrawn` never set — all four
    caught.
  - Driven in a REAL browser against the local server as well as in the vm: NAP kept 3 rows
    byte-identical after a rejecting read with the chip cleared and `dataCache.nap === null`;
    BACKBONE and NODE with nothing drawn showed the unavailable state and no all-clear.
  - The failure shape used in the browser is `httpbingo.org/drip?duration=7&numbytes=8` (200, ~9 s,
    `text/plain`, so `res.json()` rejects). `httpbingo.org/delay/8` looks like the same instrument
    and is not — it returns JSON, so in-browser it SUCCEEDS.

DONE
  Built, tested, mutation-checked and browser-checked in the repo, 2026-09-26. 21 suites, 401 cases,
  0 failed (389 -> 401). 4 mutations for this part, every one caught.

  - No server byte changed, so nothing here depends on a paste; the pastes owed by PART-024 are still
    owed, and they are the backend half of the same complaint.
  - The cold-start half is NOT done and is not pretended to be: a tab that has never drawn anything
    still has nothing to keep, and says so instead. Persisting `dataCache` across a reload is the
    open P1 item in TODO.md, and a failed first read is exactly the case it would cover.
