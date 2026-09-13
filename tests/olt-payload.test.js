/* ------------------------------------------------------------------
   OLT payload shape — the two sides together.

   code.gs encodes an OLT payload for the wire (compactOltRows); olt-module.js decodes
   it again (decodeOltPayload) and everything downstream — the admin table, the details
   modal, the kiosk slide, analytics — keeps expecting the legacy row objects.

   Nothing else checks that the two halves agree, and nothing would throw if they did
   not: a swapped field order or an off-by-one dictionary would quietly render the wrong
   province against every OLT. So this runs the real encoder through the harness, feeds
   its output to the real decoder loaded out of olt-module.js, and compares the result
   to the legacy payload for the very same sheet.

   Run with:  node --test tests/olt-payload.test.js
 * ------------------------------------------------------------------ */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createHarness, REPO_ROOT } = require('./gs-harness');

const SHEETS = { olt: 'NLZ OLT Report', oltTickets: 'OLT DOWN Tickets' };

/* ---------------- the real client decoder ---------------- */

// olt-module.js is a page script: top-level function declarations only, no imports and
// nothing that runs on load, so a bare context is enough to get at it.
function loadClientDecoder() {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'olt-module.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'olt-module.js' });

  if (typeof sandbox.decodeOltPayload !== 'function') {
    throw new Error('decodeOltPayload is no longer a top-level function in olt-module.js');
  }
  return sandbox.decodeOltPayload;
}

const decodeOltPayload = loadClientDecoder();

/* ---------------- sheet fixtures ---------------- */

/** A 12-wide OLT report row (B..M), positioned by index. */
function oltRow({ name, province = 'PROVINCE', municipality = 'Municipality', down = false, lowPower = false, ticket = '' }) {
  const row = new Array(12).fill('');
  row[0] = province;
  row[1] = municipality;
  row[2] = name;
  row[4] = down;
  row[5] = lowPower;
  row[8] = ticket;
  return row;
}

/** A 28-wide OLT ticket row, positioned by column letter. */
function oltTicketRow({ ticket, cause = 'Power', aging = '1d', clients = '0', oltNames = '' }) {
  const row = new Array(28).fill('');
  row[5] = ticket;      // F
  row[6] = cause;       // G
  row[23] = aging;      // X
  row[25] = clients;    // Z
  row[27] = oltNames;   // AB
  return row;
}

/** The fixture both sides are run against: repeats, a down row, an up row, slashes. */
function seedBothSheets(h) {
  h.sheet(SHEETS.olt).setGrid(3, 2, [
    oltRow({ name: 'KYB001-OLT-01', province: 'BENGUET', municipality: 'KABAYAN', down: true, ticket: 'TT-1' }),
    oltRow({ name: 'BGB001-OLT-02', province: 'BENGUET', municipality: 'BAGUIO', lowPower: true, ticket: 'TT-2' }),
    oltRow({ name: 'AUI001-OLT-01', province: 'ISABELA', municipality: 'AURORA' }),
    oltRow({ name: 'PAN001-OLT-09', province: 'PANGASINAN', municipality: 'URDANETA', down: true, ticket: 'TT-3' })
  ]);
  h.sheet(SHEETS.oltTickets).setGrid(2, 1, [
    oltTicketRow({ ticket: 'TT-1', cause: 'Fiber', aging: '3d 5h 27m', clients: '280', oltNames: 'KYB001-OLT-01' }),
    oltTicketRow({ ticket: 'TT-2', cause: 'Power', aging: '0d 2h 44m', clients: '17', oltNames: 'BGB001-OLT-02' }),
    oltTicketRow({ ticket: 'TT-3', cause: 'TBD', aging: '11d 1h', clients: '42', oltNames: 'PAN001-OLT-09' })
  ]);
}

/* ---------------- the contract between the two sides ---------------- */

