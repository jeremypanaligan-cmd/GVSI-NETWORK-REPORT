/* ------------------------------------------------------------------ *
   The temporal-dead-zone guard.

   A top-level `const` in a classic <script> is unusable until its own statement
   has run. The app calls into itself from statements placed ABOVE some of its
   own declarations, so a declaration that a reachable function reads throws

       ReferenceError: Cannot access 'X' before initialization

   at first paint — and only at first paint, which is why calling the same
   function from the console afterwards looks fine. It has shipped twice:

     1. `dataCache`, read by cache-control.js's getDataCache() and reached from
        the top-level checkAppVersion() call, which sits above the declaration.
     2. the module-skeleton table, read by fetchNapData() and reached from the
        top-level checkMaintenanceAndLogin() call, likewise above it.

   The two tests that matter most here are the FIRST one (the app must be clean)
   and the reproductions below: a checker that cannot fail on a real instance of
   the bug it exists to catch is worse than no checker, because it reads as
   coverage. So each historical bug is re-introduced, in its real shape (a real
   file, the real call chain), and the suite fails if the checker stops seeing
   it. See tests/inline-order.js for how the analysis works and what it
   deliberately does not cover.
 * ------------------------------------------------------------------ */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  analyse,
  analyseApp,
  loadScriptUnits,
  maskLiterals,
  effectiveDepth,
  collectFunctions,
  iifeRanges
} = require('./inline-order.js');

const ROOT = path.join(__dirname, '..');

/** Fixture units: array position is load order. */
const units = (...codes) => codes.map((code, i) => ({ name: 'script' + (i + 1), code }));

/** The shipping app, as the checker sees it. */
const appUnits = loadScriptUnits(ROOT);

/* ==================================================================== *
   1. The gate — this is the assertion that protects the app.
 * ==================================================================== */

test('the shipping app has no temporal-dead-zone reads', () => {
  const violations = analyseApp(ROOT);
  assert.deepEqual(
    violations, [],
    'a top-level declaration is read by a statement that runs before it initialises:\n' +
    violations.map(v => `  ${v.name} — read by ${v.readBy}(), reached from ${v.callName}() ` +
      `at ${v.script} line ${v.line}`).join('\n')
  );
});

test('the analysis actually looks at every script the page runs', () => {
  // A pass that inspected nothing would also report nothing. The load order is
  // the real one: index.html's inline block comes after the module files.
  const names = appUnits.map(u => u.name);
  assert.ok(appUnits.length >= 10, 'expected the full script list, got ' + names.join(', '));
  for (const expected of ['cache-control.js', 'nap-module.js', 'admin-module.js', 'kiosk-module.js']) {
    assert.ok(names.includes(expected), 'missing ' + expected + ' — found ' + names.join(', '));
  }
  assert.ok(
    names.filter(n => n.startsWith('index.html')).length >= 1,
    'index.html inline scripts were not loaded'
  );

  // Functions must actually be collected from every module. If the wrapper
  // folding regresses, collectFunctions() quietly returns nothing for an
  // IIFE-wrapped file and the whole file stops being analysed — which is
  // exactly what hid the dataCache case. Assert it per file rather than trusting
  // the violation count, because a file that is not analysed also reports
  // nothing.
  const mustYieldFunctions = [
    'db.js', 'notifications.js', 'cache-control.js', 'nap-module.js', 'lcp-module.js',
    'olt-module.js', 'node-module.js', 'backbone-module.js', 'analytics-module.js',
    'admin-module.js', 'kiosk-module.js'
  ];
  const barren = [];
  for (const name of mustYieldFunctions) {
    const unit = appUnits.find(u => u.name === name);
    if (!unit) { barren.push(name + ' (not loaded)'); continue; }
    const masked = maskLiterals(unit.code);
    const found = collectFunctions(masked, effectiveDepth(masked));
    if (found.size === 0) barren.push(name + ' (0 functions collected)');
  }
  assert.deepEqual(barren, [], 'these scripts are not being analysed: ' + barren.join(', '));

  // The page's own script is the one that declares the constants, so it is worth
  // asserting it is fully seen too — not just present in the list.
  const appScript = appUnits.find(u => u.name === 'index.html (inline #2)');
  assert.ok(appScript, 'the application inline script was not found');
  const appMasked = maskLiterals(appScript.code);
  assert.ok(
    collectFunctions(appMasked, effectiveDepth(appMasked)).size > 30,
    'the application script looks truncated — far fewer functions than expected'
  );
});

test('an IIFE body counts as top level', () => {
  // `(function () { … })()` runs during evaluation, so a const inside it is
  // initialised then too. Folding the wrapper must survive BOTH the brace and
  // the parenthesis — measuring from the wrong depth made cache-control.js
  // invisible, and this pins that.
  const masked = maskLiterals('(function () {\n  function inner() { return x; }\n  var x = 1;\n})();');
  const ranges = iifeRanges(masked);
  assert.equal(ranges.length, 1, 'the IIFE should be detected');
  const depths = effectiveDepth(masked);
  const at = masked.indexOf('function inner');
  assert.equal(depths[at], 0, 'a function directly inside an IIFE is top level');
});

