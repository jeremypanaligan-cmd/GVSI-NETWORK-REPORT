// ====================== ADMIN MODULE ======================
// Tech admin/Dev only — Maintenance Mode + Active Users tracking

// Use window.BASE_API_URL to access the global variable defined in index.html
var ADMIN_API_URL = window.BASE_API_URL || '';
var _adminRefreshInterval = null;

// Initialize ADMIN_API_URL when module loads
function initAdminUrl() {
  if (window.BASE_API_URL) {
    ADMIN_API_URL = window.BASE_API_URL;
  }
}

// ====================== AUTH TOKEN (P1) ======================
// Every call to our API carries the session token, which the backend verifies.
// index.html owns the token (it is written at login) and exposes withAuthToken,
// so this module never has to know where it is stored. Falls back to the plain
// URL when that helper is missing, so an older cached shell still works.
function withToken(url) {
  return (typeof window.withAuthToken === 'function') ? window.withAuthToken(url) : url;
}

// ====================== ROLE CHECK ======================

// Called from showTab() and showApp(), i.e. on every tab switch — so it must stay
// silent. A zero-argument log here used to dump six lines per call, which buried
// real console errors. The error paths below still log; only this verdict is quiet.
function isAdmin() {
  var session = getSession();

  if (!session) return false;
  if (!session.role) return false;

  // Trim whitespace and compare exactly
  var userRole = String(session.role).trim();
  var adminRole = 'Tech admin/Dev';

  return userRole === adminRole;
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
              <div style="font-size: 12px; color: var(--text-muted);">Current Online Users</div>
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

    <!-- CACHE & DATA SYNC SECTION -->
    <div class="table-card" style="margin-top: 16px;">
      <div style="padding: 20px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
          <div style="display: flex; align-items: center; gap: 12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
            </svg>
            <div>
              <div style="font-size: 16px; font-weight: 700; color: var(--dark-charcoal);">Cache &amp; Data Sync</div>
              <div style="font-size: 12px; color: var(--text-muted);">See which caching layer is holding data, clear it, and refetch from the backend.</div>
            </div>
          </div>
          <div id="cacheStatusTime" style="font-size: 11px; color: var(--text-muted); text-align: right;">Not checked yet</div>
        </div>

        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>LAYER</th>
                <th>HELD NOW</th>
                <th>LAST CLEAR</th>
              </tr>
            </thead>
            <tbody id="cacheStatusBody">
              <tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Checking...</td></tr>
            </tbody>
          </table>
        </div>

        <div style="margin: 20px 0 4px; font-size: 13px; font-weight: 700; color: var(--dark-charcoal);">
          Payload Size Headroom
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 10px; line-height: 1.6;">
          How close each module's payload is to the caching thresholds in the backend — measured in the browser from the same JSON the backend serializes.
        </div>

        <div class="table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>MODULE</th>
                <th>PAYLOAD</th>
                <th>USAGE OF 90 KB</th>
                <th>HEADROOM</th>
              </tr>
            </thead>
            <tbody id="payloadHeadroomBody">
              <tr><td colspan="4" style="text-align: center; color: var(--text-muted);">Measuring...</td></tr>
            </tbody>
          </table>
        </div>

        <div id="payloadHeadroomNote" style="font-size: 11px; color: var(--text-muted); margin-top: 10px; line-height: 1.6;"></div>

        <div id="cacheResyncResult" style="
          display: none; margin-top: 12px; padding: 10px 12px; border-radius: 8px;
          font-size: 12px; line-height: 1.6; background: var(--card-bg);
          border: 1px solid var(--border-color); color: var(--dark-charcoal);
        "></div>

        <div style="display: flex; gap: 12px; margin-top: 16px;">
          <button id="btnRefreshCacheStatus" onclick="loadCacheStatus(true)" style="
            flex: 1; padding: 12px; border-radius: 8px; cursor: pointer;
            background: var(--card-bg); border: 1px solid var(--border-color);
            color: var(--dark-charcoal); font-weight: 700; font-size: 13px;
            display: flex; align-items: center; justify-content: center; gap: 8px;
          ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
            Refresh Status
          </button>
          <button id="btnClearCache" onclick="adminClearCacheAndResync()" style="
            flex: 1; padding: 12px; border: none; border-radius: 8px;
            background: var(--primary-teal); color: white;
            font-weight: 700; font-size: 13px; cursor: pointer;
            display: flex; align-items: center; justify-content: center; gap: 8px;
          ">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="1 4 1 10 7 10"></polyline>
              <polyline points="23 20 23 14 17 14"></polyline>
              <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15"></path>
            </svg>
            Clear Cache &amp; Resync
          </button>
        </div>

        <div style="font-size: 11px; color: var(--text-muted); margin-top: 10px; line-height: 1.6;">
          Clears the in-memory data cache and the service-worker shell cache, then refetches every module.
          <strong>Trend history (IndexedDB) and your login are never touched.</strong>
          The backend's own cache cannot be purged from the client — it self-expires within 180s.
        </div>
      </div>
    </div>
  `;

  // Load initial data
  loadMaintenanceStatus();
  loadActiveUsers();
  loadCacheStatus();

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
    ? '⚠️ Enable Maintenance Mode?\n\nAll users will be unable to access the app except you.'
    : '✅ Disable Maintenance Mode?\n\nAll users will be able to access the app again.';

  if (!confirm(confirmMsg)) return;

  try {
    // No ?admin= here on purpose: the backend derives UpdatedBy from the token,
    // so sending a name would only suggest a second source of truth. The route is
    // admin-gated, so a missing token is refused outright.
    var result = await fetchWithRetry(
      withToken(ADMIN_API_URL + '?action=setMaintenance&enabled=' + enable)
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

/* Appended to the body — never assigned to document.body.innerHTML.

   Replacing the body's HTML deletes the whole shell: the header, the bottom
   navigation, the kiosk root and every element the still-running script holds a
   reference to. Nothing puts any of it back until the app itself is restarted,
   which on a phone looks like "the bottom nav disappeared, I had to close and
   reopen the app". That is not a theory: the update prompt used to do exactly
   this and was fixed the same way (see the comment in showReinstallPrompt():
   "Use overlay instead of replacing body.innerHTML to preserve DOM structure").
   The maintenance screen was the one place left that still replaced it.

   Idempotent: checkMaintenanceAndLogin() can call it, and so can anything that
   re-checks settings later, without stacking a second copy. */
function showMaintenancePage() {
  if (document.getElementById('maintenanceOverlay')) return;

  var overlay = document.createElement('div');
  overlay.id = 'maintenanceOverlay';
  overlay.innerHTML = `
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
  document.body.appendChild(overlay);

  // Auto-check every 60 seconds if maintenance is off
  setInterval(async () => {
    try {
      // ADMIN_API_URL is empty until an admin tab renders, and a bare
      // '?action=getSettings' resolves against THIS origin and 404s — so this
      // auto-refresh silently never fired. Take the URL from the page instead.
      var result = await fetchWithRetry((window.BASE_API_URL || ADMIN_API_URL) + '?action=getSettings');
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
var _heartbeatFirstBeat = null;
var HEARTBEAT_MS = 60000;   // 60s (was 30s) — the sheet only drops a user after 5 min idle

// The first beat is deliberately NOT immediate. showApp() calls startHeartbeat()
// in the same tick as loadInitialData(), so an immediate beat made a hard refresh
// open SIX concurrent /exec invocations at exactly the moment the deployment is
// most likely to be stalled. The heartbeat is the least urgent of the six — the
// sheet only drops a user after 5 minutes idle, so arriving seconds late costs
// nothing — and measured on the live endpoint ~20% of calls 404 while stalled
// (3/15, all of them taking 8-33 s), so one fewer concurrent draw is real.
var HEARTBEAT_FIRST_DELAY_MS = 8000;

var _heartbeatSkip = 0;     // cycles to sit out after the API refuses a beat

function startHeartbeat() {
  // One heartbeat per app, not one per showApp() call: a second interval would
  // double the beat rate for the same user.
  if (_heartbeatInterval || _heartbeatFirstBeat) return;
  _heartbeatFirstBeat = setTimeout(function () {
    _heartbeatFirstBeat = null;
    sendHeartbeat();
  }, HEARTBEAT_FIRST_DELAY_MS);
  _heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_MS);
}

function stopHeartbeat() {
  // The pending first beat has to go with the interval, or a logout that lands in
  // the first 8 seconds would still announce the user as active.
  if (_heartbeatFirstBeat) {
    clearTimeout(_heartbeatFirstBeat);
    _heartbeatFirstBeat = null;
  }
  if (_heartbeatInterval) {
    clearInterval(_heartbeatInterval);
    _heartbeatInterval = null;
  }
}

async function sendHeartbeat() {
  var session = getSession();
  if (!session || !session.username) return;
  // Lazily resolve URL — window.BASE_API_URL may not exist when this module loads
  var url = ADMIN_API_URL || window.BASE_API_URL || '';
  if (!url) return;

  // If the API just refused a beat, don't keep hammering it. Sitting out two
  // cycles still keeps us well inside the 5-minute idle window the sheet uses.
  if (_heartbeatSkip > 0) { _heartbeatSkip--; return; }

  try {
    // Plain fetch, not fetchWithRetry — a heartbeat must never add retry load.
    // Non-critical, so it fails silently.
    // The token is what identifies the caller; the username/fullName params are
    // only read when no token is present (phase 1), so they can't spoof anyone.
    var res = await fetch(
      withToken(url + '?action=heartbeat&username=' + encodeURIComponent(session.username) + '&fullName=' + encodeURIComponent(session.fullName || '')),
      { cache: 'no-store' }
    );
    if (!res || !res.ok) { _heartbeatSkip = 2; return; }

    // A refused session answers 200 with a marker body (ContentService can't set
    // a status code), so res.ok is true. Without checking, a client whose token
    // is gone — an old session, a revoked token — would beat every 60s forever
    // against an already-throttled backend and never learn why. Stop instead:
    // a re-login restarts it via showApp() -> startHeartbeat().
    try {
      var body = await res.json();
      if (body && body.unauthorized) { stopHeartbeat(); return; }
    } catch (e) { /* non-JSON means the beat succeeded; nothing to inspect */ }
  } catch (e) {
    // Silent fail — heartbeat is non-critical
    _heartbeatSkip = 2;
  }
}

// ====================== CLEANUP ON LOGOUT ======================
// This section used to "override" handleLogout, but it never ran: this file
// loads BEFORE the inline script in index.html that declares handleLogout, so at
// this point `typeof handleLogout === 'undefined'`, the assignment was skipped,
// and ?action=removeActiveUser therefore NEVER fired on logout — the 5-minute
// staleness prune in handleGetActiveUsers was quietly doing the cleanup.
// The removal, the stopHeartbeat() call and the token revocation now all live in
// handleLogout() in index.html, which is the copy that actually executes.

// ====================== CACHE & DATA SYNC ======================
// Thin wrapper over cache-control.js (window.netpulseCache) so a support tech can
// see WHICH caching layer is holding data, clear the safe ones, and force a fresh
// pull from the backend — without devtools and without deploying anything.

// Order matches the way a request actually passes through the layers (see
// GVSI_NetPulse_Caching_Notes.md). The keys differ slightly between status() and
// invalidateAll(), so each layer carries both.
var CACHE_LAYERS = [
  { label: '1 · Apps Script server cache',  statusKey: '1. Apps Script server cache', reportKey: '1. Apps Script server cache' },
  { label: '2 · IndexedDB trend history',   statusKey: '2. IndexedDB snapshots',      reportKey: '2. IndexedDB' },
  { label: '3 · Service worker',            statusKey: '3. Service worker',           reportKey: '3. service worker' },
  { label: '3 · Shell cache (app files)',   statusKey: '3. Shell cache',              reportKey: '3. shell cache' },
  { label: '4 · HTTP cache',                statusKey: '4. HTTP cache',               reportKey: '4. HTTP cache' },
  { label: '5 · dataCache (in memory)',     statusKey: '5. dataCache',                reportKey: '5. dataCache' },
  { label: '· localStorage (prefs, login)', statusKey: null,                          reportKey: 'storage' }
];

var RESYNC_MODULES = [
  { type: 'nap',      fn: 'fetchNapData' },
  { type: 'lcp',      fn: 'fetchLcpData' },
  { type: 'olt',      fn: 'fetchOltData' },
  { type: 'node',     fn: 'fetchNodeData' },
  { type: 'backbone', fn: 'fetchBackboneData' }
];

// Where each module's payload currently lands, and how loudly to say it.
var PAYLOAD_TIER_LABEL = {
  'cache-service': 'CacheService',
  'properties-fallback': 'PropertiesService fallback',
  'uncached': 'NOT CACHED — sheet read per request',
  'unknown': 'not loaded yet'
};

var PAYLOAD_SEVERITY_COLOR = {
  ok: 'var(--primary-teal)',
  warn: 'var(--badge-orange-text)',
  danger: 'var(--badge-red-text)',
  muted: 'var(--text-muted)'
};

// Result of the most recent clear, so it survives tab switches (renderAdminTab
// rebuilds the markup every time the tab is opened) and page reloads.
var _lastCacheClear = null;   // { report, at }
var CACHE_REPORT_KEY = 'netpulse_last_cache_clear';

function saveLastCacheClear(state) {
  _lastCacheClear = state;
  try { sessionStorage.setItem(CACHE_REPORT_KEY, JSON.stringify(state)); } catch (err) { /* storage full/blocked */ }
}

// Restored lazily so the report is still visible if the tech reloads to confirm
// the clear worked. invalidateAll() only clears sessionStorage when called with
// storage: true, which this panel never does.
function restoreLastCacheClear() {
  if (_lastCacheClear) return _lastCacheClear;
  try {
    var raw = sessionStorage.getItem(CACHE_REPORT_KEY);
    if (raw) _lastCacheClear = JSON.parse(raw);
  } catch (err) {
    _lastCacheClear = null;
  }
  return _lastCacheClear;
}

function cacheEscape(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// status() returns `5. dataCache` as an object; flatten it into "nap: 14 rows · …".
function formatCacheValue(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') {
    var keys = Object.keys(value);
    if (!keys.length) return 'empty';
    return keys.map(function (k) { return k + ': ' + value[k]; }).join(' · ');
  }
  return String(value);
}

function cacheControlAvailable() {
  return !!(window.netpulseCache && typeof netpulseCache.status === 'function');
}

// `clearState` is the { report, at } wrapper — the report object itself is what
// carries the per-layer results.
function renderCacheTable(status, clearState) {
  var tbody = document.getElementById('cacheStatusBody');
  if (!tbody) return;

  var report = clearState ? clearState.report : null;

  tbody.innerHTML = CACHE_LAYERS.map(function (layer) {
    var held = (status && layer.statusKey) ? formatCacheValue(status[layer.statusKey]) : '—';
    var cleared = (report && layer.reportKey) ? formatCacheValue(report[layer.reportKey]) : '—';
    return '<tr>' +
      '<td style="font-weight: 600; white-space: nowrap;">' + cacheEscape(layer.label) + '</td>' +
      '<td style="color: var(--text-muted);">' + cacheEscape(held) + '</td>' +
      '<td>' + cacheEscape(cleared) + '</td>' +
      '</tr>';
  }).join('');

  var stamp = document.getElementById('cacheStatusTime');
  if (stamp) {
    var now = new Date().toLocaleTimeString();
    stamp.innerHTML = 'Checked ' + cacheEscape(now) +
      ((clearState && clearState.at) ? '<br>Cleared ' + cacheEscape(new Date(clearState.at).toLocaleTimeString()) : '');
  }
}

// Decimal units on purpose: the thresholds are 90,000 / 450,000 bytes, which the
// backend and the docs both call "90 KB" and "450 KB". Binary units would render
// the 90 KB limit as "88 KB" and read as inconsistent with the header.
function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  var negative = bytes < 0;
  var n = Math.abs(bytes);
  var out = n < 1000 ? n + ' B' : (n / 1000).toFixed(1) + ' KB';
  return (negative ? '\u2212' : '') + out;
}

function renderPayloadHeadroom() {
  var tbody = document.getElementById('payloadHeadroomBody');
  if (!tbody) return;

  if (!window.netpulseCache || typeof netpulseCache.payloadHeadroom !== 'function') {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--badge-red-text);">' +
      'Payload measurement unavailable — reload the app and try again.</td></tr>';
    return;
  }

  var report;
  try {
    report = netpulseCache.payloadHeadroom();
  } catch (err) {
    console.error('[Admin] Payload measurement failed:', err);
    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--badge-red-text);">' +
      'Could not measure payloads: ' + cacheEscape(err && err.message) + '</td></tr>';
    return;
  }

  tbody.innerHTML = report.modules.map(function (m) {
    var colour = PAYLOAD_SEVERITY_COLOR[m.severity] || 'inherit';
    var tier = PAYLOAD_TIER_LABEL[m.tier] || m.tier;
    var pct = m.percentOfCacheLimit;
    var barWidth = pct === null ? 0 : Math.min(100, pct);

    return '<tr>' +
      '<td style="font-weight: 600; white-space: nowrap;">' + cacheEscape(m.type.toUpperCase()) +
        '<div style="font-size: 10px; font-weight: 400; color: var(--text-muted); margin-top: 2px;">' +
          cacheEscape(tier) + '</div>' +
      '</td>' +
      '<td style="color: ' + colour + '; font-weight: 600; white-space: nowrap;">' +
        cacheEscape(formatBytes(m.bytes)) + '</td>' +
      '<td style="min-width: 110px;">' +
        '<div style="display: flex; align-items: center; gap: 8px;">' +
          '<div style="flex: 1; height: 6px; border-radius: 3px; background: var(--border-color); overflow: hidden;">' +
            '<div style="width: ' + barWidth + '%; height: 100%; background: ' + colour + ';"></div>' +
          '</div>' +
          '<span style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">' +
            (pct === null ? '—' : cacheEscape(pct) + '%') + '</span>' +
        '</div>' +
      '</td>' +
      '<td style="color: var(--text-muted); white-space: nowrap;">' +
        cacheEscape(formatBytes(m.headroomBytes)) + '</td>' +
      '</tr>';
  }).join('');

  renderPayloadNote(report);
}

