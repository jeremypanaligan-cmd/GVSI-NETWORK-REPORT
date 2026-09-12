/* ------------------------------------------------------------------ *
   Backend tests for code.gs + admin.gs — routing and caching.

   Run with:  node --test tests/
   (Node 18+; this repo has no package.json, so there is nothing to install.)

   These run entirely in Node against the real .gs sources via the fake
   Apps Script runtime in ./gs-harness.js. No deployment, no browser.
 * ------------------------------------------------------------------ */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createHarness } = require('./gs-harness');

const h = createHarness();

/* ------------------------- seeding helpers ------------------------- */

const SHEETS = {
  nap: 'NLZ NAP Report',
  lcp: 'NLZ LCP Report',
  olt: 'NLZ OLT Report',
  oltTickets: 'OLT DOWN Tickets',
  node: 'Node DOWN Tickets',
  backbone: 'Backbone Tickets',
  users: 'Users',
  activeUsers: 'ActiveUsers',
  settings: 'AppSettings'
};

const big = (n) => 'X'.repeat(n);

/** NAP rows live at H3:M… (the range H2:M19 is read, row 0 of it is a header). */
function seedNap(rows) {
  h.sheet(SHEETS.nap).setGrid(3, 8, rows);
}

/** OLT report rows start at B3; B..M are read. */
function seedOltRows(rows) {
  h.sheet(SHEETS.olt).setGrid(3, 2, rows);
}

/** `OLT DOWN Tickets` rows start at A2 and run to AB (28 columns). */
function seedOltTickets(rows) {
  h.sheet(SHEETS.oltTickets).setGrid(2, 1, rows);
}

/** A 28-wide OLT ticket row, positioned by column letter. */
function oltTicketRow({ ticket, cause = 'Power', aging = '1d', clients = '0', oltNames = '' }) {
  const row = new Array(28).fill('');
  row[5] = ticket;      // F
  row[6] = cause;       // G
  row[20] = 'note';     // U
  row[23] = aging;      // X
  row[25] = clients;    // Z
  row[27] = oltNames;   // AB
  return row;
}

/** A 12-wide OLT report row (B..M), positioned by index. */
function oltRow({ name, down = false, lowPower = false, uplinkDown = false, degradation = false, ticket = '' }) {
  const row = new Array(12).fill('');
  row[0] = 'PROVINCE';
  row[1] = 'Municipality';
  row[2] = name;                 // D
  row[4] = down;                 // F
  row[5] = lowPower;             // G
  row[6] = uplinkDown;           // H
  row[7] = degradation;          // I
  row[8] = ticket;               // J
  row[9] = ticket;               // K
  row[10] = ticket;              // L
  row[11] = ticket;              // M
  return row;
}

/** Node rows start at A2 and run to AA (27 columns). */
function seedNodeRows(rows) {
  h.sheet(SHEETS.node).setGrid(2, 1, rows);
}

function nodeRow({ province, equipment = '', ticket = '', count = '' }) {
  const row = new Array(27).fill('');
  row[3] = province;    // D
  row[5] = ticket;      // F
  row[6] = 'cause';     // G
  row[10] = 'impact';   // K
  row[13] = '';         // N
  row[20] = 'remarks';  // U
  row[23] = 'aging';    // X
  row[24] = count;      // Y
  row[26] = equipment;  // AA
  return row;
}

/** Backbone rows start at A2 and run to Z (26 columns). */
function seedBackboneRows(rows) {
  h.sheet(SHEETS.backbone).setGrid(2, 1, rows);
}

function backboneRow({ province, ticket = '', category = '', links = '', linkCount = '', aging = '' }) {
  const row = new Array(26).fill('');
  row[3] = province;    // D
  row[5] = ticket;      // F
  row[6] = 'service';   // G
  row[10] = 'NSA';      // K
  row[11] = category;   // L
  row[13] = '';         // N
  row[20] = 'remarks';  // U
  row[23] = aging;      // X
  row[24] = links;      // Y
  row[25] = linkCount;  // Z
  return row;
}

test.beforeEach(() => { h.reset(); });

/* ============================ 1. ROUTING ============================ */

test.describe('routing', () => {
  test('action=keepalive is handled by admin.gs and touches no data sheet', () => {
    const res = h.doGet({ action: 'keepalive' });
    assert.equal(res.mimeType, 'application/json');
    assert.deepEqual(res.json, { status: 'ok' });
    assert.equal(h.sheetReads(), 0);
    assert.equal(h.cache.puts.length, 0, 'a keepalive must not write the data cache');
  });

  test('an admin action never falls through to the data cache path', () => {
    seedNap([['AREA', 'PROV', 1, 0, 0, 1]]);
    h.doGet({ action: 'getSettings' });
    assert.equal(
      h.cache.puts.length, 0,
      'getSettings must not populate cache_v2_<type>'
    );
    assert.deepEqual(h.cache.getKeys(), []);
  });

  test('type defaults to nap when the parameter is absent', () => {
    seedNap([['AREA1', 'PROV1', 3, 2, 1, 6]]);
    const res = h.doGet({});
    assert.equal(res.json.length, 1);
    assert.equal(res.json[0].A, 'AREA1');
  });

  test('an unrecognised type also falls back to the NAP branch', () => {
    seedNap([['AREA1', 'PROV1', 3, 2, 1, 6]]);
    const res = h.doGet({ type: 'something-else' });
    assert.equal(res.json[0].A, 'AREA1');
  });

  test('doGet tolerates a missing event object', () => {
    seedNap([['AREA1', 'PROV1', 1, 0, 0, 1]]);
    const res = h.call('doGet', undefined);
    assert.equal(JSON.parse(res.getContent())[0].A, 'AREA1');
  });

  test('a malformed event with no parameter still routes', () => {
    seedNap([['AREA1', 'PROV1', 1, 0, 0, 1]]);
    const res = h.call('doGet', {});
    assert.equal(JSON.parse(res.getContent())[0].A, 'AREA1');
  });
});

