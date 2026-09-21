// ====================== OLT MODULE ======================

// Decode compact OLT format (v2/v3) into plain objects
function decodeOltCompact(compact) {
  var f = compact.f, p = compact.p, m = compact.m, r = compact.r;
  return r.map(function(row) {
    var obj = {};
    f.forEach(function(field, i) {
      if (field === 'P') obj[field] = p[row[i]];
      else if (field === 'M') obj[field] = m[row[i]];
      else obj[field] = row[i];
    });
    return obj;
  });
}

// Server-provided meta summary for shape=3 compact responses
var oltMeta = null;

// The healthy fleet is deliberately separate from the incident data. It is
// fetched only after an operator asks for the drill-down, never on initial load.
var oltUpData = null;
var oltUpLoaded = false;
var oltUpLoading = false;
var oltUpError = '';
var oltView = 'overview';
var oltUpQuery = '';
var oltUpPage = 1;
var OLT_UP_PAGE_SIZE = 50;

/* The ONE place a response becomes what this module renders.

   There used to be two copies of this (a background callback and the foreground
   path), and two copies of a three-branch decision is how `dataCache.olt`,
   `oltMeta` and `rawOltData` end up describing different things — the failure
   mode is silent, because the tables read the array and the summary cards read
   the meta, so a mismatch shows up as numbers that quietly disagree with the
   list under them.

   It is also the only place that sees the server's build stamp, which is why the
   ticker is told from here: every caller that renders gets the age for free. */
function applyOltPayload(data) {
  if (data && data.v === 3 && data.meta) {
    dataCache.olt = decodeOltCompact(data);
    oltMeta = data.meta;
  } else if (Array.isArray(data) && data.length > 0) {
    /* Legacy full-row shape: no meta, so the cards fall back to computing from
       the rows. Still handled, because a client that has not reloaded yet can
       only ask for this. */
    dataCache.olt = data;
    oltMeta = null;
  } else {
    return false; /* nothing usable: leave every store exactly as it was */
  }

  rawOltData = dataCache.olt;

  /* The age of the picture we are about to draw. It rides inside the cached
     bytes, so a cache HIT reports the build time rather than the hit time — and a
     chip that reports the hit time is what made a deleted ticket look fresh for
     11 minutes on 2026-09-18. Untrusted values fall through to the previous
     stamp, and fetch-gate keeps the fetch-time fallback for callers that never
     send one. */
  var builtAt = (data.meta && data.meta.builtAt) || data.builtAt;
  if (builtAt) fetchGate.noteBuiltAt('olt', builtAt);

  return true;
}

function applyOltUpPayload(data) {
  if (!data || data.v !== 4 || !data.meta || !Array.isArray(data.r)) return false;
  oltUpData = decodeOltCompact(data);
  oltUpLoaded = true;
  oltUpLoading = false;
  oltUpError = '';
  return true;
}

/* ?fresh=1 is the only thing a client can say that makes the server skip its
   cache, and the server rate-limits it (once per minute per type, see
   claimForcedRebuild in code.gs). Only an explicit REFRESH asks for it. */
function oltDataUrl(forceServerFresh) {
  return BASE_API_URL + "?type=olt&shape=3" + (forceServerFresh ? "&fresh=1" : "");
}

function oltUpDataUrl() {
  return BASE_API_URL + "?type=olt&shape=4";
}

async function fetchOltData(forceRefresh = false, forceServerFresh = false) {
  if (!forceRefresh && dataCache.olt) {
    rawOltData = dataCache.olt;
    processAndRenderOlt();
    // Deduped + throttled background refresh via the shared gate
    fetchGate.fetchQueued('olt', oltDataUrl(false), data => {
      if (applyOltPayload(data)) processAndRenderOlt();
    });
    return;
  }

  // Keep the existing dashboard shell visible underneath the executive loading state.
  showModuleLoading('olt');

  try {
    const data = await fetchGate.run('olt', oltDataUrl(forceServerFresh));

    if (applyOltPayload(data) && rawOltData && rawOltData.length > 0) {
      processAndRenderOlt();
    }
  } catch (error) {
    console.error('Error fetching OLT data:', error);
  } finally {
    hideModuleLoading('olt');
  }
}