test.describe('OLT payload round trip (code.gs -> olt-module.js)', () => {
  test('decoding the compact payload reproduces the legacy rows exactly', () => {
    const h = createHarness();
    seedBothSheets(h);

    const legacy = h.doGet({ type: 'olt' }).json;
    const compact = h.doGet({ type: 'olt', shape: '2' }).json;
    const decoded = decodeOltPayload(compact);

    assert.equal(legacy.length, 4, 'fixture sanity: four OLTs on the sheet');
    // Key-for-key AND in the same order: the compact field order is the order the
    // legacy objects are built in, so the two are indistinguishable once serialised.
    // String comparison sidesteps the cross-realm prototype a strict deepEqual would
    // trip over (the decoder runs in its own vm context).
    assert.equal(JSON.stringify(decoded), JSON.stringify(legacy),
      'the decoded compact payload must reproduce the legacy rows byte-for-byte');
  });

  test('the decoded rows carry the values the renderers read', () => {
    const h = createHarness();
    seedBothSheets(h);

    const decoded = decodeOltPayload(h.doGet({ type: 'olt', shape: '2' }).json);
    const down = decoded.find((row) => row.N === 'KYB001-OLT-01');

    assert.equal(down.P, 'BENGUET', 'province comes back as the name, not an index');
    assert.equal(down.M, 'KABAYAN');
    assert.equal(down.S, 'DOWN');
    assert.equal(down.AG, '3d 5h 27m');
    assert.equal(down.DC, 'Fiber');
    assert.equal(down.CA, '280');
  });

  test('the compact payload is materially smaller than the legacy one', () => {
    const h = createHarness();
    seedBothSheets(h);

    const legacy = h.doGet({ type: 'olt' }).text.length;
    h.reset();
    seedBothSheets(h);
    const compact = h.doGet({ type: 'olt', shape: '2' }).text.length;

    // The four-row fixture is too small to show the real ratio; on the live sheet
    // (461 rows, 16 provinces, 211 municipalities) it is 50,179 -> 26,258 bytes.
    assert.ok(compact < legacy, `compact ${compact} should be smaller than legacy ${legacy}`);
  });
});

/* ---------------- the decoder's own edges ---------------- */

test.describe('decodeOltPayload (client)', () => {
  test('a legacy array passes straight through', () => {
    const legacy = [{ N: 'OLT-A', P: 'BENGUET' }];

    assert.equal(decodeOltPayload(legacy), legacy, 'same reference — nothing copied');
  });

  test('an unknown shape returns null instead of guessing', () => {
    assert.equal(decodeOltPayload({ v: 3, r: [], f: [] }), null, 'a future version');
    assert.equal(decodeOltPayload({ v: 2, r: [] }), null, 'no field order');
    assert.equal(decodeOltPayload(null), null);
    assert.equal(decodeOltPayload(undefined), null);
    assert.equal(decodeOltPayload('[]'), null, 'a string is not a payload');
  });

  test('an empty payload decodes to an empty list', () => {
    assert.deepEqual(decodeOltPayload({ v: 2, f: ['N'], p: [], m: [], r: [] }), []);
  });

  test('every field in f is carried over, in order', () => {
    const payload = {
      v: 2,
      f: ['N', 'S'],
      p: [],
      m: [],
      r: [['OLT-A', 'UP'], ['OLT-B', 'DOWN']]
    };

    // Through JSON for the same cross-realm reason as the round trip above.
    assert.deepEqual(JSON.parse(JSON.stringify(decodeOltPayload(payload))), [
      { N: 'OLT-A', S: 'UP' },
      { N: 'OLT-B', S: 'DOWN' }
    ]);
  });

  test('a dictionary index with no entry yields undefined, not a crash', () => {
    const payload = { v: 2, f: ['P', 'M'], p: ['BENGUET'], m: [], r: [[0, 7]] };
    const [row] = decodeOltPayload(payload);

    assert.equal(row.P, 'BENGUET');
    assert.equal(row.M, undefined, 'a ragged payload degrades to a blank cell');
  });

  test('the payload is not mutated', () => {
    const payload = { v: 2, f: ['P'], p: ['BENGUET'], m: [], r: [[0]] };
    const snapshot = JSON.stringify(payload);

    decodeOltPayload(payload);

    assert.equal(JSON.stringify(payload), snapshot);
  });
});
