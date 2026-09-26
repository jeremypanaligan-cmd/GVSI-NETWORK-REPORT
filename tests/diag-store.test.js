// ==================== DIAGNOSTICS STORE TESTS ====================
//
// Run: node tests/diag-store.test.js
//
// Zero dependencies. Loads the REAL diag-store.js into a vm sandbox and checks the four
// things the Module Health card depends on:
//
//   1. IT CANNOT GROW. 20 samples per label, 24 labels, and a counter of what was dropped
//      that the card shows. An unbounded diagnostic on a phone is a memory leak with a
//      reassuring name.
//   2. IT CANNOT FAIL THE THING IT WATCHES. record() is total: any url, any sample, any
//      hostile getter, and it returns rather than raising — because its caller sits on the
//      request path of every module in the app.
//   3. IT CANNOT CARRY A SECRET. The label is the type or the action, sanitized. The login
//      call the app actually builds carries the password in its query string, so one test
//      records exactly that URL and then searches the entire snapshot for it.
//   4. IT TELLS "ABSENT" FROM "ZERO". With the proxy off, no response carries the edge's
//      timing headers. A missing origin time must read as missing, not as 0 ms — that is
//      one `|| 0` away and it would be the silliest lie in this app's history.
//
// The last group reads index.html, admin-module.js and sw.js as TEXT. The wiring is where
// this feature can silently do nothing: a store nothing records into, a card nothing
// renders, a file the service worker never precaches.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const READ = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const SRC = READ('diag-store.js');
const INDEX = READ('index.html');
const ADMIN = READ('admin-module.js');
const SW = READ('sw.js');

/** A browser-shaped sandbox: in a browser `window` IS the global object. */
function freshSandbox() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = { log() {}, warn() {}, error() {} };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'diag-store.js' });
  sandbox.__store = sandbox.window.diagStore;
  return sandbox;
}

/**
 * The real admin-module.js in a sandbox with a stand-in document, so the card is actually
 * DRAWN rather than merely grepped for. Reading a template is how a card ships with an
 * undefined field in a column — which renders as a dash and looks like "no data" — so this
 * drives renderModuleHealth() and reads what it put in the DOM.
 */
function cardHarness(opts) {
  opts = opts || {};
  const elements = {};
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      getElementById: (id) => {
        if (!elements[id]) elements[id] = { innerHTML: '', style: {} };
        return elements[id];
      }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  /* Not loaded at all, rather than deleted afterwards: that is the real case — a phone
     running the previous shell when index.html arrives before diag-store.js is cached. */
  if (!opts.withoutStore) vm.runInContext(SRC, sandbox, { filename: 'diag-store.js' });
  vm.runInContext(ADMIN, sandbox, { filename: 'admin-module.js' });

  return {
    store: sandbox.window.diagStore,
    draw: () => sandbox.renderModuleHealth(),
    html: () => (elements.moduleHealthBody ? elements.moduleHealthBody.innerHTML : '')
  };
}

/** A store holding the calls we name, so the summary maths can be checked on numbers we chose. */
function storeWith(entries) {
  const s = freshSandbox();
  entries.forEach((e, i) => s.__store.record(e.url || 'https://x/exec?type=lcp',
    { ms: e.ms, attempts: e.attempts, originMs: e.originMs, ok: e.ok, error: e.error,
      at: 1700000000000 + i }));
  return s.__store;
}

function summaryOf(store) {
  return store.summary();
}

function rowFor(store, label) {
  return store.summary().filter((r) => r.label === label)[0];
}

