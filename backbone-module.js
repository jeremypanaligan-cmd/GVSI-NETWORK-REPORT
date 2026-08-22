// ====================== BACKBONE LINKS MODULE ======================

// Helper: Transform Service Type (DWDM -> "DWDM", NPE -> "MPLS")
function transformBbService(raw) {
  const s = (raw || '').toString().trim().toUpperCase();
  if (s === 'NPE') return 'MPLS';
  return s || '-';
}

// Fetcher: Backbone Links Data
async function fetchBackboneData(forceRefresh = false) {
  if (!forceRefresh && dataCache.backbone) {
    if (Array.isArray(dataCache.backbone) && dataCache.backbone.length > 0) {
      renderBackboneReport(dataCache.backbone);
    } else {
      renderBackboneEmptyState();
    }
    return;
  }

  const loader = document.getElementById('loader');
  if (loader && !forceRefresh) loader.classList.remove('hidden');

  try {
    const response = await fetch(BASE_API_URL + "?type=backbone");
    const data = await response.json();

    if (Array.isArray(data) && data.length > 0) {
      dataCache.backbone = data;
      renderBackboneReport(data);
    } else {
      dataCache.backbone = [];
      renderBackboneEmptyState();
    }
  } catch (error) {
    console.error('Error fetching BACKBONE data:', error);
    renderBackboneEmptyState();
  } finally {
    if (loader) loader.classList.add('hidden');
  }
}