/* ============================ 2. CACHE TTLs ============================ */

test.describe('cache TTLs', () => {
  test.beforeEach(() => {
    seedNap([['AREA1', 'PROV1', 3, 2, 1, 6]]);
    h.sheet(SHEETS.lcp).setGrid(2, 7, [['H', 'P', 'TT', 'LCP', 'C']]);       // header row
    seedOltRows([oltRow({ name: 'OLT-A' })]);
    seedNodeRows([nodeRow({ province: 'BENGUET', equipment: 'NODE-1' })]);
    seedBackboneRows([backboneRow({ province: 'BENGUET', ticket: 'BB-1', links: 'a → b' })]);
  });

  const cases = [
    ['nap', 180],
    ['lcp', 180],
    ['olt', 60],
    ['node', 60],
    ['backbone', 60]
  ];

  for (const [type, ttl] of cases) {
    test(`${type} caches under cache_v2_${type} with TTL ${ttl}s`, () => {
      h.doGet({ type });
      assert.equal(h.cache.ttlFor(`cache_v2_${type}`), ttl);
      assert.ok(h.cache.has(`cache_v2_${type}`), 'payload should be in CacheService');
    });
  }

  test('a cache hit is served without re-reading any sheet', () => {
    h.doGet({ type: 'olt' });
    const firstReads = h.sheetReads();
    assert.ok(firstReads > 0, 'the first call should hit the sheet');

    const second = h.doGet({ type: 'olt' });
    assert.equal(h.sheetReads(), firstReads, 'the second call must not touch the sheet');
    assert.equal(second.json.length, 1);
  });

  test('a cache hit re-serves the stored bytes even if the sheet changed', () => {
    const first = h.doGet({ type: 'olt' });
    seedOltRows([oltRow({ name: 'OLT-A' }), oltRow({ name: 'OLT-B' })]);

    const second = h.doGet({ type: 'olt' });
    assert.equal(second.text, first.text, 'the cached payload must be served verbatim');
    assert.equal(second.json.length, 1, 'the new sheet row must not leak through');
  });

  test('a cache hit does not rewrite the cache', () => {
    h.doGet({ type: 'nap' });
    const writes = h.cache.puts.length;
    h.doGet({ type: 'nap' });
    assert.equal(h.cache.puts.length, writes, 'a hit must not re-put');
  });

  test('the cache expires on its own after the TTL', () => {
    h.doGet({ type: 'olt' });
    h.clock.advanceSeconds(59);
    assert.ok(h.cache.has('cache_v2_olt'), 'still fresh at 59s');
    h.clock.advanceSeconds(2);
    assert.equal(h.cache.has('cache_v2_olt'), false, 'expired at 61s');
  });
});

/* ============ 3. PropertiesService overflow + hand-rolled expiry ============ */

test.describe('PropertiesService overflow (write path)', () => {
  test('a payload over 90KB is stored in PropertiesService with a stamp', () => {
    seedNap([['AREA1', big(95000), 3, 2, 1, 6]]);
    const res = h.doGet({ type: 'nap' });

    assert.ok(res.text.length > 90000, 'sanity: the payload really is oversized');
    assert.equal(h.cache.has('cache_v2_nap'), false, 'too big for CacheService');
    assert.equal(h.props.getProperty('cache_v2_nap'), res.text);
    assert.equal(
      h.props.getProperty('cache_v2_nap_cached_at'),
      String(h.clock.now()),
      'the write must be stamped with the clock time'
    );
    assert.ok(h.logs.some((l) => l.includes('overflow fallback')));
  });

  test('a payload over 450KB is cached nowhere and warns', () => {
    seedNap([['AREA1', big(460000), 3, 2, 1, 6]]);
    const res = h.doGet({ type: 'nap' });

    assert.ok(res.text.length > 450000);
    assert.equal(h.cache.has('cache_v2_nap'), false);
    assert.equal(h.props.getProperty('cache_v2_nap'), null);
    assert.ok(h.logs.some((l) => l.includes('too large for any cache')));
  });

  test('a module that shrinks back under the limit clears its leftover overflow copy', () => {
    // A previously oversized payload is sitting in PropertiesService. Force the
    // read path to be skipped (a CacheService failure does exactly that) so the
    // WRITE path is what has to notice and clear the leftover copy.
    h.props.setProperty('cache_v2_nap', big(100000));
    h.props.setProperty('cache_v2_nap_cached_at', String(h.clock.now()));
    h.cache.get = () => { throw new Error('cache unavailable'); };

    seedNap([['AREA1', 'PROV1', 3, 2, 1, 6]]);
    h.doGet({ type: 'nap' });

    assert.equal(h.props.getProperty('cache_v2_nap'), null, 'payload copy must be gone');
    assert.equal(h.props.getProperty('cache_v2_nap_cached_at'), null, 'stamp must be gone');
    // getKeys() rather than has(): `get` is deliberately throwing in this test.
    assert.ok(h.cache.getKeys().includes('cache_v2_nap'), 'the small payload belongs in CacheService');
  });

  test('a CacheService failure is caught and the sheet is still served', () => {
    h.cache.get = () => { throw new Error('cache unavailable'); };
    seedNap([['AREA1', 'PROV1', 3, 2, 1, 6]]);

    const res = h.doGet({ type: 'nap' });
    assert.equal(res.json[0].A, 'AREA1', 'degraded cache must not break the response');
    assert.ok(h.sheetReads() > 0);
    assert.ok(h.logs.some((l) => l.includes('Cache get error')));
  });
});

