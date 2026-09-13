/* ------------------------------------------------------------------
   Last known good — the honesty layer.

   When the API cannot be reached a module used to leave a hole ("Error loading
   data."), and NODE and BACKBONE went further and rendered their ALL-CLEAR cards —
   "All Node Systems Operational" while nothing had been fetched at all. On a 24/7
   wall display that is the worst available lie, so this suite exists to keep it gone.

   Two halves, both needed:

     1. last-good.js is RUN, for real, in a node vm with a minimal window/document/
        localStorage. No browser, no network, and a clock we control, so the
        write-only-when-changed rule and the stale timestamp can be asserted exactly.
     2. the five module files are READ, because each of them is one edit away from
        dropping the contract again — and the calmer the edit looks, the more likely
        it is (`catch { renderNodeEmptyState() }` is a one-liner that lies).

   Run with:  node --test tests/last-good.test.js
 * ------------------------------------------------------------------ */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const LAYER = fs.readFileSync(path.join(ROOT, 'last-good.js'), 'utf8');

const MODULES = ['nap', 'lcp', 'olt', 'node', 'backbone'];
const moduleSource = (type) => fs.readFileSync(path.join(ROOT, type + '-module.js'), 'utf8');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

/* ==================================================================== *
   A browser, small enough to read
 * ==================================================================== */

function fakeStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  const writes = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      map.set(k, String(v));
      writes.set(k, (writes.get(k) || 0) + 1);
    },
    removeItem: (k) => { map.delete(k); },
    keys: () => Array.from(map.keys()),
    writes: (k) => writes.get(k) || 0
  };
}

/* One banner node: the class toggles last-good.js uses, and the text node it fills. */
function fakeBanner() {
  const classes = new Set();
  const text = { textContent: '' };
  return {
    classes,
    text,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : !!on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
      contains: (c) => classes.has(c)
    },
    querySelector: (sel) => (sel === '.stale-banner-text' ? text : null)
  };
}

/* A clock we advance by hand: Date.now() is read on every note, and the banner's
   "stale since HH:MM" comes from the stored timestamp, so both have to be exact. */
function fakeClock(startMs) {
  let now = startMs;
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  FakeDate.advance = (ms) => { now += ms; };
  FakeDate.set = (ms) => { now = ms; };
  return FakeDate;
}

let warnCount = 0;

/* Objects parsed inside the vm carry the vm's prototypes, so a strict deepEqual
   against a host literal fails on reference identity alone. Compare the JSON. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function load(options) {
  const opts = options || {};
  const storage = fakeStorage(opts.stored);
  const banners = opts.bannerCount === 0 ? [] : [fakeBanner(), fakeBanner()];
  const warnings = [];
  const clock = opts.clock || fakeClock(1700000000000);
  warnCount = 0;

  const win = { localStorage: storage };
  const document = {
    querySelectorAll: (sel) => (sel === '.stale-banner' ? banners : [])
  };

  const sandbox = {
    window: win,
    localStorage: storage,
    document,
    Date: clock,
    console: {
      warn: (msg) => { warnCount++; warnings.push(String(msg)); },
      error: () => {},
      log: () => {}
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(LAYER, sandbox, { filename: 'last-good.js' });

  return { win, storage, banners, warnings, clock };
}

/* ==================================================================== *
   1. Nothing is invented
 * ==================================================================== */

test('a failure with nothing remembered reports that it knows nothing', () => {
  const { win } = load();
  const result = win.degradeModuleToLastGood('nap', undefined);

  assert.equal(result.payload, null, 'no payload may be invented');
  assert.equal(result.at, null);
  assert.equal(result.from, 'none');
  assert.equal(win.lastGoodStale('nap'), true, 'and the module must still be marked stale');
});

test('the honest row says so and prints no number at all', () => {
  const { win } = load();
  const html = win.unavailableRowHtml(6);

  assert.match(html, /Live data unavailable/);
  assert.match(html, /not an all-clear/);
  assert.match(html, /colspan="6"/);
  assert.doesNotMatch(html, /\b0\b/, 'a printed 0 reads as "no outages"');
});

test('an empty on-screen list is not data: it falls through to storage', () => {
  const { win } = load({
    stored: {
      netpulse_lastgood_nap: JSON.stringify({ v: 1, payload: [{ A: 'Benguet' }] }),
      netpulse_lastgood_nap_at: '1700000000000'
    }
  });

  const result = win.degradeModuleToLastGood('nap', []);

  assert.equal(result.from, 'stored');
  assert.deepEqual(plain(result.payload), [{ A: 'Benguet' }]);
  assert.equal(result.at, 1700000000000);
});

