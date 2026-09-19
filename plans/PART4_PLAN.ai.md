@PlannablePlan v0.1

ID=PART-004
PH=LUCIDE_ICON_SYSTEM
SCN=SCN-004,SCN-006
OUT=A generated subset of the installed package, wired into the shell and precache
DEP=[]

DICT:
G=goal; CTX=context; C=constraint; F=file(+=new, ~=modified, ?=maybe); T=task; AC=acceptance; V=verify; DONE=completion; S=stop

G:
- Lucide reaches a static, bundler-less PWA as a small generated file, not a 436 KB bundle.

CTX:
- product: GVSI NetPulse — offline-first PWA, no bundler, module scripts loaded by name
- phase: Lucide icon system (part 1/5)
- prior: none — this is the first part
- next: PART-005 and PART-006 replace the icons themselves
- installed: lucide@1.47.0 (ISC), 3696 individual icon files under dist/esm/icons/
- the whole UMD is 436 KB (min) against a 117 KB index.html — the reason for a subset

C:
- preserve-existing-work
- avoid-unrelated-edits
- ask-before-new-deps
- the generated file must be deterministic: same input, byte-identical output
- it must be committed and must NOT be edited by hand
- `icon()` returns a whole `<svg>` for template strings (no re-init needed); `createIcons()`
  upgrades `[data-lucide]` for static markup once at boot

F:
+ scripts/build-icons.mjs
+ lucide-icons.js
~ index.html
~ sw.js
~ package.json
~ .gitignore

T:
1 Allowlist of the 30 names actually used, kebab-case, in a fixed order.
2 For each, dynamic-import node_modules/lucide/dist/esm/icons/<name>.mjs and take the default export.
3 Emit lucide-icons.js: the icon table, the ISC notice and package version, and
  window.lucide = { icons, icon(name, opts), createIcons(root) } with Lucide's own defaults
  (viewBox 0 0 24 24, fill none, stroke currentColor, stroke-width 2, round caps and joins).
4 Unknown names: return no SVG and warn once in the console — never a silent blank.
5 index.html: script tag before the module scripts, unversioned like the rest.
6 sw.js: add './lucide-icons.js' to STATIC_ASSETS.
7 package.json: declare lucide as a devDependency; .gitignore: node_modules/.

AC:
- lucide-icons.js is generated, committed, and smaller than 40 KB for the 30 icons.
- `node scripts/build-icons.mjs --check` reports no drift immediately after generating.
- Every name in the allowlist resolves to a real file in the installed package.
- The generated file carries the lucide version and the ISC notice.

V:
- node scripts/build-icons.mjs --check
- node --check lucide-icons.js
- for t in tests/*.test.js; do node "$t"; done

DONE:
- update MASTER_PLAN.md Part 4=[x]
- append PLAN_EVIDENCE.md#PART-004: summary+files+checks+notes

S:
- if a name does not exist in this lucide version, stop and report it rather than substituting
- do not vendor the UMD bundle
