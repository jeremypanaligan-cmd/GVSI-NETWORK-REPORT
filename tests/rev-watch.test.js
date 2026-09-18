// ====================== REV WATCH TESTS ======================
// Run: node tests/rev-watch.test.js
//
// Zero dependencies — loads rev-watch.js into a vm sandbox with a stubbed
// fetchWithRetry, a stubbed fetchGate and a controllable document, then drives
// real (short) timers.
//
// The interesting claims are the ones that decide whether this adds load or
// removes it:
//
//   * Nothing is refreshed on the first poll. The page has just loaded; treating
//     the initial revision as "changed" would refetch every module on every load.
//   * An unchanged revision causes NO fetch at all. That is the entire point —
//     the poll is cheap, and it must never become a data fetch by accident.
//   * A hidden tab does not poll. Otherwise every backgrounded dashboard keeps
//     spending the PropertiesService daily quota to learn nothing.
//   * A moved revision refreshes only the module that moved.
//   * A poll failure is silent and re-armed, because the fallback is the refresh
//     cadence that already existed.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'rev-watch.js'), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Timers started inside a sandbox, swept so node can exit. */
const SANDBOXES = [];

function makeSandbox(opts) {
  opts = opts || {};

  const state = {
    polls: [],            // urls passed to fetchWithRetry
    refreshed: [],        // types passed to the refresh callback
    rev: Object.assign({ nap: 0, lcp: 0, olt: 0, node: 0, backbone: 0 }, opts.rev || {}),
    built: Object.assign({}, opts.built || {}),
    warnings: [],
    failNext: opts.failNext || 0,
    visibility: opts.visibility || 'visible',
    listeners: {}
  };

  const sandbox = {
    console: {
      log: (m) => state.warnings.push(String(m)),
      warn: (m) => state.warnings.push(String(m)),
      error: (m) => state.warnings.push(String(m))
    },
    setTimeout,
    clearTimeout,
    fetchWithRetry: (url) => {
      state.polls.push(url);
      if (state.failNext > 0) {
        state.failNext--;
        return Promise.reject(new Error('poll failed'));
      }
      if (opts.payload !== undefined) return Promise.resolve(opts.payload);
      return Promise.resolve({ ok: true, rev: Object.assign({}, state.rev) });
    },
    fetchGate: { dataBuiltAt: (type) => state.built[type] || 0 },
    document: {
      get visibilityState() { return state.visibility; },
      addEventListener: (name, fn) => { state.listeners[name] = fn; }
    }
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'rev-watch.js' });

  const stop = sandbox.revWatch.stop;
  SANDBOXES.push(stop);
  state.window = sandbox;
  return state;
}

function start(state, opts) {
  opts = opts || {};
  state.window.startRevWatch(Object.assign({
    url: 'https://api.invalid/exec?action=rev',
    types: ['nap', 'lcp', 'olt', 'node', 'backbone'],
    refresh: (type) => state.refreshed.push(type)
  }, opts));
}

/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