/* ==================================================================== *
   2. What is remembered, and for how long
 * ==================================================================== */

test('a successful fetch is handed back untouched on the next failure', () => {
  const { win } = load();
  const payload = [{ A: 'Cluster 2', P: 'Benguet', H: 5, T: 12 }];

  win.noteModuleFresh('lcp', { lcpAging: payload, lcpImpact: [] });
  const result = win.degradeModuleToLastGood('lcp', null);

  assert.equal(result.from, 'stored');
  assert.deepEqual(plain(result.payload), { lcpAging: plain(payload), lcpImpact: [] });
  assert.equal(result.at, 1700000000000, 'the time the API last ANSWERED, not when the numbers changed');
});

test('the payload is written only when it changes, but the timestamp keeps moving', () => {
  const { win, storage, clock } = load();
  const payload = [{ A: 'Cluster 1' }];
  const DATA = 'netpulse_lastgood_nap';
  const AT = 'netpulse_lastgood_nap_at';

  win.noteModuleFresh('nap', payload);
  assert.equal(storage.writes(DATA), 1);

  // Same payload, next poll. Rewriting ~50 KB every minute on a display that never
  // sleeps is ~26 GB/year of writes, which is why the two keys are split.
  clock.advance(60000);
  win.noteModuleFresh('nap', payload);
  assert.equal(storage.writes(DATA), 1, 'an unchanged payload must not be rewritten');
  assert.equal(storage.writes(AT), 2, 'the timestamp is still written every time');
  assert.equal(storage.getItem(AT), '1700000060000', 'and it is the time we just saw');

  clock.advance(60000);
  win.noteModuleFresh('nap', [{ A: 'Cluster 2' }]);
  assert.equal(storage.writes(DATA), 2, 'a changed payload is written again');
});

test('a payload too large to keep is refused, and the module says so', () => {
  const { win, storage, warnings } = load();

  win.noteModuleFresh('olt', 'x'.repeat(600 * 1024));

  assert.equal(storage.getItem('netpulse_lastgood_olt'), null, 'nothing half-written');
  assert.equal(storage.getItem('netpulse_lastgood_olt_at'), '1700000000000',
    'the timestamp still stands, so the banner can still be honest');
  assert.ok(warnings.some((w) => /too large/.test(w)), 'and it is not a silent drop');
  assert.equal(win.netpulseLastGood.report().olt.remembered, false);
});

test('a record this build does not understand is refused, not guessed at', () => {
  const { win } = load({
    stored: {
      netpulse_lastgood_nap: JSON.stringify({ v: 99, payload: [{ A: 'future shape' }] })
    }
  });

  const result = win.degradeModuleToLastGood('nap', null);

  assert.equal(result.payload, null);
  assert.equal(result.from, 'none');
});

test('a corrupted record is refused, not thrown', () => {
  const { win } = load({ stored: { netpulse_lastgood_nap: '{not json' } });

  assert.doesNotThrow(() => win.degradeModuleToLastGood('nap', null));
  assert.equal(win.degradeModuleToLastGood('nap', null).payload, null);
});

test('a store that throws on write never breaks the fetch that called it', () => {
  const { win } = load();
  win.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };

  assert.doesNotThrow(() => win.noteModuleFresh('nap', [{ A: 'X' }]));
  assert.equal(win.noteModuleFresh('nap', [{ A: 'X' }]), undefined);
});

/* ==================================================================== *
   3. The banner
 * ==================================================================== */

test('every banner in the document is driven, in both shells', () => {
  const { win, banners } = load();
  assert.equal(banners.length, 2, 'the dashboard header and the kiosk topbar');
  assert.ok(banners.every((b) => !b.classList.contains('is-visible')), 'hidden while live');

  // Live first, then the poll that failed — the real order.
  win.noteModuleFresh('nap', [{ A: 'X' }]);
  win.degradeModuleToLastGood('nap', [{ A: 'X' }]);

  for (const banner of banners) {
    assert.ok(banner.classList.contains('is-visible'));
    assert.equal(banner.text.textContent, banners[0].text.textContent,
      'two shells must never disagree about how stale the screen is');
  }
  assert.match(banners[0].text.textContent, /^STALE — live data unavailable · showing last known: NAP /);
  assert.match(banners[0].text.textContent, /\d{1,2}:\d{2} (AM|PM)/, 'a real clock time, not a duration');
});

