// ==================== TRIGGER SETUP TESTS ====================
//
// Run: node tests/triggers.test.js
//
// Zero dependencies. Loads the real triggers.gs into a vm sandbox with a stubbed
// ScriptApp, and checks the three things that matter about this file:
//
//   1. A bad plan is a NO-OP, not an outage. removeAllTriggers() runs first in
//      the real flow, so a missing handler must abort BEFORE anything is
//      deleted. This is the bug that left the project with fewer triggers than
//      it started with.
//   2. The schedule in TRIGGER_PLAN is the documented one, and cannot drift
//      silently.
//   3. processAllNodeDownRows stays out of the plan. It was deleted from the
//      codebase in v3.5.0 (its extraction became a sheet formula) while its
//      trigger entry survived and broke setup — so its absence is a regression
//      guard, not a detail.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* The schedule this file is supposed to declare. Kept next to the assertions so
   a change to the plan has to be a deliberate change here too. */
const EXPECTED_PLAN = [
  { fn: 'updateAgingDurationStatic', cadence: 'everyMinutes(15)' },
  /* Was warmOltCache. The warmer now rebuilds all five modules in one execution, and
     this entry is the only written record of that cadence, so the rename is the plan
     change — not a detail of how the function happens to be named in code. */
  { fn: 'warmDataCaches',            cadence: 'everyMinutes(5)' },
  { fn: 'updateAgingDurationColP',   cadence: 'everyMinutes(30)' },
  { fn: 'processBackboneTickets',    cadence: 'everyHours(1)' },
  { fn: 'autoExportSheetToExcel',    cadence: 'atHour(6)+everyDays(1)+tz(Asia/Manila)' },
  /* The two event-driven handlers: what makes an edit show up in seconds
     instead of at the next warm cadence. They are part of the plan for the same
     reason everything else is — the Apps Script UI shows the event type but not
     the cadence, so this table is the only record of what is supposed to exist. */
  { fn: 'handleSheetEdit',           cadence: 'forSpreadsheet+onEdit()' },
  { fn: 'handleSheetChange',         cadence: 'forSpreadsheet+onChange()' }
];

const ALL_HANDLERS = EXPECTED_PLAN.map((e) => e.fn);

/* What each planned handler should be installed AS, read from the plan itself so
   the drift tests cannot disagree with triggers.gs about it. */
function expectedEventTypes(sandbox) {
  const byFn = {};
  sandbox.TRIGGER_PLAN.forEach((entry) => {
    byFn[entry.fn] = sandbox.triggerPlanEventType_(entry.event);
  });
  return byFn;
}

/* A builder that records the schedule calls made on it, so a plan entry's
   `apply` can be run without Apps Script. It carries BOTH chains — a clock
   trigger goes through timeBased(), an installable spreadsheet trigger through
   forSpreadsheet() — because TRIGGER_PLAN now holds one of each and a recorder
   that only understood clocks would silently mis-report the other kind. */
function recordingBuilder(spec, onCreate) {
  const b = {
    timeBased() { return b; },
    everyMinutes(n) { spec.push('everyMinutes(' + n + ')'); return b; },
    everyHours(n)   { spec.push('everyHours(' + n + ')');   return b; },
    atHour(n)       { spec.push('atHour(' + n + ')');       return b; },
    everyDays(n)    { spec.push('everyDays(' + n + ')');    return b; },
    inTimezone(tz)  { spec.push('tz(' + tz + ')');          return b; },
    forSpreadsheet(ss) {
      spec.push('forSpreadsheet');
      assert.ok(ss, 'forSpreadsheet() needs the spreadsheet object');
      return b;
    },
    onEdit()   { spec.push('onEdit()');   return b; },
    onChange() { spec.push('onChange()'); return b; },
    create()   { if (onCreate) onCreate(spec); return b; }
  };
  return b;
}

/* ------------------------------------------------------------------ *
   Sandbox
   ------------------------------------------------------------------ *
   opts.handlers  handler functions to define (default: all five)
   opts.live      handler names currently installed as triggers
 */
