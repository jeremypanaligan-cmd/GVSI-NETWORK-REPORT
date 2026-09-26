// ====================== MODULE CACHE STORE TESTS ======================
// Run: node tests/cache-store.test.js
//
// The store's whole job is to make a COLD START paint before the network answers, which means
// every one of its failure modes is a rendering bug rather than a storage bug:
//
//   - a payload restored too old           → the app shows a picture it should have replaced
//   - a payload restored without its age   → a table reporting "No data yet" over rows
//   - a stamp in the FUTURE                → an age that never expires, so that stale picture is
//                                            redrawn on every launch, forever
//   - an empty snapshot overwriting a good one → the store destroys its own contents on a timer
//   - OLT rows without their meta          → cards whose numbers disagree with the list under them
//   - a throw out of any of it             → the cache breaks the app it exists to accelerate
//
// So this suite drives the shipped file against a fake localStorage, including the two ways
// storage actually fails on a phone (quota on write, and an accessor that throws in private mode).

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STORE_SRC = fs.readFileSync(path.join(__dirname, '..', 'cache-store.js'), 'utf8');

const NOW = 1700000000000;
const MIN = 60000;

/* Everything the store builds is built in the vm's realm, so an identical object has a different
   Object.prototype and `deepStrictEqual` rejects it outright. Round-tripping the ACTUAL value
   back through JSON puts it in this realm and keeps the comparison strict about its content. */
const host = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fakeStorage(initial) {
  const map = Object.assign({}, initial || {});
  const api = {
    map,
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: (k, v) => { api.writes = (api.writes || 0) + 1; map[k] = String(v); },
    removeItem: (k) => { delete map[k]; },
    writes: 0
  };
  return api;
}

/* A storage whose accessor itself throws — Safari in private mode, and the one failure a
   try/catch around getItem does not cover. */
function hostileStorage() {
  return {
    get getItem() { throw new Error('storage is not available'); },
    get setItem() { throw new Error('storage is not available'); },
    get removeItem() { throw new Error('storage is not available'); }
  };
}

function makeSandbox(options) {
  const o = options || {};
  const state = {
    now: NOW,
    lastFetch: o.lastFetch || {},
    seeds: [],      // [type, at] pairs handed to the gate
    built: [],      // [type, at] pairs handed to the gate's build stamp
    listeners: {},
    interval: null
  };

  const RealDate = Date;
  function SandboxDate(...args) { return new RealDate(...args); }
  SandboxDate.now = () => state.now;

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Date: SandboxDate,
    setInterval: (fn, ms) => { state.interval = { fn, ms }; return { fake: true }; },
    clearInterval: () => {},
    addEventListener: (name, fn) => { state.listeners[name] = fn; },
    fetchGate: o.fetchGate || {
      lastFetch: (type) => state.lastFetch[type] || 0,
      seedLastFetch: (type, at) => { state.seeds.push([type, at]); return true; },
      noteBuiltAt: (type, at) => { state.built.push([type, at]); }
    }
  };

  if (o.storage !== null) sandbox.localStorage = o.storage === undefined ? fakeStorage() : o.storage;
  if (o.withPageGlobals !== false) {
    sandbox.dataCache = o.dataCache || { nap: null, lcp: null, olt: null, node: null, backbone: null };
    sandbox.oltMeta = o.oltMeta === undefined ? null : o.oltMeta;
    sandbox.rawOltData = o.rawOltData || [];
  }
  sandbox.window = sandbox;
  sandbox.document = {
    addEventListener: (name, fn) => { state.listeners[name] = fn; },
    visibilityState: 'visible'
  };

  vm.createContext(sandbox);
  vm.runInContext(STORE_SRC, sandbox, { filename: 'cache-store.js' });
  return { store: sandbox.moduleCache, sandbox, state };
}

function entry(data, at, meta) {
  const e = { at: at === undefined ? NOW : at, data: data };
  if (meta !== undefined) e.meta = meta;
  return e;
}

