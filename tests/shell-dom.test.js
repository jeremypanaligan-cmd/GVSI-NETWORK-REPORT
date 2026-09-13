/* ------------------------------------------------------------------
   The shell's DOM, and the mobile bottom nav.

   Two bugs, one family, both of which present as "the app lost its navigation
   and I had to close and reopen it":

     1. A full-screen state that renders itself by REPLACING the body's HTML.
        That deletes the whole shell — header, bottom nav, kiosk root, every node
        the running script still references — and nothing restores it until the
        app is relaunched. It has shipped once already, in the update prompt
        (v3.8.1, "Update prompt no longer destroys bottom nav on mobile"), and
        the maintenance screen was still doing it until now.

     2. `body.dark-mode .bottom-nav` declaring `position: relative; z-index: 2`.
        That rule has specificity (0,2,1) and the bar is only ever *displayed*
        inside `@media (max-width: 768px)`, where `.bottom-nav` is (0,1,0) — so
        the frosted-glass paint rule silently overrode the pin on the one device
        that shows the bar, leaving it in normal flow with a z-index beneath every
        overlay instead of pinned above them.

   Static half: every script the page loads is read (and both CSS files parsed)
   so a reintroduction fails here rather than on someone's phone. Run half: the
   two full-screen states are actually executed against a fake document holding a
   bottom nav, because "it appends" is the property under test.

   Run with:  node --test tests/shell-dom.test.js
 * ------------------------------------------------------------------ */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadScriptUnits } = require('./inline-order.js');

const ROOT = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(ROOT, name), 'utf8');

const units = loadScriptUnits(ROOT);
const unitDefining = (name) => {
  const unit = units.find((u) => u.code.indexOf('function ' + name + '(') !== -1);
  assert.ok(unit, 'no loaded script defines ' + name + '()');
  return unit;
};

/** Slice one top-level function out of raw source, braces balanced. */
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.notEqual(start, -1, 'function ' + name + '() was not found in the source');
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name + '()');
}

/* ==================================================================== *
   1. Nothing may replace the body's HTML
 * ==================================================================== */

/* Each pattern is an assignment or a call, never a mention — the code is allowed
   to READ document.body (measuring it, walking it) and to describe the rule in a
   comment. */
