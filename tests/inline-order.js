/* ------------------------------------------------------------------ *
   Temporal-dead-zone guard for the app's front-end scripts.

   Why this exists
   ---------------
   A top-level `const`/`let`/`class` in a classic <script> is in its temporal
   dead zone until its own statement has run. The app calls into itself from
   statements placed ABOVE some of its own declarations, so a declaration that a
   reachable function reads throws

       ReferenceError: Cannot access 'X' before initialization

   at first paint — and ONLY at first paint, because calling the same function
   from the console afterwards works fine. That is what makes it invisible to
   manual testing and to every other check we have. It has happened twice:

     - `dataCache` read by checkAppVersion(), which runs before the inline script
       that declares it (documented in cache-control.js);
     - the module-skeleton table read by fetchNapData(), called from
       loadInitialData() further up the same inline script.

   Both were cross-cutting: the reader lived in a separate file, so the check
   below walks EVERY script the page loads, in load order, not just the inline
   one.

   What it does
   ------------
   1. Build the page's script list in execution order (external scripts where
      the file exists locally, plus inline blocks) from index.html.
   2. Blank out comments and string/template literals so brace counting and
      identifier scanning see only code. Offsets and line numbers are preserved.
   3. Find top-level declarations, top-level eager call sites, and each
      function's own body.
   4. For every eager call, follow the call graph through those bodies. If a
      reached function reads a top-level `const`/`let`/`class` that is declared
      later than the call (later in the same script, or in a script that loads
      after it), that is a violation.

   This is an APPROXIMATION, not a parser. It is deliberately conservative about
   what counts as reachable, so it under-reports rather than crying wolf:
     - Bodies of anonymous function expressions and of block-bodied arrows are
       treated as deferred callbacks and skipped — correct for addEventListener,
       setTimeout, .then, .map/.forEach, and wrong for an IIFE written
       anonymously. Documented false negative.
     - Calls through a property (`x.y()`) or a computed key are not followed.
       Documented false negative.
     - Single-expression arrows (`x => x.trim()`) are NOT skipped, so a late name
       read only there is still reported. Documented false positive risk.
     - Shadowing is respected: if a body declares its own `const|let|var` with the
       same name, the read refers to the local and is ignored.
   If the scanner cannot make sense of the source it throws, so "no violations"
   always means "checked", never "gave up".
 * ------------------------------------------------------------------ */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* ---------------------------- lexing helpers ---------------------------- */

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof',
  'function', 'new', 'do', 'else', 'delete', 'void', 'in', 'of', 'case',
  'throw', 'yield', 'await', 'super', 'this', 'class', 'const', 'let', 'var',
  'import', 'export', 'default', 'with'
]);

/* A `/` after one of these starts a regex literal, not a division. */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'yield', 'await', 'case', 'throw'
]);

const isIdentChar = (ch) => !!ch && /[A-Za-z0-9_$]/.test(ch);

/** The identifier ending at `end` (inclusive), scanning back through `buf`. */
function trailingWord(buf, end) {
  let k = end;
  let out = '';
  while (k >= 0 && isIdentChar(buf[k])) {
    out = buf[k] + out;
    k--;
  }
  return out;
}

/** Can a `/` at `at` start a regex literal? Standard previous-token heuristic. */
function regexAllowed(buf, at) {
  let k = at - 1;
  while (k >= 0 && /\s/.test(buf[k])) k--;
  if (k < 0) return true;
  const ch = buf[k];
  if (isIdentChar(ch)) return REGEX_AFTER_KEYWORD.has(trailingWord(buf, k));
  // After `)` or `]` a `/` is division; after `}` it is nearly always a block.
  return ch !== ')' && ch !== ']';
}

/**
 * Blank comments and string/template literals. Same length, newlines kept, so
 * every offset and line number still points at the original source. The code
 * inside a template literal's `${...}` is KEPT, because that part is code.
 */