test.describe('PropertiesService expiry (read path)', () => {
  // The backing sheets are seeded so "fell through to the sheet" is observable:
  // an unseeded sheet returns [] without a single getValues() call.
  test.beforeEach(() => {
    seedNap([['AREA1', 'PROV1', 3, 2, 1, 6]]);
    seedOltRows([oltRow({ name: 'OLT-A' })]);
  });

  /** Seed an overflow-style entry directly; only the read path is under test. */
  function seedProp(type, payload, ageSeconds) {
    h.props.setProperty(`cache_v2_${type}`, payload);
    h.props.setProperty(`cache_v2_${type}_cached_at`, String(h.clock.now() - ageSeconds * 1000));
  }

  test('a fresh stamped entry is served with zero sheet reads', () => {
    seedProp('olt', '[{"cached":true}]', 10);
    const res = h.doGet({ type: 'olt' });
    assert.equal(res.text, '[{"cached":true}]');
    assert.equal(h.sheetReads(), 0);
    assert.equal(h.cache.puts.length, 0, 'a hit must not rewrite anything');
  });

  test('an entry older than its TTL is dropped and the sheet is read', () => {
    seedProp('olt', '[{"stale":true}]', 600);
    const res = h.doGet({ type: 'olt' });

    assert.notEqual(res.text, '[{"stale":true}]');
    assert.equal(res.json[0].N, 'OLT-A', 'the freshly computed payload is returned');
    assert.equal(h.props.getProperty('cache_v2_olt'), null, 'payload must be deleted');
    assert.equal(h.props.getProperty('cache_v2_olt_cached_at'), null, 'stamp must be deleted');
    assert.ok(h.sheetReads() > 0, 'must fall through to the sheet');
    assert.ok(h.logs.some((l) => l.includes('Stale PropertiesService cache dropped')));
    assert.equal(h.cache.ttlFor('cache_v2_olt'), 60, 'and the fresh data is cached properly');
  });

  // The write path also clears a leftover overflow property, so simply asserting
  // "the property is gone" would pass even if the read path never deleted it.
  // Here the freshly computed payload is too large to cache at all, which makes
  // the write path skip its cleanup — isolating the read path's own deletion.
  test('the read path itself deletes the stale entry', () => {
    seedNap([['AREA1', big(460000), 3, 2, 1, 6]]);
    h.props.setProperty('cache_v2_nap', big(100000));
    h.props.setProperty('cache_v2_nap_cached_at', String(h.clock.now() - 600 * 1000));

    h.doGet({ type: 'nap' });

    assert.equal(h.props.getProperty('cache_v2_nap'), null, 'payload must be deleted');
    assert.equal(h.props.getProperty('cache_v2_nap_cached_at'), null, 'stamp must be deleted');
    assert.ok(h.props.deletes.includes('cache_v2_nap_cached_at'));
    // Sanity: the write path really did skip its cleanup, or this test proves nothing.
    assert.ok(h.logs.some((l) => l.includes('too large for any cache')));
  });

  test('an entry with NO stamp is treated as expired (legacy migration)', () => {
    h.props.setProperty('cache_v2_olt', '[{"legacy":true}]'); // no _cached_at
    const res = h.doGet({ type: 'olt' });

    assert.notEqual(res.text, '[{"legacy":true}]');
    assert.equal(h.props.getProperty('cache_v2_olt'), null);
    assert.ok(h.sheetReads() > 0, 'must not be trusted indefinitely');
  });

  test('a corrupted (non-numeric) stamp is treated as expired', () => {
    h.props.setProperty('cache_v2_olt', '[{"bad":true}]');
    h.props.setProperty('cache_v2_olt_cached_at', 'not-a-number');
    const res = h.doGet({ type: 'olt' });

    assert.notEqual(res.text, '[{"bad":true}]');
    assert.equal(h.props.getProperty('cache_v2_olt'), null);
    assert.ok(h.sheetReads() > 0, 'must fall through to the sheet');
  });

  test('the same 120s age is fresh for NAP (180s) but stale for OLT (60s)', () => {
    seedProp('nap', '[{"nap":true}]', 120);
    seedProp('olt', '[{"olt":true}]', 120);

    const napRes = h.doGet({ type: 'nap' });
    const oltRes = h.doGet({ type: 'olt' });

    assert.equal(napRes.text, '[{"nap":true}]', 'NAP TTL is 180s, so 120s is fresh');
    assert.equal(oltRes.text !== '[{"olt":true}]', true, 'OLT TTL is 60s, so 120s is stale');
    assert.equal(h.props.getProperty('cache_v2_nap'), '[{"nap":true}]', 'NAP entry survives');
    assert.equal(h.props.getProperty('cache_v2_olt'), null, 'OLT entry is deleted');
  });

  test('boundary: an entry exactly at its TTL is expired', () => {
    seedProp('olt', '[{"edge":true}]', 60);
    const res = h.doGet({ type: 'olt' });
    assert.equal(h.props.getProperty('cache_v2_olt'), null);
    assert.notEqual(res.text, '[{"edge":true}]');
    assert.ok(h.sheetReads() > 0);
  });

  test('boundary: an entry just under its TTL is served', () => {
    seedProp('olt', '[{"edge":true}]', 59);
    const res = h.doGet({ type: 'olt' });
    assert.equal(res.text, '[{"edge":true}]');
    assert.equal(h.sheetReads(), 0);
  });
});

/* ============================ 4. DATA SHAPES ============================ */

