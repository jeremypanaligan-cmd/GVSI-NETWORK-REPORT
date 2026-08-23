// Data cache para sa Node module

async function fetchNodeData(forceRefresh = false) {
  if (!forceRefresh && dataCache.node) {
    if (Array.isArray(dataCache.node) && dataCache.node.length > 0) {
      renderNodeReport(dataCache.node);
    } else {
      renderNodeEmptyState();
    }
    fetchWithRetry(BASE_API_URL + "?type=node")
      .then(data => {
        if (Array.isArray(data) && data.length > 0) { dataCache.node = data; renderNodeReport(data); }
        else { dataCache.node = []; renderNodeEmptyState(); }
      })
      .catch(() => {});
    return;
  }

  // Show skeleton on first load
  if (!dataCache.node) showSkeleton('node');

  try {
    const data = await fetchWithRetry(BASE_API_URL + "?type=node");

    if (Array.isArray(data) && data.length > 0) {
      dataCache.node = data;
      renderNodeReport(data);
    } else {
      dataCache.node = [];
      renderNodeEmptyState();
    }
  } catch (error) {
    console.error('Error fetching NODE data:', error);
    renderNodeEmptyState();
  }
}

function renderNodeReport(data) {
  const nodeTab = document.getElementById('tab-node');
  if (!nodeTab) return;

  // SAFETY CHECK: Kapag walang laman ang data, ipakita agad ang empty state
  if (!data || !Array.isArray(data) || data.length === 0) {
    renderNodeEmptyState();
    return;
  }

  let tableHtml = `
    <div class="page-title-row">
      <div class="page-title">NODE Status Report</div>
    </div>
    <div class="table-card">
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th class="sortable" onclick="sortTable('nodeTableBody', 0, this)">PROVINCE</th>
              <th class="sortable" onclick="sortTable('nodeTableBody', 1, this)">AFFECTED NODES</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('nodeTableBody', 2, this, true)">COUNT</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('nodeTableBody', 3, this)">IMPACT</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('nodeTableBody', 4, this)">DOWNTIME</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('nodeTableBody', 5, this, false, true)">AGING</th>
            </tr>
          </thead>
          <tbody id="nodeTableBody">
  `;

  let totalCount = 0;

  data.forEach(item => {
    const province = item.P || '-';
    const rawNodes = item.N || '';
    const count = parseInt(item.C || 0) || 0;
    const impact = item.I || '-';
    const downtime = item.D || '-';
    const aging = item.AG || '-';

    // Dagdagan ang total count sa bawat row
    totalCount += count;

    // Kunin ang Ticket at Remarks mula sa Google Sheets API payload
    const ticketNo = item.T || item.TICKET || '-';
    const remarks = item.RM || item.REMARKS || '-';

    const nodeBadges = rawNodes.split(',')
      .map(node => node.trim())
      .filter(node => node !== '')
      .map(node => `<span class="node-chip">${typeof sanitizeHTML === 'function' ? sanitizeHTML(node) : node}</span>`)
      .join('');

    // Ligtas na pag-escape para sa String parameters sa onclick event
    const safeProvince = province.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeTicket = ticketNo.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeBadges = nodeBadges.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeRemarks = remarks.replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n').replace(/\r/g, '');

    tableHtml += `
      <tr class="clickable-row" onclick="openNodeModal('${safeProvince}', '${safeTicket}', '${safeBadges}', '${safeRemarks}')">
        <td data-label="Province"><strong>${province}</strong></td>
        <td data-label="Affected Nodes">
          <div class="node-chip-container">
            ${nodeBadges || '-'}
          </div>
        </td>
        <td data-label="Count" style="text-align: center;"><span class="badge badge-purple">${count}</span></td>
        <td data-label="Impact" style="text-align: center;"><span class="badge badge-red">${impact}</span></td>
        <td data-label="Downtime" style="text-align: center;">${downtime}</td>
        <td data-label="Aging" style="text-align: center; color: var(--badge-orange-text); font-weight: 700;">${aging}</td>
      </tr>
    `;
  });

  tableHtml += `
            <tr class="total-row">
              <td colspan="2" data-label="Summary">TOTAL AFFECTED EQUIPMENT</td>
              <td data-label="Total Count" style="text-align: center;">${totalCount}</td>
              <td colspan="3"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  nodeTab.innerHTML = tableHtml;

  // Add export toolbar
  if (!nodeTab.querySelector('.export-toolbar')) {
    const toolbar = document.createElement('div');
    toolbar.className = 'export-toolbar';
    toolbar.innerHTML = `
      <button class="export-btn" onclick="exportTableToCSV('nodeTableBody', 'Node_Report')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Export CSV
      </button>
      <button class="export-btn" onclick="exportTabToPDF('tab-node', 'Node_Report')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        Export PDF
      </button>
    `;
    const tableCard = nodeTab.querySelector('.table-card');
    if (tableCard) tableCard.parentNode.insertBefore(toolbar, tableCard);
  }
}

function renderNodeEmptyState() {
  const nodeTab = document.getElementById('tab-node');
  if (!nodeTab) return;

  nodeTab.innerHTML = `
    <div class="page-title-row">
      <div class="page-title">NODE Status Report</div>
    </div>
    <div class="placeholder-card" style="padding: 40px 20px;">
      <div style="margin-bottom: 12px; color: var(--primary-teal);">
        <svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          <path d="M9 12l2 2 4-4"></path>
        </svg>
      </div>
      <h3 style="color: var(--primary-teal); font-size: 18px; margin-bottom: 6px;">All Node Systems Operational</h3>
      <p style="font-size: 13px; color: var(--text-muted); max-width: 400px; margin: 0 auto;">
        There are currently no active node down incidents reported across all monitored regions.
      </p>
    </div>
  `;
}