test('a module that never loaded says so instead of showing a time', () => {
  const { win } = load();
  win.degradeModuleToLastGood('olt', null);

  assert.match(win.netpulseLastGood.line(), /OLT \(not loaded\)/);
  assert.equal(win.lastGoodClock(null), null);
});

test('the banner hides again the moment live data returns', () => {
  const { win, banners } = load();
  win.degradeModuleToLastGood('nap', [{ A: 'X' }]);
  assert.ok(banners[0].classList.contains('is-visible'));

  win.noteModuleFresh('nap', [{ A: 'X' }]);

  assert.ok(banners.every((b) => !b.classList.contains('is-visible')));
  assert.deepEqual([...win.netpulseLastGood.staleTypes()], []);
});

test('the line names at most three modules and counts the rest', () => {
  const { win } = load();
  MODULES.forEach((type) => win.noteModuleFresh(type, [{ A: 'X' }]));
  MODULES.forEach((type) => win.degradeModuleToLastGood(type, [{ A: 'X' }]));

  const line = win.netpulseLastGood.line();

  assert.match(line, /\+2 more/);
  assert.equal(line.match(/\(not loaded\)/g), null, 'these all have a timestamp');
  assert.equal(line.replace(/^.*showing last known: /, '').split(' · ').length, 4,
    'three names plus the count of the rest');
});

test('on-screen data of unknown age is not called "not loaded"', () => {
  const { win } = load();
  // No noteModuleFresh(): data exists on screen but this session never saw it
  // arrive, which is the one case with no usable timestamp.
  win.degradeModuleToLastGood('nap', [{ A: 'X' }]);

  const line = win.netpulseLastGood.line();

  assert.match(line, /NAP \(age unknown\)/);
  assert.doesNotMatch(line, /NAP \(not loaded\)/);
});

test('a background revalidation that fails only moves the banner', () => {
  const { win } = load();
  win.noteModuleFresh('backbone', [{ P: 'Benguet' }]);

  const at = win.noteModuleFailed('backbone');

  assert.equal(at, 1700000000000);
  assert.equal(win.lastGoodStale('backbone'), true);
  assert.deepEqual(win.netpulseLastGood.report().backbone.showing, 'stale');
});

test('clearing the layer empties it and reports what it dropped', () => {
  const { win, storage } = load();
  MODULES.forEach((type) => win.noteModuleFresh(type, [{ A: 'X' }]));

  const report = win.netpulseLastGood.clearAll();

  assert.match(report, /removed 5/);
  assert.equal(storage.keys().filter((k) => k.startsWith('netpulse_lastgood_')).length, 0);
  assert.deepEqual(win.netpulseLastGood.report().nap.remembered, false);
});

/* ==================================================================== *
   4. The module wiring — each of these is a one-line edit away
 * ==================================================================== */

test('every module notes freshness AND degrades on failure', () => {
  for (const type of MODULES) {
    const src = moduleSource(type);
    assert.match(src, new RegExp(`noteModuleFresh\\('${type}'`), `${type} never records a good payload`);
    assert.match(src, new RegExp(`noteModuleFailed\\('${type}'\\)`), `${type} never reports a failed poll`);
    assert.match(src, new RegExp(`degradeModuleToLastGood\\('${type}'`), `${type} never falls back`);
    assert.match(src, new RegExp(`render${type[0].toUpperCase()}${type.slice(1)}Unavailable\\(\\)`),
      `${type} has no state for "nothing to show"`);
  }
});

/* The deceptive one: a failed fetch must never render the all-clear card. It may still
   render it for a REMEMBERED all-clear, which is why the guard has to be checked by
   position rather than by looking for the call. */
const CATCH_AND_EMPTY = {
  node: ['fetchNodeData', 'renderNodeEmptyState', 'renderNodeUnavailable'],
  backbone: ['fetchBackboneData', 'renderBackboneEmptyState', 'renderBackboneUnavailable']
};