function freshSandbox(opts) {
  opts = opts || {};
  const handlers = opts.handlers || ALL_HANDLERS;
  const created = [];
  const deleted = [];
  // Accept a bare name (time-driven, the normal case) or { fn, type } to model
  // a trigger installed on the wrong event type.
  let live = (opts.live || []).map((item) => {
    const fn = typeof item === 'string' ? item : item.fn;
    const type = typeof item === 'string' ? 'CLOCK' : (item.type || 'CLOCK');
    return { getHandlerFunction: () => fn, getEventType: () => type };
  });
  const logs = [];

  const sandbox = {
    console,
    Logger: { log: (m) => logs.push(String(m)) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ __spreadsheet: true })
    },
    ScriptApp: {
      EventType: { CLOCK: 'CLOCK', ON_EDIT: 'ON_EDIT', ON_CHANGE: 'ON_CHANGE' },
      newTrigger: (fn) => {
        const spec = [];
        // The plan's apply() receives this and returns a configured builder;
        // .create() is called on whatever comes back.
        return recordingBuilder(spec, () => {
          created.push({
            fn,
            cadence: spec.join('+'),
            type: spec.indexOf('onEdit()') !== -1 ? 'ON_EDIT'
                : spec.indexOf('onChange()') !== -1 ? 'ON_CHANGE'
                : 'CLOCK'
          });
        });
      },
      getProjectTriggers: () => live.slice(),
      deleteTrigger: (t) => {
        deleted.push(t.getHandlerFunction());
        live = live.filter((x) => x !== t);
      }
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'triggers.gs'), 'utf8'), sandbox, { filename: 'triggers.gs' });

  // Defined AFTER loading triggers.gs so they land on the same global the
  // handler lookup reads (globalThis inside the context IS this object).
  handlers.forEach((fn) => { sandbox[fn] = function () {}; });

  sandbox.__created = created;
  sandbox.__deleted = deleted;
  sandbox.__logs = logs;
  return sandbox;
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

console.log('\nTrigger setup\n');

/* ------------------------------------------------------------------ *
   The safety property
 * ------------------------------------------------------------------ */

test('a missing handler aborts WITHOUT deleting any live trigger', () => {
  const s = freshSandbox({
    handlers: ALL_HANDLERS.filter((f) => f !== 'warmDataCaches'),
    live: ['updateAgingDurationStatic', 'processBackboneTickets']   // real ones, must survive
  });

  s.setupAllTriggers();

  assert.deepStrictEqual(s.__deleted, [],
    'nothing may be removed when the plan cannot be satisfied');
  assert.deepStrictEqual(s.__created, [],
    'nothing may be created when the plan cannot be satisfied');
  assert.ok(s.__logs.some((l) => l.indexOf('warmDataCaches') !== -1),
    'the missing handler should be named in the log');
  assert.ok(s.__logs.some((l) => l.indexOf('NOTHING was removed') !== -1),
    'the log should say plainly that nothing was removed');
});

test('an entirely missing plan is still a no-op', () => {
  const s = freshSandbox({ handlers: [], live: ['keepMe'] });
  s.setupAllTriggers();
  assert.deepStrictEqual(s.__deleted, []);
  assert.deepStrictEqual(s.__created, []);
});

test('every live trigger is deleted only once the plan validates', () => {
  const s = freshSandbox({ live: ['legacyThing', 'updateAgingDurationStatic'] });
  s.setupAllTriggers();
  assert.deepStrictEqual(s.__deleted.sort(), ['legacyThing', 'updateAgingDurationStatic'],
    'validation passed, so the old set should be replaced');
  assert.strictEqual(s.__created.length, EXPECTED_PLAN.length);
});

/* ------------------------------------------------------------------ *
   The plan is the documented schedule
 * ------------------------------------------------------------------ */

test('TRIGGER_PLAN matches the documented schedule exactly', () => {
  const s = freshSandbox();
  const actual = s.TRIGGER_PLAN.map((e) => {
    const spec = [];
    e.apply(recordingBuilder(spec));
    return { fn: e.fn, cadence: spec.join('+') };
  });
  // JSON, not deepStrictEqual: TRIGGER_PLAN comes from the vm realm, so its
  // arrays carry that realm's prototype and a strict compare fails on identity
  // rather than on content.
  assert.strictEqual(JSON.stringify(actual), JSON.stringify(EXPECTED_PLAN));
});

test('setupAllTriggers creates exactly the planned triggers with their cadences', () => {
  const s = freshSandbox();
  s.setupAllTriggers();
  const actual = s.__created.map((c) => ({ fn: c.fn, cadence: c.cadence }));
  assert.deepStrictEqual(actual, EXPECTED_PLAN);
  assert.ok(s.__logs.some((l) => l.indexOf('All ' + EXPECTED_PLAN.length + ' triggers created') !== -1));
});