/* ------------------------------------------------------------------ *
   Harness
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  PASS  ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL  ' + name);
    console.log('        ' + err.message);
  }
}

(() => {
  console.log('\nModule diagnostics, client half — the store, the bounds and the wiring\n');

  /* ---------------------------------------------------------------- *
     1. The label is the question's name
   * ---------------------------------------------------------------- */

  test('a type request is labelled by its type, and the type wins over the action', () => {
    const store = freshSandbox().__store;

    assert.strictEqual(store.labelFor('https://script.google.com/macros/s/X/exec?type=lcp'), 'lcp');
    assert.strictEqual(store.labelFor('https://script.google.com/macros/s/X/exec?type=olt&shape=3'), 'olt',
      'extra parameters must not change the label');
    assert.strictEqual(store.labelFor('?type=nap&action=diag'), 'nap',
      'a data request is about the module, not the route');
  });

  test('an action request is labelled by its action, namespaced away from the modules', () => {
    const store = freshSandbox().__store;

    assert.strictEqual(store.labelFor('https://x/exec?action=login'), 'action:login');
    assert.strictEqual(store.labelFor('https://x/exec?action=setMaintenance&enabled=true'), 'action:setMaintenance');
    assert.strictEqual(store.labelFor('https://x/exec?action=rev'), 'action:rev');
  });

  test('an action name survives with its CASE, rather than being folded and then stripped', () => {
    /* The whitelist strips anything outside [A-Za-z0-9:_-]. Folding case first would have made
       that whitelist eat every capital letter, silently renaming action:setMaintenance. A
       mangled label is worse than two spellings of one: only the mangled one is invisible. */
    const store = freshSandbox().__store;

    assert.strictEqual(store.labelFor('?action=getSettings'), 'action:getSettings');
    assert.strictEqual(store.labelFor('?action=setMaintenance'), 'action:setMaintenance');
  });

  test('anything it cannot name collapses into one bucket instead of growing a label each', () => {
    const store = freshSandbox().__store;

    assert.strictEqual(store.labelFor('https://x/exec'), 'other');
    assert.strictEqual(store.labelFor(''), 'other');
    assert.strictEqual(store.labelFor(null), 'other', 'a missing url must not throw');
    assert.strictEqual(store.labelFor('https://x/exec?action=diag&token=abc'), 'action:diag',
      'the token must not become part of a label');
  });

  test('a label is sanitized and clipped, because it reaches innerHTML', () => {
    const store = freshSandbox().__store;

    const evil = store.labelFor('?type=<img src=x onerror=alert(1)>');
    assert.ok(evil.indexOf('<') === -1 && evil.indexOf('>') === -1,
      'angle brackets must not survive into a label: ' + evil);
    assert.ok(evil.indexOf('=') === -1 && evil.indexOf('(') === -1,
      'and neither must the syntax of a handler: ' + evil);
    assert.ok(evil.length <= 24, 'and a label is bounded: ' + evil.length);

    const long = store.labelFor('?action=' + 'a'.repeat(500));
    assert.ok(long.length <= 24 + 'action:'.length, 'a long action is clipped: ' + long.length);
  });

  /* ---------------------------------------------------------------- *
     2. Nothing secret, ever
   * ---------------------------------------------------------------- */

  test('the login URL the app really builds does not put its password in the snapshot', () => {
    /* index.html sends the password as a query parameter — that is the login path as it
       stands. It must not reach a diagnostic that a human is invited to paste into a chat. */
    const s = freshSandbox();
    s.__store.record('https://x/exec?action=login&password=Hunter2Secret&user=jeremy',
      { ms: 120, attempts: 1, ok: true });

    const text = JSON.stringify(s.__store.snapshot());
    assert.ok(text.indexOf('Hunter2Secret') === -1, 'the password is in the snapshot');
    assert.ok(text.indexOf('Hunter2Secret') === -1 && text.indexOf('jeremy') === -1,
      'and so is the username: a sample carries no query value at all');
    assert.deepStrictEqual(Object.keys(s.__store.snapshot().samples), ['action:login']);
  });

  test('a token attached to a data call does not appear in a label either', () => {
    const s = freshSandbox();
    s.__store.record('https://x/exec?type=nap&token=tok-9f3a-secret', { ms: 900, ok: true });

    assert.deepStrictEqual(Object.keys(s.__store.snapshot().samples), ['nap']);
    assert.ok(JSON.stringify(s.__store.snapshot()).indexOf('tok-9f3a-secret') === -1,
      'the token reached the store');
  });

  test('the store does not pretend to scrub error text — the call site is what redacts', () => {
    /* A store cannot know what is secret inside an arbitrary message, and a half-scrubber is
       worse than none because it reads as a guarantee. So the rule is: the recorded error is
       the error's own message, and the URL that IS logged goes through safeApiUrlForLog.
       Both halves asserted here, because either one alone would leave the hole open. */
    assert.ok(/function safeApiUrlForLog\(url\)/.test(INDEX), 'the URL redactor is gone');
    assert.ok(/error: lastErr \? lastErr\.message : 'unknown'/.test(INDEX),
      'the recorded error must be the message, not the request it came from');
    assert.ok(/const logUrl = safeApiUrlForLog\(url\);/.test(INDEX),
      'and the URL that is logged must go through the redactor');
    assert.ok(/\[redacted\]/.test(INDEX), 'the redactor no longer redacts');
  });

  test('an error string that DOES carry a URL is kept as it was given, not half-scrubbed', () => {
    /* The honest failure mode, pinned so nobody adds a scrubber that looks like a guarantee:
       what lands in the field is exactly what the caller passed. */
    const s = freshSandbox();
    s.__store.record('?type=nap', { ms: 900, ok: false, error: 'HTTP 500 for https://x/exec?token=abc' });

    assert.strictEqual(summaryOf(s.__store)[0].lastError, 'HTTP 500 for https://x/exec?token=abc',
      'the store silently rewrote an error message, which is worse than passing it through');
  });

  /* ---------------------------------------------------------------- *
     3. record() is total
   * ---------------------------------------------------------------- */

  test('record() survives a missing url, a missing sample, and a non-object sample', () => {
    const store = freshSandbox().__store;

    assert.strictEqual(store.record(undefined, undefined), true, 'nothing about that is an error');
    assert.strictEqual(store.record(null, null), true);
    assert.strictEqual(store.record('https://x/exec?type=lcp', 'not an object'), true);
    assert.strictEqual(store.record('https://x/exec?type=lcp', 42), true);

    assert.strictEqual(store.summary().length, 2, 'and they landed in the two honest buckets');
  });

  test('record() survives a sample whose properties throw, and leaves the store consistent', () => {
    /* A getter that raises is the cheapest way to reach this: the caller would be an object
       this file did not write. The store normalizes BEFORE it mutates, so a throw cannot
       leave a half-written sample behind. */
    const store = freshSandbox().__store;
    store.record('https://x/exec?type=lcp', { ms: 100, ok: true });

    const hostile = { ok: true, get ms() { throw new Error('nope'); } };
    let raised = false;
    let result;
    try {
      result = store.record('https://x/exec?type=nap', hostile);
    } catch (e) {
      raised = true;
    }

    assert.strictEqual(raised, false, 'record() must never throw into the request path');
    assert.strictEqual(result, false, 'it reports the failure instead');

    const nap = rowFor(store, 'nap');
    assert.ok(nap === undefined || nap.calls === 0,
      'and the hostile sample was not half-recorded: ' + JSON.stringify(nap));
    const lcp = rowFor(store, 'lcp');
    assert.strictEqual(lcp.calls, 1, 'while the store it already held is intact');
  });

  test('a very long error message is truncated rather than kept whole', () => {
    const s = freshSandbox();
    s.__store.record('https://x/exec?type=lcp', { ms: 10, ok: false, error: 'x'.repeat(10000) });

    const stored = s.__store.snapshot().samples.lcp[0];
    assert.ok(stored.error.length <= 121, 'an error field is bounded: ' + stored.error.length);
    assert.ok(stored.error.slice(-1) === '…', 'and it says it was cut: ' + stored.error.slice(-3));
  });

  /* ---------------------------------------------------------------- *
     4. The bounds, and the counter that admits them
   * ---------------------------------------------------------------- */

  test('the ring keeps the NEWEST 20 and counts the rest as dropped', () => {
    const s = freshSandbox();
    for (let i = 0; i < 25; i++) {
      s.__store.record('https://x/exec?type=lcp', { ms: 100 + i, at: 1700000000000 + i });
    }

    const row = rowFor(s.__store, 'lcp');
    assert.strictEqual(row.calls, 20, 'the ring is 20');
    assert.strictEqual(s.__store.totals().dropped, 5, 'and it says five were dropped, not silently');

    const kept = s.__store.snapshot().samples.lcp;
    assert.strictEqual(kept[0].ms, 105, 'the OLDEST were dropped, so the ring holds the last 20');
    assert.strictEqual(kept[kept.length - 1].ms, 124);
  });

  test('the label cap holds, and it evicts oldest-first with a count', () => {
    const s = freshSandbox();
    for (let i = 0; i < 30; i++) {
      s.__store.record('https://x/exec?action=a' + i, { ms: 10, at: 1700000000000 + i });
    }

    const labels = Object.keys(s.__store.snapshot().samples);
    assert.strictEqual(labels.length, 24, '24 labels, whatever the world throws at it');
    assert.strictEqual(labels[0], 'action:a6', 'the first six went, oldest first');
    assert.strictEqual(labels[23], 'action:a29');
    assert.strictEqual(s.__store.totals().evictedLabels, 6);
    assert.strictEqual(s.__store.totals().dropped, 6,
      'evicted samples are counted as dropped too — nothing leaves without a number');
  });

  test('clear() empties the store including its counters', () => {
    const s = freshSandbox();
    for (let i = 0; i < 25; i++) s.__store.record('?type=lcp', { ms: 5 });
    assert.ok(s.__store.totals().dropped > 0);

    s.__store.clear();

    /* Length rather than deepStrictEqual: the store's arrays are built inside the vm, so
       they are not the host realm's arrays and a deep comparison would fail on prototype
       identity rather than on contents. */
    assert.strictEqual(summaryOf(s.__store).length, 0);
    assert.strictEqual(Object.keys(s.__store.snapshot().samples).length, 0);
    assert.strictEqual(s.__store.totals().dropped, 0, 'a reset is a reset');
    assert.strictEqual(s.__store.totals().startedAt, null);
  });

  /* ---------------------------------------------------------------- *
     5. The maths the card prints
   * ---------------------------------------------------------------- */

  test('p50 is the server\'s median and p95 is nearest rank, both exact on a known set', () => {
    /* p50 uses the same rule as diagnostics.gs `diagMedian_` — the mean of the two middle
       values on an even count — so a report read side by side does not show two different
       numbers for the same calls. p95 is nearest rank. */
    const store = storeWith([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms) => ({ ms })));
    const row = rowFor(store, 'lcp');

    assert.strictEqual(row.calls, 10);
    assert.strictEqual(row.waitMs, 550, '(500 + 600) / 2 — the even-count median, as the server defines it');
    assert.strictEqual(row.waitP95Ms, 1000, 'p95 by nearest rank is the 10th of ten');
    assert.strictEqual(row.waitMaxMs, 1000);
  });

  test('an odd count needs no averaging, and a single call is that call', () => {
    const odd = rowFor(storeWith([{ ms: 100 }, { ms: 300 }, { ms: 900 }]), 'lcp');
    assert.strictEqual(odd.waitMs, 300, 'the middle value');
    assert.strictEqual(odd.waitP95Ms, 900);
  });

  test('one call reports that call, not zero — the off-by-one that would hide a slow open', () => {
    const store = storeWith([{ ms: 4200 }]);

    assert.strictEqual(rowFor(store, 'lcp').waitP95Ms, 4200);
    assert.strictEqual(rowFor(store, 'lcp').waitMs, 4200);
    assert.strictEqual(rowFor(store, 'lcp').waitMaxMs, 4200);
  });

  test('a summary of an empty store is an empty list, not a crash', () => {
    assert.strictEqual(summaryOf(freshSandbox().__store).length, 0);
    assert.strictEqual(freshSandbox().__store.totals().startedAt, null);
  });

  test('a sample with no ms at all is skipped by the maths rather than counted as zero', () => {
    /* A call that was recorded without a wait is not a fast call. Counting it as 0 would
       drag every median down toward a number nobody measured. */
    const store = storeWith([{ ms: 6000 }, { ms: undefined }, { ms: -5 }]);
    const row = rowFor(store, 'lcp');

    assert.strictEqual(row.calls, 3, 'the calls are counted; that part is a fact');
    assert.strictEqual(row.waitMs, 6000, 'but the maths only saw the measured one');
    assert.strictEqual(row.waitMaxMs, 6000);
  });

  /* ---------------------------------------------------------------- *
     6. Absent is not zero
   * ---------------------------------------------------------------- */

  test('with no edge headers the origin time is NULL, and the count says why', () => {
    /* This is the live case: the proxy is off, so no response carries the headers. */
    const store = storeWith([{ ms: 3000 }, { ms: 4000 }]);
    const row = rowFor(store, 'lcp');

    assert.strictEqual(row.originMs, null, 'the origin did not say, so the answer is null');
    assert.strictEqual(row.overheadMs, null, 'and neither can an overhead be invented from it');
    assert.strictEqual(row.edgeSamples, 0, 'zero calls carried edge timing — that is the fact');
    assert.strictEqual(row.waitMs, 3500, 'but the wait this device measured is still reported');
  });

  test('an edge that reports 0ms is a fact, not a missing value, and it is distinguishable', () => {
    const store = storeWith([{ ms: 120, originMs: 0 }]);
    const row = rowFor(store, 'lcp');

    assert.strictEqual(row.originMs, 0);
    assert.strictEqual(row.edgeSamples, 1, 'the count is what tells the two cases apart');
    assert.strictEqual(row.overheadMs, 120);
  });

  test('overhead is the median of per-call (wait - origin), not the difference of two medians', () => {
    /* Three calls the edge timed, one it did not. The unpaired call must not influence the
       decomposition, and a call whose origin time exceeds its wait contributes nothing. */
    const store = storeWith([
      { ms: 6000, originMs: 1200 },   // 4800
      { ms: 3000, originMs: 1000 },   // 2000
      { ms: 2000, originMs: 1000 },   // 1000
      { ms: 9000 }                    // no edge timing: excluded
    ]);
    const row = rowFor(store, 'lcp');

    assert.strictEqual(row.calls, 4);
    assert.strictEqual(row.edgeSamples, 3);
    assert.strictEqual(row.originMs, 1000, 'p50 of the three origin times');
    assert.strictEqual(row.overheadMs, 2000, 'p50 of 1000, 2000, 4800 — the paired set only');
    assert.strictEqual(row.waitMs, 4500, 'while the wait is the median of all four');
  });

  test('retries count calls that took more than one attempt, and failures name the last error', () => {
    const store = storeWith([
      { ms: 500, attempts: 1, ok: true },
      { ms: 7000, attempts: 3, ok: true },
      { ms: 8000, attempts: 3, ok: false, error: 'HTTP 502' }
    ]);
    const row = rowFor(store, 'lcp');

    assert.strictEqual(row.retried, 2, 'two calls took more than one attempt');
    assert.strictEqual(row.failed, 1);
    assert.strictEqual(row.lastError, 'HTTP 502');
  });

  test('a failure followed by a success still reports the failure', () => {
    /* The card is read after the fact; the most recent sample being fine does not erase the
       one that was not. */
    const s = freshSandbox();
    s.__store.record('?type=nap', { ms: 8000, attempts: 3, ok: false, at: 1, error: 'Failed after 3 attempts' });
    s.__store.record('?type=nap', { ms: 400, attempts: 1, ok: true, at: 2 });

    const row = rowFor(s.__store, 'nap');
    assert.strictEqual(row.failed, 1);
    assert.ok(row.lastError.indexOf('Failed after 3 attempts') !== -1, 'got: ' + row.lastError);
  });

  test('the snapshot is a copy: writing to it cannot reach back into the store', () => {
    const s = freshSandbox();
    s.__store.record('?type=lcp', { ms: 100 });

    const snap = s.__store.snapshot();
    snap.samples.lcp.push({ ms: 99999 });
    snap.samples.nap = [{ ms: 1 }];

    assert.strictEqual(s.__store.summary().length, 1, 'the store gained nothing');
    assert.strictEqual(rowFor(s.__store, 'lcp').calls, 1);
  });

  /* ---------------------------------------------------------------- *
     6b. The card, actually drawn
   * ---------------------------------------------------------------- */

  test('the card draws a row per label, with the calls, the waits and the age', () => {
    const h = cardHarness();
    h.store.record('?type=lcp', { ms: 6000, attempts: 1, ok: true });
    h.store.record('?type=lcp', { ms: 2000, attempts: 1, ok: true });
    h.store.record('?action=rev', { ms: 300, attempts: 1, ok: true });

    h.draw();
    const html = h.html();

    assert.ok(html.indexOf('Module Health') === -1, 'the heading lives in the tab, not in this body');
    assert.ok(html.indexOf('lcp') !== -1, 'the module that was slow must be named: ' + html.slice(0, 200));
    assert.ok(html.indexOf('action:rev') !== -1, 'and the other label too');
    assert.ok(html.indexOf('4.0s') !== -1, 'the median wait must be drawn, in seconds once it is past one');
    assert.ok(html.indexOf('300ms') !== -1, 'and small waits in milliseconds');
    assert.ok((html.match(/<tr>/g) || []).length === 3, 'two rows plus a header');
    assert.ok(html.indexOf('· 2<') !== -1,
      'the call count must be drawn beside the label — a p95 from one call is not the same claim: ' + html.slice(0, 300));
  });

  test('the table is eight columns wide, and nothing was dropped to get there', () => {
    /* Ten columns pushed Retried, Failed and the age behind a horizontal scroll on the very
       screen this card is read from, and a screenshot is what found it. `Calls` folded into
       the module cell and `Worst` moved to the p95 title; both numbers are still here, so
       this asserts the width AND that the two that moved are still readable. */
    const h = cardHarness();
    h.store.record('?type=lcp', { ms: 900, ok: true });
    h.store.record('?type=lcp', { ms: 7500, ok: true });

    h.draw();
    const html = h.html();

    assert.strictEqual((html.match(/<th /g) || []).length, 8, 'the header row is no longer eight columns');
    assert.ok(html.indexOf('title="worst 7.5s"') !== -1,
      'the worst call must still be one hover away: ' + html.slice(0, 400));
    assert.ok(/healthEsc_\(healthMs_\(r\.waitMaxMs\)\)/.test(ADMIN),
      'and it must be drawn from waitMaxMs rather than left behind');
  });

  test('a header sits over its own column: each label is aligned the way its data is', () => {
    /* Reported from a screenshot: "tila'y hindi naka-align yung data sa column?" The header
       row was left-aligned while the numbers under it were right-aligned, so "10s" floated
       between "Wait p50" and "Wait p95" with nothing saying which column it belonged to. The
       columns are stretched to the card's full width, and that stretch is what makes the gap
       visible at all.

       So this asserts the rule and not one column: a header is aligned the way ITS OWN
       column's data is aligned. It also asserts the table really is mixed — an all-left table
       would satisfy the rule while quietly throwing the numbers away. */
    const h = cardHarness();
    h.store.record('?type=lcp', { ms: 900, ok: true });
    h.draw();
    const html = h.html();

    const alignOf = (style) => {
      const m = /text-align:\s*(\w+)/.exec(style);
      return m ? m[1] : 'left';   // a cell that says nothing reads left, like the browser does
    };
    const cellsOf = (text, tag) => {
      const out = [];
      const re = new RegExp('<' + tag + ' style="([^"]*)"', 'g');
      let m;
      while ((m = re.exec(text)) !== null) out.push(alignOf(m[1]));
      return out;
    };

    const bodyStart = html.indexOf('<tbody>') + '<tbody>'.length;
    const heads = cellsOf(html.slice(0, bodyStart), 'th');
    const row = cellsOf(html.slice(bodyStart, html.indexOf('</tr>', bodyStart)), 'td');

    assert.strictEqual(heads.length, 8, 'the header row was not found: ' + html.slice(0, 120));
    assert.strictEqual(row.length, 8, 'the drawn row was not found: ' + html.slice(bodyStart, bodyStart + 120));
    heads.forEach((align, i) => {
      assert.strictEqual(align, row[i],
        'column ' + i + ' reads ' + align + ' in the header and ' + row[i] + ' in the data');
    });
    assert.strictEqual(heads[0], 'left', 'the module names are text, so they read left');
    assert.ok(heads.indexOf('right') !== -1 && heads.indexOf('left') !== -1,
      'the table is no longer mixed, so this check would pass on anything: ' + heads);
  });

  test('the worst module is drawn first, because that is the question', () => {
    const h = cardHarness();
    h.store.record('?type=nap', { ms: 400, ok: true });
    h.store.record('?type=backbone', { ms: 9000, ok: true });

    h.draw();
    const html = h.html();
    assert.ok(html.indexOf('backbone') < html.indexOf('nap'),
      'the slowest module is not at the top: ' + html.slice(0, 300));
  });

  test('the card says the edge numbers are absent rather than drawing a zero', () => {
    const h = cardHarness();
    h.store.record('?type=lcp', { ms: 3000, ok: true });   // no originMs: the live case today

    h.draw();
    const html = h.html();

    assert.ok(html.indexOf('Edge timing unavailable') !== -1, 'the absent measurement must be named');
    assert.ok(html.indexOf('0ms') === -1, 'and must never be drawn as 0ms: ' + html.slice(0, 300));
    assert.ok(html.indexOf('3.0s') !== -1, 'while the wait this device measured is still there');
  });

  test('and switches to the edge numbers, plus the overhead, when it has them', () => {
    const h = cardHarness();
    h.store.record('?type=lcp', { ms: 6000, originMs: 1500, originAttempts: 1, ok: true });

    h.draw();
    const html = h.html();

    assert.ok(html.indexOf('Edge timing unavailable') === -1, 'the note must go away when the numbers exist');
    assert.ok(html.indexOf('1.5s') !== -1, 'the origin time must be drawn');
    assert.ok(html.indexOf('4.5s') !== -1, 'and the overhead, which is what this device added');
  });

  test('the card draws its empty state rather than an empty box', () => {
    const h = cardHarness();
    h.draw();

    assert.ok(h.html().indexOf('Nothing measured yet this session') !== -1, h.html().slice(0, 200));
  });

  test('a device with no store is told, not shown an empty table', () => {
    const h = cardHarness({ withoutStore: true });
    h.draw();

    assert.ok(h.html().indexOf('diag-store.js is not loaded on this device') !== -1,
      'a device on an older shell must be told which file is missing: ' + h.html().slice(0, 200));
  });

  test('a failed call is drawn as failed, with its error on the row', () => {
    const h = cardHarness();
    h.store.record('?type=node', { ms: 8000, attempts: 3, ok: false, error: 'HTTP 502' });

    h.draw();
    const html = h.html();

    assert.ok(html.indexOf('HTTP 502') !== -1, 'the last error must reach the row title');
    assert.ok(html.indexOf('var(--badge-red-text)') !== -1, 'and the failure count must be drawn as one');
  });

  test('a retried call is marked, and a clean session is not', () => {
    /* The retry column is the retry LOOP made visible: a call that took three attempts is
       drawn differently from one that took one, because "slow" and "slow but retried" are
       different problems with different fixes. */
    const retried = cardHarness();
    retried.store.record('?type=node', { ms: 8000, attempts: 3, ok: true });
    retried.draw();
    assert.ok(retried.html().indexOf('var(--badge-yellow-text)') !== -1,
      'a retried call must not look like a clean one: ' + retried.html().slice(0, 400));

    const clean = cardHarness();
    clean.store.record('?type=node', { ms: 8000, attempts: 1, ok: true });
    clean.draw();
    assert.ok(clean.html().indexOf('var(--badge-yellow-text)') === -1,
      'and a clean call must not be marked');
  });

  test('a thrown message with markup in it is escaped on the way into the row', () => {
    const h = cardHarness();
    h.store.record('?type=lcp', { ms: 900, ok: false, error: '<img src=x onerror=alert(1)>' });

    h.draw();
    assert.ok(h.html().indexOf('<img') === -1,
      'an error message reached the DOM unescaped: ' + h.html().slice(0, 400));
  });

  test('the card names how many samples were dropped, when any were', () => {
    const h = cardHarness();
    for (let i = 0; i < 25; i++) h.store.record('?type=lcp', { ms: 100 + i, ok: true });

    h.draw();
    assert.ok(h.html().indexOf('5 older samples dropped') !== -1,
      'the bound must be visible rather than silent: ' + h.html().slice(-300));
  });

  /* ---------------------------------------------------------------- *
     7. The wiring, read as text
   * ---------------------------------------------------------------- */

  test('fetchWithRetry records at BOTH exits, and reads both edge headers', () => {
    assert.ok(/window\.diagStore\.record\(url, sample\)/.test(INDEX),
      'index.html no longer records into the store');
    assert.ok(/edgeNumber\(res, 'x-netpulse-origin-ms'\)/.test(INDEX), 'the origin-ms header is not read');
    assert.ok(/edgeNumber\(res, 'x-netpulse-attempts'\)/.test(INDEX), 'the attempts header is not read');

    const okNote = /recordDiag\(\{ ok: true,[^}]*attempts: i \+ 1[^}]*\}\);/.test(INDEX);
    assert.ok(okNote, 'the success exit does not record a sample');

    const failNote = /recordDiag\(\{ ok: false,[^}]*attempts,/.test(INDEX);
    assert.ok(failNote, 'the give-up exit does not record a sample — a module that never got its data would be invisible');

    assert.ok(INDEX.indexOf("'diag-store.js'") === -1 && /<script src="diag-store\.js"><\/script>/.test(INDEX),
      'diag-store.js is not loaded by a script tag');
  });

  test('the sample records WALL CLOCK, and the header goes missing as null rather than 0', () => {
    assert.ok(/const startedAt = Date\.now\(\);/.test(INDEX), 'the wall clock is not taken');
    assert.ok(/ms: Date\.now\(\) - startedAt/.test(INDEX), 'the recorded ms is not the wall clock');

    assert.ok(/if \(raw === null \|\| raw === undefined \|\| raw === ''\) return null;/.test(INDEX),
      'an absent header must return null, and a coercion to 0 would print a lie');
    assert.ok(/return \(isFinite\(n\) && n >= 0\) \? Math\.round\(n\) : null;/.test(INDEX),
      'and an unparseable one too');
  });

  test('the diagnostic cannot break the call it measures', () => {
    /* Both halves, and each one covers a different failure: a device on an older shell has no
       store at all, and a store that RAISES must not reach the retry policy. The one that
       matters is the call-site guard, because those calls sit inside the try that decides
       whether to retry. tests/origin-resilience.test.js drives a store whose record() throws
       and holds that line — this only pins that the two guards are still there. */
    assert.ok(/function noteApiCall\(url, sample\)/.test(INDEX), 'the store-side wrapper is gone');
    assert.ok(/if \(typeof window === 'undefined' \|\| !window\.diagStore\) return;/.test(INDEX),
      'a shell without diag-store.js must record nothing rather than throw');

    assert.ok(/const recordDiag = \(sample\) => \{/.test(INDEX), 'the call-site guard is gone');
    assert.ok(/catch \(e\) \{ \/\* never reaches the retry policy \*\/ \}/.test(INDEX),
      'the call-site guard no longer catches, so a diagnostics fault would be retried as an origin failure');
  });

  test('the admin tab renders the card, and the card renders after the tab exists', () => {
    assert.ok(ADMIN.indexOf('id="moduleHealthBody"') !== -1, 'the card has no mount point in the admin tab');
    assert.ok(/renderModuleHealth\(\);\n\}/.test(ADMIN.replace(/\r\n/g, '\n')),
      'renderAdminTab() does not render the card');
    assert.ok(ADMIN.indexOf('moduleHealthStore_()') !== -1, 'the card does not read the store');
  });

  test('the card adds no timer and no request of its own', () => {
    /* Opening the admin tab must cost nothing: this is the surface a person stares at while
       asking why something is slow. */
    const tail = ADMIN.slice(ADMIN.indexOf('function moduleHealthStore_'));
    assert.ok(tail.indexOf('setInterval') === -1, 'the health card added a timer');
    assert.ok(tail.indexOf('fetchWithRetry') === -1,
      'the health card made a request — Refresh must re-read memory, not refetch');
    assert.ok(tail.indexOf('localStorage') === -1, 'the health card persists something');
  });

  test('the admin card says when the edge numbers are missing instead of printing them', () => {
    assert.ok(ADMIN.indexOf('Edge timing unavailable') !== -1,
      'the card must name the missing measurement — the proxy is off right now, so this is the LIVE state');
    assert.ok(/r\.edgeSamples \? r\.originMs : null/.test(ADMIN),
      'the origin column must be driven by the count of calls that carried edge timing');
  });

  /* ---------------------------------------------------------------- *
     8. The release: a file the service worker never sees is a file that
        arrives only when it feels like it
   * ---------------------------------------------------------------- */

  test('every local script index.html loads is precached by sw.js', () => {
    const staticAssets = /const STATIC_ASSETS = \[([\s\S]*?)\];/.exec(SW);
    assert.ok(staticAssets, 'sw.js no longer has a STATIC_ASSETS list');
    const listed = staticAssets[1];

    const local = [];
    const tag = /<script src="([^"]+)"/g;
    let m;
    while ((m = tag.exec(INDEX)) !== null) {
      if (/^https?:/.test(m[1])) continue;   // a CDN is not ours to preload
      local.push(m[1]);
    }
    assert.ok(local.length >= 10, 'the script tags were not found: ' + local.length);

    const missing = local.filter((f) => listed.indexOf("'./" + f + "'") === -1);
    assert.deepStrictEqual(missing, [],
      'these files are loaded by the page and never precached by the service worker: ' + missing.join(', '));
  });

  /* ---------------------------------------------------------------- */

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})();
