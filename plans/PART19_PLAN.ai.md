@PlannablePlan v0.1

Part: PART-019 — the last session paints the first frame
Project: GVSI NetPulse
Phase: 11 (the cold start, and what it may show before it knows)

DICT
  cold start   = a launch with an empty `dataCache`, which is every launch: the cache is
                 in-memory only, so nothing survives the tab. The first render therefore waits on
                 the network, and against a stalled deployment (~7.5 s to 30.8 s, PART-024) that
                 wait ends in a failure with nothing to fall back on
  snapshot     = the last good payload of each module, written to localStorage as the post-decode
                 state each module reads: `dataCache[type]` for all five, plus `oltMeta` with the
                 OLT rows. Stamped with the moment each payload was FETCHED, per type
  honest age   = the age of that stamp, judged against the interval the app already refreshes that
                 module on. nap 60 min, lcp 30, olt 15, node 10, backbone 10
  carry-over   = a type the page is NOT holding is taken from the previous snapshot at its own
                 stamp rather than dropped, because a failed refresh leaves its `dataCache` slot
                 empty and a snapshot at that moment would otherwise erase the only copy
  first frame  = what is on screen synchronously after `loadInitialData()` is called, before any
                 request has settled

G
  A launch that cannot reach the deployment draws the last session's data instead of the
  "could not be loaded" screen, with a freshness chip that reports how old that data really is,
  and a store that can never be the reason the app fails to start or shows something untrue.

CTX
  - The complaint this closes is PART-025's, half of it: *"habang hindi pa lumalabas ang latest
    data ay ang last fetched data muna ang nasa display"*. PART-025 made a FAILED read keep the
    screen it has; a cold start has no screen yet, so this is the remaining half. It was already
    planned as TODO.md's P1 item *Instant first paint (persist `dataCache`)*, with the measured
    payload sizes (nap 718 B, lcp 488 B, node 2 B, backbone 2,080 B, olt 643 B — ~3.9 KB total), and
    it says why localStorage and not IndexedDB: `getItem` is SYNCHRONOUS, so the payloads are in
    memory before the first paint; IndexedDB would trade a synchronous read for an asynchronous one
    and make the paint LATER.
  - The refresh contract is the trap in the middle of this. `refreshCurrentTab()` and
    `backgroundRefresh()` set `dataCache[type] = null` BEFORE they ask (PART-025), so the 30 s
    writer can land in a window where the page holds nothing for that type — and a writer that
    replaces wholesale then deletes the copy the next launch needs, precisely when the read failed.
  - OLT is the one module whose rows and totals come from different places: the list reads
    `dataCache.olt` / `rawOltData`, the cards read module-level `oltMeta`, and OLT's cache-first path
    re-renders from `dataCache.olt` WITHOUT restoring meta. Rows without meta are therefore a silent
    mismatch (cards computed from a different source than the table), not a cosmetic one.
  - A stamp in the FUTURE is worse than no stamp: date arithmetic makes it a negative age, so an
    entry written by a clock running ahead (or read by one that moved backwards) would never expire
    and would be redrawn as "fresh" on every launch, forever.
  - A restored payload arrives with the fetch time of the PREVIOUS session, and `fetchGate.lastFetchAt`
    is in-memory. Without seeding it, the chip renders "No data yet" over a table full of rows.
  - Storage fails in ways that are normal on a phone: Safari private mode throws on the accessor
    itself, quota errors arrive on write, and a value can be corrupt or from another schema.

C
  - SYNCHRONOUS OR NOT AT ALL. localStorage, because the restore has to be finished before the first
    paint. The size is measured, not assumed.
  - THE FIRST FRAME DOES NOT WAIT FOR THE OPENING REQUEST. The visible tab is drawn from the
    snapshot before `bootFromBundle()` is awaited; waiting would deliver the restored data at the
    exact moment it was meant to replace. One background refresh for the visible tab is the price,
    and the gate joins and throttles it.
  - AN ENTRY IS JUDGED BY ITS OWN AGE, PER TYPE, against the interval the app already refreshes that
    module on. Expired entries are dropped one by one, so one stale module cannot cost the other four.
  - A STAMP IN THE FUTURE IS UNUSABLE, not infinitely fresh.
  - THE AGE IS NEVER RESET. A kept entry keeps its own stamp across sessions, so a payload that is
    never refreshed ages out instead of reading as new on every launch.
  - A TYPE THE PAGE IS NOT HOLDING IS CARRIED OVER, at its own stamp. A failed refresh may not cost
    the next launch its only snapshot.
  - ROWS WITHOUT THEIR META ARE NOT STORED. OLT is written and restored with `oltMeta` or not at all.
  - THE CHIP IS TOLD THE TRUTH. `fetchGate.seedLastFetch(type, at)` restores the fetch time and only
    ever moves the stamp backwards; OLT's server build stamp rides inside the payload, so the chip
    reports the age of the DATA rather than of the fetch.
  - STORAGE FAILING IS THE SAME ANSWER AS NOT HAVING THIS FILE. Private mode, quota, corrupt value,
    schema mismatch, no localStorage — each degrades to the previous behaviour and never throws into
    the load path.
  - AUTH ORDERING IS UNCHANGED. The restore sits in `loadInitialData()`, which is reached only from
    `showApp()`, gated on `isLoggedIn()`.
  - ONE USER'S SNAPSHOT IS NOT THE NEXT USER'S. Cleared on logout, and by the version guard's wipe.
  - The release label moves (client bytes changed, and `cache-store.js` is a new precache entry).
    The guard does not.