function maskLiterals(code) {
  const out = code.split('');
  const n = code.length;

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  // Template literal text from `start`; masks literals, keeps `${...}` code.
  function scanTemplate(start) {
    let i = start;
    while (i < n) {
      const c = code[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { blank(start, i + 1); return i + 1; }
      if (c === '$' && code[i + 1] === '{') {
        blank(start, i + 2);
        i = scanCode(i + 2, true);
        start = i;
        continue;
      }
      i++;
    }
    blank(start, n);
    return n;
  }

  // Normal code from `start`. With `stopAtBraceClose`, returns just past the `}`
  // that closes the current interpolation.
  function scanCode(start, stopAtBraceClose) {
    let i = start;
    let depth = 0;
    while (i < n) {
      const c = code[i];
      const c2 = code[i + 1];

      if (c === '/' && c2 === '/') {
        const j = code.indexOf('\n', i);
        const e = j === -1 ? n : j;
        blank(i, e); i = e; continue;
      }
      if (c === '/' && c2 === '*') {
        const j = code.indexOf('*/', i + 2);
        const e = j === -1 ? n : j + 2;
        blank(i, e); i = e; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < n) {
          if (code[j] === '\\') { j += 2; continue; }
          if (code[j] === c || code[j] === '\n') { j++; break; }
          j++;
        }
        blank(i, j); i = j; continue;
      }
      if (c === '`') { i = scanTemplate(i); continue; }
      if (c === '/' && regexAllowed(out, i)) {
        let j = i + 1;
        let inClass = false;
        while (j < n) {
          const d = code[j];
          if (d === '\\') { j += 2; continue; }
          if (d === '\n') break;
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) { j++; break; }
          j++;
        }
        blank(i, j); i = j; continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        if (stopAtBraceClose && depth === 0) return i + 1;
        depth--;
      }
      i++;
    }
    return n;
  }

  scanCode(0, false);
  return out.join('');
}

