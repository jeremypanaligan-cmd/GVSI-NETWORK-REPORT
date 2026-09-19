// Focused client tests for the OLT zero state — the "no Down OLT" screen.
//
// This path gets its own suite because it is the tab's DEFAULT view (currentOltFilter
// starts at 'DOWN'), so it is the screen an operator sees most often and the one that
// most needs to be honest. What it replaces: a bare inline-styled <td> plus an early
// `return` that skipped the freshness chip and the export toolbar.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'olt-module.js'), 'utf8');

/* iconMarkup() is a page global — index.html defines it over lucide-icons.js — so the
   sandbox has to carry it the way the browser does. The generated file is loaded for real
   rather than stubbed: the glyph's aria-hidden is asserted below, and a hand-written stub
   would only prove that the stub works. */
const lucide = (function loadGeneratedIcons() {
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lucide-icons.js'), 'utf8'), box);
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
    }
  };
}

function sandbox(options) {
  const o = options || {};
  const nodes = {};
  let tickerCalls = 0;

  const tab = el('div', 'tab-content');
  tab.id = 'tab-olt';
  const strip = el('div', 'filter-toolbar');
  tab.appendChild(strip);
  nodes['tab-olt'] = tab;

  if (o.exportBar !== false) {
    const bar = el('div', 'export-toolbar');
    const csv = el('button', 'export-btn'); csv.textContent = 'Export CSV';
    const pdf = el('button', 'export-btn'); pdf.textContent = 'Export PDF';
    bar.appendChild(csv);
    bar.appendChild(pdf);
    tab.appendChild(bar);
  }

  const wrapper = el('div', 'table-wrapper');
  const card = el('div', 'table-card');
  card.id = 'oltIssuesTableCard';
  card.appendChild(wrapper);
  nodes.oltIssuesTableCard = card;
  nodes.oltTableBody = el('tbody');
  nodes.oltHealthyFleetPanel = el('div');

  const s = {
    console: console,
    BASE_API_URL: 'https://example.test/exec',
    dataCache: { olt: null },
    rawOltData: [],
    getAlertClass: () => '',
    sanitizeHTML: (v) => String(v),
    fetchGate: { refreshTicker: () => { tickerCalls++; } },
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
  vm.createContext(s);
  vm.runInContext(source, s, { filename: 'olt-module.js' });

  s.__nodes = nodes;
  s.__card = card;
  s.__wrapper = wrapper;
  s.__tab = tab;
  s.__strip = strip;
  s.__ticker = () => tickerCalls;
  s.__host = () => card.querySelector('.olt-empty-state-host');
  s.__markup = () => { const h = s.__host(); return h ? h.innerHTML : ''; };
  s.__exportBtns = () => {
    const bar = tab.querySelector('.export-toolbar');
    return bar ? bar.querySelectorAll('button.export-btn') : [];
  };
  return s;
}

function upRow(name) {
  return { S: 'UP', P: 'IFUGAO', M: 'BANAUE', N: name || 'OLT-UP', T: '', DC: '', AG: '', CA: 0, RM: '' };
}
function downRow(name) {
  return { S: 'DOWN', P: 'BENGUET', M: 'ITOGON', N: name || 'OLT-A', T: 'T-1', DC: 'FIBER', AG: '1h', CA: 5, RM: '' };
}

console.log('\nOLT zero state\n');

/* ------------------------------------------------------------------ *
   The zero state itself
 * ------------------------------------------------------------------ */

test('nothing is DOWN: the table leaves the screen and its rows do not linger', () => {
  const s = sandbox();
  s.currentOltFilter = 'DOWN';
  s.oltMeta = { up: 1, down: 1, total: 2 };
  s.rawOltData = [downRow('OLT-A'), upRow()];
  s.renderOltTable();
  assert.ok(s.__nodes.oltTableBody.innerHTML.indexOf('clickable-row') !== -1,
    'the scenario starts with the incident actually rendered');

  /* The same screen one repaint later, when the ticket clears — which is the sequence an
     operator watching a DOWN ticket close actually goes through. */
  s.oltMeta = { up: 2, down: 0, total: 2 };
  s.rawOltData = [upRow(), upRow()];
  s.renderOltTable();

  assert.strictEqual(s.__wrapper.hidden, true, 'the seven-column table leaves the screen');
  assert.strictEqual(s.__host().hidden, false, 'the zero state is what is shown instead');
  assert.strictEqual(s.__nodes.oltTableBody.innerHTML, '',
    'the previous rows must not stay behind under the card');
  assert.ok(s.__markup().indexOf('No Down OLT Right Now') !== -1, 'and it says so in words');
});

test('an OLT goes DOWN again: the table comes back and the card steps aside', () => {
  const s = sandbox();
  s.currentOltFilter = 'DOWN';
  s.oltMeta = { up: 2, down: 0, total: 2 };
  s.rawOltData = [upRow(), upRow()];
  s.renderOltTable();
  assert.strictEqual(s.__wrapper.hidden, true);

  s.oltMeta = { up: 1, down: 1, total: 2 };
  s.rawOltData = [downRow('OLT-B'), upRow()];
  s.renderOltTable();

  assert.strictEqual(s.__wrapper.hidden, false, 'the table returns on its own');
  assert.strictEqual(s.__host().hidden, true, 'the zero state steps aside');
  assert.ok(s.__nodes.oltTableBody.innerHTML.indexOf('OLT-B') !== -1, 'with the new incident in it');
  assert.ok(s.__nodes.oltTableBody.innerHTML.indexOf('total-row') !== -1, 'and its filtered total');
  assert.ok(s.__exportBtns().every((b) => !b.disabled), 'and the export buttons wake up');
});

/* ------------------------------------------------------------------ *
   One card, four different facts
 * ------------------------------------------------------------------ */

test('each partial filter names itself instead of borrowing the DOWN copy', () => {
  const s = sandbox();
  s.oltMeta = { up: 3, down: 0, lowPower: 0, uplinkDown: 0, degradation: 0, total: 3 };
  s.rawOltData = [upRow('OLT-1'), upRow('OLT-2'), upRow('OLT-3')];
  const expected = {
    'LOW POWER': 'No Low Power OLTs',
    'UPLINK DOWN': 'No Uplink Down OLTs',
    'DEGRADATION': 'No Degraded OLTs'
  };

  Object.keys(expected).forEach((filter) => {
    s.currentOltFilter = filter;
    s.renderOltTable();
    assert.ok(s.__markup().indexOf(expected[filter]) !== -1, filter + ' names itself');
    assert.ok(s.__markup().indexOf('No Down OLT Right Now') === -1,
      filter + ' must not borrow the DOWN copy: this filter is empty, the fleet is fine');
  });
});

test('no rows at all is missing data, never good news', () => {
  const s = sandbox();
  s.currentOltFilter = 'ALL';
  s.oltMeta = null;
  s.rawOltData = [];
  s.renderOltTable();

  const m = s.__markup();
  assert.ok(m.indexOf('No OLT data in this snapshot') !== -1, 'it says what happened');
  assert.ok(m.indexOf('REFRESH') !== -1, 'and points at the control that can fix it');
  assert.ok(m.indexOf('No Down OLT Right Now') === -1,
    'calling an empty payload a healthy fleet would be a claim the data does not support');
  assert.ok(m.indexOf('is-missing') !== -1, 'and it must not wear the all-clear green');

  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(/\.olt-empty-state\.is-missing\s+\.olt-empty-icon/.test(css),
    'the neutral variant is styled, or the two cases look identical');
});

test('legacy shape=1 with no meta counts the fleet from the rows', () => {
  const s = sandbox();
  s.currentOltFilter = 'DOWN';
  s.oltMeta = null;
  s.rawOltData = [upRow('OLT-1'), upRow('OLT-2'), { S: 'LOW POWER', P: 'X', M: 'Y', N: 'OLT-LP' }];
  s.renderOltTable();

  const m = s.__markup();
  assert.ok(m.indexOf('2 UP') !== -1, 'two rows report UP');
  assert.ok(m.indexOf('3 TRACKED') !== -1, 'three are tracked');
  assert.ok(m.indexOf('0 DOWN') !== -1, 'and the zero is counted, not assumed');
});

/* ------------------------------------------------------------------ *
   The two duties that used to be skipped
 * ------------------------------------------------------------------ */

test('the freshness chip and the export bar are this function\'s tail, not the table\'s', () => {
  const empty = sandbox();
  empty.currentOltFilter = 'DOWN';
  empty.oltMeta = { up: 1, down: 0, total: 1 };
  empty.rawOltData = [upRow()];
  empty.renderOltTable();

  assert.strictEqual(empty.__ticker(), 1, 'the empty view still refreshes the age chip');
  const btns = empty.__exportBtns();
  assert.strictEqual(btns.length, 2, 'and its export bar still exists to be muted');
  assert.ok(btns.every((b) => b.disabled),
    'muted: a CSV of no rows is a header line, and a PDF of it is this card');
  assert.ok(btns[0].title.indexOf('DOWN') !== -1, 'and it says which filter has nothing');

  const filled = sandbox();
  filled.currentOltFilter = 'DOWN';
  filled.oltMeta = { up: 0, down: 1, total: 1 };
  filled.rawOltData = [downRow('OLT-A')];
  filled.renderOltTable();

  assert.strictEqual(filled.__ticker(), 1, 'the filled view refreshes it too');
  assert.ok(filled.__exportBtns().every((b) => !b.disabled), 'and its export buttons are live');
});

test('a tab with no export bar gets one even when there is nothing to export', () => {
  const s = sandbox({ exportBar: false });
  s.currentOltFilter = 'DOWN';
  s.oltMeta = { up: 1, down: 0, total: 1 };
  s.rawOltData = [upRow()];
  s.renderOltTable();

  const bar = s.__tab.querySelector('.export-toolbar');
  assert.ok(bar, 'the bar is built before it can be muted');
  assert.strictEqual(bar.parentNode, s.__tab, 'and lands in the tab, beside the filter strip');
});

/* ------------------------------------------------------------------ *
   Accessibility, and the stylesheet
 * ------------------------------------------------------------------ */

test('the zero state is a live region and its glyph is not read aloud', () => {
  const s = sandbox();
  s.currentOltFilter = 'DOWN';
  s.oltMeta = { up: 1, down: 0, total: 1 };
  s.rawOltData = [upRow()];
  s.renderOltTable();

  const m = s.__markup();
  assert.ok(m.indexOf('role="status"') !== -1, 'a filter tap that yields nothing is announced');
  assert.ok(m.indexOf('aria-live="polite"') !== -1);
  assert.ok(m.indexOf('aria-hidden="true"') !== -1,
    'the icon is decoration; the sentence under it carries the meaning');
});

test('every token the zero state uses is defined, and it has a phone layout', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  const start = css.indexOf('OLT ZERO STATE');
  assert.ok(start !== -1, 'the zero-state block must exist');
  const end = css.indexOf('DARK MODE SUPPORT', start);
  const block = css.slice(start, end === -1 ? undefined : end);

  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = [...new Set([...block.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))];
  assert.deepStrictEqual(used.filter((v) => !defined.has(v)), [],
    'a var() naming no token drops the whole declaration, silently');

  assert.ok(/@media \(max-width: 640px\)[\s\S]*?\.olt-empty-state/.test(block),
    'and the card has a phone layout of its own');
});