function aggregateOltDownCauses(rows) {
  const counts = {};
  (Array.isArray(rows) ? rows : []).forEach(item => {
    const status = (item.S || item.STATUS || '').toString().trim().toUpperCase();
    if (status !== 'DOWN') return;

    const cause = (item.DC || item.DT_CAUSE || '').toString().trim();
    const normalizedCause = cause || 'UNKNOWN';
    counts[normalizedCause] = (counts[normalizedCause] || 0) + 1;
  });

  return Object.keys(counts)
    .map(label => ({ label, count: counts[label] }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function processAndRenderOlt() {
  hideModuleLoading('olt');
  let countUp = 0, countDown = 0, countLowPower = 0, countUplinkDown = 0, countDegradation = 0;
  let countActive = 0;
  let totalClientsSA = 0;
  let totalOlt = rawOltData.length;

  if (oltMeta) {
    // Use precomputed meta from server (shape=3 compact response)
    countUp = oltMeta.up;
    countDown = oltMeta.down;
    countLowPower = oltMeta.lowPower;
    countUplinkDown = oltMeta.uplinkDown;
    countDegradation = oltMeta.degradation;
    totalClientsSA = Number(oltMeta.clientsSA) || 0;
    totalOlt = oltMeta.total;

    /* ACTIVE INCIDENTS is every row the server did NOT call UP: the test the server applied
       when it chose which rows to send, and the same test the ACTIVE filter re-applies to
       them when it renders. Derived from the fleet size rather than added up from the four
       arms below, because those arms are a hand-written list of the statuses anyone thought
       of — a status the sheet spells differently increments none of them, and the card would
       count one incident fewer than the table shows while the row sat there on screen. */
    countActive = Math.max(0, totalOlt - countUp);
  } else {
    // Fallback: compute from data (legacy shape=1)
    rawOltData.forEach(item => {
      const status = (item.S || item.STATUS || '').toString().trim().toUpperCase();
      /* The same comparison the ACTIVE filter makes, so the card and the table cannot
         disagree about what active means. */
      if (status !== 'UP') countActive++;
      if (status === 'DOWN') countDown++;
      else if (status.includes('LOW POWER')) countLowPower++;
      else if (status.includes('UPLINK DOWN')) countUplinkDown++;
      else if (status.includes('DEGRADATION')) countDegradation++;
      else countUp++;

      /* Affected Clients (SA) is scoped by the TICKET's impact, not by this row's status,
         so it is counted beside the status chain rather than inside one of its arms: an OLT
         in LOW POWER whose ticket is SA counts, and a DOWN ticket marked NSA does not. */
      if (status !== 'UP' && (item.IM || '').toString().trim().toUpperCase() === 'SA') {
        totalClientsSA += parseInt(item.CA || 0) || 0;
      }
    });
  }

  // Null-safe DOM updates
  const _el = (id) => document.getElementById(id);
  if (_el('oltCardActive')) _el('oltCardActive').textContent = countActive;
  if (_el('oltCardUp')) _el('oltCardUp').textContent = countUp;
  if (_el('oltCardDown')) _el('oltCardDown').textContent = countDown;
  if (_el('oltCardLowPower')) _el('oltCardLowPower').textContent = countLowPower;
  if (_el('oltCardUplinkDown')) _el('oltCardUplinkDown').textContent = countUplinkDown;

  // Apply alert thresholds to stat cards
  const cardDown = _el('cardOltDown');
  if (cardDown) cardDown.className = 'stat-card clickable ' + getAlertClass('oltDown', countDown);
  const cardLP = _el('cardOltLowPower');
  if (cardLP) cardLP.className = 'stat-card clickable ' + getAlertClass('oltLowPower', countLowPower);
  if (_el('oltCardDegradation')) _el('oltCardDegradation').textContent = countDegradation;
  if (_el('oltCardClientsSA')) _el('oltCardClientsSA').textContent = totalClientsSA;

  renderOltDonut(countUp, countDown, countLowPower, countUplinkDown, countDegradation, totalOlt);
  if (oltView === 'healthy-summary' || oltView === 'healthy-list') renderHealthyOltFleet();
  else renderOltTable();

  // Expose the normalized aggregation for the dashboard and future consumers
  // without changing the API.
  window.oltDownCauseBreakdown = aggregateOltDownCauses(rawOltData);
}

function renderOltDonut(up, down, lowPower, uplinkDown, degradation, total) {
  const chart = document.getElementById('oltDonutChart');
  const legend = document.getElementById('oltDonutLegend');
  const totalLabel = document.getElementById('oltDonutTotalLabel');
  if (!chart || !legend) return;

  if (totalLabel) totalLabel.textContent = total;

  const segments = [
    { label: 'UP', value: up, color: 'var(--badge-green-text)' },
    { label: 'DOWN', value: down, color: 'var(--badge-red-text)' },
    { label: 'LOW POWER', value: lowPower, color: 'var(--badge-orange-text)' },
    { label: 'UPLINK DOWN', value: uplinkDown, color: 'var(--badge-yellow-text)' },
    { label: 'DEGRADATION', value: degradation, color: 'var(--badge-purple-text)' }
  ];

  let gradientParts = [];
  let cumulativePct = 0;
  legend.innerHTML = '';

  segments.forEach(seg => {
    const pct = total > 0 ? (seg.value / total) * 100 : 0;
    if (pct > 0) {
      gradientParts.push(`${seg.color} ${cumulativePct}% ${cumulativePct + pct}%`);
      cumulativePct += pct;
    }
    const legendItem = document.createElement('div');
    legendItem.style.cssText = 'display:flex; align-items:center; gap:8px;';
    legendItem.innerHTML = `
      <span style="width:10px; height:10px; border-radius:50%; background:${seg.color}; display:inline-block; flex-shrink:0;"></span>
      <span>${seg.label}: <strong>${seg.value}</strong> (${pct.toFixed(1)}%)</span>
    `;
    legend.appendChild(legendItem);
  });

  chart.style.background = gradientParts.length > 0
    ? `conic-gradient(${gradientParts.join(', ')})`
    : 'var(--card-bg)';
}

function setOltFilter(filterType) {
  oltView = 'overview';
  currentOltFilter = filterType;

  document.querySelectorAll('.filter-btn').forEach(btn => btn.classList.remove('active'));

  const btnMap = {
    'ACTIVE': 'btnFilterActiveIncidents',
    'DOWN': 'btnFilterDown',
    'LOW POWER': 'btnFilterLowPower',
    'UPLINK DOWN': 'btnFilterUplinkDown',
    'DEGRADATION': 'btnFilterDegradation',
    'UP': 'btnFilterUp'
  };

  if (btnMap[filterType] && document.getElementById(btnMap[filterType])) {
    document.getElementById(btnMap[filterType]).classList.add('active');
  }

  renderOltTable();
}

function healthyPanel_() {
  return document.getElementById('oltHealthyFleetPanel');
}

/* The healthy fleet IS the UP view of this module, so the toolbar has to say UP
   while it is open. It used to keep whatever was active before — DOWN, the overview's
   default at the time — so the strip said the opposite of what was on screen.
   Scoped to this tab's toolbar, unlike setOltFilter's app-wide sweep. */
function markOltFilterActive_(buttonId) {
  const strip = document.querySelector('#tab-olt .filter-toolbar');
  document.querySelectorAll('#tab-olt .filter-toolbar .filter-btn')
    .forEach(btn => btn.classList.remove('active'));
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  btn.classList.add('active');

  /* UP is the last pill in a strip that scrolls sideways on narrow screens, so the
     highlight can land off-screen and the strip reads as "nothing selected". This
     nudges the strip only — never the page — so opening the fleet cannot scroll the
     dashboard out from under the operator. */
  if (!strip || typeof btn.offsetLeft !== 'number') return;
  const left = btn.offsetLeft;
  const right = left + btn.offsetWidth;
  if (left < strip.scrollLeft) strip.scrollLeft = left;
  else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
}

function showHealthyOltFleet() {
  oltView = 'healthy-summary';
  renderHealthyOltFleet();
}

function showOltOverview() {
  oltView = 'overview';
  oltUpQuery = '';
  oltUpPage = 1;
  /* Back to the landing view. It used to return to DOWN, which was the default before the
     toolbar's first pill became Active Incidents — a "Back" that landed somewhere other
     than where the operator started. */
  setOltFilter('ACTIVE');
}

async function loadHealthyOltList() {
  oltView = 'healthy-list';
  /* Loaded already, or a fetch is already in flight — render either way. The
     in-flight case must not return quietly: the origin here can take 40s, so a tap
     on "View All Healthy OLTs" that changed nothing on screen read as a dead button
     while oltView said 'healthy-list' and the summary was still displayed. The next
     call starts no second request; it only moves the view to the loading state. */
  if (oltUpLoaded || oltUpLoading) {
    renderHealthyOltFleet();
    return;
  }

  oltUpLoading = true;
  oltUpError = '';
  renderHealthyOltFleet();
  try {
    const data = await fetchGate.run('olt-up', oltUpDataUrl());
    if (!applyOltUpPayload(data)) throw new Error('Invalid healthy OLT response');
  } catch (error) {
    oltUpLoading = false;
    oltUpError = 'Unable to load the healthy OLT list. Please try again.';
    console.error('Error fetching healthy OLT data:', error);
  }
  renderHealthyOltFleet();
}

/* The drill-down borrows the dashboard's own components rather than styling a
   second visual language beside it: .stat-card tiles, the .search-input bar and the
   analytics .bar-chart-track/fill. Every colour therefore comes from the theme's
   tokens, and the dark-mode frosted glass arrives with the tile instead of being
   hand-copied.

   The list is a shell plus a repaint. Rebuilding the whole panel on every keystroke
   replaced the input that had focus, so the caret was lost after the first
   character and the box had to be clicked again per letter; search and page
   changes now repaint only the rows, the count and the pager. */
function healthyHeading_(titleId, title, lede, isError, actionsHtml) {
  return `<div class="healthy-olt-heading">
    <div>
      <p class="healthy-olt-eyebrow">NETWORK HEALTH</p>
      <h2 id="${titleId}">${title}</h2>
      <p class="${isError ? 'healthy-olt-error' : 'healthy-olt-lede'}">${lede}</p>
    </div>
    <div class="healthy-olt-actions">
      ${actionsHtml || ''}
      <button class="filter-btn" type="button" onclick="showOltOverview()">Back to OLT Overview</button>
    </div>
  </div>`;
}

/* The healthy fleet needs its own export because the incident table's buttons step
   aside with the table in this view, and reusing them would have exported a table
   that is not on screen. Deliberately NOT class="export-toolbar": the panel's own
   chrome logic queries the first .export-toolbar in the tab to hide it, so a second
   one inside the panel would hide itself. */
function healthyExportButton_() {
  return `<button class="export-btn" id="healthyOltExport" type="button" onclick="exportHealthyOltCsv()">
      ${iconMarkup('download', { size: 14 })}
      Export CSV
    </button>`;
}

var OLT_UP_CSV_COLUMNS = [
  { label: 'PROVINCE', key: 'P' },
  { label: 'MUNICIPALITY', key: 'M' },
  { label: 'OLT NAME', key: 'N' },
  { label: 'STATUS', fixed: 'UP' }
];

/* This exports the DATA, not the DOM — and that is the whole reason it exists. The
   incident table's exportTableToCSV() reads its <tbody>, which is right for a table
   that renders every row; this list shows 50 rows a page out of 457, so a DOM export
   would quietly hand back one page and look complete. Everything the current search
   matches is written out, in the order the screen lists it, using the same quoting,
   filename shape and toast as the exporter the rest of the app already uses. */
function exportHealthyOltCsv() {
  const rows = healthyMatches_();
  if (!rows.length) return;

  const quote = function(value) {
    return '"' + String(value == null ? '' : value).trim().replace(/"/g, '""') + '"';
  };
  const cell = function(item, column) {
    return quote(column.fixed !== undefined ? column.fixed : item[column.key]);
  };

  const lines = [OLT_UP_CSV_COLUMNS.map(function(c) { return quote(c.label); }).join(',')];
  rows.forEach(function(item) {
    lines.push(OLT_UP_CSV_COLUMNS.map(function(c) { return cell(item, c); }).join(','));
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'OLT_Healthy_Fleet_' + new Date().toISOString().slice(0, 10) + '.csv';
  link.click();
  URL.revokeObjectURL(link.href);
  if (typeof showToast === 'function') showToast('CSV exported successfully!', 'success');
}

function healthyMatches_() {
  const rows = oltUpData || [];
  const needle = oltUpQuery.trim().toLowerCase();
  if (!needle) return rows.slice();
  return rows.filter(function(item) {
    return [item.P, item.M, item.N].join(' ').toLowerCase().indexOf(needle) !== -1;
  });
}

function setHealthyOltSearch(query) {
  oltUpQuery = String(query || '');
  oltUpPage = 1;
  paintHealthyOltRows();
}

function setHealthyOltPage(page) {
  oltUpPage = Math.max(1, Number(page) || 1);
  paintHealthyOltRows();
}

function paintHealthyOltRows() {
  const body = document.getElementById('healthyOltListBody');
  if (!body) return;
  const safe = typeof sanitizeHTML === 'function' ? sanitizeHTML : (v => String(v));
  const rows = healthyMatches_();
  const pages = Math.max(1, Math.ceil(rows.length / OLT_UP_PAGE_SIZE));
  oltUpPage = Math.min(Math.max(1, oltUpPage), pages);
  const start = (oltUpPage - 1) * OLT_UP_PAGE_SIZE;
  const pageRows = rows.slice(start, start + OLT_UP_PAGE_SIZE);

  body.innerHTML = pageRows.map(function(item) {
    return `<tr><td>${safe(item.P || '-')}</td><td>${safe(item.M || '-')}</td><td><strong>${safe(item.N || '-')}</strong></td><td><span class="badge badge-green">UP</span></td></tr>`;
  }).join('') || '<tr><td colspan="4" class="healthy-olt-empty">No healthy OLTs match this search.</td></tr>';

  const countEl = document.getElementById('healthyOltSearchCount');
  if (countEl) countEl.textContent = rows.length.toLocaleString() + ' found';

  const rangeEl = document.getElementById('healthyOltListRange');
  if (rangeEl) {
    rangeEl.textContent = rows.length
      ? 'Showing ' + (start + 1).toLocaleString() + '\u2013' +
        Math.min(start + OLT_UP_PAGE_SIZE, rows.length).toLocaleString() +
        ' of ' + rows.length.toLocaleString()
      : 'No matching OLTs';
  }

  /* The button says how much it will write, and goes quiet when the search matches
     nothing — a live "Export CSV" over an empty result is how a user ends up with a
     one-line file and a bug report. */
  const exportBtn = document.getElementById('healthyOltExport');
  if (exportBtn) {
    const listed = rows.length.toLocaleString() + ' listed OLT' + (rows.length === 1 ? '' : 's');
    exportBtn.disabled = rows.length === 0;
    exportBtn.title = 'Export ' + listed + ' as CSV';
    exportBtn.setAttribute('aria-label', 'Export ' + listed + ' as CSV');
  }

  const pager = document.getElementById('healthyOltListPager');
  if (pager) {
    pager.innerHTML =
      `<button class="filter-btn" type="button" onclick="setHealthyOltPage(${oltUpPage - 1})" ${oltUpPage <= 1 ? 'disabled' : ''}>Previous</button>` +
      `<span class="healthy-olt-pageof">Page ${oltUpPage} of ${pages}</span>` +
      `<button class="filter-btn" type="button" onclick="setHealthyOltPage(${oltUpPage + 1})" ${oltUpPage >= pages ? 'disabled' : ''}>Next</button>`;
  }
}

function renderHealthyOltFleet() {
  const panel = healthyPanel_();
  const issuesCard = document.getElementById('oltIssuesTableCard');
  const exportToolbar = document.querySelector('#tab-olt .export-toolbar');
  if (!panel) return;

  /* The incident table and its export bar step aside; the filter strip does NOT.
     It is the module's navigator, it is what tells the operator which of the two
     OLT views they are in, and one tap on DOWN takes them back — so hiding it both
     removed the way back and left the wrong button highlighted underneath. */
  panel.hidden = false;
  if (issuesCard) issuesCard.hidden = true;
  if (exportToolbar) exportToolbar.hidden = true;
  markOltFilterActive_('btnFilterUp');

  const safe = typeof sanitizeHTML === 'function' ? sanitizeHTML : (v => String(v));
  const up = oltMeta ? Number(oltMeta.up) || 0 : 0;
  const total = oltMeta ? Number(oltMeta.total) || 0 : 0;
  const share = total > 0 ? Math.round((up / total) * 100) : 0;

  if (oltView === 'healthy-summary') {
    panel.innerHTML = `
      <section class="healthy-olt-panel" aria-labelledby="healthyOltTitle">
        ${healthyHeading_('healthyOltTitle', 'Healthy OLT Fleet', 'OLTs reporting UP across the whole tracked fleet.')}
        <div class="healthy-olt-metrics">
          <div class="stat-card c-green"><div class="label">REPORTING UP</div><div class="value" aria-live="polite">${up.toLocaleString()}</div></div>
          <div class="stat-card c-total"><div class="label">TOTAL OLT</div><div class="value">${total.toLocaleString()}</div></div>
        </div>
        ${total > 0 ? `<div class="healthy-olt-share">
          <div class="bar-chart-track" role="img" aria-label="${up} of ${total} tracked OLTs reporting UP"><div class="bar-chart-fill" style="width:${share}%"></div></div>
          <p class="healthy-olt-share-label"><strong>${share}%</strong> of the tracked fleet is UP</p>
        </div>` : ''}
        <button class="healthy-olt-cta" type="button" onclick="loadHealthyOltList()">View All Healthy OLTs</button>
      </section>`;
    return;
  }

  if (oltUpLoading) {
    panel.innerHTML = `<section class="healthy-olt-panel" aria-live="polite" aria-busy="true">
      ${healthyHeading_('healthyOltListTitle', 'Healthy OLT List', 'Loading the healthy fleet\u2026')}
    </section>`;
    return;
  }
  if (!oltUpLoaded) {
    panel.innerHTML = `<section class="healthy-olt-panel">
      ${healthyHeading_('healthyOltListTitle', 'Healthy OLT List', safe(oltUpError || 'No healthy OLT data is available.'), true)}
      <button class="healthy-olt-cta" type="button" onclick="loadHealthyOltList()">Try Again</button>
    </section>`;
    return;
  }

  panel.innerHTML = `
    <section class="healthy-olt-panel" aria-labelledby="healthyOltListTitle">
      ${healthyHeading_('healthyOltListTitle', 'Healthy OLT List', 'Every OLT reporting UP in the latest snapshot from the server.', false, healthyExportButton_())}
      <div class="search-bar-container">
        <input type="search" class="search-input" id="healthyOltSearch" aria-label="Search healthy OLTs"
               placeholder="Search province, municipality, or OLT name\u2026"
               oninput="debounce('olt-healthy-search', () => setHealthyOltSearch(this.value), 200)">
        <span class="search-count" id="healthyOltSearchCount"></span>
      </div>
      <div class="table-wrapper">
        <table class="data-table">
          <thead><tr><th>PROVINCE</th><th>MUNICIPALITY</th><th>OLT NAME</th><th>STATUS</th></tr></thead>
          <tbody id="healthyOltListBody"></tbody>
        </table>
      </div>
      <div class="healthy-olt-pagination">
        <span id="healthyOltListRange"></span>
        <div id="healthyOltListPager"></div>
      </div>
    </section>`;

  /* The query is written as a property, never interpolated into the markup: a
     search term can contain a quote, and `value="${...}"` would let it leave the
     attribute. */
  const searchEl = document.getElementById('healthyOltSearch');
  if (searchEl && oltUpQuery) searchEl.value = oltUpQuery;
  paintHealthyOltRows();
}

function getCauseColor(cause) {
  const c = (cause || '').toUpperCase().trim();
  if (c === 'FIBER') return { color: '#e74c3c', bg: 'rgba(231,76,60,0.18)' };
  if (c === 'POWER') return { color: '#e67e22', bg: 'rgba(230,126,34,0.18)' };
  if (c === 'EQUIPMENT') return { color: '#f39c12', bg: 'rgba(243,156,18,0.18)' };
  if (c === 'TBD') return { color: '#7f8c8d', bg: 'rgba(127,140,141,0.15)' };
  if (c === 'FIBER AND POWER') return { color: '#8e44ad', bg: 'rgba(142,68,173,0.18)' };
  return { color: 'var(--text-muted)', bg: 'transparent' };
}

/* ── OLT ZERO STATE ──

   Active Incidents is this tab's DEFAULT landing view, and "nothing is wrong" is its best
   news — but it used to render as a bare <td> reading "No OLTs found under status: DOWN"
   inside a table with no rows, styled by an inline attribute instead of the theme.

   Two things it deliberately does NOT do:

   - It does not keep an empty table on screen. `@media (max-width: 340px)` turns every
     <tr> into a card and gives every <td> a ::before label taken from `data-label`, so an
     empty state living inside a cell inherits that shape on a phone. The table leaves the
     screen instead; the stat cards, the donut and the filter strip stay exactly where they
     are, because they are what still reports 457/461 while the list below is blank.
   - It does not write into tbody. The live region is a sibling of `.table-wrapper` inside
     #oltIssuesTableCard, created once and repainted after, so a re-render cannot replace
     a node that a screen reader is watching.

   The copy is per filter, and the "no data at all" case is worded apart from the healthy
   one on purpose: an empty list over a payload that carried NOTHING means no rows
   ARRIVED, and calling that a healthy fleet would be a claim the payload does not
   support. That case is decided from the data itself — see oltEmptyCopy_(). */

/* The all-clear copy, declared ONCE and shared by the two views that can legitimately claim
   it. A copy per view is how two cards that mean the same thing start saying different
   things; the badges these views render under the sentence are what scope it.

   ACTIVE is the tab's DEFAULT view and it is empty only when DOWN, LOW POWER, UPLINK DOWN
   and DEGRADATION are all zero — the server sends nothing but incident rows — so there the
   sentence is exactly true. DOWN is the narrower view whose own card the fleet's numbers
   sit under. */
var OLT_ALL_CLEAR_COPY = {
  title: 'All OLT Systems Operational',
  lede: 'All tracked OLTs are functional. Incident alerts will automatically render here in real time.',
  healthy: true
};

var OLT_EMPTY_COPY = {
  'ACTIVE': OLT_ALL_CLEAR_COPY,
  'DOWN': OLT_ALL_CLEAR_COPY,
  /* The three partial filters name themselves, because "nothing matches" and "nothing is
     wrong" look alike on screen otherwise — and DOWN is this tab's default view, so an
     operator who has just tapped LOW POWER has to be told it is the FILTER with no rows,
     not the network with no problem. */
  'LOW POWER': {
    title: 'No Low Power OLTs',
    lede: 'Nothing in this snapshot matches the LOW POWER filter.'
  },
  'UPLINK DOWN': {
    title: 'No Uplink Down OLTs',
    lede: 'Nothing in this snapshot matches the UPLINK DOWN filter.'
  },
  'DEGRADATION': {
    title: 'No Degraded OLTs',
    lede: 'Nothing in this snapshot matches the DEGRADATION filter.'
  },
};

/* "No rows ARRIVED" is a DIFFERENT fact from "this filter matched nothing": the first is a
   missing snapshot, the second is a fleet with nothing to report. Saying "no OLT is down"
   over a missing snapshot would turn a failure into good news, so it is worded apart and
   points at the one control that can fix it.

   It is chosen from the DATA, not from a filter token, because no token can decide it: a
   payload that carried a summary, or carried rows, is evidence the server answered — an
   empty list is then a fact about the filters. It used to hang off the 'ALL' token, which
   meant the one screen it described depended on which button had been tapped. */
var OLT_MISSING_COPY = {
  title: 'No OLT data in this snapshot',
  lede: 'The server returned no OLT rows. Use REFRESH to build a new snapshot.',
  missing: true
};

function oltEmptyCopy_(filter) {
  if (!oltMeta && !(rawOltData || []).length) return OLT_MISSING_COPY;
  return OLT_EMPTY_COPY[filter] || {
    title: 'Nothing to list',
    lede: 'No OLT in this snapshot matches the current filter.'
  };
}

/* The same numbers the cards above show. `oltMeta` wins because that is what the cards
   read: a zero state that disagreed with the tiles directly above it would be worse than
   no zero state at all. Legacy shape=1 carries no meta, so the count falls back to the
   rows, using the same rules processAndRenderOlt uses. */
function oltFleetCounts_() {
  if (oltMeta) {
    return {
      up: Number(oltMeta.up) || 0,
      total: Number(oltMeta.total) || 0,
      down: Number(oltMeta.down) || 0
    };
  }
  var up = 0, down = 0;
  (rawOltData || []).forEach(function(item) {
    var status = (item.S || item.STATUS || '').toString().trim().toUpperCase();
    if (status === 'DOWN') { down++; return; }
    if (status.includes('LOW POWER') || status.includes('UPLINK DOWN') || status.includes('DEGRADATION')) return;
    up++;
  });
  return { up: up, total: (rawOltData || []).length, down: down };
}

function oltEmptyStateMarkup_(filter) {
  const copy = oltEmptyCopy_(filter);
  const counts = oltFleetCounts_();
  /* Only the DOWN case is a health claim, so only it gets the numbers. A missing snapshot
     also gets a different glyph: a green all-clear drawn over "no rows arrived" would be
     the same lie in a nicer card.

     The all-clear glyph is `activity` — the steady signal — and not a tick inside a circle.
     The tick WAS a circle, drawn inside this card's own 64px circle, so the two rings read
     as one smudged ring; `activity` is also the line the login screen already uses for
     real-time monitoring, which is what this card is reporting on. */
  const icon = copy.missing
    ? iconMarkup('circle-alert', { strokeWidth: 1.8 })
    : iconMarkup('activity', { strokeWidth: 1.8 });
  const metrics = copy.healthy
    ? `<div class="olt-empty-metrics">
        <span class="badge badge-green">${counts.up.toLocaleString()} UP</span>
        <span class="badge badge-gray">${counts.total.toLocaleString()} TRACKED</span>
        <span class="badge badge-red">${counts.down.toLocaleString()} DOWN</span>
      </div>`
    : '';
  /* There is no action here on purpose. "View All Healthy OLTs" duplicated the UP card and
     the UP filter, which open the same list from a control that is always on screen — and
     on the one card that has nothing wrong to report, the last thing it should do is ask
     the operator to go and check. The fleet is one tap away either way; this card reports. */

  /* role=status + aria-live sit on the container and the icon is aria-hidden: a filter tap
     that yields nothing is a change worth hearing explained, and the icon is decoration —
     the sentence under it carries the meaning. */
  return `<div class="olt-empty-state${copy.missing ? ' is-missing' : ''}" role="status" aria-live="polite">
    <div class="olt-empty-icon">${icon}</div>
    <h3 class="olt-empty-title">${copy.title}</h3>
    <p class="olt-empty-desc">${copy.lede}</p>
    ${metrics}
  </div>`;
}

/* One host element, created on first use and repainted after — the same shape as the
   export toolbar below, and for the same reason: a fresh node per render would replace
   the live region rather than update it. */
function oltEmptyStateHost_(card) {
  if (!card) return null;
  let host = card.querySelector('.olt-empty-state-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'olt-empty-state-host';
    card.appendChild(host);
  }
  return host;
}

function showOltEmptyState_(filter) {
  const card = document.getElementById('oltIssuesTableCard');
  const wrapper = card ? card.querySelector('.table-wrapper') : null;
  const tbody = document.getElementById('oltTableBody');
  const host = oltEmptyStateHost_(card);
  if (tbody) tbody.innerHTML = '';
  if (wrapper) wrapper.hidden = true;
  if (host) {
    host.innerHTML = oltEmptyStateMarkup_(filter);
    host.hidden = false;
  }
}

function hideOltEmptyState_() {
  const card = document.getElementById('oltIssuesTableCard');
  const wrapper = card ? card.querySelector('.table-wrapper') : null;
  const host = card ? card.querySelector('.olt-empty-state-host') : null;
  if (wrapper) wrapper.hidden = false;
  if (host) { host.hidden = true; host.innerHTML = ''; }
}

/* The export toolbar is built here so the zero state can reach it: with no rows the CSV
   would be a header line and the PDF would be this card, which is why `renderOltTable`
   mutes it and then takes it off screen when the table comes up empty. The healthy fleet
   mutes its own button the same way, so the app keeps one answer to "what happens when
   there is nothing to export". */
function setupOltExportToolbar_() {
  const oltTab = document.getElementById('tab-olt');
  if (!oltTab) return null;
  let toolbar = oltTab.querySelector('.export-toolbar');
  if (toolbar) return toolbar;

  toolbar = document.createElement('div');
  toolbar.className = 'export-toolbar';
  toolbar.innerHTML = `
      <button class="export-btn" onclick="exportTableToCSV('oltTableBody', 'OLT_Report')">
        ${iconMarkup('download', { size: 14 })}
        Export CSV
      </button>
      <button class="export-btn" onclick="exportTabToPDF('tab-olt', 'OLT_Report')">
        ${iconMarkup('file-text', { size: 14 })}
        Export PDF
      </button>
    `;
  const strip = oltTab.querySelector('.filter-toolbar');
  if (strip) strip.parentNode.insertBefore(toolbar, strip.nextSibling);
  return toolbar;
}

function setOltExportEnabled_(enabled) {
  const toolbar = document.querySelector('#tab-olt .export-toolbar');
  if (!toolbar) return;
  const reason = 'Nothing to export — no OLT matches the ' + oltFilterLabel_() + ' filter';
  const buttons = toolbar.querySelectorAll('button.export-btn');
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    if (enabled) {
      btn.disabled = false;
      btn.removeAttribute('title');
      btn.removeAttribute('aria-label');
    } else {
      btn.disabled = true;
      btn.title = reason;
      btn.setAttribute('aria-label', btn.textContent.replace(/\s+/g, ' ').trim() + ' — ' + reason);
    }
  }
}

/* The footer and the tooltips name the view in the words the toolbar itself uses. 'ACTIVE'
   is the only token whose printed form differs from the token, and this is where it would
   have read "FILTERED TOTAL (ACTIVE)". */
function oltFilterLabel_() {
  return currentOltFilter === 'ACTIVE' ? 'ACTIVE INCIDENTS' : currentOltFilter;
}

/* The INCIDENT cell's label, trimmed of the module prefix the status arrives with: every row
   in this table is an OLT, so "OLT UPLINK DOWN" spends its first word repeating the name of
   the tab you are already looking at. DOWN is retained exactly as it arrives — it carries no
   prefix, and it is the one status whose label is already the whole story under this header.

   A DISPLAY transform, and nothing else. The raw status is what the filters compare against
   (`st.includes('LOW POWER')`), what the cards and `meta` count, and what the modal receives —
   and the raw value is what the cell's `title` keeps, so the sheet's own wording is still one
   hover away. Trimming the DATA would be a different change with a wider blast radius: the
   server's vocabulary is what the sheet, the CSV export and every count already agree on. */
function oltIncidentLabel_(status) {
  var s = String(status || '').trim().toUpperCase();
  /* DOWN is retained exactly as it arrives, prefix or not: it is the one status whose label is
     already the whole story under this header, and the only one the instruction named as
     retained. The other three lose the prefix and keep everything that distinguishes them. */
  if (s === 'DOWN' || s === 'OLT DOWN') return s;
  return s.replace(/^OLT\s+/, '');
}

function renderOltTable() {
  const tbody = document.getElementById('oltTableBody');
  if (!tbody) return;
  const healthyPanel = healthyPanel_();
  const toolbar = document.querySelector('#tab-olt .filter-toolbar');
  const issuesCard = document.getElementById('oltIssuesTableCard');
  const exportToolbar = document.querySelector('#tab-olt .export-toolbar');
  if (healthyPanel) healthyPanel.hidden = true;
  if (toolbar) toolbar.hidden = false;
  if (issuesCard) issuesCard.hidden = false;
  if (exportToolbar) exportToolbar.hidden = false;
  let tableHtml = '';

  const filtered = rawOltData.filter(item => {
    const st = (item.S || item.STATUS || '').toString().trim().toUpperCase();
    /* Active Incidents is every row the server sends: shape=3 already carries only problem
       rows, so "not UP" is the honest test — and it stays correct if a legacy full-row
       payload ever reaches this function. */
    if (currentOltFilter === 'ACTIVE') return st !== 'UP';
    if (currentOltFilter === 'DOWN') return st === 'DOWN';
    if (currentOltFilter === 'LOW POWER') return st.includes('LOW POWER');
    if (currentOltFilter === 'UPLINK DOWN') return st.includes('UPLINK DOWN');
    if (currentOltFilter === 'DEGRADATION') return st.includes('DEGRADATION');
    if (currentOltFilter === 'UP') return st === 'UP' || st === 'NORMAL' || st === 'OK';
    return true;
  });

  /* The export toolbar and the freshness chip are duties of THIS FUNCTION, not of its
     table. Both used to be its last lines — after the early return for an empty result —
     so the one screen whose honesty matters most, "nothing is down", was the screen whose
     "Data as of" age never moved and whose export toolbar was never built. They moved
     above the branch rather than into both arms of it: two copies of a decision is how an
     empty path and a filled path drift apart.

     Still above the branch — but the bar now LEAVES when the table has nothing in it. Two
     greyed-out buttons over a card that says there is nothing to report are a control the
     operator cannot use, spending the height the card needs, and this function is the only
     place that knows both facts at once. The buttons stay muted as well as hidden, so the
     bar is never one reveal away from exporting a header line. */
  const exportBar = setupOltExportToolbar_();
  setOltExportEnabled_(filtered.length !== 0);
  if (window.fetchGate) fetchGate.refreshTicker('olt');

  if (filtered.length === 0) {
    if (exportBar) exportBar.hidden = true;
    showOltEmptyState_(currentOltFilter);
    return;
  }

  hideOltEmptyState_();

  filtered.forEach(item => {
    const _s = typeof sanitizeHTML === 'function' ? sanitizeHTML : (v => v);
    const province = _s(item.P || item.PROVINCE || '-');
    const municipality = _s(item.M || item.MUNICIPALITY || '-');
    const name = _s(item.N || item.OLT_NAME || '-');
    const status = (item.S || item.STATUS || 'UP').toString().toUpperCase();
    const ticketNo = _s(item.T || '-');
    const downtimeCause = _s(item.DC || '-');
    const aging = _s(item.AG || item.AGING || '-');
    const clientsAffectedNum = parseInt(item.CA || 0) || 0;
    const clientsAffectedDisplay = clientsAffectedNum > 0
      ? `<strong style="color: var(--badge-red-text);">${clientsAffectedNum}</strong>`
      : `<span style="color: var(--text-muted);">–</span>`;

    /* Ticket-level IMPACT, from OLT DOWN Tickets column K. SA = service affecting, so it
       takes the red badge; NSA is the ordinary case and wears the quiet gray one; anything
       else that is not blank is printed as-is. A payload built by a server that does not
       send `IM` yet renders the same muted dash this table already uses for an empty CLIENTS
       cell — an absence, never a confident zero.

       Both badges share one fixed box (`.status-chip.is-impact`), because "SA" and "NSA" are
       one character apart: a chip sized to its own text re-centres on every row whose ticket
       type changes, and the column breathes with it. The dash stays outside the box — it is
       the absence of an answer, not a value that needs to line up with one. */
    const impact = _s(item.IM || '').toString().trim().toUpperCase();
    const impactDisplay = impact === 'SA'
      ? `<span class="badge badge-red status-chip is-impact">SA</span>`
      : impact
        ? `<span class="badge badge-gray status-chip is-impact">${impact}</span>`
        : `<span style="color: var(--text-muted);">–</span>`;
    const remarks = _s(item.RM || item.REMARKS || '-');

    let badgeType = 'green';
    if (status === 'DOWN') badgeType = 'red';
    else if (status.includes('LOW POWER')) badgeType = 'orange';
    else if (status.includes('UPLINK DOWN')) badgeType = 'yellow';
    else if (status.includes('DEGRADATION')) badgeType = 'purple';

    const causeColor = getCauseColor(downtimeCause);
    const causeDisplay = downtimeCause && downtimeCause !== '-'
      ? `<span class="dt-cause-badge" style="--cause-color: ${causeColor.color}; --cause-bg: ${causeColor.bg};">${downtimeCause}</span>`
      : `<span class="dt-cause-badge is-empty">–</span>`;

    /* The cell shows the trimmed label under an INCIDENT header; `title` keeps the status the
       sheet actually reports, so the tooltip is the record and the cell is the reading. Quotes
       are escaped on the way into the attribute, the same way the onclick parameters below
       are. */
    const statusLabel = oltIncidentLabel_(status);
    const statusTitle = _s(status).replace(/"/g, '&quot;');

    const alertClass = getAlertClass('clientsDown', clientsAffectedNum);
    const safeRemarks = remarks.replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n').replace(/\r/g, '');
    const onclickStr = `openOltModal('${_s(name).replace(/'/g, "\'")}', '${_s(province).replace(/'/g, "\'")}', '${_s(municipality).replace(/'/g, "\'")}', '${status}', '${_s(ticketNo).replace(/'/g, "\'")}', '${_s(downtimeCause).replace(/'/g, "\'")}', '${_s(aging).replace(/'/g, "\'")}', '${safeRemarks}', ${clientsAffectedNum})`;
    tableHtml += `<tr class="clickable-row ${alertClass}" onclick="${onclickStr}">
      <td data-label="Province">${province}</td>
      <td data-label="Municipality">${municipality}</td>
      <td data-label="OLT Name"><strong>${name}</strong></td>
      <td data-label="Affected Clients" style="text-align: center;">${clientsAffectedDisplay}</td>
      <td data-label="Impact" style="text-align: center;">${impactDisplay}</td>
      <td data-label="DT Cause" style="text-align: center;">${causeDisplay}</td>
      <td data-label="Aging" style="text-align: center;">${aging}</td>
      <td data-label="Incident" style="text-align: center;"><span class="badge badge-${badgeType} status-chip is-long" title="${statusTitle}">${statusLabel}</span></td>
    </tr>`;
  });

  tableHtml += `<tr class="total-row">
    <td colspan="7">FILTERED TOTAL (${oltFilterLabel_()})</td>
    <td style="text-align: center;">${filtered.length}</td>
  </tr>`;

  tbody.innerHTML = tableHtml;
}

function openOltModal(name, province, municipality, status, ticketNo, downtimeCause, aging, remarks, clientsAffected) {
  document.getElementById('mOltName').textContent = name;
  document.getElementById('mProvince').textContent = province;
  document.getElementById('mMunicipality').textContent = municipality;
  document.getElementById('mStatus').textContent = status;
  document.getElementById('mTicket').textContent = ticketNo;
  document.getElementById('mDowntimeCause').textContent = downtimeCause || '-';
  document.getElementById('mAging').textContent = aging || '-';
  document.getElementById('mRemarks').textContent = (remarks || '-').replace(new RegExp(String.fromCharCode(92) + 'n', 'g'), String.fromCharCode(10)).replace(new RegExp(String.fromCharCode(92) + 'r', 'g'), '');
  document.getElementById('mClientsAffected').textContent = clientsAffected || '0';

  document.getElementById('oltModal').classList.add('open');
}

function closeOltModal(event) {
  if (!event || event.target.id === 'oltModal' || event.target.className === 'close-btn') {
    document.getElementById('oltModal').classList.remove('open');
  }
}
