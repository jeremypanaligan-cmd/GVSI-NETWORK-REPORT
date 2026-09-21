// ==================== OLT TICKET IMPACT / AFFECTED CLIENTS (SA) ====================
//
// Run: node tests/olt-impact.test.js
//
// Zero dependencies. Loads the REAL code.gs into a vm sandbox with stubbed Apps Script
// services and drives doGet() exactly the way the app does — and then loads the REAL
// olt-module.js, so the decoder under test is the one the browser runs rather than a copy
// written here. These claims straddle two sheets and both sides of the wire, so neither
// file on its own can be asked about them:
//
//   1. COL.OLT_IMPACT is column K — the same absolute column NODE_IMPACT and BB_IMPACT
//      already read, so one IMPACT column serves all three ticket sheets.
//   2. Every incident row carries its OWN ticket's IMPACT as `IM`, matched by ticket
//      number, normalised for case and surrounding whitespace.
//   3. meta.clientsSA is scoped by the TICKET's impact and not by the row's status: a DOWN
//      ticket marked NSA is excluded, a LOW POWER ticket marked SA is included, and two
//      OLTs sharing one SA ticket contribute their own counts rather than the ticket total
//      twice.
//   4. meta.clientsDown is left exactly as it was. The Analytics tab and the daily snapshot
//      in db.js read that field, and a snapshot is never corrected after the fact — so
//      changing what that number means would rewrite history.
//   5. `IM` is the LAST field of the compact wire contract, so a client that positions its
//      fields from `f` keeps every position it already had.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');

/* ------------------------------------------------------------------ *
   Apps Script service stubs
 * ------------------------------------------------------------------ */

function makeSheet(rows) {
  return {
    getLastRow: () => rows.length,
    getRange: (r, c, nr, nc) => ({
      getValues: () => {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const src = rows[r - 1 + i] || [];
          const row = [];
          for (let j = 0; j < nc; j++) {
            row.push(src[c - 1 + j] === undefined ? '' : src[c - 1 + j]);
          }
          out.push(row);
        }
        return out;
      }
    })
  };
}

/* Absolute-column layout of the two sheets the OLT branch reads. Column A = index 0, so
   these indices ARE the sheet's own letters — the point of COL in code.gs, and the thing
   a wrong index would silently shift. */

/* "NLZ OLT Report": read from row 3, columns B..M. Five status flags, four ticket slots. */
function oltRow(name, flags, tickets) {
  const row = [];
  row[1] = 'BENGUET';                 // B — province
  row[2] = 'ITOGON';                  // C — municipality
  row[3] = name;                      // D — OLT name
  if (flags.down) row[5] = true;      // F — DOWN
  if (flags.lowPower) row[6] = true;  // G — UPLINK LOW POWER
  if (flags.uplinkDown) row[7] = true;// H — UPLINK DOWN
  if (flags.degradation) row[8] = true; // I — SERVICE DEGRADATION
  row[9] = tickets.down || '';        // J — DOWN ticket
  row[10] = tickets.lowPower || '';   // K — LOW POWER ticket
  row[11] = tickets.uplinkDown || ''; // L — UPLINK DOWN ticket
  row[12] = tickets.degradation || '';// M — DEGRADATION ticket
  return row;
}

/* "OLT DOWN Tickets": the columns the branch joins on. Z and AB are newline-separated
   parallel lists — client count per line, OLT name per line — which is what the per-OLT
   lookup is built from. */
function ticketRow(no, cause, impact, aging, clients, oltNames) {
  const row = [];
  row[5] = no;          // F  — ticket number
  row[6] = cause;       // G  — DT cause
  row[10] = impact;     // K  — IMPACT
  row[23] = aging;      // X  — aging
  row[25] = clients;    // Z  — clients, one per line
  row[27] = oltNames;   // AB — OLT names, one per line, aligned with Z
  return row;
}

