// ==================== MODULE DIAGNOSTICS TESTS ====================
//
// Run: node tests/diagnostics.test.js
//
// Zero dependencies. Loads the REAL admin.gs, code.gs, olt-cache-warmer.gs and
// diagnostics.gs into a vm sandbox with stubbed Apps Script services, and checks the
// claims this feature is built on:
//
//   1. THE GATE IS A MEASUREMENT, NOT AN ARGUMENT. The verdict function is pure, so the
//      DECISION is tested here even though the sampling can only run inside Apps Script.
//      A whole-store read that is not a fraction of a build is a NO-GO, and the verdict is
//      taken on the pessimistic bound so an optimistic single read cannot carry it.
//      The calibration is pinned to the LIVE measurement (25 ms read, 51 ms write, 1.9% of a
//      cold build) rather than to absolute numbers someone liked: the first version compared
//      against 20 ms and 50 ms, and a healthy system failed it by one millisecond.
//   2. THE HOOKS SHIP OFF, and while they are off a successful build reads and writes
//      exactly as much as it did before diagnostics.gs existed — measured by running the
//      same build with and without the file, rather than by counting lines.
//   3. THE HOOKS FAIL SOFT AND LOUD. A recorder that throws cannot break a build, and a
//      call site whose file was never pasted says so in the log instead of going quietly
//      inert.
//   4. THE ROUTE IS A GATE AND A READ. No token, a null session and a non-admin token are
//      all refused; an admin gets a report that touched no sheet, wrote no cache and moved
//      no revision.
//
// On (3): the slow-build hook sits inside doGet, so a missing diagnostics.gs is a hook
// that is dead while the suite stays green. The last test in this file is the one that
// stops that: it asserts that the five suites which run a build LOAD this file.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

const ALL_FILES = ['admin.gs', 'code.gs', 'olt-cache-warmer.gs', 'diagnostics.gs'];

const KEY = {
  nap: 'cache_v2_nap',
  lcp: 'cache_v2_lcp',
  node: 'cache_v2_node',
  backbone: 'cache_v2_backbone',
  olt: 'cache_v2_olt_c3'
};
const TYPES = ['nap', 'lcp', 'olt', 'node', 'backbone'];

/* ------------------------------------------------------------------ *
   Apps Script service stubs
 * ------------------------------------------------------------------ */

/**
 * @param {Object} [opts]
 * @param {string[]} [opts.files]      which .gs files to load (default: all four)
 * @param {Object} [opts.cache]        pre-seeded CacheService entries
 * @param {Object} [opts.props]        pre-seeded script properties
 * @param {boolean} [opts.buildThrows] the spreadsheet handle throws (a failed build)
 * @param {boolean} [opts.propsThrow]  setProperty throws (a recorder that cannot write)
 */
function freshSandbox(opts) {
  opts = opts || {};
  const counters = { opens: 0, sheetReads: 0, cacheGets: 0, propReads: 0 };
  const store = Object.assign({}, opts.cache || {});
  const puts = [];
  const removed = [];
  const props = Object.assign({}, opts.props || {});
  const writes = [];
  const deleted = [];
  const logs = [];
  const keysRead = [];

  const sheet = {
    getLastRow: () => 0,
    getRange: (a, b, c, d) => ({
      getValues: () => {
        counters.sheetReads++;
        /* Numeric form (r, c, nr, nc) must answer nr rows; the string form ("G24:L39")
           answers one row of nothing, which every consuming loop skips. */
        const rows = (typeof c === 'number') ? Math.max(0, c) : 1;
        const cols = (typeof d === 'number') ? Math.max(0, d) : 1;
        const out = [];
        for (let i = 0; i < rows; i++) out.push(new Array(cols).fill(''));
        return out;
      }
    })
  };

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => {
        counters.opens++;
        if (opts.buildThrows) throw new Error('Sheets service temporarily unavailable');
        return { getSheetByName: () => sheet };
      }
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => {
          counters.cacheGets++;
          keysRead.push(k);
          return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
        },
        getAll: (ks) => {
          const out = {};
          ks.forEach((k) => {
            if (Object.prototype.hasOwnProperty.call(store, k)) out[k] = store[k];
          });
          return out;
        },
        put: (key, value, ttl) => { puts.push({ key, value, ttl }); store[key] = value; },
        remove: (key) => { removed.push(key); delete store[key]; }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => { counters.propReads++; return props[k] === undefined ? null : props[k]; },
        getProperties: () => {
          counters.propReads++;
          return Object.assign({}, props);
        },
        getKeys: () => Object.keys(props),
        setProperty: (k, v) => {
          if (opts.propsThrow) throw new Error('properties store unavailable');
          writes.push({ key: k, value: v });
          props[k] = v;
        },
        deleteProperty: (k) => { deleted.push(k); delete props[k]; }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({
        _text: text,
        setMimeType() { return this; },
        getContent() { return this._text; }
      })
    },
    Logger: { log: (m) => logs.push(String(m)) },
    Utilities: {
      formatDate: () => '01/01/2026 00:00:00',
      getUuid: () => 'uuid',
      computeDigest: () => [],
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' }
    },
    Session: { getScriptTimeZone: () => 'Asia/Manila' },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200 }) }
  };

  vm.createContext(sandbox);
  (opts.files || ALL_FILES).forEach((f) => {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  });

  sandbox.__puts = puts;
  sandbox.__removed = removed;
  sandbox.__writes = writes;
  /* An accessor, NOT writes.map(...) evaluated here. A snapshot taken at sandbox creation
     is always empty, which makes every "it wrote nothing" assertion vacuous — vacuous in
     exactly the direction that reads as a pass. The mutation pass caught that: removing a
     hook's own off-switch left the suite green. */
  Object.defineProperty(sandbox, '__propsWritten', {
    get: () => writes.map((w) => w.key),
    enumerable: true
  });
  sandbox.__deleted = deleted;
  sandbox.__props = props;
  sandbox.__logs = logs;
  sandbox.__keysRead = keysRead;
  sandbox.__counters = counters;
  return sandbox;
}