/** Nesting depth (braces + parens + brackets) at every offset. */
function depthMap(masked) {
  const d = new Int32Array(masked.length + 1);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{' || c === '(' || c === '[') { d[i] = depth; depth++; }
    else if (c === '}' || c === ')' || c === ']') { depth = Math.max(0, depth - 1); d[i] = depth; }
    else d[i] = depth;
  }
  d[masked.length] = depth;
  return d;
}

/**
 * Bodies of functions that are invoked on the spot — `(function () { … })()` and
 * `(() => { … })()`. These run during the script's own evaluation, so for our
 * purposes their insides ARE top level.
 *
 * This is not a detail: cache-control.js wraps its entire body in one, and the
 * `dataCache` read that caused the first historical bug lives three calls deep
 * inside it. Requiring depth 0 would make that whole file invisible.
 */
function iifeRanges(masked) {
  const ranges = [];
  const consider = (open) => {
    if (open === -1) return;
    const close = matchingBrace(masked, open);
    if (close === -1) return;
    // `… } ) (` — the closing `)` then an argument list. A plain callback passed
    // as an argument ends in `,` or `)`, so it cannot match.
    if (!/^\s*\)\s*\(/.test(masked.slice(close + 1, close + 40))) return;
    ranges.push([open + 1, close]);
  };

  const fns = /\bfunction\b\s*(?:[A-Za-z_$][\w$]*\s*)?\(/g;
  let m;
  while ((m = fns.exec(masked))) consider(masked.indexOf('{', m.index));

  const arrows = /=>\s*\{/g;
  while ((m = arrows.exec(masked))) consider(masked.indexOf('{', m.index));

  return ranges;
}

/**
 * Depth with any enclosing IIFE body folded away, so a declaration that is
 * top-level *within the IIFE* counts as top level. Offsets are unchanged, which
 * matters because the analysis compares declaration and call positions.
 */
function effectiveDepth(masked) {
  const orig = depthMap(masked);
  const eff = Int32Array.from(orig);
  iifeRanges(masked).forEach(([a, b]) => {
    // Measure from the depth just inside the IIFE's own body, rather than
    // subtracting a flat 1. `(function () { … })()` is wrapped in BOTH a brace
    // and a parenthesis, so its body starts at depth 2 — subtracting one left
    // every function in cache-control.js at depth 1, which made the whole file
    // invisible to the analysis.
    const base = orig[a];
    for (let i = a; i < b && i < eff.length; i++) eff[i] = Math.max(0, eff[i] - base);
  });
  return eff;
}

/** Index of the `}` matching the `{` at `open`. */
function matchingBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* --------------------------- script collection --------------------------- */

/** Inline <script> blocks, in document order, with their first source line. */
function extractInlineScripts(html) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const openTagEnd = m.index + m[0].indexOf('>') + 1;
    const startLine = html.slice(0, openTagEnd).split('\n').length;
    scripts.push({ code: m[1], startLine, at: m.index });
  }
  return scripts;
}

/** Local srcs referenced by the page, in document order. */
function extractScriptSrcs(html) {
  const srcs = [];
  const re = /<script[^>]*\bsrc=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) srcs.push(m[1]);
  return srcs;
}

/**
 * Every script the page runs, in execution order: external files first where the
 * source sits next to index.html, inline blocks in their document position.
 * CDN scripts (DOMPurify) are skipped — no local source, nothing to read.
 */
function loadScriptUnits(rootDir) {
  const indexPath = path.join(rootDir, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  const units = [];
  const inline = extractInlineScripts(html);
  let inlineIdx = 0;

  const push = (name, code, startLine) => {
    units.push({ name, code, startLine, order: units.length });
  };

  // Walk the document, interleaving external and inline blocks in the order they
  // appear, which is the order a browser executes them.
  const tagRe = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const tag = m[0];
    const src = /\bsrc=["']([^"']+)["']/.exec(tag);
    if (src) {
      if (/^https?:\/\//i.test(src[1])) continue;
      const file = src[1].split('?')[0].replace(/^\.\//, '');
      const full = path.join(rootDir, file);
      if (!fs.existsSync(full)) continue;
      push(file, fs.readFileSync(full, 'utf8'), 1);
      continue;
    }
    const unit = inline[inlineIdx++];
    if (unit) push('index.html (inline #' + inlineIdx + ')', unit.code, unit.startLine);
  }

  if (!units.length) throw new Error('inline-order: found no scripts in index.html');
  return units;
}

/* ------------------------------- analysis ------------------------------- */

/**
 * Declarations that are top level in their script (IIFE wrappers folded away):
 * const/let/var/class/function.
 */
function topLevelDeclarations(masked, depths) {
  const out = [];
  const re = /\b(const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    out.push({ kind: m[1], name: m[2], offset: m.index });
  }
  return out;
}

/**
 * Call sites that run while the script is evaluating — top level, including the
 * top level of an IIFE. A call through a property (`netpulseCache.invalidateAll(`)
 * is recorded under the method name, which is how the `dataCache` chain is found.
 */
function topLevelCalls(masked, depths) {
  const out = [];
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    // Skip `function foo(`, which is a declaration, not a call.
    const before = masked.slice(Math.max(0, m.index - 12), m.index);
    if (/\bfunction\s+$/.test(before)) continue;
    out.push({ callee: name, offset: m.index });
  }
  return out;
}

/**
 * Function bodies we can follow: named `function` declarations at any depth that
 * are not nested inside another one we already recorded, plus `const NAME =
 * function|(…) =>` forms with a block body.
 */
function collectFunctions(masked, depths) {
  const fns = new Map();
  const record = (name, declOffset) => {
    if (fns.has(name)) return;
    const open = masked.indexOf('{', declOffset);
    if (open === -1) return;
    const close = matchingBrace(masked, open);
    if (close === -1) return;
    fns.set(name, { bodyStart: open + 1, bodyEnd: close });
  };

  const fdecl = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = fdecl.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    record(m[1], m.index);
  }

  const assigned = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\(?[^)=]*\)?\s*=>\s*\{)/g;
  while ((m = assigned.exec(masked))) {
    if (depths[m.index] !== 0) continue;
    record(m[1], m.index);
  }

  return fns;
}

/**
 * A function's own body: nested anonymous function expressions and block-bodied
 * arrows are blanked, because they are callbacks that run later — not when the
 * outer function is entered. An IIFE is kept, since it does run immediately.
 */
