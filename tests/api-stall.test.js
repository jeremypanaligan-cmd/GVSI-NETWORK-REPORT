/* ------------------------------------------------------------------ *
   The stall-handling guard.

   Context — measured on the live deployment, with curl (no cookies, no JS, no
   service worker):

     - 15 calls in a sweep, 3 came back 404 (20%), and EVERY 404 took 8-33 s.
     - Every fast call (1.1-1.3 s) was 200. A single cold call took 45.3 s.
     - 32 calls through node's fetch, while the endpoint was answering fast,
       404'd 0 times.

   So the 404 is not a missing route and not this app's code: it lands on the
   redirect hop (script.googleusercontent.com/macros/echo, reached after /exec
   answers 302) and the app's own script cannot produce it at all, because
   ContentService always answers 200. It is a STALL SIGNATURE.

   What the app did with that signature was the bug: retry after a fixed 500 ms,
   from six callers at once (five modules plus the heartbeat, all started in the
   same tick by showApp()), so one bad second became ~18 invocations inside the
   stall. A retry that fires 500 ms into an 8 s stall is a retry that is
   guaranteed to fail.

   Three properties are asserted here, because each is one "helpful" edit away
   from coming back:

     1. the retry waits as long as the attempt actually took (stallMs), not a
        constant — and the wait is computed by a PURE function, so it can be run;
     2. there is ONE gate for the whole app, not one per caller, and the wait
        loops so a sibling failing underneath cannot release it early;
     3. the heartbeat's first beat does not fire in the boot tick.

   Following inline-order.test.js and boot-parallel.test.js: the first test is
   the gate on the shipping app, and the rest re-introduce each old shape in its
   real form so the suite fails if the checker stops seeing it.

   What this does NOT cover: that the retry then succeeds. That needs the live
   API and a stalled instance, neither of which exists here.
 * ------------------------------------------------------------------ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadScriptUnits,
  maskLiterals,
  depthMap,
  collectFunctions,
  ownBody,
  calleesIn,
  readOffsets
} = require('./inline-order.js');

const ROOT = path.join(__dirname, '..');

/* ==================================================================== *
   The analysis
 * ==================================================================== */

/** The one shared gate. One name, declared once, read by every caller. */
const GATE_NAME = '_stallGateUntil';

/** The old shape, in the form it shipped: no stall term anywhere. */
const OLD_BACKOFF = /Math\.pow\(\s*2\s*,\s*attempt\s*-\s*1\s*\)/;

/** A gate declared inside a function is a per-caller gate. That is the bug. */
const PRIVATE_GATE = /\b(?:var|let|const)\s+\w*[Gg]ate\w*\s*=/;

function unitMatching(units, re) {
  return units.filter((u) => re.test(u.name));
}

/**
 * Inspect every script the page loads and report each way the stall handling
 * has gone back to a fixed backoff, a per-caller gate, or a boot-tick beat.
 */
