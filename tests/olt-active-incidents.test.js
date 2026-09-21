// ==================== OLT ACTIVE INCIDENTS (LANDING VIEW) ====================
//
// Run: node tests/olt-active-incidents.test.js
//
// Focused client tests for the OLT tab's landing view. Three things changed together and
// each one can break the other two silently:
//
//   1. "ALL OLTs" became "Active Incidents" and became the DEFAULT view. The rows were
//      always the incident rows — the server's shape=3 sends nothing else — so the old
//      label was the only thing wrong, and a landing view that renders an empty table over
//      a clean fleet now has to say so.
//   2. A new IMPACT column was inserted after CLIENTS. `sortTable` takes a column index by
//      hand in the markup, so an inserted column that does not renumber the three after it
//      sorts by the wrong cell while looking perfectly correct — and the totals row's
//      colspan has to grow with it or the footer floats over the wrong column.
//   3. Affected Clients (DOWN) became Affected Clients (SA), sourced from the ticket's
//      IMPACT rather than from the row's status.
//   4. The summary row leads with the incident it is named after: TOTAL OLT became ACTIVE
//      INCIDENTS, which is total minus up — the same test the filter and the server's row
//      selection both make — and the six tiles were reordered into the ladder they describe.
//
// The harness is the one tests/olt-empty-state.test.js uses: olt-module.js is loaded for
// real into a vm sandbox with a fake DOM sized to the queries the module actually makes,
// and lucide-icons.js is generated output loaded for real rather than stubbed.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'olt-module.js'), 'utf8');
const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');

const lucide = (function loadGeneratedIcons() {
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lucide-icons.js'), 'utf8'), box);
  return box.window.lucide;
})();

let passed = 0;
let failed = 0;
function test(name, fn) {
  Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); }, (err) => {
    failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message);
  });
}

/* ------------------------------------------------------------------ *
   A fake DOM, sized to the queries olt-module.js actually makes
 * ------------------------------------------------------------------ */

function el(tag, className) {
  return {
    tagName: tag.toUpperCase(),
    className: className || '',
    hidden: false,
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    attrs: {},
    children: [],
    parentNode: null,
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    insertBefore(child) { child.parentNode = this; this.children.push(child); return child; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    querySelector(sel) { const hits = this.querySelectorAll(sel); return hits.length ? hits[0] : null; },
    querySelectorAll(sel) {
      let tag = null;
      let cls = sel.trim();
      const dot = cls.indexOf('.');
      if (dot === 0) cls = cls.slice(1);
      else if (dot > 0) { tag = cls.slice(0, dot).toUpperCase(); cls = cls.slice(dot + 1); }
      return this.children.filter((c) => (!tag || c.tagName === tag) && c.className.split(/\s+/).indexOf(cls) !== -1);
    },
    classList: {
      add(c) { const list = this.className.split(/\s+/).filter(Boolean); if (list.indexOf(c) === -1) list.push(c); this.className = list.join(' '); },
      remove(c) { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return this.className.split(/\s+/).indexOf(c) !== -1; }
    }
  };
}

function sandbox() {
  const nodes = {};

  const tab = el('div', 'tab-content');
  tab.id = 'tab-olt';
  const strip = el('div', 'filter-toolbar');
  tab.appendChild(strip);
  nodes['tab-olt'] = tab;

  const bar = el('div', 'export-toolbar');
  const csv = el('button', 'export-btn'); csv.textContent = 'Export CSV';
  const pdf = el('button', 'export-btn'); pdf.textContent = 'Export PDF';
  bar.appendChild(csv);
  bar.appendChild(pdf);
  tab.appendChild(bar);

  const wrapper = el('div', 'table-wrapper');
  const card = el('div', 'table-card');
  card.id = 'oltIssuesTableCard';
  card.appendChild(wrapper);
  nodes.oltIssuesTableCard = card;
  nodes.oltTableBody = el('tbody');
  nodes.oltHealthyFleetPanel = el('div');

  /* Both card ids are stubbed on purpose: the SA card has to be found under its new id, and
     the old one must stay untouched if it is still in the page. */
  ['oltCardActive', 'oltCardUp', 'oltCardDown', 'oltCardLowPower', 'oltCardUplinkDown',
    'oltCardDegradation', 'oltCardClientsSA', 'oltCardClientsDown'].forEach((id) => {
    nodes[id] = el('div');
  });
  nodes.cardOltDown = el('div');
  nodes.cardOltLowPower = el('div');

  const s = {
    console: console,
    BASE_API_URL: 'https://example.test/exec',
    dataCache: { olt: null },
    getAlertClass: () => '',
    sanitizeHTML: (v) => String(v),
    hideModuleLoading: () => {},
    showModuleLoading: () => {},
    fetchGate: { refreshTicker: () => {} },
    iconMarkup: (name, options) => lucide.icon(name, options),
    document: {
      createElement: (tag) => el(tag),
      getElementById: (id) => nodes[id] || null,
      querySelector: (sel) => {
        const parts = sel.split(' ');
        if (parts.length === 2 && parts[0] === '#tab-olt') return tab.querySelector(parts[1]);
        return null;
      },
      querySelectorAll: () => []
    }
  };
  /* In a vm sandbox the context object IS the global, so `window` pointing back at it is
     what makes `window.fetchGate` the same object the module calls. */
  s.window = s;
  /* `currentOltFilter` and `rawOltData` are declared in index.html, not in the module, so
     the sandbox has to carry them the way the page does — with the very initial value the
     page declares, which is what the landing-view test above pins. */
  s.rawOltData = [];
  s.currentOltFilter = 'ACTIVE';
  vm.createContext(s);
  vm.runInContext(source, s, { filename: 'olt-module.js' });

  s.__nodes = nodes;
  s.__card = card;
  s.__wrapper = wrapper;
  s.__host = () => card.querySelector('.olt-empty-state-host');
  s.__markup = () => { const h = s.__host(); return h ? h.innerHTML : ''; };
  return s;
}

/* ------------------------------------------------------------------ *
   Markup readers — the column contract lives in the static markup
 * ------------------------------------------------------------------ */

function oltHeaderColumns() {
  const re = /onclick="sortTable\('oltTableBody', (\d+), this[^"]*\)">([^<]+)<\/th>/g;
  const cols = [];
  let m;
  while ((m = re.exec(page))) cols.push({ index: Number(m[1]), label: m[2].trim() });
  return cols;
}