function jsonOf(output) {
  return JSON.parse(output.getContent());
}

/* A session token seeded the way issueSessionToken() stores one, so the real
   readSessionToken()/resolveSession() do the gating rather than a stub of them. */
function seededToken(s, token, role, msFromNow) {
  s.__props['session_' + token] = JSON.stringify({
    u: 'jeremy', name: 'Jeremy', role: role,
    exp: Date.now() + (msFromNow === undefined ? 3600000 : msFromNow)
  });
}

function repeated(value, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(value);
  return out;
}

function writesTo(s, key) {
  return s.__writes.filter((w) => w.key === key);
}

const NAP = () => ({ parameter: { type: 'nap' } });

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

console.log('\nModule diagnostics — the gate, the hooks and the route\n');

/* ------------------------------------------------------------------ *
   1. The gate: the decision is testable even where the sampling is not
 * ------------------------------------------------------------------ */

test('the numbers the LIVE project reported are a GO (25 ms read, 51 ms write)', () => {
  /* These are not invented. This is the first real run of measurePropertyCost(), on the live
     project, 2026-09-26:

         single getProperty   median 25ms  (worst 50ms)
         getProperties()      median 25ms  (worst 40ms)
         setProperty          median 51ms  (worst 134ms)

     That run came back NO-GO, because the thresholds it was compared against were absolute
     numbers I had picked (20 ms and 50 ms) rather than the claim the design rests on — and the
     verdict it printed said the measurement "is not a fraction of a build", which was false:
     25 ms against a 1290 ms build is 1.9%. Pinned here so the calibration cannot drift back to
     guessing: if a future edit makes these numbers fail, the gate has been mis-set again rather
     than the store having got slower.

     The second run, nine minutes later, is pinned just below — because two runs of the same
     instrument on the same idle store differed by 40%, and that spread is what the 5% ceiling
     was chosen to clear. */
  const s = freshSandbox();
  const v = s.judgePropertyCost_(repeated(25, 30), repeated(25, 30), repeated(51, 30));

  assert.strictEqual(v.go, true, 'the live measurement must pass: ' + v.reason);
  assert.strictEqual(v.verdict, 'GO');
  assert.strictEqual(v.readMs, 25, 'the median of the single reads');
  assert.strictEqual(v.readAllMs, 25, 'the median of the whole-store reads');
  assert.strictEqual(v.writeMs, 51, 'the median of the writes');
  assert.strictEqual(v.shareOfBuildPct, 1.9,
    '25 ms against the 1290 ms shortest build is 1.9% — the number the whole design rests on');
  assert.ok(v.reason.indexOf('1.9%') !== -1,
    'and the GO must state the share rather than "inside its thresholds": ' + v.reason);
  assert.ok(v.next.indexOf('set DIAG_REQUEST_HOOKS_ENABLED = true') === -1,
    'the verdict must not tell an operator to do what the shipped file already does: ' + v.next);
  assert.ok(v.next.indexOf('nothing to do') !== -1,
    'and it must say so plainly rather than just omitting the instruction: ' + v.next);
});

test('the second live run also passes', () => {
  /* Live run 2, 2026-09-26 12:42 AM, nine minutes after run 1, same store, same hour:

         single getProperty   median 35ms  (worst 58ms)
         getProperties()      median 35ms  (worst 52ms)
         setProperty          median 53ms  (worst 111ms)   -> 2.7% of a 1290ms build

     Every absolute number moved up; the single-read median moved 40%. The old absolute
     thresholds (20 ms read, 50 ms write) would have failed BOTH runs, by one millisecond and
     then by three. That is the recorded reason the verdict is a share with a write backstop
     instead of three invented ceilings. */
  const s = freshSandbox();
  const v = s.judgePropertyCost_(repeated(35, 30), repeated(35, 30), repeated(53, 30));

  assert.strictEqual(v.go, true, 'the second live run must also pass: ' + v.reason);
  assert.strictEqual(v.shareOfBuildPct, 2.7);
});

