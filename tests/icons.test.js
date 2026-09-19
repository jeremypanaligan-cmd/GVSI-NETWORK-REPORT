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

/* One glyph per module, read out of index.html rather than restated here: the point of the
   test is that the map and the markup agree, which it cannot check if it carries its own
   copy of the map. */
const MODULE_ICONS = (function parseModuleIcons() {
  const src = read('index.html');
  const m = src.match(/const MODULE_ICONS = (\{[\s\S]*?\n\};)/);
  assert.ok(m, 'MODULE_ICONS is not defined in index.html');
  return vm.runInNewContext('(' + m[1].replace(/;$/, '') + ')');
})();

test('every iconMarkup() call names an icon that exists', () => {
  const names = loadRuntime().names;
  let total = 0;
  APP_FILES.forEach((file) => {
    const src = read(file);
    const re = /(?<!Module)iconMarkup\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      total++;
      assert.ok(
        names.indexOf(m[1]) !== -1,
        `${file} calls iconMarkup('${m[1]}'), which is not in the table`
      );
    }
  });
  assert.ok(total >= 20, 'only ' + total + ' iconMarkup calls found — did the scan break?');
});

test('every moduleIconMarkup() call names a module in MODULE_ICONS', () => {
  const names = loadRuntime().names;
  let total = 0;
  APP_FILES.forEach((file) => {
    const src = read(file);
    const re = /moduleIconMarkup\(\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      total++;
      const icon = MODULE_ICONS[m[1]];
      assert.ok(icon, `${file} calls moduleIconMarkup('${m[1]}'), which is not a module`);
      assert.ok(names.indexOf(icon) !== -1, `module ${m[1]} maps to \"${icon}\", not in the table`);
    }
  });
  assert.ok(total >= 5, 'only ' + total + ' moduleIconMarkup calls found — did the scan break?');
});