test('the plan installs each handler under the event type it declares', () => {
  const s = freshSandbox();
  s.setupAllTriggers();
  const expected = expectedEventTypes(s);
  s.__created.forEach((c) => {
    assert.strictEqual(c.type, expected[c.fn],
      c.fn + ' was installed as ' + c.type + ' but the plan declares ' + expected[c.fn]);
  });
});

/* ------------------------------------------------------------------ *
   The regression guard
 * ------------------------------------------------------------------ */

test('processAllNodeDownRows is NOT in the plan (its function no longer exists)', () => {
  const s = freshSandbox();
  const names = s.TRIGGER_PLAN.map((e) => e.fn);
  assert.ok(names.indexOf('processAllNodeDownRows') === -1,
    'referencing a function that does not exist is what broke setupAllTriggers()');
});

test('every planned handler really exists in the .gs sources', () => {
  const gsFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.gs'));
  const source = gsFiles
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n');

  EXPECTED_PLAN.forEach((entry) => {
    const re = new RegExp('function\\s+' + entry.fn + '\\s*\\(');
    assert.ok(re.test(source),
      'TRIGGER_PLAN references ' + entry.fn + ' but no .gs file defines it');
  });
});

/* ------------------------------------------------------------------ *
   The drift report
 * ------------------------------------------------------------------ */

test('listTriggers reports a planned trigger that is not live', () => {
  const s = freshSandbox({ live: ['warmDataCaches'] });
  s.listTriggers();
  const out = s.__logs.join('\n');
  assert.ok(out.indexOf('Planned but NOT live') !== -1, 'should flag the gap');
  assert.ok(out.indexOf('updateAgingDurationStatic') !== -1, 'should name a missing one');
});

test('listTriggers reports a live trigger that is not planned', () => {
  const s = freshSandbox({ live: ALL_HANDLERS.concat(['someManualTrigger']) });
  s.listTriggers();
  const out = s.__logs.join('\n');
  assert.ok(out.indexOf('not in the plan') !== -1, 'should flag the extra one');
  assert.ok(out.indexOf('someManualTrigger') !== -1, 'should name it');
});

test('listTriggers flags a planned trigger installed on the WRONG event type', () => {
  // This was a real live situation: processBackboneTickets existed, so a
  // name-only comparison saw no drift — but it was installed as an ON_CHANGE
  // trigger, so the hourly schedule the plan intends was not actually running.
  const s = freshSandbox({
    live: ALL_HANDLERS.map((fn) => ({
      fn,
      type: fn === 'processBackboneTickets' ? 'ON_CHANGE' : 'CLOCK'
    }))
  });
  s.listTriggers();
  const out = s.__logs.join('\n');
  assert.ok(out.indexOf('WRONG event type') !== -1, 'should flag the wrong event type');
  assert.ok(out.indexOf('processBackboneTickets') !== -1, 'should name it');
  assert.ok(out.indexOf('In sync') === -1, 'must not claim it is in sync');
});

test('listTriggers flags an invalidation handler installed on a clock', () => {
  /* The inverse mistake, and the one this release makes possible: a handler that
     IS in the plan, IS installed, and is therefore invisible to a name-only
     check — while serving no edits at all because it runs every hour. */
  const expected = expectedEventTypes(freshSandbox());
  const s = freshSandbox({
    live: ALL_HANDLERS.map((fn) => ({
      fn,
      type: (fn === 'handleSheetEdit' || fn === 'handleSheetChange') ? 'CLOCK' : expected[fn]
    }))
  });
  s.listTriggers();
  const out = s.__logs.join('\n');
  assert.ok(out.indexOf('WRONG event type') !== -1, 'should flag it');
  assert.ok(out.indexOf('handleSheetEdit') !== -1, 'should name it');
});

test('listTriggers says so when there is no drift', () => {
  const expected = expectedEventTypes(freshSandbox());
  const s = freshSandbox({ live: ALL_HANDLERS.map((fn) => ({ fn, type: expected[fn] })) });
  s.listTriggers();
  assert.ok(s.__logs.some((l) => l.indexOf('In sync') !== -1));
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
