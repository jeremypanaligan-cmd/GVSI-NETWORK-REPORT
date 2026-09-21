// ==================== SERVICE WORKER UPDATE TESTS ====================
//
// Run: node tests/sw-update.test.js
//
// Zero dependencies. The sw.js registration block is sliced out of index.html and run
// in a vm sandbox with a fake navigator/document/clock, so this exercises the real
// trigger code rather than a copy of it.
//
// The bug these tests exist for: an installed PWA kept the release it was installed
// with until the user uninstalled and reinstalled. Two things were missing and each is
// invisible on its own —
//
//   * NOTHING EVER ASKED. `reg.update()` was called on exactly one event, a return to
//     the foreground, so a launch and a dashboard left open never checked at all.
//   * A WORKER IN `waiting` WAS NEVER TOLD TO GO. A device whose running worker predates
//     `skipWaiting()` can hold a new one in `waiting` forever, because an installed app
//     is never closed and so never releases it.
//
// The claims that decide whether this holds are the throttling ones: three reasons to
// ask in the same minute must cost ONE fetch of sw.js, and asking must never happen
// while the tab is hidden. Getting either wrong turns a fix for a stale app into a
// request generator on every device.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const HTML_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const RELEASE = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).version;

const BLOCK_START = "if ('serviceWorker' in navigator) {";
const BLOCK_END = '// ==================== SKELETON LOADING ====================';

const REGISTRATION_BLOCK = (function () {
  /* LAST occurrence: `checkAppVersion()` also opens with this exact line, and slicing from
     there would take in half the page (and every top-level `await` in it). */
  const from = HTML_SRC.lastIndexOf(BLOCK_START);
  const to = HTML_SRC.indexOf(BLOCK_END);
  assert.ok(from !== -1, 'index.html no longer has a service worker registration block');
  assert.ok(to > from, 'the skeleton marker moved above the registration block');
  const block = HTML_SRC.slice(from, to);
  assert.ok(block.indexOf("register('./sw.js") !== -1,
    'the slice must be the REGISTRATION block, not the version wipe that opens the same way');
  return block;
})();

const INTERVAL_MS = 15 * 60 * 1000;
const MINUTE = 60 * 1000;

const flush = async (n) => {
  for (let i = 0; i < (n || 4); i++) await new Promise((r) => setTimeout(r, 0));
};

/* ------------------------------------------------------------------ */