test('the third live run passes too, and it is the one the 5% ceiling must clear', () => {
  /* Live run 3, 2026-09-26 12:57 AM, fifteen minutes after run 2, same store, same hour:

         single getProperty   median 30ms  (worst 77ms)
         getProperties()      median 38ms  (worst 102ms)
         setProperty          median 54ms  (worst 119ms)   -> 2.9% of a 1290ms build

     THE TIGHTEST READING OF THE THREE, so this is where the calibration is pinned. Two things
     it settled, and the second one corrected a note I had already written:

       - the ceiling has to clear the worst thing the instrument has ever said, not the first
         reading it produced. 1.9 -> 2.7 -> 2.9 over twenty-five minutes is drift well inside
         the noise of a single run, and a limit set just above the first one would have fired
         on run 3 for no reason at all.
       - `getProperties()` came out DEARER than a single `getProperty` here (38 vs 30 median,
         102 vs 77 worst) after being level on the first two runs. The note claiming the two
         cost the same was wrong, and the verdict was already reading the pessimistic bound,
         which is the one that turned out to be the expensive one. */
  const s = freshSandbox();
  const v = s.judgePropertyCost_(repeated(30, 30), repeated(38, 30), repeated(54, 30));

  assert.strictEqual(v.go, true, 'the third live run must also pass: ' + v.reason);
  assert.strictEqual(v.shareOfBuildPct, 2.9);
  assert.strictEqual(v.maxSharePct, 5);

  /* A ratio, not a percentage-point gap: the claim being pinned is "the ceiling clears
     everything measured so far by at least half again", and THAT is the claim a future edit
     would break. Lowering the ceiling to 4% fails here (1.38x), which is the change worth
     catching — a gate that fires on a healthy store teaches its reader to ignore it. */
  const headroom = v.maxSharePct / v.shareOfBuildPct;
  assert.ok(headroom >= 1.5,
    'the ceiling must clear the worst live reading by at least half again, got ' +
    headroom.toFixed(2) + 'x (' + v.shareOfBuildPct + '% under a ' + v.maxSharePct + '% ceiling)');
});

test('the GO verdict on an unflipped copy still names the flip', () => {
  /* The other arm of the state-aware message. Without this, the branch that keeps the
     instruction honest is itself unobservable. */
  const s = freshSandbox();
  s.DIAG_REQUEST_HOOKS_ENABLED = false;
  const v = s.judgePropertyCost_(repeated(25, 30), repeated(25, 30), repeated(51, 30));

  assert.strictEqual(v.go, true);
  assert.ok(v.next.indexOf('DIAG_REQUEST_HOOKS_ENABLED = true') !== -1,
    'a copy that has not been flipped must still be told how to flip it: ' + v.next);
});

test('a write that costs half a build is a NO-GO even when the read is free', () => {
  /* The write backstop exists because a write has no share equivalent — it happens on a rare
     path rather than per read. It has to be able to fire ON ITS OWN, or it is a second message
     attached to the read's failure and nothing else. */
  const s = freshSandbox();
  const v = s.judgePropertyCost_(repeated(1, 30), repeated(1, 30), repeated(600, 30));

  assert.strictEqual(v.go, false, 'a 600 ms write against a 1290 ms build is not affordable');
  assert.ok(v.reason.indexOf('write median') !== -1, 'the reason must name the write: ' + v.reason);
  assert.ok(v.reason.indexOf('whole-store') === -1,
    'and only the write: the read was 1 ms, so naming it would be a lie about what failed');
});

test('a whole-store read that is NOT a fraction of a build is a NO-GO', () => {
  /* This is the assertion the whole feature hangs on. If a property read costs what a
     build costs, the hooks do not ship — the pass record and the report are the entire
     diagnostic — and the verdict has to say so in those words. */
  const s = freshSandbox();
  const v = s.judgePropertyCost_(repeated(4, 30), repeated(1200, 30), repeated(20, 30));

  assert.strictEqual(v.go, false, 'a 1200 ms read against a 1290 ms build is not a fraction');
  assert.strictEqual(v.verdict, 'NO-GO');
  assert.ok(v.reason.indexOf('whole-store') !== -1,
    'the reason must name the measurement that failed, got: ' + v.reason);
  assert.ok(v.next.indexOf('do NOT enable') !== -1,
    'and the next step must be explicit about not enabling the hooks: ' + v.next);
});

test('the verdict is taken on the PESSIMISTIC bound, so an optimistic read cannot carry it', () => {
  /* getProperty can be answered from an in-execution cache and understate the cost;
     getProperties() returns the whole store and cannot. A GO that rested on the cheap
     number would be a GO the evidence does not support. */
  const s = freshSandbox();
  const v = s.judgePropertyCost_(repeated(0, 30), repeated(200, 30), repeated(0, 30));

  assert.strictEqual(v.go, false,
    'free single reads must not carry a verdict when the whole-store read is 200 ms');
  assert.strictEqual(v.readMs, 0, 'the optimistic number is reported, not hidden');
  assert.strictEqual(v.readAllMs, 200, 'and the pessimistic one is what decided');
});

test('no samples at all is a NO-GO, not a GO', () => {
  /* An instrument that was never run must not read as a pass — the failure mode of every
     "assume the measurement succeeded" gate. */
  const s = freshSandbox();
  const v = s.judgePropertyCost_([], [], []);

  assert.strictEqual(v.go, false, 'an empty measurement is not evidence');
  assert.strictEqual(v.samples, 0);
});