const OLT_ROWS = [
  [],                                                                             // row 1 — header
  [],                                                                             // row 2 — header
  oltRow('OLT-DOWN-NSA', { down: true }, { down: 'TKT-NSA' }),
  oltRow('OLT-LP-SA', { lowPower: true }, { lowPower: 'TKT-SA' }),
  oltRow('OLT-SA-A', { down: true }, { down: 'TKT-SA2' }),
  oltRow('OLT-SA-B', { down: true }, { down: 'TKT-SA2' }),
  oltRow('OLT-NO-TICKET', { down: true }, {}),
  oltRow('OLT-BLANK-IMPACT', { down: true }, { down: 'TKT-BLANK' }),
  oltRow('OLT-UP', {}, {})
];

const TICKET_ROWS = [
  [],                                                                             // row 1 — header
  ticketRow('TKT-NSA', 'FIBER', 'NSA', '12h', '75', 'OLT-DOWN-NSA'),
  ticketRow('TKT-SA', 'POWER', ' sa ', '3h', '45', 'OLT-LP-SA'),
  ticketRow('TKT-SA2', 'FIBER', 'SA', '1h', '30\n20', 'OLT-SA-A\nOLT-SA-B'),
  ticketRow('TKT-BLANK', 'TBD', '', '2h', '10', 'OLT-BLANK-IMPACT')
];

function freshSandbox() {
  const store = {};
  const puts = [];
  const props = {};
  const logs = [];

  const sandbox = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (name) => {
          if (name === 'NLZ OLT Report') return makeSheet(OLT_ROWS);
          if (name === 'OLT DOWN Tickets') return makeSheet(TICKET_ROWS);
          return null;
        }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        put: (key, value, ttl) => { puts.push({ key, value, ttl }); store[key] = value; },
        remove: (k) => { delete store[k]; }
      })
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props[k] === undefined ? null : props[k]),
        getProperties: () => Object.assign({}, props),
        setProperty: (k, v) => { props[k] = v; },
        deleteProperty: (k) => { delete props[k]; }
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
    Utilities: { formatDate: () => '01/01/2026 00:00:00' },
    Session: { getScriptTimeZone: () => 'Asia/Manila' },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200 }) },
    /* Stands in for admin.gs's jsonOut, which the error envelopes call, so that a failing
       build answers with an envelope a test can read instead of a ReferenceError. */
    jsonOut: (obj) => ({ getContent: () => JSON.stringify(obj) })
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'code.gs'), 'utf8'), sandbox, { filename: 'code.gs' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'olt-module.js'), 'utf8'), sandbox, { filename: 'olt-module.js' });

  sandbox.__puts = puts;
  sandbox.__logs = logs;
  return sandbox;
}

const OLT_HTTP = () => ({ parameter: { type: 'olt', shape: '3' } });
const OLT_UP_HTTP = () => ({ parameter: { type: 'olt', shape: '4' } });
const OLT_LEGACY_HTTP = () => ({ parameter: { type: 'olt' } });

function payload(s, event) {
  return JSON.parse(s.doGet(event || OLT_HTTP()).getContent());
}

/* Decoded through the app's own decoder, so a field the server appends but the client
   cannot read fails here rather than on a phone. */
