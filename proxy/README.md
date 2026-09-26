# NetPulse edge proxy

`netpulse-proxy.mjs` is a Cloudflare Worker that sits between the PWA and the Apps Script
deployment, so the browser pays **one** request instead of a redirect chain.

**Status: TURNED OFF in the app, 2026-09-15 — the code below is kept, the app does not use it.**

`window.NETPULSE_PROXY` in `index.html` is blank, so every route (data *and* auth) calls
Apps Script directly, and `API_PROXY_HOST` in `sw.js` is blank to match. The reason:
`ATTEMPT_TIMEOUT_MS = 20000` with `ATTEMPTS = 3` is shorter than the deployment's OLT
branch needs to build its payload, so `?type=olt` was answered **503 by this worker while
the deployment was healthy** — the direct `/exec?type=olt` URL returns the JSON, just
slowly, and retrying a heavy call only repeats the heavy computation. Raising the ceiling
or dropping to one attempt buys headroom without fixing that, so the proxy is off until
the OLT branch is fast enough for any timeout to be the right answer. Everything below
still describes how to turn it back on; the rollback is the two values named above.

**Former status: deployed and wired up, 2026-09-13.**

| | |
|---|---|
| worker | `https://holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev` (`holy-cloud-1d7a` is the name the dashboard generated) |
| app | `window.NETPULSE_PROXY` in `index.html`; `sw.js` lists the same host in its network-only API branch |
| verified | `?type=lcp` and `?type=olt` through the app added **0** entries to the shell cache, i.e. the API really is network-only |

**One edit in this directory is newer than the deployed copy:** the
`Access-Control-Expose-Headers` line (see Observability). Nothing breaks without it — the
headers are still visible in devtools and the logs — but until the worker is re-pasted the
app cannot read its own retry counts. Re-pasting the whole file is the simplest fix.

This file is the runbook for turning it on, and for turning it off again.

---

## Why it exists

The app called Apps Script directly, and that call is a **two-hop redirect**:

```
browser → script.google.com/.../exec       302   (+400 – 3,100 ms)
        → script.googleusercontent.com/... 200   (+400 ms)
```

That last row is the reason this exists. `curl` reproduced the 404 with no cookies, no
JavaScript and no service worker, so it is the origin's flakiness and not the browser's —
but the browser cannot do anything about it: it pays the whole chain, it sees the 404, and
its own retry has to be slow and visible. A 404 that reached a module left it on
*"Error loading data."* until its next poll, which for NAP is up to an hour.

### Measured, same instrument, both ways

`tools/api-probe.js`, 2026-09-13, 25 calls each way. "After" is the worker run **locally**
(`node proxy/serve-local.mjs`) against the **real** origin — the same code Cloudflare would
run, so the only thing missing from these numbers is Cloudflare's edge:

| | before (direct) | after (through the proxy) |
|---|---|---|
| hops the client pays | **2** | **1** |
| `?type=nap`, warm, sequential (p50) | 1,096 ms | **1,126 ms** |
| one boot burst, 5 concurrent (warm) | 1,156 ms | **1,182 / 1,266 ms** |
| cold-ish first burst | 3,235 ms | **2,437 ms** |
| failures that afternoon | 0 / 25 | 0 / 25 |
| failures during a stall (measured earlier) | **3 / 15 = 20%**, each on a call that had already taken **8–33 s** | absorbed — see below |

**Read that honestly: this is not a speed win on a healthy origin.** Warm calls went from
1,096 ms to 1,126 ms — about **+30 ms (+2.7%)**, the price of one extra hop through this
machine — and both sides happened to be 0/25 that afternoon. What it changes is the *shape*
of a failure:

- the client makes **one** request to **one** host, instead of paying a redirect chain it
  cannot retry cheaply;
- the hop that answers 404 is now retried **server-side**, where waiting costs a user
  nothing: the caller gets 200, or a retryable 503, and never a 404;
- a module that received a 404 used to sit on *"Error loading data."* until its next poll,
  which for NAP is up to an hour.