function pillMarkup(id) {
  const re = new RegExp('<button class="filter-btn[^"]*" id="' + id + '"[^>]*>[^<]*</button>');
  const m = re.exec(page);
  return m ? m[0] : null;
}

/* The summary tiles, in the order the markup declares them. Read from the static markup
   rather than from a render, because the ORDER is a markup decision: the module writes six
   numbers into ids it looks up by name and would happily write them into any arrangement. */
function oltStatCards() {
  const start = page.indexOf('<div class="olt-stats-grid">');
  const end = page.indexOf('<!-- OLT Status Distribution', start);
  const block = page.slice(start, end);
  return block.split('<div class="stat-card').slice(1).map((chunk) => {
    const label = /<div class="label">([^<]+)<\/div>/.exec(chunk);
    const value = /<div class="value" id="([^"]+)">/.exec(chunk);
    const filter = /onclick="setOltFilter\('([^']+)'\)"/.exec(chunk);
    return {
      label: label ? label[1].trim() : null,
      id: value ? value[1] : null,
      filter: filter ? filter[1] : null,
      attrs: chunk.slice(0, chunk.indexOf('>'))
    };
  });
}

function renderedRows(html) {
  const re = /<tr class="clickable-row[^"]*"[^>]*>([\s\S]*?)<\/tr>/g;
  const out = [];
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function cellLabels(rowHtml) {
  const re = /data-label="([^"]+)"/g;
  const out = [];
  let m;
  while ((m = re.exec(rowHtml))) out.push(m[1]);
  return out;
}

function incidentRow(status, name, impact, clients) {
  return {
    P: 'BENGUET', M: 'ITOGON', N: name, S: status, T: 'TKT-1', AG: '1h', DC: 'FIBER',
    CA: clients === undefined ? 7 : clients, RM: '', IM: impact
  };
}

function upRow(name) {
  return { P: 'IFUGAO', M: 'BANAUE', N: name || 'OLT-UP', S: 'UP', T: '', DC: '', AG: '', CA: 0, RM: '', IM: '' };
}

console.log('\nOLT Active Incidents landing view\n');

/* ------------------------------------------------------------------ *
   1. The landing view
 * ------------------------------------------------------------------ */

