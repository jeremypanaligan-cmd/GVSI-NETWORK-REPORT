@PlannablePlan v0.1

Part: PART-016 — the client half of the diagnostics: what THIS phone waited on
Project: GVSI NetPulse
Phase: 7 (module diagnostics, second half)

DICT
  sample      = one API call as this device experienced it: when, how long it waited,
                how many attempts it took, whether it worked, and what the edge said
  the edge    = the Cloudflare worker in front of Apps Script. It already measures every
                call and publishes `x-netpulse-origin-ms` (how long the origin attempt
                took) and `x-netpulse-attempts` (1 = first try), exposed to JS through
                `access-control-expose-headers`
  wait        = what the operator actually experiences: attempts x (floor + build + retry
                backoff), not the origin's build time
  overhead    = client wait MINUS edge origin-ms. The part of the wait that is the phone
                and the network rather than Apps Script — the number no server-side
                report can ever contain

G
  When an operator says "ang tagal ng data", the answer stops being a guess about which
  module is slow: the admin screen names the module, how long this device waited for it,
  how much of that was the origin, how many attempts it took, and what failed — from memory,
  with no new request and no polling.

CTX
  - PART-014/021 shipped the SERVER half. It answers "which module misbehaved, on which
    sheet, at which stage" from `?action=diag`. It cannot answer what this phone waited,
    because it never sees the phone.
  - The edge already measures the split and nothing reads it. `proxy/netpulse-proxy.mjs`
    sets `x-netpulse-origin-ms` and `x-netpulse-attempts` on every response and already
    exposes them to JavaScript; `grep` finds no reader anywhere in the app.
  - `fetchWithRetry()` (index.html) is the single client choke point: every module call,
    every admin call and every auth call with a token goes through it, and it already
    counts attempts by hand.
  - The proxy is DISABLED right now (`window.NETPULSE_PROXY = ""`, 2026-09-15), so those
    two headers are ABSENT on every live call. That is the design constraint that decides
    the whole card: the edge numbers are the best half of the answer and today they do not
    exist, so the card must be useful without them and must SAY they are missing rather
    than print a zero. A 0 ms "origin time" would be the silliest lie in this file's
    history.
  - `sw.js` still carries `API_PROXY_HOST = 'holy-cloud-1d7a...'` while index.html's
    `NETPULSE_PROXY` is blank, and its own comment says the pair must move together.
    Recorded, NOT fixed here: with the proxy off the constant is inert, while DELETING it
    while a human re-enables `NETPULSE_PROXY` is the direction that is actually dangerous
    (a cache-first branch would hand a wall display a stale outage). Leaving it set is the
    safe side of the drift; the comment already names the pair.
  - A first attempt at this feature was reverted (`i-undo lahat ng pagbabago 9:51pm`) after
    it put a `PropertiesService` read on the server's success path. The lesson carried
    across: a diagnostic is only acceptable when it is free on the path it watches, which
    here means in-memory, bounded, and unable to fail.

C
  - THIS DEVICE, THIS SESSION, IN MEMORY. No localStorage, no IndexedDB, no sending
    anything anywhere. A persisted history would survive the "Refresh & Sync App" wipe,
    go stale, and become another silent lie about the present — which is the failure this
    project keeps paying for. Reloading the app is a legitimate way to get a clean slate.
  - BOUNDED BY CONSTRUCTION. 20 samples per label, 24 labels, and a `dropped` counter that
    is SHOWN. An unbounded diagnostic on a phone is a memory leak with a reassuring name.
  - THE RECORD CANNOT FAIL THE THING IT WATCHES. `record()` is total: any input, any
    missing global, any hostile getter, and it returns instead of throwing — and the call
    site guards the store's existence too. A diagnostics fault must never turn a working
    request into an exception the module reports as no data.
  - NO SECRET EVER ENTERS A SAMPLE. The label is the `type` or the `action` only: never
    the URL, never a query string, never a token or a password. The URL the app builds for
    login literally carries the password, so this is asserted by a test that records such
    a URL and then searches the whole snapshot for it.
  - THE LABEL IS THE QUESTION'S NAME. `?type=lcp` -> `lcp`; `?action=diag` -> `action:diag`;
    anything else -> `other`. Deriving it from the request the app actually made means the
    card needs no per-module wiring, and a module added later shows up on its own.
  - THE CLIENT MEASURES WALL CLOCK, THE EDGE MEASURES THE ORIGIN, AND THE CARD SHOWS BOTH
    PLUS THE DIFFERENCE. Wall clock is the only number that is always available; the
    subtract is the only number that separates "Apps Script is slow" from "this phone's
    network is slow", and it is why the two halves of this feature are worth having
    separately.
  - NO NEW REQUEST, NO POLLING, NO TIMER. The card renders from memory when the admin
    opens the tab. "Refresh" re-reads memory, it does not refetch. This is the same rule
    the background question was answered with.
  - NO `?v=` OR PROXY CHANGE. The release label moves because client bytes changed; the
    worker is not redeployed and no query parameter is added.

