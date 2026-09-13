#!/usr/bin/env node
/* ------------------------------------------------------------------
   tools/api-probe.js — what one boot costs, and how often the origin fails.

   The app calls a Google Apps Script deployment whose /exec answers with a 302 to
   script.googleusercontent.com, and THAT redirect target is the hop that fails: a
   stall on the origin shows up as a 404 there, never on a healthy fast call.
   Measured earlier by hand: 3/15 = 20% failures, every one of them on a call that
   took 8-33 s, against 1.1-1.3 s for the calls that succeeded.

   This exists so a change (a proxy, say) is compared before/after against the same
   instrument rather than against a memory. It walks the redirect chain by hand —
   Node reports only the end result, and the whole point is WHICH hop fails — and then
   fires the same burst shape the app boots with.

   Usage (from the repo root):
     node tools/api-probe.js                                  # defaults
     node tools/api-probe.js --rounds=12 --bursts=4
     node tools/api-probe.js --url=https://<proxy-host>/      # probe the proxy instead
     node tools/api-probe.js --json                           # one machine-readable line

   Nothing here writes anything or needs a session: the ?type= data routes are open
   by design (see GVSI_NetPulse_Auth_Notes.md), which is what makes this probeable.
 * ------------------------------------------------------------------ */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.dirname(__dirname);

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
}
const flag = (name) => process.argv.includes('--' + name);

/* Probe whatever the app is actually configured to call, unless told otherwise. */
function resolveUrl() {
  const explicit = arg('url', null);
  if (explicit) return explicit;
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const match = html.match(/window\.BASE_API_URL\s*=\s*"([^"]+)"/);
  if (!match) throw new Error('could not read BASE_API_URL out of index.html — pass --url=');
  return match[1];
}

const BASE = resolveUrl().replace(/\?.*$/, '');
const ROUNDS = Number(arg('rounds', 10));
const BURSTS = Number(arg('bursts', 3));
const CONC = Number(arg('concurrency', 5));
const TIMEOUT = Number(arg('timeout', 45000));

/* The five module routes, in the order the boot fires them. */
const TYPES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

function withQuery(type) {
  return BASE + (BASE.includes('?') ? '&' : '?') + 'type=' + type;
}

/* Walk the chain by hand so a failure can be attributed to a hop. */
async function walk(url) {
  const started = Date.now();
  const hops = [];
  let current = url;
  let status = 0;
  let bytes = 0;
  // Present only when the target is the edge proxy. `attempts > 1` means the origin
  // FAILED on the first try and the proxy absorbed it — i.e. exactly the calls that
  // would have reached the browser as a 404 on the direct path.
  let attempts = null;
  let originMs = null;
  try {
    for (let i = 0; i < 6; i++) {
      const res = await fetch(current, {
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT)
      });
      const host = new URL(current).host;
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        hops.push({ host, status: res.status });
        if (!location) { status = res.status; break; }
        current = new URL(location, current).href;
        continue;
      }
      hops.push({ host, status: res.status });
      status = res.status;
      const attemptHeader = res.headers.get('x-netpulse-attempts');
      const originHeader = res.headers.get('x-netpulse-origin-ms');
      if (attemptHeader !== null) attempts = Number(attemptHeader);
      if (originHeader !== null) originMs = Number(originHeader);
      if (res.ok) bytes = (await res.text()).length;
      break;
    }
  } catch (err) {
    status = 0;
    hops.push({ host: new URL(current).host, status: 'threw' });
  }
  return { status, ms: Date.now() - started, hops, bytes, attempts, originMs };
}

const failed = (r) => r.status !== 200;

/* One walk, printed hop by hop: this is the chain the browser otherwise pays for. */
async function showChain() {
  console.log('--- redirect chain for one ?type=nap call -------------------------');
  const url = withQuery('nap');
  const started = Date.now();
  let current = url;
  try {
    for (let i = 0; i < 6; i++) {
      const hopStart = Date.now();
      const res = await fetch(current, {
        redirect: 'manual',
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT)
      });
      const host = new URL(current).host;
      console.log(
        '  hop ' + (i + 1) + '  ' + String(res.status).padEnd(4) + ' ' + host.padEnd(34) +
        ' +' + (Date.now() - hopStart) + ' ms'
      );
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) break;
        current = new URL(location, current).href;
        continue;
      }
      break;
    }
  } catch (err) {
    console.log('  threw: ' + err.message);
  }
  console.log('  total ' + (Date.now() - started) + ' ms');
}

