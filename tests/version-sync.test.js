// ==================== RELEASE VERSION SYNC TESTS ====================
// Run: node tests/version-sync.test.js
//
// Zero dependencies. Drives the real `scripts/bump-version.mjs` against
// throwaway copies of the release files, and checks both halves of the delivery
// rule this app depends on:
//
//   1. DETECTION — drift in any single label fails, whether it is the cache
//      generation, one `?v=` token, a manifest field, or the frozen version
//      guard. A publish that moves some labels and not others is exactly the
//      silent failure the script exists for.
//   2. APPLICATION — a bump moves every label together, in one pass, preserving
//      line endings and touching nothing else in the file, and it never moves
//      the guard.
//
// The sandboxes are real directories, so the script under test is the same file
// a human runs — not a re-imported copy of its logic.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join('scripts', 'bump-version.mjs');

/* Only what the script reads or writes. A full copy would drag the whole app
   into a temp directory for no reason — and it would find a .git, which the
   sandboxes deliberately do not have. */
const SANDBOX_FILES = ['version.json', 'sw.js', 'manifest.json', 'index.html'];

const SANDBOXES = [];

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-version-'));
  SANDBOXES.push(dir);
  for (const f of SANDBOX_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(ROOT, SCRIPT), path.join(dir, SCRIPT));
  return dir;
}

function run(dir, ...args) {
  const r = spawnSync(process.execPath, [path.join(dir, SCRIPT), '--root', dir, ...args], {
    encoding: 'utf8'
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8');
const write = (dir, f, text) => fs.writeFileSync(path.join(dir, f), text);

function edit(dir, f, from, to) {
  const text = read(dir, f);
  assert.ok(text.indexOf(from) !== -1, `fixture is missing ${JSON.stringify(from)} in ${f}`);
  write(dir, f, text.replace(from, to));
}

const crlf = (s) => (s.match(/\r\n/g) || []).length;
const bareLf = (s) => (s.match(/(^|[^\r])\n/g) || []).length;

/* The lines that differ between two versions of one file, as 0-based indices. */
function changedLines(before, after) {
  const a = before.split('\r\n');
  const b = after.split('\r\n');
  assert.strictEqual(a.length, b.length, 'a bump must not add or remove lines');
  const changed = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed.push(i);
  return changed;
}

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

/* The one check that needs git: it compares the working tree against what was
   actually published. Skipped, not failed, where git is not installed. */
function testWithGit(name, fn) {
  const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    console.log('  SKIP  ' + name + '  (git not available)');
    return;
  }
  test(name, fn);
}

/* A throwaway repo holding only the release files, so the "published last"
   comparison has something to compare against. Config is passed per-command;
   nothing global is touched. */
function gitSandbox() {
  const dir = sandbox();
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.invalid',
    '-c', 'user.name=test', ...args], { encoding: 'utf8' });
  const init = git('init', '-q');
  assert.ok(!init.error && init.status === 0, 'git init failed: ' + (init.stderr || init.error));
  git('add', '.');
  const commit = git('commit', '-q', '-m', 'publish 3.9.9');
  assert.strictEqual(commit.status, 0, 'git commit failed: ' + commit.stderr);
  return { dir, git };
}

console.log('\nRelease version sync\n');

/* ------------------------------------------------------------------ *
   The tree it actually ships in
 * ------------------------------------------------------------------ */

test('the real tree passes --check', () => {
  const r = run(ROOT, '--check');
  assert.strictEqual(r.code, 0, 'expected exit 0, got ' + r.code + '\n' + r.out);
  assert.ok(r.out.indexOf('every release label reads') !== -1, 'should say so explicitly');
});

test('the real tree has exactly 6 release labels and 2 guard sites', () => {
  const r = run(ROOT, '--check');
  /* Every located label prints an `ok` row. If a label is added, moved into a
     shape the patterns miss, or removed, this count changes and the patterns in
     scripts/bump-version.mjs need to change with it. */
  const rows = (r.out.match(/^  ok /gm) || []).length;
  assert.strictEqual(rows, 8, 'expected 8 ok rows (6 release + 2 guard), got ' + rows + '\n' + r.out);
  ['cache generation', 'asset ?v= token', '"version"', '"id"', '"start_url"',
   'REQUIRED_APP_VERSION', 'login footer'].forEach((what) => {
    assert.ok(r.out.indexOf(what) !== -1, 'should report on ' + what);
  });
});

