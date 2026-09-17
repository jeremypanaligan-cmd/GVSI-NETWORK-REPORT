// ====================== FETCH GATE TESTS ======================
// Run: node tests/fetch-gate.test.js
// Zero dependencies — loads fetch-gate.js into a vm sandbox with a stubbed
// fetchWithRetry and drives real (short) timers for the throttle window.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const GATE_SRC = fs.readFileSync(path.join(__dirname, '..', 'fetch-gate.js'), 'utf8');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Intervals started inside sandboxes — swept at the end so node can exit.
const ACTIVE_TIMERS = [];

// Fresh sandbox per test → isolated gate state.
function makeSandbox() {
  /* `now` pins the gate's clock when set, so ticker granularity can be tested
     without waiting real minutes. */
  const state = { fetchCount: 0, pending: [], now: null };
  const tabs = {};

  /* textContent is an accessor, not a plain field, so the sandbox can count
     writes the way a real browser pays for them: an assignment replaces the
     text node even when the string is identical. */
  function fakeEl(cls) {
    return {
      className: cls || '', children: [], _text: '', _attrs: {},
      textWrites: 0, attrWrites: 0,
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; this.textWrites++; },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
      },
      setAttribute(k, v) { this._attrs[k] = v; this.attrWrites++; },
      appendChild(c) { this.children.push(c); },
      querySelector(sel) {
        /* Recursive — matches real DOM descendant semantics */
        const cls = sel.slice(1);
        for (const c of this.children) {
          if ((c.className || '').split(' ').indexOf(cls) !== -1) return c;
          const found = c.querySelector(sel);
          if (found) return found;
        }
        return null;
      }
    };
  }

  const RealDate = Date;
  const sandbox = {
    console,
    /* The gate only ever calls Date.now(). */
    Date: { now: () => (state.now === null ? RealDate.now() : state.now) },
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); ACTIVE_TIMERS.push(h); return h; },
    clearInterval: h => {
      const i = ACTIVE_TIMERS.indexOf(h); if (i !== -1) ACTIVE_TIMERS.splice(i, 1);
      clearInterval(h);
    },
    fetchWithRetry: function (url) {
      state.fetchCount++;
      state.lastUrl = url;
      const d = deferred();
      state.pending.push(d);
      return d.promise;
    },
    /* Minimal DOM: getElementById('tab-x') auto-creates a tab shell with a
       .page-title-row — enough for the ticker chip lifecycle. */
    document: {
      createElement: tag => fakeEl(''),
      getElementById(id) {
        if (!tabs[id]) {
          const tab = fakeEl();
          tab.children.push(fakeEl('page-title-row'));
          tabs[id] = tab;
        }
        return tabs[id];
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(GATE_SRC, sandbox, { filename: 'fetch-gate.js' });

  return { gate: sandbox.fetchGate, state, tabs };
}

function tickerChip(tabs, type) {
  const row = tabs['tab-' + type].children[0];
  return row.querySelector('.module-refresh-ticker');
}

let passed = 0;
let total = 0;
async function test(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    console.error('  FAIL  ' + name);
    console.error('        ' + (err && err.message));
    process.exitCode = 1;
  }
}

