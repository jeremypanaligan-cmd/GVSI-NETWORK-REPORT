#!/usr/bin/env node
/**
 * Writes lucide-icons.js from the lucide package in node_modules.
 *
 * The app is a static PWA with no bundler: its scripts load by name out of the service
 * worker's precache list, which every device downloads again on every generation. The
 * shipped lucide UMD bundle is 436 KB against a 117 KB index.html, and nearly all of it
 * would be precached forever to draw ~27 glyphs. So this reads the individual icon modules
 * out of node_modules/lucide/dist/esm/icons/ and emits only the ones the app names.
 *
 * USAGE
 *   node scripts/build-icons.mjs           write lucide-icons.js
 *   node scripts/build-icons.mjs --check   write nothing; exit 1 if the file differs
 *
 * The output is deterministic — same package, byte-identical file — which is what makes
 * `--check` meaningful and what tests/icons.test.js re-runs. Do not hand-edit
 * lucide-icons.js: change the ICONS list below and regenerate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Git stores this file with LF and, under `core.autocrlf`, hands the working copy back
 * with CRLF. Comparing raw bytes would therefore call a clean checkout out of date on
 * every Windows machine. Newlines are the one difference that is not a difference, so
 * both sides are compared normalized.
 * The generator always WRITES LF; the blob it is committed as is LF; only the working
 * copy varies.
 */
export function normalizeNewlines(text) {
  return text === null || text === undefined ? text : String(text).replace(/\r\n/g, '\n');
}
const LUCIDE_PKG = path.join(ROOT, 'node_modules', 'lucide', 'package.json');
const ICON_DIR = path.join(ROOT, 'node_modules', 'lucide', 'dist', 'esm', 'icons');
const OUT_FILE = path.join(ROOT, 'lucide-icons.js');

/**
 * Every icon the app draws, and the reason to add a line here rather than at a call site:
 * `lucide.icon()` resolves names at runtime, so a name that is not in this list renders
 * nothing. tests/icons.test.js walks the call sites and compares them against this list in
 * both directions, so a missing name is a failing test rather than a blank space.
 *
 * Adding an icon is two steps: this line, and the call that uses it. Regenerate after.
 */
export const ICONS = [
  'activity', // login feature list — real-time monitoring
  'arrow-right', // login button
  'ban', // admin — enable maintenance window
  'bell', // notifications — alerts ON
  'bell-off', // notifications — alerts OFF
  /* Every module has exactly one glyph, and it is the same one wherever the module is
     named — the nav row, the mobile bottom bar and the analytics snapshot card all read
     MODULE_ICONS in index.html. Separate shapes for the same module is how a dashboard
     stops being readable at a glance. */
  'boxes', // LCP — the enclosure that fans a fibre out
  'cable', // BACKBONE — the transport link itself
  'chart-column', // CHARTS tab + analytics bar glyph
  'chevron-down', // sortable header, descending
  'chevron-up', // sortable header, ascending
  'chevrons-up-down', // sortable header, unsorted
  'circle-alert', // OLT empty state — no rows arrived
  'circle-check-big', // OLT empty state healthy, admin confirm, backbone healthy
  'clock', // login feature list — uptime
  'download', // every "Export CSV"
  'eye', // password field, shown
  'eye-off', // password field, hidden
  'file-text', // every "Export PDF"
  'info', // ABOUT tab
  'log-out', // header LOGOUT
  'moon', // theme toggle, dark
  'radio-tower', // NAP — the access point that radiates
  'rocket', // app-update overlay
  'server', // OLT tab
  'settings', // ADMIN tab
  'shield', // login feature list — incident management
  'shield-check', // NODE tab, and the node empty state
  'sun', // theme toggle, light
  'triangle-alert', // alert badge in tables
  'wrench', // admin — maintenance is on
];

/**
 * The runtime that ships with the generated table. It is written out verbatim, so the
 * shape of the API is visible in the committed file rather than only here.
 */
