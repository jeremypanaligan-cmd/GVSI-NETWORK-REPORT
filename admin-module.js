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

  `;

  // Load initial data
  loadMaintenanceStatus();
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
