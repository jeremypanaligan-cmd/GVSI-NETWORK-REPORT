// Tests for the Lucide icon migration.
//
// The app is a static PWA with no bundler, so "using the package" means a generated file:
// scripts/build-icons.mjs reads node_modules/lucide and writes lucide-icons.js, which is
// committed and precached. That indirection is the thing worth testing, because every way
// it can fail is silent — an icon name that is not in the table renders as nothing at all,
// and a table that drifts from the package renders yesterday's geometry forever.
//
// So this suite guards both ends: the generated file against the package it came from, and
// every call site against the table.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const GENERATED = 'lucide-icons.js';
/* Normalized on read for the same reason as read() below: git hands a Windows checkout
   CRLF, and nothing here is about newlines. */
const onDisk = fs.readFileSync(path.join(ROOT, GENERATED), 'utf8').replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;
function test(name, fn) {
  Promise.resolve().then(fn).then(() => { passed++; console.log('  PASS  ' + name); }, (err) => {
    failed++; console.log('  FAIL  ' + name); console.log('        ' + err.message);
  });
}

/* Every source file that can name an icon. Read from the directory rather than listed, so
   a new module that forgets the table fails here instead of shipping a blank glyph. */
const APP_FILES = fs
  .readdirSync(ROOT)
  .filter((f) => /\.(js|html|css)$/.test(f) && f !== GENERATED && !f.startsWith('_'));

/* The sorted-header chevrons are never named in app code: lucide.sortIndicator() names them
   inside the generated runtime, because the indicator is a CSS pseudo-element on 38 headers
   rather than markup. */
const RUNTIME_ONLY = ['chevron-down', 'chevron-up', 'chevrons-up-down'];

/* The GALLOPVISION mark in the login panel is drawn by hand: it is the brand, not an
   interface glyph, and no Lucide icon stands in for it. It is the only svg left in the
   app's own markup — everything else is emitted from the table at runtime. */
const BRAND_MARK = '<div class="brand-logo">';

/* Git stores these files with LF and, under `core.autocrlf`, checks them out with CRLF.
   Every check here is about CONTENT — a name, a rule, a path — so newlines are normalized
   on read rather than allowed to decide whether the suite is green on one platform. */
function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
}

/* The drift check needs the package the file was generated from, and node_modules is
   gitignored: a fresh clone is runnable and testable WITHOUT it, because the generated
   file is committed. So its absence skips that one check with a reason, rather than
   failing the suite and training the reader to ignore red. Everything that does not need
   the package — every call-site scan below — still runs. */
const ICON_PACKAGE = path.join(ROOT, 'node_modules', 'lucide', 'package.json');
const hasPackage = fs.existsSync(ICON_PACKAGE);

function loadRuntime() {
  const box = { window: {} };
  vm.createContext(box);
  vm.runInContext(onDisk, box, { filename: GENERATED });
  return box.window.lucide;
}

/* ------------------------------------------------------------------ *
   The generated file, against the package it came from
 * ------------------------------------------------------------------ */

console.log('\nLucide icons\n');

test('lucide-icons.js is what the generator produces from the installed package', async () => {
  if (!hasPackage) {
    console.log('        skipped: node_modules/lucide is not installed (npm install)');
    return;
  }
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'scripts', 'build-icons.mjs')).href);
  } catch (err) {
    throw new Error('cannot load scripts/build-icons.mjs: ' + err.message);
  }
  const expected = await mod.generate();
  assert.strictEqual(
    onDisk,
    mod.normalizeNewlines(expected),
    'lucide-icons.js is out of date — run: npm run icons:build'
  );
});

test('the generated file says it is generated, and carries the licence', () => {
  assert.ok(onDisk.indexOf('GENERATED FILE') !== -1, 'no "generated" header');
  assert.ok(onDisk.indexOf('ISC') !== -1, 'the ISC attribution is required by the licence');
  assert.ok(onDisk.indexOf('lucide') !== -1, 'no provenance');
});