const RUNTIME = `
(function (global) {
  'use strict';

  /* A Lucide icon's geometry is [tag, attributes] pairs; nesting never occurs in this
     package's icon format. Every attribute is emitted as-is. */
  function nodeMarkup(node) {
    var tag = node[0];
    var attrs = node[1] || {};
    var out = '<' + tag;
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) out += ' ' + key + '="' + escapeAttr(attrs[key]) + '"';
    }
    return out + '/>';
  }

  function escapeAttr(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /* The one way a template string gets an icon, and deliberately a string: these modules
     rebuild whole tables with innerHTML on every refresh, so an icon that needed a second
     pass after the paint would be missing on every repaint after the first.
     Returns '' for an unknown name — an icon is decoration, and a missing glyph must not
     take the data next to it down with it. */
  function icon(name, options) {
    var nodes = ICONS[name];
    if (!nodes) return '';
    var o = options || {};
    var size = o.size || 24;
    var attrs = {
      class: 'lucide-icon' + (o.className ? ' ' + o.className : ''),
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': o.strokeWidth || 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    };
    if (o.id) attrs.id = o.id;
    if (o.style) attrs.style = o.style;
    /* Icon-only button labels live on the button, not on the svg, so the svg is hidden from
       assistive tech by default. ariaHidden:false plus label is for an icon that IS the
       label. */
    if (o.ariaHidden === false) {
      attrs.role = 'img';
      if (o.label) attrs['aria-label'] = o.label;
    } else {
      attrs['aria-hidden'] = 'true';
    }
    var out = '<svg';
    for (var key in attrs) out += ' ' + key + '="' + escapeAttr(attrs[key]) + '"';
    out += '>';
    for (var i = 0; i < nodes.length; i++) out += nodeMarkup(nodes[i]);
    return out + '</svg>';
  }

  /* The sorted-header indicator is a ::after on th.sortable, so it decorates 38 headers
     without a single line of markup — the one win worth keeping out of a CSS-only
     indicator. Drawing it in CSS would mean hand-copying path data into styles.css, which
     is exactly the drift this file exists to prevent, so the geometry is turned into a
     mask here instead and the rules are injected once. A mask (rather than an <img> or a
     background-image) is what keeps currentColor working: the chevron is painted with
     background-color, so light, dark and every hover state follow along as before.

     styles.css keeps its text glyphs as the rule of record, so with no JS the header still
     shows something — these rules simply come later in the cascade and win. */
  function maskUrl(name, strokeWidth) {
    var nodes = ICONS[name];
    if (!nodes) return 'none';
    var body = '';
    for (var i = 0; i < nodes.length; i++) body += nodeMarkup(nodes[i]);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000"' +
      ' stroke-width="' + (strokeWidth || 2) + '" stroke-linecap="round" stroke-linejoin="round">' +
      body + '</svg>';
    return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
  }

  function sortIndicator() {
    if (typeof document === 'undefined' || document.getElementById('lucide-sort-styles')) return;
    var rule = function (sel, name, width, opacity) {
      var m = maskUrl(name, width);
      return (
        sel + '{content:"";position:absolute;right:6px;top:50%;width:10px;height:10px;' +
        'margin-top:-5px;background-color:currentColor;opacity:' + opacity + ';' +
        '-webkit-mask:' + m + ' no-repeat center/contain;mask:' + m + ' no-repeat center/contain;}'
      );
    };
    var style = document.createElement('style');
    style.id = 'lucide-sort-styles';
    style.textContent =
      rule('th.sortable::after', 'chevrons-up-down', 2.6, '.5') +
      rule('th.sort-asc::after', 'chevron-up', 3, '1') +
      rule('th.sort-desc::after', 'chevron-down', 3, '1');
    document.head.appendChild(style);
  }

  /* The shell's static markup cannot hold generated output, so it holds placeholders:
     <i data-lucide="download" data-size="14"></i>. One pass at boot turns those into real
     svgs, carrying across the id, class, style and aria-label the page put on the
     placeholder — index.html toggles #eyeIcon/#eyeOffIcon/#themeIcon by id, so those ids
     have to survive the swap. */
  function createIcons(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope) return;
    var hosts = scope.querySelectorAll('[data-lucide]');
    for (var i = 0; i < hosts.length; i++) {
      var host = hosts[i];
      var markup = icon(host.getAttribute('data-lucide'), {
        size: parseInt(host.getAttribute('data-size'), 10) || 24,
        strokeWidth: parseFloat(host.getAttribute('data-stroke-width')) || undefined,
        className: (typeof host.className === 'string' ? host.className : '') || host.getAttribute('data-class') || '',
        id: host.id || '',
        style: host.getAttribute('style') || '',
        ariaHidden: host.getAttribute('data-aria-hidden') !== 'false',
        label: host.getAttribute('aria-label') || ''
      });
      if (!markup) continue;
      host.insertAdjacentHTML('afterend', markup);
      if (host.parentNode) host.parentNode.removeChild(host);
    }
  }

  global.lucide = {
    icon: icon,
    createIcons: createIcons,
    sortIndicator: sortIndicator,
    names: Object.keys(ICONS)
  };
  global.lucideIcons = ICONS;
})(typeof window !== 'undefined' ? window : this);
`;