test('the toolbar lands on Active Incidents, and nothing still routes to ALL', () => {
  const active = pillMarkup('btnFilterActiveIncidents');
  assert.ok(active, 'the pill must exist in index.html');
  assert.ok(active.indexOf('filter-btn active') !== -1,
    'and it is the one the page loads with highlighted');
  assert.ok(active.indexOf("setOltFilter('ACTIVE')") !== -1);
  assert.ok(active.indexOf('>Active Incidents<') !== -1, 'labelled in the page, not by JS');

  const down = pillMarkup('btnFilterDown');
  assert.ok(down, 'the per-status pills stay: they are how a status is inspected alone');
  assert.strictEqual(down.indexOf('filter-btn active'), -1,
    'DOWN must not load highlighted any more — it is not the landing view');

  assert.ok(page.indexOf('btnFilterAll') === -1, 'the old pill is gone, not merely hidden');
  assert.ok(page.indexOf("let currentOltFilter = 'ACTIVE';") !== -1,
    'the landing view is what the module starts on');
  assert.ok(source.indexOf("currentOltFilter === 'ALL'") === -1, 'no branch still answers to ALL');
  assert.ok(source.indexOf("setOltFilter('ALL'") === -1, 'and nothing still sets it');
});

test('Active Incidents is the four incident statuses, never an UP row', () => {
  const s = sandbox();
  s.currentOltFilter = 'ACTIVE';
  s.oltMeta = { total: 5, up: 1, down: 1, lowPower: 1, uplinkDown: 1, degradation: 1 };
  s.rawOltData = [
    incidentRow('DOWN', 'OLT-DOWN'),
    incidentRow('OLT UPLINK LOW POWER', 'OLT-LP'),
    incidentRow('OLT UPLINK DOWN', 'OLT-UD'),
    incidentRow('OLT SERVICE DEGRADATION', 'OLT-DEG'),
    upRow('OLT-UP-ROW')
  ];
  s.renderOltTable();

  const html = s.__nodes.oltTableBody.innerHTML;
  const rows = renderedRows(html);
  assert.strictEqual(rows.length, 4, 'four incident rows, and only those');
  ['OLT-DOWN', 'OLT-LP', 'OLT-UD', 'OLT-DEG'].forEach((name) => {
    assert.ok(html.indexOf(name) !== -1, name + ' belongs to this view');
  });
  assert.strictEqual(html.indexOf('OLT-UP-ROW'), -1, 'the UP row is not an incident');
  assert.ok(html.indexOf('All OLT Systems Operational') === -1, 'the table is the view when it has rows');
  assert.ok(html.indexOf('FILTERED TOTAL (ACTIVE INCIDENTS)') !== -1,
    'and its footer names the view the way the toolbar does');
});

test('a clean fleet is the all-clear card, not a missing snapshot', () => {
  const s = sandbox();
  s.currentOltFilter = 'ACTIVE';
  s.oltMeta = { total: 461, up: 461, down: 0, lowPower: 0, uplinkDown: 0, degradation: 0, clientsSA: 0 };
  s.rawOltData = [];
  s.renderOltTable();

  assert.strictEqual(s.__wrapper.hidden, true, 'the empty table leaves the screen');
  assert.ok(s.__markup().indexOf('All OLT Systems Operational') !== -1,
    'an empty incident list over a real snapshot is good news and says so');
  assert.ok(s.__markup().indexOf('is-missing') === -1, 'and it is not the neutral variant');

  /* Same empty list, but nothing arrived: the copy must change, because that is a failure
     and not a fleet at peace. */
  s.oltMeta = null;
  s.renderOltTable();
  assert.ok(s.__markup().indexOf('No OLT data in this snapshot') !== -1);
  assert.ok(s.__markup().indexOf('is-missing') !== -1, 'the neutral variant, not the green one');
});

test('the all-clear sentence is written once, so the two views cannot drift', () => {
  const hits = source.match(/All OLT Systems Operational/g) || [];
  assert.strictEqual(hits.length, 1,
    'a second copy of the sentence is how two cards that mean the same thing start disagreeing');
  assert.ok(source.indexOf("'ACTIVE': OLT_ALL_CLEAR_COPY") !== -1, 'the landing view borrows it');
  assert.ok(source.indexOf("'DOWN': OLT_ALL_CLEAR_COPY") !== -1, 'and so does DOWN');
});