test('a read that was never measured cannot be carried by a write that was', () => {
  /* The case the test above cannot reach, and the one the null-share branch exists for.
     With all three empty, an unmeasured WRITE fails its own backstop and the verdict lands on
     NO-GO anyway — so it proves nothing about the read. Measured reads and writes with an
     UNMEASURED whole-store read is the shape that would otherwise read as a pass, because
     `null > 5` is false: a gate reporting GO on the strength of a measurement it never took. */
  const s = freshSandbox();
  const v = s.judgePropertyCost_(repeated(5, 30), [], repeated(5, 30));

  assert.strictEqual(v.go, false, 'an unmeasured read is not a measured one');
  assert.strictEqual(v.shareOfBuildPct, null, 'and there is no share to report');
  assert.ok(v.reason.indexOf('no whole-store read was measured') !== -1,
    'the reason must say which measurement is missing: ' + v.reason);
  assert.ok(v.reason.indexOf('write') === -1,
    'and must not blame the write, which was measured and is fine');
});

test('the gate compares against the SHORTEST measured build, not an average', () => {
  /* 1290 ms is lcp in the warm-pass log — the floor of a cold build. Using an average, or
     the heaviest module, would make the gate easier to pass than the data justifies. */
  const s = freshSandbox();
  assert.ok(s.DIAG_GATE_BUILD_MS > 0 && s.DIAG_GATE_BUILD_MS <= 1290,
    'DIAG_GATE_BUILD_MS is ' + s.DIAG_GATE_BUILD_MS + 'ms; the shortest measured module ' +
    'build is 1290ms, and raising this number is how a gate stops being one');
});

test('measurePropertyCost() prints a verdict, and leaves the property store as it found it', () => {
  const s = freshSandbox();
  const v = s.measurePropertyCost();

  assert.ok(v && v.verdict, 'measurePropertyCost must return the verdict it logged');
  assert.ok(s.__logs.some((l) => l.indexOf('GATE') !== -1),
    'the verdict must be one line an operator cannot miss');
  assert.ok(s.__logs.some((l) => l.indexOf('PESSIMISTIC') !== -1),
    'and it must say which bound decided, or the two numbers look interchangeable');

  assert.strictEqual(s.__props['diag_gate_probe'], undefined,
    'the probe key must be deleted: an instrument that leaves litter in the property store ' +
    'is a quota problem with no owner');

  /* It obviously writes its own probe — that is what it measures. What it must not do is
     write a DIAG record: the gate is an instrument, and an instrument that records its own
     reading on every run is a monitor. Filtering the probe rather than asserting "wrote
     nothing at all" is the difference between a claim that can fail and one that cannot. */
  const records = s.__propsWritten.filter((k) => k !== 'diag_gate_probe');
  assert.deepStrictEqual(records, [],
    'measurePropertyCost wrote a record: ' + records.join(', '));
});

/* ------------------------------------------------------------------ *
   2. The hooks ship on — because the gate said GO — and cost nothing
 * ------------------------------------------------------------------ */

test('the request-path hooks ship ON, and the reason is recorded where an operator reads it', () => {
  /* They shipped off while the gate was unrun and then uncalibrated. It has now been run on
     the live project three times in one hour: 1.9%, 2.7% and 2.9% of a 1290 ms cold build, against
     a 5% ceiling. Flipping this constant back to `false` is a supported move — the tests below
     cover the off path explicitly — but it must be a decision, not a drive-by. */
  const s = freshSandbox();

  assert.strictEqual(s.DIAG_REQUEST_HOOKS_ENABLED, true,
    'the live gate said GO twice; the hooks must ship on');
  assert.strictEqual(s.diagStatus_().requestHooks, 'on');
  assert.ok(s.diagStatus_().note.indexOf('1.9%') !== -1,
    'the report must carry the measurement the switch was flipped on, not just a state');
  assert.ok(s.diagStatus_().note.indexOf('2.7%') !== -1,
    'and every reading, because the spread between them is what set the 5% ceiling');
  assert.ok(s.diagStatus_().note.indexOf('2.9%') !== -1,
    'including the worst of the three — the one the ceiling exists to clear');
});

test('a successful build writes NO property at all', () => {
  /* The cost model in one assertion. The reverted version of this feature recorded a
     sample after every successful build: one property read plus one write on the coldest
     path in the app. There is now nothing to write there. */
  TYPES.forEach((t) => {
    const s = freshSandbox();
    const event = { parameter: { type: t } };
    if (t === 'olt') event.parameter.shape = '3';
    s.doGet(event);

    assert.deepStrictEqual(s.__propsWritten, [],
      t + ' wrote a property on its success path: ' + s.__propsWritten.join(', '));
  });
});

test('a successful build costs the same reads with diagnostics deployed as without', () => {
  /* Measured, not argued: run the identical build twice, once with diagnostics.gs loaded
     and once without, and compare the property service counters. This is the claim the
     whole cost model rests on, so it is checked by observation rather than by reading the
     hook and concluding that it looks cheap. */
  TYPES.forEach((t) => {
    const event = { parameter: { type: t } };
    if (t === 'olt') event.parameter.shape = '3';

    const withDiag = freshSandbox();
    withDiag.doGet(event);

    const without = freshSandbox({ files: ['admin.gs', 'code.gs', 'olt-cache-warmer.gs'] });
    without.doGet(event);

    assert.strictEqual(withDiag.__counters.propReads, without.__counters.propReads,
      t + ': ' + withDiag.__counters.propReads + ' property reads with diagnostics.gs vs ' +
      without.__counters.propReads + ' without — the hook is not free');
    assert.strictEqual(withDiag.__counters.opens, without.__counters.opens,
      t + ': the diagnostics changed how many times the spreadsheet was opened');
  });
});

