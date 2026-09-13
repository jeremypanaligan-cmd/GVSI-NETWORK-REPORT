# NetPulse edge proxy

`netpulse-proxy.mjs` is a Cloudflare Worker that sits between the PWA and the Apps Script
deployment, so the browser pays **one** request instead of a redirect chain.

**Status: deployed and wired up, 2026-09-13.**

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

## Turning it on

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
