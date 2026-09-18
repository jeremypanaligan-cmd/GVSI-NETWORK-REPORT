#!/usr/bin/env node
/* ==================== RELEASE VERSION — ONE SOURCE OF TRUTH ====================
 *
 * This app is delivered by a service worker that is CACHE-FIRST for the shell
 * (sw.js), which makes the release version a load-bearing value rather than a
 * label. It lives in three places at once: the cache generation, the manifest,
 * and the `?v=` query token on every versioned asset.
 *
 * The failure this guards against is SILENT. Publish changed bytes without
 * moving the version and:
 *
 *   - the browser installs into the SAME cache name, so `activate` deletes
 *     nothing (the old generation IS `STATIC_CACHE`), and
 *   - the page navigates to `./index.html?v=<old>` — the manifest start_url —
 *     which the fetch handler already pinned with an on-demand `cache.put`.
 *
 * The repo says one thing, every installed device keeps serving the other, and
 * nothing reports an error. No log, no toast, no failing test. That is why this
 * script exists, and why it is wired into a test.
 *
 * ---------------------------------------------------------------------------
 * THE SOURCE OF TRUTH
 * ---------------------------------------------------------------------------
 * `version.json` at the repo root, holding exactly two values:
 *
 *   version   the release. Moves on every publish that changes a precached
 *             byte. This script writes it into every release label.
 *   guard     REQUIRED_APP_VERSION in index.html, plus the login footer that
 *             mirrors it. This one must NEVER move with a release: it is the
 *             match key that sends a device to the "Refresh & Sync App" wipe
 *             overlay, and moving it behind a dashboard nobody is standing in
 *             front of is an outage, not an update.
 *
 * Recording the frozen guard here is deliberate — the only way to notice that a
 * deliberately frozen value moved is to write it down somewhere a check reads.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node scripts/bump-version.mjs                  report state, exit 1 on drift
 *   node scripts/bump-version.mjs --check          the same, explicitly
 *   node scripts/bump-version.mjs patch            move every label to the next patch
 *   node scripts/bump-version.mjs minor            ... minor / major
 *   node scripts/bump-version.mjs 3.9.10           ... or name the version outright
 *
 * Flags:
 *   --root <dir>                 run against another checkout (tests use this)
 *   --dry-run                    with a bump: report the changes, write nothing
 *   --allow-guard-collision      permit release === guard (see the refusal message)
 *
 * Exit codes: 0 clean · 1 drift or a refused bump · 2 bad usage.
 *
 * ---------------------------------------------------------------------------
 * WHAT NO SCRIPT CAN DO
 * ---------------------------------------------------------------------------
 * 1. Commit the moved labels in the SAME push as the bytes they describe. A
 *    generation move landing in a later push is a publish that delivered nothing.
 * 2. Add new UNVERSIONED precache entries (`cache-store.js`, not
 *    `cache-store.js?v=...`) to STATIC_ASSETS in sw.js by hand — `install`
 *    re-fetching every entry with `cache: 'reload'` is their whole delivery.
 * 3. Leave the version guard alone. A bump never moves it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.dirname(SCRIPT_DIR);

const SEMVER_TEXT = String.raw`\d+\.\d+\.\d+`;
const IS_SEMVER = /^\d+\.\d+\.\d+$/;

/* ---------------------------------------------------------------------------
 * The label sites.
 *
 * Each pattern captures the version in a group named `v` and carries the `d`
 * flag, so its exact offsets are known: the span can be spliced without
 * rebuilding the surrounding text, which would mangle quoting and — on a
 * Windows checkout with core.autocrlf — line endings.
 *
 * `min` is how many matches a healthy tree holds. A pattern that stops matching
 * is the loudest kind of drift: it means the label moved somewhere this script
 * cannot see, and a script that quietly rewrites fewer labels than exist is the
 * same failure it was written to prevent.
 * ------------------------------------------------------------------------- */