const OLT_META = { builtAt: NOW - 5 * MIN, up: 461, down: 2, total: 463 };

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
  console.log('\ncache-store.js tests\n-------------------');

  await test('it exposes one key, one schema version and one age table', () => {
    const { store } = makeSandbox();
    assert.strictEqual(store.KEY, 'netpulse_datacache_v1');
    assert.strictEqual(store.VERSION, 1);
    assert.deepStrictEqual(host(store.MAX_AGE_MS).backbone, 10 * MIN,
      'every module has an age cap it can be judged by');
    assert.deepStrictEqual(host(store.types).slice().sort(), ['backbone', 'lcp', 'nap', 'node', 'olt']);
  });

  await test('round trip: what goes in comes back out, per type', () => {
    const { store } = makeSandbox();
    const raw = store.serializeModuleCache({
      nap: entry([{ A: 'LUZON', P: 'BENGUET' }]),
      lcp: entry({ lcpAging: [{ A: 'LUZON' }], lcpImpact: [] }),
      olt: entry([{ S: 'DOWN' }], NOW, OLT_META)
    });
    const back = host(store.parseModuleCache(raw, NOW));

    assert.deepStrictEqual(back.nap.data, [{ A: 'LUZON', P: 'BENGUET' }]);
    assert.deepStrictEqual(back.lcp.data, { lcpAging: [{ A: 'LUZON' }], lcpImpact: [] });
    assert.deepStrictEqual(back.olt.data, [{ S: 'DOWN' }]);
    assert.deepStrictEqual(back.olt.meta, OLT_META);
    assert.strictEqual(back.nap.at, NOW, 'the fetch time is what makes the age honest');
  });

  await test('an entry past its own cap is dropped, and the others are not', () => {
    const { store } = makeSandbox();
    const raw = store.serializeModuleCache({
      nap: entry([1], NOW),                    // cap 60 min
      olt: entry([2], NOW, OLT_META),          // cap 15 min
      node: entry([3], NOW)                    // cap 10 min
    });
    const back = host(store.parseModuleCache(raw, NOW + 20 * MIN));

    assert.ok(back.nap, 'nap is still inside its 60 min cap');
    assert.strictEqual(back.olt, undefined, 'olt is 20 min old against a 15 min cap');
    assert.strictEqual(back.node, undefined, 'node is 20 min old against a 10 min cap');
    assert.strictEqual(Object.keys(back).length, 1, 'one stale module must not cost the others');
  });

  await test('the cap boundary is inclusive at the cap and exclusive one millisecond past it', () => {
    const { store } = makeSandbox();
    const raw = store.serializeModuleCache({ nap: entry([1], NOW) });

    assert.ok(host(store.parseModuleCache(raw, NOW + 60 * MIN)).nap, 'exactly at the cap is still usable');
    assert.strictEqual(host(store.parseModuleCache(raw, NOW + 60 * MIN + 1)).nap, undefined,
      'one ms past it is not');
  });

  await test('a stamp in the FUTURE is refused — an age that never expires is the bug, not the guard', () => {
    const { store } = makeSandbox();
    const raw = store.serializeModuleCache({ nap: entry([1], NOW + MIN) });
    assert.strictEqual(host(store.parseModuleCache(raw, NOW)).nap, undefined,
      'a clock that moved backwards would otherwise keep a stale picture forever');
  });

  await test('a schema move or a corrupt value discards the snapshot instead of half-reading it', () => {
    const { store } = makeSandbox();
    const old = JSON.stringify({ v: 0, types: { nap: { at: NOW, data: [1] } } });
    assert.deepStrictEqual(host(store.parseModuleCache(old, NOW)), {});
    assert.deepStrictEqual(host(store.parseModuleCache('{not json', NOW)), {});
    assert.deepStrictEqual(host(store.parseModuleCache('', NOW)), {});
    assert.deepStrictEqual(host(store.parseModuleCache(null, NOW)), {});
    assert.deepStrictEqual(host(store.parseModuleCache('{"v":1}', NOW)), {}, 'no types map, nothing to read');
    assert.deepStrictEqual(host(store.parseModuleCache('{"v":1,"types":[]}', NOW)), {});
  });

  await test('a payload with no honest fetch time is not written at all', () => {
    const { store, sandbox } = makeSandbox();
    const raw = store.serializeModuleCache({
      nap: entry([1], 0),
      lcp: { data: [2] },            // no `at` at all
      node: { at: NaN, data: [3] },
      backbone: { data: [4] }
    });
    assert.deepStrictEqual(host(store.parseModuleCache(raw, NOW)), {},
      '`now` would claim this data is fresher than it is, so none of it is stored');
    assert.strictEqual(sandbox.localStorage.map[store.KEY], undefined, 'nothing reached storage either');
  });

  await test('OLT rows without their meta are refused — cards and list must not disagree', () => {
    const { store } = makeSandbox();
    const raw = store.serializeModuleCache({ olt: entry([{ S: 'DOWN' }], NOW) });
    assert.deepStrictEqual(host(store.parseModuleCache(raw, NOW)), {});

    const smuggled = JSON.stringify({ v: 1, types: { olt: { at: NOW, data: [{ S: 'DOWN' }] } } });
    assert.deepStrictEqual(host(store.parseModuleCache(smuggled, NOW)), {},
      'and one that got in another way is dropped on the way out');
  });

  await test('restore puts each payload where its module reads it, and tells the gate the age', () => {
    const { store, sandbox, state } = makeSandbox();
    const rows = [{ S: 'DOWN' }];
    store.writeModuleCache({
      nap: entry([{ A: 'LUZON' }]),
      olt: entry(rows, NOW - 3 * MIN, OLT_META)
    });

    const restored = host(store.restoreModuleCache()).sort();

    assert.deepStrictEqual(restored, ['nap', 'olt']);
    assert.deepStrictEqual(host(sandbox.dataCache.nap), [{ A: 'LUZON' }]);
    assert.deepStrictEqual(host(sandbox.dataCache.olt), rows);
    assert.deepStrictEqual(host(sandbox.rawOltData), rows, 'OLT renders off rawOltData, not off dataCache');
    assert.deepStrictEqual(host(sandbox.oltMeta), OLT_META, 'without meta the cards would compute from rows');
    assert.deepStrictEqual(host(state.seeds).sort(), [['nap', NOW], ['olt', NOW - 3 * MIN]],
      'the gate is told when each payload was fetched, or the chip reads "No data yet"');
    assert.deepStrictEqual(host(state.built), [['olt', OLT_META.builtAt]],
      'OLT carries the server\'s own build time, so the chip can report the DATA age');
  });

  await test('restore leaves the types it has nothing for untouched', () => {
    const { store, sandbox } = makeSandbox();
    store.writeModuleCache({ backbone: entry([{ P: 'BENGUET' }]) });

    store.restoreModuleCache();

    assert.deepStrictEqual(host(sandbox.dataCache.backbone), [{ P: 'BENGUET' }]);
    assert.strictEqual(sandbox.dataCache.nap, null, 'a module with no snapshot still fetches');
    assert.strictEqual(sandbox.dataCache.lcp, null);
  });

  await test('restore on an empty or expired store is a clean no-op', () => {
    const empty = makeSandbox();
    assert.deepStrictEqual(host(empty.store.restoreModuleCache()), []);
    assert.strictEqual(empty.sandbox.dataCache.nap, null);

    const expired = makeSandbox();
    expired.store.writeModuleCache({ nap: entry([1], NOW) });
    expired.state.now = NOW + 61 * MIN;
    assert.deepStrictEqual(host(expired.store.restoreModuleCache()), [], 'a payload can age out across sessions');
  });

  await test('a refresh that fails does not erase the snapshot of the module it failed on', () => {
    const { store, sandbox, state } = makeSandbox();
    state.lastFetch = { nap: NOW, backbone: NOW };
    sandbox.dataCache.nap = [{ A: 'LUZON' }];
    sandbox.dataCache.backbone = [{ P: 'BENGUET' }];
    store.persistModuleCache();

    /* What a failed refresh leaves behind: the module keeps its SCREEN (PART-025) but its
       `dataCache` slot is empty, because the refresh emptied it and the read never put anything
       back. The timer fires here all the time. A snapshot that replaces wholesale would lose the
       only copy of nap at exactly the moment it mattered most. */
    sandbox.dataCache.nap = null;
    state.now = NOW + MIN;                      // the timer fires later, as it does in life
    state.lastFetch = { nap: 0, backbone: NOW + MIN };
    sandbox.dataCache.backbone = [{ P: 'IFUGAO' }];
    assert.strictEqual(store.persistModuleCache(), true, 'backbone is still held, so a snapshot is written');

    const back = host(store.readModuleCache(NOW + MIN));
    assert.deepStrictEqual(back.nap.data, [{ A: 'LUZON' }], 'nap keeps the copy it had');
    assert.strictEqual(back.nap.at, NOW,
      'and keeps its own age — carrying it over must not re-stamp it as fresh');
    assert.deepStrictEqual(back.backbone.data, [{ P: 'IFUGAO' }], 'the module that did answer is replaced');
    assert.strictEqual(back.backbone.at, NOW + MIN);
  });

  await test('the carry-over still ages: an entry is not kept past its own cap', () => {
    const { store, sandbox, state } = makeSandbox();
    state.lastFetch = { backbone: NOW };
    sandbox.dataCache.backbone = [{ P: 'BENGUET' }];
    store.persistModuleCache();

    /* Nothing held, and the only stored entry is 20 minutes old against backbone's 10 minute
       cap. The carry-over reads through the same age rule, so it carries nothing. */
    sandbox.dataCache.backbone = null;
    state.now = NOW + 20 * MIN;
    assert.strictEqual(store.persistModuleCache(), false, 'nothing worth carrying, so nothing is written');
    assert.deepStrictEqual(host(store.readModuleCache(NOW + 20 * MIN)), {},
      'and a carried-over entry cannot make a payload immortal');
  });

  await test('with nothing held and nothing stored, storage is left alone', () => {
    const { store, sandbox } = makeSandbox();
    assert.strictEqual(store.persistModuleCache(), false);
    assert.strictEqual(sandbox.localStorage.map[store.KEY], undefined);
  });

  await test('a type with no fetch stamp is left out of the snapshot rather than stamped now', () => {
    const { store, sandbox } = makeSandbox();
    sandbox.dataCache.nap = [{ A: 'LUZON' }];
    sandbox.dataCache.node = [{ P: 'IFUGAO' }];
    sandbox.fetchGate.lastFetch = (type) => (type === 'nap' ? NOW : 0);

    store.persistModuleCache();
    const back = host(store.readModuleCache(NOW));

    assert.ok(back.nap, 'the one with a known fetch time is kept');
    assert.strictEqual(back.node, undefined, 'the one without is not claimed to be fresh');
  });

  await test('the age GROWS across sessions instead of resetting on every launch', () => {
    const { store, sandbox, state } = makeSandbox();
    state.lastFetch = { nap: NOW };
    sandbox.dataCache.nap = [{ A: 'LUZON' }];
    store.persistModuleCache();

    /* Reload 20 minutes later: restore, write again, reload again — and the stamp is still the
       original fetch, so a payload that is never refreshed eventually expires rather than being
       treated as new on every launch. */
    state.now = NOW + 20 * MIN;
    assert.deepStrictEqual(host(store.restoreModuleCache()), ['nap']);
    store.persistModuleCache();
    assert.strictEqual(store.readModuleCache(NOW + 20 * MIN).nap.at, NOW, 'the age is not reset');

    state.now = NOW + 61 * MIN;
    assert.deepStrictEqual(host(store.readModuleCache(state.now)), {}, 'and it ages out for good');
  });

  await test('storage failures are silent, and never reach the caller', () => {
    const hostile = makeSandbox({ storage: hostileStorage() });
    assert.deepStrictEqual(host(hostile.store.readModuleCache(NOW)), {}, 'a store that throws reads as empty');
    assert.strictEqual(hostile.store.writeModuleCache({ nap: entry([1]) }), false, 'and writes fail open');
    assert.doesNotThrow(() => hostile.store.clearModuleCache());
    assert.deepStrictEqual(host(hostile.store.restoreModuleCache()), []);

    const noStore = makeSandbox({ storage: null });
    assert.deepStrictEqual(host(noStore.store.readModuleCache(NOW)), {});
    assert.strictEqual(noStore.store.writeModuleCache({ nap: entry([1]) }), false);
    assert.doesNotThrow(() => noStore.store.clearModuleCache());
  });

  await test('a quota error on write leaves the previous snapshot alone', () => {
    const storage = fakeStorage();
    const { store } = makeSandbox({ storage });
    store.writeModuleCache({ nap: entry([{ A: 'first' }]) });
    const before = storage.map[store.KEY];

    storage.setItem = () => { throw new Error('QuotaExceededError'); };
    assert.strictEqual(store.writeModuleCache({ nap: entry([{ A: 'second' }]) }), false);
    assert.strictEqual(storage.map[store.KEY], before, 'the store is not left half-written');
    assert.deepStrictEqual(host(store.readModuleCache(NOW).nap.data), [{ A: 'first' }]);
  });

  await test('clear() removes the key — the logout path', () => {
    const { store, sandbox } = makeSandbox();
    store.writeModuleCache({ nap: entry([1]) });
    assert.ok(sandbox.localStorage.map[store.KEY], 'there is something to clear');

    store.clearModuleCache();

    assert.strictEqual(sandbox.localStorage.map[store.KEY], undefined);
    assert.deepStrictEqual(host(store.readModuleCache(NOW)), {});
  });

  await test('start() writes on a timer and again when the page goes away', () => {
    const { store, sandbox, state } = makeSandbox();
    state.lastFetch = { nap: NOW };
    sandbox.dataCache.nap = [{ A: 'LUZON' }];

    store.start();
    assert.ok(state.interval, 'a snapshot interval is running');
    assert.strictEqual(state.interval.ms, 30 * 1000, 'once every 30 s');
    assert.strictEqual(typeof state.listeners.pagehide, 'function', 'pagehide is the one a phone fires');
    assert.strictEqual(typeof state.listeners.visibilitychange, 'function', 'backgrounded, then killed');

    assert.strictEqual(sandbox.localStorage.map[store.KEY], undefined, 'nothing is written just by starting');
    state.interval.fn();
    assert.ok(sandbox.localStorage.map[store.KEY], 'the timer snapshots what the page holds');
  });

  await test('with no page globals at all it is inert, not fatal', () => {
    /* The state a test harness or an older shell can be in: cache-store.js loaded, the page
       script that defines dataCache not. It must answer "nothing restored" and change nothing. */
    const { store, sandbox } = makeSandbox({ withPageGlobals: false });
    assert.deepStrictEqual(host(store.restoreModuleCache()), []);
    assert.strictEqual(store.persistModuleCache(), false);
    assert.strictEqual(sandbox.localStorage.map[store.KEY], undefined);
  });

  console.log('\n' + passed + ' passed, ' + (total - passed) + ' failed\n');
})();