function analyseStallHandling(units) {
  const report = {
    fixedBackoff: [],          // units still computing the wait from the attempt number alone
    stallBlindFetchers: [],    // fetchWithRetry() implementations with no stall term
    privateGates: [],          // a gate declared inside a caller instead of shared
    gateDeclarations: 0,       // must be exactly 1 across the whole app
    impureDelay: [],           // retryDelayMs() reaching for clock, DOM or network
    singleShotWait: [],        // waitForStallGate() that sleeps once and stops
    immediateFirstBeat: [],    // startHeartbeat() calling sendHeartbeat() on entry
    missingDeferral: [],       // startHeartbeat() with no setTimeout for the first beat
    missingCleanup: []         // stopHeartbeat() that cannot cancel the first beat
  };

  for (const unit of units) {
    const masked = maskLiterals(unit.code);
    const depths = depthMap(masked);
    const fns = collectFunctions(masked, depths);

    const span = (name) => fns.get(name) || null;

    /** Everything name() can reach, plus itself. Callbacks are NOT traversed. */
    const rawBody = (name) => {
      const s = span(name);
      return s ? masked.slice(s.bodyStart, s.bodyEnd) : null;
    };

    /** The body with nested callbacks blanked: only what runs on entry. */
    const own = (name) => {
      const s = span(name);
      return s ? ownBody(masked, s.bodyStart, s.bodyEnd) : null;
    };

    /* 1. The old formula, anywhere. */
    if (OLD_BACKOFF.test(masked)) report.fixedBackoff.push(unit.name);

    /* 2. A retry path that never looks at how long the attempt took. */
    const fetcherBody = rawBody('fetchWithRetry');
    if (fetcherBody !== null) {
      const required = ['stallMs', 'retryDelayMs(', 'noteStall(', 'waitForStallGate('];
      const missing = required.filter((n) => fetcherBody.indexOf(n) === -1);
      if (missing.length) {
        report.stallBlindFetchers.push(unit.name + ' · fetchWithRetry() lacks ' + missing.join(', '));
      }
      // A gate declared inside the retry path is private to it: every caller then
      // waits on its own clock, which is what made six storms out of one stall.
      const privateInFetcher = ownBody(masked, span('fetchWithRetry').bodyStart, span('fetchWithRetry').bodyEnd);
      if (PRIVATE_GATE.test(privateInFetcher)) {
        report.privateGates.push(unit.name + ' · fetchWithRetry() declares its own gate');
      }
    }

    /* 3. Exactly one gate, declared at the top level. */
    report.gateDeclarations += (masked.match(new RegExp('\\b(?:var|let|const)\\s+' + GATE_NAME + '\\b', 'g')) || []).length;

    /* 4. The wait must be a pure function of (stall, attempt, base). */
    const delayBody = rawBody('retryDelayMs');
    if (delayBody !== null) {
      const impure = ['Date.now', 'fetch(', 'document', 'window.', GATE_NAME, 'localStorage']
        .filter((n) => delayBody.indexOf(n) !== -1);
      if (impure.length) report.impureDelay.push(unit.name + ' · retryDelayMs() reads ' + impure.join(', '));
    }

    /* 5. The shared wait must LOOP: a sibling can push the gate out mid-sleep. */
    const waitBody = rawBody('waitForStallGate');
    if (waitBody !== null && !/\b(for|while)\s*\(/.test(waitBody)) {
      report.singleShotWait.push(unit.name + ' · waitForStallGate() sleeps once');
    }

    /* 6. The heartbeat must not fire its first beat on entry. */
    const startOwn = own('startHeartbeat');
    if (startOwn !== null) {
      const direct = new Set();
      for (const c of calleesIn(startOwn, fns)) direct.add(c.name);
      if (direct.has('sendHeartbeat')) {
        report.immediateFirstBeat.push(unit.name + ' · startHeartbeat() calls sendHeartbeat() on entry');
      }
      // Checked on the RAW body, not the own body: ownBody() blanks a
      // callback-scheduling call whole, so `setTimeout(fn, ms)` disappears from it
      // and the deferral would look missing in healthy code.
      const startRaw = rawBody('startHeartbeat') || '';
      if (!readOffsets(startRaw, 'setTimeout').length) {
        report.missingDeferral.push(unit.name + ' · startHeartbeat() has no setTimeout for the first beat');
      }
    }

    const stopOwn = own('stopHeartbeat');
    if (stopOwn !== null && !readOffsets(stopOwn, 'clearTimeout').length) {
      report.missingCleanup.push(unit.name + ' · stopHeartbeat() cannot cancel the pending first beat');
    }
  }

  return report;
}

/* ==================================================================== *
   The executable half: the real delay function, out of the real source.

   A static check says the delay mentions a stall; only running it says the delay
   is SHORTER than the stall, which is the one mistake that matters.
 * ==================================================================== */

/** Slice one top-level function out of raw source, braces balanced. */
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + '() was not found in the source');
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name + '()');
}

/**
 * The shipping retryDelayMs(), closed over the REAL RETRY_MIN_WAIT /
 * RETRY_MAX_WAIT values read from the source — so a test that passes cannot be
 * passing against a copy of the numbers.
 */
function loadRetryDelay() {
  // Found by what it DEFINES, not by position: index.html carries the anti-FOUC
  // inline script first, so the retry layer is inline #2 and matching on the file
  // name alone picks the wrong unit.
  const unit = loadScriptUnits(ROOT).find((u) => u.code.indexOf('function retryDelayMs') !== -1);
  assert.ok(unit, 'no loaded script defines retryDelayMs()');

  const min = Number((unit.code.match(/\bRETRY_MIN_WAIT\s*=\s*(\d+)/) || [])[1]);
  const max = Number((unit.code.match(/\bRETRY_MAX_WAIT\s*=\s*(\d+)/) || [])[1]);
  assert.ok(min > 0 && max > min, 'the wait bounds were not found in index.html');

  const src = extractFunction(unit.code, 'retryDelayMs');
  const fn = new Function('RETRY_MIN_WAIT', 'RETRY_MAX_WAIT', 'return (' + src + ');')(min, max);
  assert.equal(typeof fn, 'function', 'retryDelayMs() did not evaluate to a function');
  return { fn, min, max };
}

