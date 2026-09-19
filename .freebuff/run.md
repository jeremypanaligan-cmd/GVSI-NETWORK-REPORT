# Run doc — GVSI NetPulse (local preview)

A static PWA shell. The server only has to serve this directory over HTTP.

## 1. Reproduce the artifacts a fresh checkout needs

**Nothing is required to run the app.** There is no env file and no build step in the
serving path.

- No `.env*`. The deployment URL is inline in `index.html` (`window.APPS_SCRIPT_URL`),
  and `window.NETPULSE_PROXY` is deliberately blank while the Cloudflare worker is off.
- `index.html` loads `styles.css`, `lucide-icons.js` and every module script by name.

One generated file IS committed — `lucide-icons.js`, the tree-shaken Lucide subset the
icons are drawn from. It needs rebuilding only when the icon list changes or the package
is upgraded, and `node_modules` exists only for that:

```bash
npm install                 # lucide is a build-time dependency; node_modules/ is gitignored
node scripts/build-icons.mjs --check   # exit 1 if the committed file drifted
node scripts/build-icons.mjs           # rewrite it (npm run icons:build)
```

Running the app does **not** require `npm install`: the generated file is committed and
precached, so a fresh clone is already runnable. (`plannable/` is a separate, unbuilt npm
package and is not needed either.)

## 2. Run the server

Port **8080** is the project's own default (`serve-local.py`) and it was free.
This is the recipe that actually works on this machine (Windows, Git Bash):

```bash
powershell -NoProfile -Command "(Start-Process -FilePath 'C:\Users\Jeremy Panaligan\AppData\Local\Python\pythoncore-3.14-64\python.exe' -ArgumentList '-m','http.server','8080','--bind','127.0.0.1' -WorkingDirectory 'C:\Users\Jeremy Panaligan\Documents\GitHub\GVSI NETWORK REPORT' -RedirectStandardOutput '<LOG>' -RedirectStandardError '<LOG>.err' -WindowStyle Hidden -PassThru).Id"
```

It prints the pid. Confirm it survived, then confirm the URL answers:

```bash
powershell -NoProfile -Command "Get-Process -Id <pid>"
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/index.html
```

Two mistakes the first attempt made, recorded so they are not repeated:

- **Use `-WorkingDirectory`, do not pass `--directory`.** `Start-Process -ArgumentList`
  joins its array with spaces and does **not** re-quote, so a path containing a space
  (`...\Jeremy Panaligan\...`) arrives as two arguments and the server exits with
  `unrecognized arguments: Panaligan\Documents\GitHub\GVSI NETWORK REPORT`.
- **`serve-local.py` is not the launcher.** It crashes on a cp1252 console
  (`UnicodeEncodeError` from its emoji `print()`, already logged as TODO.md P3).
  `python -m http.server` is the substitute. It needs no CORS header: the app calls
  Apps Script cross-origin, and Google answers for itself.

## 3. The one thing that makes the preview look stale

`sw.js` is **cache-first** for the entire shell, and its precache list holds the
UNVERSIONED names the page requests (`olt-module.js`, `styles.css`). Delivery therefore
depends on the release label or the cache generation moving together with the bytes — a
rule `sw.js`'s own header states. An edit that lands without that move keeps serving the
old bytes out of `gvsi-shell-v*` on every reload.

Clear it in the preview **before reloading after an edit**:

```js
(await navigator.serviceWorker.getRegistrations()).forEach(r => r.unregister());
(await caches.keys()).forEach(k => caches.delete(k));
```

The next load re-fetches every asset from disk and re-precaches the NEW bytes, so this is
a per-edit step, not a permanent one.

This bites a NEW file hardest: a generation a device already holds has no
`lucide-icons.js` in its precache, so between an edit and the release that moves the label,
the page asks for a file the worker cannot answer from cache. Both a stale and a missing
answer are why the label has to move in the same commit as the bytes.

Where it bites, measured: the page asks for `styles.css?v=3.9.13`, and that VERSIONED URL is the
one the worker answers cache-first and re-caches, while `install` refreshes the UNVERSIONED
precache entry (`styles.css`). On a plain reload of an edited tree this was observed as
`transferSize: 0`, 454 rules, no `.olt-empty-*` selectors — with the 466-rule copy on disk.
Clearing caches and reloading can land the stale HTTP-cached response back into the worker, so if
the page still looks old after a clear, hard-reload it (Ctrl+Shift+R).

## 4. What the preview shows

The app boots to its **login gate**. No credentials are used or needed here.

On a brand-new browser profile it first shows the app's own *"App Update Available /
Refresh & Sync App"* overlay: `checkAppVersion()` compares `localStorage.app_version`
against `REQUIRED_APP_VERSION` (`3.10.0`), and a fresh profile has no such key. One tap
on its button clears it and reloads. That is first-visit behavior of the app itself, not
a fault introduced by the preview.