/* ------------------------------------------------------------------ *
   2. The IMPACT column
 * ------------------------------------------------------------------ */

test('IMPACT sits right after CLIENTS in the header, and the sort indices follow it', () => {
  const cols = oltHeaderColumns();
  assert.deepStrictEqual(cols.map((c) => c.label),
    ['PROVINCE', 'CITY/MUN', 'OLT NAME', 'CLIENTS', 'IMPACT', 'DT CAUSE', 'AGING', 'INCIDENT']);
  assert.deepStrictEqual(cols.map((c) => c.index), [0, 1, 2, 3, 4, 5, 6, 7],
    'each header sorts by its own position: an inserted column must renumber the ones after it');
});

test('every rendered row lines its cells up with the header', () => {
  const s = sandbox();
  s.currentOltFilter = 'ACTIVE';
  s.rawOltData = [incidentRow('DOWN', 'OLT-DOWN', 'SA', 12)];
  s.renderOltTable();

  const row = renderedRows(s.__nodes.oltTableBody.innerHTML)[0];
  assert.ok(row, 'one incident, one row');
  const labels = cellLabels(row);
  const header = oltHeaderColumns().map((c) => c.label);
  assert.strictEqual(labels.length, header.length,
    'a row with fewer cells than the header shifts every value under the wrong label');
  assert.strictEqual(labels.indexOf('Impact'), 4, 'the IMPACT cell is the fifth');
  assert.strictEqual(labels[labels.indexOf('Impact') - 1], 'Affected Clients',
    'and it comes straight after the clients cell');
});

test('the totals row spans every column the header declares', () => {
  const s = sandbox();
  s.currentOltFilter = 'ACTIVE';
  s.rawOltData = [incidentRow('DOWN', 'OLT-DOWN', 'NSA', 3)];
  s.renderOltTable();

  const html = s.__nodes.oltTableBody.innerHTML;
  const headerCount = oltHeaderColumns().length;
  const m = /<tr class="total-row">([\s\S]*?)<\/tr>/.exec(html);
  assert.ok(m, 'the footer is part of every filled table');
  const colspan = /colspan="(\d+)"/.exec(m[1]);
  const cellsInFooter = (m[1].match(/<td/g) || []).length;
  assert.ok(colspan, 'the label cell spans');
  assert.strictEqual(Number(colspan[1]) + (cellsInFooter - 1), headerCount,
    'colspan + the remaining cells must equal the header width, or the footer floats');
});

test('IMPACT renders SA loudly, NSA quietly, and an absence as an absence', () => {
  const s = sandbox();
  s.currentOltFilter = 'ACTIVE';
  s.rawOltData = [
    incidentRow('DOWN', 'OLT-SA', 'SA', 10),
    incidentRow('DOWN', 'OLT-NSA', 'NSA', 4),
    incidentRow('DOWN', 'OLT-NONE', '', 1),
    incidentRow('OLT UPLINK LOW POWER', 'OLT-LOWER', 'sa', 2)
  ];
  s.renderOltTable();

  const html = s.__nodes.oltTableBody.innerHTML;
  const rows = renderedRows(html);
  assert.ok(rows[0].indexOf('badge badge-red status-chip is-impact">SA<') !== -1,
    'service affecting is the red one');
  assert.ok(rows[1].indexOf('badge badge-gray status-chip is-impact">NSA<') !== -1,
    'the ordinary case is quiet');
  assert.ok(rows[2].indexOf('–') !== -1, 'a missing impact is a dash, never a zero');
  assert.ok(rows[2].indexOf('badge-red">SA<') === -1, 'and never borrows the SA badge');
  assert.ok(rows[3].indexOf('badge badge-red status-chip is-impact">SA<') !== -1,
    'a lower-case cell is normalised');
});

