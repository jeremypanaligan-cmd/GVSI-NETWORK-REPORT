/* ==========================================================================
   GVSI NetPulse — KIOSK MODE / NOC WALL DISPLAY   (v3.9.3)
   --------------------------------------------------------------------------
   Presentation layer only.

   WHAT THIS FILE DOES
   - Renders five read-only slides (NAP, LCP, OLT, NODE, BACKBONE) into
     #kioskRoot, replacing the previous "kiosk = restyled admin tabs" approach.
   - Reads live data from the existing `dataCache` and triggers the existing
     module fetchers. It never re-implements fetching, polling, caching or
     sanitising — the admin pipeline stays exactly as it is.

   WHAT THIS FILE DOES NOT DO
   - No changes to admin views: the slides live in their own DOM subtree and
     every class is `kiosk-` prefixed (see kiosk.css).
   - No touching of global app state: dark mode is NOT forced, the theme
     button is NOT rewritten, and `switchTab` is NOT called. Kiosk owns its
     own slide index, so admin tab state survives untouched.

   LIVE DATA SOURCES (unchanged)
   - dataCache.nap / .lcp / .olt / .node / .backbone  (populated by the existing
     fetchNapData/fetchLcpData/fetchOltData/fetchNodeData/fetchBackboneData)
   ========================================================================== */

/* ------------------------------------------------------------------ *
   Slide model
 * ------------------------------------------------------------------ */
var KIOSK_SLIDE_IDS = ['nap', 'lcp', 'olt', 'node', 'backbone'];

var KIOSK_SLIDE_META = {
  nap: { title: 'NAP Outages', tag: 'NAP MODULE' },
  lcp: { title: 'LCP Outages & Impact', tag: 'LCP MODULE' },
  olt: { title: 'OLT Status', tag: 'OLT MODULE' },
  node: { title: 'Node Status', tag: 'NODE MODULE' },
  backbone: { title: 'Backbone Links', tag: 'BACKBONE MODULE' }
};

/* Rank limits — real "+N more" footnotes are built from whatever is left over. */
var KIOSK_LIMITS = {
  napHotspots: 6,
  lcpAreas: 5,
  oltDownCards: 2,
  nodeCards: 5,
  backboneCards: 7
};

var KIOSK_DEFAULT_ROTATE_MS = 9000;   /* 8–10s per slide, per design direction */
var KIOSK_REFRESH_MS = 60000;         /* re-pull the visible module every minute */
var KIOSK_WATCH_MS = 2000;            /* notice fresh data arriving from the pipeline */
var KIOSK_IDLE_RESUME_MS = 30000;     /* auto-resume after manual interaction */

/* ------------------------------------------------------------------ *
   State
 * ------------------------------------------------------------------ */
var _kioskMode = false;
var _kioskPaused = false;
var _kioskIdlePaused = false;
var _kioskIndex = 0;
var _kioskRotateMs = KIOSK_DEFAULT_ROTATE_MS;
var _kioskElapsed = 0;
var _kioskSlideStart = 0;   /* wall-clock deadline base for the current slide */
var _kioskPausedAt = 0;     /* when rotation was paused, so the deadline can shift */
var _kioskRafId = null;
var _kioskClockTimer = null;
var _kioskRefreshTimer = null;
var _kioskWatchTimer = null;
var _kioskIdleTimer = null;
var _kioskEscapeCount = 0;
var _kioskEscapeTimer = null;
var _kioskSeenRef = { nap: null, lcp: null, olt: null, node: null, backbone: null };
var _kioskLastSync = { nap: null, lcp: null, olt: null, node: null, backbone: null };

/* ------------------------------------------------------------------ *
   Small helpers
 * ------------------------------------------------------------------ */
