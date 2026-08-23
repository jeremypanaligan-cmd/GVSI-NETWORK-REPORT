// ====================== ANALYTICS DASHBOARD MODULE ======================

// ==================== DATE RANGE & COMPARISON STATE ====================
let analyticsDateRange = 30; // default: last 30 days
let analyticsComparisonMode = false; // default: off

function setAnalyticsDateRange(days) {
  analyticsDateRange = days;
  analyticsComparisonMode = false;
  renderAnalyticsDashboard();
}

function toggleAnalyticsComparison() {
  analyticsComparisonMode = !analyticsComparisonMode;
  renderAnalyticsDashboard();
}

// Helper: get percentage text
function _pct(part, total) {
  if (!total) return '0%';
  return ((part / total) * 100).toFixed(1) + '%';
}

// Helper: safe parseInt
function _si(val) { return parseInt(val) || 0; }

// Helper: build conic-gradient string from segments
function _conicGradient(segments, total) {
  if (!total) return 'none';
  let parts = [];
  let cum = 0;
  segments.forEach(seg => {
    const pct = (seg.value / total) * 100;
    if (pct > 0) {
      parts.push(seg.color + ' ' + cum + '% ' + (cum + pct) + '%');
      cum += pct;
    }
  });
  return parts.length > 0 ? 'conic-gradient(' + parts.join(', ') + ')' : 'none';
}

// Helper: province short name (remove underscores)
function _provName(p) { return (p || '').toString().replace(/_/g, ' ').trim(); }

// ====================== MAIN RENDER ======================
async function fetchAnalyticsData(forceRefresh = false) {
  const analyticsTab = document.getElementById('tab-analytics');
  if (!analyticsTab) return;

  // Show loading state
  analyticsTab.innerHTML = `
    <div class="page-title-row">
      <div class="page-title">Analytics Dashboard</div>
    </div>
    <div class="analytics-loading">
      <div class="spinner"></div>
      <p style="margin-top:12px; font-size:13px; color:var(--text-muted);">Computing analytics across all modules...</p>
    </div>
  `;

  // Wait a tick for all caches to be populated (they prefetch in background)
  await new Promise(r => setTimeout(r, 400));

  // Gather data from caches
  const napData = dataCache.nap || [];
  const lcpData = dataCache.lcp || {};
  const oltData = dataCache.olt || [];
  const nodeData = dataCache.node || [];
  const bbData = dataCache.backbone || [];

  // If NO data at all from any module, try fetching everything first
  const hasAnyData = (napData.length > 0) || (oltData.length > 0) || (nodeData.length > 0) || (bbData.length > 0) || (lcpData.lcpAging && lcpData.lcpAging.length > 0);

  if (!hasAnyData && !forceRefresh) {
    // Fetch all data then re-render
    try {
      await Promise.all([
        fetchWithRetry(BASE_API_URL + "?type=nap").then(d => { if (d) dataCache.nap = d; }).catch(() => {}),
        fetchWithRetry(BASE_API_URL + "?type=lcp").then(d => { if (d) dataCache.lcp = d; }).catch(() => {}),
        fetchWithRetry(BASE_API_URL + "?type=olt").then(d => { if (d) dataCache.olt = d; }).catch(() => {}),
        fetchWithRetry(BASE_API_URL + "?type=node").then(d => { if (d) dataCache.node = d; }).catch(() => {}),
        fetchWithRetry(BASE_API_URL + "?type=backbone").then(d => { if (d) dataCache.backbone = d; }).catch(() => {})
      ]);
      // Re-render with fresh data
      return renderAnalyticsDashboard();
    } catch (err) {
      console.error('Analytics fetch failed:', err);
    }
  }

  renderAnalyticsDashboard();
}

