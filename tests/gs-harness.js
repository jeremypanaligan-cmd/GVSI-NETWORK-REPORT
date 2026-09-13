/* ------------------------------------------------------------------ *
   GVSI NetPulse — Apps Script test harness (browser-free)

   Runs the backend .gs files in a Node `vm` context with fake Google
   service globals, so `doGet` routing and the caching layers can be
   exercised without deploying to Apps Script.

   No dependencies: only node:vm, node:crypto and node:path.

   Usage
   -----
     const { createHarness } = require('./gs-harness');
     const h = createHarness();                 // loads code.gs + admin.gs

     h.sheet('NLZ NAP Report').setGrid(3, 8, [['AREA', 'PROV', 3, 2, 1, 6]]);
     const res = h.doGet({ type: 'nap' });      // -> { text, mimeType, json }
     h.cache.puts;                              // [{ key, seconds, size }]
     h.props.getKeys();                         // current script properties
     h.clock.advanceSeconds(120);               // move time forward
     h.reset();                                 // clean slate, fresh context

   What is faithful, and why it matters
   ------------------------------------
   • `getValues()` returns '' for empty cells, as Apps Script does.
   • A1 ranges ("G24:L39") and grid ranges (row, col, nRows, nCols) both
     work, because the parsers use them and an off-by-one silently returns
     the wrong rows.
   • `Utilities.computeDigest` returns **signed** bytes (-128..127), which
     is the quirk `admin.gs` compensates for in `sha256()`. Returning
     unsigned bytes here would hide a real hashing bug.
   • `CacheService` entries really expire, and every `put` is recorded with
     its TTL, so the per-type TTLs are asserted rather than assumed.
   • `PropertiesService` has no TTL (matching Google), so the app's
     hand-rolled timestamp expiry is genuinely the thing under test.
 * ------------------------------------------------------------------ */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');

/* Default files: the router plus the handlers it delegates to. Other .gs files
   are opt-in via `files`, so trigger/backup helpers stay out of the way. */
const DEFAULT_FILES = ['code.gs', 'admin.gs'];

/* ============================ clock ============================ */

class Clock {
  constructor(startMs) {
    this.t = startMs == null ? Date.UTC(2026, 8, 12, 12, 0, 0) : startMs;
  }
  now() { return this.t; }
  advanceSeconds(seconds) { this.t += seconds * 1000; return this.t; }
  advanceMs(ms) { this.t += ms; return this.t; }
  set(ms) { this.t = ms; return this.t; }
}

/* A Date whose `new Date()` and `Date.now()` follow the harness clock, so the
   PropertiesService expiry path can be driven deterministically.

   `Symbol.hasInstance` is overridden deliberately: values cross the vm boundary,
   so a Date built in the host would otherwise fail `d instanceof Date` inside the
   context — and `code.gs`'s formatDateVal() relies on exactly that check. Making
   any real Date satisfy it keeps tests able to pass `new Date(...)` directly. */
function makeControllableDate(clock) {
  const RealDate = Date;
  class ClockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(clock.now());
      else super(...args);
    }
    static now() { return clock.now(); }
    static [Symbol.hasInstance](value) { return value instanceof RealDate; }
  }
  ClockDate.parse = RealDate.parse;
  ClockDate.UTC = RealDate.UTC;
  return ClockDate;
}

/* ============================ A1 notation ============================ */

function columnToIndex(letters) {
  let n = 0;
  const upper = String(letters).toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    n = n * 26 + (upper.charCodeAt(i) - 64);
  }
  return n - 1;
}