/**
 * Reads each named icon out of the installed package and returns the generated file text.
 * Exported so tests/icons.test.js can regenerate and compare without spawning a process.
 */
export async function generate() {
  const pkg = JSON.parse(readFileSync(LUCIDE_PKG, 'utf8'));
  const entries = [];
  for (const name of ICONS) {
    const file = path.join(ICON_DIR, `${name}.mjs`);
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (err) {
      throw new Error(
        `no icon module for "${name}" at ${file} — a name not in this lucide version, ` +
          `or node_modules is not installed (run: npm install)`
      );
    }
    entries.push([name, mod.default]);
  }

  let table = '{\n';
  entries.forEach(([name, nodes], i) => {
    table += `    ${JSON.stringify(name)}: ${JSON.stringify(nodes)}`;
    table += i === entries.length - 1 ? '\n' : ',\n';
  });
  table += '  }';

  return `/**
 * GENERATED FILE — do not edit. Run: npm run icons:build
 *
 * A tree-shaken subset of lucide@${pkg.version}, one entry per icon the app draws. Source:
 * node_modules/lucide/dist/esm/icons/*.mjs, emitted by scripts/build-icons.mjs. The full
 * bundle is 436 KB and would be precached by every device on every generation; these
 * ${entries.length} icons are a fraction of that, and --check keeps the file honest.
 *
 * lucide is licensed ISC. Copyright (c) 2022 Lucide Contributors.
 * https://github.com/lucide-icons/lucide
 *
 * API:
 *   lucide.icon(name, { size, strokeWidth, className, id, style, ariaHidden, label })
 *     -> svg markup string, inline in a template literal. '' for an unknown name.
 *   lucide.createIcons(root)
 *     -> upgrades [data-lucide] placeholders in static markup, once, at boot.
 */
var ICONS = ${table};
${RUNTIME}`;
}

async function main() {
  const check = process.argv.includes('--check');
  let next;
  try {
    next = await generate();
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }

  let current = null;
  try {
    current = readFileSync(OUT_FILE, 'utf8');
  } catch (err) {
    current = null;
  }

  if (check) {
    if (normalizeNewlines(current) === normalizeNewlines(next)) {
      console.log(`✓ lucide-icons.js matches lucide in node_modules (${ICONS.length} icons)`);
      process.exit(0);
    }
    console.error(
      '✗ lucide-icons.js is out of date with node_modules/lucide — run: npm run icons:build'
    );
    process.exit(1);
  }

  if (normalizeNewlines(current) === normalizeNewlines(next)) {
    console.log(`✓ lucide-icons.js already up to date (${ICONS.length} icons)`);
    return;
  }
  writeFileSync(OUT_FILE, next);
  console.log(`✓ wrote lucide-icons.js — ${ICONS.length} icons, ${next.length} bytes`);
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  });
}
