# Backend test harness

Tests `code.gs` (routing + the caching layers) and `admin.gs` **without deploying
to Apps Script**. The `.gs` files are executed for real, in a Node `vm` context,
against fake Google service globals — no browser, no network.

## Running

```bash
node --test            # from the repo root, runs tests/*.test.js
node --test tests/code.gs.test.js    # one file
node --test --test-name-pattern="TTL" # filter by test name
```

There is no `package.json` and nothing to install: the suite uses only Node
built-ins (`node:test`, `node:assert`, `node:vm`, `node:crypto`). Requires
Node 18+; developed against Node 24.

## Layout

| File | Purpose |
|---|---|
| `gs-harness.js` | The fake Apps Script runtime (`createHarness`) |
| `code.gs.test.js` | The suite — 87 tests across routing, caching, data shapes, admin, session tokens, and harness fidelity |

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
  hand-rolled timestamp expiry is genuinely the thing under test.
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

Four suites cover the auth layer, and they are meant to be read alongside
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
  a prune that removes dead sessions without touching `cache_v2_*`.
- **`login throttling`** — 5 failures locking the username out (the *correct*
  password is refused too, and no sheet is read), the window lapsing, the counter
  resetting, and the recorded sleeps growing then stopping at the cap.

As with the cache work, the suite was **mutation-tested** rather than trusted
because it was green: disabling the role check, the `UpdatedBy` override, the
expiry check, the invalid-token rejection, or the prune prefix filter each fails
at least one test.

## Limits — what this deliberately does not cover

- **No real Google services.** Rate limits, quotas, cold starts, and Apps Script's
  own 100 KB `CacheService` ceiling are not modelled; the size thresholds are only
  exercised as they appear in `code.gs` (90 KB / 450 KB).
- **Only the backend.** `index.html`, the `*-module.js` frontend files, the
  service worker, and the deployed endpoint are out of scope. Nothing here proves
  the live web app behaves as tested.
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
