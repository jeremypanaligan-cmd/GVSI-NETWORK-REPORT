// ====================== ADMIN MODULE ======================
// Tech admin/Dev only — Maintenance Mode

// Use window.BASE_API_URL to access the global variable defined in index.html
var ADMIN_API_URL = window.BASE_API_URL || '';

// Initialize ADMIN_API_URL when module loads
function initAdminUrl() {
  if (window.BASE_API_URL) {
    ADMIN_API_URL = window.BASE_API_URL;
  }
}

// ====================== ROLE CHECK ======================

function isAdmin() {
  // Deliberately silent. This ran on every tab change and wrote FIVE console lines
  // each time, which is how a real failure gets lost in the noise — the console is
  // the only place this app can show an API problem, so it cannot be spent on
  // "Match: true" forty times a session.
  var session = getSession();

  if (!session) return false;
  if (!session.role) return false;

  // Trim whitespace and compare exactly
  var userRole = String(session.role).trim();
  var adminRole = 'Tech admin/Dev';

  return (userRole === adminRole);
}

// ====================== RENDER ADMIN TAB ======================

function renderAdminTab() {
  // Initialize ADMIN_API_URL from global scope
  initAdminUrl();
  
  var container = document.getElementById('tab-admin');
  if (!container) return;

  container.innerHTML = `
    <div class="page-title-row">
      <div class="page-title">⚙️ Admin Panel</div>
    </div>

    <!-- MAINTENANCE MODE SECTION -->
    <div class="table-card" style="margin-bottom: 16px;">
      <div style="padding: 20px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
          ${iconMarkup('wrench', { size: 24 })}
          <div>
            <div style="font-size: 16px; font-weight: 700; color: var(--dark-charcoal);">Maintenance Mode</div>
            <div style="font-size: 12px; color: var(--text-muted);">Toggle to close the app for all users.</div>
          </div>
        </div>
        
        <div id="maintenanceStatus" style="
          display: flex; align-items: center; gap: 12px; 
          padding: 16px; border-radius: 8px; 
          background: var(--card-bg); border: 1px solid var(--border-color);
          margin-bottom: 16px;
        ">
          <div style="font-size: 13px; font-weight: 600;">Status:</div>
          <div id="maintenanceStatusBadge" style="
            padding: 4px 12px; border-radius: 12px; 
            font-size: 12px; font-weight: 700;
          ">Loading...</div>
        </div>

        <div style="display: flex; gap: 12px;">
          <button id="btnEnableMaintenance" onclick="toggleMaintenance(true)" style="
            flex: 1; padding: 12px; border: none; border-radius: 8px;
            background: var(--badge-red-text); color: white; 
            font-weight: 700; font-size: 13px; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 8px;
          ">
            ${iconMarkup('ban', { size: 16 })}
            Enable Maintenance
          </button>
          <button id="btnDisableMaintenance" onclick="toggleMaintenance(false)" style="
            flex: 1; padding: 12px; border: none; border-radius: 8px;
            background: var(--badge-green-text); color: white; 
            font-weight: 700; font-size: 13px; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 8px;
          ">
            ${iconMarkup('circle-check-big', { size: 16 })}
            Disable Maintenance
          </button>
        </div>
      </div>
    </div>

    <!-- MODULE HEALTH SECTION -->
    <div class="table-card" style="margin-bottom: 16px;">
      <div style="padding: 20px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
          ${iconMarkup('activity', { size: 24 })}
          <div>
            <div style="font-size: 16px; font-weight: 700; color: var(--dark-charcoal);">Module Health</div>
            <div style="font-size: 12px; color: var(--text-muted);">What THIS device waited on, this session. Held in memory only — nothing is stored and nothing is sent.</div>
          </div>
        </div>
        <div id="moduleHealthBody"></div>
      </div>
    </div>

  `;

  // Load initial data
  loadMaintenanceStatus();
  renderModuleHealth();
}

// ====================== MAINTENANCE MODE ======================