test('every IMPACT value shares one fixed box, and the dash stays outside it', () => {
  const s = sandbox();
  s.rawOltData = [
    incidentRow('DOWN', 'OLT-SA', 'SA', 10),
    incidentRow('DOWN', 'OLT-NSA', 'NSA', 4),
    incidentRow('DOWN', 'OLT-NONE', '', 0)
  ];
  s.renderOltTable();

  const rows = renderedRows(s.__nodes.oltTableBody.innerHTML);
  assert.strictEqual(rows.length, 3, 'three incidents, so three IMPACT cells to compare');
  /* "SA" and "NSA" are one character apart. Without the fixed box each chip is sized by its
     own text, so the badge re-centres on every row whose ticket type changes — the same
     ragged-column problem the INCIDENT cell was given a chip for, one character narrower. */
  assert.strictEqual((rows[0].match(/status-chip is-impact/g) || []).length, 1,
    'a ticket that affects service wears the fixed box');
  assert.strictEqual((rows[1].match(/status-chip is-impact/g) || []).length, 1,
    'and so does one that does not');
  assert.ok(rows[0].indexOf('is-impact">SA<') !== -1 && rows[1].indexOf('is-impact">NSA<') !== -1,
    'both in the same box, so only the label inside it changes');
  assert.strictEqual((rows[2].match(/status-chip is-impact/g) || []).length, 0,
    'a row with no impact keeps the dash: it is the absence of an answer, not a value to align');
});

test('the INCIDENT cell is a fixed-size chip, in the column the header names', () => {
  const s = sandbox();
  s.rawOltData = [
    incidentRow('OLT UPLINK DOWN', 'OLT-UD', 'NSA', 3),
    incidentRow('OLT SERVICE DEGRADATION', 'OLT-DEG', 'SA', 1)
  ];
  s.renderOltTable();

  const rows = renderedRows(s.__nodes.oltTableBody.innerHTML);
  assert.strictEqual(rows.length, 2);
  /* Without the chip every row's badge is sized by its own text, so the four statuses stack
     as four widths and the column is as wide as the longest one. The stylesheet fixes the box
     (tests/status-chip.test.js); this asserts the cell actually wears it. */
  assert.ok(rows[0].indexOf('class="badge badge-yellow status-chip is-long"') !== -1,
    'the incident cell is a fixed-size chip');
  assert.ok(rows[1].indexOf('class="badge badge-purple status-chip is-long"') !== -1);
  /* The mobile layout prints `data-label` where the header is off-screen, so this label IS the
     column name on a phone and has to match the header. */
  assert.strictEqual(cellLabels(rows[0]).indexOf('Incident'), 7, 'labelled for the card layout too');
  assert.strictEqual(cellLabels(rows[0]).indexOf('Status'), -1, 'and not still called Status');
});

test('the INCIDENT cell drops the module prefix from the display, and only the display', () => {
  const s = sandbox();
  s.rawOltData = [
    incidentRow('DOWN', 'OLT-DOWN', 'NSA', 5),
    incidentRow('OLT UPLINK DOWN', 'OLT-UD', 'NSA', 3),
    incidentRow('OLT SERVICE DEGRADATION', 'OLT-DEG', 'SA', 1),
    incidentRow('OLT UPLINK LOW POWER', 'OLT-LP', 'NSA', 2)
  ];
  s.renderOltTable();

  const rows = renderedRows(s.__nodes.oltTableBody.innerHTML);
  assert.strictEqual(rows.length, 4);
  ['DOWN', 'UPLINK DOWN', 'SERVICE DEGRADATION', 'UPLINK LOW POWER'].forEach((label, i) => {
    assert.ok(rows[i].indexOf('>' + label + '<') !== -1, 'the cell reads ' + label);
    assert.strictEqual(rows[i].indexOf('>OLT ' + label + '<'), -1,
      label + ' must not arrive with the module prefix it repeats');
  });
  assert.ok(rows[0].indexOf('>DOWN<') !== -1,
    'DOWN is retained as it is; it carries no prefix to begin with');

  /* The record stays whole: the tooltip is what the sheet reports, and the DATA is what the
     filters and the counts read. A trim that reached the data would break the filters first. */
  assert.ok(rows[2].indexOf('title="OLT SERVICE DEGRADATION"') !== -1,
    'the sheet\'s own wording is one hover away');
  assert.strictEqual(s.rawOltData[2].S, 'OLT SERVICE DEGRADATION',
    'the payload keeps the server vocabulary — the trim is a display transform, not a data one');

  s.setOltFilter('LOW POWER');
  const filtered = renderedRows(s.__nodes.oltTableBody.innerHTML);
  assert.strictEqual(filtered.length, 1, 'and the LOW POWER filter still matches the raw status');
  assert.ok(filtered[0].indexOf('>UPLINK LOW POWER<') !== -1, 'showing the trimmed label');
});