/* ------------------------------------------------------------------ *
   Detection — every label fails the check on its own
 * ------------------------------------------------------------------ */

test('a stale cache generation is drift', () => {
  const dir = sandbox();
  edit(dir, 'sw.js', "gvsi-shell-v3.9.9", "gvsi-shell-v3.8.2");
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 1, 'must fail');
  assert.ok(r.out.indexOf('sw.js:') !== -1, 'should name the file and line');
  assert.ok(r.out.indexOf('gvsi-shell-v3.8.2') !== -1, 'should show what it found');
});

test('one stale ?v= token is drift', () => {
  const dir = sandbox();
  edit(dir, 'index.html', 'styles.css?v=3.9.9', 'styles.css?v=3.9.1');
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 1, 'must fail on a single token');
  assert.ok(r.out.indexOf('index.html:') !== -1, 'should name the file and line');
  assert.ok(r.out.indexOf('3.9.1') !== -1, 'should show what it found');
});

test('a stale manifest start_url is drift', () => {
  const dir = sandbox();
  edit(dir, 'manifest.json', '"start_url": "./index.html?v=3.9.9"', '"start_url": "./index.html?v=3.9.7"');
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 1, 'must fail');
  assert.ok(r.out.indexOf('"start_url"') !== -1, 'should name the field');
});

test('a stale manifest version is drift', () => {
  const dir = sandbox();
  edit(dir, 'manifest.json', '"version": "3.9.9"', '"version": "3.9.0"');
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 1, 'must fail');
});

test('a ?v= token inside a third-party URL is left alone', () => {
  const dir = sandbox();
  /* The generic sweep exists so a token added later cannot be forgotten. It must
     not reach into someone else's URL: that cache-buster is not our version. */
  const html = read(dir, 'index.html');
  write(dir, 'index.html', html.replace('<title>NetPulse | Gallopvision</title>',
    '<title>NetPulse | Gallopvision</title>\r\n  <script src="https://cdn.example.com/widget.js?v=1.2.3" defer></script>'));

  const check = run(dir, '--check');
  assert.strictEqual(check.code, 0, 'not drift — that token is not a release label\n' + check.out);
  assert.ok(check.out.indexOf('cdn.example.com') !== -1, 'but it must be reported, not hidden\n' + check.out);

  assert.strictEqual(run(dir, 'patch').code, 0);
  const after = read(dir, 'index.html');
  assert.ok(after.indexOf('widget.js?v=1.2.3') !== -1, 'the URL must survive the bump untouched');
  assert.strictEqual((after.match(/\?v=3\.9\.10/g) || []).length, 2, 'while our own two still move');
});

test('a missing label is drift, not a silent no-op', () => {
  const dir = sandbox();
  const text = read(dir, 'index.html');
  write(dir, 'index.html', text.replace(/\?v=3\.9\.9/g, '')); // both tokens gone
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 1, 'must fail');
  assert.ok(r.out.indexOf('expected at least 2') !== -1, 'should say how many it wanted: ' + r.out);
});

/* ------------------------------------------------------------------ *
   Detection — the frozen guard
 * ------------------------------------------------------------------ */

test('a moved REQUIRED_APP_VERSION is drift', () => {
  const dir = sandbox();
  edit(dir, 'index.html', 'const REQUIRED_APP_VERSION = "3.10.0"', 'const REQUIRED_APP_VERSION = "3.9.9"');
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 1, 'the guard must never drift unnoticed');
  assert.ok(r.out.indexOf('guard') !== -1, 'should explain which value drifted');
  assert.ok(r.out.indexOf('REQUIRED_APP_VERSION') !== -1, 'should name the constant');
});