The flaky hop is not gone from the world — the worker still pays it. It is gone from the
**browser's** path, which is the part that had no way to absorb it. Because the live 404 is
not reproducible on demand (0/25 healthy, 3/15 stalled), that part is proven by injected
failure in `tests/proxy.test.js` rather than by a lucky run.

The worker moves the chain behind one request and absorbs the retry:

```
browser --1 request--> worker --up to 3 attempts--> Apps Script
```

## What it deliberately does not do

- **No caching.** A 24/7 NOC display showing a stale outage is worse than one that takes
  1.2 s. If caching is ever wanted, key it on `type=` **only** and never on `action=`,
  which carries sessions and tokens.
- **No open relay.** The origin URL is fixed in the worker and only a small whitelist of
  query parameters is forwarded (`type`, `action`, `shape`, `token`, `username`,
  `password`, `fullName`, `enabled`, `probe`). A caller cannot make it fetch anything else.

  **The whitelist must be exactly the set `code.gs` / `admin.gs` read, and getting it wrong is
  silent.** A dropped parameter is not an error anyone sees: Apps Script answers **200 with
  JSON** either way. This shipped without `password`, and every sign-in failed with
  `Invalid username or password` while the credentials were correct — the worker was
  stripping the password before the origin ever saw it. `enabled` was missing too, so
  `action=setMaintenance` could only ever turn maintenance **off**.

  So it is no longer hand-kept: `tests/proxy.test.js` reads every `e.parameter.*` out of
  `code.gs` and `admin.gs` and fails when `buildOriginUrl()` drops any of them — **the
  backend defines the allowed set**. Add a route there and its inputs travel here too.
- **No auth changes.** The session token still travels the same way it does today; the
  worker does not hold credentials and is not a trust boundary.

## Observability

Every response carries:

| header | meaning |
|---|---|
| `x-netpulse-attempts` | `1` = the origin answered first try; higher = it was retried |
| `x-netpulse-origin-ms` | how long the successful origin attempt took |

`?probe=1` answers without touching the origin, so "is the worker up" and "is the origin
healthy" stay separable when something is wrong.

Both headers are also listed in `Access-Control-Expose-Headers`, and that is not cosmetic.
A cross-origin response hides every header that is not CORS-safelisted: measured from the
app, `res.headers.keys()` returned **neither** header while the same call from `curl` showed
both. Without that line they are readable in devtools and the logs only — with it the app
can display its own retry counts, which is the whole point of having them.

---

---

# THE DATA PLANE (`/publish` and `/data/*`)

**Status: the WORKER half is deployed, the Apps Script half is not — 2026-09-26.** Steps 1 and 2 below
are done and verified against the live edge, and both worker secrets are set. What is left is step 3
(the `publish-cache.gs` paste and `setEdgeConfig_`) and step 4 (one publish). Nothing changes for the
app until all four are done and `window.NETPULSE_CDN` in `index.html` is set.

This is the second job this worker does, and it is the one that removes the hop rather than
absorbing it: the Apps Script trigger publishes each payload it has already built into KV, and the
app reads it from the edge in tens of milliseconds. Apps Script is not in the read path at all.

| route | method | auth | what it does |
|---|---|---|---|
| `/publish?type=nap` | POST | `x-netpulse-secret` = `PUBLISH_SECRET` | stores the exact JSON body in KV, with `{builtAt, rev, bytes, publishedAt}` as metadata |
| `/data/nap` | GET | `Authorization: Bearer <login token>` | the payload, edge-cached 60 s, with `x-netpulse-built-at` |
| `/data/_bundle` | GET | same | all five in **one** read (assembled at the edge), plus per-type stamps |
| `/data/_meta` | GET | same | the stamps and sizes, without the payloads |
| `/?type=…`, `/?action=…` | GET | none (as before) | the pass-through above, untouched |

**Why a token and not just an obscure path.** The app's `?type=` data routes are not session-gated —
`resolveSession()` is called only by the admin and diag routes, and `index.html` says so in its own
comment. So "behind the login" is true of the UI only. A CDN path adds the two things the `/exec`
URL does not have — it can be found, and it can be copied into a cache — so the read is gated by a
short-lived HMAC (`user|exp`, signed with `READ_SECRET`) that the deployment mints at login. The
worker verifies it statelessly, which is the point: no call back to Apps Script on the hot path.