test.describe('data shapes', () => {
  test('NAP parses the H:M block and skips TOTAL', () => {
    seedNap([
      ['AREA1', 'PROV1', 3, 2, 1, 6],
      ['TOTAL', 'X', 9, 9, 9, 9],
      ['', '', '', '', '', ''],
      ['AREA2', 'PROV2', 1, 1, 0, 2]
    ]);
    const res = h.doGet({ type: 'nap' });

    assert.equal(res.json.length, 2);
    assert.deepEqual(Object.keys(res.json[0]), ['A', 'P', 'H', 'D1', 'D3', 'T']);
    assert.equal(res.json[0].A, 'AREA1');
    assert.equal(res.json[1].A, 'AREA2');
    assert.ok(!res.json.some((r) => String(r.A).toUpperCase() === 'TOTAL'));
  });

  test('NAP returns [] when the sheet is missing', () => {
    assert.deepEqual(h.doGet({ type: 'nap' }).json, []);
  });

  test('LCP parses both blocks and skips TOTAL in each', () => {
    const sheet = h.sheet(SHEETS.lcp);
    sheet.setGrid(3, 7, [
      ['PANGASINAN', 'P', 'TT', 'LCP', 'C'],
      ['TOTAL', 'X', 'X', 'X', 'X']
    ]);
    sheet.setGrid(24, 7, [
      ['ISABELA', 'P', 'H', 'D1', 'D3', 'T'],
      ['TOTAL', 'X', 'X', 'X', 'X', 'X']
    ]);

    const res = h.doGet({ type: 'lcp' });
    assert.deepEqual(Object.keys(res.json), ['lcpAging', 'lcpImpact']);
    assert.equal(res.json.lcpAging.length, 1);
    assert.equal(res.json.lcpImpact.length, 1);
    assert.equal(res.json.lcpAging[0].A, 'ISABELA');
    assert.equal(res.json.lcpImpact[0].A, 'PANGASINAN');
    assert.equal(res.json.lcpAging[0].T, 'T');
    assert.equal(res.json.lcpImpact[0].C, 'C');
  });

  test('LCP returns empty blocks when the sheet is missing', () => {
    assert.deepEqual(h.doGet({ type: 'lcp' }).json, { lcpAging: [], lcpImpact: [] });
  });

  test('OLT attributes clients per-OLT from the breakline lists, not per-ticket', () => {
    seedOltTickets([
      oltTicketRow({ ticket: 'TKT-1', clients: '100\n50', oltNames: 'OLT-A\nOLT-B' })
    ]);
    seedOltRows([
      oltRow({ name: 'OLT-A', down: true, ticket: 'TKT-1' }),
      oltRow({ name: 'OLT-B', down: true, ticket: 'TKT-1' })
    ]);

    const res = h.doGet({ type: 'olt' });
    const byName = Object.fromEntries(res.json.map((r) => [r.N, r]));
    assert.equal(byName['OLT-A'].CA, '100');
    assert.equal(byName['OLT-B'].CA, '50', 'OLT-B must not inherit the ticket total');
  });

  test('OLT falls back to the ticket total when the OLT is not named in the list', () => {
    seedOltTickets([oltTicketRow({ ticket: 'TKT-1', clients: '77', oltNames: 'OLT-A' })]);
    seedOltRows([oltRow({ name: 'OLT-Z', down: true, ticket: 'TKT-1' })]);

    const res = h.doGet({ type: 'olt' });
    assert.equal(res.json[0].CA, '77');
  });

  test('OLT status precedence: DOWN wins over low power, and UP is the default', () => {
    seedOltRows([
      oltRow({ name: 'OLT-BOTH', down: true, lowPower: true, ticket: 'T1' }),
      oltRow({ name: 'OLT-LP', lowPower: true, ticket: 'T2' }),
      oltRow({ name: 'OLT-OK' })
    ]);
    const res = h.doGet({ type: 'olt' });
    const byName = Object.fromEntries(res.json.map((r) => [r.N, r]));

    assert.equal(byName['OLT-BOTH'].S, 'DOWN');
    assert.equal(byName['OLT-LP'].S, 'OLT UPLINK LOW POWER');
    assert.equal(byName['OLT-OK'].S, 'UP');
    assert.equal(byName['OLT-OK'].T, 'N/A');
    assert.equal(byName['OLT-OK'].CA, '0');
  });

  test('OLT drops TOTAL and blank name rows', () => {
    seedOltRows([
      oltRow({ name: 'OLT-A' }),
      oltRow({ name: 'TOTAL' }),
      oltRow({ name: '' })
    ]);
    const res = h.doGet({ type: 'olt' });
    assert.equal(res.json.length, 1);
    assert.equal(res.json[0].N, 'OLT-A');
  });

  test('OLT returns [] when the sheet is missing or too short', () => {
    assert.deepEqual(h.doGet({ type: 'olt' }).json, []);
    h.sheet(SHEETS.olt).setCell(1, 1, 'header only');
    assert.deepEqual(h.doGet({ type: 'olt' }).json, []);
  });

  test('Node keeps rows with a province or equipment and maps its keys', () => {
    seedNodeRows([
      nodeRow({ province: 'BENGUET', equipment: 'NODE-1', ticket: 'T1', count: 5 }),
      nodeRow({ province: '', equipment: 'NODE-2', count: 1 }),
      nodeRow({ province: '', equipment: '' })
    ]);
    const res = h.doGet({ type: 'node' });

    assert.equal(res.json.length, 2);
    assert.deepEqual(Object.keys(res.json[0]), ['P', 'N', 'C', 'T', 'DC', 'I', 'D', 'AG', 'RM']);
    assert.equal(res.json[0].P, 'BENGUET');
    assert.equal(res.json[0].C, 5);
    assert.equal(res.json[1].N, 'NODE-2');
    assert.equal(res.json[1].T, '-');
  });

  test('Node returns [] when the sheet is missing', () => {
    assert.deepEqual(h.doGet({ type: 'node' }).json, []);
  });

  test('Backbone replaces underscores and filters residual rows', () => {
    seedBackboneRows([
      backboneRow({ province: 'MT_PROVINCE', ticket: 'BB-1', category: 'DWDM', links: 'A → B', linkCount: 2, aging: '3d' }),
      backboneRow({ province: '-', ticket: 'N/A' }),      // residual: dropped
      backboneRow({ province: '', ticket: '' })           // blank: dropped
    ]);
    const res = h.doGet({ type: 'backbone' });

    assert.equal(res.json.length, 1);
    assert.equal(res.json[0].P, 'MT PROVINCE', 'underscores become spaces');
    assert.equal(res.json[0].IS, 'DWDM');
    assert.equal(res.json[0].LC, 2);
    assert.equal(res.json[0].AG, '3d');
  });

  test('Backbone keeps a row that has a ticket even with no province', () => {
    seedBackboneRows([backboneRow({ province: '', ticket: 'BB-9' })]);
    const res = h.doGet({ type: 'backbone' });
    assert.equal(res.json.length, 1);
    assert.equal(res.json[0].T, 'BB-9');
  });

  test('Backbone returns [] when the sheet is missing', () => {
    assert.deepEqual(h.doGet({ type: 'backbone' }).json, []);
  });

  test('formatDateVal formats a Date and passes other values through', () => {
    const formatted = h.call('formatDateVal', new Date(Date.UTC(2026, 8, 12, 14, 30, 5)));
    assert.equal(formatted, '09/12/2026 14:30:05');
    assert.equal(h.call('formatDateVal', 'already a string'), 'already a string');
  });

  test('formatDateVal respects the script time zone', () => {
    const manila = createHarness({ timeZone: 'Asia/Manila' });
    const formatted = manila.call('formatDateVal', new Date(Date.UTC(2026, 8, 12, 14, 30, 5)));
    assert.equal(formatted, '09/12/2026 22:30:05', 'UTC+8 shifts the clock forward');
  });
});