/* ==================================================================== *
   2. Teeth — each historical bug, re-introduced in its real shape.
 * ==================================================================== */

/** Rewrite cache-control.js's getDataCache() without its try/catch guard. */
function stripDataCacheGuard(list) {
  return list.map((unit) => {
    if (unit.name !== 'cache-control.js') return unit;
    const at = unit.code.indexOf('function getDataCache');
    assert.notEqual(at, -1, 'getDataCache() moved — update this test');
    const end = unit.code.indexOf('\n  }', at);
    assert.notEqual(end, -1, 'could not find the end of getDataCache()');
    assert.ok(
      unit.code.slice(at, end).includes('catch'),
      'getDataCache() no longer has a try/catch guard; if that is intentional, ' +
      'update this test to reproduce the bug some other way'
    );
    const unguarded =
      'function getDataCache() {\n' +
      "    return (typeof dataCache !== 'undefined' && dataCache) ? dataCache : null;\n" +
      '  }';
    return { ...unit, code: unit.code.slice(0, at) + unguarded + unit.code.slice(end + 4) };
  });
}

test('it catches the first historical bug: dataCache read by checkAppVersion()', () => {
  // Filtered to this declaration on purpose: the point of these mutation tests is
  // "does the checker see THIS bug", and coupling them to a clean baseline would
  // make a single real regression fail five tests instead of one.
  const found = analyse(stripDataCacheGuard(appUnits)).filter(v => v.name === 'dataCache');

  assert.equal(
    found.length, 1,
    'the checker no longer sees the dataCache bug it was written for: ' + JSON.stringify(found)
  );
  const v = found[0];
  assert.equal(v.callName, 'checkAppVersion', 'the top-level statement that runs too early');
  assert.equal(v.readBy, 'getDataCache', 'the function that reads it');
  assert.match(v.script, /index\.html/, 'reported against the script that runs the call');
  assert.equal(v.viaMicrotask, false, 'the read is on the synchronous path');
});

const inline2 = (list) => list.find(u => u.name === 'index.html (inline #2)');

test('that bug is only found by following the property call into the IIFE', () => {
  // The chain is checkAppVersion() -> netpulseCache.invalidateAll() ->
  // clearMemory() -> getDataCache(). Two steps are ordinary calls; the first is
  // a property call into a file whose entire body is an IIFE.
  const renamed = appUnits.map((u) => u.name === 'index.html (inline #2)'
    ? { ...u, code: u.code.replace('netpulseCache.invalidateAll(', 'netpulseCache.zzz(') }
    : u);
  assert.notEqual(
    inline2(renamed).code, inline2(appUnits).code,
    'the call was not renamed — update this test'
  );
  assert.deepEqual(
    analyse(stripDataCacheGuard(renamed)).filter(v => v.name === 'dataCache'), [],
    'the dataCache read was found without resolving netpulseCache.invalidateAll()'
  );
});

test('it catches the second historical bug: a late const read by a module renderer', () => {
  // checkMaintenanceAndLogin() -> loadInitialData() -> fetchNapData(), with the
  // declaration added below the top-level call that reaches it.
  const NAME = 'MODULE_SKELETON_TARGETS';
  const buggy = appUnits.map((unit) => {
    if (unit.name === 'index.html (inline #2)') {
      const at = unit.code.indexOf('checkMaintenanceAndLogin();');
      assert.notEqual(at, -1, 'the boot call moved — update this test');
      const insertAt = unit.code.indexOf('\n', at) + 1;
      const decl = '\n  const ' + NAME + ' = { nap: { bodies: ["napTableBody"] } };\n';
      return { ...unit, code: unit.code.slice(0, insertAt) + decl + unit.code.slice(insertAt) };
    }
    if (unit.name === 'nap-module.js') {
      const at = unit.code.indexOf('function fetchNapData');
      assert.notEqual(at, -1, 'fetchNapData() moved — update this test');
      const open = unit.code.indexOf('{', at);
      return { ...unit, code: unit.code.slice(0, open + 1) + '\n  var _s = ' + NAME + '.nap;' + unit.code.slice(open + 1) };
    }
    return unit;
  });

  const found = analyse(buggy).filter(v => v.name === NAME);
  assert.equal(
    found.length, 1,
    'the checker no longer sees the late-const bug it was written for: ' + JSON.stringify(found)
  );
  assert.equal(found[0].callName, 'checkMaintenanceAndLogin');
  assert.equal(found[0].readBy, 'fetchNapData');
});

test('an unrelated edit does not start reporting violations', () => {
  // Guards against a checker that fails on any change at all.
  const noisy = appUnits.map((u) => u.name === 'cache-control.js'
    ? { ...u, code: u.code.replace("'theme'", "'theme_name'") }
    : u);
  assert.notEqual(
    noisy.find(u => u.name === 'cache-control.js').code,
    appUnits.find(u => u.name === 'cache-control.js').code,
    "the edit did not apply ('theme' may have moved) — update this test"
  );
  // The claim is "adds nothing", not "nothing at all" — comparing against the
  // live baseline keeps this a statement about the edit.
  assert.deepEqual(analyse(noisy), analyse(appUnits));
});