test('a fast build writes no property on the success path, even with the hooks ON', () => {
  /* The threshold is DIAG_SLOW_BUILD_MS and a healthy build is far under it, so the slow
     hook is one integer comparison. Two ways to state that; this is the behavioural one. */
  const s = freshSandbox();
  s.DIAG_REQUEST_HOOKS_ENABLED = true;
  s.doGet(NAP());

  assert.deepStrictEqual(s.__propsWritten, [],
    'a fast build must write nothing even with the hooks ON: ' + s.__propsWritten.join(', '));
});

/* ------------------------------------------------------------------ *
   3. Failures, recorded
 * ------------------------------------------------------------------ */

test('with the hooks off, a failed build writes nothing and still answers the envelope', () => {
  const s = freshSandbox({ buildThrows: true });
  s.DIAG_REQUEST_HOOKS_ENABLED = false;
  const res = jsonOf(s.doGet(NAP()));

  assert.strictEqual(res.error, 'build_failed', 'the caller must still get its envelope');
  assert.strictEqual(res.retryable, true, 'and it must still be retryable');
  assert.deepStrictEqual(s.__propsWritten, [], 'but nothing may be recorded');
});

test('with the hooks on, a failed build records type, stage, sheet, rev and elapsed ms', () => {
  const s = freshSandbox({ buildThrows: true });
  s.DIAG_REQUEST_HOOKS_ENABLED = true;
  jsonOf(s.doGet(NAP()));

  const records = writesTo(s, s.DIAG_FAILURES_KEY);
  assert.strictEqual(records.length, 1, 'exactly one write per failure');

  const list = JSON.parse(records[0].value);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].type, 'nap');
  assert.strictEqual(list[0].stage, 'spreadsheet',
    'the stage the build died at is the whole point — "a build failed" is not a finding');
  assert.strictEqual(list[0].sheet, '');
  assert.ok(list[0].ms >= 0, 'and how long it had been running');
  assert.ok(list[0].at > 0, 'and when');
  assert.ok(list[0].message.indexOf('Sheets service') !== -1, 'and what broke');
});

test('two failures are both kept, newest first', () => {
  const s = freshSandbox();
  s.DIAG_REQUEST_HOOKS_ENABLED = true;

  s.recordBuildFailure_('nap', { message: 'first', stage: 'nap', sheet: 'NLZ NAP Report' });
  s.recordBuildFailure_('backbone', { message: 'second', stage: 'backbone', sheet: 'Backbone Tickets' });

  const list = JSON.parse(s.__props[s.DIAG_FAILURES_KEY]);
  assert.strictEqual(list.length, 2, 'one failure must not overwrite the other');
  assert.strictEqual(list[0].type, 'backbone', 'newest first');
  assert.strictEqual(list[1].type, 'nap');
});

test('the failure history is capped at the number the report claims', () => {
  const s = freshSandbox();
  s.DIAG_REQUEST_HOOKS_ENABLED = true;

  for (let i = 0; i < s.DIAG_FAILURES_MAX + 3; i++) {
    s.recordBuildFailure_('type' + i, { message: 'm' + i });
  }

  const list = JSON.parse(s.__props[s.DIAG_FAILURES_KEY]);
  assert.strictEqual(list.length, s.DIAG_FAILURES_MAX,
    'an unbounded history is a property that grows until it is a quota problem');
  assert.strictEqual(list[0].type, 'type' + (s.DIAG_FAILURES_MAX + 2), 'and it keeps the newest');
});

test('a slow build is recorded with NO property read', () => {
  /* The one place in the design where a read would have been legitimate and was designed
     out: the record is a single overwritten slot, so writing it needs no history. */
  const s = freshSandbox();
  s.DIAG_REQUEST_HOOKS_ENABLED = true;
  s.__counters.propReads = 0;

  const wrote = s.recordSlowBuild_('backbone', 9000, 'backbone', 'Backbone Tickets');

  assert.strictEqual(wrote, true, 'a 9000 ms build is over the threshold and must be kept');
  assert.strictEqual(s.__counters.propReads, 0,
    'the slow path read the property store ' + s.__counters.propReads + ' time(s)');
  const rec = JSON.parse(s.__props[s.DIAG_SLOW_KEY]);
  assert.strictEqual(rec.type, 'backbone');
  assert.strictEqual(rec.ms, 9000);
  assert.strictEqual(rec.sheet, 'Backbone Tickets');
});

test('a build under the threshold is not recorded', () => {
  const s = freshSandbox();
  s.DIAG_REQUEST_HOOKS_ENABLED = true;

  assert.strictEqual(s.recordSlowBuild_('lcp', 1290, 'lcp', 'NLZ LCP Report'), false,
    'a healthy build must cost a comparison and nothing else');
  assert.strictEqual(s.__props[s.DIAG_SLOW_KEY], undefined);
});