/* ============================ 5. ADMIN ============================ */

test.describe('admin handlers', () => {
  test('sha256 matches the real SHA-256 hex (signed-byte handling)', () => {
    const expected = crypto.createHash('sha256').update('secret').digest('hex');
    assert.equal(h.call('sha256', 'secret'), expected);
    // A value whose digest contains bytes > 127 exercises the sign correction.
    const tricky = 'Password123!';
    assert.equal(
      h.call('sha256', tricky),
      crypto.createHash('sha256').update(tricky).digest('hex')
    );
  });

  test('login succeeds with the right hash and fails otherwise', () => {
    const hash = crypto.createHash('sha256').update('secret').digest('hex');
    h.sheet(SHEETS.users).setGrid(2, 1, [
      ['admin', hash, 'Admin User', 'Tech admin/Dev'],
      ['viewer', 'deadbeef', 'View Only', 'viewer']
    ]);

    const ok = h.doGet({ action: 'login', username: 'ADMIN', password: 'secret' });
    assert.equal(ok.json.success, true);
    assert.deepEqual(ok.json.user, {
      username: 'admin', fullName: 'Admin User', role: 'Tech admin/Dev'
    });

    const bad = h.doGet({ action: 'login', username: 'admin', password: 'wrong' });
    assert.equal(bad.json.success, false);
    assert.match(bad.json.message, /Invalid username or password/);
  });

  test('login reports a missing Users sheet without throwing', () => {
    const res = h.doGet({ action: 'login', username: 'a', password: 'b' });
    assert.equal(res.json.success, false);
    assert.match(res.json.message, /Users sheet not found/);
  });

  test('login reports an empty Users sheet', () => {
    h.sheet(SHEETS.users).setCell(1, 1, 'Username');
    const res = h.doGet({ action: 'login', username: 'a', password: 'b' });
    assert.match(res.json.message, /No users configured/);
  });

  test('getSettings creates AppSettings and defaults maintenance to false', () => {
    const res = h.doGet({ action: 'getSettings' });
    assert.deepEqual(res.json, { maintenance: false });
    assert.ok(h.spreadsheet.inserted.includes('AppSettings'));
  });

  test('setMaintenance writes the flag and getSettings reads it back', () => {
    const token = adminToken();

    const set = gated({ action: 'setMaintenance', enabled: 'true' }, token);
    assert.deepEqual(set, { success: true, maintenance: true });

    const get = h.doGet({ action: 'getSettings' });
    assert.equal(get.json.maintenance, true, 'getSettings stays public and readable');

    gated({ action: 'setMaintenance', enabled: 'false' }, token);
    assert.equal(h.doGet({ action: 'getSettings' }).json.maintenance, false);
  });

  test('heartbeat inserts a new user and updates an existing one', () => {
    seedUsers();
    const juan = login('juan', 'juanpw').token;
    const maria = login('maria', 'mariapw').token;

    // Seed the row with different casing, so the case-folded match is what keeps
    // this an update rather than a duplicate.
    const sheet = h.sheet(SHEETS.activeUsers);
    sheet.setGrid(1, 1, [
      ['Username', 'FullName', 'LastSeen'],
      ['JUAN', 'Juan Dela Cruz', new Date(h.clock.now() - 60 * 1000).toISOString()]
    ]);

    gated({ action: 'heartbeat' }, juan);
    assert.equal(sheet.getLastRow(), 2, 'a repeat heartbeat must not add a row');

    gated({ action: 'heartbeat' }, maria);
    assert.equal(sheet.getLastRow(), 3);
  });

  test('heartbeat without a token is refused and writes nothing', () => {
    seedUsers();
    const res = h.doGet({ action: 'heartbeat', username: 'juan', fullName: 'Juan' });
    assert.equal(res.json.unauthorized, true);
    assert.equal(h.findSheet(SHEETS.activeUsers), null, 'nothing may be created');
  });

  test('getActiveUsers prunes stale rows and lists fresh ones', () => {
    const now = h.clock.now();
    h.sheet(SHEETS.activeUsers).setGrid(1, 1, [
      ['Username', 'FullName', 'LastSeen'],
      ['fresh', 'Fresh User', new Date(now - 60 * 1000).toISOString()],
      ['stale', 'Stale User', new Date(now - 30 * 60 * 1000).toISOString()]
    ]);

    const res = gated({ action: 'getActiveUsers' }, adminToken());
    assert.equal(res.users.length, 1);
    assert.equal(res.users[0].username, 'fresh');
    assert.equal(h.sheet(SHEETS.activeUsers).getLastRow(), 2, 'the stale row is deleted');
  });

  test('removeActiveUser deletes the matching row only', () => {
    h.sheet(SHEETS.activeUsers).setGrid(1, 1, [
      ['Username', 'FullName', 'LastSeen'],
      ['juan', 'Juan', new Date(h.clock.now()).toISOString()],
      ['maria', 'Maria', new Date(h.clock.now()).toISOString()]
    ]);

    // An admin removing somebody else, by a differently-cased name.
    const res = gated({ action: 'removeActiveUser', username: 'JUAN' }, adminToken());
    assert.equal(res.success, true);

    const remaining = h.sheet(SHEETS.activeUsers).getDataRange().getValues();
    assert.equal(remaining.length, 2);
    assert.equal(remaining[1][0], 'maria');
  });

  test('removeActiveUser tolerates a missing ActiveUsers sheet', () => {
    const res = gated({ action: 'removeActiveUser', username: 'juan' }, adminToken());
    assert.equal(res.success, true);
  });
});

