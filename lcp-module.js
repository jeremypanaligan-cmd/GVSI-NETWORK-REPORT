// ====================== LCP MODULE ======================

async function fetchLcpData(forceRefresh = false) {
  if (!forceRefresh && dataCache.lcp) {
    renderLcpReport(dataCache.lcp.lcpAging, dataCache.lcp.lcpImpact);
    fetchWithRetry(BASE_API_URL + "?type=lcp")
      .then(data => { if (data && data.lcpAging) { dataCache.lcp = data; renderLcpReport(data.lcpAging, data.lcpImpact || []); } })
      .catch(() => {});
    return;
  }

  try {
    const data = await fetchWithRetry(BASE_API_URL + "?type=lcp");

    if (data && data.lcpAging) {
      dataCache.lcp = data;
      renderLcpReport(data.lcpAging, data.lcpImpact || []);
    }
  } catch (error) {
    console.error('Error fetching LCP data:', error);
  }
}

function renderLcpReport(agingData, impactData) {
  const agingBody = document.getElementById('lcpAgingTableBody');
  if (!agingBody) return;
  agingBody.innerHTML = '';

  let total24 = 0, total13 = 0, total3 = 0, grandTotal = 0;

  agingData.forEach(row => {
    const area = row.A || row.AREA || '';
    const provinceRaw = row.P || row.PROVINCE || '';
    const province = provinceRaw.toString().replace(/_/g, ' ');

    const h24 = parseInt(row.H || row['<24HOURS'] || 0) || 0;
    const d13 = parseInt(row.D1 || row['1-3 DAYS'] || 0) || 0;
    const d3 = parseInt(row.D3 || row['>3DAYS'] || 0) || 0;
    const rowTotal = parseInt(row.T || row.TOTAL || (h24 + d13 + d3)) || 0;

    if (area.toString().trim().toUpperCase() !== 'TOTAL') {
      total24 += h24;
      total13 += d13;
      total3 += d3;
      grandTotal += rowTotal;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Area"><strong>${area}</strong></td>
        <td data-label="Province">${province}</td>
        <td data-label="(<24HOURS)" style="text-align: center;">${getBadgeHtml(h24, 'green')}</td>
        <td data-label="(1-3 DAYS)" style="text-align: center;">${getBadgeHtml(d13, 'yellow')}</td>
        <td data-label="(>3DAYS)" style="text-align: center;">${getBadgeHtml(d3, 'red')}</td>
        <td data-label="Total" style="text-align: center;"><strong>${rowTotal}</strong></td>
      `;
      agingBody.appendChild(tr);
    }
  });

  if (document.getElementById('lcpCard24')) document.getElementById('lcpCard24').textContent = total24;
  if (document.getElementById('lcpCard13')) document.getElementById('lcpCard13').textContent = total13;
  if (document.getElementById('lcpCard3')) document.getElementById('lcpCard3').textContent = total3;

  const agingTotalTr = document.createElement('tr');
  agingTotalTr.className = 'total-row';
  agingTotalTr.innerHTML = `
    <td colspan="2">TOTAL</td>
    <td style="text-align: center;">${total24}</td>
    <td style="text-align: center;">${total13}</td>
    <td style="text-align: center;">${total3}</td>
    <td style="text-align: center;">${grandTotal}</td>
  `;
  agingBody.appendChild(agingTotalTr);

  const impactBody = document.getElementById('lcpImpactTableBody');
  if (!impactBody) return;
  impactBody.innerHTML = '';

  let totalTT = 0, totalLCP = 0, totalClients = 0;

  impactData.forEach(row => {
    const area = row.A || row.AREA || '';
    const provinceRaw = row.P || row.PROVINCE || '';
    const province = provinceRaw.toString().replace(/_/g, ' ');

    const ttCount = parseInt(row.TT || row['TT COUNT'] || 0) || 0;
    const lcpCount = parseInt(row.LCP || row['LCP COUNT'] || 0) || 0;
    const clients = parseInt(row.C || row.CLIENTS || 0) || 0;

    if (area.toString().trim().toUpperCase() !== 'TOTAL') {
      totalTT += ttCount;
      totalLCP += lcpCount;
      totalClients += clients;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="Area"><strong>${area}</strong></td>
        <td data-label="Province">${province}</td>
        <td data-label="TT Count" style="text-align: center;">${ttCount}</td>
        <td data-label="LCP Count" style="text-align: center;">${lcpCount}</td>
        <td data-label="Clients" style="text-align: center; color: var(--primary-teal); font-weight: 700;">${clients}</td>
      `;
      impactBody.appendChild(tr);
    }
  });

  if (document.getElementById('lcpCardClients')) document.getElementById('lcpCardClients').textContent = totalClients;
  if (document.getElementById('lcpCardTT')) document.getElementById('lcpCardTT').textContent = totalTT;
  if (document.getElementById('lcpCardLCP')) document.getElementById('lcpCardLCP').textContent = totalLCP;

  if (impactData.length > 0) {
    const impactTotalTr = document.createElement('tr');
    impactTotalTr.className = 'total-row';
    impactTotalTr.innerHTML = `
      <td colspan="2">TOTAL</td>
      <td style="text-align: center;">${totalTT}</td>
      <td style="text-align: center;">${totalLCP}</td>
      <td style="text-align: center; color: var(--primary-teal);">${totalClients}</td>
    `;
    impactBody.appendChild(impactTotalTr);
  }

  // Add export toolbar
  const lcpTab = document.getElementById('tab-lcp');
  if (lcpTab && !lcpTab.querySelector('.export-toolbar')) {
    const toolbar = document.createElement('div');
    toolbar.className = 'export-toolbar';
    toolbar.innerHTML = `
      <button class="export-btn" onclick="exportTableToCSV('lcpAgingTableBody', 'LCP_Aging_Report')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export CSV
      </button>
    `;
    const agingCard = lcpTab.querySelector('.table-card');
    if (agingCard) agingCard.parentNode.insertBefore(toolbar, agingCard);
  }
}
