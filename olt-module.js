// ====================== OLT MODULE ======================

async function fetchOltData(forceRefresh = false) {
  if (!forceRefresh && dataCache.olt) {
    rawOltData = dataCache.olt;
    processAndRenderOlt();
    fetchWithRetry(BASE_API_URL + "?type=olt")
      .then(data => { if (Array.isArray(data) && data.length > 0) { dataCache.olt = data; rawOltData = data; processAndRenderOlt(); } })
      .catch(() => {});
    return;
  }

  try {
    const data = await fetchWithRetry(BASE_API_URL + "?type=olt");

    if (Array.isArray(data) && data.length > 0) {
      dataCache.olt = data;
      rawOltData = data;
      processAndRenderOlt();
    }
  } catch (error) {
    console.error('Error fetching OLT data:', error);
  }
}

function processAndRenderOlt() {
  let countUp = 0, countDown = 0, countLowPower = 0, countUplinkDown = 0, countDegradation = 0;
  let totalClientsDown = 0;
  let totalOlt = rawOltData.length;

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

  document.getElementById('oltCardTotal').textContent = totalOlt;
  document.getElementById('oltCardUp').textContent = countUp;
  document.getElementById('oltCardDown').textContent = countDown;
  document.getElementById('oltCardLowPower').textContent = countLowPower;
  document.getElementById('oltCardUplinkDown').textContent = countUplinkDown;
  document.getElementById('oltCardDegradation').textContent = countDegradation;
  document.getElementById('oltCardClientsDown').textContent = totalClientsDown;

  renderOltDonut(countUp, countDown, countLowPower, countUplinkDown, countDegradation, totalOlt);
  renderOltTable();
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

function renderOltTable() {
  const tbody = document.getElementById('oltTableBody');
  if (!tbody) return;
  tbody.innerHTML = '';

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
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;">No OLTs found under status: <strong>${currentOltFilter}</strong></td></tr>`;
    return;
  }

  filtered.forEach(item => {
    const province = item.P || item.PROVINCE || '-';
    const municipality = item.M || item.MUNICIPALITY || '-';
    const name = item.N || item.OLT_NAME || '-';
    const status = (item.S || item.STATUS || 'UP').toString().toUpperCase();
    const ticketNo = item.T || '-';
    const downtimeCause = item.DC || '-';
    const aging = item.AG || item.AGING || '-';
    const clientsAffectedNum = parseInt(item.CA || 0) || 0;
    const clientsAffectedDisplay = clientsAffectedNum > 0
      ? `<strong style="color: var(--badge-red-text);">${clientsAffectedNum}</strong>`
      : `<span style="color: var(--text-muted);">–</span>`;
    const remarks = item.RM || item.REMARKS || '-';

    let badgeType = 'green';
    if (status === 'DOWN') badgeType = 'red';
    else if (status.includes('LOW POWER')) badgeType = 'orange';
    else if (status.includes('UPLINK DOWN')) badgeType = 'yellow';
    else if (status.includes('DEGRADATION')) badgeType = 'purple';

    const tr = document.createElement('tr');
    tr.className = 'clickable-row';
    tr.onclick = () => openOltModal(name, province, municipality, status, ticketNo, downtimeCause, aging, remarks);
    tr.innerHTML = `
      <td data-label="Province">${province}</td>
      <td data-label="Municipality">${municipality}</td>
      <td data-label="OLT Name"><strong>${name}</strong></td>
      <td data-label="Affected Clients" style="text-align: center;">${clientsAffectedDisplay}</td>
      <td data-label="Aging" style="text-align: center;">${aging}</td>
      <td data-label="Status" style="text-align: center;"><span class="badge badge-${badgeType}">${status}</span></td>
    `;
    tbody.appendChild(tr);
  });

  const totalTr = document.createElement('tr');
  totalTr.className = 'total-row';
  totalTr.innerHTML = `
    <td colspan="5">FILTERED TOTAL (${currentOltFilter})</td>
    <td style="text-align: center;">${filtered.length}</td>
  `;
  tbody.appendChild(totalTr);

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
    `;
    const tableCard = oltTab.querySelector('.filter-toolbar');
    if (tableCard) tableCard.parentNode.insertBefore(toolbar, tableCard.nextSibling);
  }
}

function openOltModal(name, province, municipality, status, ticketNo, downtimeCause, aging, remarks) {
  document.getElementById('mOltName').textContent = name;
  document.getElementById('mProvince').textContent = province;
  document.getElementById('mMunicipality').textContent = municipality;
  document.getElementById('mStatus').textContent = status;
  document.getElementById('mTicket').textContent = ticketNo;
  document.getElementById('mDowntimeCause').textContent = downtimeCause || '-';
  document.getElementById('mAging').textContent = aging || '-';
  document.getElementById('mRemarks').textContent = remarks || '-';

  document.getElementById('oltModal').classList.add('open');
}

function closeOltModal(event) {
  if (!event || event.target.id === 'oltModal' || event.target.className === 'close-btn') {
    document.getElementById('oltModal').classList.remove('open');
  }
}