F
  diag-store.js             new. The bounded store, the label rule, the summary maths and a
                            copyable snapshot. Loaded before index.html's page script so
                            fetchWithRetry can see it
  index.html                the script tag; the sampling call at both exits of
                            fetchWithRetry (success and give-up) and the two header reads;
                            the release tokens
  admin-module.js           the Module Health card in renderAdminTab(), admin-only like the
                            tab itself, with Refresh / Clear / Copy report
  sw.js                     diag-store.js in STATIC_ASSETS; the cache generation
  tests/diag-store.test.js  new. The store's bounds and maths, the never-throw rule, the
                            no-secrets rule, and the wiring assertions that read index.html,
                            admin-module.js and sw.js as text
  plans/PART16_PLAN.ai.md   this artifact
  MASTER_PLAN.md            Part 16, SCN-019
  PLAN_EVIDENCE.md          PART-023
  TODO.md                   the client half moves from "not done" to built, and the
                            paste/push step gains the third file
  .freebuff/run.md          how to read the card, and what the two header names mean

T
  1. The store: bounded ring per label, total record(), summary with p50/p95, snapshot.
  2. The label rule, and the assertion that no sample can carry a secret.
  3. fetchWithRetry: wall clock, attempt count, the two header reads, and a record at both
     exits.
  4. The Module Health card, rendered from memory on tab open, with the honest "edge timing
     unavailable" state the disabled proxy requires.
  5. STATIC_ASSETS and the assertion that every local <script src> in index.html is in it.
  6. Version bump 3.9.21 -> 3.9.22, guard untouched at 3.10.0.

VALIDATION
  - Store: p50/p95 exact on a known set; one sample p95 = that sample; the ring drops the
    OLDEST and counts what it dropped; the label cap evicts oldest-first; summary of an
    empty store is an empty list, not a crash.
  - record() with: undefined url, null sample, a non-numeric ms, a getter that throws, a
    10 KB error string. Every one returns, none throws, and the error text is truncated.
  - No secrets: a URL carrying `password=` and `token=` produces a snapshot in which neither
    value appears.
  - Overhead: a sample with ms 6000 and originMs 1200 reports 4800, and a sample with no
    edge headers reports null rather than 0 — and the summary counts how many samples had
    edge timing, so "no data" is distinguishable from "0 ms".
  - Wiring, read as text: index.html calls diagStore.record from inside fetchWithRetry and
    reads both header names; admin-module.js renders the card; sw.js precaches the file.
  - STATIC_ASSETS covers every local script tag in index.html — the invariant that
    currently depends on a human remembering.
  - Mutation pass: every new assertion gets a mutation it catches, on a green baseline.
  - From outside: load the app, open Admin, and read the card against a known module (LCP);
    then the same card after a paste, where the numbers must move and nothing else should.

DONE
  Built, tested and mutation-checked in the repo, 2026-09-26. 20 suites, 384 cases, 0 failed
  (336 -> 384). 38 mutations attempted and every one caught.

  It was also LOOKED AT, which is not the same as being tested. Rendered in a browser against
  the real styles.css, the first version had ten columns and pushed Retries, Failed and the age
  off the right edge behind a horizontal scroll — on the very screen the card is read from, and
  invisible to every text assertion. Calls folded into the module cell ("backbone · 7"), Worst
  moved to the p95 title, the edge column titled rather than spelled out: eight columns, nothing
  lost, and a screenshot is what found it.

  Two defects the suite found, and neither was in the feature's happy path:

    - tests/origin-resilience.test.js lifts the real fetchWithRetry out of index.html by line
      slicing, and adding the two helpers ABOVE the function broke it — which was the finding
      rather than the noise. The recording call sits inside the try that decides whether to
      retry, so the resulting ReferenceError was caught as an origin failure, spent three
      attempts, and ended with the module reported as having no data for a request that had
      SUCCEEDED. A diagnostic breaking the thing it measures is the one thing this part may
      not do, so the guard now lives at the call site as well as inside the store, the slice
      starts at the hooks so it cannot silently test a client this app does not have, and a
      new test drives a store whose record() throws.
    - the label whitelist and the case fold composed wrongly: lowercasing the value and then
      stripping everything outside [a-z0-9:_-] would have renamed action:setMaintenance to
      action:etaintenance. A mangled name is worse than two spellings of one, because only the
      intact one is visible on the card.

  The card is also DRAWN in a test — admin-module.js runs in a sandbox with a stand-in
  document and the assertions read the DOM — because reading a template is how a card ships
  with an undefined column that renders as a dash and looks like "no data".

  The release folds two parts: 3.9.21 was never pushed, so the label moved once to 3.9.22 and
  one push delivers the bundle, the TTL and this card.

  - The two reverted-attempt hazards are both closed by construction: nothing is written to
    the server, and nothing is written to storage.
  - Deliberately NOT here: merging the server's `?action=diag` into the same card. It is a
    request, and this card's rule is that opening the tab costs nothing. The two reports are
    read side by side instead.
  - Deliberately NOT here: the 21 s origin 404, still the largest single source of a bad
    experience. The card will now be able to SEE it (attempts > 1, wall clock >> origin),
    which is the first step.
