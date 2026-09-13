# Test suites

Three suites, all browser-free and network-free:

- **Backend** — `code.gs` (routing + the caching layers) and `admin.gs` executed
  for real in a Node `vm` context against fake Google service globals.
- **Front-end script order** — a static check over the scripts `index.html`
  actually loads, for the temporal-dead-zone bug class that has shipped twice.
- **OLT payload shape** — the real encoder in `code.gs` and the real decoder in
  `olt-module.js`, run against each other, because nothing else would notice if the
  two halves stopped agreeing.

## Running

```bash
node --test            # from the repo root, runs tests/*.test.js (all three suites)
node --test tests/code.gs.test.js        # backend only
node --test tests/inline-order.test.js   # script order only
node --test tests/olt-payload.test.js    # payload round trip only
node --test --test-name-pattern="TTL"    # filter by test name
```

There is no `package.json` and nothing to install: the suite uses only Node
built-ins (`node:test`, `node:assert`, `node:vm`, `node:crypto`, `node:fs`).
Requires Node 18+; developed against Node 24.

**Nothing runs this automatically.** There is no CI and no git hook, so the check
only protects the app if `node --test` is run before a commit that touches a
`<script>` file. Run it.

## Layout

| File | Purpose |
|---|---|
| `gs-harness.js` | The fake Apps Script runtime (`createHarness`) |
| `code.gs.test.js` | The suite — 98 tests across routing, caching, data shapes, the compact OLT payload, admin, session tokens, session-lookup cost, and harness fidelity |
| `inline-order.js` | The script-order analyser (no tests of its own; used by the file below) |
| `inline-order.test.js` | 18 tests — the app-clean gate, reproductions of both historical bugs, and the rule cases |
| `olt-payload.test.js` | 9 tests — the encoder/decoder round trip and the decoder's own edges |

## Usage

```js
const { createHarness } = require('./gs-harness');

const h = createHarness();          // loads code.gs + admin.gs by default

h.sheet('NLZ NAP Report').setGrid(3, 8, [['AREA', 'PROV', 3, 2, 1, 6]]);
const res = h.doGet({ type: 'nap' });   // -> { text, mimeType, json, raw }

h.cache.puts;        // [{ key, seconds, size }] — every CacheService.put, with its TTL
h.cache.ttlFor('cache_v2_olt');   // TTL of the most recent write to a key
h.props.getKeys();   // current script properties
h.sheetReads();      // total getValues() calls — how a cache hit is proven
h.sleeps;            // ms passed to Utilities.sleep(), in call order
h.clock.advanceSeconds(120);      // move time forward
h.call('sha256', 'secret');       // invoke any top-level .gs function
h.context;                        // escape hatch: the raw vm context
h.reset();                        // fresh context + brand-new fake services
```

### Methods

- `doGet(params)` — calls `doGet({ parameter: params })` and returns
  `{ text, mimeType, json, raw }`. `json` is `undefined` if the body isn't JSON.
- `call(name, ...args)` — invoke any function declared in a loaded `.gs` file.
- `sheet(name)` — get-or-create a sheet for seeding. `findSheet(name)` looks up
  without creating (null when absent), which is how "the sheet is missing" paths
  are tested.
- `reset()` — **replaces** the fake services and rebuilds the vm context. It
  replaces rather than clears on purpose: a test that stubs a method (say, to
  simulate a CacheService outage) cannot leak that stub into later tests, which
  would otherwise silently skip whole branches of `doGet`.

### Options

```js
createHarness({
  files: ['code.gs', 'admin.gs', 'ExtractOLT.gs'],  // extra .gs files share one global scope
  timeZone: 'Asia/Manila',                          // what Session.getScriptTimeZone() returns
  now: Date.UTC(2026, 8, 12, 12, 0, 0)              // starting clock
});
```

## What is faked, and where the fidelity matters

- **Sheets** support both A1 ranges (`'G24:L39'`) and grid ranges
  (`row, col, numRows, numCols`), plus the 1/2/3/4-argument overloads of
  `getRange`. Empty cells read back as `''`, as Apps Script does.
- **`CacheService`** entries really expire, and every `put` records its TTL, so
  the per-type TTLs (60s / 180s) are asserted rather than assumed.
- **`PropertiesService`** has no TTL — matching Google — so the app's
  hand-rolled timestamp expiry is genuinely the thing under test. It also **counts**
  its calls (`h.props.reads` / `h.props.writes`), because Apps Script meters
  *Properties read/write* against a **daily quota** — a session lookup whose cost
  grows with the number of stored sessions is an outage risk, not a style nit.