function indexToColumn(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/* ============================ sheets ============================ */

class FakeRange {
  constructor(sheet, row0, col0, numRows, numCols) {
    this.sheet = sheet;
    this.row0 = row0;
    this.col0 = col0;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getRow() { return this.row0 + 1; }
  getColumn() { return this.col0 + 1; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }

  getA1Notation() {
    const a = indexToColumn(this.col0) + (this.row0 + 1);
    const b = indexToColumn(this.col0 + this.numCols - 1) + (this.row0 + this.numRows);
    return a === b ? a : a + ':' + b;
  }

  getValues() {
    this.sheet.reads++;
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.values[this.row0 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col0 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }

  getValue() { return this.getValues()[0][0]; }

  setValue(value) {
    const row = this.sheet._row(this.row0);
    row[this.col0] = value;
    this.sheet.writes++;
    return this;
  }

  setValues(matrix) {
    matrix.forEach((row, r) => {
      const target = this.sheet._row(this.row0 + r);
      row.forEach((v, c) => { target[this.col0 + c] = v; });
    });
    this.sheet.writes++;
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.values = [];      // row-major, 0-based; sparse rows are fine
    this.reads = 0;        // getValues() calls — used to assert cache hits
    this.writes = 0;       // setValue()/appendRow()/deleteRow() calls
  }

  /* ---- authoring helpers (not part of the Apps Script API) ---- */

  /** Seed a block. 1-based, mirroring getRange(). */
  setGrid(startRow, startCol, matrix) {
    matrix.forEach((row, r) => {
      const target = this._row(startRow - 1 + r);
      row.forEach((v, c) => { target[startCol - 1 + c] = v; });
    });
    return this;
  }

  setCell(row, col, value) {
    this._row(row - 1)[col - 1] = value;
    return this;
  }

  clear() { this.values = []; return this; }

  /* ---- Apps Script API ---- */

  _row(i) {
    if (!this.values[i]) this.values[i] = [];
    return this.values[i];
  }

  getName() { return this.name; }

  _isBlank(v) { return v === '' || v === null || v === undefined; }

  getLastRow() {
    let last = 0;
    this.values.forEach((row, i) => {
      if (row && row.some((v) => !this._isBlank(v))) last = i + 1;
    });
    return last;
  }

  getLastColumn() {
    let last = 0;
    this.values.forEach((row) => {
      if (!row) return;
      for (let c = row.length - 1; c >= 0; c--) {
        if (!this._isBlank(row[c])) { last = Math.max(last, c + 1); break; }
      }
    });
    return last;
  }

  getMaxRows() { return this.values.length; }

  /**
   * Mirrors Apps Script's overloads:
   *   getRange(row, col)                 -> one cell
   *   getRange(row, col, numRows)        -> one column
   *   getRange(row, col, numRows, cols)  -> block
   *   getRange('A1') / getRange('A1:B2') -> A1 notation
   */
  getRange(a, b, c, d) {
    if (typeof a === 'string') return this._rangeFromA1(a);
    if (b === undefined) {   // getRange(row) -> the whole row
      return new FakeRange(this, a - 1, 0, 1, Math.max(this.getLastColumn(), 1));
    }
    if (c === undefined) return new FakeRange(this, a - 1, b - 1, 1, 1);
    if (d === undefined) return new FakeRange(this, a - 1, b - 1, c, 1);
    return new FakeRange(this, a - 1, b - 1, c, d);
  }

  _rangeFromA1(a1) {
    const clean = String(a1).replace(/\$/g, '').trim();
    const block = clean.match(/^([A-Za-z]+)(\d+):([A-Za-z]+)(\d+)$/);
    if (block) {
      const r1 = Number(block[2]) - 1;
      const r2 = Number(block[4]) - 1;
      const c1 = columnToIndex(block[1]);
      const c2 = columnToIndex(block[3]);
      return new FakeRange(
        this,
        Math.min(r1, r2), Math.min(c1, c2),
        Math.abs(r2 - r1) + 1, Math.abs(c2 - c1) + 1
      );
    }
    const single = clean.match(/^([A-Za-z]+)(\d+)$/);
    if (single) {
      return new FakeRange(this, Number(single[2]) - 1, columnToIndex(single[1]), 1, 1);
    }
    throw new Error('Unsupported A1 range: ' + a1);
  }

  getDataRange() {
    const rows = Math.max(this.getLastRow(), 1);
    const cols = Math.max(this.getLastColumn(), 1);
    return new FakeRange(this, 0, 0, rows, cols);
  }

  appendRow(row) {
    this.setGrid(this.getLastRow() + 1, 1, [row]);
    this.writes++;
    return this;
  }

  deleteRow(rowPosition) {
    this.values.splice(rowPosition - 1, 1);
    this.writes++;
    return this;
  }
}

class FakeSpreadsheet {
  constructor() {
    this.sheets = new Map();
    this.inserted = [];
  }

  getSheetByName(name) {
    return this.sheets.has(name) ? this.sheets.get(name) : null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    this.inserted.push(name);
    return sheet;
  }

  /* Authoring helper: create-or-get, used for seeding in tests. */
  ensureSheet(name) {
    return this.getSheetByName(name) || this.insertSheet(name);
  }

  getSheets() { return Array.from(this.sheets.values()); }

  getId() { return 'fake-spreadsheet-id'; }
  getName() { return 'GVSI NetPulse Test Sheet'; }
}

/* ============================ CacheService ============================ */

class FakeScriptCache {
  constructor(clock) {
    this.clock = clock;
    this.store = new Map();
    this.puts = [];     // { key, seconds, size }
    this.gets = [];
  }

  get(key) {
    this.gets.push(key);
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.clock.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  put(key, value, seconds) {
    const ttl = Number(seconds) || 0;
    this.puts.push({ key, seconds: ttl, size: String(value).length });
    this.store.set(key, {
      value: String(value),
      // Apps Script treats a 0 TTL as "no expiry".
      expiresAt: ttl > 0 ? this.clock.now() + ttl * 1000 : Infinity
    });
  }

  putAll(entries, seconds) {
    Object.keys(entries).forEach((k) => this.put(k, entries[k], seconds));
  }

  remove(key) { this.store.delete(key); }

  removeAll(keys) { keys.forEach((k) => this.store.delete(k)); }

  getKeys() { return Array.from(this.store.keys()); }

  has(key) { return this.get(key) !== null; }

  /** TTL recorded for the most recent write to a key, or null. */
  ttlFor(key) {
    const hit = [...this.puts].reverse().find((p) => p.key === key);
    return hit ? hit.seconds : null;
  }

  clear() { this.store.clear(); this.puts = []; this.gets = []; }
}

/* ============================ PropertiesService ============================ */

class FakeScriptProperties {
  constructor() {
    this.map = new Map();
    this.sets = [];
    this.deletes = [];
    // Counters, not just logs. Apps Script meters "Properties read/write" against
    // a DAILY quota (50,000 on a consumer account), so a session lookup whose cost
    // grows with the number of stored sessions is an outage risk, not a style nit.
    // Read = getProperty + getKeys; write = setProperty + deleteProperty.
    this.reads = 0;
    this.writes = 0;
  }

  getProperty(key) {
    this.reads++;
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setProperty(key, value) {
    this.writes++;
    this.sets.push(String(key));
    this.map.set(String(key), String(value));
    return this;
  }

  setProperties(obj) {
    Object.keys(obj).forEach((k) => this.setProperty(k, obj[k]));
    return this;
  }

  deleteProperty(key) {
    this.writes++;
    this.deletes.push(String(key));
    this.map.delete(String(key));
    return this;
  }

  getKeys() {
    this.reads++;
    return Array.from(this.map.keys());
  }

  has(key) { return this.map.has(key); }

  clear() { this.map.clear(); this.sets = []; this.deletes = []; this.reads = 0; this.writes = 0; }
}

/* ============================ Utilities / ContentService ============================ */

const DIGEST_ALGORITHMS = {
  SHA_256: 'sha256',
  SHA_1: 'sha1',
  MD5: 'md5'
};

const CHARSETS = {
  UTF_8: 'utf8',
  US_ASCII: 'ascii',
  ISO_8859_1: 'latin1'
};

function createUtilities(defaultTimeZone) {
  const tz = defaultTimeZone || 'Etc/UTC';
  const sleeps = [];
  let uuidCounter = 0;
  const utils = {
    DigestAlgorithm: {
      MD5: 'MD5',
      SHA_1: 'SHA_1',
      SHA_256: 'SHA_256'
    },
    Charset: {
      US_ASCII: 'US_ASCII',
      UTF_8: 'UTF_8',
      ISO_8859_1: 'ISO_8859_1'
    },

    computeDigest(algorithm, input, charset) {
      const algo = DIGEST_ALGORITHMS[String(algorithm)];
      if (!algo) throw new Error('Unsupported digest algorithm: ' + algorithm);
      const encoding = CHARSETS[String(charset)] || 'utf8';
      const buf = crypto.createHash(algo).update(String(input), encoding).digest();
      // Apps Script hands back SIGNED bytes. sha256() in admin.gs corrects for
      // that (`if (byte < 0) byte += 256`), so reproducing it here is the point.
      return Array.from(buf, (b) => (b > 127 ? b - 256 : b));
    },

    // Honours the time zone argument rather than assuming UTC, so a test can
    // pin (or vary) the script time zone the way a deployment would.
    formatDate(date, timeZone, pattern) {
      const d = date instanceof Date ? date : new Date(date);
      const zone = timeZone || tz;
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23'
      });
      const parts = {};
      for (const part of fmt.formatToParts(d)) parts[part.type] = part.value;
      const map = {
        yyyy: parts.year,
        MM: parts.month,
        dd: parts.day,
        HH: parts.hour,
        mm: parts.minute,
        ss: parts.second
      };
      return String(pattern).replace(/yyyy|MM|dd|HH|mm|ss/g, (token) => map[token]);
    },

    formatString(pattern, ...args) {
      let i = 0;
      return String(pattern).replace(/%s/g, () => String(args[i++]));
    },

    /* Recorded, never performed: the login throttle asserts that a failure
       actually waited, without the suite paying the wall-clock cost. */
    sleep(ms) { sleeps.push(Number(ms) || 0); },

    /* UUID-shaped and unique per context. Real getUuid() values are close to
       sequential, which is exactly why issueSessionToken() mixes in two. */
    getUuid() {
      uuidCounter += 1;
      return '00000000-0000-4000-8000-' + String(uuidCounter).padStart(12, '0');
    },

    base64Encode(input) {
      return Buffer.from(String(input), 'utf8').toString('base64');
    },

    base64Decode(input) {
      return Buffer.from(String(input), 'base64').toString('utf8');
    },

    newBlob(data, contentType) {
      return {
        getDataAsString: () => String(data),
        getContentType: () => contentType
      };
    }
  };

  utils.sleeps = sleeps;
  return utils;
}

function createContentService() {
  return {
    MimeType: {
      JSON: 'application/json',
      TEXT: 'text/plain',
      JAVASCRIPT: 'application/javascript',
      HTML: 'text/html'
    },
    createTextOutput(content) {
      let text = content === undefined || content === null ? '' : String(content);
      return {
        _text: text,
        _mimeType: 'text/plain',
        setContent(next) { text = String(next); this._text = text; return this; },
        setMimeType(mime) { this._mimeType = mime; return this; },
        getContent() { return text; },
        getMimeType() { return this._mimeType; },
        toString() { return text; }
      };
    }
  };
}

/* ============================ harness ============================ */

function createHarness(options) {
  const opts = options || {};
  const files = opts.files || DEFAULT_FILES;
  const root = opts.root ? path.resolve(opts.root) : REPO_ROOT;
  const clock = new Clock(opts.now);

  /* The fake services live in a mutable holder so reset() can REPLACE them.
     Replacing rather than clearing matters: a test that stubs a method (e.g. to
     simulate a CacheService outage with `h.cache.get = () => { throw ... }`)
     would otherwise leak that stub into every later test in the file, silently
     skipping whole branches of doGet. Replacing makes isolation total. */
  const timeZone = opts.timeZone || 'Etc/UTC';
  const services = {
    spreadsheet: new FakeSpreadsheet(),
    cache: new FakeScriptCache(clock),
    props: new FakeScriptProperties(),
    // Inside the holder so reset() can replace it too — otherwise the recorded
    // sleeps would leak across tests, the same isolation bug as the stubbed
    // cache methods below.
    utilities: createUtilities(timeZone)
  };
  const logs = [];

  const state = { clock, logs, context: null };

  function buildContext() {
    const sandbox = {
      Date: makeControllableDate(clock),
      SpreadsheetApp: {
        getActiveSpreadsheet: () => services.spreadsheet,
        getActive: () => services.spreadsheet,
        openById: () => services.spreadsheet,
        openByUrl: () => services.spreadsheet,
        flush: () => {}
      },
      CacheService: {
        getScriptCache: () => services.cache,
        getUserCache: () => services.cache,
        getDocumentCache: () => services.cache
      },
      PropertiesService: {
        getScriptProperties: () => services.props,
        getUserProperties: () => services.props,
        getDocumentProperties: () => services.props
      },
      ContentService: createContentService(),
      Utilities: services.utilities,
      Session: {
        getScriptTimeZone: () => timeZone,
        getActiveUser: () => ({ getEmail: () => 'tester@example.com' }),
        getEffectiveUser: () => ({ getEmail: () => 'tester@example.com' })
      },
      Logger: {
        log: (message) => { logs.push(String(message)); }
      },
      console: {
        log: (...args) => { logs.push(args.map(String).join(' ')); },
        warn: (...args) => { logs.push('WARN ' + args.map(String).join(' ')); },
        error: (...args) => { logs.push('ERROR ' + args.map(String).join(' ')); }
      }
    };

    const context = vm.createContext(sandbox);
    state.context = context;
    return context;
  }

  function loadContext() {
    const context = buildContext();
    for (const file of files) {
      const fullPath = path.resolve(root, file);
      if (!fs.existsSync(fullPath)) {
        throw new Error('Harness: missing backend file ' + fullPath);
      }
      vm.runInContext(fs.readFileSync(fullPath, 'utf8'), context, { filename: file });
    }
    return context;
  }

  /** Fresh context + brand-new fake services, so nothing can leak between tests. */
  function reset() {
    services.spreadsheet = new FakeSpreadsheet();
    services.cache = new FakeScriptCache(clock);
    services.props = new FakeScriptProperties();
    services.utilities = createUtilities(timeZone);
    logs.length = 0;
    clock.set(opts.now == null ? Date.UTC(2026, 8, 12, 12, 0, 0) : opts.now);
    loadContext();
    return api;
  }

  /** Invoke a top-level .gs function by name. */
  function call(name, ...args) {
    const fn = state.context[name];
    if (typeof fn !== 'function') {
      throw new Error('Harness: ' + name + ' is not defined (is its .gs file loaded?)');
    }
    return fn.apply(state.context, args);
  }

  /**
   * Call doGet with a plain params object.
   * Returns { text, mimeType, json } — `json` is undefined if parsing fails.
   */
  function doGet(params) {
    const res = call('doGet', { parameter: Object.assign({}, params || {}) });
    const text = typeof res === 'string' ? res : res.getContent();
    const mimeType = typeof res === 'string' ? 'text/plain' : res.getMimeType();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = undefined; }
    return { text, mimeType, json, raw: res };
  }

  /** Seeding accessor: creates the sheet if absent. */
  function sheet(name) {
    return services.spreadsheet.ensureSheet(name);
  }

  /** Lookup without creating — null when the sheet does not exist. */
  function findSheet(name) {
    return services.spreadsheet.getSheetByName(name);
  }

  /** Total getValues() calls across every sheet. */
  function sheetReads() {
    return services.spreadsheet.getSheets().reduce((sum, s) => sum + s.reads, 0);
  }

  const api = {
    // state — getters, so they always point at the current fakes after a reset()
    get spreadsheet() { return services.spreadsheet; },
    get cache() { return services.cache; },
    get props() { return services.props; },
    get utilities() { return services.utilities; },
    /** Milliseconds passed to Utilities.sleep(), in call order. */
    get sleeps() { return services.utilities.sleeps; },
    clock,
    logs,
    sheet,
    findSheet,
    sheetReads,
    // interaction
    reset,
    call,
    doGet,
    // escape hatch
    get context() { return state.context; },
    get files() { return files.slice(); }
  };

  reset();
  return api;
}

/** Convenience: run the harness body with an auto-resetting harness. */
function withHarness(options, body) {
  const h = createHarness(options);
  return body(h);
}

module.exports = {
  createHarness,
  withHarness,
  Clock,
  FakeSheet,
  FakeSpreadsheet,
  FakeScriptCache,
  FakeScriptProperties,
  columnToIndex,
  indexToColumn,
  DEFAULT_FILES,
  REPO_ROOT
};