test('the label helper: the three prefixes go, DOWN is retained, blanks stay blank', () => {
  const s = sandbox();

  assert.strictEqual(s.oltIncidentLabel_('OLT UPLINK DOWN'), 'UPLINK DOWN');
  assert.strictEqual(s.oltIncidentLabel_('OLT SERVICE DEGRADATION'), 'SERVICE DEGRADATION');
  assert.strictEqual(s.oltIncidentLabel_('OLT UPLINK LOW POWER'), 'UPLINK LOW POWER');
  assert.strictEqual(s.oltIncidentLabel_(' olt  uplink low power '), 'UPLINK LOW POWER',
    'whitespace and case are normalised before the prefix is removed');
  assert.strictEqual(s.oltIncidentLabel_('DOWN'), 'DOWN');
  /* Pinned deliberately, though the server does not send this string today: DOWN is the one
     status the instruction named as retained, so a "tidy-up" that starts stripping it there
     would be changing a decision rather than removing dead code. */
  assert.strictEqual(s.oltIncidentLabel_('OLT DOWN'), 'OLT DOWN');
  assert.strictEqual(s.oltIncidentLabel_(''), '');
  assert.strictEqual(s.oltIncidentLabel_(undefined), '', 'a missing status must not render as "OLT"');
});

/* ------------------------------------------------------------------ *
   3. Affected Clients (SA)
 * ------------------------------------------------------------------ */

test('the SA card reads clientsSA, not the DOWN total beside it in the same payload', () => {
  const s = sandbox();
  s.oltMeta = {
    total: 461, up: 456, down: 2, lowPower: 1, uplinkDown: 1, degradation: 1,
    clientsDown: 150, clientsSA: 45
  };
  s.rawOltData = [incidentRow('DOWN', 'OLT-DOWN', 'NSA', 150), incidentRow('OLT UPLINK LOW POWER', 'OLT-LP', 'SA', 45)];
  s.processAndRenderOlt();

  assert.strictEqual(s.__nodes.oltCardClientsSA.textContent, 45,
    'the card is scoped by the ticket impact, so the DOWN-only total must not appear');
  assert.notStrictEqual(s.__nodes.oltCardClientsSA.textContent, 150);
  assert.ok(page.indexOf('Affected Clients (SA)') !== -1, 'and the page says which number it is');
  assert.ok(page.indexOf('id="oltCardClientsSA"') !== -1);
});

test('a legacy payload with no summary still counts SA from its own rows', () => {
  const s = sandbox();
  s.oltMeta = null;
  s.rawOltData = [
    incidentRow('DOWN', 'OLT-NSA', 'NSA', 150),
    incidentRow('DOWN', 'OLT-SA', 'SA', 40),
    incidentRow('OLT SERVICE DEGRADATION', 'OLT-DEG-SA', 'SA', 5),
    upRow('OLT-UP')
  ];
  s.processAndRenderOlt();

  assert.strictEqual(s.__nodes.oltCardClientsSA.textContent, 45,
    '40 + 5: an SA ticket counts whatever status its row carries, an NSA one never does');
});

/* ------------------------------------------------------------------ *
   4. The summary tiles: what they count, and the order they sit in
 * ------------------------------------------------------------------ */

test('the ACTIVE INCIDENTS tile counts what the ACTIVE view renders', () => {
  const s = sandbox();
  s.oltMeta = {
    total: 461, up: 457, down: 1, lowPower: 1, uplinkDown: 1, degradation: 1,
    clientsDown: 0, clientsSA: 0
  };
  s.rawOltData = [];
  s.processAndRenderOlt();

  assert.strictEqual(s.__nodes.oltCardActive.textContent, 4,
    '461 - 457: the four rows the server kept, and the same four the table lists');
  assert.notStrictEqual(s.__nodes.oltCardActive.textContent, 461,
    'the fleet size is not the incident count — that is the number this tile replaced');
});

test('a status the four arms do not name still counts as an incident', () => {
  const s = sandbox();
  /* The server's four arms are a hand-written list of the statuses anyone thought of. A row
     the sheet spells differently increments none of them, so a tile built by adding the four
     up would read one fewer than the table — which lists that row like any other. Deriving it
     from total minus up is what makes the tile and the table the same claim. */
  s.oltMeta = { total: 10, up: 7, down: 1, lowPower: 1, uplinkDown: 0, degradation: 0, clientsDown: 0, clientsSA: 0 };
  s.rawOltData = [];
  s.processAndRenderOlt();

  assert.strictEqual(s.__nodes.oltCardActive.textContent, 3,
    '10 - 7 includes the row none of the four arms counted');
});