// Renderer: Backbone Report Table + Stat Cards
function renderBackboneReport(data) {
  const bbTab = document.getElementById('tab-backbone');
  if (!bbTab) return;

  if (!data || !Array.isArray(data) || data.length === 0) {
    renderBackboneEmptyState();
    return;
  }

  // --- STAT CARD CALCULATIONS ---
  let totalLinks = 0;
  let dwdmLowPower = 0, dwdmLinkDown = 0;
  let mplsLowPower = 0, mplsLinkDown = 0;

  data.forEach(item => {
    const service = transformBbService(item.S);
    const issue = (item.IS || '').toString().trim().toUpperCase();
    const count = parseInt(item.LC || 0) || 0;
    totalLinks += count;

    if (service === 'DWDM') {
      if (issue.includes('LOW POWER')) dwdmLowPower++;
      else if (issue.includes('LINK DOWN')) dwdmLinkDown++;
    } else if (service === 'MPLS') {
      if (issue.includes('LOW POWER')) mplsLowPower++;
      else if (issue.includes('LINK DOWN')) mplsLinkDown++;
    }
  });

  // --- BUILD HTML ---
  let tableHtml = `
    <div class="page-title-row">
      <div class="page-title">Backbone Links Status</div>
    </div>

    <!-- STAT CARDS -->
    <div class="bb-stats-grid">
      <div class="stat-card c-total">
        <div class="label">TOTAL LINKS AFF.</div>
        <div class="value">${totalLinks}</div>
      </div>
      <div class="stat-card c-yellow">
        <div class="label">DWDM LOW POWER</div>
        <div class="value">${dwdmLowPower}</div>
      </div>
      <div class="stat-card c-red">
        <div class="label">DWDM LINK DOWN</div>
        <div class="value">${dwdmLinkDown}</div>
      </div>
      <div class="stat-card c-orange">
        <div class="label">MPLS LOW POWER</div>
        <div class="value">${mplsLowPower}</div>
      </div>
      <div class="stat-card c-purple">
        <div class="label">MPLS LINK DOWN</div>
        <div class="value">${mplsLinkDown}</div>
      </div>
    </div>

    <!-- DATA TABLE -->
    <div class="table-card">
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th class="sortable" onclick="sortTable('backboneTableBody', 0, this)">PROVINCE</th>
              <th class="sortable" onclick="sortTable('backboneTableBody', 1, this)">LINKS AFF.</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('backboneTableBody', 2, this)">SERVICE</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('backboneTableBody', 3, this, true)">NO. OF LINKS</th>
              <th class="sortable" onclick="sortTable('backboneTableBody', 4, this)">IMPACT</th>
              <th class="sortable" style="text-align: center;" onclick="sortTable('backboneTableBody', 5, this)">AGING</th>
            </tr>
          </thead>
          <tbody id="backboneTableBody">
  `;

  data.forEach(item => {
    const province = item.P || '-';
    const service = transformBbService(item.S);
    const rawLinks = item.L || '';
    const countLinks = parseInt(item.LC || 0) || 0;
    const impact = item.I || '-';
    const downtime = item.DT || '-';
    const ticketNo = item.T || '-';
    const aging = item.AG || '-';
    const remarks = item.RM || '-';

    // I-render ang links bilang chips (kagaya ng NODE > Affected Equipments)
    const linkChips = rawLinks.split(',')
      .map(link => link.trim())
      .filter(link => link !== '')
      .map(link => `<span class="link-chip">${link}</span>`)
      .join('');

    // Ligtas na pag-escape para sa onclick parameters
    const safeProvince = province.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeTicket = ticketNo.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeService = service.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeImpact = impact.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeDowntime = downtime.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeAging = aging.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    const safeRemarks = remarks.replace(/'/g, "\\'").replace(/"/g, '&quot;').replace(/\n/g, '\\n').replace(/\r/g, '');
    const safeLinks = rawLinks.replace(/'/g, "\\'").replace(/"/g, '&quot;');

    // Badge color para sa service type
    const serviceBadge = service === 'DWDM' ? 'purple' : (service === 'MPLS' ? 'orange' : 'gray');

    tableHtml += `
      <tr class="clickable-row" onclick="openBackboneModal('${safeProvince}', '${safeTicket}', '${safeService}', '${safeImpact}', '${safeDowntime}', '${safeAging}', '${safeLinks}', '${safeRemarks}')">
        <td data-label="Province"><strong>${province}</strong></td>
        <td data-label="Links Aff.">
          <div class="link-chip-container">
            ${linkChips || '<span style="color: var(--text-muted);">-</span>'}
          </div>
        </td>
        <td data-label="Service" style="text-align: center;"><span class="badge badge-${serviceBadge}">${service}</span></td>
        <td data-label="No. of Links" style="text-align: center;"><span class="badge badge-orange">${countLinks}</span></td>
        <td data-label="Impact">${impact}</td>
        <td data-label="Aging" style="text-align: center; color: var(--badge-orange-text); font-weight: 700;">${aging}</td>
      </tr>
    `;
  });

  // TOTAL ROW - naka-align sa AGING column (colspan=5)
  tableHtml += `
            <tr class="total-row">
              <td colspan="5" data-label="Summary">TOTAL LINKS AFFECTED</td>
              <td data-label="Total Count" style="text-align: center; font-weight: 800; color: var(--primary-teal); font-size: 15px;">${totalLinks}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  bbTab.innerHTML = tableHtml;
}

// Empty State / Landing Page: Kapag walang active backbone incidents
function renderBackboneEmptyState() {
  const bbTab = document.getElementById('tab-backbone');
  if (!bbTab) return;

  bbTab.innerHTML = `
    <div class="page-title-row">
      <div class="page-title">Backbone Links Status</div>
    </div>

    <!-- STAT CARDS - Zero State -->
    <div class="bb-stats-grid">
      <div class="stat-card c-total">
        <div class="label">TOTAL LINKS AFF.</div>
        <div class="value">0</div>
      </div>
      <div class="stat-card c-yellow">
        <div class="label">DWDM LOW POWER</div>
        <div class="value">0</div>
      </div>
      <div class="stat-card c-red">
        <div class="label">DWDM LINK DOWN</div>
        <div class="value">0</div>
      </div>
      <div class="stat-card c-orange">
        <div class="label">MPLS LOW POWER</div>
        <div class="value">0</div>
      </div>
      <div class="stat-card c-purple">
        <div class="label">MPLS LINK DOWN</div>
        <div class="value">0</div>
      </div>
    </div>

    <!-- LANDING PAGE -->
    <div style="
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 12px;
      padding: 48px 24px;
      text-align: center;
      margin-top: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.03);
      transition: background-color 0.3s ease, border-color 0.3s ease;
    ">
      <!-- Success Icon -->
      <div style="
        width: 80px; height: 80px;
        margin: 0 auto 20px;
        border-radius: 50%;
        background: var(--badge-green);
        display: flex; align-items: center; justify-content: center;
      ">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--badge-green-text)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
      </div>

      <h2 style="
        color: var(--badge-green-text);
        font-size: 20px;
        font-weight: 800;
        margin-bottom: 8px;
      ">All Backbone Links Operational</h2>

      <p style="
        font-size: 14px;
        color: var(--text-muted);
        max-width: 440px;
        margin: 0 auto 24px;
        line-height: 1.6;
      ">
        There are currently no pending backbone link incidents for rectification and restoration. All DWDM and MPLS links are fully operational across all monitored regions.
      </p>

      <!-- Status Indicators -->
      <div style="
        display: flex;
        justify-content: center;
        gap: 20px;
        flex-wrap: wrap;
      ">
        <div style="
          display: flex; align-items: center; gap: 6px;
          font-size: 12px; font-weight: 700; color: var(--badge-green-text);
        ">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--badge-green-text); display: inline-block;"></span>
          DWDM — Operational
        </div>
        <div style="
          display: flex; align-items: center; gap: 6px;
          font-size: 12px; font-weight: 700; color: var(--badge-green-text);
        ">
          <span style="width: 8px; height: 8px; border-radius: 50%; background: var(--badge-green-text); display: inline-block;"></span>
          MPLS — Operational
        </div>
      </div>

      <!-- Last Checked -->
      <div style="
        margin-top: 20px;
        font-size: 11px;
        color: var(--text-muted);
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      ">
        Last checked: ${new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  `;
}

// Modal: Open Backbone Link Details
function openBackboneModal(province, ticket, service, impact, downtime, aging, links, remarks) {
  document.getElementById('bbProvince').textContent = province || '-';
  document.getElementById('bbTicket').textContent = ticket || '-';
  document.getElementById('bbService').textContent = service || '-';
  document.getElementById('bbImpact').textContent = impact || '-';
  document.getElementById('bbDowntime').textContent = downtime || '-';
  document.getElementById('bbAging').textContent = aging || '-';
  document.getElementById('bbRemarks').textContent = remarks || '-';

  // Render links as chips (ready for multiple comma-separated links)
  const linksContainer = document.getElementById('bbLinks');
  if (linksContainer) {
    if (links && links.trim() !== '' && links.trim() !== '-') {
      const linkList = links.split(',').map(l => l.trim()).filter(l => l !== '');
      linksContainer.innerHTML = linkList.map(l => `<span class="link-chip">${l}</span>`).join('');
    } else {
      linksContainer.innerHTML = '<span style="color: var(--text-muted);">-</span>';
    }
  }

  document.getElementById('backboneModal').classList.add('open');
}

// Modal: Close Backbone Link Details
function closeBackboneModal(event) {
  if (!event || event.target.id === 'backboneModal' || event.target.className === 'close-btn') {
    document.getElementById('backboneModal').classList.remove('open');
  }
}
