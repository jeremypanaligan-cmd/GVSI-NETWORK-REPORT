/* ====================== DIAGNOSTICS STORE ======================
   What THIS device waited on, this session, in memory.

   THE QUESTION THIS ANSWERS, and why the server cannot answer it. `?action=diag` reports
   what the origin spent building and where it died. It never sees the phone. When an
   operator says "ang tagal ng data", the two most common causes are indistinguishable from
   the server side: the origin really was slow, or this device's network made a fast origin
   feel slow — three attempts through a retry backoff do that, and so does 40 kB over a
   congested cell. The number that separates them is the difference between what the device
   waited and what the origin took, and only the device can compute it.

   THE EDGE ALREADY MEASURES HALF OF IT. The Cloudflare worker sets `x-netpulse-origin-ms`
   (how long the successful origin attempt took) and `x-netpulse-attempts` on every
   response, and exposes both to JavaScript. Nothing in the app has ever read them.

   BUT THE PROXY IS OFF RIGHT NOW (`window.NETPULSE_PROXY = ""` since 2026-09-15), so those
   headers are ABSENT on every live call. That decides the shape of this file rather than
   being an inconvenience to work around: every sample keeps `originMs` as null when the
   edge did not say, the summary COUNTS how many samples had edge timing, and the card says
   so in words. A missing origin time rendered as "0ms" would be the silliest lie in this
   app's history, and it is one `|| 0` away.

   WHAT THIS FILE MUST NEVER DO
     - Persist anything. No localStorage, no IndexedDB, no sending it anywhere. A stored
       history survives the "Refresh & Sync App" wipe, goes stale, and then describes a
       session that ended days ago as if it were now. Reloading is a legitimate reset.
     - Grow without bound. 20 samples per label, 24 labels, and a counter of what was
       dropped that the card SHOWS. An unbounded diagnostic on a phone is a memory leak with
       a reassuring name.
     - Throw. `record()` is total: any input, any hostile getter, and it returns false
       instead of raising, because the caller is the one function every request in the app
       goes through. A diagnostics fault that fails a request is worse than no diagnostics.
     - Keep a secret. The label is the `type` or the `action` only, sanitized to
       [A-Za-z0-9:_-] — never the URL, never a query string. The login call the app actually
       builds carries the password, and tests/diag-store.test.js records exactly that URL
       and then searches the whole snapshot for it.

       The `error` field is the ONE place a message from somewhere else lands, and this file
       does not try to scrub it: a store cannot know what is secret inside an arbitrary
       string, and a half-scrubber is worse than none because it reads as a guarantee. That
       guarantee is held at the call site instead — index.html records `err.message` ("HTTP
       502", "origin: build_failed"), and the URL it does log goes through
       safeApiUrlForLog(), which redacts password and token. Both halves are asserted. */