/* ==================================================================== *
   3. Rules — what is and is not a violation, and why.
 * ==================================================================== */

test('flags a top-level const read by a call above it', () => {
  const v = analyse(units(
    'boot();\nconst CONFIG = { a: 1 };\nfunction boot() { return CONFIG.a; }'
  ));
  assert.equal(v.length, 1);
  assert.equal(v[0].name, 'CONFIG');
  assert.equal(v[0].callName, 'boot');
  assert.equal(v[0].readBy, 'boot');
});

test('flags it through an intermediate function, in another script', () => {
  // The real shape: the reader lives in a module file, the declaration in the
  // page's inline script, the call between them.
  const v = analyse(units(
    'boot();\nconst LATE = 1;\nfunction boot() { render(); }\n',
    'function render() { return LATE; }\n'
  ));
  assert.equal(v.length, 1);
  assert.equal(v[0].name, 'LATE');
  assert.equal(v[0].readBy, 'render');
});

test('does not flag a read that only happens after an await', () => {
  // A microtask resumes after the whole script has evaluated, so the
  // declaration below is initialised by then. Flagging this would be a false
  // positive on the app's most common shape (an async boot path).
  assert.deepEqual(analyse(units(
    'boot();\nconst LATE = 1;\nasync function boot() { await go(); return LATE; }\nfunction go() {}'
  )), []);
});

test('does not flag a read inside a try/catch guard', () => {
  // The documented workaround, and what cache-control.js relies on.
  assert.deepEqual(analyse(units(
    'boot();\nconst LATE = 1;\nfunction boot() { return read(); }\n' +
    'function read() { try { return LATE; } catch (e) { return null; } }'
  )), []);
});

test('a try/finally is NOT a guard', () => {
  // Finally has no catch, so the exception still escapes.
  const v = analyse(units(
    'boot();\nconst LATE = 1;\nfunction boot() { return read(); }\n' +
    'function read() { try { return LATE; } finally { done(); } }\nfunction done() {}'
  ));
  assert.equal(v.length, 1, 'expected the unguarded read to be reported');
  assert.equal(v[0].name, 'LATE');
});

test('does not flag a shadowed local of the same name', () => {
  assert.deepEqual(analyse(units(
    'boot();\nconst LATE = 1;\nfunction boot() { const LATE = 2; return LATE; }'
  )), []);
});

test('does not flag a callback handed to setTimeout', () => {
  assert.deepEqual(analyse(units(
    'boot();\nconst LATE = 1;\nfunction boot() { setTimeout(function () { use(LATE); }, 0); }\nfunction use(x) { return x; }'
  )), []);
});

test('flags a declaration in a script that has not loaded yet', () => {
  // Microtasks drain before the next script is evaluated, so an awaited path can
  // still arrive before a later script's const is initialised. The reader has to
  // be in the FIRST script for this to be reachable at all — a function defined
  // in the not-yet-loaded script would simply be undefined, which is a different
  // (and louder) bug.
  const v = analyse(units(
    'boot();\nasync function boot() { await go(); return use(); }\n' +
    'function go() {}\nfunction use() { return LATE; }\n',
    'const LATE = 2;\n'
  ));
  assert.equal(v.length, 1, 'expected the later-script declaration to be reported');
  assert.equal(v[0].name, 'LATE');
  assert.equal(v[0].readBy, 'use');
  assert.equal(v[0].declaredIn, 'script2');
});

test('does not flag a declaration that has already been initialised', () => {
  // The same chain, but the declaration lives in the FIRST script above the
  // call — the ordinary case, which must stay silent.
  assert.deepEqual(analyse(units(
    'const LATE = 2;\nboot();\nasync function boot() { await go(); return use(); }\n' +
    'function go() {}\nfunction use() { return LATE; }\n'
  )), []);
});

/* ==================================================================== *
   4. The scanner must never give up quietly.
 * ==================================================================== */

test('it throws rather than reporting "clean" when it cannot find scripts', () => {
  // "No violations" must always mean "checked", never "gave up": a loader that
  // returned an empty list would make the gate above pass vacuously.
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'netpulse-tdz-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<html><body>no scripts here</body></html>');
    assert.throws(() => loadScriptUnits(dir), /found no scripts/);
    assert.throws(() => loadScriptUnits(path.join(dir, 'does-not-exist')), /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every inline script in index.html is picked up, and only local srcs', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const inlineCount = (html.match(/<script(?![^>]*\bsrc=)[^>]*>/gi) || []).length;
  const loaded = appUnits.filter(u => u.name.startsWith('index.html'));
  assert.equal(
    loaded.length, inlineCount,
    'index.html has ' + inlineCount + ' inline scripts but ' + loaded.length + ' were analysed'
  );
  // CDN scripts have no local source and must be skipped, not crash the loader.
  assert.ok(html.includes('cdnjs'), 'expected a CDN script in index.html for this test to mean something');
  assert.ok(!appUnits.some(u => /^https?:/.test(u.name)), 'a CDN url was treated as a local file');
});