function kioskEsc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function kioskInt(value) {
  var n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

/* "Nueva_Ecija" -> "Nueva Ecija" */
function kioskProvince(value) {
  var s = String(value === null || value === undefined ? '' : value).replace(/_/g, ' ').trim();
  return s || '—';
}

/* "NUEVA ECIJA" -> "Nueva Ecija" */
function kioskTitleCase(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/(^|\s|[(-])([a-z])/g, function (m, pre, ch) { return pre + ch.toUpperCase(); });
}

/* Real duration -> minutes (falls back to the app's own parser when present) */
function kioskDurationMinutes(text) {
  if (typeof parseDurationToMinutes === 'function') return parseDurationToMinutes(text);
  var s = String(text || '').toLowerCase();
  var d = s.match(/(\d+)\s*d/);
  var h = s.match(/(\d+)\s*h/);
  var m = s.match(/(\d+)\s*m/);
  return (d ? kioskInt(d[1]) * 1440 : 0) + (h ? kioskInt(h[1]) * 60 : 0) + (m ? kioskInt(m[1]) : 0);
}

function kioskPct(part, whole) {
  if (!whole) return 0;
  return (part / whole) * 100;
}

function kioskPctText(part, whole) {
  return kioskPct(part, whole).toFixed(1) + '%';
}

function kioskTime(date) {
  if (!date) return '—';
  try {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  } catch (e) {
    return '—';
  }
}

function kioskClockTime(date) {
  try {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  } catch (e) {
    return '--:--:--';
  }
}

function kioskPlural(count, singular, plural) {
  return count + ' ' + (count === 1 ? singular : (plural || singular + 's'));
}

/* ------------------------------------------------------------------ *
   Data access — read-only views onto the existing pipeline
 * ------------------------------------------------------------------ */
function kioskCache() {
  return (typeof dataCache !== 'undefined' && dataCache) ? dataCache : null;
}

function kioskSource(type) {
  var cache = kioskCache();
  var value = cache ? cache[type] : null;

  if (type === 'lcp') {
    if (value && (value.lcpAging || value.lcpImpact)) return value;
    return null;
  }
  if (type === 'olt') {
    if (Array.isArray(value)) return value;
    if (typeof rawOltData !== 'undefined' && Array.isArray(rawOltData) && rawOltData.length) return rawOltData;
    return null;
  }
  if (Array.isArray(value)) return value;
  return null;
}

/* Kick the module's own fetcher — the very same functions the admin tabs use.
   Cache-first inside those functions, so this is cheap and never re-implements
   fetch/polling logic. */
function kioskFetch(type) {
  var map = {
    nap: 'fetchNapData',
    lcp: 'fetchLcpData',
    olt: 'fetchOltData',
    node: 'fetchNodeData',
    backbone: 'fetchBackboneData'
  };
  var fn = map[type];
  if (!fn) return;
  try {
    if (typeof window[fn] === 'function') window[fn]();
  } catch (e) {
    /* non-fatal: the watchdog keeps whatever the cache already holds on screen */
  }
}

/* ------------------------------------------------------------------ *
   Live value snapshots
   One keyed map per module. Every entry carries its value plus whether an
   increase is bad news — that polarity is what lets a change be coloured
   correctly later (an OLT going down is red, an OLT coming back is teal).
   This is the single source of truth for the pill, the ticker and change
   tracking, so those three can never disagree with each other.
 * ------------------------------------------------------------------ */
function kioskSnapshotAll() {
  var snap = { nap: null, lcp: null, olt: null, node: null, backbone: null, pill: null };

  /* ---- NAP ---- */
  var nap = kioskSource('nap');
  if (nap) {
    var n = {
      active: { value: 0, polarity: 'bad-up' },
      h: { value: 0, polarity: 'bad-up' },
      d1: { value: 0, polarity: 'bad-up' },
      d3: { value: 0, polarity: 'bad-up' }
    };
    nap.forEach(function (r) {
      var area = String(r.A || '').trim();
      if (!area || area.toUpperCase() === 'TOTAL') return;
      var h = kioskInt(r.H), d1 = kioskInt(r.D1), d3 = kioskInt(r.D3);
      var total = kioskInt(r.T) || (h + d1 + d3);
      n.active.value += total;
      n.h.value += h;
      n.d1.value += d1;
      n.d3.value += d3;
      n[kioskAreaKey(kioskProvince(r.P), area)] = { value: total, polarity: 'bad-up', item: true };
    });
    snap.nap = n;
  }

  /* ---- LCP ---- */
  var lcp = kioskSource('lcp');
  if (lcp) {
    var l = {
      clients: { value: 0, polarity: 'bad-up' },
      down: { value: 0, polarity: 'bad-up' },
      tickets: { value: 0, polarity: 'bad-up' },
      aged: { value: 0, polarity: 'bad-up' }
    };
    (Array.isArray(lcp.lcpImpact) ? lcp.lcpImpact : []).forEach(function (r) {
      var area = String(r.A || '').trim();
      if (!area || area.toUpperCase() === 'TOTAL') return;
      var clients = kioskInt(r.C);
      l.clients.value += clients;
      l.down.value += kioskInt(r.LCP);
      l.tickets.value += kioskInt(r.TT);
      l[kioskAreaKey(kioskProvince(r.P), area)] = { value: clients, polarity: 'bad-up', item: true };
    });
    (Array.isArray(lcp.lcpAging) ? lcp.lcpAging : []).forEach(function (r) {
      var area = String(r.A || '').trim();
      if (!area || area.toUpperCase() === 'TOTAL') return;
      l.aged.value += kioskInt(r.D1) + kioskInt(r.D3);
    });
    snap.lcp = l;
  }

  /* ---- OLT ---- */
  var olt = kioskSource('olt');
  if (olt) {
    var b = kioskOltBuckets(olt);
    var o = {
      total: { value: b.total, polarity: 'bad-up' },
      up: { value: b.up, polarity: 'good-up' },
      down: { value: b.down, polarity: 'bad-up' },
      low: { value: b.low, polarity: 'bad-up' },
      uplink: { value: b.uplink, polarity: 'bad-up' },
      degradation: { value: b.degradation, polarity: 'bad-up' },
      clientsDown: { value: b.clientsDown, polarity: 'bad-up' }
    };
    olt.forEach(function (item) {
      if (String(item.S || item.STATUS || '').trim().toUpperCase() !== 'DOWN') return;
      o[kioskDeviceKey(item.N || item.OLT_NAME)] = { value: 1, polarity: 'bad-up', item: true };
    });
    snap.olt = o;
  }

  /* ---- NODE ---- */
  var node = kioskSource('node');
  if (node) {
    var nd = { incidents: { value: 0, polarity: 'bad-up' }, nodes: { value: 0, polarity: 'bad-up' }, provinces: { value: 0, polarity: 'bad-up' } };
    var nodeProvinces = {};
    node.forEach(function (r) {
      nd.incidents.value++;
      nd.nodes.value += kioskInt(r.C);
      nodeProvinces[kioskProvince(r.P).toLowerCase()] = 1;
      nd[kioskAreaKey(kioskProvince(r.P), '')] = { value: kioskInt(r.C), polarity: 'bad-up', item: true };
    });
    nd.provinces.value = Object.keys(nodeProvinces).filter(Boolean).length;
    snap.node = nd;
  }

  /* ---- BACKBONE ---- */
  var bb = kioskSource('backbone');
  if (bb) {
    var cats = kioskBackboneCounts(bb);
    var bsnap = {
      links: { value: cats.total, polarity: 'bad-up' },
      dwdmLow: { value: cats.dwdmLow, polarity: 'bad-up' },
      dwdmDown: { value: cats.dwdmDown, polarity: 'bad-up' },
      mplsLow: { value: cats.mplsLow, polarity: 'bad-up' },
      mplsDown: { value: cats.mplsDown, polarity: 'bad-up' }
    };
    kioskBackboneLinkList(bb).forEach(function (link) {
      bsnap[kioskLinkKey(link.text)] = { value: 1, polarity: 'bad-up', item: true };
    });
    snap.backbone = bsnap;
  }

  /* ---- Top pill: the aggregated alert count ---- */
  if (snap.nap || snap.lcp || snap.olt || snap.node || snap.backbone) {
    snap.pill = {
      alerts: {
        value: kioskValue(snap, 'nap', 'active') +
          kioskValue(snap, 'lcp', 'down') +
          kioskValue(snap, 'olt', 'down') +
          kioskValue(snap, 'node', 'incidents') +
          kioskValue(snap, 'backbone', 'dwdmDown') +
          kioskValue(snap, 'backbone', 'mplsDown'),
        polarity: 'bad-up'
      }
    };
  }

  return snap;
}

/* Stable snapshot keys — shared by the snapshot builder and the renderers so a
   highlight can never be looked up under a key nobody stored. */
function kioskAreaKey(province, area) {
  return 'area::' + province + '|' + (area || '');
}

function kioskDeviceKey(name) {
  return 'dev::' + String(name || '-').trim();
}

function kioskLinkKey(text) {
  return 'link::' + String(text || '').trim();
}

function kioskValue(snap, mod, key) {
  return (snap[mod] && snap[mod][key]) ? snap[mod][key].value : 0;
}

function kioskItemCount(snap, mod, prefix) {
  if (!snap[mod]) return 0;
  var n = 0;
  Object.keys(snap[mod]).forEach(function (k) { if (k.indexOf(prefix) === 0) n++; });
  return n;
}

function kioskItemProvinces(snap, mod, prefix) {
  if (!snap[mod]) return 0;
  var seen = {}, n = 0;
  Object.keys(snap[mod]).forEach(function (k) {
    if (k.indexOf(prefix) !== 0) return;
    var province = k.split('|')[0].slice(prefix.length);
    if (!seen[province]) { seen[province] = 1; n++; }
  });
  return n;
}

/* Aggregates reused by the top pill and the ticker (derived from the snapshot
   above so the pill, the ticker and change tracking share one source). */
function kioskAggregates() {
  var snap = kioskSnapshotAll();
  function v(mod, key) { return kioskValue(snap, mod, key); }

  return {
    napTotal: v('nap', 'active'),
    napAreas: kioskItemCount(snap, 'nap', 'area::'),
    napProvinces: kioskItemProvinces(snap, 'nap', 'area::'),
    napBuckets: { h: v('nap', 'h'), d1: v('nap', 'd1'), d3: v('nap', 'd3') },
    lcpDown: v('lcp', 'down'),
    lcpTickets: v('lcp', 'tickets'),
    lcpClients: v('lcp', 'clients'),
    lcpAged: v('lcp', 'aged'),
    lcpProvinces: kioskItemProvinces(snap, 'lcp', 'area::'),
    oltTotal: v('olt', 'total'),
    oltUp: v('olt', 'up'),
    oltDown: v('olt', 'down'),
    oltLow: v('olt', 'low'),
    oltUplink: v('olt', 'uplink'),
    oltDegradation: v('olt', 'degradation'),
    oltClientsDown: v('olt', 'clientsDown'),
    nodeIncidents: v('node', 'incidents'),
    nodeProvinces: kioskItemProvinces(snap, 'node', 'area::'),
    nodeNodes: v('node', 'nodes'),
    bbLinks: v('backbone', 'links'),
    bbDown: v('backbone', 'dwdmDown') + v('backbone', 'mplsDown'),
    bbLow: v('backbone', 'dwdmLow') + v('backbone', 'mplsLow'),
    ready: {
      nap: snap.nap !== null,
      lcp: snap.lcp !== null,
      olt: snap.olt !== null,
      node: snap.node !== null,
      backbone: snap.backbone !== null
    }
  };
}

/* Same classification the admin OLT module uses, so kiosk and admin never
   disagree about a status. "OLT UPLINK LOW POWER" counts as low power. */
function kioskOltBuckets(rows) {
  var b = { up: 0, down: 0, low: 0, uplink: 0, degradation: 0, total: rows.length, clientsDown: 0 };
  rows.forEach(function (item) {
    var status = String(item.S || item.STATUS || '').trim().toUpperCase();
    if (status === 'DOWN') {
      b.down++;
      b.clientsDown += kioskInt(item.CA);
    } else if (status.indexOf('LOW POWER') !== -1) {
      b.low++;
    } else if (status.indexOf('UPLINK DOWN') !== -1) {
      b.uplink++;
    } else if (status.indexOf('DEGRADATION') !== -1) {
      b.degradation++;
    } else {
      b.up++;
    }
  });
  return b;
}

/* OLT cause inventory is intentionally DOWN-only for the kiosk outage view. */
function kioskOltDownCauses(rows) {
  var counts = {};
  (rows || []).forEach(function (item) {
    var status = String(item.S || item.STATUS || '').trim().toUpperCase();
    if (status !== 'DOWN') return;
    var cause = String(item.DC || item.DT_CAUSE || '').trim() || 'UNKNOWN';
    counts[cause] = (counts[cause] || 0) + 1;
  });

  return Object.keys(counts).map(function (label) {
    return { label: label, count: counts[label] };
  }).sort(function (a, b) {
    return b.count - a.count || a.label.localeCompare(b.label);
  });
}

function kioskCauseColor(cause) {
  var c = String(cause || '').toUpperCase();
  if (c.indexOf('FIBER') !== -1 && c.indexOf('POWER') !== -1) return 'var(--k-violet)';
  if (c.indexOf('FIBER') !== -1) return 'var(--k-red)';
  if (c.indexOf('POWER') !== -1) return 'var(--k-amber)';
  if (c.indexOf('EQUIPMENT') !== -1 || c.indexOf('HARDWARE') !== -1) return 'var(--k-yellow)';
  return 'var(--k-teal)';
}

function kioskOltCauseStrip(rows) {
  var causes = kioskOltDownCauses(rows);
  if (!causes.length) {
    return '<div class="kiosk-cause-strip is-empty"><span class="kiosk-cause-heading">DT Cause Breakdown</span><span class="kiosk-cause-empty">No DOWN OLT cause data</span></div>';
  }

  return '<div class="kiosk-cause-strip" aria-label="OLT down outage cause breakdown">' +
    '<div class="kiosk-cause-heading">DT Cause Breakdown <small>DOWN OLTs only</small></div>' +
    '<div class="kiosk-cause-list">' + causes.map(function (cause) {
      var color = kioskCauseColor(cause.label);
      return '<div class="kiosk-cause-badge" style="--cause-color:' + color + '">' +
        '<span class="kiosk-cause-dot"></span>' +
        '<span class="kiosk-cause-label">' + kioskEsc(cause.label) + '</span>' +
        '<b>' + kioskChanged('olt', 'cause::' + cause.label, cause.count) + '</b>' +
        '</div>';
    }).join('') + '</div></div>';
}

/* Service type uses the app's own transform when available (NPE -> MPLS) */
function kioskService(raw) {
  if (typeof transformBbService === 'function') return transformBbService(raw);
  var s = String(raw || '').trim().toUpperCase();
  return s === 'NPE' ? 'MPLS' : (s || '-');
}

function kioskIsLinkDown(issue) {
  return String(issue || '').toUpperCase().indexOf('LINK DOWN') !== -1;
}

function kioskBackboneCounts(rows) {
  var c = { total: 0, dwdmLow: 0, dwdmDown: 0, mplsLow: 0, mplsDown: 0 };
  rows.forEach(function (item) {
    var service = kioskService(item.S);
    var count = kioskInt(item.LC) || 1;
    var down = kioskIsLinkDown(item.IS);
    c.total += count;
    if (service === 'DWDM') {
      if (down) c.dwdmDown += count; else c.dwdmLow += count;
    } else if (service === 'MPLS') {
      if (down) c.mplsDown += count; else c.mplsLow += count;
    }
  });
  return c;
}

/* Individual affected links (a single ticket can carry several). Shared by the
   renderer and the change snapshot so both see the very same link list. */
function kioskBackboneLinkList(rows) {
  var links = [];
  rows.forEach(function (item) {
    var service = kioskService(item.S);
    var down = kioskIsLinkDown(item.IS);
    var province = kioskTitleCase(item.P);
    var aging = String(item.AG || '—');
    var impact = String(item.I || '—');
    var raw = String(item.L || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!raw.length) raw = ['—'];
    raw.forEach(function (text) {
      links.push({
        service: service,
        down: down,
        province: province,
        text: text,
        aging: aging,
        impact: impact,
        minutes: kioskDurationMinutes(aging)
      });
    });
  });
  return links;
}

/* ------------------------------------------------------------------ *
   Change tracking — "what moved since the previous refresh?"
   The first complete picture becomes the baseline; every later snapshot is
   diffed against it by VALUE, so a re-fetch that returns identical numbers
   stays quiet. Detected changes become a delta chip plus a short flash, so
   someone who looks up at the wall can tell what is new without having had
   to watch it happen.
 * ------------------------------------------------------------------ */
var KIOSK_CHANGE_TTL_MS = 90000;      /* how long a highlight stays visible     */
var KIOSK_BASELINE_WAIT_MS = 45000;   /* wait this long for a complete baseline */

var _kioskBaseline = null;
var _kioskBaselineModules = {};
var _kioskBaselineWaitStart = 0;
var _kioskChanges = {};
var _kioskTickerHadChanges = false;

var KIOSK_CHANGE_LABELS = {
  'nap:active': 'NAP outages',
  'nap:h': 'NAP < 24h',
  'nap:d1': 'NAP 1–3 days',
  'nap:d3': 'NAP > 3 days',
  'lcp:clients': 'LCP clients affected',
  'lcp:down': 'LCPs down',
  'lcp:tickets': 'LCP tickets',
  'lcp:aged': 'LCPs aged past 24h',
  'olt:total': 'OLTs tracked',
  'olt:up': 'OLTs up',
  'olt:down': 'OLTs down',
  'olt:low': 'OLTs low power',
  'olt:uplink': 'OLT uplink down',
  'olt:degradation': 'OLT degradation',
  'olt:clientsDown': 'OLT clients affected',
  'node:incidents': 'NODE incidents',
  'node:nodes': 'NODE nodes affected',
  'node:provinces': 'NODE provinces affected',
  'backbone:links': 'backbone links affected',
  'backbone:dwdmDown': 'DWDM links down',
  'backbone:dwdmLow': 'DWDM low power',
  'backbone:mplsDown': 'MPLS links down',
  'backbone:mplsLow': 'MPLS low power',
  'pill:alerts': 'active alerts'
};

function kioskResetChanges() {
  _kioskBaseline = null;
  _kioskBaselineModules = {};
  _kioskBaselineWaitStart = 0;
  _kioskChanges = {};
  _kioskTickerHadChanges = false;
}

function kioskChangeFresh(change) {
  return !!change && (Date.now() - change.at) < KIOSK_CHANGE_TTL_MS;
}

function kioskChange(mod, key) {
  var change = _kioskChanges[mod + ':' + key];
  return kioskChangeFresh(change) ? change : null;
}

function kioskRecordChange(mod, key, kind, delta, item) {
  var worse;
  if (kind === 'new') worse = true;
  else if (kind === 'up') worse = item.polarity !== 'good-up';
  else worse = item.polarity === 'good-up';

  _kioskChanges[mod + ':' + key] = {
    module: mod,
    key: key,
    kind: kind,
    delta: delta,
    tone: worse ? 'alert' : 'ok',
    at: Date.now()
  };
}

function kioskTrackChanges() {
  var snap = kioskSnapshotAll();
  var now = Date.now();

  /* The first complete picture is the baseline — nothing has "changed" yet. */
  if (!_kioskBaseline) {
    var complete = !!(snap.nap && snap.lcp && snap.olt && snap.node && snap.backbone);
    if (!complete && !_kioskBaselineWaitStart) _kioskBaselineWaitStart = now;
    var waitedTooLong = _kioskBaselineWaitStart && (now - _kioskBaselineWaitStart) > KIOSK_BASELINE_WAIT_MS;
    if (!complete && !waitedTooLong) return;

    _kioskBaseline = snap;
    _kioskBaselineModules = {
      nap: !!snap.nap,
      lcp: !!snap.lcp,
      olt: !!snap.olt,
      node: !!snap.node,
      backbone: !!snap.backbone,
      pill: !!snap.pill
    };
    return;
  }

  Object.keys(snap).forEach(function (mod) {
    if (!snap[mod]) return;

    /* A module that arrived after the baseline is folded in, not flagged. */
    if (!_kioskBaselineModules[mod]) {
      _kioskBaseline[mod] = snap[mod];
      _kioskBaselineModules[mod] = true;
      return;
    }

    var base = _kioskBaseline[mod] || {};
    Object.keys(snap[mod]).forEach(function (key) {
      var item = snap[mod][key];
      var was = base[key];

      if (!was) {
        if (item.item) kioskRecordChange(mod, key, 'new', 0, item);
        return;
      }
      if (was.value !== item.value) {
        kioskRecordChange(mod, key, item.value > was.value ? 'up' : 'down', item.value - was.value, item);
      }
    });

    _kioskBaseline[mod] = snap[mod];
  });

  Object.keys(_kioskChanges).forEach(function (full) {
    if (!kioskChangeFresh(_kioskChanges[full])) delete _kioskChanges[full];
  });
}

/* ---- change rendering helpers ---- */

function kioskDeltaChip(change) {
  if (!change) return '';
  if (change.kind === 'new') return '<span class="kiosk-delta">NEW</span>';
  return '<span class="kiosk-delta">' + (change.delta > 0 ? '▲ +' : '▼ −') + Math.abs(change.delta) + '</span>';
}

/* Value wrapped with its delta chip, flashed when it moved. A brand-new item
   (kind 'new') never gets a chip here — its label already carries the NEW
   chip, and a value with no previous number has no delta to show. It still
   flashes so the movement is visible. */
function kioskChanged(mod, key, value) {
  var change = kioskChange(mod, key);
  var text = kioskEsc(value);
  if (!change) return text;
  var chip = change.kind === 'new' ? '' : kioskDeltaChip(change);
  return '<span class="kiosk-changed tone-' + change.tone + '">' + text + chip + '</span>';
}

/* Flash class for elements that already own their markup. */
function kioskFlashClass(mod, key) {
  var change = kioskChange(mod, key);
  return change ? (' kiosk-flash tone-' + change.tone) : '';
}

/* Chip alone (no value wrapper). */
function kioskChip(mod, key) {
  return kioskDeltaChip(kioskChange(mod, key));
}

/* Chip only when the thing itself is new (a new down OLT, a new link, …). */
function kioskNewChip(mod, key) {
  var change = kioskChange(mod, key);
  return (change && change.kind === 'new') ? kioskDeltaChip(change) : '';
}

/* Human-readable list of what moved, used by the ticker. */
function kioskChangeSummary() {
  var parts = [];
  var counts = {};

  Object.keys(_kioskChanges).forEach(function (full) {
    var change = _kioskChanges[full];
    if (!kioskChangeFresh(change)) return;

    if (change.kind === 'new') {
      var noun = change.module === 'olt' ? 'down OLT'
        : change.module === 'backbone' ? 'affected link'
          : change.module === 'node' ? 'NODE region'
            : change.module === 'lcp' ? 'LCP area'
              : 'hotspot province';
      counts[noun] = (counts[noun] || 0) + 1;
      return;
    }

    /* Item-level movement is already marked on the slide itself (NEW chip),
       so the summary only lists headline metric deltas — never silently. */
    if (change.key.indexOf('::') !== -1) return;

    var label = KIOSK_CHANGE_LABELS[change.module + ':' + change.key] ||
      (change.module.toUpperCase() + ' ' + change.key);
    parts.push(label + ' ' + (change.delta > 0 ? '+' + change.delta : '−' + Math.abs(change.delta)));
  });

  var out = [];
  Object.keys(counts).forEach(function (noun) {
    out.push(counts[noun] + ' new ' + noun + (counts[noun] === 1 ? '' : 's'));
  });
  return out.concat(parts);
}

/* ------------------------------------------------------------------ *
   Shared slide fragments
 * ------------------------------------------------------------------ */
var KIOSK_ICON_SHIELD = '<svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#2fe3c0" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>';

function kioskSlideHead(type, subtitle) {
  var meta = KIOSK_SLIDE_META[type];
  return '<div class="kiosk-slide-head">' +
    '<div><div class="kiosk-slide-title">' + kioskEsc(meta.title) + '</div>' +
    '<div class="kiosk-slide-sub">' + kioskEsc(subtitle) + '</div></div>' +
    '<div class="kiosk-module-tag">' + kioskEsc(meta.tag) + '</div>' +
    '</div>';
}

function kioskLoadingHtml(label) {
  return '<div class="kiosk-loading"><div class="kiosk-loading-bar"></div><div>' + kioskEsc(label) + '</div></div>';
}

function kioskCalmHtml(subtitle, headline, sub, tiles) {
  var tilesHtml = '';
  if (tiles && tiles.length) {
    tilesHtml = '<div class="kiosk-stat-row">' + tiles.map(function (t) {
      var valueHtml = t.change ? kioskChanged(t.change.mod, t.change.key, t.value) : kioskEsc(t.value);
      return '<div class="kiosk-stat-tile"><div class="v"' + (t.color ? ' style="color:' + t.color + '"' : '') + '>' +
        valueHtml + '</div><div class="k">' + kioskEsc(t.label) + '</div></div>';
    }).join('') + '</div>';
  }
  return kioskSlideHead(subtitle.slide, subtitle.text) +
    '<div class="kiosk-calm">' +
    '<div class="kiosk-calm-icon">' + KIOSK_ICON_SHIELD + '</div>' +
    '<div class="kiosk-calm-headline">' + kioskEsc(headline) + '</div>' +
    '<div class="kiosk-calm-sub">' + kioskEsc(sub) + '</div>' +
    tilesHtml +
    '</div>';
}

function kioskFootNote(text) {
  return text ? '<div class="kiosk-foot-note">' + kioskEsc(text) + '</div>' : '';
}

/* ------------------------------------------------------------------ *
   Slide 1 — NAP
 * ------------------------------------------------------------------ */
function kioskRenderNap() {
  var el = kioskSlideEl('nap');
  if (!el) return;

  var rows = kioskSource('nap');
  if (rows === null) {
    el.innerHTML = kioskLoadingHtml('Loading NAP data…');
    return;
  }

  var areas = [];
  var totals = { h: 0, d1: 0, d3: 0, total: 0 };
  var provinces = {};

  rows.forEach(function (r) {
    var area = String(r.A || '').trim();
    if (!area || area.toUpperCase() === 'TOTAL') return;
    var h = kioskInt(r.H), d1 = kioskInt(r.D1), d3 = kioskInt(r.D3);
    var total = kioskInt(r.T) || (h + d1 + d3);
    areas.push({ area: area, province: kioskProvince(r.P), h: h, d1: d1, d3: d3, total: total });
    totals.h += h;
    totals.d1 += d1;
    totals.d3 += d3;
    totals.total += total;
    provinces[kioskProvince(r.P)] = 1;
  });

  var provinceCount = Object.keys(provinces).length;
  var subtitle = totals.total + ' active outages across ' + kioskPlural(provinceCount, 'province');

  if (!areas.length || totals.total === 0) {
    el.innerHTML = kioskCalmHtml(
      { slide: 'nap', text: subtitle },
      'No NAP Outages Reported',
      'Every monitored NAP area is currently reporting zero active outage buckets.',
      [{ label: 'Provinces monitored', value: String(provinceCount), color: 'var(--k-teal)' }]
    );
    return;
  }

  var sorted = areas.slice().sort(function (a, b) {
    return (b.total - a.total) || a.province.localeCompare(b.province);
  });
  var top = sorted.slice(0, KIOSK_LIMITS.napHotspots);
  var rest = sorted.slice(KIOSK_LIMITS.napHotspots);
  var maxTotal = sorted[0].total || 1;

  function bandSeg(cls, key, value, label) {
    return '<div class="kiosk-sev-seg ' + cls + '" style="flex:' + value + ' 1 0%">' +
      '<div class="num">' + kioskChanged('nap', key, value) + '</div>' +
      '<div class="lbl">' + label + '</div>' +
      '</div>';
  }

  var band = '<div class="kiosk-sev-band">' +
    bandSeg('kiosk-sev-fresh', 'h', totals.h, '&lt; 24 hrs') +
    bandSeg('kiosk-sev-aging', 'd1', totals.d1, '1–3 days') +
    bandSeg('kiosk-sev-critical', 'd3', totals.d3, '&gt; 3 days') +
    '<div class="kiosk-sev-seg kiosk-sev-total">' +
    '<div class="num">' + kioskChanged('nap', 'active', totals.total) + '</div><div class="lbl">Total</div>' +
    '</div>' +
    '</div>';

  var hotspotRows = top.map(function (a, i) {
    var barWidth = Math.max(2, Math.round(kioskPct(a.total, maxTotal)));
    var areaKey = kioskAreaKey(a.province, a.area);
    return '<div class="kiosk-hotspot-row' + kioskFlashClass('nap', areaKey) + '">' +
      '<div class="kiosk-hotspot-rank">' + String(i + 1).padStart(2, '0') + '</div>' +
      '<div class="kiosk-hotspot-name"><b>' + kioskEsc(a.province) + kioskNewChip('nap', areaKey) + '</b>' +
      '<small>' + kioskEsc(a.area) + '</small></div>' +
      '<div class="kiosk-mini-bar" style="width:' + barWidth + '%">' +
      '<span style="width:' + kioskPct(a.h, a.total) + '%;background:var(--k-teal)"></span>' +
      '<span style="width:' + kioskPct(a.d1, a.total) + '%;background:var(--k-amber)"></span>' +
      '<span style="width:' + kioskPct(a.d3, a.total) + '%;background:var(--k-red)"></span>' +
      '</div>' +
      '<div class="kiosk-hotspot-total">' + kioskChanged('nap', areaKey, a.total) + '</div>' +
      '</div>';
  }).join('');

  var foot = '';
  if (rest.length) {
    var moreOutages = 0, rh = 0, rd1 = 0, rd3 = 0;
    rest.forEach(function (a) {
      moreOutages += a.total; rh += a.h; rd1 += a.d1; rd3 += a.d3;
    });
    var dominant = (rd1 >= rh && rd1 >= rd3)
      ? '1–3 day range'
      : (rh >= rd3 ? '24-hour range' : 'beyond-3-day range');
    foot = '+' + kioskPlural(rest.length, 'more province') + ' · ' +
      kioskPlural(moreOutages, 'additional outage') + ', mostly in the ' + dominant;
  }

  el.innerHTML = kioskSlideHead('nap', subtitle) + band +
    '<div class="kiosk-hotspots">' +
    '<div class="kiosk-section-title">Hotspot Provinces</div>' +
    '<div class="kiosk-hotspot-list">' + hotspotRows + '</div>' +
    '</div>' +
    kioskFootNote(foot);
}

/* ------------------------------------------------------------------ *
   Slide 2 — LCP
 * ------------------------------------------------------------------ */
function kioskRenderLcp() {
  var el = kioskSlideEl('lcp');
  if (!el) return;

  var data = kioskSource('lcp');
  if (data === null) {
    el.innerHTML = kioskLoadingHtml('Loading LCP data…');
    return;
  }

  var aging = Array.isArray(data.lcpAging) ? data.lcpAging : [];
  var impact = Array.isArray(data.lcpImpact) ? data.lcpImpact : [];

  var areas = [];
  var totals = { clients: 0, lcp: 0, tickets: 0, aged: 0 };
  var provinces = {};

  impact.forEach(function (r) {
    var area = String(r.A || '').trim();
    if (!area || area.toUpperCase() === 'TOTAL') return;
    var clients = kioskInt(r.C), lcp = kioskInt(r.LCP), tickets = kioskInt(r.TT);
    areas.push({ area: area, province: kioskProvince(r.P), clients: clients, lcp: lcp, tickets: tickets });
    totals.clients += clients;
    totals.lcp += lcp;
    totals.tickets += tickets;
    provinces[kioskProvince(r.P)] = 1;
  });

  aging.forEach(function (r) {
    var area = String(r.A || '').trim();
    if (!area || area.toUpperCase() === 'TOTAL') return;
    totals.aged += kioskInt(r.D1) + kioskInt(r.D3);
  });

  var provinceCount = Object.keys(provinces).length;
  var subtitle = kioskPlural(totals.lcp, 'LCP') + ' down across ' + kioskPlural(provinceCount, 'province');

  if (!areas.length && !aging.length) {
    el.innerHTML = kioskCalmHtml(
      { slide: 'lcp', text: subtitle },
      'No LCP Outages Reported',
      'There are no LCP aging or customer-impact records in the current report.',
      [{ label: 'Clients affected', value: '0', color: 'var(--k-teal)' }]
    );
    return;
  }

  var agedBadge = totals.aged === 0
    ? '<span class="kiosk-badge-ok' + kioskFlashClass('lcp', 'aged') + '">● 0 — all within 24 hrs' + kioskChip('lcp', 'aged') + '</span>'
    : '<span class="' + (totals.aged > 5 ? 'kiosk-badge-crit' : 'kiosk-badge-warn') + kioskFlashClass('lcp', 'aged') + '">● ' + totals.aged + ' aged past 24 hrs' + kioskChip('lcp', 'aged') + '</span>';

  var sorted = areas.slice().sort(function (a, b) {
    return (b.clients - a.clients) || a.province.localeCompare(b.province);
  });
  var top = sorted.slice(0, KIOSK_LIMITS.lcpAreas);
  var rest = sorted.slice(KIOSK_LIMITS.lcpAreas);
  var maxClients = sorted.length ? (sorted[0].clients || 0) : 0;

  var areaCards = top.map(function (a) {
    var areaKey = kioskAreaKey(a.province, a.area);
    var barWidth = maxClients ? Math.max(2, kioskPct(a.clients, maxClients)) : 2;
    return '<div class="kiosk-area-card' + kioskFlashClass('lcp', areaKey) + '">' +
      '<div><div class="cluster">' + kioskEsc(a.area) + '</div>' +
      '<div class="province">' + kioskEsc(a.province) + kioskNewChip('lcp', areaKey) + '</div></div>' +
      '<div><div class="clients">' + kioskChanged('lcp', areaKey, a.clients) + '</div>' +
      '<div class="clients-lbl">Clients</div>' +
      '<div class="kiosk-bar-track"><div class="kiosk-bar-fill" style="width:' + barWidth + '%"></div></div>' +
      '<div class="lcp-count">' + kioskPlural(a.tickets, 'ticket') + ' · ' + kioskPlural(a.lcp, 'LCP') + '</div>' +
      '</div>' +
      '</div>';
  }).join('');

  var foot = '';
  if (rest.length) {
    var moreClients = 0;
    rest.forEach(function (a) { moreClients += a.clients; });
    foot = '+' + kioskPlural(rest.length, 'more area') + ' · ' + kioskPlural(moreClients, 'client') + ' affected';
  }

  el.innerHTML = kioskSlideHead('lcp', subtitle) +
    '<div class="kiosk-lcp-hero">' +
    '<div class="kiosk-hero-card">' +
    '<div class="num">' + kioskChanged('lcp', 'clients', totals.clients) + '</div>' +
    '<div class="lbl">Clients Affected</div>' +
    '</div>' +
    '<div class="kiosk-lcp-stack">' +
    '<div class="kiosk-stat-line"><span class="lbl">Total LCPs down</span><span class="val">' + kioskChanged('lcp', 'down', totals.lcp) + '</span></div>' +
    '<div class="kiosk-stat-line"><span class="lbl">Open tickets</span><span class="val">' + kioskChanged('lcp', 'tickets', totals.tickets) + '</span></div>' +
    '<div class="kiosk-stat-line"><span class="lbl">Aged past 24 hrs</span>' + agedBadge + '</div>' +
    '</div>' +
    '</div>' +
    '<div class="kiosk-area-grid">' + areaCards + '</div>' +
    kioskFootNote(foot);
}

/* ------------------------------------------------------------------ *
   Slide 3 — OLT
 * ------------------------------------------------------------------ */
function kioskRenderOlt() {
  var el = kioskSlideEl('olt');
  if (!el) return;

  var rows = kioskSource('olt');
  if (rows === null) {
    el.innerHTML = kioskLoadingHtml('Loading OLT data…');
    return;
  }

  if (!rows.length) {
    el.innerHTML = kioskCalmHtml(
      { slide: 'olt', text: 'No OLT records in the current sweep' },
      'No OLT Data',
      'The OLT report returned no rows for this sweep.',
      []
    );
    return;
  }

  var b = kioskOltBuckets(rows);
  var subtitle = b.total + ' OLTs tracked · ' + kioskPctText(b.up, b.total) + ' up';

  /* Donut */
  var radius = 80;
  var circumference = 2 * Math.PI * radius;
  var segments = [
    { key: 'up', label: 'Up', value: b.up, color: 'var(--k-teal)' },
    { key: 'down', label: 'Down', value: b.down, color: 'var(--k-red)' },
    { key: 'low', label: 'Low power', value: b.low, color: 'var(--k-amber)' },
    { key: 'uplink', label: 'Uplink down', value: b.uplink, color: '#425752' },
    { key: 'degradation', label: 'Degradation', value: b.degradation, color: 'var(--k-violet)' }
  ];

  var arcs = '';
  var legend = '';
  var consumed = 0;

  segments.forEach(function (seg) {
    if (seg.value > 0) {
      var dash = kioskPct(seg.value, b.total) / 100 * circumference;
      arcs += '<circle cx="100" cy="100" r="' + radius + '" fill="none" stroke="' + seg.color + '" stroke-width="24" ' +
        'stroke-dasharray="' + dash.toFixed(2) + ' ' + circumference.toFixed(2) + '" ' +
        'stroke-dashoffset="' + (-consumed).toFixed(2) + '" transform="rotate(-90 100 100)"/>';
      consumed += dash;
    }
    legend += '<div class="kiosk-legend-row">' +
      '<span class="kiosk-legend-dot" style="background:' + seg.color + '"></span>' +
      kioskEsc(seg.label) +
      '<b>' + kioskChanged('olt', seg.key, seg.value + ' · ' + kioskPctText(seg.value, b.total)) + '</b>' +
      '</div>';
  });

  var donut = '<svg class="kiosk-donut" viewBox="0 0 200 200" role="img" ' +
    'aria-label="OLT status distribution across ' + b.total + ' devices">' +
    '<circle cx="100" cy="100" r="' + radius + '" fill="none" stroke="var(--k-panel-raised)" stroke-width="24"/>' +
    arcs +
    '<text x="100" y="96" text-anchor="middle" fill="#eaf5f2" font-family="ui-monospace, monospace" ' +
    'font-size="30" font-weight="600">' + b.total + '</text>' +
    '<text x="100" y="118" text-anchor="middle" fill="#7fa199" font-size="11" letter-spacing="1">TOTAL</text>' +
    '</svg>';

  /* Down OLTs */
  var downRows = rows.filter(function (item) {
    return String(item.S || item.STATUS || '').trim().toUpperCase() === 'DOWN';
  }).sort(function (a, bRow) {
    return kioskDurationMinutes(bRow.AG || bRow.AGING) - kioskDurationMinutes(a.AG || a.AGING);
  });

  var topDown = downRows.slice(0, KIOSK_LIMITS.oltDownCards);

  var downCards = topDown.map(function (item) {
    var name = String(item.N || item.OLT_NAME || '—');
    var province = kioskProvince(item.P || item.PROVINCE);
    var municipality = kioskProvince(item.M || item.MUNICIPALITY);
    var clients = kioskInt(item.CA);
    var aging = String(item.AG || item.AGING || '—');
    var deviceKey = kioskDeviceKey(name);
    return '<div class="kiosk-down-card' + kioskFlashClass('olt', deviceKey) + '">' +
      '<div style="min-width:0">' +
      '<div class="oname">' + kioskEsc(name) + kioskNewChip('olt', deviceKey) + '</div>' +
      '<div class="oloc">' + kioskEsc(province + ' · ' + municipality) + '</div>' +
      '</div>' +
      '<div class="kiosk-down-stats">' +
      '<div class="kiosk-down-stat"><div class="v">' + (clients > 0 ? clients : '—') + '</div><div class="k">Affected</div></div>' +
      '<div class="kiosk-down-stat"><div class="v">' + kioskEsc(aging) + '</div><div class="k">Aging</div></div>' +
      '<span class="kiosk-down-badge">DOWN</span>' +
      '</div>' +
      '</div>';
  }).join('');

  var downBlock;
  if (!downRows.length) {
    downBlock = '<div class="kiosk-calm">' +
      '<div class="kiosk-calm-headline" style="font-size:clamp(1.2rem,1.9vw,1.8rem)">No OLTs currently down</div>' +
      '<div class="kiosk-calm-sub">Every tracked OLT is up, low power or degraded — none are fully down.</div>' +
      '</div>';
  } else {
    var remaining = downRows.length - topDown.length;
    downBlock = '<div class="kiosk-down-list">' + downCards + '</div>' +
      kioskFootNote(remaining > 0 ? '+' + kioskPlural(remaining, 'more down OLT') : '');
  }

  var affectedClass = b.down > 0 ? 'kiosk-olt-affected' : 'kiosk-olt-affected is-clear';
  var downClass = b.down > 0 ? 'kiosk-olt-down' : 'kiosk-olt-down is-clear';

  el.innerHTML = kioskSlideHead('olt', subtitle) +
    '<div class="kiosk-olt-hero">' +
    '<div class="kiosk-donut-wrap">' + donut + '<div class="kiosk-legend">' + legend + '</div></div>' +
    /* How many OLTs are down, stated on its own and ahead of the client figure
       so the two counts can never be read as one. */
    '<div class="' + downClass + kioskFlashClass('olt', 'down') + '">' +
    '<div class="num">' + kioskChanged('olt', 'down', b.down) + '</div>' +
    '<div class="lbl">OLT' + (b.down === 1 ? '' : 's') + ' down</div>' +
    '</div>' +
    '<div class="' + affectedClass + kioskFlashClass('olt', 'clientsDown') + '">' +
    '<div class="num">' + kioskChanged('olt', 'clientsDown', b.clientsDown) + '</div>' +
    '<div class="lbl">Clients affected (down)</div>' +
    '</div>' +
    '</div>' +
    kioskOltCauseStrip(rows) +
    '<div class="kiosk-section-title">Down OLTs</div>' +
    downBlock;
}

/* ------------------------------------------------------------------ *
   Slide 4 — NODE
 * ------------------------------------------------------------------ */
var KIOSK_NORTH_LUZON_PROVINCES = [
  { name: 'Ilocos Norte', points: '106,46 158,30 202,48 190,104 146,118 108,94' },
  { name: 'Apayao', points: '202,48 250,30 292,48 280,104 238,112 190,104' },
  { name: 'Cagayan', points: '292,48 360,34 414,62 430,132 374,158 326,122 280,104' },
  { name: 'Ilocos Sur', points: '108,94 146,118 174,160 148,204 104,190 88,144' },
  { name: 'Abra', points: '146,118 190,104 238,112 232,166 174,160' },
  { name: 'Kalinga', points: '238,112 280,104 326,122 330,178 274,188 232,166' },
  { name: 'Isabela', points: '326,122 374,158 430,132 454,204 416,266 348,240 330,178' },
  { name: 'La Union', points: '88,144 104,190 148,204 154,246 112,270 76,230' },
  { name: 'Benguet', points: '148,204 174,160 232,166 218,226 190,264 154,246' },
  { name: 'Mountain Province', points: '232,166 274,188 278,238 218,226' },
  { name: 'Ifugao', points: '278,188 330,178 348,240 310,272 278,238' },
  { name: 'Nueva Vizcaya', points: '218,226 278,238 310,272 274,310 210,292 190,264' },
  { name: 'Pangasinan', points: '112,270 154,246 190,264 210,292 194,338 132,332 96,302' },
  { name: 'Nueva Ecija', points: '194,338 210,292 274,310 318,344 274,376 214,368' },
  { name: 'Quirino', points: '310,272 348,240 416,266 396,326 358,344 318,344 274,310' },
  { name: 'Aurora', points: '416,266 454,204 476,246 468,338 396,326' }
];

function kioskNorthLuzonKey(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function kioskMapCallout(province, data, index) {
  var x = province.points.split(' ')[0].split(',')[0] * 1;
  var y = province.points.split(' ')[0].split(',')[1] * 1;
  var rightSide = x < 250;
  var boxX = rightSide ? 340 : 8;
  var boxY = 42 + (index % 3) * 104;
  var nodeNames = String(data.nodesText || 'Affected nodes').slice(0, 32);
  return '<g class="kiosk-map-callout ' + (rightSide ? 'to-right' : 'to-left') + '">' +
    '<path class="kiosk-map-leader" d="M' + x + ' ' + y + ' L' + (rightSide ? boxX : boxX + 172) + ' ' + (boxY + 28) + '"></path>' +
    '<rect class="kiosk-map-callout-box" x="' + boxX + '" y="' + boxY + '" width="172" height="58" rx="4"></rect>' +
    '<text class="kiosk-map-callout-title" x="' + (boxX + 9) + '" y="' + (boxY + 16) + '">RED PING · ' + kioskEsc(province.name.toUpperCase()) + '</text>' +
    '<text class="kiosk-map-callout-body" x="' + (boxX + 9) + '" y="' + (boxY + 34) + '">NODE DOWN · ' + kioskEsc(nodeNames) + '</text>' +
    '<text class="kiosk-map-callout-body" x="' + (boxX + 9) + '" y="' + (boxY + 49) + '">' + kioskEsc(String(data.nodes)) + ' NODE' + (data.nodes === 1 ? '' : 'S') + ' AFFECTED</text>' +
    '</g>';
}

function kioskRenderNorthLuzonMap(rows) {
  var active = {};
  (rows || []).forEach(function (row) {
    var key = kioskNorthLuzonKey(row.P || row.PROVINCE);
    if (!key) return;
    if (!active[key]) active[key] = { incidents: 0, nodes: 0, nodesText: '' };
    active[key].incidents += 1;
    active[key].nodes += kioskInt(row.C);
    active[key].nodesText += (active[key].nodesText ? ', ' : '') + String(row.N || 'Affected nodes');
  });

  var activeCount = Object.keys(active).length;
  var isClear = activeCount === 0;
  var activeCallouts = [];
  var regions = KIOSK_NORTH_LUZON_PROVINCES.map(function (province) {
    var data = active[kioskNorthLuzonKey(province.name)];
    var isActive = !!data;
    var firstPoint = province.points.split(' ')[0].split(',');
    var centerX = firstPoint[0] * 1 + 24;
    var centerY = firstPoint[1] * 1 + 20;
    var label = province.name + (isActive ? ': ' + data.nodes + ' affected nodes' : ': clear');
    if (isActive && activeCallouts.length < 3) activeCallouts.push(kioskMapCallout(province, data, activeCallouts.length));
    return '<g class="kiosk-map-province ' + (isActive ? 'is-active' : '') + '" tabindex="0" aria-label="' + kioskEsc(label) + '">' +
      '<title>' + kioskEsc(label) + '</title>' +
      '<polygon class="kiosk-map-region" points="' + province.points + '"></polygon>' +
      (isActive ? '<circle class="kiosk-map-pulse" cx="' + centerX + '" cy="' + centerY + '" r="12"></circle><circle class="kiosk-map-marker" cx="' + centerX + '" cy="' + centerY + '" r="6"></circle>' : '') +
      '<text class="kiosk-map-label" x="' + centerX + '" y="' + (centerY + 4) + '" text-anchor="middle">' + kioskEsc(province.name) + '</text>' +
      '</g>';
  }).join('');

  return '<div class="kiosk-node-map-wrap ' + (isClear ? 'is-clear' : 'is-alert') + '">' +
    '<div class="kiosk-node-map-head"><div><div class="kiosk-section-title">North Luzon Node Watch</div><div class="kiosk-node-map-sub">16 monitored provinces · live outage overlay</div></div>' +
    '<span class="kiosk-node-map-status">' + (isClear ? '● All Regions Clear' : '● ' + activeCount + ' province' + (activeCount === 1 ? '' : 's') + ' affected') + '</span></div>' +
    '<svg class="kiosk-north-map" viewBox="0 0 520 410" role="img" aria-label="North Luzon node outage map">' +
    '<path class="kiosk-map-land-outline" d="M76 230 L88 144 106 46 202 30 250 30 360 34 414 62 454 204 476 246 468 338 396 326 358 344 318 344 274 376 214 368 132 332 96 302Z"></path>' +
    regions + activeCallouts.join('') + '</svg></div>';
}

function kioskNodeImpactSummary(rows) {
  var provinces = {};
  var severityCounts = { critical: 0, high: 0, medium: 0, low: 0, other: 0 };
  var totalNodes = 0;

  (rows || []).forEach(function (row) {
    var province = kioskNorthLuzonKey(row.P || row.PROVINCE);
    if (province) provinces[province] = 1;
    totalNodes += kioskInt(row.C);

    var impact = String(row.I || '').trim().toUpperCase();
    if (impact.indexOf('CRITICAL') !== -1) severityCounts.critical++;
    else if (impact.indexOf('HIGH') !== -1) severityCounts.high++;
    else if (impact.indexOf('MEDIUM') !== -1 || impact.indexOf('MODERATE') !== -1) severityCounts.medium++;
    else if (impact.indexOf('LOW') !== -1) severityCounts.low++;
    else severityCounts.other++;
  });

  var impactLabel = 'NO RATING';
  var impactCount = 0;
  ['critical', 'high', 'medium', 'low'].some(function (level) {
    if (severityCounts[level] > 0) {
      impactLabel = level.toUpperCase();
      impactCount = severityCounts[level];
      return true;
    }
    return false;
  });

  return {
    incidents: (rows || []).length,
    nodes: totalNodes,
    provinces: Object.keys(provinces).length,
    impact: impactLabel,
    impactCount: impactCount,
    latestSync: kioskTime(_kioskLastSync.node)
  };
}

function kioskNodeImpactStrip(rows) {
  var summary = kioskNodeImpactSummary(rows);
  var impactTone = summary.impact === 'CRITICAL' || summary.impact === 'HIGH' ? 'is-critical' :
    (summary.impact === 'NO RATING' ? 'is-muted' : 'is-warning');

  function metric(value, label, className, changeKey) {
    var displayValue = changeKey ? kioskChanged('node', changeKey, value) : kioskEsc(String(value));
    return '<div class="kiosk-node-impact-metric ' + (className || '') + '">' +
      '<div class="value">' + displayValue + '</div>' +
      '<div class="label">' + kioskEsc(label) + '</div>' +
      '</div>';
  }

  return '<div class="kiosk-node-impact-strip" aria-label="Node kiosk impact summary">' +
    metric(summary.nodes, 'Affected nodes', 'is-primary', 'nodes') +
    metric(summary.incidents, 'DOWN incidents', '', 'incidents') +
    metric(summary.provinces, 'Provinces', '', 'provinces') +
    metric(summary.latestSync, 'Latest sync', 'is-sync') +
    '</div>';
}

function kioskRenderNode() {
  var el = kioskSlideEl('node');
  if (!el) return;

  var rows = kioskSource('node');
  if (rows === null) {
    el.innerHTML = kioskLoadingHtml('Loading NODE data…');
    return;
  }

  /* Calm all-clear. Every figure below is derived from live data or the real
     clock — nothing is hardcoded. */
  if (!rows.length) {
    var monitoredProvinces = 0;
    var seen = {};
    /* "Monitored provinces" = distinct provinces seen across the OLT and NAP
       feeds. The key MUST be case-folded: OLT returns provinces UPPERCASE
       ("BENGUET") while NAP returns them Title_Case ("Benguet"), so comparing
       raw strings counts every shared province twice. */
    function countProvince(value) {
      var key = kioskProvince(value).toLowerCase();
      if (key && key !== '\u2014') seen[key] = 1;
    }
    (kioskSource('olt') || []).forEach(function (r) { countProvince(r.P || r.PROVINCE); });
    (kioskSource('nap') || []).forEach(function (r) { countProvince(r.P); });
    monitoredProvinces = Object.keys(seen).length;

    el.innerHTML = kioskNodeImpactStrip([]) + kioskCalmHtml(
      { slide: 'node', text: 'Real-time regional monitoring' },
      'All Node Systems Operational',
      'No active node-down incidents reported across all monitored provinces.',
      [
        { label: 'Active incidents', value: '0', color: 'var(--k-teal)', change: { mod: 'node', key: 'incidents' } },
        { label: 'Last sync', value: kioskTime(_kioskLastSync.node) },
        { label: 'Monitored provinces', value: String(monitoredProvinces) },
        { label: 'Feed status', value: (navigator.onLine === false ? 'Offline' : 'Live'), color: (navigator.onLine === false ? 'var(--k-red)' : 'var(--k-teal)') }
      ]
    );
    return;
  }

  var provinces = {};
  var totalNodes = 0;
  rows.forEach(function (r) {
    provinces[kioskProvince(r.P)] = 1;
    totalNodes += kioskInt(r.C);
  });

  var subtitle = kioskPlural(rows.length, 'incident') + ' · ' +
    kioskPlural(kioskInt(totalNodes), 'affected node') + ' across ' + kioskPlural(Object.keys(provinces).length, 'province');

  var sorted = rows.slice().sort(function (a, bRow) {
    return kioskInt(bRow.C) - kioskInt(a.C);
  });
  var top = sorted.slice(0, KIOSK_LIMITS.nodeCards);
  var rest = sorted.slice(KIOSK_LIMITS.nodeCards);

  function causeColor(cause) {
    var c = String(cause || '').toUpperCase();
    if (c.indexOf('FIBER') !== -1 && c.indexOf('POWER') !== -1) return 'var(--k-violet)';
    if (c.indexOf('FIBER') !== -1) return 'var(--k-red)';
    if (c.indexOf('POWER') !== -1) return 'var(--k-amber)';
    if (c.indexOf('EQUIPMENT') !== -1) return 'var(--k-amber)';
    return 'var(--k-text-dim)';
  }

  var cards = top.map(function (r) {
    var nodeCount = kioskInt(r.C);
    var cause = String(r.DC || '—');
    var affectedNodes = String(r.N || '—').split(',').map(function (node) {
      return node.trim();
    }).filter(Boolean).join(', ');
    var areaKey = kioskAreaKey(kioskProvince(r.P), '');
    return '<div class="kiosk-node-card' + kioskFlashClass('node', areaKey) + '">' +
      '<div class="kiosk-node-identity">' +
      '<div class="affected-label">NPE NAME</div>' +
      '<div class="affected-nodes">' + kioskEsc(affectedNodes) + kioskNewChip('node', areaKey) + '</div>' +
      '<div class="province">' + kioskEsc(kioskProvince(r.P)) + '</div>' +
      '<div class="cause" style="color:' + causeColor(cause) + '"><span class="affected-label">DT CAUSE</span> ' + kioskEsc(cause) + '</div>' +
      '</div>' +
      '<div class="nodes">' +
      '<div class="kiosk-down-stat"><div class="v">' + kioskEsc(String(r.I || '—')) + '</div><div class="k">Impact</div></div>' +
      '<div class="kiosk-down-stat"><div class="v">' + kioskEsc(String(r.AG || '—')) + '</div><div class="k">Aging</div></div>' +
      '<div class="kiosk-down-stat"><div class="v">' + kioskChanged('node', areaKey, nodeCount) + '</div><div class="k">Nodes</div></div>' +
      '</div>' +
      '</div>';
  }).join('');

  var foot = rest.length
    ? '+' + kioskPlural(rest.length, 'more incident') + ' · ' +
      kioskPlural(rest.reduce(function (s, r) { return s + kioskInt(r.C); }, 0), 'node') + ' affected'
    : '';

  el.innerHTML = kioskSlideHead('node', subtitle) +
    kioskNodeImpactStrip(rows) +
    '<div class="kiosk-node-list">' + cards + '</div>' +
    kioskFootNote(foot);
}

/* ------------------------------------------------------------------ *
   Slide 5 — BACKBONE LINKS
 * ------------------------------------------------------------------ */
function kioskRenderBackbone() {
  var el = kioskSlideEl('backbone');
  if (!el) return;

  var rows = kioskSource('backbone');
  if (rows === null) {
    el.innerHTML = kioskLoadingHtml('Loading Backbone data…');
    return;
  }

  var counts = kioskBackboneCounts(rows);

  if (!rows.length || counts.total === 0) {
    el.innerHTML = kioskCalmHtml(
      { slide: 'backbone', text: 'Live backbone link monitoring' },
      'All Backbone Links Operational',
      'No pending DWDM or MPLS link incidents are reported for rectification.',
      [
        { label: 'Links affected', value: '0', color: 'var(--k-teal)' },
        { label: 'Links down', value: '0' },
        { label: 'Low power', value: '0' }
      ]
    );
    return;
  }

  /* Expand each ticket into its individual links for the card grid. */
  var links = kioskBackboneLinkList(rows);

  links.sort(function (a, b) {
    if (a.down !== b.down) return a.down ? -1 : 1;
    return b.minutes - a.minutes;
  });

  var shown = links.slice(0, KIOSK_LIMITS.backboneCards);
  var subtitle = kioskPlural(counts.total, 'link') + ' flagged · ' +
    kioskPlural(counts.dwdmDown + counts.mplsDown, 'link') + ' down';

  var chips = '<div class="kiosk-bb-chips">' +
    '<div class="kiosk-bb-chip is-hero"><div class="v">' + kioskChanged('backbone', 'links', counts.total) + '</div><div class="k">Total links affected</div></div>' +
    '<div class="kiosk-bb-chip"><div class="v" style="color:var(--k-violet)">' + kioskChanged('backbone', 'dwdmLow', counts.dwdmLow) + '</div><div class="k">DWDM low power</div></div>' +
    '<div class="kiosk-bb-chip"><div class="v" style="color:' + (counts.dwdmDown ? 'var(--k-red)' : 'var(--k-text-faint)') + '">' + kioskChanged('backbone', 'dwdmDown', counts.dwdmDown) + '</div><div class="k">DWDM link down</div></div>' +
    '<div class="kiosk-bb-chip"><div class="v" style="color:var(--k-amber)">' + kioskChanged('backbone', 'mplsLow', counts.mplsLow) + '</div><div class="k">MPLS low power</div></div>' +
    '<div class="kiosk-bb-chip"><div class="v" style="color:' + (counts.mplsDown ? 'var(--k-red)' : 'var(--k-text-faint)') + '">' + kioskChanged('backbone', 'mplsDown', counts.mplsDown) + '</div><div class="k">MPLS link down</div></div>' +
    '</div>';

  var cards = shown.map(function (l) {
    var linkKey = kioskLinkKey(l.text);
    var cls = 'kiosk-bb-card' + (l.down ? ' is-down' : (l.service === 'MPLS' ? ' is-mpls' : '')) + kioskFlashClass('backbone', linkKey);
    var catCls = l.service === 'MPLS' ? 'mpls' : 'dwdm';
    return '<div class="' + cls + '">' +
      '<span class="kiosk-bb-cat ' + catCls + '">' + kioskEsc(l.service) + '</span>' +
      '<div class="kiosk-bb-info">' +
      '<div class="prov">' + kioskEsc(l.province) + kioskNewChip('backbone', linkKey) + '</div>' +
      '<div class="link" title="' + kioskEsc(l.text) + '">' + kioskEsc(l.text) + '</div>' +
      '</div>' +
      '<div class="kiosk-bb-right">' +
      '<div class="aging">' + kioskEsc(l.aging) + '</div>' +
      '<div class="impact">' + kioskEsc((l.down ? 'Link down' : 'Low power') + ' · ' + l.impact) + '</div>' +
      '</div>' +
      '</div>';
  }).join('');

  var remaining = counts.total - shown.length;
  var foot = remaining > 0
    ? '+' + kioskPlural(remaining, 'more affected link') + ' not shown on this rotation'
    : '';

  el.innerHTML = kioskSlideHead('backbone', subtitle) + chips +
    '<div class="kiosk-bb-grid">' + cards + '</div>' +
    kioskFootNote(foot);
}

/* ------------------------------------------------------------------ *
   Top pill + ticker (real numbers only)
 * ------------------------------------------------------------------ */
function kioskUpdatePill() {
  var pill = document.getElementById('kioskPill');
  var text = document.getElementById('kioskPillText');
  if (!pill || !text) return;

  var agg = kioskAggregates();
  var alerts = agg.napTotal + agg.lcpDown + agg.oltDown + agg.nodeIncidents + agg.bbDown;
  var anyReady = agg.ready.nap || agg.ready.lcp || agg.ready.olt || agg.ready.node || agg.ready.backbone;

  pill.classList.remove('is-ok', 'is-crit');

  if (!anyReady) {
    text.textContent = 'Connecting to live data…';
    pill.classList.add('is-ok');
    return;
  }

  if (alerts === 0) pill.classList.add('is-ok');
  else if (alerts >= 5) pill.classList.add('is-crit');

  text.innerHTML = (alerts === 0 ? 'No active alerts' : '<b>' + kioskChanged('pill', 'alerts', alerts) + '</b> active alerts') +
    ' · ' + agg.oltTotal + ' OLTs · ' + agg.napTotal + ' NAPs';
}

function kioskUpdateTicker() {
  var track = document.getElementById('kioskTickerTrack');
  if (!track) return;

  var agg = kioskAggregates();
  var items = [];

  if (agg.ready.nap) {
    items.push('NAP — ' + agg.napTotal + ' active across ' + kioskPlural(agg.napProvinces, 'province') +
      ' (<24h ' + agg.napBuckets.h + ' · 1–3d ' + agg.napBuckets.d1 + ' · >3d ' + agg.napBuckets.d3 + ')');
  }
  if (agg.ready.lcp) {
    items.push('LCP — ' + kioskPlural(agg.lcpDown, 'LCP') + ' down · ' + kioskPlural(agg.lcpTickets, 'ticket') +
      ' · ' + agg.lcpClients + ' clients affected · ' + agg.lcpAged + ' aged past 24h');
  }
  if (agg.ready.olt) {
    items.push('OLT — ' + agg.oltUp + ' up of ' + agg.oltTotal + ' · ' + agg.oltDown + ' down · ' +
      agg.oltLow + ' low power · ' + agg.oltClientsDown + ' clients affected');
  }
  if (agg.ready.node) {
    items.push(agg.nodeIncidents === 0
      ? 'NODE — all systems operational, no active incidents'
      : 'NODE — ' + kioskPlural(agg.nodeIncidents, 'incident') + ' · ' + agg.nodeNodes + ' nodes affected');
  }
  if (agg.ready.backbone) {
    items.push('BACKBONE — ' + kioskPlural(agg.bbLinks, 'link') + ' flagged · ' + agg.bbDown + ' down · ' + agg.bbLow + ' low power');
  }

  /* What moved since the previous refresh leads the ticker. */
  var summary = kioskChangeSummary();
  if (summary.length) {
    items.unshift('UPDATED ' + kioskClockTime(new Date()) + ' — ' + summary.join(' · '));
  }
  _kioskTickerHadChanges = summary.length > 0;

  var syncs = [];
  KIOSK_SLIDE_IDS.forEach(function (type) {
    if (_kioskLastSync[type]) syncs.push(type.toUpperCase() + ' synced ' + kioskTime(_kioskLastSync[type]));
  });
  if (syncs.length) items.push(syncs.join(' · '));

  if (!items.length) items.push('Waiting for the first live data snapshot…');

  var html = items.map(function (item) {
    return '<span>● ' + kioskEsc(item) + '</span>';
  }).join('');

  track.innerHTML = html + html; /* duplicated for a seamless loop */
}

/* ------------------------------------------------------------------ *
   Slide control
 * ------------------------------------------------------------------ */
function kioskSlideEl(type) {
  return document.querySelector('.kiosk-slide[data-kiosk-slide="' + type + '"]');
}

function kioskActiveType() {
  return KIOSK_SLIDE_IDS[_kioskIndex] || 'nap';
}

function kioskRenderActive() {
  var type = kioskActiveType();
  if (type === 'nap') kioskRenderNap();
  else if (type === 'lcp') kioskRenderLcp();
  else if (type === 'olt') kioskRenderOlt();
  else if (type === 'node') kioskRenderNode();
  else if (type === 'backbone') kioskRenderBackbone();
}

function kioskBuildDots() {
  var wrap = document.getElementById('kioskDots');
  if (!wrap) return;
  wrap.innerHTML = '';
  KIOSK_SLIDE_IDS.forEach(function (type, i) {
    var dot = document.createElement('button');
    dot.className = 'kiosk-dot';
    dot.type = 'button';
    dot.title = KIOSK_SLIDE_META[type].title;
    dot.setAttribute('aria-label', 'Show ' + KIOSK_SLIDE_META[type].title);
    dot.innerHTML = '<span class="fill"></span>';
    dot.addEventListener('click', function () {
      kioskShowSlide(i);
      kioskPauseForIdle();
    });
    wrap.appendChild(dot);
  });
  kioskUpdateDots();
}

function kioskUpdateDots() {
  var wrap = document.getElementById('kioskDots');
  if (!wrap) return;
  Array.prototype.forEach.call(wrap.children, function (dot, i) {
    dot.classList.toggle('is-done', i < _kioskIndex);
    var fill = dot.querySelector('.fill');
    if (fill && i !== _kioskIndex) fill.style.width = i < _kioskIndex ? '100%' : '0%';
  });
  kioskUpdateDotFill();
}

function kioskUpdateDotFill() {
  var wrap = document.getElementById('kioskDots');
  if (!wrap) return;
  var dot = wrap.children[_kioskIndex];
  if (!dot) return;
  var fill = dot.querySelector('.fill');
  if (!fill) return;
  fill.style.width = Math.min(100, (_kioskElapsed / _kioskRotateMs) * 100) + '%';
}

function kioskShowSlide(index) {
  var count = KIOSK_SLIDE_IDS.length;
  _kioskIndex = ((index % count) + count) % count;
  var type = kioskActiveType();

  Array.prototype.forEach.call(document.querySelectorAll('.kiosk-slide'), function (slide) {
    slide.classList.toggle('active', slide.getAttribute('data-kiosk-slide') === type);
  });

  _kioskElapsed = 0;
  _kioskSlideStart = Date.now();
  _kioskPausedAt = 0;

  /* Render immediately from whatever the pipeline already holds, then ask the
     module's own fetcher for fresher data (cache-first, background refresh). */
  kioskRenderActive();
  kioskFetch(type);

  kioskUpdateDots();
  kioskUpdatePill();
  kioskUpdateTicker();
}

function kioskNextSlide() { kioskShowSlide(_kioskIndex + 1); }
function kioskPrevSlide() { kioskShowSlide(_kioskIndex - 1); }

function kioskPauseForIdle() {
  _kioskIdlePaused = true;
  clearTimeout(_kioskIdleTimer);
  _kioskIdleTimer = setTimeout(function () {
    _kioskIdlePaused = false;
  }, KIOSK_IDLE_RESUME_MS);
}

function kioskSetPlayButton() {
  var btn = document.getElementById('kioskPlayBtn');
  if (!btn) return;
  btn.innerHTML = _kioskPaused ? '&#9654;' : '&#10074;&#10074;';
  btn.title = _kioskPaused ? 'Resume rotation' : 'Pause rotation';
  btn.setAttribute('aria-label', btn.title);
}

function toggleKioskPause() {
  _kioskPaused = !_kioskPaused;
  clearTimeout(_kioskIdleTimer);
  _kioskIdlePaused = false;
  document.body.classList.toggle('kiosk-mode-paused', _kioskPaused);
  kioskSetPlayButton();
}

/* ------------------------------------------------------------------ *
   Clock
 * ------------------------------------------------------------------ */
function kioskUpdateClock() {
  var clock = document.getElementById('kioskClock');
  var date = document.getElementById('kioskDate');
  var now = new Date();
  if (clock) clock.textContent = kioskClockTime(now);
  if (date) {
    try {
      date.textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    } catch (e) {
      date.textContent = '';
    }
  }
}

/* ------------------------------------------------------------------ *
   Data watchdog — notices fresh data arriving from the existing pipeline
 * ------------------------------------------------------------------ */
function kioskWatchedRef(type) {
  if (type === 'olt') {
    var cache = kioskCache();
    if (cache && cache.olt) return cache.olt;
    return (typeof rawOltData !== 'undefined') ? rawOltData : null;
  }
  var c = kioskCache();
  return c ? c[type] : null;
}

function kioskWatchData() {
  var changed = false;
  var activeChanged = false;

  KIOSK_SLIDE_IDS.forEach(function (type) {
    var ref = kioskWatchedRef(type);
    if (ref === null || ref === undefined) return;
    if (ref === _kioskSeenRef[type]) return;
    _kioskSeenRef[type] = ref;
    _kioskLastSync[type] = new Date();
    changed = true;
    if (type === kioskActiveType()) activeChanged = true;
  });

  if (changed) {
    /* Diff against the previous picture BEFORE rendering, so the slides that
       render next can mark what moved. */
    kioskTrackChanges();
    kioskUpdatePill();
    kioskUpdateTicker();
  } else {
    /* Highlights expire on their own — keep the pill and the ticker honest
       once the last one has aged out. */
    var hasChanges = kioskChangeSummary().length > 0;
    if (hasChanges !== _kioskTickerHadChanges) {
      kioskUpdatePill();
      kioskUpdateTicker();
    }
  }

  if (activeChanged) kioskRenderActive();
}

/* ------------------------------------------------------------------ *
   Rotation clock
   Wall-clock based on purpose: a TV browser may throttle animation frames,
   so rotation is driven by real elapsed time (checked from both the 1s clock
   interval and the frame loop). rAF only smooths the progress-dot fill.
 * ------------------------------------------------------------------ */
function kioskTick() {
  if (!_kioskMode) return;

  if (_kioskPaused || _kioskIdlePaused) {
    if (!_kioskPausedAt) _kioskPausedAt = Date.now();
    return;
  }

  /* Resume: push the slide deadline forward by however long we were held. */
  if (_kioskPausedAt) {
    _kioskSlideStart += (Date.now() - _kioskPausedAt);
    _kioskPausedAt = 0;
  }

  if (!_kioskSlideStart) _kioskSlideStart = Date.now();
  _kioskElapsed = Date.now() - _kioskSlideStart;
  kioskUpdateDotFill();

  if (_kioskElapsed >= _kioskRotateMs) kioskNextSlide();
}

function kioskLoop() {
  if (!_kioskMode) return;
  kioskTick();
  _kioskRafId = requestAnimationFrame(kioskLoop);
}

/* ------------------------------------------------------------------ *
   Enter / exit
 * ------------------------------------------------------------------ */
function isKioskMode() {
  return _kioskMode;
}

function enterKioskMode() {
  if (_kioskMode) return;
  _kioskMode = true;
  _kioskPaused = false;
  _kioskIdlePaused = false;
  _kioskEscapeCount = 0;
  _kioskElapsed = 0;
  /* Start each kiosk session with a fresh baseline: whatever is already cached
     becomes the baseline instead of flashing as "updated". */
  _kioskSeenRef = { nap: null, lcp: null, olt: null, node: null, backbone: null };
  kioskResetChanges();
  _kioskSlideStart = Date.now();
  _kioskPausedAt = 0;

  document.body.classList.add('kiosk-mode');

  var root = document.getElementById('kioskRoot');
  if (root) root.setAttribute('aria-hidden', 'false');

  /* Best-effort fullscreen. Kiosk styling does NOT depend on it. */
  try {
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {});
    } else if (document.documentElement.webkitRequestFullscreen) {
      document.documentElement.webkitRequestFullscreen();
    }
  } catch (e) { /* ignore */ }

  kioskBuildDots();
  kioskSetPlayButton();
  kioskUpdateClock();
  _kioskClockTimer = setInterval(function () {
    kioskUpdateClock();
    kioskTick(); /* rotation fallback: never depends on animation frames */
  }, 1000);

  kioskShowSlide(0);

  /* Warm every module through its existing fetcher, then keep only the visible
     slide refreshed on a timer (no request storm against Apps Script). */
  KIOSK_SLIDE_IDS.forEach(function (type) { kioskFetch(type); });

  clearInterval(_kioskRefreshTimer);
  _kioskRefreshTimer = setInterval(function () {
    if (!_kioskMode) return;
    kioskFetch(kioskActiveType());
  }, KIOSK_REFRESH_MS);

  clearInterval(_kioskWatchTimer);
  _kioskWatchTimer = setInterval(kioskWatchData, KIOSK_WATCH_MS);

  if (_kioskRafId) cancelAnimationFrame(_kioskRafId);
  _kioskRafId = requestAnimationFrame(kioskLoop);

  var kioskBtn = document.getElementById('kioskToggleBtn');
  if (kioskBtn) kioskBtn.classList.add('active-kiosk');

  if (typeof showToast === 'function') {
    showToast('Kiosk Mode ON — Press Escape x3 to exit', 'info', 3000);
  }
}