test('a moved login footer is drift', () => {
  const dir = sandbox();
  edit(dir, 'index.html', 'GVSI NetPulse v3.10.0', 'GVSI NetPulse v3.9.9');
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 1, 'the footer mirrors the guard and must move with it');
  assert.ok(r.out.indexOf('login footer') !== -1, 'should name the site');
});

test('a guard that drifted in version.json is caught too', () => {
  const dir = sandbox();
  write(dir, 'version.json', JSON.stringify({ version: '3.9.9', guard: '3.8.0' }, null, 2) + '\n');
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 1, 'version.json is the record of the frozen value');
});

/* ------------------------------------------------------------------ *
   Application — a bump moves everything, once
 * ------------------------------------------------------------------ */

test('patch moves the generation, both tokens, all three manifest fields and version.json', () => {
  const dir = sandbox();
  const r = run(dir, 'patch');
  assert.strictEqual(r.code, 0, 'expected exit 0\n' + r.out);

  assert.ok(read(dir, 'sw.js').indexOf("gvsi-shell-v3.9.10") !== -1, 'generation must move');
  assert.strictEqual(read(dir, 'sw.js').indexOf('gvsi-shell-v3.9.9'), -1, 'and not linger');

  const html = read(dir, 'index.html');
  assert.strictEqual((html.match(/\?v=3\.9\.10/g) || []).length, 2, 'both tokens must move');
  assert.strictEqual(html.indexOf('?v=3.9.9'), -1, 'no token may stay behind');
  assert.strictEqual(html.indexOf('gvsi-shell-v3.9.10'), -1, 'the generation string belongs in sw.js only');

  const manifest = JSON.parse(read(dir, 'manifest.json'));
  assert.strictEqual(manifest.version, '3.9.10');
  assert.strictEqual(manifest.id, '/index.html?v=3.9.10');
  assert.strictEqual(manifest.start_url, './index.html?v=3.9.10');

  const truth = JSON.parse(read(dir, 'version.json'));
  assert.strictEqual(truth.version, '3.9.10', 'the source of truth moves last');
  assert.strictEqual(truth.guard, '3.10.0', 'the guard is not a release label');
});

test('a bumped sandbox passes its own check', () => {
  const dir = sandbox();
  run(dir, 'patch');
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 0, 'the write must settle cleanly\n' + r.out);
});

test('the guard is byte-identical after a bump', () => {
  const dir = sandbox();
  const before = read(dir, 'index.html');
  run(dir, 'patch');
  const after = read(dir, 'index.html');
  const guardLine = /const REQUIRED_APP_VERSION = "3\.10\.0";/;
  assert.ok(guardLine.test(before) && guardLine.test(after), 'the guard must be untouched');
  assert.ok(/GVSI NetPulse v3\.10\.0/.test(after), 'the footer must be untouched');
  void before;
});

test('only the version spans change in index.html', () => {
  const dir = sandbox();
  const before = read(dir, 'index.html');
  run(dir, 'patch');
  const after = read(dir, 'index.html');
  const changed = changedLines(before, after);
  assert.strictEqual(changed.length, 2, 'expected exactly the two ?v= lines, got ' + changed.length);
  for (const i of changed) {
    assert.strictEqual(after.split('\r\n')[i], before.split('\r\n')[i].replace('3.9.9', '3.9.10'),
      'line ' + (i + 1) + ' must differ only in the version');
  }
});

test('only the generation line changes in sw.js', () => {
  const dir = sandbox();
  const before = read(dir, 'sw.js');
  run(dir, 'patch');
  const after = read(dir, 'sw.js');
  const changed = changedLines(before, after);
  assert.strictEqual(changed.length, 1, 'expected exactly the STATIC_CACHE line, got ' + changed.length);
  assert.ok(after.split('\r\n')[changed[0]].indexOf('STATIC_CACHE') !== -1, 'and it must be that line');
});

test('only the three version fields change in manifest.json', () => {
  const dir = sandbox();
  const before = read(dir, 'manifest.json');
  run(dir, 'patch');
  const after = read(dir, 'manifest.json');
  assert.strictEqual(changedLines(before, after).length, 3, 'version, id and start_url');
});