test('the card reports rather than telephones: no action, and a pulse that yields to motion', () => {
  const s = sandbox();
  s.currentOltFilter = 'DOWN';
  s.oltMeta = { up: 457, down: 0, total: 461 };
  s.rawOltData = [upRow('OLT-1'), upRow('OLT-2')];
  s.renderOltTable();

  const m = s.__markup();
  /* The button duplicated the UP card and the UP filter, which open the same list from
     controls that are always on screen. If it comes back here it has to be a decision
     rather than a leftover, and this is what makes it one. */
  assert.ok(m.indexOf('healthy-olt-cta') === -1, 'the zero state carries no button');
  assert.ok(m.indexOf('loadHealthyOltList') === -1, 'nor a call that goes and fetches the fleet');
  assert.ok(m.indexOf('457 UP') !== -1, 'the numbers stay \u2014 they are why the card is read at all');

  const css = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.ok(/\.olt-empty-icon \{[^}]*position: relative/.test(css),
    'the pulse ring needs the circle as its containing block, or it lands at the card corner');
  /* The ring has to animate a name that is DEFINED, checked by reading the name out of the
     rule rather than matching a literal: a substring test passes on
     `@keyframes oltEmptyPulseRenamed`, which is exactly the rename that kills the pulse and
     leaves the card looking correct. */
  const pulseName = (css.match(/\.olt-empty-icon::after \{[^}]*animation:\s*([A-Za-z][\w-]*)/) || [])[1];
  assert.ok(pulseName, 'the pulse ring must animate something');
  assert.ok(new RegExp('@keyframes ' + pulseName + '\\s*\\{').test(css),
    'the animation names "' + pulseName + '", which no @keyframes block defines');

  /* Named in exactly one reduced-motion block, and switched off there rather than slowed:
     a ring that still fades in and out is still motion. */
  const reduce = (css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) || [])
    .filter((b) => b.indexOf('.olt-empty-icon::after') !== -1);
  assert.strictEqual(reduce.length, 1, 'the pulse must be named in one reduced-motion block');
  assert.ok(/animation: none/.test(reduce[0]), 'and switched off there, not slowed down');

  assert.ok(/\.olt-empty-state\.is-missing \.olt-empty-icon::after \{[^}]*opacity: 0/.test(css),
    'the "no rows arrived" card must not pulse \u2014 that would claim something is being watched');
  assert.strictEqual(css.indexOf('.olt-empty-actions'), -1,
    "the button's wrapper is not left behind as dead CSS");
});

setTimeout(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
}, 20);