test('a slow build is recorded by the hook inside doGet, with the stage it came from', () => {
  const s = freshSandbox();
  s.DIAG_REQUEST_HOOKS_ENABLED = true;
  s.DIAG_SLOW_BUILD_MS = -1;            // every build now counts as slow
  s.doGet(NAP());

  const rec = JSON.parse(s.__props[s.DIAG_SLOW_KEY] || 'null');
  assert.ok(rec, 'the hook must actually run: it is the only line of this feature on every build');
  assert.strictEqual(rec.type, 'nap');
  assert.strictEqual(rec.stage, 'nap', 'the stage comes from buildCtx_, not from the caller');
  assert.strictEqual(rec.sheet, 'NLZ NAP Report',
    'and the sheet — "which read was slow" is the question this file exists to answer');
});

test('a cache HIT never reaches the slow-build hook', () => {
  /* Every end-of-build hook is paid only on a MISS, which is why they are allowed to exist
     at all. Asserted on the one observable that distinguishes them: a hit does not open
     the spreadsheet. */
  const s = freshSandbox({ cache: { [KEY.lcp]: JSON.stringify([{ A: 'cached' }]) } });
  s.DIAG_REQUEST_HOOKS_ENABLED = true;
  s.DIAG_SLOW_BUILD_MS = -1;

  s.doGet({ parameter: { type: 'lcp' } });

  assert.strictEqual(s.__counters.opens, 0, 'the hit path must not build');
  assert.strictEqual(s.__props[s.DIAG_SLOW_KEY], undefined,
    'and must not reach the hook either');
});

test('a recorder that cannot write does not break the build', () => {
  /* Both recorders run inside doGet, on the path whose entire job is to answer. A
     diagnostics failure that turns into an HTML error page would be worse than no
     diagnostics. */
  const s = freshSandbox({ buildThrows: true, propsThrow: true });
  s.DIAG_REQUEST_HOOKS_ENABLED = true;

  const res = jsonOf(s.doGet(NAP()));

  assert.strictEqual(res.error, 'build_failed', 'the caller still gets its envelope');
  assert.strictEqual(res.retryable, true);
  assert.ok(s.__logs.some((l) => l.indexOf('recordBuildFailure_ could not write') !== -1),
    'and the recorder says it failed rather than pretending');
});

test('a slow recorder that cannot write does not break the build either', () => {
  const s = freshSandbox({ propsThrow: true });
  s.DIAG_REQUEST_HOOKS_ENABLED = true;
  s.DIAG_SLOW_BUILD_MS = -1;

  const out = s.doGet(NAP());
  assert.ok(out.getContent().indexOf('error') === -1,
    'a healthy payload must still come back: ' + out.getContent().slice(0, 80));
  assert.ok(s.__logs.some((l) => l.indexOf('recordSlowBuild_ could not write') !== -1));
});

test('a call site whose file was never pasted SAYS SO instead of going quietly inert', () => {
  /* code.gs and diagnostics.gs are two separate pastes. Forgetting the second must not
     take the dashboard down, and it must not silently disable diagnostics either — that
     is the failure this project keeps having to hunt. */
  const s = freshSandbox({ files: ['admin.gs', 'code.gs', 'olt-cache-warmer.gs'] });
  const out = s.doGet(NAP());

  assert.ok(out.getContent().indexOf('error') === -1, 'the build still answers');
  assert.ok(s.__logs.some((l) => l.indexOf('diagnostics.gs is not deployed') !== -1),
    'and the log names the missing file');

  /* The FAILURE call site is a separate guard, on a path that is already in a catch block.
     Without it, an unguarded call to a function that is not deployed throws a ReferenceError
     out of doGet — which Apps Script turns into an HTML error page, on the one path whose
     entire job is to answer with an envelope. */
  const f = freshSandbox({ files: ['admin.gs', 'code.gs', 'olt-cache-warmer.gs'], buildThrows: true });
  const failed = jsonOf(f.doGet(NAP()));

  assert.strictEqual(failed.error, 'build_failed',
    'a failed build must still get its envelope when the recorder is not deployed');
  assert.strictEqual(failed.retryable, true);
  assert.ok(f.__logs.some((l) => l.indexOf('logged but not recorded') !== -1),
    'and it must say the failure went unrecorded, not let a missing paste look like "no failures"');
});

test('that warning is said once per execution, not once per build', () => {
  const s = freshSandbox({ files: ['admin.gs', 'code.gs', 'olt-cache-warmer.gs'] });
  TYPES.forEach((t) => {
    const event = { parameter: { type: t } };
    if (t === 'olt') event.parameter.shape = '3';
    s.doGet(event);
  });

  const warnings = s.__logs.filter((l) => l.indexOf('slow-build hook is inert') !== -1);
  assert.strictEqual(warnings.length, 1,
    'five builds in one execution produced ' + warnings.length + ' warnings — a warning ' +
    'repeated on every build is a warning nobody reads');
});

/* ------------------------------------------------------------------ *
   4. The warm pass record — the instrument the TTL decision came from
 * ------------------------------------------------------------------ */