## The four owed steps

**1. ✅ DONE — the namespace exists** — Workers & Pages → KV → `NETPULSE_DATA`
(id `96d4c88d628a48d993068157d62da852`).

**2. ✅ DONE — this worker source is deployed, with the binding** — `holy-cloud-1d7a` runs the current
`netpulse-proxy.mjs`, and a KV namespace binding named **`DATA`** points at `NETPULSE_DATA`. Verified
from OUTSIDE, not from the dashboard: `gateRead` checks `!kv` **before** it looks at any token, so an
unauthenticated `GET /data/nap` answering `401 no_token` rather than `503 field: "DATA"` is proof the
binding is attached — a `503` is what a missing binding would say. (With wrangler instead:
`npx wrangler deploy proxy/netpulse-proxy.mjs --name holy-cloud-1d7a`, which needs a `wrangler.toml`
for the binding.)

**3. ⏳ HALF DONE — the worker's secrets are set, the Apps Script half is not.** Generate them once
(they are the same value in both places, and they belong in NO repository):

```bash
openssl rand -hex 32   # -> PUBLISH_SECRET  (worker)  / netpulse_publish_secret  (Apps Script)
openssl rand -hex 32   # -> READ_SECRET     (worker)  / netpulse_read_secret     (Apps Script)
```

Worker: ✅ Settings → Runtime variables and secrets → both added as **Encrypted** on Production +
Previews, which is why `POST /publish` and `GET /data/*` answer `401` instead of `503` today. The
`Secret` checkbox is not on by default and a plaintext variable would work identically — it is a
signing key, so it is a secret.

⚠️ **A secret rotation is TWO clicks, and the second one is not in that dialog. MEASURED
2026-09-26: this cost five rotations in one sitting.** Editing a secret opens a dialog with `Save
version` and `Deploy`. `Save version` saves the version but does **not** put it in front of traffic,
and `Deploy` goes **disabled** the moment you save it — so the obvious next move is to close the
dialog, and the worker keeps serving the PREVIOUS secret. That is invisible from both ends: the
Cloudflare version list shows the new one, `setEdgeConfig_` shows the value you typed, and every
request still answers `401 bad_signature` because the two halves do not actually hold the same
string. The second click is on the **Deployments** tab: **Version History → ⋯ (More options) →
Promote version** (the menu offers `Promote version`, `Split versions`, `View logs` — there is no
item called Deploy).

**Check it before believing a rotation worked:** the top of the Deployments page names the **Active
deployment**. If that version id is not the one you just saved, nothing you changed is live. The
fastest end-to-end check is still `diagnoseEdgeSecrets_()` below, which asks the worker itself.
Apps Script: **still owed** — paste `publish-cache.gs`, then run once from the editor. **The Run
dropdown cannot pass arguments**, so the call needs a wrapper: add a throwaway function, run **that**
from the dropdown, then delete it.

```javascript
function setupEdgeOnce() {
  setEdgeConfig_('https://holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev', '<publish secret>', '<read secret>');
}
```

`setEdgeConfig_` trims each value itself, so a trailing space cannot become a 401 nobody can explain —
the reason it is a function rather than three fields in the Properties UI. `reportEdgeState()` (also in
`publish-cache.gs`, read-only) then prints what the edge actually holds.

**4. ⏳ Publish something (still owed).** The publish rides `warmDataCaches`, so it needs that trigger (every 5
minutes — see `triggers.gs` and `setupAllTriggers()`), or one manual run of `warmDataCaches` from the
editor. Nothing will be published to the edge until one of those exists.

**How to tell whether that trigger is installed — do NOT use `?action=bundle` for it.** The route is
not a clean warmth probe: `handleBundle` falls back to Script Properties (`bundlePropertyEntry_`) whose
freshness rule is `cacheTtlFor_` (60 s for node/olt/backbone, 180 s for nap/lcp), and on a CacheService
hit it does not check freshness at all — a hit counts as present for the whole CacheService TTL. So a
full bundle with `missing: []` looks identical whether a warm pass wrote it or app traffic did.
Measured twice on 2026-09-26: earlier the same day `?action=bundle` answered **all five as missing**
(nothing in either store), and later it answered **`missing: []`** — the two readings differ, and
neither one names the trigger. The decisive check is **`listTriggers()`** in the Apps Script editor:
read-only, and it prints `✅ In sync.` or `❌ Planned but NOT live (run setupAllTriggers): …`.