/* ==================== 6. HARNESS SELF-CHECKS ==================== */

test.describe('harness fidelity', () => {
  test('empty cells read back as empty strings, not undefined', () => {
    h.sheet('X').setCell(1, 1, 'a');
    const grid = h.sheet('X').getRange(1, 1, 1, 3).getValues();
    assert.deepEqual(grid, [['a', '', '']]);
  });

  test('A1 ranges resolve to the same cells as grid ranges', () => {
    const sheet = h.sheet('X');
    sheet.setCell(5, 3, 'C5');
    assert.equal(sheet.getRange('C5').getValue(), 'C5');
    assert.deepEqual(sheet.getRange('C5:D6').getValues(), [['C5', ''], ['', '']]);
    assert.equal(sheet.getRange('C5:D6').getA1Notation(), 'C5:D6');
  });

  test('getValues() counts as a sheet read so cache hits are provable', () => {
    const sheet = h.sheet('X');
    sheet.setCell(1, 1, 'a');
    assert.equal(sheet.reads, 0);
    sheet.getRange(1, 1, 1, 1).getValues();
    assert.equal(sheet.reads, 1);
  });

  test('computeDigest returns signed bytes like Apps Script', () => {
    const bytes = h.utilities.computeDigest('SHA_256', 'secret', 'UTF_8');
    assert.equal(bytes.length, 32);
    assert.ok(bytes.some((b) => b < 0), 'at least one byte should be negative');
    assert.ok(bytes.every((b) => b >= -128 && b <= 127));
  });

  test('reset() clears sheets, cache, properties and logs', () => {
    seedNap([['AREA1', 'PROV1', 1, 0, 0, 1]]);
    h.doGet({ type: 'nap' });
    assert.ok(h.cache.puts.length > 0);

    h.reset();
    assert.equal(h.findSheet(SHEETS.nap), null);
    assert.deepEqual(h.cache.getKeys(), []);
    assert.deepEqual(h.props.getKeys(), []);
    assert.deepEqual(h.logs, []);
  });
});

/* ============ 6. SESSION TOKENS — P1 (accept-if-present) ============ */

const sha = (plain) => crypto.createHash('sha256').update(plain).digest('hex');
const ADMIN_ROLE = 'Tech admin/Dev';

/** Seed the Users sheet: one admin, one plain viewer, and two ordinary users. */
function seedUsers() {
  h.sheet(SHEETS.users).setGrid(2, 1, [
    ['admin', sha('secret'), 'Admin User', ADMIN_ROLE],
    ['viewer', sha('view'), 'View Only', 'viewer'],
    ['juan', sha('juanpw'), 'Juan Dela Cruz', 'viewer'],
    ['maria', sha('mariapw'), 'Maria Santos', 'viewer']
  ]);
}

/* The rollout switch is a `var` in the vm context, so a test can flip it. reset()
   reloads admin.gs, so the shipped default is restored before every test. */
function setEnforcement(on) { h.context.REQUIRE_SESSION = !!on; }

function adminToken() { seedUsers(); return login('admin', 'secret').token; }
function viewerToken() { seedUsers(); return login('viewer', 'view').token; }

/** Log in through the real route; returns the parsed response body. */
function login(username, password) {
  return h.doGet({ action: 'login', username, password }).json;
}

/** A gated call carrying a token (undefined = no token at all). */
function gated(params, token) {
  return h.doGet(Object.assign({ token }, params)).json;
}

/** The UpdatedBy value recorded in AppSettings for `maintenance`. */
function maintenanceActor() {
  const sheet = h.findSheet(SHEETS.settings);
  if (!sheet) return null;
  const rows = sheet.getDataRange().getValues();
  const row = rows.find((r) => String(r[0]).trim() === 'maintenance');
  return row ? String(row[3]) : null;
}

const sessionKeys = () => h.props.getKeys().filter((k) => k.indexOf('session_') === 0);

test.describe('session tokens', () => {
  test('login mints a token and stores the session server-side', () => {
    seedUsers();
    const body = login('ADMIN', 'secret');

    assert.equal(body.success, true);
    assert.equal(typeof body.token, 'string');
    assert.ok(body.token.length >= 32, 'token must be too long to guess');

    const keys = h.props.getKeys();
    assert.equal(keys.length, 1, 'exactly one property, and it is the session');
    assert.equal(keys[0], 'session_' + body.token);

    const stored = JSON.parse(h.props.getProperty(keys[0]));
    assert.equal(stored.u, 'admin', 'username is normalised to lowercase');
    assert.equal(stored.name, 'Admin User');
    assert.equal(stored.role, ADMIN_ROLE);
    assert.equal(stored.exp, h.clock.now() + 24 * 60 * 60 * 1000, 'TTL matches the client session');
  });

  test('two logins mint two distinct tokens and both stay valid', () => {
    seedUsers();
    const first = login('admin', 'secret').token;
    const second = login('admin', 'secret').token;

    assert.notEqual(first, second);
    assert.ok(h.props.has('session_' + first));
    assert.ok(h.props.has('session_' + second));
    assert.ok(Array.isArray(gated({ action: 'getActiveUsers' }, first).users));
    assert.ok(Array.isArray(gated({ action: 'getActiveUsers' }, second).users));
  });

  test('a failed login mints no token and stores no session', () => {
    seedUsers();
    const body = login('admin', 'wrong');
    assert.equal(body.success, false);
    assert.equal(body.token, undefined);
    assert.deepEqual(sessionKeys(), []);
  });
});