function makeSandbox(opts) {
  opts = opts || {};

  const state = {
    now: 1000000000000,          // a fixed clock: the throttle is the subject here
    visibility: opts.visibility || 'visible',
    registered: [],
    updates: 0,
    reloads: 0,
    intervals: [],
    listeners: {},
    swListeners: {},
    regListeners: {},
    workerListeners: {},
    postMessages: [],
    warnings: [],
    pending: null,               // resolve() of a deliberately in-flight update()
    activeElement: opts.activeElement || null
  };

  const worker = (name) => ({
    label: name,
    state: 'installing',
    postMessage: (msg) => state.postMessages.push(msg),
    addEventListener: (evt, fn) => { state.workerListeners[name + ':' + evt] = fn; }
  });

  const waiting = opts.waiting ? worker('waiting') : null;
  const installing = opts.installing ? worker('installing') : null;

  const reg = {
    waiting: waiting,
    installing: installing,
    get installing2() { return null; },
    update: () => {
      state.updates++;
      if (opts.updateRejects) return Promise.reject(new Error('offline'));
      if (opts.updateHangs) {
        return new Promise((resolve) => { state.pending = resolve; });
      }
      return Promise.resolve();
    },
    addEventListener: (evt, fn) => { state.regListeners[evt] = fn; }
  };

  const sandbox = {
    console: {
      log: (m) => state.warnings.push(String(m)),
      warn: (m) => state.warnings.push(String(m)),
      error: (m) => state.warnings.push(String(m))
    },
    Promise,
    Date: { now: () => state.now },
    setInterval: (fn, ms) => { state.intervals.push({ fn: fn, ms: ms }); return state.intervals.length; },
    clearInterval: () => {},
    setTimeout: setTimeout,
    navigator: {
      serviceWorker: {
        controller: opts.controller === false ? null : {},
        register: (url) => { state.registered.push(url); return Promise.resolve(reg); },
        addEventListener: (evt, fn) => { state.swListeners[evt] = fn; }
      }
    },
    document: {
      get visibilityState() { return state.visibility; },
      get activeElement() { return state.activeElement; },
      addEventListener: (evt, fn) => { state.listeners[evt] = fn; }
    }
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (evt, fn) => { state.listeners[evt] = fn; };
  sandbox.location = { reload: () => { state.reloads++; } };

  vm.createContext(sandbox);
  vm.runInContext(REGISTRATION_BLOCK, sandbox, { filename: 'index.html (sw block)' });

  state.reg = reg;
  state.madeWorker = worker;
  state.fireLoad = () => state.listeners.load();
  state.fireVisibility = () => state.listeners.visibilitychange();
  state.fireInterval = () => state.intervals.forEach((t) => t.fn());
  return state;
}

function swSandbox() {
  const state = { listeners: {}, skipWaiting: 0, warnings: [] };
  const sandbox = {
    console: {
      log: (m) => state.warnings.push(String(m)),
      warn: (m) => state.warnings.push(String(m)),
      error: (m) => state.warnings.push(String(m))
    },
    caches: {
      open: () => Promise.resolve({ add: () => Promise.resolve() }),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve()
    },
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    addEventListener: (evt, fn) => { state.listeners[evt] = fn; },
    skipWaiting: () => { state.skipWaiting++; }
  };
  sandbox.self = sandbox;
  sandbox.registration = { showNotification: () => Promise.resolve() };

  vm.createContext(sandbox);
  vm.runInContext(SW_SRC, sandbox, { filename: 'sw.js' });
  return state;
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
  console.log('\nService worker update triggers\n');

  /* ---------------- the gap: nothing ever asked ---------------- */

  await test('the worker is registered with the release label in its url', async () => {
    const s = makeSandbox();
    s.fireLoad();
    await flush();

    assert.deepStrictEqual(s.registered, ['./sw.js?v=' + RELEASE],
      'the registration url carries the label so a publish always looks like a change');
  });

  await test('THE LAUNCH asks for an update check', async () => {
    const s = makeSandbox();
    s.fireLoad();
    await flush();

    assert.strictEqual(s.updates, 1,
      'a home-screen launch navigates once and then never again: if the launch does not ' +
      'ask, nothing does until the app is next foregrounded');
  });

  await test('a dashboard left open is asked for, on a timer', async () => {
    const s = makeSandbox();
    s.fireLoad();
    await flush();
    assert.strictEqual(s.intervals.length, 1, 'exactly one timer, or every module page ' +
      'would carry its own');

    assert.strictEqual(s.intervals[0].ms, INTERVAL_MS);
    s.now += INTERVAL_MS;
    s.fireInterval();
    await flush();

    assert.strictEqual(s.updates, 2,
      'a display that is never hidden and never navigated is exactly the device that ' +
      'stayed on its install-day build');
  });

  await test('a return to the foreground asks again', async () => {
    const s = makeSandbox();
    s.fireLoad();
    await flush();

    s.now += 20 * MINUTE;
    s.visibility = 'visible';
    s.fireVisibility();
    await flush();

    assert.strictEqual(s.updates, 2, 'this is the only trigger the old code had');
  });

  /* ---------------- the throttle: the fix must not become load ---------------- */

  await test('three reasons to ask in one minute cost ONE check', async () => {
    const s = makeSandbox();
    s.fireLoad();
    await flush();

    s.fireVisibility();
    s.fireVisibility();
    s.fireInterval();
    await flush();

    assert.strictEqual(s.updates, 1,
      'the launch, a foreground return and a timer tick overlap by design; each one may ' +
      'not cost a fetch of sw.js');
  });

  await test('a check already in flight is not asked for a second time', async () => {
    const s = makeSandbox({ updateHangs: true });
    s.fireLoad();
    await flush();
    assert.strictEqual(s.updates, 1);

    s.now += INTERVAL_MS;
    s.fireVisibility();
    s.fireInterval();
    await flush();
    assert.strictEqual(s.updates, 1, 'the answer is already on its way');

    s.pending();                 // the check that was in flight finally answers
    await flush();

    s.now += INTERVAL_MS;
    s.fireInterval();
    await flush();
    assert.strictEqual(s.updates, 2,
      'and the in-flight flag must be cleared by the ANSWER, not left set — otherwise ' +
      'one slow check disables every later one');
  });

  await test('a failed check is silent and the next trigger asks again', async () => {
    const s = makeSandbox({ updateRejects: true });
    s.fireLoad();
    await flush();

    assert.strictEqual(s.updates, 1);
    assert.deepStrictEqual(s.warnings, [],
      'offline is not an error worth a console line — the next trigger covers it');

    s.now += INTERVAL_MS;
    s.fireInterval();
    await flush();
    assert.strictEqual(s.updates, 2);
  });

  await test('a hidden tab is not checked, and coming back is', async () => {
    const s = makeSandbox({ visibility: 'hidden' });
    s.fireLoad();
    await flush();
    assert.strictEqual(s.updates, 1, 'the launch still asks: it is a load, not a tick');

    s.now += INTERVAL_MS;
    s.fireInterval();
    await flush();
    assert.strictEqual(s.updates, 1,
      'a backgrounded dashboard must not spend a fetch per interval to learn nothing');

    s.visibility = 'visible';
    s.fireVisibility();
    await flush();
    assert.strictEqual(s.updates, 2, 'the foreground return is the reason to look now');
  });

  /* ---------------- applying it without a second launch ---------------- */

  await test('the new worker taking control reloads the page once', async () => {
    const s = makeSandbox();
    s.fireLoad();
    await flush();

    s.swListeners.controllerchange();
    s.swListeners.controllerchange();
    await flush();

    assert.strictEqual(s.reloads, 1,
      'the reload is what moves the shell; a second one would throw away the load it ' +
      'just delivered');
  });

  await test('a first install is not reloaded', async () => {
    const s = makeSandbox({ controller: false });
    s.fireLoad();
    await flush();

    s.swListeners.controllerchange();
    await flush();

    assert.strictEqual(s.reloads, 0,
      'clients.claim() fires controllerchange on a first install too, and there the ' +
      'reload would discard the load that just happened');
  });

  await test('the reload waits for a focused field to blur', async () => {
    let blurred = null;
    const field = {
      tagName: 'INPUT',
      addEventListener: (evt, fn) => { blurred = fn; }
    };
    const s = makeSandbox({ activeElement: field });
    s.fireLoad();
    await flush();

    s.swListeners.controllerchange();
    await flush();
    assert.strictEqual(s.reloads, 0, 'a half-typed login is not worth a release');
    assert.strictEqual(typeof blurred, 'function', 'the reload is re-armed on blur');

    s.activeElement = null;      // the field loses focus
    blurred();
    assert.strictEqual(s.reloads, 1);
  });

  /* ---------------- the gap: a worker that never activates ---------------- */

  await test('a worker already waiting at launch is told to skip waiting', async () => {
    const s = makeSandbox({ waiting: true });
    s.fireLoad();
    await flush();

    assert.strictEqual(s.postMessages.length, 1,
      'a waiting worker is the release sitting in the cache, unused, with the old page ' +
      'still on screen');
    /* JSON, not deepStrictEqual: the message is built inside the vm realm, so it carries
       that realm's prototype and a strict compare fails on identity, not on content. */
    assert.strictEqual(JSON.stringify(s.postMessages[0]), '{"type":"SKIP_WAITING"}');
  });

  await test('a worker that starts waiting after this launch is nudged too', async () => {
    const s = makeSandbox({ installing: true });
    s.fireLoad();
    await flush();

    assert.strictEqual(s.postMessages.length, 0, 'nothing is waiting yet');

    s.reg.waiting = s.madeWorker('waiting');         // install finished and parked
    s.reg.installing.state = 'installed';
    s.regListeners.updatefound();
    s.workerListeners['installing:statechange']();
    await flush();

    assert.strictEqual(s.postMessages.length, 1,
      'the nudge has to arrive on the event that creates the waiting worker');
    assert.strictEqual(JSON.stringify(s.postMessages[0]), '{"type":"SKIP_WAITING"}');
  });

  await test('an installing worker that is not installed yet is left alone', async () => {
    const s = makeSandbox({ installing: true });
    /* An older worker is still parked in `waiting` from an earlier cycle, so this is the
       test that separates "the install finished" from "an install is running": nudging on
       the wrong one hands the page a half-installed shell. */
    s.reg.waiting = s.madeWorker('waiting');
    s.fireLoad();
    await flush();
    assert.strictEqual(s.postMessages.length, 1, 'the parked one is nudged at launch');

    s.regListeners.updatefound();
    // state stays 'installing': the activate would leave a broken worker behind
    s.workerListeners['installing:statechange']();
    await flush();

    assert.strictEqual(s.postMessages.length, 1,
      'only an INSTALLED worker may be activated; activating a failed install is how a ' +
      'device loses its offline shell');
  });

  await test('sw.js answers the nudge by activating', async () => {
    const s = swSandbox();

    assert.strictEqual(typeof s.listeners.message, 'function',
      'sw.js must handle the message or the nudge is a no-op');
    s.listeners.message({ data: { type: 'SKIP_WAITING' } });
    assert.strictEqual(s.skipWaiting, 1);

    s.listeners.message({ data: { type: 'something-else' } });
    s.listeners.message({ data: null });
    s.listeners.message({});
    assert.strictEqual(s.skipWaiting, 1,
      'and only that exact message may; skipWaiting() on anything else would hand the ' +
      'page a half-installed shell');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
})();