function exitKioskMode() {
  if (!_kioskMode) return;
  _kioskMode = false;
  document.body.classList.remove('kiosk-mode', 'kiosk-mode-paused');

  if (_kioskRafId) { cancelAnimationFrame(_kioskRafId); _kioskRafId = null; }
  clearInterval(_kioskClockTimer);
  clearInterval(_kioskRefreshTimer);
  clearInterval(_kioskWatchTimer);
  clearTimeout(_kioskIdleTimer);
  _kioskClockTimer = null;
  _kioskRefreshTimer = null;
  _kioskWatchTimer = null;
  _kioskIdleTimer = null;
  _kioskIdlePaused = false;

  var root = document.getElementById('kioskRoot');
  if (root) root.setAttribute('aria-hidden', 'true');

  try {
    if (document.exitFullscreen) {
      document.exitFullscreen().catch(function () {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  } catch (e) { /* ignore */ }

  var kioskBtn = document.getElementById('kioskToggleBtn');
  if (kioskBtn) kioskBtn.classList.remove('active-kiosk');

  if (typeof showToast === 'function') showToast('Kiosk Mode OFF', 'info', 2000);
}

function toggleKioskMode() {
  if (_kioskMode) exitKioskMode();
  else enterKioskMode();
}

function showKioskExitHint(count) {
  var hint = document.getElementById('kioskExitHint');
  if (!hint) return;
  var left = 3 - count;
  hint.textContent = 'Press Escape ' + left + ' more time' + (left > 1 ? 's' : '') + ' to exit';
  hint.classList.add('show');
  setTimeout(function () { hint.classList.remove('show'); }, 1200);
}

/* ------------------------------------------------------------------ *
   Wiring
 * ------------------------------------------------------------------ */
(function kioskWireControls() {
  var prev = document.getElementById('kioskPrevBtn');
  var next = document.getElementById('kioskNextBtn');
  var play = document.getElementById('kioskPlayBtn');

  if (prev) prev.addEventListener('click', function () { kioskPrevSlide(); kioskPauseForIdle(); });
  if (next) next.addEventListener('click', function () { kioskNextSlide(); kioskPauseForIdle(); });
  if (play) play.addEventListener('click', function () { toggleKioskPause(); });

  /* Manual interaction pauses rotation briefly, then auto-resumes. */
  var root = document.getElementById('kioskRoot');
  if (root) {
    root.addEventListener('pointerdown', function () { kioskPauseForIdle(); }, { passive: true });
  }
})();

(function kioskKeyboardShortcuts() {
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k')) {
      e.preventDefault();
      toggleKioskMode();
      return;
    }

    if (!_kioskMode) return;

    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      toggleKioskPause();
      return;
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      kioskNextSlide();
      kioskPauseForIdle();
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      kioskPrevSlide();
      kioskPauseForIdle();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      _kioskEscapeCount++;
      clearTimeout(_kioskEscapeTimer);
      _kioskEscapeTimer = setTimeout(function () { _kioskEscapeCount = 0; }, 1500);
      if (_kioskEscapeCount >= 3) {
        _kioskEscapeCount = 0;
        exitKioskMode();
        return;
      }
      showKioskExitHint(_kioskEscapeCount);
    }
  });
})();

/* ------------------------------------------------------------------ *
   URL entry point:  ?kiosk=true            auto-start after the app shows
                     &interval=5..300        seconds per slide (default 9)
 * ------------------------------------------------------------------ */
(function kioskAutoStartFromUrl() {
  var params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch (e) {
    return;
  }
  if (params.get('kiosk') !== 'true') return;

  var interval = parseInt(params.get('interval'), 10);
  if (interval && interval >= 5 && interval <= 300) _kioskRotateMs = interval * 1000;

  var attempts = 0;
  var timer = setInterval(function () {
    attempts++;
    if (!_kioskMode) {
      var overlay = document.getElementById('loginOverlay');
      var hidden = !overlay ||
        overlay.classList.contains('hidden') ||
        (window.getComputedStyle && window.getComputedStyle(overlay).display === 'none');
      if (hidden) enterKioskMode();
    }
    if (_kioskMode || attempts > 240) clearInterval(timer);
  }, 500);
})();
