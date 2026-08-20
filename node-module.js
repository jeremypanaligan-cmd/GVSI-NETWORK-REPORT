// Data cache para sa Node module

async function fetchNodeData(forceRefresh = false) {
  // Kung may cache at may laman, i-render ang report
  if (!forceRefresh && dataCache.node) {
    if (Array.isArray(dataCache.node) && dataCache.node.length > 0) {
      renderNodeReport(dataCache.node);
    } else {
      renderNodeEmptyState();
    }
    return;
  }

  const loader = document.getElementById('loader');
  if (loader && !forceRefresh) loader.classList.remove('hidden');

  try {
    const response = await fetch(BASE_API_URL + "?type=node");
    const data = await response.json();

    if (Array.isArray(data) && data.length > 0) {
      dataCache.node = data;
      renderNodeReport(data);
    } else {
      dataCache.node = []; // I-save bilang empty array
      renderNodeEmptyState();
    }
  } catch (error) {
    console.error('Error fetching NODE data:', error);
    renderNodeEmptyState();
  } finally {
    if (loader) loader.classList.add('hidden');
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
              <th class="sortable" style="text-align: center;" onclick="sortTable('nodeTableBody', 5, this)">AGING</th>
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
      .map(node => `<span class="node-chip">${node}</span>`)
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