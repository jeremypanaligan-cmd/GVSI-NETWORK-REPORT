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
  let totalClientsDown = 0;
  let totalOlt = rawOltData.length;

  if (oltMeta) {
    // Use precomputed meta from server (shape=3 compact response)
    countUp = oltMeta.up;
    countDown = oltMeta.down;
    countLowPower = oltMeta.lowPower;
    countUplinkDown = oltMeta.uplinkDown;
    countDegradation = oltMeta.degradation;
    totalClientsDown = oltMeta.clientsDown;
    totalOlt = oltMeta.total;
  } else {
    // Fallback: compute from data (legacy shape=1)
    rawOltData.forEach(item => {
      const status = (item.S || item.STATUS || '').toString().trim().toUpperCase();
      if (status === 'DOWN') {
        countDown++;
        totalClientsDown += parseInt(item.CA || 0) || 0;
      }
      else if (status.includes('LOW POWER')) countLowPower++;
      else if (status.includes('UPLINK DOWN')) countUplinkDown++;
      else if (status.includes('DEGRADATION')) countDegradation++;
      else countUp++;
    });
  }

  // Null-safe DOM updates
  const _el = (id) => document.getElementById(id);
  if (_el('oltCardTotal')) _el('oltCardTotal').textContent = totalOlt;
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
  if (_el('oltCardClientsDown')) _el('oltCardClientsDown').textContent = totalClientsDown;

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
    'ALL': 'btnFilterAll',
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
   while it is open. It used to keep whatever was active before — DOWN, because that
   is the overview's default — so the strip said the opposite of what was on screen.
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
  setOltFilter('DOWN');
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
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
    if (currentOltFilter === 'ALL') return true;
    if (currentOltFilter === 'DOWN') return st === 'DOWN';
    if (currentOltFilter === 'LOW POWER') return st.includes('LOW POWER');
    if (currentOltFilter === 'UPLINK DOWN') return st.includes('UPLINK DOWN');
    if (currentOltFilter === 'DEGRADATION') return st.includes('DEGRADATION');
    if (currentOltFilter === 'UP') return st === 'UP' || st === 'NORMAL' || st === 'OK';
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">No OLTs found under status: <strong>${currentOltFilter}</strong></td></tr>`;
    return;
  }

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

    const alertClass = getAlertClass('clientsDown', clientsAffectedNum);
    const safeRemarks = remarks.replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n').replace(/\r/g, '');
    const onclickStr = `openOltModal('${_s(name).replace(/'/g, "\'")}', '${_s(province).replace(/'/g, "\'")}', '${_s(municipality).replace(/'/g, "\'")}', '${status}', '${_s(ticketNo).replace(/'/g, "\'")}', '${_s(downtimeCause).replace(/'/g, "\'")}', '${_s(aging).replace(/'/g, "\'")}', '${safeRemarks}', ${clientsAffectedNum})`;
    tableHtml += `<tr class="clickable-row ${alertClass}" onclick="${onclickStr}">
      <td data-label="Province">${province}</td>
      <td data-label="Municipality">${municipality}</td>
      <td data-label="OLT Name"><strong>${name}</strong></td>
      <td data-label="Affected Clients" style="text-align: center;">${clientsAffectedDisplay}</td>
      <td data-label="DT Cause" style="text-align: center;">${causeDisplay}</td>
      <td data-label="Aging" style="text-align: center;">${aging}</td>
      <td data-label="Status" style="text-align: center;"><span class="badge badge-${badgeType}">${status}</span></td>
    </tr>`;
  });

  tableHtml += `<tr class="total-row">
    <td colspan="6">FILTERED TOTAL (${currentOltFilter})</td>
    <td style="text-align: center;">${filtered.length}</td>
  </tr>`;

  tbody.innerHTML = tableHtml;

  // Add export toolbar
  const oltTab = document.getElementById('tab-olt');
  if (oltTab && !oltTab.querySelector('.export-toolbar')) {
    const toolbar = document.createElement('div');
    toolbar.className = 'export-toolbar';
    toolbar.innerHTML = `
      <button class="export-btn" onclick="exportTableToCSV('oltTableBody', 'OLT_Report')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export CSV
      </button>
      <button class="export-btn" onclick="exportTabToPDF('tab-olt', 'OLT_Report')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        Export PDF
      </button>
    `;
    const tableCard = oltTab.querySelector('.filter-toolbar');
    if (tableCard) tableCard.parentNode.insertBefore(toolbar, tableCard.nextSibling);
  }

  if (window.fetchGate) fetchGate.refreshTicker('olt');
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