function ownBody(masked, start, end) {
  const out = masked.split('');
  const blank = (a, b) => {
    for (let k = a; k < b && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };

  // APIs that only ever call their callback later. A single-expression arrow
  // passed to one of these (`setInterval(() => backgroundRefresh('olt'), …)`)
  // looks like a plain call, but it cannot run while this script evaluates — so
  // blank the callback argument instead of following it.
  const deferring = /\b(?:setTimeout|setInterval|requestAnimationFrame|queueMicrotask|addEventListener|removeEventListener)\s*\(|\.(?:then|catch|finally)\s*\(/g;
  let d;
  while ((d = deferring.exec(masked))) {
    if (d.index < start || d.index >= end) continue;
    const open = masked.indexOf('(', d.index);
    if (open === -1 || open >= end) continue;
    const close = matchingParen(masked, open);
    if (close === -1 || close > end) continue;
    // Only a callback-shaped argument is deferred; a computed argument is
    // evaluated eagerly, so leave `setTimeout(nextDelay(), 10)` alone.
    const args = masked.slice(open + 1, close);
    if (!/=>|\bfunction\b/.test(args)) continue;
    blank(d.index, close + 1);
  }

  // A read inside `try { … } catch (…) { … }` cannot break the page: the TDZ
  // ReferenceError is thrown synchronously and caught. cache-control.js's
  // getDataCache() is deliberately this shape — it is the documented workaround
  // for genuinely running before the app boots — so mask such bodies. Everything
  // inside is covered, including reads reached through calls made there.
  // `try { … } finally { … }` is NOT a guard, so it is left alone.
  const tryBlock = /\btry\s*\{/g;
  let m;
  while ((m = tryBlock.exec(masked))) {
    if (m.index < start || m.index >= end) continue;
    const open = masked.indexOf('{', m.index);
    const close = matchingBrace(masked, open);
    if (close === -1 || close > end) continue;
    if (!/^\s*catch\b/.test(masked.slice(close + 1, close + 40))) continue;
    blank(open, close + 1);
  }

  const anon = /\bfunction\b\s*\(/g;
  while ((m = anon.exec(masked))) {
    if (m.index < start || m.index >= end) continue;
    const open = masked.indexOf('{', m.index);
    if (open === -1 || open >= end) continue;
    const close = matchingBrace(masked, open);
    if (close === -1 || close > end) continue;
    // `})()` — an IIFE runs now, so leave it alone.
    if (/^\s*\)?\s*\(/.test(masked.slice(close + 1, close + 6))) continue;
    blank(m.index, close + 1);
  }

  const arrow = /=>\s*\{/g;
  while ((m = arrow.exec(masked))) {
    if (m.index < start || m.index >= end) continue;
    const open = masked.indexOf('{', m.index);
    const close = matchingBrace(masked, open);
    if (close === -1 || close > end) continue;
    if (/^\s*\)?\s*\(/.test(masked.slice(close + 1, close + 6))) continue;
    blank(m.index, close + 1);
  }

  return out.slice(start, end).join('');
}

/** Index of the `)` matching the `(` at `open`. */
function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Ranges of a body that do NOT run during script evaluation: everything after an
 * `await`, and the argument list of a `.then(`/`.catch(`/`.finally(`. A call
 * inside one of these resumes from a microtask, so it can no longer hit the dead
 * zone of a declaration later in the same script — the microtask checkpoint only
 * happens once that script's top level has finished.
 *
 * (It can still hit a declaration in a LATER script: microtasks drain before the
 * next script is evaluated. findTdzViolations() keeps that distinction.)
 */
function asyncRegions(body) {
  const regions = [];

  // `await f()` evaluates f() right now and defers only what follows, so the
  // region starts at the END of the awaited statement — not at the `await`
  // keyword. Getting this wrong is not academic: it is what hid the dataCache
  // case, where the offending read sits inside the awaited expression.
  const awaited = /\bawait\b/g;
  let a;
  while ((a = awaited.exec(body))) {
    let parens = 0;
    let brackets = 0;
    let braces = 0;
    let end = body.length;
    for (let i = a.index; i < body.length; i++) {
      const c = body[i];
      if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
      else if (c === '{') braces++;
      else if (c === '}') {
        if (parens <= 0 && braces === 0) { end = i; break; }
        braces--;
      } else if (c === ';' && parens <= 0 && brackets <= 0 && braces === 0) {
        end = i + 1;
        break;
      }
    }
    regions.push([end, body.length]);
  }

  // The callback handed to .then()/.catch()/.finally() resumes from a microtask.
  const chained = /\.(?:then|catch|finally)\s*\(/g;
  let m;
  while ((m = chained.exec(body))) {
    const open = body.indexOf('(', m.index);
    const close = matchingParen(body, open);
    if (close !== -1) regions.push([open, close]);
  }

  return regions;
}

const inRegions = (regions, offset) => regions.some(([a, b]) => offset > a && offset < b);

/** Calls from a body we can follow, each flagged if it resumes from a microtask. */
function calleesIn(body, fns) {
  const regions = asyncRegions(body);
  const found = [];
  const seen = new Set();
  const re = /([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    const name = m[1];
    if (KEYWORDS.has(name)) continue;
    if (/\bfunction\s+$/.test(body.slice(Math.max(0, m.index - 12), m.index))) continue;
    if (!fns.has(name) || seen.has(name)) continue;
    seen.add(name);
    found.push({ name, afterAsync: inRegions(regions, m.index) });
  }
  return found;
}

/**
 * Offsets in `body` where `name` is read as a value. Empty when the body declares
 * its own `name` (shadowing), or when every occurrence is a property access
 * (`.name`) or an object key (`{ name:` / `, name:`) rather than a read.
 *
 * Offsets rather than a boolean, because WHERE the read sits decides whether it
 * can still hit the dead zone: a read that only runs after an `await` resumes
 * from a microtask, which is too late for a declaration later in the same script
 * but still early enough for one in a script that has not been evaluated yet.
 */
function readOffsets(body, name) {
  const shadow = new RegExp('\\b(?:const|let|var|function)\\s+' + name + '\\b');
  if (shadow.test(body)) return [];

  const out = [];
  const re = new RegExp('\\b' + name + '\\b', 'g');
  let m;
  while ((m = re.exec(body))) {
    const i = m.index;
    if (body[i - 1] === '.') continue;                       // property access
    let k = i - 1;
    while (k >= 0 && /\s/.test(body[k])) k--;
    if (body[i + name.length] === ':' && (body[k] === '{' || body[k] === ',')) continue; // object key
    out.push(i);
  }
  return out;
}


/** Line number (1-based, in the original file) for an offset. */
function lineAt(unit, offset) {
  return unit.startLine + unit.code.slice(0, offset).split('\n').length - 1;
}

/**
 * Every top-level const/let/class read from a function reachable by a call that
 * runs before the declaration is initialised.
 *
 * Returns [] when clean, otherwise [{ script, line, name, callLine, callName }].
 */
function findTdzViolations(units) {
  const parsed = units.map((unit) => {
    const masked = maskLiterals(unit.code);
    const depths = effectiveDepth(masked);
    return {
      unit,
      masked,
      depths,
      // `order` is the script's position in execution order; offsets only
      // compare meaningfully inside one script.
      decls: topLevelDeclarations(masked, depths).map((d) => ({ ...d, order: unit.order })),
      calls: topLevelCalls(masked, depths).map((c) => ({ ...c, order: unit.order })),
      fns: collectFunctions(masked, depths)
    };
  });

  // Functions may be reached from any script, so follow the graph across all of
  // them rather than per file.
  const allFns = new Map();
  parsed.forEach((p) => p.fns.forEach((body, name) => { if (!allFns.has(name)) allFns.set(name, body); }));

  const violations = [];
  const seen = new Set();

  // Every declaration in the page, each tagged with the script that owns it. It
  // has to be the UNION across scripts: a call in one script can run before a
  // declaration in a script that has not been evaluated yet. Taking only the
  // calling script's own declarations made that whole case unreachable.
  const allDecls = [];
  parsed.forEach((p) => p.decls.forEach((d) => {
    if (d.kind === 'const' || d.kind === 'let' || d.kind === 'class') {
      allDecls.push({ ...d, script: p.unit.name });
    }
  }));

  parsed.forEach((p) => {
    p.calls.forEach((call) => {
      if (!allFns.has(call.callee)) return;

      // Breadth-first over the call graph, starting from the eager call. Each
      // function carries whether every path to it crossed a microtask boundary.
      const syncReachable = new Map();   // name -> true when reached synchronously
      const queue = [{ name: call.callee, afterAsync: false, sync: true }];
      while (queue.length) {
        const item = queue.shift();
        const known = syncReachable.get(item.name);
        if (known !== undefined && (known === true || item.sync === false)) continue;
        syncReachable.set(item.name, item.sync);

        const def = allFns.get(item.name);
        const owner = parsed.find((q) => q.fns.has(item.name));
        const body = ownBody(owner.masked, def.bodyStart, def.bodyEnd);
        calleesIn(body, allFns).forEach((next) => {
          queue.push({
            name: next.name,
            afterAsync: next.afterAsync,
            sync: item.sync && !next.afterAsync
          });
        });
      }

      allDecls.forEach((d) => {
        // Later in the SAME script: only a path that runs without yielding can
        // hit the dead zone, because a microtask resumes after that script's top
        // level has finished.
        const laterInSameScript = d.order === call.order && d.offset > call.offset;
        // In a script that loads AFTER this one: microtasks drain before the next
        // script is evaluated, so even an awaited path arrives too early. (The
        // reader must live in THIS script to still be defined at that point, which
        // is exactly what makes the case reachable.)
        const inLaterScript = d.order > call.order;
        if (!laterInSameScript && !inLaterScript) return;

        syncReachable.forEach((sync, fnName) => {
          const def = allFns.get(fnName);
          const owner = parsed.find((q) => q.fns.has(fnName));
          const body = ownBody(owner.masked, def.bodyStart, def.bodyEnd);

          const reads = readOffsets(body, d.name);
          if (!reads.length) return;

          const regions = asyncRegions(body);
          const syncRead = reads.some((o) => !inRegions(regions, o));

          // Both halves matter: `sync` is how the function was reached, `syncRead`
          // is where inside it the read happens. Checking only the first reported
          // a read that sits after an `await` — a false positive on the app's most
          // common shape.
          if (laterInSameScript && (!sync || !syncRead)) return;

          const key = d.name + '|' + fnName;
          if (seen.has(key)) return;
          seen.add(key);
          violations.push({
            name: d.name,
            declaredIn: d.script,
            script: p.unit.name,
            line: lineAt(p.unit, call.offset),
            callName: call.callee,
            readBy: fnName,
            viaMicrotask: !sync || !syncRead
          });
        });
      });
    });
  });

  return violations;
}

/* ------------------------------ public API ------------------------------ */

/**
 * Analyse a set of scripts. `units` is [{ name, code, startLine? }] in execution
 * order — position in the array IS the load order, so fixtures do not have to
 * number themselves. Exposed separately so tests can feed fixtures as well as
 * the real app.
 */
function analyse(units) {
  return findTdzViolations(units.map((u, i) => ({ startLine: 1, ...u, order: i })));
}

/** Analyse the real app, loading index.html and the scripts it references. */
function analyseApp(rootDir) {
  return analyse(loadScriptUnits(rootDir));
}

module.exports = {
  analyse,
  analyseApp,
  loadScriptUnits,
  extractInlineScripts,
  extractScriptSrcs,
  maskLiterals,
  depthMap,
  // Exported so a test can assert on the individual steps, and so a failure can
  // be narrowed to the lexer, the graph walk, or the read check.
  iifeRanges,
  effectiveDepth,
  topLevelDeclarations,
  topLevelCalls,
  collectFunctions,
  ownBody,
  calleesIn,
  // Exported for the boot-graph guard, which needs to slice a call's argument
  // list out of masked source ("is saveDailySnapshot inside a setTimeout?").
  matchingParen,
  matchingBrace,
  readOffsets,
  asyncRegions,
  findTdzViolations
};