test.describe('route gates', () => {
  test('enforcement is the shipped default', () => {
    // Guards the flip itself: if REQUIRE_SESSION is ever set back to false, this
    // fails rather than silently reopening the four write routes.
    assert.equal(h.context.REQUIRE_SESSION, true);
  });

  test('a tokenless caller is refused by every gated route and writes nothing', () => {
    seedUsers();
    const before = h.sheetReads();

    [
      { action: 'setMaintenance', enabled: 'true' },
      { action: 'getActiveUsers' },
      { action: 'heartbeat', username: 'juan' },
      { action: 'removeActiveUser', username: 'juan' }
    ].forEach((route) => {
      const res = h.doGet(route).json;
      assert.equal(res.unauthorized, true, route.action + ' must refuse a tokenless caller');
    });

    assert.equal(h.sheetReads(), before, 'none of them may reach the sheet');
    assert.equal(h.findSheet(SHEETS.settings), null, 'no AppSettings write');
    assert.equal(h.findSheet(SHEETS.activeUsers), null, 'no ActiveUsers write');
  });

  test('the rollout switch reopens the route, but never the forgeable name', () => {
    setEnforcement(false);
    const res = h.doGet({ action: 'setMaintenance', enabled: 'true', admin: 'Forged Person' }).json;
    assert.deepEqual(res, { success: true, maintenance: true });
    assert.equal(maintenanceActor(), 'unknown',
      'with no token there is no trustworthy actor, so ?admin= must NOT be recorded');
  });

  test('a garbage token is refused, in either mode', () => {
    setEnforcement(false); // the switch must NOT soften an invalid token
    const res = gated({ action: 'setMaintenance', enabled: 'true' }, 'not-a-real-token');
    assert.equal(res.unauthorized, true);
    assert.equal(res.success, false);
    assert.equal(h.findSheet(SHEETS.settings), null, 'a refusal must not create or write anything');
  });

  test('every gated route refuses a bogus token', () => {
    [
      { action: 'setMaintenance', enabled: 'true' },
      { action: 'getActiveUsers' },
      { action: 'heartbeat', username: 'juan' },
      { action: 'removeActiveUser', username: 'juan' }
    ].forEach((route) => {
      assert.equal(gated(route, 'bogus').unauthorized, true, route.action + ' must refuse a bogus token');
    });
  });

  test("setMaintenance records the token's user, not the URL's ?admin=", () => {
    seedUsers();
    const { token } = login('admin', 'secret');

    const res = gated({ action: 'setMaintenance', enabled: 'true', admin: 'Forged Person' }, token);

    assert.equal(res.success, true);
    assert.equal(maintenanceActor(), 'admin', 'UpdatedBy must come from the token');
  });

  test('an admin token is accepted for admin-only routes', () => {
    seedUsers();
    const token = login('admin', 'secret').token;

    const res = gated({ action: 'getActiveUsers' }, token);
    assert.equal(res.unauthorized, undefined);
    assert.ok(Array.isArray(res.users));
  });

  test('a viewer token is refused for admin-only routes without even reading the sheet', () => {
    seedUsers();
    const token = login('viewer', 'view').token;

    const readsBefore = h.sheetReads();
    const maintenance = gated({ action: 'setMaintenance', enabled: 'true' }, token);
    assert.equal(maintenance.unauthorized, true);
    assert.match(maintenance.message, /role/i);
    assert.equal(h.sheetReads(), readsBefore, 'a refusal must not read the sheet');

    assert.equal(gated({ action: 'getActiveUsers' }, token).unauthorized, true);
  });

  test('heartbeat takes its identity from the token, not the URL', () => {
    seedUsers();
    const token = login('admin', 'secret').token;

    // A valid session must not be able to register somebody else as active.
    gated({ action: 'heartbeat', username: 'juan', fullName: 'Juan Dela Cruz' }, token);

    const rows = h.findSheet(SHEETS.activeUsers).getDataRange().getValues();
    assert.equal(String(rows[1][0]), 'admin');
    assert.equal(String(rows[1][1]), 'Admin User');
  });

  test('removeActiveUser allows self-removal but not removing another user as a viewer', () => {
    seedUsers();
    const juan = login('juan', 'juanpw').token;
    const maria = login('maria', 'mariapw').token;
    const viewer = login('viewer', 'view').token;

    gated({ action: 'heartbeat' }, juan);
    gated({ action: 'heartbeat' }, maria);
    assert.equal(h.findSheet(SHEETS.activeUsers).getLastRow(), 3);

    const denied = gated({ action: 'removeActiveUser', username: 'juan' }, viewer);
    assert.equal(denied.unauthorized, true);
    assert.equal(h.findSheet(SHEETS.activeUsers).getLastRow(), 3, 'nobody was removed');

    // The logout path: removing yourself is always allowed, and with no
    // ?username= the target is your own row.
    gated({ action: 'heartbeat' }, viewer);
    assert.equal(h.findSheet(SHEETS.activeUsers).getLastRow(), 4);
    assert.equal(gated({ action: 'removeActiveUser' }, viewer).success, true);
    assert.equal(h.findSheet(SHEETS.activeUsers).getLastRow(), 3);

    const admin = login('admin', 'secret').token;
    assert.equal(gated({ action: 'removeActiveUser', username: 'juan' }, admin).success, true);
    assert.equal(h.findSheet(SHEETS.activeUsers).getLastRow(), 2);
  });
});

