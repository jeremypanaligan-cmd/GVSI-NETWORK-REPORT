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

async function fetchOltData(forceRefresh = false) {
  if (!forceRefresh && dataCache.olt) {
    rawOltData = dataCache.olt;
    processAndRenderOlt();
    // Deduped + throttled background refresh via the shared gate
    fetchGate.fetchQueued('olt', BASE_API_URL + "?type=olt&shape=3", data => {
      if (data && data.meta) {
        dataCache.olt = decodeOltCompact(data);
        oltMeta = data.meta;
      } else if (Array.isArray(data) && data.length > 0) {
        dataCache.olt = data;
        oltMeta = null;
      }
      rawOltData = dataCache.olt;
      processAndRenderOlt();
    });
    return;
  }

  // Keep the existing dashboard shell visible underneath the executive loading state.
  showModuleLoading('olt');

  try {
    const data = await fetchGate.run('olt', BASE_API_URL + "?type=olt&shape=3");

    if (data && data.meta) {
      dataCache.olt = decodeOltCompact(data);
      oltMeta = data.meta;
    } else if (Array.isArray(data) && data.length > 0) {
      dataCache.olt = data;
      oltMeta = null;
    }
    rawOltData = dataCache.olt;
    if (rawOltData && rawOltData.length > 0) {
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
  renderOltTable();

  // Kiosk derives its own presentation, but expose the normalized aggregation
  // for the regular dashboard and future consumers without changing the API.
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
