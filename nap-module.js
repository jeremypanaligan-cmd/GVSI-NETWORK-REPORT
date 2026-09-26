// ====================== NAP MODULE ======================

/* Whether this tab has ever drawn a report. Held HERE rather than read back out of dataCache,
   because every refresh EMPTIES dataCache first so the next read goes to the network
   (refreshCurrentTab / backgroundRefresh) — which is why a failed refresh used to have nothing
   left to draw and fell through to its error row, blanking a table that was on screen a second
   earlier. LCP and OLT already answer a failed read this way (their catch only logs); this is
   the same rule, written down. */
let napHasDrawn = false;

async function fetchNapData(forceRefresh = false) {
  // Show cached data instantly (no skeleton)
  if (!forceRefresh && dataCache.nap) {
    renderNapReport(dataCache.nap);
    // Still fetch fresh data in background (deduped + throttled by the shared gate)
    fetchGate.fetchQueued('nap', BASE_API_URL + "?type=nap", data => {
      if (data) { dataCache.nap = data; renderNapReport(data); }
    });
    return;
  }

  // Keep the existing dashboard shell visible underneath the executive loading state.
  showModuleLoading('nap');

  try {
    const data = await fetchGate.run('nap', BASE_API_URL + "?type=nap");

    if (Array.isArray(data) && data.length > 0) {
      dataCache.nap = data;
      renderNapReport(data);
      prefetchOtherTabsInBackground();
    } else {
      document.getElementById('napTableBody').innerHTML = '<tr><td colspan="6" style="text-align:center;">No data found.</td></tr>';
    }
  } catch (error) {
    console.error('Error fetching NAP data:', error);
    /* A refresh that failed keeps what is already drawn: those rows are the last read that DID
       answer, and they are still the best thing anyone has. Overwriting them with an error line
       threw them away and made the tab read as if the report itself were empty. Only a tab that
       has never drawn anything has nothing to keep — and only then is this row the honest
       screen. */
    if (!napHasDrawn) {
      document.getElementById('napTableBody').innerHTML = '<tr><td colspan="6" style="text-align:center; color:red;">Error loading data.</td></tr>';
    }
  } finally {
    hideModuleLoading('nap');
    hideLoader();
    _isInitialLoad = false;
  }
}

function renderNapReport(data) {
  hideModuleLoading('nap');
  const tbody = document.getElementById('napTableBody');
  if (!tbody) return;
  let tableHtml = '';

  let total24 = 0, total13 = 0, total3 = 0, grandTotal = 0;
  /* How many rows this draw actually put on the table. It decides the TOTAL line below: a
     TOTAL of zeros over no rows is not a summary, it is a line of zeros a reader will take
     for a count. */
  let drawnRows = 0;

  data.forEach(row => {
    const area = typeof sanitizeHTML === 'function' ? sanitizeHTML(row.A || row.AREA || row.Area || '') : (row.A || row.AREA || row.Area || '');
    const provinceRaw = row.P || row.PROVINCE || row.Province || '';
    const province = typeof sanitizeHTML === 'function' ? sanitizeHTML(provinceRaw.toString().replace(/_/g, ' ')) : provinceRaw.toString().replace(/_/g, ' ');

    const h24 = parseInt(row.H || row['<24HOURS'] || 0) || 0;
    const d13 = parseInt(row.D1 || row['1-3 DAYS'] || 0) || 0;
    const d3 = parseInt(row.D3 || row['>3DAYS'] || 0) || 0;
    const rowTotal = parseInt(row.T || row.TOTAL || (h24 + d13 + d3)) || 0;

    /* A row whose figures are ALL zero is not a row of this report. The sheet band behind it
       is fixed (code.gs reads A2:F19), so every area row arrives whether or not anything is
       pending on it — an area with nothing on it simply reads back 0/0/0/0, and drawing that
       put a line of zeros under AREA/PROVINCE that reads like a count instead of a blank.

       The guard is on the COMPUTED rowTotal, never on row.T: a zero or blank TOTAL cell is
       already replaced above by the sum of the components, so a row left blank there while
       still carrying 24-hour counts stays a row of this report. */
    if (area.toString().trim().toUpperCase() !== 'TOTAL' && rowTotal !== 0) {
      drawnRows++;
      total24 += h24;
      total13 += d13;
      total3 += d3;
      grandTotal += rowTotal;

      tableHtml += `<tr>
        <td data-label="Area"><strong>${area}</strong></td>
        <td data-label="Province">${province}</td>
        <td data-label="(<24HOURS)" style="text-align: center;">${getBadgeHtml(h24, 'green')}</td>
        <td data-label="(1-3 DAYS)" style="text-align: center;">${getBadgeHtml(d13, 'yellow')}</td>
        <td data-label="(>3DAYS)" style="text-align: center;">${getBadgeHtml(d3, 'red')}</td>
        <td data-label="Total" style="text-align: center;"><strong>${rowTotal}</strong></td>
      </tr>`;
    }
  });

  if (drawnRows === 0) {
    /* Every row was a row of zeros, so there is nothing to report — and that is worth saying
       in words rather than leaving an empty table. The TOTAL line is no substitute for it:
       every figure under it would be zero anyway. */
    tableHtml = '<tr><td colspan="6" class="table-empty-row">No Pending NAP Ticket.</td></tr>';
  } else {
    tableHtml += `<tr class="total-row">
      <td colspan="2">TOTAL</td>
      <td style="text-align: center;">${total24}</td>
      <td style="text-align: center;">${total13}</td>
      <td style="text-align: center;">${total3}</td>
      <td style="text-align: center;">${grandTotal}</td>
    </tr>`;
  }

  tbody.innerHTML = tableHtml;
  napHasDrawn = true;

  if (document.getElementById('card24')) document.getElementById('card24').textContent = total24;
  if (document.getElementById('card13')) document.getElementById('card13').textContent = total13;
  if (document.getElementById('card3')) document.getElementById('card3').textContent = total3;
  if (document.getElementById('cardTotal')) document.getElementById('cardTotal').textContent = grandTotal;

  // Add export toolbar
  const napTab = document.getElementById('tab-nap');
  if (napTab && !napTab.querySelector('.export-toolbar')) {
    const toolbar = document.createElement('div');
    toolbar.className = 'export-toolbar';
    toolbar.innerHTML = `
      <button class="export-btn" onclick="exportTableToCSV('napTableBody', 'NAP_Report')">
        ${iconMarkup('download', { size: 14 })}
        Export CSV
      </button>
      <button class="export-btn" onclick="exportTabToPDF('tab-nap', 'NAP_Report')">
        ${iconMarkup('file-text', { size: 14 })}
        Export PDF
      </button>
    `;
    const tableCard = napTab.querySelector('.table-card');
    if (tableCard) tableCard.parentNode.insertBefore(toolbar, tableCard);
  }

  if (window.fetchGate) fetchGate.refreshTicker('nap');
}