test('a legacy payload with no summary counts ACTIVE from its own rows', () => {
  const s = sandbox();
  s.oltMeta = null;
  s.rawOltData = [
    upRow('OLT-UP-1'), upRow('OLT-UP-2'),
    incidentRow('DOWN', 'OLT-DOWN', 'NSA', 1),
    incidentRow('OLT UPLINK LOW POWER', 'OLT-LP', 'SA', 2)
  ];
  s.processAndRenderOlt();

  assert.strictEqual(s.__nodes.oltCardActive.textContent, 2,
    'every row that is not UP, counted the way the ACTIVE filter counts it');
});

test('the tiles run UP / ACTIVE INCIDENTS / DOWN, then the three incident types', () => {
  const cards = oltStatCards();

  assert.deepStrictEqual(cards.map((c) => c.label),
    ['UP', 'ACTIVE INCIDENTS', 'DOWN', 'LOW POWER', 'UPLINK DOWN', 'SERVICE DEGRADATION'],
    'the ladder reads left to right, top to bottom: the fleet, then what makes up the middle');
  assert.strictEqual(cards.filter((c) => c.label === 'TOTAL OLT').length, 0,
    'the fleet-size tile is gone from this row; the donut centre still reports the total');
  assert.strictEqual(cards.filter((c) => c.id === 'oltCardTotal').length, 0,
    'and its id went with it, so nothing can quietly keep writing the old number into it');

  assert.strictEqual(cards[1].id, 'oltCardActive',
    'the middle tile is the one the module writes the derived count into');
  assert.strictEqual(cards[1].filter, 'ACTIVE',
    'and it opens the view it counts, not the DOWN filter beside it');
  assert.ok(/c-total/.test(cards[1].attrs),
    'it keeps the aggregate colour, so a clean fleet is not dressed as an alarm');

  /* The tile that opens the DEGRADATION filter is named the way the INCIDENT column names
     the incident. The TOKEN is untouched — it is what the filter matches and what the sort
     and the export agree on — so a rename that reached it would empty the view it opens. */
  assert.strictEqual(cards[5].label, 'SERVICE DEGRADATION');
  assert.strictEqual(cards[5].filter, 'DEGRADATION');
});

test('the two long tile labels wrap inside the tile instead of leaving it', () => {
  /* Two of the six labels — ACTIVE INCIDENTS and SERVICE DEGRADATION — are wider than a
     third of a phone, and the rule every tile shares is `nowrap`. The rule below is the
     reason they wrap instead of spilling out of the tile, and it is scoped to this grid
     because every other tab's tiles still hold their labels on one line. */
  const scoped = /\.olt-stats-grid \.stat-card \.label\s*\{([^}]*)\}/.exec(css);
  assert.ok(scoped, 'the tiles need a rule of their own; the shared one cannot be changed');
  assert.ok(/white-space:\s*normal/.test(scoped[1]),
    'without this the longest label is clipped by the tile edge instead of wrapping');
  assert.ok(/align-items:\s*flex-end/.test(scoped[1]),
    'and the labels are bottom-aligned, so the six values share one baseline either way');

  /* The reserve has to be exactly the two lines it is holding. Shorter and a wrapped label
     pushes its value down; taller and every tile in the tab grows for a line that is not
     there — which is why it is pinned to the line-height rather than to a pixel count. */
  const reserve = /min-height:\s*([\d.]+)em/.exec(scoped[1]);
  const lineHeight = /line-height:\s*([\d.]+)/.exec(scoped[1]);
  assert.ok(reserve && lineHeight, 'the reserve and the line it counts must both be declared');
  assert.strictEqual(Number(reserve[1]), Number(lineHeight[1]) * 2,
    'two lines, measured in the label\'s own line-height');

  const shared = /\n\.stat-card \.label \{([^}]*)\}/.exec(css);
  assert.ok(shared && /white-space:\s*nowrap/.test(shared[1]),
    'and the shared rule keeps its one-line promise for the tabs that can afford it');
});

/* ------------------------------------------------------------------ */

setTimeout(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed === 0 ? 0 : 1);
}, 10);