async function loadMaintenanceStatus() {
  try {
    var result = await fetchWithRetry(ADMIN_API_URL + '?action=getSettings');
    var statusBadge = document.getElementById('maintenanceStatusBadge');
    var btnEnable = document.getElementById('btnEnableMaintenance');
    var btnDisable = document.getElementById('btnDisableMaintenance');
    
    if (!statusBadge) return;

    if (result && result.maintenance === true) {
      statusBadge.textContent = '🔴 ACTIVE';
      statusBadge.style.background = 'var(--badge-red-bg)';
      statusBadge.style.color = 'var(--badge-red-text)';
      if (btnEnable) btnEnable.disabled = true;
      if (btnDisable) btnDisable.disabled = false;
    } else {
      statusBadge.textContent = '🟢 INACTIVE';
      statusBadge.style.background = 'var(--badge-green-bg)';
      statusBadge.style.color = 'var(--badge-green-text)';
      if (btnEnable) btnEnable.disabled = false;
      if (btnDisable) btnDisable.disabled = true;
    }
  } catch (err) {
    console.error('[Admin] Failed to load maintenance status:', err);
  }
}

async function toggleMaintenance(enable) {
  var confirmMsg = enable 
    ? '⚠️ Enable Maintenance Mode?\n\nAll users will be unable to access the app except you.'
    : '✅ Disable Maintenance Mode?\n\nAll users will be able to access the app again.';

  if (!confirm(confirmMsg)) return;

  try {
    var session = getSession();
    var result = await fetchWithRetry(
      ADMIN_API_URL + '?action=setMaintenance&enabled=' + enable + '&admin=' + encodeURIComponent(session.username)
    );
    
    if (result && result.success) {
      showToast(enable ? 'Maintenance Mode ENABLED 🔴' : 'Maintenance Mode DISABLED 🟢', enable ? 'warning' : 'success');
      loadMaintenanceStatus();
    } else {
      showToast('Failed to update maintenance mode', 'error');
    }
  } catch (err) {
    console.error('[Admin] Toggle maintenance error:', err);
    showToast('Connection error', 'error');
  }
}

// ====================== MAINTENANCE PAGE (shown to locked-out users) ======================

function showMaintenancePage() {
  document.body.innerHTML = `
    <div style="
      position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; 
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); 
      color: white; display: flex; flex-direction: column; 
      align-items: center; justify-content: center; 
      padding: 24px; text-align: center; z-index: 999999;
    ">
      <div style="margin-bottom: 24px; color: #f59e0b;">
        ${iconMarkup('wrench', { size: 72, strokeWidth: 1.5 })}
      </div>
      <h1 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #f59e0b;">
        Under Maintenance
      </h1>
      <p style="color: #94a3b8; font-size: 14px; max-width: 400px; line-height: 1.6; margin-bottom: 24px;">
        The system is currently under maintenance. 
        Please wait while the application is being updated.
      </p>
      <div style="
        padding: 12px 24px; border-radius: 8px; 
        background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.3);
        color: #f59e0b; font-size: 12px; font-weight: 600;
      ">
        ⏱ Auto-refresh every 60 seconds
      </div>
    </div>
  `;

  // Auto-check every 60 seconds if maintenance is off
  setInterval(async () => {
    try {
      var result = await fetchWithRetry(ADMIN_API_URL + '?action=getSettings');
      if (result && result.maintenance !== true) {
        window.location.reload();
      }
    } catch (e) {}
  }, 60000);
}

// ====================== MODULE HEALTH (this device's own diagnostics) ======================
//
// The other half of the diagnostics. `?action=diag` answers what the ORIGIN spent, on which
// sheet, at which stage — and it cannot see the phone. This card answers what THIS DEVICE
// waited, which is the half a server-side report can never contain and the one that decides
// what an operator actually experiences.
//
// Three rules it is built on, and each one is visible below:
//
//   1. IT READS MEMORY. Opening this tab costs no request, and Refresh re-reads memory rather
//      than refetching — a diagnostic screen that adds load is the bug it exists to hunt.
//   2. ABSENT IS NOT ZERO. The edge's own timings exist only while the Cloudflare proxy sits
//      in front of Apps Script, and it is off right now. So the card says so in words instead
//      of printing 0ms for a measurement nobody took — the wait column is still real and
//      still the number that was waited, and that distinction is the whole reason the two
//      halves of this feature are worth having separately.
//   3. IT NEVER CLAIMS MORE THAN IT SAW. Every row carries its call count, and the footer
//      says how many samples were dropped, so "p95 4s" from one call reads as one call.