## Verify it before switching the app on

```bash
EDGE=https://holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev

curl -s "$EDGE/?probe=1"                                  # the pass-through is still alive
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$EDGE/publish?type=nap"   # 401: no secret
curl -s -o /dev/null -w '%{http_code}\n' "$EDGE/data/nap"                    # 401: no token
curl -s -X POST "$EDGE/publish?type=nap" -H "x-netpulse-secret: $PUBLISH_SECRET" \
     -H 'content-type: application/json' --data '[{"A":"test"}]'          # 200
curl -s "$EDGE/data/_meta" -H "Authorization: Bearer $TOKEN"                # the index
curl -s -o /dev/null -w '%{http_code}\n' "$EDGE/data/nap" \
     -H 'Authorization: Bearer basura.token'                                # 401, never 500
```

A `503 edge_not_configured` with `field: "PUBLISH_SECRET"` (or `READ_SECRET`, or `DATA`) means step 2
or 3 is incomplete — the worker says which one rather than pretending to work.

**`diagnoseEdgeSecrets_()` is the answer to "why is my token refused".** In `publish-cache.gs`, run
from the editor. It mints the SAME token with five spellings of the configured secret — as stored,
trimmed, `+\n`, `+space`, `+\r\n` — and prints the HTTP code each one gets (200 for the read probe,
400 for the publish probe). The spelling with the checkmark is the one the worker holds; if NO row has
one, the two sides hold different values. It is read-only by construction and that is asserted in
`tests/publish-server.test.js`: the read probe is `GET /data/_meta`, and the publish probe posts to a
type that does not exist, which `handlePublish` refuses with 400 **after** the secret check and
**before** the body is read. Why the spellings matter: `setEdgeConfig_` **trims** what it stores and
Cloudflare does **not** trim a secret, so a value copied from a terminal selection — which carries the
line's trailing newline — lands in the worker as `"<secret>\n"` and can never be reproduced from the
Apps Script side however many times the paste is repeated.

**That last curl is not decoration — it is the one that caught a real bug.** On 2026-09-26 the
DEPLOYED worker answered `Bearer basura.token` with **500 `error code: 1101`**, a Worker exception,
because `b64urlToBytes` calls `atob` and a string containing a dot is not necessarily two base64url
halves. A 500 tells the client "the edge is broken"; a 401 tells it "fall back to `/exec`", so that
inverted the one decision the verifier exists to make. The decode and the `subtle.verify` call are
guarded in this source now, with `publish-auth` covering six malformed shapes — **but the fix lives
only in the repo until the worker is pasted again.** A deployed copy that answers 500 here needs that
re-paste, not another secret.

## Turning it on, and off again

On: set `window.NETPULSE_CDN = "https://holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev"` in
`index.html`. `sw.js` already lists that host as network-only (`DATA_CDN_HOST`), and the release
label moves with it.

Off, in one value: blank `window.NETPULSE_CDN`. Every module then reads from `/exec` exactly as it
did before, because that is the path the client falls back to on any refusal. A second, harder roll-
back is to delete the KV keys — the worker answers 404 `not_published` and each type falls back
individually.

## What the data plane does NOT change

- **Login, admin, diag and settings stay on Apps Script.** Only the five data payloads move.
- **The pass-through above is untouched**, including the 404-absorbing retry — so the direct path
  remains a working fallback for every client that has not reloaded.
- **No new copy of the data exists anywhere else.** What is published is byte-for-byte the JSON the
  build cached, so a payload from the edge and one from `/exec` are the same shape. The fields are
  also the same, which means ticket remarks and ticket numbers do leave Google for Cloudflare KV and
  its edge cache — named here because it is the one thing about this design a reader should be told
  rather than discover.

---

## Turning the pass-through on

### 1. Deploy the worker