async function sequential() {
  console.log('');
  console.log('--- ' + ROUNDS + ' single ?type=nap calls, one at a time ---------------');
  const runs = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const r = await walk(withQuery('nap'));
    runs.push(r);
    console.log(
      '  ' + String(i).padStart(2) + '  ' + String(r.status).padEnd(5) +
      String(r.ms + ' ms').padStart(9) + '   ' + r.hops.length + ' hop(s)' +
      (failed(r) ? '   <-- FAILED' : '')
    );
  }
  return runs;
}

async function bursts() {
  console.log('');
  console.log('--- ' + BURSTS + ' bursts of ' + CONC + ' concurrent calls (the boot shape) ---');
  const runs = [];
  for (let b = 1; b <= BURSTS; b++) {
    const started = Date.now();
    const results = await Promise.all(
      TYPES.slice(0, CONC).map((type) => walk(withQuery(type)))
    );
    const wall = Date.now() - started;
    const bad = results.filter(failed).length;
    runs.push(...results);
    console.log(
      '  burst ' + b + '  wall ' + String(wall + ' ms').padStart(9) +
      '   failures ' + bad + '/' + results.length +
      '   slowest ' + Math.max(...results.map((r) => r.ms)) + ' ms'
    );
  }
  return runs;
}

function summarise(runs) {
  const times = runs.map((r) => r.ms).sort((a, b) => a - b);
  const at = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))];
  const bad = runs.filter(failed);

  // Through the proxy, the retry count is the real question: a call the origin failed
  // first time is a call the browser would have seen fail. Direct calls carry no such
  // header, so these stay null rather than being invented.
  const proxied = runs.filter((r) => Number.isFinite(r.attempts));
  const retried = proxied.filter((r) => r.attempts > 1);
  const retryRate = proxied.length ? +(100 * retried.length / proxied.length).toFixed(1) : null;

  return {
    calls: runs.length,
    failures: bad.length,
    failureRate: runs.length ? +(100 * bad.length / runs.length).toFixed(1) : 0,
    proxyCalls: proxied.length || null,
    originRetried: proxied.length ? retried.length : null,
    originRetryRate: retryRate,
    failedStatuses: [...new Set(bad.map((r) => r.status))],
    p50: at(0.5),
    p95: at(0.95),
    max: times[times.length - 1],
    /* A failure that finished fast is a real error page; a failure that took seconds is
       the stall signature. Keeping them apart stops a burst of instant 404s from being
       mistaken for the same thing as a 30 s timeout. */
    failureMsMin: bad.length ? Math.min(...bad.map((r) => r.ms)) : null,
    failureMsMax: bad.length ? Math.max(...bad.map((r) => r.ms)) : null
  };
}

(async () => {
  console.log('target: ' + BASE);
  const chain = await showChain();
  const seq = await sequential();
  const bur = await bursts();

  const all = seq.concat(bur);
  const summary = summarise(all);

  console.log('');
  console.log('--- SUMMARY ------------------------------------------------------');
  console.log('  calls                 ' + summary.calls);
  console.log('  failures              ' + summary.failures + '  (' + summary.failureRate + '%)' +
    (summary.failedStatuses.length ? '  statuses: ' + summary.failedStatuses.join(', ') : ''));
  if (summary.failures) {
    console.log('  failing call time     ' + summary.failureMsMin + '-' + summary.failureMsMax + ' ms');
  }
  console.log('  healthy p50           ' + summary.p50 + ' ms');
  console.log('  healthy p95           ' + summary.p95 + ' ms');
  console.log('  slowest call          ' + summary.max + ' ms');
  if (summary.proxyCalls) {
    console.log('');
    console.log('  --- the proxy\'s own value (x-netpulse-attempts) ---');
    console.log('  calls through the proxy   ' + summary.proxyCalls);
    console.log('  origin needed a retry     ' + summary.originRetried +
      '  (' + summary.originRetryRate + '%)');
    console.log('  A retried call is one that would have reached the browser as a failure on');
    console.log('  the direct path. This rate is the number that decides whether the proxy');
    console.log('  earns its ~60 ms — the failure rate alone cannot, because the origin is');
    console.log('  usually healthy.');
  }
  console.log('');
  console.log('  Sequential ?type=nap calls are the warm-cache case; each burst is what one');
  console.log('  boot pays. Compare these same four numbers before and after a change.');

  if (flag('json')) {
    console.log('');
    console.log('JSON ' + JSON.stringify(summary));
  }
})().catch((err) => {
  console.error('probe failed: ' + err.message);
  process.exit(1);
});