F
  cache-store.js                   new: the store, its one age table, the per-type parse, the
                                   carry-over writer, the restore, the 30 s/pagehide writer and
                                   the logout clear
  fetch-gate.js                    seedLastFetch(): the fetch time of a payload that came from
                                   storage, never moving the stamp backwards
  index.html                       the script tag; restoreModuleCache() at the top of
                                   loadInitialData(); the immediate render of the visible tab; the
                                   writer started once per page; the logout clear; the release
                                   tokens
  sw.js                            cache-store.js in STATIC_ASSETS, and the cache generation
  tests/cache-store.test.js        new: 21 cases
  tests/fetch-gate.test.js         three cases for seedLastFetch
  plans/PART19_PLAN.ai.md          this artifact
  MASTER_PLAN.md                   Part 19, SCN-022
  PLAN_EVIDENCE.md                 PART-026
  TODO.md                          the P1 item closed as shipped, with what changed against it
  .freebuff/run.md                 how to drive a cold start with a stalled opening, by hand

T
  1. The store: key, schema version, one age table, per-type parse, and the four failures swallowed.
  2. seedLastFetch(), because a restored table reporting "No data yet" is the same lie in reverse.
  3. The restore: dataCache, OLT's three parts, the build stamp, and the gate's clock.
  4. The writer: carry-over, and no write when there is nothing to say.
  5. The three call sites in index.html, including the first-frame render.
  6. `./cache-store.js` in the precache list and the release label moved with it.
  7. Version bump 3.9.24 -> 3.9.25, guard untouched at 3.10.0.

VALIDATION
  - A cold start whose opening request NEVER settles draws the restored rows in the first frame, with
    BENGUET in the table, and the chip reading the stored age.
  - The gate is seeded with the stored fetch time per type; OLT's build stamp is restored too, so its
    chip reports the data age.
  - An entry past its own cap is not restored, and one stale type does not cost the others.
  - The cap boundary is inclusive at the cap, exclusive one millisecond past it.
  - A stamp in the future is refused.
  - A corrupt value, an unknown schema and a missing types map each read as empty rather than
    half-read.
  - A payload with no honest fetch time is not written, and neither is one with a null payload.
  - OLT rows without meta are neither written nor restored, including a value smuggled in another way.
  - A refresh that FAILED does not erase the stored snapshot of the module it failed on, and the
    carried-over entry keeps its original age rather than being re-stamped as fresh.
  - The carry-over still ages out by its own cap.
  - With nothing held and nothing usable stored, storage is left untouched.
  - The three storage failures (throwing accessor, quota on write, no store at all) each fail open,
    and a failed write leaves the previous snapshot alone.
  - clear() removes the key, and start() writes on the timer and on both unload events.
  - Driven in a REAL browser on a fresh origin, with the numbers recorded in PART-026: first frame,
    chip text, seeded stamp, OLT meta/rows/stamp, then a failed refresh keeping the screen and the
    writer keeping the copy.
  - Mutation pass on a green baseline: fifteen mutations, all caught, plus one attempted mutation
    that was a no-op rather than a gap.

DONE
  Built, tested, mutation-checked and browser-checked in the repo, 2026-09-26. 22 suites, 425 cases,
  0 failed (401 -> 425). 15 mutations for this part, every one caught.

  - One assertion was found to be VACUOUS by that pass (the carry-over test did not advance the
    harness clock, so "kept the age" and "re-stamped as fresh" produced the same number). It is a
    real assertion now, and the mutation that would have passed it is caught.
  - No server byte changed. The pastes owed by PART-024 are still owed, and nothing here depends on
    them.
  - Deliberately NOT done: nothing reads the snapshot before login (see C), and the store holds no
    payload older than the app's own cadence would have replaced.