test('a bump keeps every line ending exactly as it was', () => {
  const dir = sandbox();
  const before = {};
  for (const f of ['index.html', 'sw.js', 'manifest.json']) before[f] = read(dir, f);
  run(dir, 'patch');
  for (const f of ['index.html', 'sw.js', 'manifest.json']) {
    const after = read(dir, f);
    assert.strictEqual(crlf(after), crlf(before[f]), f + ': CRLF count changed');
    assert.strictEqual(bareLf(after), bareLf(before[f]), f + ': a bare LF was introduced');
  }
});

test('a bump changes the byte length by exactly one byte per label', () => {
  const dir = sandbox();
  const before = {};
  for (const f of ['index.html', 'sw.js', 'manifest.json']) before[f] = read(dir, f);
  run(dir, 'patch'); // 3.9.9 -> 3.9.10 is one byte longer, on every label
  assert.strictEqual(read(dir, 'index.html').length - before['index.html'].length, 2);
  assert.strictEqual(read(dir, 'sw.js').length - before['sw.js'].length, 1);
  assert.strictEqual(read(dir, 'manifest.json').length - before['manifest.json'].length, 3);
});

test('major resets minor and patch, minor advances the middle number', () => {
  const major = sandbox();
  assert.strictEqual(run(major, 'major').code, 0);
  assert.strictEqual(JSON.parse(read(major, 'version.json')).version, '4.0.0');

  /* From 3.9.x, `minor` lands on 3.10.0 — which IS the frozen guard, so it is
     refused on purpose (see the collision tests below). Move the release out of
     that corner first, through the script's own explicit-version path. */
  const minor = sandbox();
  assert.strictEqual(run(minor, '9.9.9').code, 0);
  assert.strictEqual(run(minor, 'minor').code, 0);
  assert.strictEqual(JSON.parse(read(minor, 'version.json')).version, '9.10.0');
  assert.ok(read(minor, 'sw.js').indexOf('gvsi-shell-v9.10.0') !== -1);
});

test('an explicit version works like a bump kind', () => {
  const dir = sandbox();
  const r = run(dir, '4.0.1');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(read(dir, 'sw.js').indexOf('gvsi-shell-v4.0.1') !== -1);
});

/* ------------------------------------------------------------------ *
   Refusals — a bump that cannot be trusted must write nothing
 * ------------------------------------------------------------------ */

test('bumping to the version already published is refused', () => {
  const dir = sandbox();
  const r = run(dir, '3.9.9');
  assert.strictEqual(r.code, 2, 'nothing to do is not success');
  assert.ok(r.out.indexOf('already 3.9.9') !== -1, r.out);
});

test('a bump that would collide with the frozen guard is refused', () => {
  const dir = sandbox();
  const r = run(dir, 'minor'); // 3.9.9 -> 3.10.0, which IS the guard
  assert.notStrictEqual(r.code, 0, 'must not silently hand the guard number to a release');
  assert.ok(r.out.indexOf('--allow-guard-collision') !== -1, 'should name the override');
  assert.strictEqual(JSON.parse(read(dir, 'version.json')).version, '3.9.9', 'and must not have written');
});

test('the collision override is accepted, and warned about afterwards', () => {
  const dir = sandbox();
  const r = run(dir, 'minor', '--allow-guard-collision');
  assert.strictEqual(r.code, 0, r.out);
  const check = run(dir, '--check');
  assert.strictEqual(check.code, 0, 'a collision is a warning, not drift\n' + check.out);
  assert.ok(check.out.indexOf('warn') !== -1, 'but it must say so');
});

test('an unreadable bump kind is refused', () => {
  const dir = sandbox();
  const r = run(dir, '9.9');
  assert.strictEqual(r.code, 2, r.out);
  assert.ok(r.out.indexOf('not a version or a bump kind') !== -1, r.out);
});

test('--check and a version contradict each other', () => {
  const dir = sandbox();
  const r = run(dir, '--check', 'patch');
  assert.strictEqual(r.code, 2, r.out);
});

