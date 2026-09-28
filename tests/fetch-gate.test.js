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
function makeSandbox(opts) {
  opts = opts || {};

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
  /* The gate reads the clock (Date.now) and, for a build stamp, formats one
     (new Date(ms)) — so the stub has to be a real constructor with a pinned
     now(), not just an object carrying a now() method. */
  function SandboxDate(...args) { return new RealDate(...args); }
  SandboxDate.now = () => (state.now === null ? RealDate.now() : state.now);

  const sandbox = {
    console,
    Date: SandboxDate,
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

  /* A stand-in for cdn-source.js. It matches the real file at the one seam the escape turns on:
     the build stamp is handed to the gate from INSIDE this promise, before the gate's own success
     handler runs — which is the order that makes a stale stamp visible to a read at all. */
  const edge = { calls: 0, pending: [] };
  if (opts.cdn) {
    sandbox.cdnSource = {
      enabled: opts.cdnEnabled || (() => true),
      dataUrl: type => 'edge/' + type,
      bundleUrl: () => 'edge/_bundle',
      fetchJson: function (type, url) {
        edge.calls++;
        const d = deferred();
        edge.pending.push({ type, url, d });
        return d.promise;
      }
    };
  }
  /* Answer edge read #i the way cdn-source.js does: stamp the gate first, then resolve. A builtAt
     of 0 means the answer carried no stamp — legal, and not stale. */
  edge.answer = function (i, data, builtAt) {
    const rec = edge.pending[i];
    if (builtAt > 0) sandbox.fetchGate.noteBuiltAt(rec.type, builtAt);
    rec.d.resolve(data);
    return rec;
  };

  vm.runInContext(GATE_SRC, sandbox, { filename: 'fetch-gate.js' });

  return { gate: sandbox.fetchGate, state, tabs, edge, document: sandbox.document };
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

  /* -------------------- the honest chip (server build stamp) -------------------- */

  function clockOf(ms) {
    const d = new Date(ms);
    const hh = (d.getHours() < 10 ? '0' : '') + d.getHours();
    const mm = (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
    return hh + ':' + mm;
  }

  await test('ticker: a build stamp makes the chip report the DATA age, not the request age', async () => {
    const { gate, state, tabs } = makeSandbox();
    state.now = 1700000000000;
    const builtAt = state.now - 65000;   // the payload is just over a minute old

    gate.noteBuiltAt('olt', builtAt);
    gate.refreshTicker('olt');
    const chip = tickerChip(tabs, 'olt');

    assert.strictEqual(chip.textContent, 'Data as of ' + clockOf(builtAt) + ' · 1m ago',
      'the wall clock keeps it meaningful when it is minutes old, not seconds');
    assert.strictEqual(chip.getAttribute('data-state'), 'ok', 'a minute old is not stale');
  });

  await test('ticker: the stamp beats a successful fetch — the 11-minute lie, refused', async () => {
    /* The exact incident shape: the app fetched a moment ago (so the old chip
       would say "just now"), and the server answered from a cached snapshot built
       long before. The chip has to report the snapshot, because that is what is
       on screen. */
    const { gate, state, tabs } = makeSandbox();

    /* The threshold that was in force on 2026-09-18, pinned so this case keeps testing the incident
       it was written for. The default is 15 minutes now (see STALE_AFTER_MS in fetch-gate.js), and
       at that setting eleven minutes is simply not stale, which would quietly turn this test into
       an assertion about a chip that happens to be green. */
    gate.configure({ staleAfterMs: 10 * 60 * 1000 });
    state.now = 1700000000000;
    const builtAt = state.now - 11 * 60 * 1000;   // built 11 minutes before the fetch

    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].resolve([{ A: 1 }]);
    await q1;
    gate.noteBuiltAt('olt', builtAt);      // ... the payload it returned said this
    gate.refreshTicker('olt');

    const chip = tickerChip(tabs, 'olt');
    assert.strictEqual(chip.textContent, 'Data as of ' + clockOf(builtAt) + ' · 11m ago');
    assert.strictEqual(chip.getAttribute('data-state'), 'stale',
      'eleven minutes of staleness must look like a warning, not a countdown');
  });

  await test('ticker: the staleness threshold is configurable and slightly tolerant', async () => {
    const { gate, state, tabs } = makeSandbox();
    gate.configure({ staleAfterMs: 60000 });
    state.now = 1700000000000;

    gate.noteBuiltAt('olt', state.now - 59000);
    gate.refreshTicker('olt');
    assert.strictEqual(tickerChip(tabs, 'olt').getAttribute('data-state'), 'ok');

    gate.noteBuiltAt('olt', state.now - 61000);
    gate.refreshTicker('olt');
    assert.strictEqual(tickerChip(tabs, 'olt').getAttribute('data-state'), 'stale');
  });

  await test('ticker: a stamp that is not a usable time is ignored, not trusted', async () => {
    const { gate, state, tabs } = makeSandbox();
    state.now = 1700000000000;

    gate.noteBuiltAt('olt', 0);
    gate.noteBuiltAt('olt', NaN);
    gate.noteBuiltAt('olt', undefined);
    gate.noteBuiltAt('olt', 'later');

    const q1 = gate.fetchQueued('olt', 'u1', () => {});
    state.pending[0].resolve([{ A: 1 }]);
    await q1;
    gate.refreshTicker('olt');

    assert.strictEqual(tickerChip(tabs, 'olt').textContent, 'Updated just now',
      'no usable stamp means the old fetch-time wording, which is what an older ' +
      'server deserves rather than a broken chip');
    assert.strictEqual(gate.dataBuiltAt('olt'), 0);
  });

  await test('ticker: a stable stamp keeps the chip quiet (no per-second repaint)', async () => {
    const { gate, state, tabs } = makeSandbox();
    state.now = 1700000000000;
    gate.noteBuiltAt('olt', state.now - 120000);
    gate.refreshTicker('olt');
    const chip = tickerChip(tabs, 'olt');

    const writes = chip.textWrites;
    const attrs = chip.attrWrites;
    for (let i = 0; i < 5; i++) { state.now += 1000; gate.refreshTicker('olt'); }

    assert.strictEqual(chip.textWrites, writes,
      'minute-granularity text must stay stable within the minute, stamp or no stamp');
    assert.strictEqual(chip.attrWrites, attrs, 'and the stale flag must not flicker');
  });

  await test('ticker: dataBuiltAt() exposes the stamp rev-watch verifies against', async () => {
    const { gate, state } = makeSandbox();
    assert.strictEqual(gate.dataBuiltAt('olt'), 0, 'no stamp before one is reported');
    gate.noteBuiltAt('olt', 1700000000123);
    assert.strictEqual(gate.dataBuiltAt('olt'), 1700000000123);
    state.now = 1700000000123;
    assert.strictEqual(gate.dataBuiltAt('nap'), 0, 'per type, not global');
  });

  /* ------------------------------------------------------------------
     seedLastFetch(): the fetch time of a payload that came from STORAGE

     A restored payload is drawn before anything is asked for, so its freshness
     chip has to report the age of THAT payload. An empty clock would print
     "No data yet" over a table full of rows — and stamping it `now` would be
     the same lie pointing the other way, with the extra cost that the age would
     reset on every reload and the data would look fresh forever.
   * ------------------------------------------------------------------ */

  await test('seedLastFetch(): a restored payload reports its own age, not "No data yet"', async () => {
    const { gate, state, tabs } = makeSandbox();
    state.now = 1700000000000;

    gate.seedLastFetch('nap', state.now - 20 * 60000);
    gate.refreshTicker('nap');

    const chip = tickerChip(tabs, 'nap');
    assert.ok(chip, 'chip auto-created');
    assert.strictEqual(chip.textContent, 'Updated 20m ago',
      'the chip must report when the payload was FETCHED, not that nothing has been');
  });

  await test('seedLastFetch(): refused for junk, and it never moves the stamp backwards', async () => {
    const { gate, state } = makeSandbox();
    const at = 1700000000000;

    [0, -1, NaN, Infinity, 'yesterday', null, undefined].forEach(bad => {
      assert.strictEqual(gate.seedLastFetch('nap', bad), false, 'junk stamp refused: ' + String(bad));
    });

    assert.strictEqual(gate.seedLastFetch('nap', at), true, 'a real stamp is accepted');
    assert.strictEqual(gate.seedLastFetch('nap', at - 60000), false,
      'an older stamp may not overwrite a newer one — the opening bundle stamps `now` first');
    assert.strictEqual(gate.seedLastFetch('nap', at), false, 'and the same stamp changes nothing');
  });

  await test('seedLastFetch(): a real fetch still supersedes the seed, and types stay separate', async () => {
    const { gate, state, tabs } = makeSandbox();
    state.now = 1700000000000;

    gate.seedLastFetch('olt', state.now - 20 * 60000);
    assert.strictEqual(gate.seedLastFetch('olt', state.now), true, 'the seed is not sticky');

    gate.refreshTicker('nap');
    assert.strictEqual(tickerChip(tabs, 'nap').textContent, 'No data yet',
      'seeding one type must not stamp another');

    gate.refreshTicker('olt');
    assert.strictEqual(tickerChip(tabs, 'olt').textContent, 'Updated just now');
  });

  /* -------------------- the stale escape (an edge copy that is too old) -------------------- */

  await test('stale: the default threshold clears a heartbeat plus one warm cycle', async () => {
    /* The two server numbers this has to survive: EDGE_PUBLISH_HEARTBEAT_MS (8 min) plus the
       5-minute pass means a HEALTHY copy can be thirteen minutes old at the very moment it is
       rewritten. Crossing that line is what put a red chip in front of the operator on 2026-09-28,
       so the default is asserted here on the real clock: a default is behavior, not a comment.
       The cross-file half of the invariant is in tests/publish-server.test.js. */
    const { gate, tabs } = makeSandbox();
    const now = Date.now();

    gate.noteBuiltAt('nap', now - 13 * 60 * 1000);
    assert.strictEqual(gate.isStale('nap'), false, 'the worst healthy age is not stale');
    gate.refreshTicker('nap');
    assert.strictEqual(tickerChip(tabs, 'nap').getAttribute('data-state'), 'ok');

    gate.noteBuiltAt('nap', now - 16 * 60 * 1000);
    assert.strictEqual(gate.isStale('nap'), true, 'a missed heartbeat is named');
    gate.refreshTicker('nap');
    assert.strictEqual(tickerChip(tabs, 'nap').getAttribute('data-state'), 'stale');
  });

  await test('escape: a stale edge copy buys exactly one origin read, and the screen is repaired', async () => {
    const { gate, state, edge } = makeSandbox({ cdn: true });
    state.now = 1700000000000;
    const drawn = [];

    const q = gate.fetchQueued('nap', 'exec/nap', d => drawn.push(d));
    assert.strictEqual(edge.calls, 1, 'the edge is tried first');
    assert.strictEqual(state.fetchCount, 0, 'and /exec is not asked while the edge is answering');

    edge.answer(0, [{ A: 'edge' }], state.now - 16 * 60 * 1000);   // sixteen minutes old
    await q;

    assert.strictEqual(gate.isStale('nap'), true, 'sixteen minutes is past the threshold');
    assert.strictEqual(state.fetchCount, 1, 'so one origin read is spent on it');
    assert.strictEqual(state.lastUrl, 'exec/nap', 'the URL the module itself gave the gate');
    assert.strictEqual(edge.calls, 1, 'and the escape does not ask the edge again');

    state.pending[0].resolve([{ A: 'origin' }]);
    await sleep(0);

    assert.deepStrictEqual(drawn, [[{ A: 'edge' }], [{ A: 'origin' }]],
      'the module is redrawn from the origin — the screen is repaired, not just the console');
    assert.strictEqual(gate.isStale('nap'), false,
      'and the edge stamp is dropped: four of the five payloads carry none of their own, so keeping ' +
      'an old one would leave the chip red over bytes fetched a moment ago');
    assert.strictEqual(gate.dataBuiltAt('nap'), 0);
  });

  await test('escape: a current edge copy spends nothing at all', async () => {
    const { gate, state, edge } = makeSandbox({ cdn: true });
    state.now = 1700000000000;

    const q = gate.fetchQueued('lcp', 'exec/lcp', () => {});
    edge.answer(0, [], state.now - 60 * 1000);
    await q;

    assert.strictEqual(state.fetchCount, 0, 'a minute-old copy is healthy, not an outage');
    assert.strictEqual(gate.escapeState('lcp'), null, 'and no episode is opened for it');
  });

  await test('escape: refused for a type nothing has drawn, for a hidden tab, and with the edge off', async () => {
    /* (1) Foreground only. The loader is handed the data and renders it itself, registering no
       applier — so an escape would fetch bytes with nothing able to draw them. */
    const a = makeSandbox({ cdn: true });
    a.state.now = 1700000000000;
    const qa = a.gate.run('nap', 'exec/nap');
    a.edge.answer(0, [], a.state.now - 20 * 60 * 1000);
    await qa;
    assert.strictEqual(a.state.fetchCount, 0, 'no applier, no escape');

    /* (2) A tab nobody is looking at. visibilitychange brings a refresh when it returns, and that
       read escapes then — which is the second half of this case. */
    const b = makeSandbox({ cdn: true });
    b.state.now = 1700000000000;
    b.document.visibilityState = 'hidden';
    b.gate.fetchQueued('nap', 'exec/nap', () => {});
    b.edge.answer(0, [], b.state.now - 20 * 60 * 1000);
    await sleep(0);
    assert.strictEqual(b.state.fetchCount, 0, 'a hidden tab does not spend an execution');

    b.document.visibilityState = 'visible';
    b.gate.refreshTicker('nap');
    assert.strictEqual(b.state.fetchCount, 1, 'the same crossing acts once the tab is visible');

    /* (3) The edge switched off or in cooldown: /exec is already the source, so an escape would
       mean asking that same origin a second time. */
    const c = makeSandbox({ cdn: true, cdnEnabled: () => false });
    c.state.now = 1700000000000;
    c.gate.fetchQueued('nap', 'exec/nap', () => {});
    assert.strictEqual(c.edge.calls, 0, 'a disabled edge is not read at all');
    c.state.pending[0].resolve([]);
    await sleep(0);
    c.gate.noteBuiltAt('nap', c.state.now - 20 * 60 * 1000);
    c.gate.refreshTicker('nap');
    assert.strictEqual(c.state.fetchCount, 1, 'and no second origin read is bought for it');
  });

  await test('escape: the gap holds, the backoff doubles, and a current read ends the episode', async () => {
    const { gate, state, edge } = makeSandbox({ cdn: true });
    state.now = 1700000000000;

    const q = gate.fetchQueued('nap', 'exec/nap', () => {});
    edge.answer(0, [], state.now - 20 * 60 * 1000);
    await q;
    assert.strictEqual(state.fetchCount, 1, 'the first escape');
    assert.strictEqual(gate.escapeState('nap').gapMs, 5 * 60 * 1000, 'five minutes before the next');

    /* Let that read land and put the stamp back to stale: the origin answered and the publisher is
       still behind, which is the state the backoff exists for. */
    const settleEscape = async (i) => { state.pending[i].resolve([]); await sleep(0); };
    await settleEscape(0);

    state.now += 60 * 1000;
    gate.noteBuiltAt('nap', state.now - 20 * 60 * 1000);
    gate.refreshTicker('nap');
    assert.strictEqual(state.fetchCount, 1, 'a repaint one minute later spends nothing');

    state.now += 4 * 60 * 1000;
    gate.noteBuiltAt('nap', state.now - 20 * 60 * 1000);
    gate.refreshTicker('nap');
    assert.strictEqual(state.fetchCount, 2, 'five minutes on, the escape is allowed again');
    assert.strictEqual(gate.escapeState('nap').gapMs, 10 * 60 * 1000,
      'and because the last one did not cure it, the next waits twice as long');
    await settleEscape(1);

    state.now += 5 * 60 * 1000;
    gate.noteBuiltAt('nap', state.now - 20 * 60 * 1000);
    gate.refreshTicker('nap');
    assert.strictEqual(state.fetchCount, 2, 'ten minutes after the second is not yet twenty');

    state.now += 5 * 60 * 1000;
    gate.noteBuiltAt('nap', state.now - 20 * 60 * 1000);
    gate.refreshTicker('nap');
    assert.strictEqual(state.fetchCount, 3, 'the doubled gap elapses at ten minutes');

    gate.noteBuiltAt('nap', state.now);
    assert.strictEqual(gate.escapeIfStale('nap'), false, 'a current read has nothing to escape');
    assert.strictEqual(gate.escapeState('nap').count, 0, 'and it forgets the whole episode');
    assert.strictEqual(gate.escapeState('nap').gapMs, 5 * 60 * 1000, 'backoff included');
  });

  await test('escape: an edge refusal that falls back to /exec is not escaped again', async () => {
    /* The expired-token shape: the edge is enabled, the read is refused, and the very same read is
       answered by /exec — which is the escape's own destination. Escaping it would spend an
       execution re-reading the source that just answered. */
    const { gate, state, edge } = makeSandbox({ cdn: true });
    state.now = 1700000000000;

    gate.noteBuiltAt('nap', state.now - 20 * 60 * 1000);   // the stamp already on the chip, and old
    const q = gate.fetchQueued('nap', 'exec/nap', () => {});
    edge.pending[0].d.reject(new Error('edge HTTP 401'));
    await sleep(0);
    assert.strictEqual(state.fetchCount, 1, 'the refusal itself falls through to /exec');
    assert.strictEqual(state.lastUrl, 'exec/nap');

    state.pending[0].resolve([]);
    await q;
    assert.strictEqual(state.fetchCount, 1, 'and that fallback is not escaped on top of itself');
  });

  await test('escape: one crossing is one read, and a busy type buys nothing', async () => {
    const { gate, state, edge } = makeSandbox({ cdn: true });
    state.now = 1700000000000;

    const q = gate.fetchQueued('nap', 'exec/nap', () => {});
    edge.answer(0, [], state.now - 20 * 60 * 1000);
    await q;
    assert.strictEqual(state.fetchCount, 1, 'the crossing spent its one read');
    assert.strictEqual(gate.isBusy('nap'), true, 'and that read is still in flight');

    /* The chip repaints once a second for as long as the tab lives, and the type being busy is one
       of the reasons escapeIfStale() refuses: an answer is already on its way. */
    gate.refreshTicker('nap');
    gate.refreshTicker('nap');
    assert.strictEqual(state.fetchCount, 1, 'a busy type buys a second execution for nothing');
  });

  // Ticker tests leave 1s intervals running — sweep them so node can exit.
  ACTIVE_TIMERS.splice(0).forEach(h => clearInterval(h));

  /* Derived from the tests that actually ran — the old hardcoded total turned
     the summary into noise the moment a test was added. */
  console.log('\n' + passed + ' passed, ' + (total - passed) + ' failed\n');
})();