function moduleHealthStore_() {
  return (typeof window !== 'undefined' && window.diagStore) ? window.diagStore : null;
}

/* Escaped rather than trusted. The store already sanitizes labels to [a-z0-9:_-], but the
   error text is a message from a throw and this string reaches innerHTML. */
function healthEsc_(value) {
  var text = String(value === null || value === undefined ? '' : value);
  if (typeof sanitizeHTML === 'function') return sanitizeHTML(text);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function healthMs_(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return ms + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
}

function healthAge_(at) {
  if (!at) return '—';
  var seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return seconds + 's ago';
  var minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  return Math.round(minutes / 60) + 'h ago';
}

function renderModuleHealth() {
  var body = document.getElementById('moduleHealthBody');
  if (!body) return;

  var store = moduleHealthStore_();
  if (!store) {
    body.innerHTML = '<div style="font-size: 12px; color: var(--text-muted);">diag-store.js is not loaded on this device, so nothing has been measured. It arrives with the next update — reload once installed.</div>';
    return;
  }

  var rows = store.summary();
  if (!rows.length) {
    body.innerHTML = '<div style="font-size: 12px; color: var(--text-muted);">Nothing measured yet this session. Open a module, then come back — the samples are collected by the calls the app was already making.</div>';
    return;
  }

  // Worst first, so the top row answers the question the card exists for.
  rows.sort(function (a, b) { return (b.waitP95Ms || 0) - (a.waitP95Ms || 0); });

  var withEdge = rows.filter(function (r) { return r.edgeSamples > 0; }).length;
  var note = withEdge
    ? 'Origin and Overhead come from the edge\'s own timing headers. Overhead is what this device and its network added on top of the origin\'s work, which is the difference between a slow deployment and a slow phone.'
    : 'Edge timing unavailable: the Cloudflare proxy is off, so the origin\'s own time is not on the response. These are this device\'s wall-clock waits only — still the number that was actually waited.';

  /* A header is aligned the way its own column's DATA is aligned, and the data is what decides
     it. Left-aligned labels over right-aligned numbers leave "10s" floating between "Wait p50"
     and "Wait p95" with nothing saying which column it belongs to — which is the one comparison
     this card exists to make, unreadable at a glance. `Module` stays left because its data is
     text; the rest are numbers and read right. */
  var thBase = 'font-size: 11px; text-transform: uppercase; color: var(--text-muted); padding: 6px 7px; border-bottom: 1px solid var(--border-color); white-space: nowrap;';
  var th = 'text-align: left; ' + thBase;
  var thNum = 'text-align: right; ' + thBase;
  var td = 'font-size: 12px; padding: 6px 7px; border-bottom: 1px solid var(--border-color); white-space: nowrap;';
  var num = 'font-size: 12px; padding: 6px 7px; border-bottom: 1px solid var(--border-color); text-align: right; white-space: nowrap;';
  var btn = 'padding: 8px 14px; border: 1px solid var(--border-color); border-radius: 8px; background: var(--card-bg); color: var(--dark-charcoal); font-size: 12px; font-weight: 600; cursor: pointer;';

  function head_(label, title) {
    return '<th style="' + th + '"' + (title ? ' title="' + healthEsc_(title) + '"' : '') + '>' + label + '</th>';
  }

  /* The numeric headers, built over their own numbers rather than beside them. */
  function headNum_(label, title) {
    return '<th style="' + thNum + '"' + (title ? ' title="' + healthEsc_(title) + '"' : '') + '>' + label + '</th>';
  }

  /* EIGHT columns, and every one of them was earned by a screenshot: ten of them pushed
     `Retries`, `Failed` and the age off the right edge behind a horizontal scroll on the very
     screen this card is read from, and a diagnostic whose bottom half nobody can see reports
     nothing. So `Calls` folded into the module cell (where it reads better anyway — the
     label and how much it rests on belong together), `Worst` rides on the p95 cell as its
     title, and the edge column is titled rather than spelled out. Nothing was dropped; three
     numbers moved to where they cost no width. */
  var table = '<div style="overflow-x: auto;"><table style="width: 100%; border-collapse: collapse;"><thead><tr>'
    + head_('Module')
    + headNum_('Wait p50')
    + headNum_('Wait p95', 'the worst call is one hover away')
    + headNum_('Edge', 'the edge\'s own median for this module. Absent while the proxy is off, which is why it reads as a dash.')
    + headNum_('Overhead', 'median of (this device\'s wait - the edge\'s own time), per call')
    + headNum_('Retried')
    + headNum_('Failed')
    + headNum_('Age')
    + '</tr></thead><tbody>'
    + rows.map(function (r) {
        var failedCell = r.failed
          ? '<td style="' + num + ' color: var(--badge-red-text); font-weight: 700;" title="' + healthEsc_(r.lastError) + '">' + r.failed + '</td>'
          : '<td style="' + num + '">0</td>';
        return '<tr>'
          + '<td style="' + td + ' font-weight: 700;">' + healthEsc_(r.label)
            + '<span style="font-weight: 400; font-size: 10px; color: var(--text-muted);"> · ' + r.calls + '</span></td>'
          + '<td style="' + num + '">' + healthMs_(r.waitMs) + '</td>'
          + '<td style="' + num + '" title="worst ' + healthEsc_(healthMs_(r.waitMaxMs)) + '">' + healthMs_(r.waitP95Ms) + '</td>'
          + '<td style="' + num + '">' + healthMs_(r.edgeSamples ? r.originMs : null) + '</td>'
          + '<td style="' + num + '">' + healthMs_(r.overheadMs) + '</td>'
          + '<td style="' + num + (r.retried ? ' color: var(--badge-yellow-text); font-weight: 700;' : '') + '">' + r.retried + '</td>'
          + failedCell
          + '<td style="' + num + '">' + healthAge_(r.lastAt) + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table></div>';

  var totals = store.totals();
  var footer = 'Last ' + store.MAX_SAMPLES + ' calls per module'
    + (totals.dropped ? ' · ' + totals.dropped + ' older sample' + (totals.dropped === 1 ? '' : 's') + ' dropped' : '');

  body.innerHTML = ''
    + '<div style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px; line-height: 1.5;">' + healthEsc_(note) + '</div>'
    + table
    + '<div style="display: flex; align-items: center; gap: 8px; margin-top: 14px; flex-wrap: wrap;">'
    + '<button type="button" onclick="renderModuleHealth()" style="' + btn + '">Refresh</button>'
    + '<button type="button" onclick="clearModuleHealth()" style="' + btn + '">Clear</button>'
    + '<button type="button" onclick="copyModuleHealth()" style="' + btn + '">Copy report</button>'
    + '<span style="font-size: 11px; color: var(--text-muted); margin-left: auto;">' + healthEsc_(footer) + '</span>'
    + '</div>';
}

function clearModuleHealth() {
  var store = moduleHealthStore_();
  if (!store) return;
  store.clear();
  renderModuleHealth();
  if (typeof showToast === 'function') showToast('Module Health cleared', 'success');
}

/* A copy that silently does nothing is worse than no button, so the fallback says what
   happened and puts the report where it can still be read. */
function copyModuleHealth() {
  var store = moduleHealthStore_();
  if (!store) return;
  var text = JSON.stringify(store.snapshot(), null, 2);
  function fallback() {
    try { console.log('[Module Health] ' + text); } catch (e) {}
    if (typeof showToast === 'function') showToast('Copy unavailable — report written to the console', 'error');
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (typeof showToast === 'function') showToast('Module Health report copied', 'success');
      }).catch(fallback);
      return;
    }
  } catch (e) { /* fall through */ }
  fallback();
}