const BODY_REPLACEMENT = [
  /\bdocument\s*\.\s*body\s*\.\s*innerHTML\s*(?:=(?!=)|\+=)/,
  /\bdocument\s*\.\s*body\s*\.\s*outerHTML\s*(?:=(?!=)|\+=)/,
  /\bdocument\s*\.\s*body\s*\.\s*replaceChildren\s*\(/,
  /\bdocument\s*\.\s*body\s*\.\s*remove\s*\(/,
  /\bdocument\s*\.\s*write(?:ln)?\s*\(/
];

/** Report every place a loaded script throws the shell away. */
function analyseBodyReplacement(source) {
  const problems = [];
  BODY_REPLACEMENT.forEach((re) => {
    const hit = re.exec(source);
    if (hit) problems.push(hit[0].replace(/\s+/g, '') + ' — the shell is deleted, not overlaid');
  });
  return problems;
}

test('the app never replaces the body, so no state can delete the shell', () => {
  const offenders = [];
  units.forEach((u) => {
    analyseBodyReplacement(u.code).forEach((p) => offenders.push(u.name + ': ' + p));
  });
  assert.deepEqual(offenders, [],
    'a full-screen state must be APPENDED (see showReinstallPrompt/showMaintenancePage); ' +
    'replacing document.body removes the bottom nav until the app is restarted');
});

test('the body-replacement check has teeth', () => {
  /* The real historical shape, verbatim in form: the v3.8.1 update prompt. */
  const oldPrompt = [
    'function showReinstallPrompt() {',
    '  document.body.innerHTML = `',
    '    <div style="position:fixed;top:0;left:0;width:100vw;height:100vh;">',
    '      <button onclick="finishUpdate()">Refresh & Sync App</button>',
    '    </div>',
    '  `;',
    '}'
  ].join('\n');
  assert.equal(analyseBodyReplacement(oldPrompt).length, 1, 'the old update prompt must be flagged');

  /* The other three ways to do the same thing. */
  assert.equal(analyseBodyReplacement('document.body.replaceChildren(div);').length, 1);
  assert.equal(analyseBodyReplacement('document.body.innerHTML += markup;').length, 1);
  assert.equal(analyseBodyReplacement('document.write(html);').length, 1);

  /* And the sanctioned shape stays clean — including a mention in a comment. */
  const current = [
    '// Use overlay instead of replacing body.innerHTML to preserve DOM structure',
    'function showReinstallPrompt() {',
    '  var overlay = document.createElement("div");',
    '  overlay.innerHTML = "<div>x</div>";',
    '  document.body.appendChild(overlay);',
    '}'
  ].join('\n');
  assert.deepEqual(analyseBodyReplacement(current), []);
});

/* ==================================================================== *
   2. A full-screen state keeps the shell — proven by running it
 * ==================================================================== */

/** A body holding the real shell we must not lose, plus the two DOM APIs used. */
function fakeShell() {
  const byId = new Map();
  const created = [];

  function element(tag) {
    return {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      style: { cssText: '' },
      innerHTML: '',
      children: [],
      appendChild(child) {
        if (child && child.id) byId.set(child.id, child);
        this.children.push(child);
        return child;
      }
    };
  }

  const body = element('body');
  const shell = ['nav:bottomNav', 'header:appHeader', 'div:mainContainer', 'div:kioskRoot'].map((spec) => {
    const [tag, id] = spec.split(':');
    const el = element(tag);
    el.id = id;
    body.appendChild(el);
    return el;
  });

  const document = {
    body,
    createElement: (tag) => {
      const el = element(tag);
      created.push(el);
      return el;
    },
    getElementById: (id) => byId.get(id) || null
  };

  return { document, body, shell, created };
}

/** Load one function out of the shipping source, closed over fakes only. */
function loadFullScreenState(functionName, shell) {
  const src = extractFunction(unitDefining(functionName).code, functionName);
  const intervals = [];
  const factory = new Function(
    'document', 'window', 'setInterval', 'fetchWithRetry', 'ADMIN_API_URL',
    'return (' + src + ');'
  );
  return factory(
    shell.document,
    { BASE_API_URL: 'https://example.invalid/exec' },
    (fn, ms) => { intervals.push(ms); return intervals.length; },
    () => { throw new Error('the network must not be reached from a full-screen state under test'); },
    ''
  );
}

test('the maintenance screen is overlaid, so the bottom nav survives it', () => {
  const shell = fakeShell();
  const showMaintenancePage = loadFullScreenState('showMaintenancePage', shell);

  showMaintenancePage();

  assert.equal(shell.body.children.length, 5, 'the four shell nodes plus one overlay, nothing replaced');
  shell.shell.forEach((node) => {
    assert.ok(shell.body.children.includes(node), node.id + ' must still be in the body');
  });
  assert.ok(shell.document.getElementById('bottomNav'), 'the bottom nav must survive the maintenance screen');

  const overlay = shell.document.getElementById('maintenanceOverlay');
  assert.ok(overlay, 'the overlay must be appended under its own id');
  assert.match(overlay.innerHTML, /Under Maintenance/, 'it must still say what it is');
  assert.match(overlay.innerHTML, /z-index: 999999/, 'and still cover the app while it is up');
});

test('showing the maintenance screen twice does not stack two of them', () => {
  const shell = fakeShell();
  const showMaintenancePage = loadFullScreenState('showMaintenancePage', shell);

  showMaintenancePage();
  showMaintenancePage();

  const overlays = shell.body.children.filter((c) => c.id === 'maintenanceOverlay');
  assert.equal(overlays.length, 1, 'a second call must be a no-op');
  assert.equal(shell.body.children.length, 5);
});

test('the update prompt is overlaid, so the bottom nav survives it', () => {
  const shell = fakeShell();
  const showReinstallPrompt = loadFullScreenState('showReinstallPrompt', shell);

  showReinstallPrompt();

  assert.ok(shell.document.getElementById('bottomNav'), 'the bottom nav must survive the update prompt');
  assert.ok(shell.document.getElementById('updateOverlay'), 'and the prompt must still be appended');
  assert.match(shell.document.getElementById('updateOverlay').innerHTML, /Refresh & Sync App/);
});

/* ==================================================================== *
   3. The mobile bar must stay pinned
 * ==================================================================== */

/**
 * Minimal rule scanner: comments stripped, rules grouped with the at-rule they
 * sit under. Enough for the question here (which block declares what for
 * `.bottom-nav`), and it does not pretend to be a CSS parser elsewhere.
 */
function parseCssRules(css) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [];
  const stack = [];
  let buf = '';

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      const head = buf.trim();
      buf = '';
      if (head.startsWith('@')) {
        stack.push(head);
        continue;
      }
      const end = src.indexOf('}', i);
      rules.push({
        media: stack[stack.length - 1] || '',
        selector: head,
        body: src.slice(i + 1, end === -1 ? src.length : end)
      });
      i = end === -1 ? src.length : end;
    } else if (ch === '}') {
      if (stack.length) stack.pop();
      buf = '';
    } else {
      buf += ch;
    }
  }
  return rules;
}