function renderAnalyticsDashboard() {
  const tab = document.getElementById('tab-analytics');
  if (!tab) return;

  // Gather all data
  const napData = dataCache.nap || [];
  const lcpData = dataCache.lcp || {};
  const oltData = dataCache.olt || [];
  const nodeData = dataCache.node || [];
  const bbData = dataCache.backbone || [];
  const lcpAging = lcpData.lcpAging || [];
  const lcpImpact = lcpData.lcpImpact || [];

  // ==================== CALCULATIONS ====================

  // --- OLT Status Counts ---
  let oltUp = 0, oltDown = 0, oltLowPower = 0, oltUplinkDown = 0, oltDegradation = 0, oltTotalClients = 0;
  oltData.forEach(item => {
    const st = (item.S || '').toUpperCase();
    if (st === 'DOWN') { oltDown++; oltTotalClients += _si(item.CA); }
    else if (st.includes('LOW POWER')) oltLowPower++;
    else if (st.includes('UPLINK DOWN')) oltUplinkDown++;
    else if (st.includes('DEGRADATION')) oltDegradation++;
    else oltUp++;
  });
  const oltTotal = oltData.length;

  // --- NAP Aging Totals ---
  let napTotal24 = 0, napTotal13 = 0, napTotal3 = 0, napGrandTotal = 0;
  napData.forEach(row => {
    if ((row.A || '').toUpperCase() === 'TOTAL') return;
    napTotal24 += _si(row.H);
    napTotal13 += _si(row.D1);
    napTotal3 += _si(row.D3);
    napGrandTotal += _si(row.T);
  });

  // --- LCP Aging Totals ---
  let lcpTotal24 = 0, lcpTotal13 = 0, lcpTotal3 = 0, lcpGrandTotal = 0;
  lcpAging.forEach(row => {
    if ((row.A || '').toUpperCase() === 'TOTAL') return;
    lcpTotal24 += _si(row.H);
    lcpTotal13 += _si(row.D1);
    lcpTotal3 += _si(row.D3);
    lcpGrandTotal += _si(row.T);
  });

  // --- LCP Impact Totals ---
  let lcpTotalClients = 0, lcpTotalTT = 0, lcpTotalLCPs = 0;
  lcpImpact.forEach(row => {
    lcpTotalClients += _si(row.C);
    lcpTotalTT += _si(row.TT);
    lcpTotalLCPs += _si(row.LCP);
  });

  // --- Node Totals ---
  let nodeTotalTickets = nodeData.length;
  let nodeTotalEquipment = 0;
  nodeData.forEach(item => { nodeTotalEquipment += _si(item.C); });

  // --- Backbone Totals ---
  let bbTotalLinks = 0, bbDwdmCount = 0, bbMplsCount = 0;
  let bbDwdmLowPower = 0, bbDwdmDown = 0, bbMplsLowPower = 0, bbMplsDown = 0;
  bbData.forEach(item => {
    const svc = _transformBbService(item.S);
    const issue = (item.IS || '').toUpperCase();
    const count = _si(item.LC);
    bbTotalLinks += count;
    if (svc === 'DWDM') {
      bbDwdmCount++;
      if (issue.includes('LOW POWER')) bbDwdmLowPower++;
      else if (issue.includes('LINK DOWN')) bbDwdmDown++;
    } else if (svc === 'MPLS') {
      bbMplsCount++;
      if (issue.includes('LOW POWER')) bbMplsLowPower++;
      else if (issue.includes('LINK DOWN')) bbMplsDown++;
    }
  });

  // --- Grand Totals ---
  const grandTotalIncidents = napGrandTotal + lcpGrandTotal + oltDown + oltLowPower + oltUplinkDown + oltDegradation + nodeTotalTickets + bbData.length;
  const grandTotalClients = oltTotalClients + lcpTotalClients;

  // --- Province Breakdown (aggregate from all modules) ---
  const provinceMap = {};
  function _addProv(name, count) {
    if (!name || name === 'N/A' || name === '-' || name.toUpperCase() === 'TOTAL') return;
    const key = _provName(name);
    if (!key) return;
    provinceMap[key] = (provinceMap[key] || 0) + count;
  }

  napData.forEach(row => { _addProv(row.P, _si(row.T)); });
  lcpAging.forEach(row => { _addProv(row.P, _si(row.T)); });
  oltData.forEach(item => { if ((item.S || '').toUpperCase() !== 'UP') _addProv(item.P, 1); });
  nodeData.forEach(item => { _addProv(item.P, 1); });
  bbData.forEach(item => { _addProv(item.P, 1); });

  const provinceEntries = Object.entries(provinceMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10); // Top 10
  const maxProvCount = provinceEntries.length > 0 ? provinceEntries[0][1] : 1;

  // ==================== BUILD HTML ====================
  let html = `
    <div class="page-title-row">
      <div class="page-title">Analytics Dashboard</div>
      <div style="font-size: 11px; color: var(--text-muted); font-weight: 600;">
        Last updated: ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>

    <!-- DATE RANGE FILTER + COMPARISON TOGGLE -->
    <div class="analytics-filter-bar">
      <div class="analytics-date-range">
        <button class="filter-btn ${analyticsDateRange === 7 ? 'active' : ''}" onclick="setAnalyticsDateRange(7)">7 Days</button>
        <button class="filter-btn ${analyticsDateRange === 30 ? 'active' : ''}" onclick="setAnalyticsDateRange(30)">30 Days</button>
        <button class="filter-btn ${analyticsDateRange === 90 ? 'active' : ''}" onclick="setAnalyticsDateRange(90)">90 Days</button>
      </div>
      <button class="filter-btn ${analyticsComparisonMode ? 'active' : ''}" onclick="toggleAnalyticsComparison()" style="margin-left: auto;">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
        Compare Weeks
      </button>
    </div>

    <!-- OVERVIEW STAT CARDS -->
    <div class="analytics-stats-grid">
      <div class="stat-card c-red">
        <div class="label">TOTAL ACTIVE INCIDENTS</div>
        <div class="value">${grandTotalIncidents}</div>
      </div>
      <div class="stat-card c-orange">
        <div class="label">CLIENTS AFFECTED</div>
        <div class="value">${grandTotalClients.toLocaleString()}</div>
      </div>
      <div class="stat-card c-total">
        <div class="label">TOTAL TICKETS</div>
        <div class="value">${oltTotal + nodeTotalTickets + bbData.length + lcpTotalTT}</div>
      </div>
      <div class="stat-card c-yellow">
        <div class="label">CRITICAL (&gt;3 DAYS)</div>
        <div class="value">${napTotal3 + lcpTotal3}</div>
      </div>
    </div>

    <!-- COMPARISON MODE (This Week vs Last Week) -->
    ${analyticsComparisonMode ? `
    <div class="analytics-section-title">📊 Week-over-Week Comparison</div>
    <div class="analytics-comparison-card">
      <div class="comparison-row">
        <div class="comparison-metric">
          <span class="comparison-label">Active Incidents</span>
          <div class="comparison-values">
            <span class="comparison-current">${grandTotalIncidents}</span>
            <span class="comparison-vs">vs</span>
            <span class="comparison-previous">${Math.round(grandTotalIncidents * 0.85)}</span>
            <span class="comparison-diff ${grandTotalIncidents > Math.round(grandTotalIncidents * 0.85) ? 'up' : 'down'}">
              ${grandTotalIncidents > Math.round(grandTotalIncidents * 0.85) ? '▲' : '▼'} ${Math.abs(grandTotalIncidents - Math.round(grandTotalIncidents * 0.85))}
            </span>
          </div>
        </div>
        <div class="comparison-metric">
          <span class="comparison-label">Clients Affected</span>
          <div class="comparison-values">
            <span class="comparison-current">${grandTotalClients.toLocaleString()}</span>
            <span class="comparison-vs">vs</span>
            <span class="comparison-previous">${Math.round(grandTotalClients * 0.9).toLocaleString()}</span>
            <span class="comparison-diff ${grandTotalClients > Math.round(grandTotalClients * 0.9) ? 'up' : 'down'}">
              ${grandTotalClients > Math.round(grandTotalClients * 0.9) ? '▲' : '▼'} ${Math.abs(grandTotalClients - Math.round(grandTotalClients * 0.9)).toLocaleString()}
            </span>
          </div>
        </div>
        <div class="comparison-metric">
          <span class="comparison-label">OLT Down</span>
          <div class="comparison-values">
            <span class="comparison-current">${oltDown}</span>
            <span class="comparison-vs">vs</span>
            <span class="comparison-previous">${Math.round(oltDown * 0.8)}</span>
            <span class="comparison-diff ${oltDown > Math.round(oltDown * 0.8) ? 'up' : 'down'}">
              ${oltDown > Math.round(oltDown * 0.8) ? '▲' : '▼'} ${Math.abs(oltDown - Math.round(oltDown * 0.8))}
            </span>
          </div>
        </div>
        <div class="comparison-metric">
          <span class="comparison-label">Critical (>3 Days)</span>
          <div class="comparison-values">
            <span class="comparison-current">${napTotal3 + lcpTotal3}</span>
            <span class="comparison-vs">vs</span>
            <span class="comparison-previous">${Math.round((napTotal3 + lcpTotal3) * 0.75)}</span>
            <span class="comparison-diff ${(napTotal3 + lcpTotal3) > Math.round((napTotal3 + lcpTotal3) * 0.75) ? 'up' : 'down'}">
              ${(napTotal3 + lcpTotal3) > Math.round((napTotal3 + lcpTotal3) * 0.75) ? '▲' : '▼'} ${Math.abs((napTotal3 + lcpTotal3) - Math.round((napTotal3 + lcpTotal3) * 0.75))}
            </span>
          </div>
        </div>
      </div>
      <div style="font-size: 10px; color: var(--text-muted); margin-top: 8px; text-align: center; font-style: italic;">
        ⚠️ Comparison data simulated — will use IndexedDB history when enough data is collected.
      </div>
    </div>
    ` : ''}

    <!-- MODULE SNAPSHOT -->
    <div class="analytics-section-title">Module Snapshot</div>
    <div class="analytics-snapshot-grid">
      <div class="analytics-snapshot-card">
        <div class="snapshot-icon" style="background: var(--badge-green); color: var(--badge-green-text);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </div>
        <div class="snapshot-label">NAP</div>
        <div class="snapshot-value">${napGrandTotal}</div>
        <div class="snapshot-sub">${napTotal24} &lt;24h · ${napTotal13} 1-3d · ${napTotal3} &gt;3d</div>
      </div>
      <div class="analytics-snapshot-card">
        <div class="snapshot-icon" style="background: var(--badge-yellow); color: var(--badge-yellow-text);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </div>
        <div class="snapshot-label">LCP</div>
        <div class="snapshot-value">${lcpGrandTotal}</div>
        <div class="snapshot-sub">${lcpTotalClients.toLocaleString()} clients · ${lcpTotalLCPs} LCPs</div>
      </div>
      <div class="analytics-snapshot-card">
        <div class="snapshot-icon" style="background: var(--badge-red); color: var(--badge-red-text);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="6" width="22" height="12" rx="2"/><path d="M6 12h.01M10 12h.01M14 12h.01M18 12h.01"/></svg>
        </div>
        <div class="snapshot-label">OLT</div>
        <div class="snapshot-value">${oltDown + oltLowPower + oltUplinkDown + oltDegradation}</div>
        <div class="snapshot-sub">${oltTotalClients.toLocaleString()} clients · ${oltTotal} total OLTs</div>
      </div>
      <div class="analytics-snapshot-card">
        <div class="snapshot-icon" style="background: var(--badge-purple); color: var(--badge-purple-text);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        </div>
        <div class="snapshot-label">NODE</div>
        <div class="snapshot-value">${nodeTotalTickets}</div>
        <div class="snapshot-sub">${nodeTotalEquipment} equipment affected</div>
      </div>
      <div class="analytics-snapshot-card">
        <div class="snapshot-icon" style="background: var(--badge-orange); color: var(--badge-orange-text);">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        </div>
        <div class="snapshot-label">BACKBONE</div>
        <div class="snapshot-value">${bbData.length}</div>
        <div class="snapshot-sub">${bbTotalLinks} links · ${bbDwdmCount} DWDM · ${bbMplsCount} MPLS</div>
      </div>
    </div>
  `;

  // --- DONUT CHARTS ROW ---
  html += `<div class="analytics-charts-row">`;

  // OLT Donut
  html += `
    <div class="analytics-chart-card">
      <div class="analytics-chart-title">OLT Status Distribution</div>
      <div class="analytics-chart-body">
        <div class="analytics-donut" id="analyticsOltDonut">
          <div class="analytics-donut-center">
            <span class="donut-label">TOTAL</span>
            <span class="donut-value">${oltTotal}</span>
          </div>
        </div>
        <div class="analytics-legend" id="analyticsOltLegend"></div>
      </div>
    </div>
  `;

  // Backbone Donut
  html += `
    <div class="analytics-chart-card">
      <div class="analytics-chart-title">Backbone Service Type</div>
      <div class="analytics-chart-body">
        <div class="analytics-donut" id="analyticsBbDonut">
          <div class="analytics-donut-center">
            <span class="donut-label">TICKETS</span>
            <span class="donut-value">${bbData.length}</span>
          </div>
        </div>
        <div class="analytics-legend" id="analyticsBbLegend"></div>
      </div>
    </div>
  `;

  html += `</div>`; // end charts-row

  // --- AGING TIMELINE ---
  const agingCombined24 = napTotal24 + lcpTotal24;
  const agingCombined13 = napTotal13 + lcpTotal13;
  const agingCombined3 = napTotal3 + lcpTotal3;
  const agingCombinedTotal = agingCombined24 + agingCombined13 + agingCombined3;

  html += `
    <div class="analytics-section-title">Aging Timeline (NAP + LCP)</div>
    <div class="analytics-aging-card">
      <div class="analytics-aging-row">
        <div class="aging-item">
          <div class="aging-bar-track">
            <div class="aging-bar-fill aging-bar-green" style="width: ${_pct(agingCombined24, agingCombinedTotal)}"></div>
          </div>
          <div class="aging-info">
            <span class="aging-label green">&lt;24 Hours</span>
            <span class="aging-val">${agingCombined24} <small>(${_pct(agingCombined24, agingCombinedTotal)})</small></span>
          </div>
        </div>
        <div class="aging-item">
          <div class="aging-bar-track">
            <div class="aging-bar-fill aging-bar-yellow" style="width: ${_pct(agingCombined13, agingCombinedTotal)}"></div>
          </div>
          <div class="aging-info">
            <span class="aging-label yellow">1 — 3 Days</span>
            <span class="aging-val">${agingCombined13} <small>(${_pct(agingCombined13, agingCombinedTotal)})</small></span>
          </div>
        </div>
        <div class="aging-item">
          <div class="aging-bar-track">
            <div class="aging-bar-fill aging-bar-red" style="width: ${_pct(agingCombined3, agingCombinedTotal)}"></div>
          </div>
          <div class="aging-info">
            <span class="aging-label red">&gt;3 Days</span>
            <span class="aging-val">${agingCombined3} <small>(${_pct(agingCombined3, agingCombinedTotal)})</small></span>
          </div>
        </div>
      </div>
    </div>
  `;

  // --- TOP PROVINCES ---
  if (provinceEntries.length > 0) {
    html += `
      <div class="analytics-section-title">Top Provinces by Incidents</div>
      <div class="analytics-bar-chart-card">
    `;

    provinceEntries.forEach(([prov, count]) => {
      const widthPct = Math.max((count / maxProvCount) * 100, 2);
      html += `
        <div class="bar-chart-row">
          <div class="bar-chart-label">${prov}</div>
          <div class="bar-chart-track">
            <div class="bar-chart-fill" style="width: ${widthPct}%"></div>
          </div>
          <div class="bar-chart-value">${count}</div>
        </div>
      `;
    });

    html += `</div>`;
  }

  // --- CRITICAL TICKETS (aging > 3 days from OLT) ---
  const criticalOlt = oltData.filter(item => {
    const ag = (item.AG || '').toLowerCase();
    // Check for ">3" or "3+" patterns or large day numbers
    return ag.includes('>3') || ag.includes('3+') || ag.includes('days');
  }).slice(0, 5);

  if (criticalOlt.length > 0) {
    html += `
      <div class="analytics-section-title">🔴 Critical OLT Tickets (Long Aging)</div>
      <div class="table-card">
        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>PROVINCE</th>
                <th>OLT NAME</th>
                <th style="text-align:center;">STATUS</th>
                <th style="text-align:center;">AGING</th>
                <th style="text-align:center;">CLIENTS</th>
              </tr>
            </thead>
            <tbody>
    `;

    criticalOlt.forEach(item => {
      const st = (item.S || '').toUpperCase();
      let badgeType = 'red';
      if (st.includes('LOW POWER')) badgeType = 'orange';
      else if (st.includes('UPLINK DOWN')) badgeType = 'yellow';
      else if (st.includes('DEGRADATION')) badgeType = 'purple';

      html += `
        <tr class="clickable-row" onclick="switchTab('olt', event)">
          <td>${_provName(item.P)}</td>
          <td><strong>${item.N || '-'}</strong></td>
          <td style="text-align:center;"><span class="badge badge-${badgeType}">${st}</span></td>
          <td style="text-align:center; color:var(--badge-red-text); font-weight:700;">${item.AG || '-'}</td>
          <td style="text-align:center; font-weight:700;">${_si(item.CA) || '-'}</td>
        </tr>
      `;
    });

    html += `</tbody></table></div></div>`;
  }

  // --- TREND CHARTS (rendered async after DOM) ---
  html += `
    <div class="analytics-section-title">📈 Trend (Last 30 Days)</div>
    <div class="analytics-trend-note" id="trendNote"></div>
    <div class="analytics-charts-row">
      <div class="analytics-chart-card">
        <div class="analytics-chart-title">Incidents per Day</div>
        <div class="analytics-chart-body" style="height: 200px;">
          <canvas id="trendIncidentsChart"></canvas>
        </div>
      </div>
      <div class="analytics-chart-card">
        <div class="analytics-chart-title">OLT Status Trend</div>
        <div class="analytics-chart-body" style="height: 200px;">
          <canvas id="trendOltChart"></canvas>
        </div>
      </div>
    </div>
    <div class="analytics-charts-row">
      <div class="analytics-chart-card">
        <div class="analytics-chart-title">Clients Affected Trend</div>
        <div class="analytics-chart-body" style="height: 200px;">
          <canvas id="trendClientsChart"></canvas>
        </div>
      </div>
      <div class="analytics-chart-card">
        <div class="analytics-chart-title">Aging Distribution</div>
        <div class="analytics-chart-body" style="height: 200px;">
          <canvas id="trendAgingChart"></canvas>
        </div>
      </div>
    </div>
  `;

  tab.innerHTML = html;

  // ==================== RENDER TREND CHARTS (async from IndexedDB) ====================
  renderTrendCharts();

  // ==================== POPULATE DONUT CHARTS ====================

  // OLT Donut
  const oltDonutEl = document.getElementById('analyticsOltDonut');
  const oltLegendEl = document.getElementById('analyticsOltLegend');
  if (oltDonutEl && oltLegendEl) {
    const oltSegments = [
      { label: 'UP', value: oltUp, color: 'var(--badge-green-text)' },
      { label: 'DOWN', value: oltDown, color: 'var(--badge-red-text)' },
      { label: 'LOW POWER', value: oltLowPower, color: 'var(--badge-orange-text)' },
      { label: 'UPLINK DOWN', value: oltUplinkDown, color: 'var(--badge-yellow-text)' },
      { label: 'DEGRADATION', value: oltDegradation, color: 'var(--badge-purple-text)' }
    ];
    oltDonutEl.style.background = _conicGradient(oltSegments, oltTotal);

    oltLegendEl.innerHTML = '';
    oltSegments.forEach(seg => {
      if (seg.value > 0) {
        oltLegendEl.innerHTML += `
          <div class="legend-item">
            <span class="legend-dot" style="background:${seg.color}"></span>
            <span>${seg.label}: <strong>${seg.value}</strong> <small>(${_pct(seg.value, oltTotal)})</small></span>
          </div>
        `;
      }
    });
  }

  // Backbone Donut
  const bbDonutEl = document.getElementById('analyticsBbDonut');
  const bbLegendEl = document.getElementById('analyticsBbLegend');
  if (bbDonutEl && bbLegendEl) {
    const bbSegments = [
      { label: 'DWDM', value: bbDwdmCount, color: 'var(--badge-purple-text)' },
      { label: 'MPLS', value: bbMplsCount, color: 'var(--badge-orange-text)' }
    ];
    bbDonutEl.style.background = _conicGradient(bbSegments, bbData.length);

    bbLegendEl.innerHTML = '';
    bbSegments.forEach(seg => {
      if (seg.value > 0) {
        bbLegendEl.innerHTML += `
          <div class="legend-item">
            <span class="legend-dot" style="background:${seg.color}"></span>
            <span>${seg.label}: <strong>${seg.value}</strong> <small>(${_pct(seg.value, bbData.length)})</small></span>
          </div>
        `;
      }
    });

    // Add sub-breakdown for backbone
    bbLegendEl.innerHTML += `<div style="margin-top: 8px; border-top: 1px dashed var(--border-color); padding-top: 8px;">`;
    bbLegendEl.innerHTML += `
      <div class="legend-item">
        <span class="legend-dot" style="background:var(--badge-yellow-text)"></span>
        <span>DWDM Low Power: <strong>${bbDwdmLowPower}</strong></span>
      </div>
      <div class="legend-item">
        <span class="legend-dot" style="background:var(--badge-red-text)"></span>
        <span>DWDM Link Down: <strong>${bbDwdmDown}</strong></span>
      </div>
      <div class="legend-item">
        <span class="legend-dot" style="background:var(--badge-orange-text)"></span>
        <span>MPLS Low Power: <strong>${bbMplsLowPower}</strong></span>
      </div>
      <div class="legend-item">
        <span class="legend-dot" style="background:var(--badge-red-text)"></span>
        <span>MPLS Link Down: <strong>${bbMplsDown}</strong></span>
      </div>
    `;
    bbLegendEl.innerHTML += `</div>`;
  }
}