/* ==================================================================== *
   Fixtures — each old shape, in its real form
 * ==================================================================== */

/** The retry path as it shipped before this change. */
function fixtureFixedBackoff() {
  return [{
    name: 'index.html (inline #1)',
    startLine: 1,
    code: [
      'function fetchWithRetry(url, retries, delay) {',
      '  return (async () => {',
      '    for (let attempt = 1; ; attempt++) {',
      '      const res = await fetch(url, { cache: "no-store" });',
      '      if (res.ok) return res.json();',
      '      if (attempt >= retries) throw new Error("HTTP " + res.status);',
      '      await new Promise(r => setTimeout(r, delay * Math.pow(2, attempt - 1) + Math.random() * 250));',
      '    }',
      '  })();',
      '}'
    ].join('\n')
  }];
}

/** A retry path with a gate that only its own caller can see. */
function fixturePrivateGate() {
  return [{
    name: 'index.html (inline #1)',
    startLine: 1,
    code: [
      'function fetchWithRetry(url, retries, delay) {',
      '  let gateUntil = 0;',
      '  return (async () => {',
      '    for (let attempt = 1; ; attempt++) {',
      '      const attemptStart = Date.now();',
      '      const res = await fetch(url, { cache: "no-store" });',
      '      const stallMs = Date.now() - attemptStart;',
      '      if (res.ok) return res.json();',
      '      noteStall(retryDelayMs(stallMs, attempt, delay));',
      '      await waitForStallGate();',
      '      if (attempt >= retries) throw new Error("HTTP " + res.status);',
      '    }',
      '  })();',
      '}',
      'const retryDelayMs = (a, b, c) => a;',
      'const noteStall = () => {};',
      'function waitForStallGate() { return 0; }'
    ].join('\n')
  }];
}

/** The heartbeat as it shipped: first beat in the boot tick. */
function fixtureImmediateHeartbeat() {
  return [{
    name: 'admin-module.js',
    startLine: 1,
    code: [
      'var _heartbeatInterval = null;',
      'var HEARTBEAT_MS = 60000;',
      // Declared on purpose: calleesIn() only reports calls to names the unit
      // defines, so without this the fixture would pass for the wrong reason.
      'function sendHeartbeat() {}',
      'function startHeartbeat() {',
      '  sendHeartbeat(); // Immediate',
      '  _heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_MS);',
      '}',
      'function stopHeartbeat() {',
      '  clearInterval(_heartbeatInterval);',
      '  _heartbeatInterval = null;',
      '}'
    ].join('\n')
  }];
}

/* ==================================================================== *
   1. The gate — this is the assertion that protects the app.
 * ==================================================================== */

test('the shipping app backs off by the stall it measured, through one shared gate', () => {
  const units = loadScriptUnits(ROOT);
  const report = analyseStallHandling(units);

  assert.deepEqual(
    report.fixedBackoff, [],
    'the wait is still computed from the attempt number alone, so a retry lands inside the same stall:\n' +
    report.fixedBackoff.map((u) => '  ' + u).join('\n')
  );

  assert.deepEqual(
    report.stallBlindFetchers, [],
    'the retry path does not measure its own attempt:\n' +
    report.stallBlindFetchers.map((u) => '  ' + u).join('\n')
  );

  assert.deepEqual(
    report.privateGates, [],
    'a caller declares its OWN gate, so six callers keep six clocks and the storm returns:\n' +
    report.privateGates.map((u) => '  ' + u).join('\n')
  );

  assert.equal(
    report.gateDeclarations, 1,
    'expected exactly one shared stall gate across the app, found ' + report.gateDeclarations
  );

  assert.deepEqual(report.impureDelay, [], 'retryDelayMs() must stay a pure function:\n' +
    report.impureDelay.map((u) => '  ' + u).join('\n'));

  assert.deepEqual(
    report.singleShotWait, [],
    'waitForStallGate() sleeps once, so a sibling failing beneath it releases it early:\n' +
    report.singleShotWait.map((u) => '  ' + u).join('\n')
  );

  assert.deepEqual(
    report.immediateFirstBeat, [],
    'the heartbeat fires in the boot tick, adding one more concurrent /exec draw during a stall:\n' +
    report.immediateFirstBeat.map((u) => '  ' + u).join('\n')
  );

  assert.deepEqual(report.missingDeferral, [], 'the first beat is not deferred:\n' +
    report.missingDeferral.map((u) => '  ' + u).join('\n'));

  assert.deepEqual(report.missingCleanup, [], 'the pending first beat cannot be cancelled:\n' +
    report.missingCleanup.map((u) => '  ' + u).join('\n'));
});