function rowsByName(s, envelope) {
  const map = {};
  s.decodeOltCompact(envelope).forEach((row) => { map[row.N] = row; });
  return map;
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

console.log('\nOLT ticket IMPACT and Affected Clients (SA)\n');

/* ------------------------------------------------------------------ *
   1. The column contract
 * ------------------------------------------------------------------ */

test('the impact column is K — the same column NODE and BACKBONE already read', () => {
  const s = freshSandbox();

  assert.strictEqual(s.COL.OLT_IMPACT, 10, 'OLT DOWN Tickets column K is index 10');
  assert.strictEqual(s.COL.OLT_IMPACT, s.COL.NODE_IMPACT, 'one IMPACT column, three sheets');
  assert.strictEqual(s.COL.OLT_IMPACT, s.COL.BB_IMPACT);
  assert.notStrictEqual(s.COL.OLT_IMPACT, s.COL.OLT_CAUSE,
    'it must not be the cause column the OLT branch already reads from G');
});

test('every incident row carries its own ticket\'s IMPACT', () => {
  const s = freshSandbox();
  const envelope = payload(s);
  const map = rowsByName(s, envelope);

  assert.strictEqual(s.decodeOltCompact(envelope).length, 6, 'only the problem rows are on the wire');
  assert.strictEqual(map['OLT-DOWN-NSA'].IM, 'NSA');
  assert.strictEqual(map['OLT-LP-SA'].IM, 'SA', 'whitespace and case are normalised on the way in');
  assert.strictEqual(map['OLT-BLANK-IMPACT'].IM, '-', 'an empty cell is an absence, not a value');
  assert.strictEqual(map['OLT-NO-TICKET'].IM, '-', 'no ticket means no impact to look up');
  assert.strictEqual(map['OLT-NO-TICKET'].T, 'N/A');
});

/* ------------------------------------------------------------------ *
   2. What the SA total counts
 * ------------------------------------------------------------------ */

test('Affected Clients (SA) is scoped by the ticket, not by the row status', () => {
  const s = freshSandbox();
  const meta = payload(s).meta;

  assert.strictEqual(meta.clientsSA, 95,
    '45 on a LOW POWER ticket plus 30 and 20 on two OLTs sharing one SA ticket');
  assert.strictEqual(meta.clientsDown, 135,
    'DOWN rows only: 75 NSA + 30 + 20 + 0 + 10 — the number Analytics still reads');
  assert.notStrictEqual(meta.clientsSA, meta.clientsDown,
    'two different numbers, so a swap between them cannot hide');
  assert.strictEqual(meta.lowPower, 1, 'the SA row in this fixture is not DOWN');
  assert.strictEqual(meta.down, 5);
  assert.strictEqual(meta.total, 7);
});

test('two OLTs on one SA ticket contribute their own clients, not the ticket total twice', () => {
  const s = freshSandbox();
  const map = rowsByName(s, payload(s));

  assert.strictEqual(map['OLT-SA-A'].CA, '30');
  assert.strictEqual(map['OLT-SA-B'].CA, '20');
  /* Falling back to the ticket's own Z cell would have charged both OLTs the first
     number in it and pushed the fleet total to 105. */
  assert.notStrictEqual(map['OLT-SA-B'].CA, map['OLT-SA-A'].CA,
    'the per-OLT split must be used when the ticket names its OLTs');
});

/* ------------------------------------------------------------------ *
   3. The wire contract
 * ------------------------------------------------------------------ */

test('IM is the last field, so readers that position from `f` keep their positions', () => {
  const s = freshSandbox();
  const envelope = payload(s);

  assert.strictEqual(envelope.f[envelope.f.length - 1], 'IM');
  assert.strictEqual(envelope.f.indexOf('IM'), envelope.f.length - 1, 'appended, not inserted');
  assert.deepStrictEqual(envelope.f.slice(0, 9), ['P', 'M', 'N', 'S', 'T', 'AG', 'RM', 'DC', 'CA'],
    'the fields that were already there did not move');
  assert.strictEqual(new Set(envelope.f).size, envelope.f.length, 'no field is sent twice');

  const legacy = payload(s, OLT_LEGACY_HTTP());
  /* Array.from because the sandbox's own array lives in another realm, and deepStrictEqual
     compares prototypes: the same list cross-realm is "not equal" for reasons that have
     nothing to do with the order being checked. */
  assert.deepStrictEqual(Object.keys(legacy[0]), Array.from(s.OLT_ROW_FIELDS),
    'the legacy object and the compact field list cannot drift apart');
  assert.strictEqual(legacy.length, 7, 'shape=1 still carries the whole fleet');
  assert.strictEqual(legacy[0].IM, 'NSA', 'and carries the same impact');
});

test('the healthy-fleet payload carries the field too, so one decoder serves both', () => {
  const s = freshSandbox();
  const up = payload(s, OLT_UP_HTTP());

  assert.strictEqual(up.v, 4);
  assert.strictEqual(up.f[up.f.length - 1], 'IM');
  assert.strictEqual(up.r.length, 1, 'one OLT is up in this fixture');
  assert.strictEqual(s.decodeOltCompact(up)[0].IM, '-',
    'an UP row has no incident impact to carry, and must not borrow one');
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