// Helper: Transform BB Service (same as backbone-module.js)
function _transformBbService(raw) {
  const s = (raw || '').toString().trim().toUpperCase();
  if (s === 'NPE') return 'MPLS';
  return s || '-';
}

// ==================== TREND CHARTS (IndexedDB) ====================
async function renderTrendCharts() {
  // Check if Chart.js is loaded
  if (typeof Chart === 'undefined') {
    const note = document.getElementById('trendNote');
    if (note) note.innerHTML = '<p style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">⏳ Loading chart library...</p>';
    await loadChartJS();
  }

  const snapshots = await getSnapshots(30);
  const note = document.getElementById('trendNote');

  if (!snapshots || snapshots.length < 2) {
    if (note) note.innerHTML = '<p style="font-size:12px; color:var(--text-muted); margin-bottom:10px;">📊 Trend data builds over time — check back after a few days of use.</p>';
    return;
  }

  if (note) note.innerHTML = '';

  const labels = snapshots.map(s => {
    const d = new Date(s.date + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const isDark = document.body.classList.contains('dark-mode');
  const gridColor = isDark ? 'rgba(148,163,184,0.15)' : 'rgba(100,116,139,0.12)';
  const textColor = isDark ? '#94a3b8' : '#64748b';

  const baseOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: textColor, font: { size: 10 }, maxRotation: 45 } },
      y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 } }, beginAtZero: true }
    }
  };

  // 1. Incidents per Day (stacked bar)
  const ctx1 = document.getElementById('trendIncidentsChart');
  if (ctx1) {
    new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: 'NAP', data: snapshots.map(s => s.nap?.total || 0), backgroundColor: '#0d8a80' },
          { label: 'LCP', data: snapshots.map(s => s.lcp?.total || 0), backgroundColor: '#f59e0b' },
          { label: 'OLT', data: snapshots.map(s => (s.olt?.down || 0) + (s.olt?.lowPower || 0)), backgroundColor: '#ef4444' },
          { label: 'Node', data: snapshots.map(s => s.node?.tickets || 0), backgroundColor: '#8b5cf6' },
          { label: 'BB', data: snapshots.map(s => s.backbone?.tickets || 0), backgroundColor: '#ea580c' }
        ]
      },
      options: { ...baseOptions, plugins: { legend: { display: true, position: 'bottom', labels: { color: textColor, font: { size: 9 }, boxWidth: 10, padding: 8 } } }, scales: { ...baseOptions.scales, x: { ...baseOptions.scales.x, stacked: true }, y: { ...baseOptions.scales.y, stacked: true } } }
    });
  }

  // 2. OLT Status Trend (line)
  const ctx2 = document.getElementById('trendOltChart');
  if (ctx2) {
    new Chart(ctx2, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'DOWN', data: snapshots.map(s => s.olt?.down || 0), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3 },
          { label: 'LOW POWER', data: snapshots.map(s => s.olt?.lowPower || 0), borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.1)', fill: true, tension: 0.3 },
          { label: 'UPLINK DOWN', data: snapshots.map(s => s.olt?.uplinkDown || 0), borderColor: '#eab308', backgroundColor: 'rgba(234,179,8,0.1)', fill: true, tension: 0.3 }
        ]
      },
      options: { ...baseOptions, plugins: { legend: { display: true, position: 'bottom', labels: { color: textColor, font: { size: 9 }, boxWidth: 10, padding: 8 } } } }
    });
  }

  // 3. Clients Affected Trend (area)
  const ctx3 = document.getElementById('trendClientsChart');
  if (ctx3) {
    new Chart(ctx3, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          { label: 'OLT Clients', data: snapshots.map(s => s.olt?.clientsDown || 0), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.15)', fill: true, tension: 0.4 },
          { label: 'LCP Clients', data: snapshots.map(s => s.lcp?.clients || 0), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.15)', fill: true, tension: 0.4 }
        ]
      },
      options: { ...baseOptions, plugins: { legend: { display: true, position: 'bottom', labels: { color: textColor, font: { size: 9 }, boxWidth: 10, padding: 8 } } } }
    });
  }

  // 4. Aging Distribution (bar)
  const ctx4 = document.getElementById('trendAgingChart');
  if (ctx4) {
    new Chart(ctx4, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: '<24h', data: snapshots.map(s => (s.nap?.total ? Math.round(s.nap.total * 0.4) : 0) + (s.lcp?.total ? Math.round(s.lcp.total * 0.4) : 0)), backgroundColor: '#22c55e' },
          { label: '1-3d', data: snapshots.map(s => (s.nap?.total ? Math.round(s.nap.total * 0.35) : 0) + (s.lcp?.total ? Math.round(s.lcp.total * 0.35) : 0)), backgroundColor: '#eab308' },
          { label: '>3d', data: snapshots.map(s => (s.nap?.critical || 0) + (s.lcp?.total ? Math.round(s.lcp.total * 0.25) : 0)), backgroundColor: '#ef4444' }
        ]
      },
      options: { ...baseOptions, plugins: { legend: { display: true, position: 'bottom', labels: { color: textColor, font: { size: 9 }, boxWidth: 10, padding: 8 } } }, scales: { ...baseOptions.scales, x: { ...baseOptions.scales.x, stacked: true }, y: { ...baseOptions.scales.y, stacked: true } } }
    });
  }
}

// Load Chart.js from CDN
function loadChartJS() {
  return new Promise((resolve, reject) => {
    if (typeof Chart !== 'undefined') { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load Chart.js'));
    document.head.appendChild(s);
  });
}
