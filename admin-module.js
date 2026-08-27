// ====================== ADMIN MODULE ======================
// Tech admin/Dev only — Maintenance Mode + Active Users tracking

// Use window.BASE_API_URL to access the global variable defined in index.html
var ADMIN_API_URL = '';
var _adminRefreshInterval = null;

// Initialize ADMIN_API_URL when module loads
function initAdminUrl() {
  if (window.BASE_API_URL) {
    ADMIN_API_URL = window.BASE_API_URL;
  }
}

// ====================== ROLE CHECK ======================

function isAdmin() {
  var session = getSession();
  console.log('[Admin] Session data:', session);
  console.log('[Admin] Session role:', session ? JSON.stringify(session.role) : 'null');
  
  if (!session) {
    console.log('[Admin] No session found');
    return false;
  }
  
  if (!session.role) {
    console.log('[Admin] No role in session');
    return false;
  }
  
  // Trim whitespace and compare exactly
  var userRole = String(session.role).trim();
  var adminRole = 'Tech admin/Dev';
  var isAdm = (userRole === adminRole);
  
  console.log('[Admin] User role:', JSON.stringify(userRole));
  console.log('[Admin] Expected role:', JSON.stringify(adminRole));
  console.log('[Admin] Match:', isAdm);
  
  return isAdm;
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
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
          </svg>
          <div>
            <div style="font-size: 16px; font-weight: 700; color: var(--dark-charcoal);">Maintenance Mode</div>
            <div style="font-size: 12px; color: var(--text-muted);">I-toggle para isara ang app sa lahat ng users</div>
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
            </svg>
            Enable Maintenance
          </button>
          <button id="btnDisableMaintenance" onclick="toggleMaintenance(false)" style="
            flex: 1; padding: 12px; border: none; border-radius: 8px;
            background: var(--badge-green-text); color: white; 
            font-weight: 700; font-size: 13px; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 8px;
          ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            Disable Maintenance
          </button>
        </div>
      </div>
    </div>

    <!-- ACTIVE USERS SECTION -->
    <div class="table-card">
      <div style="padding: 20px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
            <div>
              <div style="font-size: 16px; font-weight: 700; color: var(--dark-charcoal);">Active Users</div>
              <div style="font-size: 12px; color: var(--text-muted);">Mga currently gumagamit ng app</div>
            </div>
          </div>
          <div id="activeUsersCount" style="
            padding: 4px 12px; border-radius: 12px; 
            background: var(--badge-green-bg); color: var(--badge-green-text);
            font-size: 12px; font-weight: 700;
          ">0 online</div>
        </div>

        <div id="activeUsersLastUpdated" style="
          font-size: 11px; color: var(--text-muted); margin-bottom: 12px;
        ">Last updated: --</div>

        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>USERNAME</th>
                <th>FULL NAME</th>
                <th style="text-align: center;">STATUS</th>
                <th style="text-align: center;">LAST SEEN</th>
              </tr>
            </thead>
            <tbody id="activeUsersTableBody">
              <tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Loading...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  // Load initial data
  loadMaintenanceStatus();
  loadActiveUsers();

  // Auto-refresh active users every 30 seconds
  if (_adminRefreshInterval) clearInterval(_adminRefreshInterval);
  _adminRefreshInterval = setInterval(() => {
    if (currentTab === 'admin') {
      loadActiveUsers();
    }
  }, 30000);
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
    ? '⚠️ I-enable ang Maintenance Mode?\n\nLahat ng users ay hindi na makaka-access sa app maliban sa iyo.'
    : '✅ I-disable ang Maintenance Mode?\n\nMakaka-access na ulit ang lahat ng users sa app.';

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
        <svg width="72" height="72" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
        </svg>
      </div>
      <h1 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #f59e0b;">
        Under Maintenance
      </h1>
      <p style="color: #94a3b8; font-size: 14px; max-width: 400px; line-height: 1.6; margin-bottom: 24px;">
        Ang sistema ay kasalukuyang naka-maintenance. 
        Mangyaring maghintay habang ina-update ang application.
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

// ====================== ACTIVE USERS ======================

async function loadActiveUsers() {
  try {
    var result = await fetchWithRetry(ADMIN_API_URL + '?action=getActiveUsers');
    var tbody = document.getElementById('activeUsersTableBody');
    var countBadge = document.getElementById('activeUsersCount');
    var lastUpdated = document.getElementById('activeUsersLastUpdated');
    
    if (!tbody) return;

    if (!result || !result.users || result.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No active users</td></tr>';
      if (countBadge) countBadge.textContent = '0 online';
      if (lastUpdated) lastUpdated.textContent = 'Last updated: ' + new Date().toLocaleTimeString();
      return;
    }

    var users = result.users;
    var now = Date.now();
    var html = '';

    users.forEach(function(user) {
      var lastSeen = new Date(user.lastSeen).getTime();
      var diffSeconds = Math.floor((now - lastSeen) / 1000);
      var status, statusColor, statusBg;

      if (diffSeconds < 120) {
        status = '🟢 Online';
        statusColor = 'var(--badge-green-text)';
        statusBg = 'var(--badge-green-bg)';
      } else if (diffSeconds < 300) {
        status = '🟡 Idle';
        statusColor = 'var(--badge-yellow-text)';
        statusBg = 'var(--badge-yellow-bg)';
      } else {
        status = '⚪ Offline';
        statusColor = 'var(--text-muted)';
        statusBg = 'var(--card-bg)';
      }

      var lastSeenText = diffSeconds < 60 ? 'Just now' 
        : diffSeconds < 3600 ? Math.floor(diffSeconds / 60) + 'm ago'
        : Math.floor(diffSeconds / 3600) + 'h ago';

      // Highlight current user
      var session = getSession();
      var isCurrentUser = session && user.username === session.username;
      var rowStyle = isCurrentUser ? 'background: rgba(13, 138, 128, 0.08);' : '';

      html += `
        <tr style="${rowStyle}">
          <td style="font-weight: 600;">${sanitizeHTML(user.username)}${isCurrentUser ? ' <span style="font-size:10px; color: var(--primary-teal);">(YOU)</span>' : ''}</td>
          <td>${sanitizeHTML(user.fullName)}</td>
          <td style="text-align: center;">
            <span style="padding: 2px 10px; border-radius: 10px; font-size: 11px; font-weight: 700; background: ${statusBg}; color: ${statusColor};">
              ${status}
            </span>
          </td>
          <td style="text-align: center; font-size: 12px; color: var(--text-muted);">${lastSeenText}</td>
        </tr>
      `;
    });

    tbody.innerHTML = html;

    var onlineCount = users.filter(function(u) {
      var diff = (now - new Date(u.lastSeen).getTime()) / 1000;
      return diff < 120;
    }).length;

    if (countBadge) countBadge.textContent = onlineCount + ' online';
    if (lastUpdated) lastUpdated.textContent = 'Last updated: ' + new Date().toLocaleTimeString();

  } catch (err) {
    console.error('[Admin] Failed to load active users:', err);
  }
}

// ====================== HEARTBEAT ======================

var _heartbeatInterval = null;

function startHeartbeat() {
  // Send heartbeat every 30 seconds
  sendHeartbeat(); // Immediate
  _heartbeatInterval = setInterval(sendHeartbeat, 30000);
}

function stopHeartbeat() {
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
}

async function sendHeartbeat() {
  var session = getSession();
  if (!session || !session.username) return;
  if (!ADMIN_API_URL) return; // Skip if URL not initialized

  try {
    // Use simple fetch instead of fetchWithRetry to avoid console spam
    // Heartbeat is non-critical — fail silently
    await fetch(
      ADMIN_API_URL + '?action=heartbeat&username=' + encodeURIComponent(session.username) + '&fullName=' + encodeURIComponent(session.fullName || ''),
      { cache: 'no-store' }
    );
  } catch (e) {
    // Silent fail — heartbeat is non-critical
  }
}

// ====================== CLEANUP ON LOGOUT ======================

var _originalHandleLogout = typeof handleLogout === 'function' ? handleLogout : null;

function adminHandleLogout() {
  stopHeartbeat();
  // Remove from active users
  var session = getSession();
  if (session && session.username) {
    fetch(ADMIN_API_URL + '?action=removeActiveUser&username=' + encodeURIComponent(session.username)).catch(() => {});
  }
  // Call original logout if exists
  if (_originalHandleLogout) _originalHandleLogout();
}

// Override handleLogout if it exists
if (typeof handleLogout !== 'undefined') {
  var _origLogout = handleLogout;
  handleLogout = function() {
    stopHeartbeat();
    var session = getSession();
    if (session && session.username) {
      fetch(ADMIN_API_URL + '?action=removeActiveUser&username=' + encodeURIComponent(session.username)).catch(() => {});
    }
    _origLogout();
  };
}