test('the subset stays a subset — the shipped bundle would be ten times this', () => {
  /* The UMD bundle in node_modules is ~436 KB. Committing that would put it in front of
     every device on every generation, for 31 glyphs. */
  assert.ok(onDisk.length < 60000, 'lucide-icons.js is ' + onDisk.length + ' bytes — too big');
});

test('node_modules stays out of git, so the icon tree cannot be committed by accident', () => {
  const ignore = read('.gitignore');
  assert.ok(ignore.indexOf('\nnode_modules/') !== -1, 'no node_modules/ rule in .gitignore');
});

/* ------------------------------------------------------------------ *
   Every call site, against the table
 * ------------------------------------------------------------------ */

test('every [data-lucide] placeholder names an icon that exists', () => {
  const names = loadRuntime().names;
  const html = read('index.html');
  const used = [];
  let m;
  const re = /data-lucide="([^"]+)"/g;
  while ((m = re.exec(html)) !== null) used.push(m[1]);
  assert.ok(used.length >= 15, 'only ' + used.length + ' placeholders found — did the scan break?');
  used.forEach((name) => {
    assert.ok(names.indexOf(name) !== -1, `index.html asks for "${name}", which is not in the table`);
  });
});

test('every iconMarkup() call names an icon that exists', () => {
  const names = loadRuntime().names;
  let total = 0;
  APP_FILES.forEach((file) => {
    const src = read(file);
    const re = /iconMarkup\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      total++;
      assert.ok(
        names.indexOf(m[1]) !== -1,
        `${file} calls iconMarkup('${m[1]}'), which is not in the table`
      );
    }
  });
  assert.ok(total >= 26, 'only ' + total + ' iconMarkup calls found — did the scan break?');
});

test('the table carries no dead weight — every icon is used or is a sort chevron', () => {
  const names = loadRuntime().names;
  const used = {};
  const collect = (src) => {
    let m;
    const a = /data-lucide="([^"]+)"/g;
    while ((m = a.exec(src)) !== null) used[m[1]] = true;
    const b = /iconMarkup\(\s*'([^']+)'/g;
    while ((m = b.exec(src)) !== null) used[m[1]] = true;
  };
  APP_FILES.forEach((file) => collect(read(file)));
  RUNTIME_ONLY.forEach((name) => { used[name] = true; });
  /* Spread first: `names` comes out of the vm realm, and deepStrictEqual compares
     prototypes — an array from another realm never equals a literal here. */
  const unused = [...names].filter((name) => !used[name]);
  assert.deepStrictEqual(unused, [], 'in the table but drawn nowhere: ' + unused.join(', '));
});

test('no inline svg survives in the app — except the brand mark', () => {
  const offenders = [];
  APP_FILES.forEach((file) => {
    const src = read(file);
    const count = (src.match(/<svg/g) || []).length;
    if (!count) return;
    if (file !== 'index.html') {
      offenders.push(`${file} (${count})`);
      return;
    }
    /* One is allowed, and it has to be the one: the mark inside .brand-logo. */
    assert.strictEqual(count, 1, 'index.html has ' + count + ' inline svgs, expected 1');
    const at = src.indexOf('<svg');
    const before = src.slice(Math.max(0, at - 400), at);
    assert.ok(
      before.indexOf(BRAND_MARK) !== -1,
      'the one remaining svg in index.html is not the brand mark'
    );
  });
  assert.deepStrictEqual(offenders, [], 'inline svg left in: ' + offenders.join(', '));
});