const MOBILE_BREAKPOINT = /max-width:\s*768px/;
const BAR_SELECTOR = /^(?:body\.dark-mode\s+)?\.bottom-nav$/;

function declaration(rule, prop) {
  const hit = rule.body.match(new RegExp('(?:^|;)\\s*' + prop + '\\s*:\\s*([^;]+)'));
  return hit ? hit[1].trim() : null;
}

/** Every way the mobile bar can end up unpinned or covered again. */
function analyseBottomNavPin(css) {
  const problems = [];
  const barRules = parseCssRules(css).filter((r) =>
    r.selector.split(',').map((s) => s.trim()).some((s) => BAR_SELECTOR.test(s)));
  assert.ok(barRules.length > 0, 'no .bottom-nav rules found — did the stylesheet move?');

  let pinned = false;
  barRules.forEach((r) => {
    const mobile = MOBILE_BREAKPOINT.test(r.media);
    if (mobile && declaration(r, 'position') === 'fixed') pinned = true;

    /* A rule with no media query applies on every screen, and `body.dark-mode …`
       outranks the plain `.bottom-nav` inside the mobile block both on
       specificity and — being earlier in the file — on order. So layout here is
       silent corruption of the mobile layout, not a desktop concern. */
    if (!mobile && declaration(r, 'position') !== null) {
      problems.push(r.selector.trim() + ' sets position outside any media query, which beats the mobile pin');
    }
    if (!mobile && declaration(r, 'z-index') !== null) {
      problems.push(r.selector.trim() + ' sets z-index outside any media query, which beats the mobile pin');
    }
  });

  if (!pinned) problems.push('no @media (max-width: 768px) rule pins .bottom-nav with position: fixed');
  return problems;
}

test('the mobile bottom nav is pinned, and nothing outranks the pin', () => {
  const problems = analyseBottomNavPin(read('styles.css'));
  assert.deepEqual(problems, [], 'the bar must be position: fixed on mobile and unpinned nowhere else');
});

test('the pin check has teeth', () => {
  /* The rule as it shipped: position/z-index copied over from the frosted-glass
     modal rule, with no media query around them. */
  const shipped = [
    'body.dark-mode .bottom-nav {',
    '  position: relative;',
    '  z-index: 2;',
    '  background: rgba(7, 10, 15, 0.85);',
    '}',
    '@media (max-width: 768px) {',
    '  .bottom-nav { display: flex; position: fixed; bottom: 0; z-index: 100; }',
    '}'
  ].join('\n');
  const reported = analyseBottomNavPin(shipped);
  assert.equal(reported.length, 2, 'both the position and the z-index must be reported: ' + reported.join(' | '));
  assert.match(reported.join(' '), /position outside any media query/);
  assert.match(reported.join(' '), /z-index outside any media query/);

  /* The bar losing its pin entirely is the other half. */
  const unpinned = '@media (max-width: 768px) { .bottom-nav { display: flex; } }';
  assert.match(analyseBottomNavPin(unpinned).join(' '), /no @media \(max-width: 768px\) rule pins/);

  /* And a pure paint rule is clean. */
  const current = [
    'body.dark-mode .bottom-nav { background: rgba(7, 10, 15, 0.85); backdrop-filter: blur(16px); }',
    '@media (max-width: 768px) { .bottom-nav { display: flex; position: fixed; bottom: 0; z-index: 100; } }'
  ].join('\n');
  assert.deepEqual(analyseBottomNavPin(current), []);
});