(async function run() {
  console.log('\nRev watch\n');

  await test('the first poll records the revisions WITHOUT refreshing anything', async () => {
    const s = makeSandbox();
    start(s, { intervalMs: 25, firstPollDelayMs: 5 });
    await sleep(60);

    assert.strictEqual(s.polls.length >= 1, true, 'expected at least one poll');
    assert.deepStrictEqual(s.refreshed, [],
      'the page just loaded: treating the initial revision as changed would refetch every ' +
      'module on every load');
    assert.strictEqual(s.window.revWatch.seen().olt, 0, 'but the revision is remembered');
  });

  await test('a server that has no rev route yet is tolerated, silently', async () => {
    /* The real deployment returns {"error":"Unknown action: rev"} until the new
       code.gs is pasted, and the client is designed to ship first: it must
       degrade to exactly the old behaviour (refresh cadence only), not to a
       console full of errors or a refresh storm. */
    const s = makeSandbox({ payload: { error: 'Unknown action: rev' } });
    start(s, { intervalMs: 25, firstPollDelayMs: 0 });
    await sleep(90);

    assert.strictEqual(s.polls.length >= 2, true, 'it keeps asking');
    assert.deepStrictEqual(s.refreshed, [], 'and never mistakes that for a change');
    /* JSON, not deepStrictEqual: `seen` is created inside the vm realm, so its
       object carries that realm's prototype and a strict compare fails on
       identity rather than on content. */
    assert.strictEqual(JSON.stringify(s.window.revWatch.seen()), '{}',
      'no revision was learned');
    assert.deepStrictEqual(s.warnings, [], 'and nothing is logged about it');
  });

  await test('a payload with no rev object at all is a no-op', async () => {
    const s = makeSandbox({ payload: null });
    start(s, { intervalMs: 25, firstPollDelayMs: 0 });
    await sleep(80);

    assert.deepStrictEqual(s.refreshed, []);
    assert.deepStrictEqual(s.warnings, []);
  });

  await test('a moved revision refreshes exactly that module', async () => {
    const s = makeSandbox();
    start(s, { intervalMs: 25, firstPollDelayMs: 0 });
    await sleep(40);
    s.rev.olt = 4;
    await sleep(80);

    assert.deepStrictEqual(s.refreshed, ['olt'],
      'only the module whose sheet changed may be refetched');
    assert.strictEqual(s.window.revWatch.seen().olt, 4);
  });

  await test('an unchanged revision causes NO data fetch', async () => {
    const s = makeSandbox();
    start(s, { intervalMs: 20, firstPollDelayMs: 0 });
    await sleep(120);

    assert.strictEqual(s.polls.length >= 3, true, 'the poll should keep running');
    assert.deepStrictEqual(s.refreshed, [],
      'this is the whole bargain: a cheap question asked often, instead of an ' +
      'expensive fetch asked to find out nothing changed');
  });

  await test('two revisions moving in one poll refresh both, once each', async () => {
    const s = makeSandbox();
    start(s, { intervalMs: 25, firstPollDelayMs: 0 });
    await sleep(40);
    s.rev.olt = 1;
    s.rev.node = 9;
    await sleep(80);

    assert.deepStrictEqual(s.refreshed.sort(), ['node', 'olt']);
  });

  await test('a hidden tab does not poll at all', async () => {
    const s = makeSandbox({ visibility: 'hidden' });
    start(s, { intervalMs: 20, firstPollDelayMs: 0 });
    await sleep(100);

    assert.strictEqual(s.polls.length, 0,
      'a backgrounded dashboard must not spend the PropertiesService quota to learn ' +
      'nothing — the foreground refresh handles the case when it comes back');
  });

  await test('returning to the foreground polls immediately, not after an interval', async () => {
    const s = makeSandbox({ visibility: 'hidden' });
    start(s, { intervalMs: 5000, firstPollDelayMs: 0 });
    await sleep(30);
    assert.strictEqual(s.polls.length, 0, 'hidden: nothing yet');

    s.visibility = 'visible';
    s.visibility = 'visible';
    s.listeners.visibilitychange();
    await sleep(30);

    assert.strictEqual(s.polls.length >= 1, true,
      'a return to the foreground is a reason to look now, not in 30 s');
  });

  await test('a failed poll is silent and re-arms', async () => {
    const s = makeSandbox({ failNext: 1 });
    start(s, { intervalMs: 20, firstPollDelayMs: 0 });
    await sleep(120);

    assert.strictEqual(s.polls.length >= 2, true, 'the watcher must keep trying');
    assert.deepStrictEqual(s.warnings, [], 'a failed poll is not worth a console warning');
  });

  await test('stop() halts polling', async () => {
    const s = makeSandbox();
    start(s, { intervalMs: 15, firstPollDelayMs: 0 });
    await sleep(50);
    const before = s.polls.length;
    s.window.revWatch.stop();
    await sleep(60);

    assert.strictEqual(s.polls.length, before, 'stop() must not leave a timer running');
  });

  await test('a second startRevWatch call is ignored', async () => {
    const s = makeSandbox();
    start(s, { intervalMs: 20, firstPollDelayMs: 0 });
    await sleep(30);
    const before = s.polls.length;
    s.window.startRevWatch({
      url: 'https://api.invalid/exec?action=rev',
      types: ['olt'],
      refresh: () => s.refreshed.push('second')
    });
    await sleep(60);

    assert.ok(s.polls.length >= before, 'one watcher per page');
    assert.deepStrictEqual(s.refreshed, [], 'the second watcher must not double-refresh');
  });

  await test('the verification pass warns when the payload build time did not advance', async () => {
    const s = makeSandbox({ built: { olt: 1700000000000 } });
    start(s, { intervalMs: 5000, firstPollDelayMs: 0, verifyDelayMs: 10 });
    await sleep(30);
    s.rev.olt = 2;                       // the edit lands
    s.window.revWatch.pollNow();          // refresh fires, stamp stays put
    await sleep(60);

    assert.deepStrictEqual(s.refreshed, ['olt'], 'the refresh itself must still happen');
    assert.ok(s.warnings.some((w) => w.indexOf('[RevWatch]') !== -1 && w.indexOf('olt') !== -1),
      'a rev that moved without the build time moving is the mid-build race — it must be ' +
      'said out loud rather than silently trusted');
  });

  await test('no warning when the payload build time did advance', async () => {
    const s = makeSandbox({ built: { olt: 1700000000000 } });
    start(s, {
      intervalMs: 5000,
      firstPollDelayMs: 0,
      verifyDelayMs: 10,
      refresh: () => {
        s.refreshed.push('olt');
        s.built.olt = 1700000009999;      // the server built a newer payload
      }
    });
    await sleep(30);
    s.rev.olt = 2;
    s.window.revWatch.pollNow();
    await sleep(60);

    assert.deepStrictEqual(s.refreshed, ['olt']);
    assert.deepStrictEqual(s.warnings, [], 'a refresh that worked must stay quiet');
  });

  await test('a module with no build stamp is never warned about', async () => {
    const s = makeSandbox();              // no stamps at all (nap/lcp/node/backbone)
    start(s, { intervalMs: 5000, firstPollDelayMs: 0, verifyDelayMs: 10 });
    await sleep(30);
    s.rev.nap = 3;
    s.window.revWatch.pollNow();
    await sleep(60);

    assert.deepStrictEqual(s.refreshed, ['nap']);
    assert.deepStrictEqual(s.warnings, [],
      'the warning is about a stamp that failed to advance, not about a missing one');
  });

  SANDBOXES.forEach((stop) => { try { stop(); } catch (e) {} });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