- **`Utilities.computeDigest`** returns **signed** bytes (`-128..127`). That is
  the quirk `admin.gs`'s `sha256()` compensates for; returning unsigned bytes
  would hide a real hashing bug, so the harness reproduces it.
- **`Utilities.formatDate`** honours the time zone argument instead of assuming
  UTC, so the script time zone can be pinned or varied.
- **`Utilities.getUuid`** returns a unique, UUID-shaped value, so token minting is
  exercised through the real code path rather than a stub.
- **`Utilities.sleep`** is *recorded, never performed* (`h.sleeps`). The login
  throttle can therefore be asserted — that a failure genuinely waited, and that a
  locked-out attempt did not — without the suite paying the wall-clock cost.
  Like the other fakes it is recreated by `reset()`, so recorded sleeps cannot
  leak into the next test.
- **The clock** drives `new Date()` and `Date.now()` inside the context, which is
  what makes the expiry tests deterministic instead of timing-dependent.

## Session-token coverage (P1)

Five suites cover the auth layer, and they are meant to be read alongside
`GVSI_NetPulse_Auth_Notes.md`:

- **`session tokens`** — minting, server-side storage (`u`/`name`/`role`/`exp`),
  role and username normalisation, two logins minting two distinct valid tokens.
- **`route gates`** — that enforcement is the **shipped default** (a tripwire: if
  `REQUIRE_SESSION` is ever set back to `false`, the suite fails rather than
  silently reopening the four write routes), every gated route refusing a
  tokenless caller *and* a bogus token without touching a sheet, and the test that
  proves the point of the whole change: a valid admin token with `?admin=Forged`
  still writes **the token's** username into `UpdatedBy`. A viewer token is
  refused for admin-only routes without even reading a sheet. The rollout switch
  is flipped per-test via `h.context.REQUIRE_SESSION` (it is a `var` in the vm
  context, and `reset()` reloads `admin.gs`, so the default is restored before
  every test) — one test covers the switch-off path, including that it reopens
  the route but **never** revives the forgeable `?admin=` name.
- **`revocation, expiry and pruning`** — logout revoking and a replay failing,
  expiry at the boundary, corrupt and stamp-less payloads treated as expired, and
  a **login** sweep that removes dead sessions without touching `cache_v2_*`.
- **`session lookup cost`** — the suite that keeps the auth layer affordable, and
  the reason to run it before adding a gate to a new route. Apps Script meters
  *Properties read/write* at **50,000/day** on a consumer account, and heartbeat
  alone is **1,440 requests/day per signed-in client**. The expiry sweep is
  O(stored sessions) — `getKeys()` plus one read per `session_*` key — so it must
  not sit on the request path. These tests pin a gated request to **exactly one**
  property read, prove the number does **not** move when the store goes from 1 to
  26 sessions, prove a request sweeps nothing while a login does, and prove a
  stale token presented on its own is still deleted immediately. Measured
  before/after with this harness and the same input: a heartbeat went from
  **N + 3** reads to a flat **1** (−92% at 10 stored sessions, −97% at 26) —
  **41,760 → 1,440** property operations per client per day.
- **`login throttling`** — 5 failures locking the username out (the *correct*
  password is refused too, and no sheet is read), the window lapsing, the counter
  resetting, and the recorded sleeps growing then stopping at the cap.

As with the cache work, the suite was **mutation-tested** rather than trusted
because it was green: disabling the role check, the `UpdatedBy` override, the
expiry check, the invalid-token rejection, or the prune prefix filter each fails
at least one test.

## Script order — the temporal-dead-zone check

`inline-order.js` answers one question: **is any top-level `const`/`let`/`class`
read by a statement that runs before it initialises?** That throws

```
ReferenceError: Cannot access 'X' before initialization
```

at first paint, and *only* at first paint — calling the same function from the
console afterwards works fine, which is what makes it invisible to manual
testing. It has shipped twice: `dataCache` (read from `cache-control.js`'s
`getDataCache()`, reached from the top-level `checkAppVersion()` call above its
declaration) and the module-skeleton table (read by `fetchNapData()`, reached
from `checkMaintenanceAndLogin()` above it). Both readers lived in a separate
file, so the check walks **every script the page loads, in load order**, not just
the inline block.

It is an approximation, not a parser, and it is deliberately conservative — it
under-reports rather than crying wolf. What it gets right, and how:

| Case | Verdict |
|---|---|
| Top-level `const` read by a top-level call above it | **flagged** |
| Same, through a chain of functions, or across files | **flagged** |
| Through a property call (`netpulseCache.invalidateAll(`) into an IIFE file | **flagged** — the IIFE body counts as top level |
| Read that only happens after an `await` | not flagged — a microtask resumes once the script's top level has run |
| Read inside `try { … } catch (…) { … }` | not flagged — the error is caught; this is the documented workaround |
| Read inside `try { … } finally { … }` | **flagged** — `finally` has no `catch`, so it still escapes |
| Read of a name the function shadows locally | not flagged |
| Callback handed to `setTimeout` / `addEventListener` / `.then(` | not flagged — it cannot run during evaluation |
| Declaration in a script that has not been evaluated yet | **flagged** — microtasks drain *before* the next script runs |

Known false negatives (documented in the file rather than hidden): calls through
a computed key, and an IIFE written as an anonymous function expression that is
not obviously invoked. Known false-positive risk: a name that is only mentioned
in a single-expression arrow that is never called.

The two tests that matter most are `the shipping app has no temporal-dead-zone
reads` (the gate) and the two reproductions of the historical bugs. Each
historical bug is re-introduced **in its real shape** — the real file, the real
call chain — and the suite fails if the checker stops seeing it. A checker that
cannot fail on the bug it exists to catch is worse than none, because it reads as
coverage.

## OLT payload shape — the two sides together

OLT was 96.9% of every API byte the app moved: 461 rows x 9 fields, 50,179 bytes, of
which the repeated field names alone were 14,291. `shape=2` sends province and
municipality as indices into two dictionaries and each row as a positional array whose
field order travels in the payload's own `f` array — 26,304 bytes, same 461 rows.

That is a contract between two files in two languages of implementation, and until
this file it was a contract nothing checked. `compactOltRows()` in `code.gs` and
`decodeOltPayload()` in `olt-module.js` could stop agreeing without a single test
turning red: a swapped field order or an off-by-one dictionary would not throw, it
would quietly render the wrong province against every OLT.

So `olt-payload.test.js` runs the **real encoder** through the harness, feeds its
output to the **real decoder** loaded out of `olt-module.js`, and asserts the result is
identical to the legacy payload for the same sheet — compared as serialised JSON, so
it also pins the key order (a decoded row is indistinguishable from a legacy row, not
merely equal to it). The seed includes what the live sheet has: repeated provinces, a
down row, an up row, and dictionary values that differ per row.

The remaining tests cover the decoder's own edges — a legacy array passing through
untouched, an unknown `v` returning `null` rather than guessing, a missing `f`/`r`, a
ragged dictionary index degrading to a blank cell, and the payload not being mutated.

## Limits — what this deliberately does not cover

- **No real Google services.** Rate limits, quotas, cold starts, and Apps Script's
  own 100 KB `CacheService` ceiling are not modelled; the size thresholds are only
  exercised as they appear in `code.gs` (90 KB / 450 KB).
- **Only the backend, with two small exceptions.** `index.html`, the rest of the
  `*-module.js` files, the service worker, and the deployed endpoint are out of scope,
  and nothing here proves the live web app behaves as tested. The exceptions: `inline-order.js`
  is **static analysis only** — it reads the scripts, it does not run them, so it says
  nothing about runtime behaviour beyond declaration order — and `olt-payload.test.js`
  *does* execute `olt-module.js`, but only `decodeOltPayload`, in a bare context with no
  DOM, no `fetch` and no other app code. Everything else in that file is untested.
- **Synchronous invocation.** `doGet` is called directly; trigger and
  installable-trigger behaviour (`triggers.gs`) and `LockService` are not modelled.
- **Contract-level only.** These tests pin the behaviour of *this* code. If Google
  changes an underlying API semantic, the fakes will keep agreeing with the old
  contract.
- Extra `.gs` files are opt-in via `files`. `ExtractOLT.gs`, `ExtractNodeDown.gs`,
  `ExtractLinksinBB.gs`, `AgingDurationCol*.gs`, `triggers.gs` and
  `autoBackupsheet.gs` are **not** loaded by default and have no coverage yet.

## Adding a test

```js
test.beforeEach(() => { h.reset(); });

test('my case', () => {
  h.sheet('Node DOWN Tickets').setGrid(2, 1, [row]);
  const res = h.doGet({ type: 'node' });
  assert.equal(res.json.length, 1);
});
```

Seeding helpers at the top of `code.gs.test.js` (`seedNap`, `oltRow`,
`nodeRow`, `backboneRow`, …) position values by column index so the tests read
against the documented sheet layout rather than a wall of empty strings.

Because `reset()` gives every test a private harness, tests may stub the fake
services freely — for example `h.cache.get = () => { throw new Error('down') }`
to exercise the degraded-cache path.