test('warmDataCaches records one pass, with every module\'s build time', () => {
  const s = freshSandbox();
  s.warmDataCaches();

  const records = writesTo(s, s.DIAG_PASS_KEY);
  assert.strictEqual(records.length, 1, 'one write per pass, not one per module');

  const pass = JSON.parse(records[0].value);
  assert.strictEqual(pass.built, 5, 'all five should have rebuilt against an empty cache');
  assert.strictEqual(pass.of, 5);
  assert.deepStrictEqual(pass.failed, []);
  TYPES.forEach((t) => {
    assert.ok(typeof pass.ms[t] === 'number' && pass.ms[t] >= 0,
      t + ' has no build time in the pass record — this is the only place it is ever measured');
  });
  assert.ok(pass.totalMs >= 0 && pass.at > 0, 'and the pass itself is timed');
});

test('the pass record is written even with the request-path hooks off', () => {
  /* Not an oversight: this runs in the trigger's own execution, costs the request path
     nothing, and is the evidence the TTL decision was made from. Gating it behind the
     request-path switch would hide the number the switch is waiting for.

     Run twice, with the switch in both positions: the claim is that the recorder is
     independent of the switch, so a single run could not distinguish "not gated" from
     "happened to be on". */
  [false, true].forEach((enabled) => {
    const s = freshSandbox();
    s.DIAG_REQUEST_HOOKS_ENABLED = enabled;
    s.warmDataCaches();

    assert.strictEqual(writesTo(s, s.DIAG_PASS_KEY).length, 1,
      'the pass was not recorded with the request-path hooks ' + (enabled ? 'on' : 'off') +
      ' — the pass record is gated behind a switch it has nothing to do with');
  });
});

test('a pass whose diagnostic file is missing still finishes and says so', () => {
  const s = freshSandbox({ files: ['admin.gs', 'code.gs', 'olt-cache-warmer.gs'] });
  s.warmDataCaches();

  assert.ok(s.__logs.some((l) => l.indexOf('pass was logged but not recorded') !== -1),
    'the pass must name the file it could not write to');
  assert.ok(s.__logs.some((l) => l.indexOf('5 of 5 module(s) rebuilt') !== -1),
    'and must still report the pass it actually ran');
});

/* ------------------------------------------------------------------ *
   5. The route: a gate, and a read
 * ------------------------------------------------------------------ */

test('no token and no session is refused', () => {
  /* With REQUIRE_SESSION true this never happens; with it false — phase 1 of the token
     rollout — resolveSession answers {session:null, error:null} and a role check that
     dereferences a null session is not a gate at all. Flipped here on purpose. */
  const s = freshSandbox();
  s.REQUIRE_SESSION = false;

  const res = jsonOf(s.doGet({ parameter: { action: 'diag' } }));

  assert.strictEqual(res.unauthorized, true, 'an untokened caller must be refused');
  assert.strictEqual(res.cache, undefined, 'and must learn nothing about the internals');
  assert.strictEqual(res.warm, undefined);
});

test('a valid NON-admin token is refused, and sees none of the report', () => {
  const s = freshSandbox();
  seededToken(s, 'user-token', 'Tech');

  const res = jsonOf(s.doGet({ parameter: { action: 'diag', token: 'user-token' } }));

  assert.strictEqual(res.unauthorized, true, 'the role check must run');
  assert.strictEqual(res.status, undefined, 'and the body must carry no internals');
  assert.strictEqual(res.failures, undefined);
});

test('an unknown or expired token is refused', () => {
  const s = freshSandbox();
  seededToken(s, 'stale', 'Tech admin/Dev', -60000);   // expired a minute ago

  assert.strictEqual(jsonOf(s.doGet({ parameter: { action: 'diag', token: 'stale' } })).unauthorized,
    true, 'an expired admin token is not an admin');
  assert.strictEqual(jsonOf(s.doGet({ parameter: { action: 'diag', token: 'nope' } })).unauthorized,
    true, 'and neither is an unknown one');
});

test('an admin token gets the report', () => {
  const s = freshSandbox();
  seededToken(s, 'admin-token', s.ADMIN_ROLE);

  const res = jsonOf(s.doGet({ parameter: { action: 'diag', token: 'admin-token' } }));

  assert.strictEqual(res.ok, true, 'expected the report, got: ' + JSON.stringify(res).slice(0, 120));
  assert.ok(res.status, 'with the state of the hooks in it');
  assert.ok(res.cache, 'and the cache state');
  assert.ok(res.rev, 'and the revisions');
  assert.ok(Array.isArray(res.failures), 'and the failure history');
});

test('the report is a READ: no sheet opened, no cache written, no revision moved', () => {
  const s = freshSandbox({ cache: { [KEY.nap]: JSON.stringify([{ A: 'x' }]) } });
  seededToken(s, 'admin-token', s.ADMIN_ROLE);
  s.__counters.opens = 0;

  jsonOf(s.doGet({ parameter: { action: 'diag', token: 'admin-token' } }));

  assert.strictEqual(s.__counters.opens, 0,
    'asking what is slow must be incapable of starting a build');
  assert.deepStrictEqual(s.__puts, [], 'and must write no cache entry');
  assert.deepStrictEqual(s.__removed, [], 'and remove none');
  assert.deepStrictEqual(s.__propsWritten.filter((k) => k.indexOf('data_rev_') === 0), [],
    'and must not move a revision');
  assert.deepStrictEqual(s.__propsWritten, [], 'and must not write a property at all');
});

