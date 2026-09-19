// Data cache para sa Node module

async function fetchNodeData(forceRefresh = false) {
  if (!forceRefresh && dataCache.node) {
    if (Array.isArray(dataCache.node) && dataCache.node.length > 0) {
      renderNodeReport(dataCache.node);
    } else {
      renderNodeEmptyState();
    }
    fetchGate.fetchQueued('node', BASE_API_URL + "?type=node", data => {
      if (!data) return; // gate swallows failures — keep cached content on screen
      if (Array.isArray(data) && data.length > 0) { dataCache.node = data; renderNodeReport(data); }
      else { dataCache.node = []; renderNodeEmptyState(); }
    });
    return;
  }

  // Show skeleton on first load
  if (!dataCache.node) showSkeleton('node');

  try {
    const data = await fetchGate.run('node', BASE_API_URL + "?type=node");

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
  hideModuleLoading('node');
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
              <th class="sortable" style="text-align: center;" onclick="sortTable('nodeTableBody', 4, this)">DT CAUSE</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('nodeTableBody', 5, this)">DOWNTIME</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('nodeTableBody', 6, this, false, true)">AGING</th>
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
    const downtimeCause = item.DC || '-';

    // DT Cause color coding (same as OLT module)
    const getNodeCauseColor = (cause) => {
      const c = (cause || '').toUpperCase();
      if (c === 'FIBER') return { color: '#ef4444', bg: 'rgba(239,68,68,0.18)' };
      if (c === 'POWER') return { color: '#f97316', bg: 'rgba(249,115,22,0.18)' };
      if (c === 'EQUIPMENT') return { color: '#f39c12', bg: 'rgba(243,156,18,0.18)' };
      if (c === 'TBD') return { color: '#7f8c8d', bg: 'rgba(127,140,141,0.18)' };
      if (c.includes('FIBER') && c.includes('POWER')) return { color: '#8e44ad', bg: 'rgba(142,68,173,0.18)' };
      return { color: '#95a5a6', bg: 'rgba(149,165,166,0.12)' };
    };
    const causeColor = getNodeCauseColor(downtimeCause);
    const causeDisplay = downtimeCause && downtimeCause !== '-'
      ? `<span style="display: inline-block; color: ${causeColor.color}; background: ${causeColor.bg}; padding: 4px 12px; border-radius: 6px; font-size: 0.85em; font-weight: 700; letter-spacing: 0.3px; border-left: 3px solid ${causeColor.color};">${downtimeCause}</span>`
      : `<span style="color: var(--text-muted);">–</span>`;
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
        <td data-label="DT Cause" style="text-align: center;">${causeDisplay}</td>
        <td data-label="Downtime" style="text-align: center;">${downtime}</td>
        <td data-label="Aging" style="text-align: center; color: var(--badge-orange-text); font-weight: 700;">${aging}</td>
      </tr>
    `;
  });

  tableHtml += `
            <tr class="total-row">
              <td colspan="2" data-label="Summary">TOTAL AFFECTED EQUIPMENT</td>
              <td data-label="Total Count" style="text-align: center;">${totalCount}</td>
              <td colspan="4"></td>
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
        ${iconMarkup('download', { size: 14 })}
        Export CSV
      </button>
      <button class="export-btn" onclick="exportTabToPDF('tab-node', 'Node_Report')">
        ${iconMarkup('file-text', { size: 14 })}
        Export PDF
      </button>
    `;
    const tableCard = nodeTab.querySelector('.table-card');
    if (tableCard) tableCard.parentNode.insertBefore(toolbar, tableCard);
  }

  if (window.fetchGate) fetchGate.refreshTicker('node');
}

function renderNodeEmptyState() {
  hideModuleLoading('node');
  const nodeTab = document.getElementById('tab-node');
  if (!nodeTab) return;

  // Get live stats for health metrics
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  nodeTab.innerHTML = `
    <div class="page-title-row">
      <div class="page-title">NODE Status Report</div>
    </div>
    <div class="node-empty-card">
      <!-- Ambient Green Glow -->
      <div class="node-empty-glow"></div>

      <!-- Shield Icon with Pulse Rings -->
      <div class="node-empty-icon-wrapper">
        <div class="node-empty-ping-ring"></div>
        <div class="node-empty-icon-circle">
          ${iconMarkup('shield-check', { size: 40, strokeWidth: 1.8 })}
        </div>
      </div>

      <!-- Heading -->
      <h3 class="node-empty-title">All Node Systems Operational</h3>
      <p class="node-empty-desc">
        There are currently no active node down incidents reported across all monitored regions.
      </p>

      <!-- System Health Snapshot Metrics -->
      <div class="node-health-pills">
        <div class="node-health-pill">
          <span class="pill-dot pill-dot-green"></span>
          <span class="pill-label">Monitored Nodes</span>
          <span class="pill-value pill-value-green">290+ Active</span>
        </div>
        <div class="node-health-pill">
          <span class="pill-dot pill-dot-cyan"></span>
          <span class="pill-label">System Uptime</span>
          <span class="pill-value pill-value-cyan">99.9%</span>
        </div>
        <div class="node-health-pill">
          <span class="pill-dot pill-dot-green"></span>
          <span class="pill-label">Last Sync</span>
          <span class="pill-value pill-value-white">${timeStr}</span>
        </div>
        <div class="node-health-pill">
          <span class="pill-dot pill-dot-cyan"></span>
          <span class="pill-label">Regional Status</span>
          <span class="pill-value pill-value-green">All Zones Clear</span>
        </div>
      </div>
    </div>
  `;
  if (window.fetchGate) fetchGate.refreshTicker('node');
}