function renderPayloadNote(report) {
  var note = document.getElementById('payloadHeadroomNote');
  if (!note) return;

  var measured = report.modules.filter(function (m) { return m.bytes !== null; });
  if (!measured.length) {
    note.textContent = 'No module payloads are loaded yet — open another tab, or press Refresh Status.';
    return;
  }

  // The largest payload is the one that will hit the ceiling first.
  var tightest = measured.reduce(function (a, b) { return b.bytes > a.bytes ? b : a; });
  var limitKb = Math.round(report.cacheServiceLimit / 1000);

  var uncached = measured.filter(function (m) { return m.tier === 'uncached'; });
  var fallback = measured.filter(function (m) { return m.tier === 'properties-fallback'; });
  var near = measured.filter(function (m) { return m.tier === 'cache-service' && m.severity === 'danger'; });
  var watch = measured.filter(function (m) { return m.tier === 'cache-service' && m.severity === 'warn'; });

  var names = function (list) { return list.map(function (m) { return cacheEscape(m.type.toUpperCase()); }).join(', '); };

  var html = 'Closest to the limit: <strong>' + cacheEscape(tightest.type.toUpperCase()) + '</strong> at ' +
    cacheEscape(formatBytes(tightest.bytes)) + ' of ' + limitKb + ' KB (' +
    cacheEscape(tightest.percentOfCacheLimit) + '%), leaving ' +
    cacheEscape(formatBytes(tightest.headroomBytes)) + ' of headroom.';

  if (uncached.length) {
    html += ' <span style="color: var(--badge-red-text);">Over 450 KB and no longer cached at all: ' + names(uncached) + '.</span>';
  } else if (fallback.length) {
    html += ' <span style="color: var(--badge-orange-text);">Over 90 KB, so on the hand-expired PropertiesService fallback: ' + names(fallback) + '.</span>';
  } else if (near.length) {
    html += ' <span style="color: var(--badge-red-text);">Past 85% of the 90 KB limit: ' + names(near) + '.</span>';
  } else if (watch.length) {
    html += ' <span style="color: var(--badge-orange-text);">Past 60% of the 90 KB limit: ' + names(watch) + '.</span>';
  } else {
    // Deliberately precise instead of "comfortable": OLT can sit mid-range with
    // real headroom left, and claiming otherwise would undercut the number above.
    html += ' No module is past the 60% watch line.';
  }

  html += '<br>Crossing 90 KB moves a module onto the <strong>PropertiesService fallback</strong> ' +
    '(stamped and expiring by hand); past 450 KB it stops being cached at all and every request re-reads the sheet.';

  note.innerHTML = html;
}