const RELEASE_LABELS = [
  {
    file: 'sw.js',
    what: 'cache generation',
    min: 1,
    pattern: new RegExp(String.raw`const STATIC_CACHE = 'gvsi-shell-v(?<v>${SEMVER_TEXT})'`, 'gd'),
  },
  {
    file: 'index.html',
    what: 'asset ?v= token',
    min: 2,
    pattern: new RegExp(String.raw`\?v=(?<v>${SEMVER_TEXT})`, 'gd'),
    /* Every `?v=` in this file is one of ours today, and the sweep is generic so
       a token added later cannot be forgotten. But a `?v=` inside an absolute
       URL belongs to a third party — rewriting a CDN's cache-buster to our
       release would break that URL. Skipped, and reported, never silent. */
    skip: (text, start) => {
      const before = text.slice(0, start);
      const tokenStart = Math.max(
        before.lastIndexOf('"'), before.lastIndexOf("'"), before.lastIndexOf('('),
        before.lastIndexOf(' '), before.lastIndexOf('\n'));
      return before.slice(tokenStart + 1).indexOf('://') !== -1;
    },
  },
  {
    file: 'manifest.json',
    what: '"version"',
    min: 1,
    pattern: new RegExp(String.raw`"version"\s*:\s*"(?<v>${SEMVER_TEXT})"`, 'gd'),
  },
  {
    file: 'manifest.json',
    what: '"id"',
    min: 1,
    pattern: new RegExp(String.raw`"id"\s*:\s*"\/index\.html\?v=(?<v>${SEMVER_TEXT})"`, 'gd'),
  },
  {
    file: 'manifest.json',
    what: '"start_url"',
    min: 1,
    pattern: new RegExp(String.raw`"start_url"\s*:\s*"\.\/index\.html\?v=(?<v>${SEMVER_TEXT})"`, 'gd'),
  },
];

/* Recorded so drift in a frozen value can be an error instead of a regression.
   This script never rewrites them. */
const GUARD_LABELS = [
  {
    file: 'index.html',
    what: 'REQUIRED_APP_VERSION',
    min: 1,
    pattern: new RegExp(String.raw`const REQUIRED_APP_VERSION\s*=\s*"(?<v>${SEMVER_TEXT})"`, 'gd'),
  },
  {
    file: 'index.html',
    what: 'login footer',
    min: 1,
    pattern: new RegExp(String.raw`GVSI NetPulse v(?<v>${SEMVER_TEXT})`, 'gd'),
  },
];

/* ---------------------------------------------------------------------------
 * Reading
 * ------------------------------------------------------------------------- */

function lineAt(text, idx) {
  const start = text.lastIndexOf('\n', idx - 1) + 1;
  let end = text.indexOf('\n', idx);
  if (end === -1) end = text.length;
  const snippet = text.slice(start, end).replace(/\r$/, '').trim();
  return {
    line: text.slice(0, idx).split('\n').length,
    snippet: snippet.length > 76 ? snippet.slice(0, 73) + '...' : snippet,
  };
}

function readSite(root, site) {
  const abs = path.join(root, site.file);
  if (!fs.existsSync(abs)) return { ...site, abs, missing: true, text: '', matches: [], skipped: [] };
  const text = fs.readFileSync(abs, 'utf8');
  const matches = [];
  const skipped = [];
  /* matchAll clones the regex, so the shared patterns keep no state. */
  for (const m of text.matchAll(site.pattern)) {
    const [start, end] = m.indices.groups.v;
    const found = { value: m.groups.v, start, end, ...lineAt(text, start) };
    if (site.skip && site.skip(text, start)) skipped.push(found);
    else matches.push(found);
  }
  return { ...site, abs, missing: false, text, matches, skipped };
}

const readAll = (root, sites) => sites.map((s) => readSite(root, s));

function readTruth(root) {
  const abs = path.join(root, 'version.json');
  if (!fs.existsSync(abs)) {
    fail(`version.json is missing at ${abs}\n\n` +
         'It is the single source of truth for the release version, so it has to exist before\n' +
         'anything can be moved. Recreate it as:\n' +
         '  { "version": "<the release every label currently reads>",\n' +
         '    "guard":   "<REQUIRED_APP_VERSION in index.html>" }');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    fail(`version.json is not valid JSON: ${err.message}`);
  }
  if (!IS_SEMVER.test(parsed.version || '')) fail(`version.json: "version" must be X.Y.Z, got ${JSON.stringify(parsed.version)}`);
  if (!IS_SEMVER.test(parsed.guard || '')) fail(`version.json: "guard" must be X.Y.Z, got ${JSON.stringify(parsed.guard)}`);
  return { abs, version: parsed.version, guard: parsed.guard };
}

/* ---------------------------------------------------------------------------
 * Drift
 * ------------------------------------------------------------------------- */