test('the report says what each module\'s cache is holding, rows and bytes included', () => {
  /* A module can be cached and EMPTY. An empty payload behind a green warm log line is the
     shape of every silent failure this project has had, so the report answers it directly. */
  const s = freshSandbox({
    cache: {
      [KEY.nap]: JSON.stringify([{ A: 'x' }, { A: 'y' }]),
      [KEY.olt]: JSON.stringify({ v: 3, f: [], m: [], p: [], r: [{}, {}, {}], meta: { builtAt: 1 } })
    }
  });
  seededToken(s, 'admin-token', s.ADMIN_ROLE);

  const res = jsonOf(s.doGet({ parameter: { action: 'diag', token: 'admin-token' } }));

  assert.strictEqual(res.cache.nap.present, true);
  assert.strictEqual(res.cache.nap.rows, 2, 'two rows in the cache');
  assert.ok(res.cache.nap.bytes > 0, 'and how many bytes');
  assert.strictEqual(res.cache.olt.key, 'cache_v2_olt_c3', 'OLT is read in the shape the app reads');
  assert.strictEqual(res.cache.olt.rows, 3, 'the compact envelope\'s row count');
  assert.strictEqual(res.cache.node.present, false, 'and a cold module says so');
});

test('the report states the TTL arithmetic, and would have caught the 180 s bug', () => {
  const s = freshSandbox();
  seededToken(s, 'admin-token', s.ADMIN_ROLE);
  const req = { parameter: { action: 'diag', token: 'admin-token' } };

  const healthy = jsonOf(s.doGet(req)).warm;
  assert.strictEqual(healthy.intervalSeconds, 300);
  assert.strictEqual(healthy.ttlSeconds, 330);
  assert.ok(healthy.deadWindowSeconds <= 0, 'the current constants leave no cold window');
  assert.ok(healthy.verdict.indexOf('no cold window') !== -1, healthy.verdict);

  /* Now the release that shipped 180 s under the same interval. The report has to say what
     that costs, in seconds, without anyone recomputing it — the arithmetic that made 40% of
     every cycle cold and was nowhere written down. */
  s.OLT_WARM_TTL_SECONDS = 180;
  const broken = jsonOf(s.doGet(req)).warm;
  assert.strictEqual(broken.deadWindowSeconds, 120);
  assert.ok(broken.verdict.indexOf('COLD WINDOW') !== -1,
    'the report must name the cold window rather than let a reader subtract two numbers');
  assert.ok(broken.verdict.indexOf('120') !== -1, 'and give its size in seconds');
});

test('an unparseable cached payload is reported as bytes, not as absent', () => {
  const s = freshSandbox({ cache: { [KEY.lcp]: 'not json{' } });
  seededToken(s, 'admin-token', s.ADMIN_ROLE);

  const res = jsonOf(s.doGet({ parameter: { action: 'diag', token: 'admin-token' } }));

  assert.strictEqual(res.cache.lcp.present, true, '26 KB of non-JSON is a finding, not a blind spot');
  assert.strictEqual(res.cache.lcp.rows, null, 'but it has no knowable row count');
});

test('a property-backed entry is reported with its age, and as expired when it is', () => {
  const s = freshSandbox({
    props: {
      [KEY.node]: JSON.stringify([{ D: 'BENGUET' }]),
      [KEY.node + '_cached_at']: String(Date.now() - 400 * 1000)   // past the 60 s TTL
    }
  });
  seededToken(s, 'admin-token', s.ADMIN_ROLE);

  const res = jsonOf(s.doGet({ parameter: { action: 'diag', token: 'admin-token' } })).cache.node;

  assert.strictEqual(res.source, 'property');
  assert.strictEqual(res.expired, true,
    'a cached-but-expired entry is exactly the state the request path refuses to serve');
  assert.ok(res.ageSeconds >= 400, 'and its age is reported, not inferred');
});

test('the route answers diagnostics_unavailable rather than an error page when its file is absent', () => {
  const s = freshSandbox({ files: ['admin.gs', 'code.gs'] });
  seededToken(s, 'admin-token', s.ADMIN_ROLE);

  const res = jsonOf(s.doGet({ parameter: { action: 'diag', token: 'admin-token' } }));

  assert.strictEqual(res.error, 'diagnostics_unavailable');
  assert.strictEqual(res.retryable, false, 'and it is not worth retrying until it is pasted');
});

/* ------------------------------------------------------------------ *
   6. The load line — the thing that keeps the hook above from being dead but green
 * ------------------------------------------------------------------ */

test('every suite that runs a build also loads diagnostics.gs', () => {
  /* The slow-build hook sits inside doGet. A suite that loads code.gs WITHOUT
     diagnostics.gs therefore exercises a hook that is inert, and stays green while it is —
     the same silent-lie shape as the 74-byte "warmed" line this project already fixed
     once. A convention is not enough here, so it is an assertion. */
  const runners = [
    'cache-invalidation', 'cache-warmer', 'olt-impact', 'olt-warm-ttl', 'origin-resilience'
  ];

  runners.forEach((name) => {
    const src = fs.readFileSync(path.join(ROOT, 'tests', name + '.test.js'), 'utf8');
    assert.ok(src.indexOf('diagnostics.gs') !== -1,
      'tests/' + name + '.test.js runs a build but does not load diagnostics.gs, so the ' +
      'slow-build hook is dead in it and the suite is green about a hook that never ran');
  });
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