(async () => {
  console.log('\nfetch-gate.js tests\n-------------------');

  await test('run(): two concurrent calls of same type = one network fetch', async () => {
    const { gate, state } = makeSandbox();
    const p1 = gate.run('nap', 'u1');
    const p2 = gate.run('nap', 'u2'); // joins the in-flight one
    assert.strictEqual(state.fetchCount, 1, 'expected a single fetch');
    state.pending[0].resolve([{ A: 'x' }]);
    const [d1, d2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual(d1, [{ A: 'x' }]);
    assert.deepStrictEqual(d2, [{ A: 'x' }]);
    assert.strictEqual(gate.isBusy('nap'), false, 'inflight cleared after settle');
  });

  await test('run(): different types do not share in-flight', async () => {
    const { gate, state } = makeSandbox();
    gate.run('nap', 'u-nap');
    gate.run('lcp', 'u-lcp');
    assert.strictEqual(state.fetchCount, 2, 'each type fetches independently');
    state.pending[0].resolve([]);
    state.pending[1].resolve({});
  });

  await test('run(): failure propagates and frees the slot', async () => {
    const { gate, state } = makeSandbox();
    const p1 = gate.run('olt', 'u1');
    state.pending[0].reject(new Error('HTTP 404'));
    await assert.rejects(p1, /HTTP 404/, 'caller keeps its own error UI');
    assert.strictEqual(gate.isBusy('olt'), false);

    const p2 = gate.run('olt', 'u2'); // must start a NEW fetch, not join the dead one
    assert.strictEqual(state.fetchCount, 2);
    state.pending[1].resolve([]);
    await p2;
  });

  await test('fetchQueued(): joins in-flight fetch (one round-trip, both applies)', async () => {
    const { gate, state } = makeSandbox();
    const applies = [];
    const p1 = gate.run('node', 'u1');
    const q1 = gate.fetchQueued('node', 'u1', d => applies.push(['q1', d]));
    assert.strictEqual(state.fetchCount, 1, 'queued call must not stack a duplicate');
    state.pending[0].resolve([{ A: 'n' }]);
    await p1; await q1;
    assert.deepStrictEqual(applies, [['q1', [{ A: 'n' }]]]);
  });

  await test('fetchQueued(): throttled inside window, deferred refetch runs after cooldown', async () => {
    const { gate, state } = makeSandbox();
    gate.configure({ minIntervalMs: 300 });

    const applies = [];
    const q1 = gate.fetchQueued('olt', 'u1', d => applies.push(['first', d]));
    state.pending[0].resolve([{ A: 1 }]);
    await q1;
    assert.deepStrictEqual(applies, [['first', [{ A: 1 }]]]);

    // Inside the 300ms window → throttled: resolves null immediately, no fetch.
    const t0 = Date.now();
    const q2 = await gate.fetchQueued('olt', 'u2', d => applies.push(['second', d]));
    assert.strictEqual(q2, null, 'throttled call resolves null right away');
    assert.strictEqual(state.fetchCount, 1, 'no fetch while throttled');
    assert.ok(Date.now() - t0 < 100, 'throttled call returns without waiting');

    // Deferred refetch fires after the cooldown with the LATEST url/apply.
    await sleep(450);
    assert.strictEqual(state.fetchCount, 2, 'deferred refetch ran after cooldown');
    assert.strictEqual(state.lastUrl, 'u2', 'deferred uses the latest url');
    state.pending[1].resolve([{ A: 2 }]);
    await sleep(20);
    assert.deepStrictEqual(applies[1], ['second', [{ A: 2 }]]);
  });

  await test('fetchQueued(): never rejects — resolves null on failure', async () => {
    const { gate, state } = makeSandbox();
    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].reject(new Error('boom'));
    const out = await q1;
    assert.strictEqual(out, null, 'silent failure, same as the old .catch(() => {})');
  });

  await test('mixed burst (run + fetchQueued + run) = exactly one fetch', async () => {
    const { gate, state } = makeSandbox();
    const applies = [];
    const r1 = gate.run('backbone', 'u1');
    const q1 = gate.fetchQueued('backbone', 'u1', d => applies.push(d));
    const r2 = gate.run('backbone', 'u2');
    assert.strictEqual(state.fetchCount, 1, 'the whole burst shares one round-trip');
    state.pending[0].resolve([{ A: 'bb' }]);
    await Promise.all([r1, r2, q1]);
    assert.deepStrictEqual(applies, [[{ A: 'bb' }]]);
    assert.ok(gate.lastFetch('backbone') > 0, 'success stamps lastFetchAt');
  });

  await test('run(): foreground fetch supersedes a pending deferred refetch', async () => {
    const { gate, state } = makeSandbox();
    gate.configure({ minIntervalMs: 300 });

    const applies = [];
    const q1 = gate.fetchQueued('olt', 'u1', d => applies.push(['q1', d]));
    state.pending[0].resolve([{ A: 1 }]);
    await q1;

    const q2 = gate.fetchQueued('olt', 'u2', d => applies.push(['q2', d])); // deferred
    const r1 = gate.run('olt', 'u3');                                        // foreground
    assert.strictEqual(state.fetchCount, 2, 'foreground starts its own fetch');
    state.pending[1].resolve([{ A: 3 }]);
    await r1; await q2;

    await sleep(450); // the old deferred deadline passes…
    assert.strictEqual(state.fetchCount, 2, 'superseded deferred never fires');
    assert.deepStrictEqual(applies.map(a => a[0]), ['q1'], 'deferred apply never called');
  });

  await test('timeout: hung fetch is abandoned and frees the slot', async () => {
    const { gate, state } = makeSandbox();
    gate.configure({ timeoutMs: 80 });

    const applies = [];
    const q1 = gate.fetchQueued('nap', 'u1', d => applies.push(d));
    const out = await q1; // underlying stub never resolves…
    assert.strictEqual(out, null, 'timeout surfaces as null on the queued path');
    assert.strictEqual(gate.isBusy('nap'), false, 'slot freed despite hung inner promise');

    const r1 = gate.run('nap', 'u2'); // module is not wedged
    assert.strictEqual(state.fetchCount, 2);
    state.pending[1].resolve([{ A: 'ok' }]);
    assert.deepStrictEqual(await r1, [{ A: 'ok' }]);
  });

  await test('configure(): invalid values are ignored', async () => {
    const { gate, state } = makeSandbox();
    gate.configure({ minIntervalMs: -5 });
    gate.configure({ timeoutMs: 0 });
    gate.configure(null);
    // Still functional with defaults:
    const q1 = gate.fetchQueued('lcp', 'u1', () => {});
    state.pending[0].resolve({});
    await q1;
    assert.strictEqual(state.fetchCount, 1);
  });

  await test('ticker: "No data yet" before any fetch, "Updated just now" after success', async () => {
    const { gate, state, tabs } = makeSandbox();
    gate.refreshTicker('olt');
    let chip = tickerChip(tabs, 'olt');
    assert.ok(chip, 'chip auto-created inside .page-title-row');
    assert.strictEqual(chip.textContent, 'No data yet');
    assert.strictEqual(chip._attrs['data-state'], 'ok');

    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].resolve([{ A: 1 }]);
    await q1;
    gate.refreshTicker('olt'); // what a module render calls
    chip = tickerChip(tabs, 'olt');
    assert.strictEqual(chip.textContent, 'Updated just now');
  });

  await test('ticker: throttled refetch flips chip to countdown, then back to ok', async () => {
    const { gate, state, tabs } = makeSandbox();
    gate.configure({ minIntervalMs: 300 });

    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].resolve([{ A: 1 }]);
    await q1;

    await gate.fetchQueued('olt', 'u2', () => {}); // deferred — inside the window
    gate.refreshTicker('olt');
    const chip = tickerChip(tabs, 'olt');
    assert.strictEqual(chip._attrs['data-state'], 'deferred');
    assert.ok(/^Refreshing in [1-9]s$/.test(chip.textContent), 'countdown text, got: ' + chip.textContent);

    await sleep(450); // deferred fires + succeeds
    await sleep(20);
    gate.refreshTicker('olt');
    assert.strictEqual(tickerChip(tabs, 'olt')._attrs['data-state'], 'ok', 'back to ok after refresh');
    assert.strictEqual(state.fetchCount, 2);
  });

  await test('ticker: N throttled queued calls collapse into ONE deferred refetch', async () => {
    const { gate, state } = makeSandbox();
    gate.configure({ minIntervalMs: 300 });

    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].resolve([{ A: 1 }]);
    await q1;

    // Five users hammer the tab inside the window — one deferred refetch total.
    const results = await Promise.all([
      gate.fetchQueued('olt', 'u2', () => {}),
      gate.fetchQueued('olt', 'u3', () => {}),
      gate.fetchQueued('olt', 'u4', () => {}),
      gate.fetchQueued('olt', 'u5', () => {}),
      gate.fetchQueued('olt', 'u6', () => {})
    ]);
    assert.deepStrictEqual(results, [null, null, null, null, null], 'all throttled calls resolve null');
    assert.strictEqual(state.fetchCount, 1, 'no fetches during throttle');

    await sleep(450);
    await sleep(20);
    assert.strictEqual(state.fetchCount, 2, 'exactly one deferred refetch ran');
    assert.strictEqual(state.lastUrl, 'u6', 'latest deferred caller wins (each deferral replaces the last)');
  });

  await test('ticker: repainting an unchanged chip performs ZERO DOM writes', async () => {
    const { gate, state, tabs } = makeSandbox();

    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].resolve([{ A: 1 }]);
    await q1;

    gate.refreshTicker('olt');
    const chip = tickerChip(tabs, 'olt');
    assert.strictEqual(chip.textWrites, 1, 'first paint writes the text once');
    assert.strictEqual(chip.attrWrites, 1, 'first paint writes data-state once');

    /* The 1s interval calls this every second for as long as the tab lives, and
       the same text comes back each time. Before the guard, every one of those
       ticks replaced the text node — a real mutation per second per module. */
    for (let i = 0; i < 5; i++) gate.refreshTicker('olt');
    assert.strictEqual(chip.textWrites, 1, 'unchanged text must not be reassigned');
    assert.strictEqual(chip.attrWrites, 1, 'unchanged data-state must not be reassigned');
    assert.strictEqual(chip.textContent, 'Updated just now');
  });

  await test('ticker: a genuine change still reaches the chip (guard is not a swallow)', async () => {
    const { gate, state, tabs } = makeSandbox();
    gate.configure({ minIntervalMs: 300 });

    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].resolve([{ A: 1 }]);
    await q1;
    gate.refreshTicker('olt');

    const chip = tickerChip(tabs, 'olt');
    const textBefore = chip.textWrites;
    const attrBefore = chip.attrWrites;
    assert.strictEqual(chip.getAttribute('data-state'), 'ok');

    await gate.fetchQueued('olt', 'u2', () => {}); // deferred → state flips
    gate.refreshTicker('olt');
    assert.strictEqual(chip.getAttribute('data-state'), 'deferred', 'state change is written');
    assert.ok(chip.textWrites > textBefore, 'countdown text is written');
    assert.ok(chip.attrWrites > attrBefore, 'data-state write is counted');
  });

  await test('ticker: age ticks in seconds for one minute, then in minutes', async () => {
    const { gate, state, tabs } = makeSandbox();
    state.now = 1000000;

    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].resolve([{ A: 1 }]);
    await q1;
    gate.refreshTicker('olt');
    const chip = tickerChip(tabs, 'olt');

    state.now = 1000000 + 3000;
    gate.refreshTicker('olt');
    assert.strictEqual(chip.textContent, 'Updated just now');

    state.now = 1000000 + 30000;
    gate.refreshTicker('olt');
    assert.strictEqual(chip.textContent, 'Updated 30s ago', 'seconds while it is still fresh');

    /* Past a minute the string stops changing every tick — this is what makes
       the write guard above pay off for a long-lived tab. */
    state.now = 1000000 + 90000;
    gate.refreshTicker('olt');
    assert.strictEqual(chip.textContent, 'Updated 2m ago');

    const writes = chip.textWrites;
    for (let i = 0; i < 5; i++) { state.now += 1000; gate.refreshTicker('olt'); }
    assert.strictEqual(chip.textWrites, writes, 'minute-granularity text is stable within the minute');
    assert.strictEqual(chip.textContent, 'Updated 2m ago');

    state.now = 1000000 + 3600 * 1000;
    gate.refreshTicker('olt');
    assert.strictEqual(chip.textContent, 'Updated 60m ago');
  });

  // Ticker tests leave 1s intervals running — sweep them so node can exit.
  ACTIVE_TIMERS.splice(0).forEach(h => clearInterval(h));

  /* Derived from the tests that actually ran — the old hardcoded total turned
     the summary into noise the moment a test was added. */
  console.log('\n' + passed + ' passed, ' + (total - passed) + ' failed\n');
})();