test('a bump refuses to run when the guard is already inconsistent', () => {
  const dir = sandbox();
  edit(dir, 'index.html', 'const REQUIRED_APP_VERSION = "3.10.0"', 'const REQUIRED_APP_VERSION = "3.8.2"');
  const swBefore = read(dir, 'sw.js');
  const r = run(dir, 'patch');
  assert.strictEqual(r.code, 1, 'a bump would bury the problem behind a correct-looking version');
  assert.strictEqual(read(dir, 'sw.js'), swBefore, 'nothing may be written');
  assert.strictEqual(JSON.parse(read(dir, 'version.json')).version, '3.9.9', 'not the source of truth either');
});

test('a missing label refuses the whole bump, leaving every file untouched', () => {
  const dir = sandbox();
  const html = read(dir, 'index.html');
  write(dir, 'index.html', html.replace(/\?v=3\.9\.9/g, ''));
  const before = {};
  for (const f of SANDBOX_FILES) before[f] = read(dir, f);

  const r = run(dir, 'patch');
  assert.strictEqual(r.code, 1, 'a partial bump is worse than no bump');
  assert.ok(r.out.indexOf('could not be found') !== -1, r.out);
  for (const f of SANDBOX_FILES) {
    assert.strictEqual(read(dir, f), before[f], f + ' was written despite the refusal');
  }
});

test('a dry run writes nothing', () => {
  const dir = sandbox();
  const before = {};
  for (const f of SANDBOX_FILES) before[f] = read(dir, f);
  const r = run(dir, 'patch', '--dry-run');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.indexOf('3.9.10') !== -1, 'should still report the move');
  for (const f of SANDBOX_FILES) {
    assert.strictEqual(read(dir, f), before[f], f + ' must not be touched by --dry-run');
  }
});

/* ------------------------------------------------------------------ *
   The failure no consistency check can see: bytes moved, label did not
 * ------------------------------------------------------------------ */

testWithGit('a changed delivery asset with an unmoved label is warned about', () => {
  const { dir } = gitSandbox();
  fs.appendFileSync(path.join(dir, 'index.html'), '\r\n<!-- touched -->\r\n');

  const r = run(dir, '--check');
  assert.strictEqual(r.code, 0, 'this is a warning, not drift — the labels still agree\n' + r.out);
  assert.ok(r.out.indexOf('delivery set changed, release did not') !== -1, r.out);
  assert.ok(r.out.indexOf('index.html') !== -1, 'should name the file that will not arrive');
  assert.ok(r.out.indexOf('bump-version.mjs patch') !== -1, 'should say how to fix it');
});

testWithGit('changed sw.js bytes are warned about on their own', () => {
  const { dir } = gitSandbox();
  fs.appendFileSync(path.join(dir, 'sw.js'), '\r\n/* touched */\r\n');
  const r = run(dir, '--check');
  assert.ok(r.out.indexOf('delivery set changed, release did not') !== -1, r.out);
});

testWithGit('the warning clears once the label moves with the bytes', () => {
  const { dir } = gitSandbox();
  fs.appendFileSync(path.join(dir, 'index.html'), '\r\n<!-- touched -->\r\n');
  assert.strictEqual(run(dir, 'patch').code, 0);
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out.indexOf('delivery set changed'), -1, 'the same push now carries the generation move');
});

testWithGit('a clean checkout at the published version warns about nothing', () => {
  const { dir } = gitSandbox();
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(r.out.indexOf('delivery set changed'), -1, r.out);
});

testWithGit('a brand-new unversioned precache entry is spotted', () => {
  const { dir } = gitSandbox();
  /* olt-module.js is named in the sw.js precache list but does not exist in this
     fixture yet — the same shape as adding cache-store.js to the app, which is
     delivered only by install re-fetching every entry. */
  fs.writeFileSync(path.join(dir, 'olt-module.js'), '/* new module */\r\n');
  const r = run(dir, '--check');
  assert.strictEqual(r.code, 0, r.out);
  assert.ok(r.out.indexOf('olt-module.js') !== -1, 'the warning must name the new file\n' + r.out);
});

/* ------------------------------------------------------------------ */

for (const dir of SANDBOXES) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) { /* best effort */ }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