async function loadCacheStatus(announce) {
  var tbody = document.getElementById('cacheStatusBody');
  restoreLastCacheClear();

  // Synchronous, and independent of the layer table's async reads — render it
  // right away so it never waits on caches.keys() / IndexedDB.
  renderPayloadHeadroom();

  if (!cacheControlAvailable()) {
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--badge-red-text);">' +
        'Cache control unavailable — reload the app and try again.</td></tr>';
    }
    return;
  }

  if (tbody && !_lastCacheClear) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">Checking...</td></tr>';
  }

  try {
    var status = await netpulseCache.status();
    renderCacheTable(status, _lastCacheClear);
    if (announce) showToast('Cache status refreshed', 'info');
  } catch (err) {
    console.error('[Admin] Failed to read cache status:', err);
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--badge-red-text);">' +
        'Could not read cache status: ' + cacheEscape(err && err.message) + '</td></tr>';
    }
    if (announce) showToast('Could not read cache status', 'error');
  }
}

// Force-refetch every module. dataCache was just cleared, so forceRefresh=true
// bypasses the cache; identical in-flight URLs are de-duplicated by
// fetchWithRetry, so this cannot turn into a request burst.
async function resyncAllModules() {
  return Promise.all(RESYNC_MODULES.map(function (mod) {
    var fn = window[mod.fn];
    if (typeof fn !== 'function') {
      return Promise.resolve({ type: mod.type, ok: false, reason: 'loader not found' });
    }
    return Promise.resolve()
      .then(function () { return fn(true); })
      .then(function () { return { type: mod.type, ok: true }; })
      .catch(function (err) {
        console.warn('[Admin] Resync failed for ' + mod.type + ':', err);
        return { type: mod.type, ok: false, reason: (err && err.message) ? err.message : 'failed' };
      });
  }));
}