/* ==================================================================== *
   2. Teeth — each old shape, re-introduced, must be caught.
 * ==================================================================== */

test('the fixed 500 ms backoff is caught', () => {
  const report = analyseStallHandling(fixtureFixedBackoff());

  assert.deepEqual(report.fixedBackoff, ['index.html (inline #1)'], 'the checker missed the old formula');
  assert.equal(report.stallBlindFetchers.length, 1, 'the checker missed a retry path with no stall term');
  assert.equal(report.gateDeclarations, 0, 'the old shape had no shared gate, and none should be reported');
});

test('a per-caller gate is caught', () => {
  const report = analyseStallHandling(fixturePrivateGate());

  assert.deepEqual(
    report.privateGates, ['index.html (inline #1) · fetchWithRetry() declares its own gate'],
    'the checker missed a gate that is private to one caller'
  );
  assert.equal(report.gateDeclarations, 0, 'this fixture declares no shared gate');
  assert.deepEqual(report.stallBlindFetchers, [], 'this fixture does measure its attempt, so it is not stall-blind');
});

test('an immediate first heartbeat is caught', () => {
  const report = analyseStallHandling(fixtureImmediateHeartbeat());

  assert.deepEqual(
    report.immediateFirstBeat, ['admin-module.js · startHeartbeat() calls sendHeartbeat() on entry'],
    'the checker missed the boot-tick heartbeat'
  );
  assert.deepEqual(
    report.missingDeferral, ['admin-module.js · startHeartbeat() has no setTimeout for the first beat'],
    'the checker missed that nothing defers the first beat'
  );
  assert.deepEqual(report.missingCleanup, ['admin-module.js · stopHeartbeat() cannot cancel the pending first beat'],
    'the checker missed that the pending first beat cannot be cancelled');
});

/* ==================================================================== *
   3. The formula, executed — the property the whole change exists for.
 * ==================================================================== */

test('the retry outlasts the stall it just observed, up to the cap', () => {
  const { fn, max } = loadRetryDelay();

  // Below saturation the retry MUST outlast the stall it saw, or it re-enters it.
  for (const stallMs of [1200, 4000, 8000, 13333]) {
    const waited = fn(stallMs, 1, 500);
    assert.ok(
      waited > stallMs,
      'a retry after a ' + stallMs + 'ms stall waits only ' + waited + 'ms, so it re-enters the same stall'
    );
  }

  // Above saturation the wait IS the cap, by design: the gate is level-triggered,
  // so an attempt that fails again re-arms it from its own measured stall. Waiting
  // out a 50 s stall in one sleep would hold a module's skeleton for a minute.
  for (const stallMs of [20000, 33000, 60000]) {
    assert.equal(
      fn(stallMs, 1, 500), max,
      'a ' + stallMs + 'ms stall should clamp to the cap rather than growing without bound'
    );
  }
});

test('no stalled attempt can fall back to the old fixed backoff', () => {
  const { fn } = loadRetryDelay();

  // The old wait was delay * 2^(attempt-1): 500, 1000, 2000. A stalled attempt
  // must beat it at every attempt number, or the regression is invisible.
  for (const attempt of [1, 2, 3]) {
    const oldWait = 500 * Math.pow(2, attempt - 1);
    assert.ok(
      fn(8000, attempt, 500) > oldWait,
      'attempt ' + attempt + ' after an 8s stall waits ' + fn(8000, attempt, 500) +
      'ms, which is no better than the old ' + oldWait + 'ms'
    );
  }
});

test('the wait still grows with the attempt number for a fast failure', () => {
  const { fn } = loadRetryDelay();

  // A blip that answers in 100 ms keeps the old exponential: 500, 1000, 2000.
  assert.equal(fn(100, 1, 500), 1500, 'a fast failure should sit at the floor, not at zero');
  assert.equal(fn(100, 3, 500), 2000, 'the exponential must still govern a short failure');
  assert.ok(fn(100, 4, 500) > fn(100, 3, 500), 'the wait stopped growing with the attempt number');
});

test('the wait is bounded at both ends', () => {
  const { fn, min, max } = loadRetryDelay();

  assert.equal(fn(0, 1, 500), min, 'the floor must apply to an instant failure');
  assert.equal(fn(100, 1, 50), min, 'a tiny base must not produce a wait below the floor');
  assert.equal(fn(40000, 1, 500), max, 'a stall past the cap must clamp, or a retry outlives its poll');
  assert.ok(max >= 10000, 'the cap is now so low that a long stall cannot be waited out');
});