function driftOf(sites, expected) {
  const drift = [];
  for (const site of sites) {
    if (site.missing) { drift.push(`${site.file} is missing`); continue; }
    if (site.matches.length < site.min) {
      drift.push(`${site.file}: ${site.matches.length} match(es) for ${site.what}, expected at least ${site.min}` +
                 ' — the label moved somewhere this script cannot see it');
      continue;
    }
    for (const m of site.matches) {
      if (m.value !== expected) drift.push(`${site.file}:${m.line} ${site.what} reads ${m.value}, expected ${expected}`);
    }
  }
  return drift;
}

/* ---------------------------------------------------------------------------
 * Writing
 * ------------------------------------------------------------------------- */

/* Splice the new version into the exact spans the patterns captured; everything
   outside them is copied byte for byte, so CRLF files stay CRLF. All matches for
   one file are spliced in a single pass — manifest.json holds three. */
function rewrite(text, matches, next) {
  const ordered = [...matches].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const m of ordered) {
    out += text.slice(cursor, m.start) + next;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

function bumpVersion(current, kind) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/* ---------------------------------------------------------------------------
 * The one drift a consistency check cannot see by itself
 *
 * A tree where every label agrees with version.json but the label never moved is
 * internally consistent AND undeliverable. Only git knows what was published
 * last, so ask it: does the delivery set differ from HEAD while version.json
 * still carries the version HEAD published?
 * ------------------------------------------------------------------------- */

function precacheAssets(root) {
  const swPath = path.join(root, 'sw.js');
  if (!fs.existsSync(swPath)) return [];
  const block = fs.readFileSync(swPath, 'utf8').match(/const STATIC_ASSETS = \[([\s\S]*?)\];/);
  if (!block) return [];
  return [...block[1].matchAll(/'\.\/([^']+)'/g)].map((m) => m[1]);
}

function unpublishedDrift(root, release) {
  try {
    execFileSync('git', ['-C', root, 'rev-parse', '--git-dir'], { stdio: 'ignore' });
  } catch {
    return null; // not a checkout (the test sandboxes)
  }
  try {
    const head = JSON.parse(execFileSync('git', ['-C', root, 'show', 'HEAD:version.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    if (head.version !== release) return null; // the label already moved
    /* sw.js is in the set on purpose: changed sw.js bytes DO re-run install, but
       install rewrites the same cache generation, and the pinned
       `index.html?v=<old>` entry survives it regardless. */
    const watch = ['sw.js', ...precacheAssets(root)];
    const changed = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...watch], { encoding: 'utf8' })
      .split('\n').map((l) => l.trim()).filter(Boolean);
    return changed.length ? { version: head.version, changed } : null;
  } catch {
    return null; // nothing published to compare against yet
  }
}

/* ---------------------------------------------------------------------------
 * Reporting
 * ------------------------------------------------------------------------- */

function printSites(heading, sites, from, to, bumping) {
  console.log(heading);
  for (const site of sites) {
    if (site.missing) {
      console.log(`  DRIFT ${site.file}  ${site.what.padEnd(22)} file not found`);
      continue;
    }
    if (!site.matches.length) {
      console.log(`  none  ${site.file}  ${site.what.padEnd(22)} (no match in this file)`);
      continue;
    }
    for (const m of site.matches) {
      /* During a bump, a label still reading `from` is the expected state — it is
         what is about to move. Only a value that is neither is a real problem. */
      const mark = m.value === to ? 'ok   ' : (bumping && m.value === from ? 'move ' : 'DRIFT');
      console.log(`  ${mark} ${`${site.file}:${m.line}`.padEnd(16)} ${site.what.padEnd(22)} ${m.snippet}`);
      if (mark === 'move ') console.log(`         ${m.value} -> ${to}`);
      else if (mark === 'DRIFT') console.log(`         reads ${m.value}, expected ${to}`);
    }
    for (const m of site.skipped) {
      console.log(`  skip  ${`${site.file}:${m.line}`.padEnd(16)} ${site.what.padEnd(22)} ${m.snippet}`);
      console.log('         absolute URL — belongs to a third party, left alone');
    }
  }
  console.log('');
}

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function usage() {
  console.log(
    'Usage: node scripts/bump-version.mjs [patch|minor|major|X.Y.Z] [--check] [--dry-run]\n' +
    '                                        [--root <dir>] [--allow-guard-collision]\n' +
    '\n' +
    'No argument: report the state of every version label and exit 1 on drift.\n' +
    'The single source of truth is version.json.');
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */

function main(argv) {
  let root = DEFAULT_ROOT;
  let dryRun = false;
  let allowCollision = false;
  let checkOnly = false;
  let target = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { usage(); return 0; }
    if (arg === '--check') checkOnly = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--allow-guard-collision') allowCollision = true;
    else if (arg === '--root') {
      if (!argv[i + 1]) fail('--root needs a directory');
      root = path.resolve(argv[++i]);
    } else if (arg.startsWith('--')) fail(`unknown flag: ${arg}\n\n  run with --help`);
    else if (target !== null) fail(`unexpected extra argument: ${arg}`);
    else target = arg;
  }

  if (checkOnly && target !== null) fail(`--check and ${target} contradict each other: one reports, the other writes.`);
  if (!fs.existsSync(root)) fail(`root does not exist: ${root}`);

  const truth = readTruth(root);
  const release = readAll(root, RELEASE_LABELS);
  const guard = readAll(root, GUARD_LABELS);

  /* --- resolve the target -------------------------------------------------- */
  let next = truth.version;
  let bumping = false;

  if (target !== null && !checkOnly) {
    if (/^(patch|minor|major)$/.test(target)) next = bumpVersion(truth.version, target);
    else if (IS_SEMVER.test(target)) next = target;
    else fail(`not a version or a bump kind: ${target}\n\n  expected patch, minor, major or X.Y.Z`);

    if (next === truth.version) fail(`the release is already ${next} — nothing to move.`, 2);

    if (next === truth.guard && !allowCollision) {
      fail(`refusing to move the release to ${next}: that is the frozen version guard.\n\n` +
           'The guard is the match key that sends a device to the "Refresh & Sync App" wipe overlay.\n' +
           'version.json records it so that changing it is a decision, not a side effect. Two ways on,\n' +
           'both deliberate:\n' +
           `  - keep the numbers apart and name another release, e.g. ${bumpVersion(next, 'patch')}\n` +
           '  - or move the guard on purpose: version.json AND REQUIRED_APP_VERSION in index.html,\n' +
           '    knowing every device then gets the wipe overlay\n\n' +
           'To accept the collision anyway: --allow-guard-collision');
    }

    const [a, b, c] = next.split('.').map(Number);
    const [x, y, z] = truth.version.split('.').map(Number);
    if (a * 1e6 + b * 1e3 + c < x * 1e6 + y * 1e3 + z) {
      console.log(`warn: ${next} is LOWER than the published ${truth.version}. A rollback does still reach\n` +
                  '      devices (the sw.js bytes differ, so install re-runs), but it ships a shell older\n' +
                  '      than the one already on them.\n');
    }
    bumping = true;
  }

  /* --- report -------------------------------------------------------------- */
  console.log('');
  console.log(`release version   ${truth.version}${bumping ? `  ->  ${next}` : ''}` +
              `${dryRun && bumping ? '   (dry run — nothing written)' : ''}`);
  console.log(`version guard     ${truth.guard}   (frozen — a bump never moves it)`);
  console.log('');
  printSites('release labels — these move together', release, truth.version, next, bumping);
  printSites('version guard — must never move', guard, truth.guard, truth.guard, false);

  const releaseDrift = driftOf(release, bumping ? truth.version : next);
  const guardDrift = driftOf(guard, truth.guard);

  /* A release label that has caught up with the guard is not drift, but it erases
     the visual distinction the two values exist to keep. Say so; do not block. */
  const collisions = [];
  for (const site of release) {
    for (const m of site.matches) if (m.value === truth.guard) collisions.push(`${site.file}:${m.line} ${site.what}`);
  }

  /* --- check mode ---------------------------------------------------------- */
  if (!bumping) {
    if (guardDrift.length) {
      console.error('FAIL  the version guard has drifted');
      for (const d of guardDrift) console.error(`      ${d}`);
      console.error('      The guard is deliberately frozen while this tree ships the v3.9.x line. If the');
      console.error('      change is intended, move version.json "guard" and index.html together.');
      return 1;
    }
    if (releaseDrift.length) {
      console.error('FAIL  release labels disagree with version.json');
      for (const d of releaseDrift) console.error(`      ${d}`);
      console.error(`\n      Move every label to the tree's version:  node scripts/bump-version.mjs ${truth.version}`);
      console.error(`      Or move the source of truth onward:      node scripts/bump-version.mjs ${bumpVersion(truth.version, 'patch')}`);
      return 1;
    }
    if (collisions.length) {
      console.log(`warn  release and guard both read ${truth.guard} — ${collisions.join(', ')}`);
      console.log('      Not an error, but the guard loses its meaning once a release carries its number.\n');
    }

    const unpublished = unpublishedDrift(root, truth.version);
    if (unpublished) {
      console.log(`warn  delivery set changed, release did not (HEAD published ${unpublished.version})`);
      for (const line of unpublished.changed.slice(0, 12)) console.log(`      ${line}`);
      if (unpublished.changed.length > 12) console.log(`      ... and ${unpublished.changed.length - 12} more`);
      console.log('');
      console.log(`      These bytes will NOT reach an installed device: the same cache generation is`);
      console.log(`      reused so nothing is evicted, and the pinned \`index.html?v=${truth.version}\` keeps`);
      console.log('      being served. Move the label in the same commit:');
      console.log('        node scripts/bump-version.mjs patch');
      console.log('');
    }

    console.log(`ok    every release label reads ${truth.version}`);
    return 0;
  }

  /* --- apply mode ---------------------------------------------------------- */
  if (guardDrift.length) {
    console.error('FAIL  refusing to write: the version guard is already inconsistent');
    for (const d of guardDrift) console.error(`      ${d}`);
    console.error('      A bump would bury that behind a version that looks correct.');
    return 1;
  }

  const unfindable = release.filter((s) => s.missing || s.matches.length < s.min);
  if (unfindable.length) {
    console.error('FAIL  refusing to write: a release label could not be found');
    for (const s of unfindable) {
      console.error(`      ${s.file}${s.missing ? ' is missing' : `: ${s.matches.length} match(es) for ${s.what}, expected ${s.min}`}`);
    }
    console.error('      A label this script cannot find would silently stay behind. Fix the pattern first.');
    return 1;
  }

  /* One write per file: manifest.json carries three labels. */
  const byFile = new Map();
  for (const site of release) {
    if (!byFile.has(site.file)) byFile.set(site.file, { text: site.text, matches: [] });
    byFile.get(site.file).matches.push(...site.matches);
  }

  /* Built either way, so a dry run reports exactly what a real one would write
     and can compare it against the file on disk. */
  for (const [file, entry] of byFile) entry.next = rewrite(entry.text, entry.matches, next);

  if (!dryRun) {
    for (const [file, { next: text }] of byFile) {
      fs.writeFileSync(path.join(root, file), text);
    }
    fs.writeFileSync(truth.abs, JSON.stringify({ version: next, guard: truth.guard }, null, 2) + '\n');

    /* Close the loop on what actually landed. A bump that cannot verify itself is
       the same class of failure as a publish that silently delivers nothing.

       The guard is verified by its captured SPANS, not by the bytes of the file
       it lives in: index.html carries two release labels as well, so a whole-file
       comparison would report the intended move as a moved guard. */
    const stragglers = driftOf(readAll(root, RELEASE_LABELS), next);
    const guardAfter = readAll(root, GUARD_LABELS);
    guardAfter.forEach((site, i) => {
      if (site.matches.length !== guard[i].matches.length) {
        stragglers.push(`${site.file}: ${site.what} went from ${guard[i].matches.length} match(es) to ${site.matches.length}`);
      }
    });
    for (const d of driftOf(guardAfter, truth.guard)) stragglers.push(`${d} — the guard must never move`);
    if (stragglers.length) {
      console.error('FAIL  the write did not settle cleanly');
      for (const s of stragglers) console.error(`      ${s}`);
      return 1;
    }
  }

  console.log(dryRun ? 'dry run — nothing written\n' : 'written\n');
  for (const [file, { text, matches, next: rewritten }] of byFile) {
    console.log(`  ${file.padEnd(16)} ${String(matches.length).padStart(2)} label(s) -> ${next}` +
                `${rewritten === text ? '   (already there)' : ''}`);
  }
  console.log(`  ${'version.json'.padEnd(16)} release -> ${next}, guard stays ${truth.guard}`);
  console.log('');
  if (!dryRun) {
    console.log(`ok    ${truth.version} -> ${next}, every release label moved, the guard did not`);
    console.log('      Commit these together with the bytes they describe. A generation move that lands');
    console.log('      in a later push is a publish that delivered nothing.');
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