test('both nav bars show the glyph MODULE_ICONS gives that module', () => {
  /* The two bars are static markup and cannot call the map, so they carry placeholders by
     hand. That is the whole reason this test exists: a module named with one glyph in the
     bottom bar and another in the tab row is exactly the failure the map prevents, and
     nothing else in the app would notice it. */
  const html = read('index.html');

  /* The tab row identifies its tab by label (it has no data-tab), the bottom bar by
     data-tab. Both spellings are mapped to the same module keys. */
  const LABEL_TO_KEY = {
    NAP: 'nap', LCP: 'lcp', OLT: 'olt', NODE: 'node',
    BACKBONE: 'backbone', 'BACKBONE LINKS': 'backbone',
    CHARTS: 'analytics', ANALYTICS: 'analytics', ABOUT: 'about', ADMIN: 'admin'
  };

  const bottom = {};
  const tabRow = {};
  let m;

  /* The whole attribute blob is captured, not just the glyph, so data-module can be read off
     the SAME element the glyph came from — reading the two attributes with separate regexes
     would let a button borrow another module's colour without borrowing its glyph. */
  const bottomRe = /<button class="bottom-nav-btn[^"]*"([^>]*)>[\s\S]{0,140}?<i data-lucide="([^"]+)"/g;
  while ((m = bottomRe.exec(html)) !== null) {
    const tab = /\bdata-tab="([a-z]+)"/.exec(m[1]);
    assert.ok(tab, 'a bottom nav button has no data-tab: ' + m[1]);
    bottom[tab[1]] = { icon: m[2], module: (/\bdata-module="([a-z]+)"/.exec(m[1]) || [])[1] || null };
  }

  const tabRowRe = /<button class="tab-btn[^"]*"([^>]*)>\s*<span class="tab-icon"><i data-lucide="([^"]+)"[^>]*><\/i><\/span>([A-Z ]+)</g;
  while ((m = tabRowRe.exec(html)) !== null) {
    const key = LABEL_TO_KEY[m[3].trim()];
    assert.ok(key, 'the tab row has a tab whose label maps to no module: ' + m[3].trim());
    tabRow[key] = { icon: m[2], module: (/\bdata-module="([a-z]+)"/.exec(m[1]) || [])[1] || null };
  }

  /* The UNION, not just the map's keys: driven off the map alone, a module dropped from it
     would simply stop being checked, and the two bars would keep rendering whatever they
     were told by hand. Every name seen anywhere has to exist in the map and agree with it. */
  const keys = [...Object.keys(MODULE_ICONS), ...Object.keys(bottom), ...Object.keys(tabRow)]
    .filter((key, i, all) => all.indexOf(key) === i);

  assert.ok(keys.length >= 8, 'only ' + keys.length + ' modules found — did the scan break?');
  keys.forEach((key) => {
    const expected = MODULE_ICONS[key];
    assert.ok(expected, `MODULE_ICONS has no entry for "${key}"`);
    assert.ok(bottom[key], `the bottom bar has no button for data-tab="${key}"`);
    assert.strictEqual(bottom[key].icon, expected, `bottom bar: ${key} shows "${bottom[key].icon}", the map says "${expected}"`);
    assert.ok(tabRow[key], `the tab row has no button for ${key}`);
    assert.strictEqual(tabRow[key].icon, expected, `tab row: ${key} shows "${tabRow[key].icon}", the map says "${expected}"`);

    /* Same key in both bars, because styles.css colours the glyph off data-module: a bar
       whose key is missing or misspelled draws its icon in the muted fallback, which looks
       deliberate and is therefore the hardest kind of wrong to notice. */
    if (key === 'admin') {
      assert.strictEqual(bottom[key].module, null, 'the admin chip paints its own gradient and must not take a hue');
      assert.strictEqual(tabRow[key].module, null, 'the admin chip paints its own gradient and must not take a hue');
      return;
    }
    assert.strictEqual(bottom[key].module, key, `bottom bar: ${key} carries data-module="${bottom[key].module}"`);
    assert.strictEqual(tabRow[key].module, key, `tab row: ${key} carries data-module="${tabRow[key].module}"`);
  });
});

test('every module hue is declared once, for both themes, and reaches both nav bars', () => {
  /* A module's colour is the thing that makes its glyph readable at a glance, so it has to
     exist in light AND dark (a light-mode hue on the dark header is close to invisible), and
     it has to reach both bars through the one rule that sets it — not through two rules that
     can be edited apart. */
  const css = read('styles.css');

  const themeBlock = (header) => {
    const at = css.indexOf(header);
    assert.ok(at !== -1, 'no ' + header.trim() + ' block in styles.css');
    const open = css.indexOf('{', at);
    return css.slice(open, css.indexOf('\n}', open));
  };
  const declared = (block) => {
    const out = [];
    const re = /--module-([a-z]+):/g;
    let m;
    while ((m = re.exec(block)) !== null) out.push(m[1]);
    return out.sort();
  };

  const light = declared(themeBlock('\n:root {'));
  const dark = declared(themeBlock('\nbody.dark-mode {'));

  /* The admin chip has no resting hue: it is a filled gradient with `color: white
     !important`. Every other module in the map must have one, so adding a module and
     forgetting its colour fails here rather than shipping a grey glyph nobody notices. */
  const expected = Object.keys(MODULE_ICONS).filter((key) => key !== 'admin').sort();

  assert.deepStrictEqual(light, expected, 'light-mode module hues: ' + light.join(', '));
  assert.deepStrictEqual(dark, expected, 'dark-mode module hues: ' + dark.join(', '));

  expected.forEach((key) => {
    const rule = new RegExp('\\[data-module="' + key + '"\\]\\s*\\{\\s*--module-hue:\\s*var\\(--module-' + key + '\\);');
    assert.ok(rule.test(css), `no [data-module="${key}"] rule naming --module-${key}`);
  });

  /* Both wrappers in ONE selector list. Two rules would be the same bug the glyph test is
     about, one layer down: the tab row violet and the bottom bar teal for the same module. */
  assert.ok(
    /\.tab-icon,\n\.bottom-nav-icon \{\n  color: var\(--module-hue, inherit\);/.test(css),
    'the module hue is not applied to .tab-icon and .bottom-nav-icon in a single rule, with `inherit` as the fallback'
  );

  /* The active pill has to paint with currentColor. The moment it goes back to a fixed
     colour, six of the seven tabs are marked in a hue that is not theirs — which is what
     this whole change was about. */
  assert.ok(/background: currentColor;/.test(css), 'the active pill no longer paints with currentColor');
  assert.ok(
    /box-shadow: inset 0 0 0 1px currentColor;/.test(css),
    'the active pill ring no longer paints with currentColor'
  );
  assert.strictEqual(css.indexOf('--nav-pill'), -1, 'the fixed teal pill tokens are back');
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