window.diagStore = (function () {
  'use strict';

  /* Bounds. Small enough to be obviously harmless, large enough that a shift's worth of
     tab switches is represented: five modules plus auth, revision polling, settings and
     maintenance is under a dozen labels, and one module's twenty calls is more than any
     single screen makes before something has already gone wrong. */
  var MAX_SAMPLES = 20;
  var MAX_LABELS = 24;
  var MAX_LABEL_CHARS = 24;
  var MAX_ERROR_CHARS = 120;

  var samples = {};        // label -> array of samples, oldest first
  var labelOrder = [];     // first-appearance order, so the card is stable between renders
  var dropped = 0;         // samples not kept, for any reason — shown, never hidden
  var evictedLabels = 0;
  var startedAt = null;    // first record of this session

  /* ------------------------------------------------------------------ *
     The label — the question's name
   * ------------------------------------------------------------------ */

  /* Derived from the request the app actually made rather than wired in per module, so a
     module added later is measured without anyone remembering to add it here. Everything
     that is not `type` or `action` collapses to "other": a label is a bucket, and a bucket
     per distinct URL would be the unbounded-growth bug wearing a different hat. */
  function labelFor(url) {
    var text = String(url === null || url === undefined ? '' : url);
    var m = /[?&]type=([^&#]*)/.exec(text);
    if (m) return clip(decode(m[1]));
    m = /[?&]action=([^&#]*)/.exec(text);
    if (m) return 'action:' + clip(decode(m[1]));
    return 'other';
  }

  function decode(value) {
    try {
      return decodeURIComponent(String(value));
    } catch (e) {
      return String(value);
    }
  }

  /* Whitelist, not escape. A label reaches the card's innerHTML, so the guarantee has to be
     held here: anything outside [A-Za-z0-9:_-] is dropped rather than encoded, which means a
     hostile or simply unexpected query value cannot become markup or a very long string.

     Case is PRESERVED rather than folded, and the whitelist has to allow it: the app's
     actions are camelCase (`action:setMaintenance`), so folding while stripping uppercase
     would have quietly turned one of them into `action:etaintenance` — a mangled name is
     worse than two spellings of one, because only one of those is visible on the card. */
  function clip(value) {
    return String(value).replace(/[^A-Za-z0-9:_-]/g, '').slice(0, MAX_LABEL_CHARS);
  }

  /* ------------------------------------------------------------------ *
     Recording
   * ------------------------------------------------------------------ */

  function num(value) {
    return (typeof value === 'number' && isFinite(value) && value >= 0) ? Math.round(value) : null;
  }

  function str(value, max) {
    if (typeof value !== 'string') return '';
    return value.length > max ? value.slice(0, max) + '…' : value;
  }

  /* Normalized BEFORE anything is mutated, so a sample object whose properties throw leaves
     the store exactly as it was rather than half-written. */
  function normalize(sample) {
    var s = (sample && typeof sample === 'object') ? sample : {};
    return {
      at: num(s.at) || Date.now(),
      ms: num(s.ms),
      attempts: num(s.attempts),
      originMs: num(s.originMs),
      originAttempts: num(s.originAttempts),
      ok: !!s.ok,
      error: str(s.error, MAX_ERROR_CHARS)
    };
  }

  function record(url, sample) {
    try {
      var label = labelFor(url);
      var s = normalize(sample);

      if (!samples[label]) {
        while (labelOrder.length >= MAX_LABELS) {
          var gone = labelOrder.shift();
          if (gone === undefined) break;
          dropped += (samples[gone] || []).length;
          evictedLabels++;
          delete samples[gone];
        }
        samples[label] = [];
        labelOrder.push(label);
      }

      var list = samples[label];
      list.push(s);
      while (list.length > MAX_SAMPLES) {
        list.shift();
        dropped++;
      }
      if (startedAt === null || s.at < startedAt) startedAt = s.at;
      return true;
    } catch (e) {
      return false;   // total, by contract: the caller is on the request path
    }
  }

  /* ------------------------------------------------------------------ *
     The summary the card draws
   * ------------------------------------------------------------------ */

  /* TWO definitions, both deliberate and both tested.

     `median` is the server's rule — the middle value, or the mean of the two middle values
     when the count is even. It is copied rather than reinvented (diagnostics.gs,
     `diagMedian_`) so that the two halves of this feature report the same number for the
     same calls, and a report read side by side does not look like two different systems.

     `percentile` is nearest rank, which is the only sensible reading of p95 on a handful of
     samples: the smallest value at least 95% of the data sits below. With one sample both
     return that sample rather than zero — the off-by-one that would make a single slow call
     report as 0 ms, which is the one number the card exists to show. */
  function median(values) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  function percentile(values, p) {
    if (!values.length) return null;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var idx = Math.ceil(p * sorted.length) - 1;
    if (idx < 0) idx = 0;
    if (idx > sorted.length - 1) idx = sorted.length - 1;
    return sorted[idx];
  }

  function summary() {
    var rows = [];
    try {
      labelOrder.forEach(function (label) {
        var list = samples[label] || [];
        if (!list.length) return;

        var waits = [];
        var origins = [];      // only the calls the edge actually timed
        var paired = [];       // per-call (wait - origin) for those same calls
        var retried = 0;
        var failed = 0;
        var lastAt = 0;
        var lastFailAt = 0;
        var lastError = '';

        list.forEach(function (s) {
          if (s.ms !== null) waits.push(s.ms);
          if (s.originMs !== null) {
            origins.push(s.originMs);
            /* Per-call, not the difference of two medians: the calls with edge timing are a
               subset of the calls with a wait, and a median of one set minus a median of the
               other would report a decomposition of calls that were never paired. */
            if (s.ms !== null && s.ms >= s.originMs) paired.push(s.ms - s.originMs);
          }
          if (s.attempts !== null && s.attempts > 1) retried++;
          if (!s.ok) {
            failed++;
            if (s.at >= lastFailAt) { lastFailAt = s.at; lastError = s.error || 'failed'; }
          }
          if (s.at > lastAt) lastAt = s.at;
        });

        rows.push({
          label: label,
          calls: list.length,
          waitMs: median(waits),
          waitP95Ms: percentile(waits, 0.95),
          waitMaxMs: waits.length ? Math.max.apply(null, waits) : null,
          originMs: median(origins),
          /* How many calls carried edge timing at all. The card needs this to tell "the edge
             said 0" from "the edge said nothing", which is the distinction this file exists
             to keep — the proxy is off, so today it is zero for every row. */
          edgeSamples: origins.length,
          overheadMs: median(paired),
          retried: retried,
          failed: failed,
          lastAt: lastAt,
          lastError: lastError
        });
      });
    } catch (e) {
      /* A summary that throws would take the admin screen with it. Returning what was
         gathered matches the rule this file is built on: the diagnostic never wins. */
    }
    return rows;
  }

  /* For the Copy button. A plain JSON of what is in memory, so a report pasted into a chat
     can be read without the card. */
  function snapshot() {
    var out = { at: Date.now(), startedAt: startedAt, dropped: dropped,
                evictedLabels: evictedLabels, samples: {} };
    try {
      labelOrder.forEach(function (label) {
        out.samples[label] = (samples[label] || []).map(function (s) {
          return { at: s.at, ms: s.ms, attempts: s.attempts, originMs: s.originMs,
                   originAttempts: s.originAttempts, ok: s.ok, error: s.error };
        });
      });
    } catch (e) { /* partial is still useful */ }
    return out;
  }

  function clear() {
    samples = {};
    labelOrder = [];
    dropped = 0;
    evictedLabels = 0;
    startedAt = null;
  }

  return {
    record: record,
    labelFor: labelFor,
    summary: summary,
    snapshot: snapshot,
    clear: clear,
    totals: function () {
      return { labels: labelOrder.length, dropped: dropped,
               evictedLabels: evictedLabels, startedAt: startedAt };
    },
    MAX_SAMPLES: MAX_SAMPLES,
    MAX_LABELS: MAX_LABELS
  };
})();
