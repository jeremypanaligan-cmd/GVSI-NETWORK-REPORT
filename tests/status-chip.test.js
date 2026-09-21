// ============== FIXED-SIZE CHIPS: OLT INCIDENT / BACKBONE SERVICE / OLT IMPACT ==============
//
// Run: node tests/status-chip.test.js
//
// Three columns hold data-driven labels, so a chip sized by its own text gives every row a
// different box — and it lets the longest label set the column width, so the table resizes
// itself whenever the mix of incidents changes. The OLT halves are asserted where they are
// rendered (tests/olt-active-incidents.test.js, which already has the OLT sandbox); this
// file covers the stylesheet contract and the Backbone half, which has no other suite.
//
// What is actually being pinned, none of which a screenshot of one row can show:
//
//   1. The rule fixes a WIDTH and a HEIGHT, and no minimum. `min-width` is the tempting
//      version of this and it is the one that does not work: a minimum still lets the
//      longest label drag the column wider, which is the whole thing being fixed.
//   2. The three columns get different widths on purpose — SERVICE holds four characters
//      (DWDM, MPLS), IMPACT holds up to three (SA, NSA), INCIDENT holds phrases up to twenty.
//   3. The Backbone cell actually carries the class and keeps the full label in `title`,
//      because a label that wraps to a second line must not become a truncation.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
const backboneSource = fs.readFileSync(path.join(ROOT, 'backbone-module.js'), 'utf8');

const lucide = (function loadGeneratedIcons() {
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lucide-icons.js'), 'utf8'), box);
  return box.window.lucide;
})();

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

/* The body of one rule, anchored to the start of a line so `.status-chip` cannot be found
   inside `.status-chip.is-long` — the same prefix is a substring of the modifier, and a
   match there would read the WRONG block's width as the base's. */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp('(^|\\n)' + escaped + '\\s*\\{([^}]*)\\}').exec(css);
  return m ? m[2] : null;
}

function em(body, property) {
  const m = new RegExp(property + ':\\s*([\\d.]+)em').exec(body || '');
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ *
   The Backbone half, rendered
 * ------------------------------------------------------------------ */

function backboneSandbox() {
  /* renderBackboneReport only ever asks for the tab, and the export bar is skipped because
     `.table-card` resolves to null — enough to reach the rows, which is all this test reads. */
  const tab = { innerHTML: '', querySelector: () => null };
  const s = {
    console: console,
    hideModuleLoading: () => {},
    sanitizeHTML: (v) => String(v),
    iconMarkup: (name, options) => lucide.icon(name, options),
    fetchGate: { refreshTicker: () => {} },
    document: {
      getElementById: (id) => (id === 'tab-backbone' ? tab : null),
      createElement: () => ({ innerHTML: '', className: '', querySelector: () => null })
    }
  };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(backboneSource, s, { filename: 'backbone-module.js' });
  s.__tab = tab;
  return s;
}

const BB_ROWS = [
  { P: 'PANGASINAN', S: 'DWDM', IS: 'LINK DOWN', I: 'NSA', DT: '-', AG: '2h', L: 'A TO B VIA HT2 DWDM', LC: 2, T: 'T-1', RM: '-' },
  { P: 'BENGUET', S: 'NPE', IS: 'UPLINK LOW POWER', I: 'SA', DT: '-', AG: '1h', L: 'X LINK TO Y', LC: 1, T: 'T-2', RM: '-' },
  { P: 'ABRA', S: '', IS: '', I: '-', DT: '-', AG: '-', L: '', LC: 0, T: 'T-3', RM: '-' }
];

console.log('\nFixed-size STATUS / SERVICE chips\n');

/* ------------------------------------------------------------------ *
   1. The stylesheet contract
 * ------------------------------------------------------------------ */

test('the chip fixes a width AND a height — never a minimum', () => {
  const base = ruleBody('.status-chip');
  assert.ok(base, 'the rule must exist, and be written as its own block');

  assert.strictEqual(typeof em(base, 'width'), 'number',
    'a fixed width is the point; min-width still lets the longest label widen the column');
  assert.strictEqual(typeof em(base, 'height'), 'number',
    'and a fixed height, so a chip that wraps to a second line is the same box as one that does not');
  assert.ok(!/min-width/.test(base), 'a minimum is the version of this that does not work');
  assert.ok(/justify-content:\s*center/.test(base), 'and the label sits centred in the box');
  assert.ok(/title/.test(backboneSource), 'the full label is kept on the element, not only drawn in the box');
});

test('each column gets the width its own vocabulary needs, and none of them drifts', () => {
  const base = em(ruleBody('.status-chip'), 'width');
  const wide = em(ruleBody('.status-chip.is-long'), 'width');
  const narrow = em(ruleBody('.status-chip.is-impact'), 'width');

  assert.strictEqual(typeof wide, 'number', 'the OLT INCIDENT variant must declare its own width');
  assert.ok(wide > base,
    'SERVICE holds four characters (DWDM, MPLS) and INCIDENT holds phrases up to twenty; ' +
    'one width for both would either clip the phrases or leave the service column padded out');
  assert.ok(base >= 4, 'and the base must still hold a four-character service label');
  assert.ok(!/min-width/.test(ruleBody('.status-chip.is-impact')),
    'IMPACT is fixed too: a minimum is the version of this that does not work');
  assert.strictEqual(typeof narrow, 'number', 'IMPACT must declare a width of its own');
  assert.ok(narrow < base,
    'SA and NSA are one character apart and the shortest vocabulary of the three; the service ' +
    'width would pad the chip out and, at its narrowest, widen the column past its header');
  assert.ok(narrow >= 3.6,
    'and it must still hold NSA plus the horizontal padding on one line');
});

/* ------------------------------------------------------------------ *
   2. The Backbone SERVICE cell
 * ------------------------------------------------------------------ */

test('every SERVICE cell carries the chip, with its own label in the title', () => {
  const s = backboneSandbox();
  s.renderBackboneReport(BB_ROWS);
  const html = s.__tab.innerHTML;

  assert.ok(html.indexOf('class="badge badge-purple status-chip" title="DWDM"') !== -1,
    'a DWDM row is a fixed box, not one sized by its own label');
  assert.ok(html.indexOf('title="MPLS"') !== -1,
    'NPE is reported as MPLS, and the title shows what the cell shows');
  assert.strictEqual((html.match(/status-chip/g) || []).length, 3,
    'all three rows, including the one with no service at all');
  assert.ok(/title="-"/.test(html), 'a missing service keeps the chip rather than dropping out of the column');
});

test('the chip is the only thing added to the cell — the value and its colour are untouched', () => {
  const s = backboneSandbox();
  s.renderBackboneReport(BB_ROWS);
  const html = s.__tab.innerHTML;

  assert.ok(/<td data-label="Service" style="text-align: center;"><span class="badge badge-purple status-chip"/.test(html),
    'the cell keeps its label, its alignment and its per-service colour class');
  assert.ok(html.indexOf('>DWDM<') !== -1 && html.indexOf('>MPLS<') !== -1,
    'and the rendered text is still the value the CSV export reads out of the DOM');
  assert.ok(html.indexOf('badge-gray status-chip') !== -1, 'the unclassified service keeps its gray badge');
});

/* ------------------------------------------------------------------ */

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