test.describe('revocation, expiry and pruning', () => {
  test('logout revokes the token and a replay is refused', () => {
    seedUsers();
    const token = login('admin', 'secret').token;
    assert.ok(h.props.has('session_' + token));

    assert.deepEqual(h.doGet({ action: 'logout', token }).json, { success: true, revoked: true });
    assert.ok(!h.props.has('session_' + token), 'the stored session must be gone');

    assert.equal(gated({ action: 'setMaintenance', enabled: 'true' }, token).unauthorized, true);
  });

  test('logout is harmless for an unknown or absent token', () => {
    assert.deepEqual(h.doGet({ action: 'logout', token: 'nope' }).json, { success: true, revoked: false });
    assert.deepEqual(h.doGet({ action: 'logout' }).json, { success: true, revoked: false });
  });

  test('an expired token is refused and dropped', () => {
    seedUsers();
    const token = login('admin', 'secret').token;

    h.clock.advanceMs(24 * 60 * 60 * 1000 + 1000);

    assert.equal(gated({ action: 'getActiveUsers' }, token).unauthorized, true);
    assert.ok(!h.props.has('session_' + token), 'an expired token must be deleted on read');
  });

  test('a token one second inside the TTL is still valid', () => {
    seedUsers();
    const token = login('admin', 'secret').token;

    h.clock.advanceMs(24 * 60 * 60 * 1000 - 1000);

    assert.equal(gated({ action: 'getActiveUsers' }, token).unauthorized, undefined);
  });

  test('a corrupt session payload is refused and dropped', () => {
    h.props.setProperty('session_broken', 'not json at all');

    assert.equal(gated({ action: 'setMaintenance' }, 'broken').unauthorized, true);
    assert.ok(!h.props.has('session_broken'));
  });

  test('a session payload with no expiry counts as expired', () => {
    h.props.setProperty('session_nostamp', JSON.stringify({ u: 'admin', role: ADMIN_ROLE }));

    assert.equal(gated({ action: 'setMaintenance' }, 'nostamp').unauthorized, true);
    assert.ok(!h.props.has('session_nostamp'));
  });

  test('pruning drops expired sessions and leaves live ones and the payload cache alone', () => {
    seedUsers();
    const live = login('admin', 'secret').token;

    const past = h.clock.now() - 1000;
    h.props.setProperty('session_old1', JSON.stringify({ u: 'a', role: 'viewer', exp: past }));
    h.props.setProperty('session_old2', JSON.stringify({ u: 'b', role: 'viewer', exp: past }));
    // The oversized-payload cache shares PropertiesService, so a sweep that is
    // not prefix-scoped would be a data-loss bug.
    h.props.setProperty('cache_v2_olt', big(100000));
    h.props.setProperty('cache_v2_olt_cached_at', String(h.clock.now()));

    assert.equal(gated({ action: 'getActiveUsers' }, live).unauthorized, undefined);

    assert.ok(!h.props.has('session_old1'));
    assert.ok(!h.props.has('session_old2'));
    assert.ok(h.props.has('session_' + live), 'the live session must survive');
    assert.equal(h.props.getProperty('cache_v2_olt').length, 100000, 'payload cache untouched');
    assert.ok(h.props.has('cache_v2_olt_cached_at'), 'the payload stamp is untouched');
  });
});

test.describe('login throttling', () => {
  test('five failures lock the username out, and the right password is refused too', () => {
    seedUsers();
    for (let i = 0; i < 5; i++) assert.equal(login('admin', 'wrong').success, false);

    const locked = login('admin', 'secret');
    assert.equal(locked.success, false, 'the correct password must not bypass the lockout');
    assert.equal(locked.locked, true);
    assert.match(locked.message, /Too many failed attempts/);

    assert.deepEqual(sessionKeys(), [], 'a locked-out login must not mint a session');
  });

  test('a locked-out attempt does no work at all', () => {
    seedUsers();
    for (let i = 0; i < 5; i++) login('admin', 'wrong');

    const readsBefore = h.sheetReads();
    login('admin', 'secret');
    assert.equal(h.sheetReads(), readsBefore, 'the lock check must run before the sheet read');
  });

  test('the lockout lapses after its window', () => {
    seedUsers();
    for (let i = 0; i < 5; i++) login('admin', 'wrong');
    assert.equal(login('admin', 'secret').success, false);

    h.clock.advanceMs(5 * 60 * 1000 + 1000);
    assert.equal(login('admin', 'secret').success, true);
  });

  test('one further failure after the window lapses does not instantly re-lock', () => {
    seedUsers();
    for (let i = 0; i < 5; i++) login('admin', 'wrong');

    h.clock.advanceMs(5 * 60 * 1000 + 1000);
    assert.equal(login('admin', 'wrong').success, false, 'still a normal failure');
    assert.equal(login('admin', 'secret').success, true, 'the counter restarted, so no lockout');
  });

  test('a successful login clears the failure counter', () => {
    seedUsers();
    login('admin', 'wrong');
    login('admin', 'wrong');
    assert.ok(h.props.has('loginfail_admin'));

    assert.equal(login('admin', 'secret').success, true);
    assert.ok(!h.props.has('loginfail_admin'), 'the counter must be cleared');
  });

  test('each failure slows down, up to a cap', () => {
    seedUsers();
    for (let i = 0; i < 5; i++) login('admin', 'wrong');

    assert.deepEqual(h.sleeps, [400, 800, 1200, 1600, 2000], 'growing delay, capped at 2s');
  });

  test('a locked-out request does not sleep — it returns before the failure path', () => {
    seedUsers();
    for (let i = 0; i < 5; i++) login('admin', 'wrong');
    const sleepsBefore = h.sleeps.length;

    login('admin', 'secret');
    assert.equal(h.sleeps.length, sleepsBefore, 'the lock path must not sleep');
  });
});

/* ============ 7. TOKENS MUST NOT REACH THE DATA ROUTES ============ */

test.describe('tokens do not touch the data routes', () => {
  test('an un-tokened fetch is unchanged and a bogus token is ignored', () => {
    seedNap([['AREA1', 'PROV1', 5, 2, 1, 8]]);

    const plain = h.doGet({ type: 'nap' });
    assert.equal(plain.json[0].A, 'AREA1');

    h.cache.clear();
    const bogus = h.doGet({ type: 'nap', token: 'bogus' });
    assert.equal(bogus.json[0].A, 'AREA1', 'data routes must never gate on a token');
    assert.equal(bogus.json.unauthorized, undefined);
  });
});
