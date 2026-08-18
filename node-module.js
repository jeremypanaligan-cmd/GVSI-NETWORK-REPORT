// Data cache para sa Node module
dataCache.node = null;

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
        <table>
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

    totalCount += count;

    // Hihiwalayin ang comma-separated string para maging visual badge tags
    const nodeBadges = rawNodes.split(',')
      .map(node => node.trim())
      .filter(node => node !== '')
      .map(node => `<span class="node-chip">${node}</span>`)
      .join('');

    tableHtml += `
      <tr>
        <td><strong>${province}</strong></td>
        <td>
          <div class="node-chip-container">
            ${nodeBadges || '-'}
          </div>
        </td>
        <td style="text-align: center;"><span class="badge badge-purple">${count}</span></td>
        <td style="text-align: center;"><span class="badge badge-red">${impact}</span></td>
        <td style="text-align: center;">${downtime}</td>
        <td style="text-align: center; color: var(--badge-orange-text); font-weight: 700;">${aging}</td>
      </tr>
    `;
  });

  tableHtml += `
            <tr class="total-row">
              <td colspan="2">TOTAL AFFECTED EQUIPMENT</td>
              <td style="text-align: center;">${totalCount}</td>
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
      <div style="font-size: 48px; margin-bottom: 12px;">🟢</div>
      <h3 style="color: var(--primary-teal); font-size: 18px; margin-bottom: 6px;">All Node Systems Operational</h3>
      <p style="font-size: 13px; color: var(--text-muted); max-width: 400px; margin: 0 auto;">
        There are currently no active node down incidents reported across all monitored regions.
      </p>
    </div>
  `;
}