**Prerequisite, and an easy one to trip over:** the account needs a `workers.dev`
subdomain, and an account that has never opened **Workers & Pages** does not have one. Any
deploy attempted before that fails with `10007: You do not have a workers.dev subdomain`
(and, from an API token, with `10000: Authentication error` — which reads like a permissions
problem and is not). Opening
<https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages> once creates it.

Then either clone-and-paste in the dashboard: **Workers & Pages → Create → Worker**, paste
the contents of `netpulse-proxy.mjs`, Deploy. Note the URL it gives you
(`https://<name>.<subdomain>.workers.dev`).

Or with `wrangler`:

```bash
npx wrangler deploy proxy/netpulse-proxy.mjs --name netpulse-proxy
```

There is no build step and no dependency: the file is the whole worker.

### 2. Verify the worker before touching the app

```bash
curl -s "https://<name>.<subdomain>.workers.dev/?probe=1"      # liveness
curl -s "https://<name>.<subdomain>.workers.dev/?type=nap" -D - -o /dev/null   # x-netpulse-attempts
node tools/api-probe.js --url="https://<name>.<subdomain>.workers.dev"        # after-numbers
```

`node tools/api-probe.js --url=…` runs the same instrument used for the baseline above,
so the before/after tables are comparable. **Note that the 404 rate is intermittent** —
0/25 on a healthy afternoon, 3/15 during a stall — so a clean `after` run does not by
itself prove the fix. The part that *is* deterministic is proven by
`node --test tests/proxy.test.js`: it injects the origin 404, the 500, the thrown
connection and the 200-carrying-HTML, and asserts the **caller** gets 200 or a retryable
503 and never a 404.

### 3. Point the app at it

One value in `index.html`, in the application-variables block — `window.NETPULSE_PROXY`:

```js
window.APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfy…/exec";
window.NETPULSE_PROXY  = "https://holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev";
window.BASE_API_URL    = window.NETPULSE_PROXY || window.APPS_SCRIPT_URL;
```

`APP_URL` (the auth calls) derives from `BASE_API_URL`, so there is exactly one value to
change and one to blank.

**`sw.js` must change in the same step.** Its fetch handler treats `script.google.com` as
network-only; with the proxy in front, the API's host is the proxy's, and if that is not
excluded the service worker would stale-while-revalidate API responses. Add the
`NETPULSE_PROXY` host to the same rule.

### 4. Verify in the browser

Load the app twice (the second load is when the service worker has the new shell), then
check the Network tab: each module call should be a **single** request to the proxy host
with no redirect, and no `script.googleusercontent.com` entry at all.

## Deciding whether to keep it

The proxy is not free. Measured from this machine through the live worker: **+62 ms on a
warm call (p50 1,096 → 1,158 ms)** and **+110–140 ms per boot burst**. It is worth that only
if the origin fails often enough to matter, and **a failure rate cannot answer that** — both
afternoons measured had a healthy origin (0/25), and the client retries on its own, so one
browser-side 404 is not fatal either. What strands a module is several failures in a row.

The number that answers it is the worker's own retry counter. **A call the origin failed on
its first attempt is exactly a call that would have reached the browser as a failure on the
direct path** — the proxy is the only place that can see this, because it is the only place
that is not allowed to fail.

```bash
node tools/api-probe.js --url="https://holy-cloud-1d7a.jeremysamsonpanaligan.workers.dev" --rounds=20 --bursts=4
```

```
  --- the proxy's own value (x-netpulse-attempts) ---
  calls through the proxy   40
  origin needed a retry     0  (0%)
```

**Run it when the app feels slow or a module shows an error** — not only on a good afternoon.
A healthy window reads 0% and decides nothing.

| what you see | what it means |
|---|---|
| ~0% every time, including during a slow patch | insurance you never claim — **revert it** (one value, below) |
| a few % during a slow patch | it is absorbing real browser-visible failures — **keep it** |

First reading, 2026-09-13: **40 calls, 0 retried, 0 failed** — a healthy window.

## Turning it off

Set `window.NETPULSE_PROXY = ""` and revert the `sw.js` host rule. The app goes back to
calling Apps Script directly — that path is untouched and stays working, so this is a
one-value rollback with no redeploy of anything Google-side.