test('styles.css holds no icon geometry — the paths live in the generated file', () => {
  const css = read('styles.css');
  assert.ok(css.indexOf('data:image') === -1, 'an icon was embedded in CSS as a data URI');
  assert.ok(!/\sd="M/.test(css), 'hand-written path data in styles.css');
});

test('the generated script is loaded before every module that draws an icon', () => {
  const html = read('index.html');
  const lucideAt = html.indexOf('<script src="lucide-icons.js">');
  assert.ok(lucideAt !== -1, 'index.html never loads lucide-icons.js');
  const drawers = [
    'db.js', 'fetch-gate.js', 'rev-watch.js', 'notifications.js', 'nap-module.js',
    'lcp-module.js', 'olt-module.js', 'node-module.js', 'backbone-module.js',
    'analytics-module.js', 'admin-module.js'
  ];
  drawers.forEach((file) => {
    const at = html.indexOf('<script src="' + file + '">');
    assert.ok(at !== -1, 'index.html does not load ' + file);
    assert.ok(at > lucideAt, file + ' is loaded before lucide-icons.js');
  });
  /* iconMarkup() is defined by the page script, and the modules call it at render time —
     after this file has run. It must not be used while the modules load. */
  assert.ok(
    html.indexOf('function iconMarkup') !== -1,
    'iconMarkup() is not defined in index.html'
  );
});

test('the service worker precaches the generated file, or devices never get icons', () => {
  const sw = read('sw.js');
  assert.ok(
    sw.indexOf("'./lucide-icons.js'") !== -1,
    'lucide-icons.js is not in STATIC_ASSETS'
  );
});

/* ------------------------------------------------------------------ *
   The runtime
 * ------------------------------------------------------------------ */

test('icon() paints with currentColor at the size asked for', () => {
  const glyph = loadRuntime().icon('download', { size: 14 });
  assert.ok(glyph.indexOf('width="14"') !== -1, 'size ignored: ' + glyph.slice(0, 120));
  assert.ok(glyph.indexOf('height="14"') !== -1, 'size ignored');
  assert.ok(glyph.indexOf('stroke="currentColor"') !== -1, 'not theme-coloured');
  assert.ok(glyph.indexOf('fill="none"') !== -1, 'Lucide icons are stroked, not filled');
  assert.ok(glyph.indexOf('class="lucide-icon"') !== -1, 'missing the shared class');
  assert.ok(glyph.indexOf('viewBox="0 0 24 24"') !== -1, 'wrong viewBox');
  assert.ok(glyph.indexOf('<path') !== -1, 'no geometry');
});

test('icon() honours strokeWidth, className, id and style overrides', () => {
  const glyph = loadRuntime().icon('circle-check-big', {
    size: 40,
    strokeWidth: 1.8,
    className: 'big',
    id: 'glyph',
    style: 'color: var(--badge-green-text)'
  });
  assert.ok(glyph.indexOf('stroke-width="1.8"') !== -1, 'strokeWidth not applied');
  assert.strictEqual(
    (glyph.match(/stroke-width=/g) || []).length,
    1,
    'stroke-width emitted twice — the first one wins in HTML and the override would be lost'
  );
  assert.ok(glyph.indexOf('class="lucide-icon big"') !== -1, 'className not merged');
  assert.ok(glyph.indexOf('id="glyph"') !== -1, 'id not applied');
  assert.ok(glyph.indexOf('style="color: var(--badge-green-text)"') !== -1, 'style not applied');
});

test('an unknown name renders nothing instead of throwing', () => {
  /* A typo or a stale table must cost one glyph, never the screen it sits on. */
  assert.strictEqual(loadRuntime().icon('no-such-icon'), '');
  assert.strictEqual(loadRuntime().icon('no-such-icon', { size: 20 }), '');
});

test('icons are hidden from assistive tech unless they are the label', () => {
  const audible = loadRuntime();
  assert.ok(audible.icon('bell').indexOf('aria-hidden="true"') !== -1, 'decoration is not hidden');
  const labelled = audible.icon('bell', { ariaHidden: false, label: 'Notifications on' });
  assert.ok(labelled.indexOf('role="img"') !== -1, 'a labelled icon is not exposed');
  assert.ok(labelled.indexOf('aria-label="Notifications on"') !== -1, 'label dropped');
  assert.ok(labelled.indexOf('aria-hidden') === -1, 'an exposed icon is also hidden');
});

test('createIcons carries id, class and style onto the svg it builds', () => {
  /* togglePasswordVisibility() flips #eyeIcon/#eyeOffIcon by id and the hidden one carries
     display:none inline, so the swap has to preserve both or the field loses its toggle. */
  function placeholder(attrs) {
    return {
      id: attrs.id || '',
      className: attrs.class || '',
      _html: null,
      _removed: false,
      parentNode: { removeChild() { this._removed = true; } },
      getAttribute(k) { return attrs[k] === undefined ? null : String(attrs[k]); },
      insertAdjacentHTML(_pos, html) { this._html = html; }
    };
  }
  const hosts = [
    placeholder({ 'data-lucide': 'eye', 'data-size': '20', id: 'eyeIcon' }),
    placeholder({ 'data-lucide': 'eye-off', 'data-size': '20', id: 'eyeOffIcon', style: 'display:none;' }),
    placeholder({ 'data-lucide': 'arrow-right', 'data-size': '20', class: 'btn-arrow' })
  ];
  const removed = [];
  hosts.forEach((h) => {
    h.parentNode.removeChild = () => removed.push(h.id || h.className);
  });
  loadRuntime().createIcons({ querySelectorAll: () => hosts });

  assert.strictEqual(removed.length, 3, 'the placeholders were left in the page as well');
  assert.ok(hosts[0]._html.indexOf('id="eyeIcon"') !== -1, 'eyeIcon lost its id');
  assert.ok(hosts[1]._html.indexOf('id="eyeOffIcon"') !== -1, 'eyeOffIcon lost its id');
  assert.ok(hosts[1]._html.indexOf('display:none;') !== -1, 'the hidden eye came back visible');
  assert.ok(hosts[2]._html.indexOf('class="lucide-icon btn-arrow"') !== -1, 'btn-arrow class dropped');
  hosts.forEach((h, i) => {
    assert.ok(h._html.indexOf('width="20"') !== -1, 'placeholder ' + i + ' lost its size');
  });
});

test('createIcons leaves anything that is not a placeholder alone', () => {
  /* Called on every boot, so it has to be safe on a document that has already been through
     it — the modules' own svgs must not be mistaken for placeholders. */
  const hosts = [];
  const scope = { querySelectorAll: () => hosts };
  loadRuntime().createIcons(scope);
  assert.strictEqual(hosts.length, 0);
  loadRuntime().createIcons(scope);
});

test('sortIndicator injects masked chevrons once, and keeps currentColor', () => {
  const head = { children: [], appendChild(node) { this.children.push(node); } };
  const document = {
    head,
    createElement: () => ({ id: '', tagName: 'STYLE', textContent: '' }),
    getElementById: (id) => head.children.filter((n) => n.id === id)[0] || null
  };
  const box = { window: {}, document };
  vm.createContext(box);
  vm.runInContext(onDisk, box, { filename: GENERATED });

  box.window.lucide.sortIndicator();
  box.window.lucide.sortIndicator();
  assert.strictEqual(head.children.length, 1, 'the sort rules were injected twice');

  const css = head.children[0].textContent;
  ['th.sortable::after', 'th.sort-asc::after', 'th.sort-desc::after'].forEach((sel) => {
    assert.ok(css.indexOf(sel) !== -1, 'no rule for ' + sel);
  });
  assert.ok(css.indexOf('background-color:currentColor') !== -1, 'the mask is not theme-coloured');
  assert.ok(css.indexOf('mask:url("data:image/svg+xml,') !== -1, 'no mask in the rules');
  assert.ok(css.indexOf('%3Csvg') !== -1, 'the mask is not an encoded svg');
  assert.ok(css.indexOf('%23000') !== -1, 'the mask stroke is not encoded (raw # breaks a data URI)');
  assert.ok(css.indexOf('content:""') !== -1, 'the injected rules must clear the text glyph');
});

test('the runtime exposes only what the app calls', () => {
  const lucide = loadRuntime();
  assert.deepStrictEqual(
    Object.keys(lucide).sort(),
    ['createIcons', 'icon', 'names', 'sortIndicator'],
    'the generated runtime grew a surface the app does not use'
  );
});

/* ------------------------------------------------------------------ *
   Run
 * ------------------------------------------------------------------ */

setTimeout(() => {
  console.log('\n  ' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
}, 200);