test('NODE and BACKBONE never show all-clear on a failed fetch', () => {
  for (const type of ['node', 'backbone']) {
    const [fn, emptyCall, unavailableCall] = CATCH_AND_EMPTY[type];
    const src = moduleSource(type);
    const start = src.indexOf('async function ' + fn);
    assert.ok(start > -1, `${fn} not found`);

    const catchAt = src.indexOf('} catch (error) {', start);
    const catchBody = src.slice(catchAt, src.indexOf('\n}', catchAt));
    assert.ok(catchBody.includes(`degradeModuleToLastGood('${type}'`), `${type}: the failure path does not degrade`);
    assert.ok(catchBody.includes(unavailableCall), `${type}: no honest state on the failure path`);

    const emptyIdx = catchBody.indexOf(emptyCall);
    const guardIdx = catchBody.indexOf("stale.from === 'stored'");
    assert.ok(guardIdx > -1, `${type}: the all-clear is rendered without checking what was remembered`);
    assert.ok(emptyIdx > guardIdx,
      `${type}: the all-clear is reachable before the "was this remembered?" guard — that is the lie`);
  }
});

test('NODE and BACKBONE record a genuine empty answer as fresh', () => {
  for (const type of ['node', 'backbone']) {
    const src = moduleSource(type);
    assert.match(src, new RegExp(`noteModuleFresh\\('${type}', \\[\\]\\)`),
      `${type}: an API answer of "no incidents" is data, and must be remembered as such`);
  }
});

/* ==================================================================== *
   5. The kiosk
 * ==================================================================== */

test('a kiosk slide that has no data never sits on "Loading…" forever', () => {
  const src = read('kiosk-module.js');

  assert.doesNotMatch(src, /el\.innerHTML = kioskLoadingHtml\(/,
    'every missing-module branch must go through kioskMissingHtml()');
  assert.equal((src.match(/kioskMissingHtml\('/g) || []).length, 5, 'one per slide');
  assert.match(src, /lastGoodStale\('?/);
});

test('the kiosk mounts the same banner as the dashboard, restyled', () => {
  const html = read('index.html');

  assert.equal((html.match(/class="stale-banner(?![\w-])/g) || []).length, 2,
    'one in the dashboard header, one in the kiosk shell');
  assert.match(html, /class="stale-banner kiosk-stale-banner"/);
  assert.match(read('kiosk.css'), /\.kiosk-root \.kiosk-stale-banner/,
    'and it is styled inside the kiosk isolation contract');
});

/* ==================================================================== *
   6. The layer must actually load, in the right order
 * ==================================================================== */

test('last-good.js is loaded before every module that calls it', () => {
  const html = read('index.html');
  const order = ['cache-control.js', 'last-good.js'].concat(MODULES.map((t) => `${t}-module.js`), ['kiosk-module.js']);
  const positions = order.map((file) => html.indexOf(`<script src="${file}?`));

  positions.forEach((at, i) => assert.ok(at > -1, `${order[i]} is not loaded at all`));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1], `${order[i]} must come after ${order[i - 1]}`);
  }
});

test('the service worker precaches it, under the version token the page asks for', () => {
  const sw = read('sw.js');
  const version = sw.match(/const ASSET_VERSION = '([^']+)'/)[1];

  assert.match(sw, /'\.\/last-good\.js'/, 'not precached: the offline shell would miss a file the modules call');

  const tokens = new Set((read('index.html').match(/\?v=([A-Za-z0-9.]+)/g) || []).map((t) => t.slice(3)));
  assert.deepEqual([...tokens], [version],
    'a mismatch keys the precache under a URL the page never requests (and an old shell would pair with new modules)');
});

/* ==================================================================== *
   7. One documented way to inspect and clear it
 * ==================================================================== */

test('cache-control.js reports the layer and can clear it', () => {
  const src = read('cache-control.js');

  assert.match(src, /'6\. Last known good'/);
  assert.match(src, /lastGood: lastGood/);
  assert.match(src, /clearLastGood: clearLastGood/);
  assert.match(src, /report\['6\. Last known good'\] = clearLastGood\(\)/,
    'invalidateAll() must include it, or a release leaves a stale fallback behind');
});

test('clearing from cache-control.js reaches the real layer', () => {
  const { win } = load();
  win.noteModuleFresh('lcp', { lcpAging: [] });

  // What cache-control.js does, without booting the whole app: it calls through to
  // window.netpulseLastGood, which is the only surface it uses.
  assert.equal(typeof win.netpulseLastGood.clearAll, 'function');
  assert.match(win.netpulseLastGood.clearAll(), /removed 1/);
});