function setCacheButtonBusy(busy, label) {
  var btn = document.getElementById('btnClearCache');
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.idleHtml) btn.dataset.idleHtml = btn.innerHTML;
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'wait';
    btn.textContent = label || 'Working...';
  } else {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = 'pointer';
    if (btn.dataset.idleHtml) btn.innerHTML = btn.dataset.idleHtml;
  }
}

async function adminClearCacheAndResync() {
  if (!cacheControlAvailable() || typeof netpulseCache.invalidateAll !== 'function') {
    showToast('Cache control unavailable — hard-reload the app instead', 'error');
    return;
  }

  if (!confirm('Clear the cached app files and the in-memory data, then refetch everything from the backend?\n\nTrend history and your login are kept.')) return;

  setCacheButtonBusy(true, 'Clearing...');
  var note = document.getElementById('cacheResyncResult');
  if (note) { note.style.display = 'none'; note.textContent = ''; }

  try {
    // Safe default: dataCache + shell cache only. Trend history (IndexedDB) and
    // storage are opt-in and deliberately not called here.
    var report = await netpulseCache.invalidateAll();
    saveLastCacheClear({ report: report, at: Date.now() });
    showToast('Cache cleared — refetching data...', 'success');

    setCacheButtonBusy(true, 'Resyncing...');
    var results = await resyncAllModules();
    var ok = results.filter(function (r) { return r.ok; });
    var failed = results.filter(function (r) { return !r.ok; });

    if (note) {
      note.style.display = 'block';
      note.innerHTML = '<strong>' + ok.length + ' of ' + results.length + ' modules refetched.</strong>' +
        (failed.length
          ? '<br>Failed: ' + failed.map(function (f) {
              return cacheEscape(f.type) + ' (' + cacheEscape(f.reason) + ')';
            }).join(', ')
          : '') +
        '<br><span style="color: var(--text-muted);">"Held now" is live; "Last clear" records what was removed. ' +
        'A module that failed to refetch will retry on its own refresh interval.</span>';
    }

    showToast(
      failed.length
        ? 'Resynced ' + ok.length + ' of ' + results.length + ' modules'
        : 'Cache cleared and all ' + ok.length + ' modules resynced',
      failed.length ? 'warning' : 'success'
    );
  } catch (err) {
    console.error('[Admin] Clear cache failed:', err);
    showToast('Clear cache failed: ' + ((err && err.message) ? err.message : 'unknown error'), 'error');
  } finally {
    setCacheButtonBusy(false);
    // Re-read so "Held now" reflects the post-clear, post-resync state.
    await loadCacheStatus();
  }
}
