// ====================== ADMIN & LOGIN MODULE ======================
// Separate file for authentication and admin functions
// Keeps code.gs clean for data fetching

// ====================== SESSION TOKENS ======================
// Phase 2: ENFORCED.
//
// Every doGet action used to be open to anyone holding the deployment URL, and
// handleSetMaintenance stamped the actor straight from ?admin= — so a caller
// could both flip maintenance mode and forge the audit trail. Identity now comes
// from a token minted at login and verified here.
//
// REQUIRE_SESSION = true means a MISSING token is refused as well as an invalid
// one. It was flipped on 2026-09-12 after the token path was verified against the
// deployed backend (login issues one, it survives to the gated routes). Rolled
// out as phase 1 ("accept-if-present") first so no cached shell was locked out
// mid-deploy; the switch is kept as a named constant so the history is auditable
// and one line can revert it.

var REQUIRE_SESSION = true;
var SESSION_TOKEN_PREFIX = "session_";
var SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // matches the client's 24h session
var ADMIN_ROLE = "Tech admin/Dev";

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function unauthorizedResponse(message) {
  return jsonOut({
    success: false,
    unauthorized: true,
    message: message || "Session expired — please sign in again"
  });
}

function sessionTokenKey(token) {
  return SESSION_TOKEN_PREFIX + String(token || "");
}

function issueSessionToken(username, fullName, role) {
  var props = PropertiesService.getScriptProperties();
  // Two UUIDs: one alone is 122 random bits but the values are close to
  // sequential in practice, and a predictable token is a guessable one.
  var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, "");
  props.setProperty(sessionTokenKey(token), JSON.stringify({
    u: String(username || ""),
    name: String(fullName || ""),
    role: String(role || ""),
    exp: Date.now() + SESSION_TOKEN_TTL_MS
  }));
  pruneExpiredTokens(props);
  return token;
}

// Returns the session, or null when the token is absent / unknown / expired /
// corrupt. A token that fails is deleted rather than retried — the same
// discipline as the payload cache's "a missing stamp counts as expired".
function readSessionToken(token) {
  if (!token) return null;
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(sessionTokenKey(token));
  if (!raw) return null;

  var session = null;
  try { session = JSON.parse(raw); } catch (err) { session = null; }

  var exp = session ? Number(session.exp) || 0 : 0;
  if (!session || !session.u || exp <= Date.now()) {
    props.deleteProperty(sessionTokenKey(token));
    return null;
  }
  return session;
}

// There is deliberately no bare sessionFromRequest() helper any more: resolving
// the session is the SAME act as gating the route, and doing them separately is
// what read the token twice. resolveSession() below is the single entry point.

function revokeSessionToken(token) {
  if (!token) return false;
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty(sessionTokenKey(token))) return false;
  props.deleteProperty(sessionTokenKey(token));
  return true;
}

// Deliberately prefix-scoped: the oversized-payload cache also lives in
// PropertiesService, and sweeping its keys here would be a data-loss bug.
function pruneExpiredTokens(props) {
  props = props || PropertiesService.getScriptProperties();
  var now = Date.now();
  var keys = props.getKeys();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf(SESSION_TOKEN_PREFIX) !== 0) continue;
    var exp = 0;
    try { exp = Number(JSON.parse(props.getProperty(keys[i])).exp) || 0; } catch (err) { exp = 0; }
    if (exp <= now) props.deleteProperty(keys[i]);
  }
}

/**
 * Resolve the caller's session AND the gate decision in one pass.
 *
 * Returns { session, error }: `error` is the unauthorized body to send back, or
 * null to proceed; `session` is the verified session, null only in the phase-1
 * case where no token was offered and the switch tolerates it.
 *
 * Split out of requireSession() because three routes need both halves — they gate
 * first and then need the identity, and doing that as two calls read the same
 * property twice on routes that run constantly.
 */
function resolveSession(e, role) {
  var token = (e && e.parameter && e.parameter.token) ? String(e.parameter.token) : "";
  var session = readSessionToken(token);

  if (!session) {
    // A token was offered and rejected — never let that slide, even in phase 1.
    if (token) return { session: null, error: unauthorizedResponse("Session expired — please sign in again") };
    if (REQUIRE_SESSION) return { session: null, error: unauthorizedResponse("Sign-in required") };
    return { session: null, error: null }; // phase 1: tolerate an untokened caller (old cached shell)
  }

  // The expiry sweep deliberately does NOT run here. It is O(stored sessions):
  // getKeys() plus one read per session_* key. It used to run on every request
  // bearing a valid token, which put it on the busiest path in the app against a
  // METERED daily quota (Properties read/write, 50,000/day on a consumer account),
  // and the sweep made each such request cost 2 + N operations instead of 1. It now
  // runs at login (issueSessionToken), and readSessionToken still deletes a stale
  // token the moment one is presented, so abandoned entries do not accumulate.

  if (role && String(session.role || "").trim() !== role) {
    return { session: null, error: unauthorizedResponse("Your role does not allow this action") };
  }
  return { session: session, error: null };
}

/**
 * Gate a route. Returns null when the caller may proceed, or an unauthorized
 * response body when it may not. A route that also needs the session should call
 * resolveSession() instead, so the token is read once.
 */
function requireSession(e, role) {
  return resolveSession(e, role).error;
}

// ====================== LOGIN THROTTLING ======================
// sha256() is a single unsalted round, so the only real defence against a
// guessing loop is to stop accepting guesses: lock the username out after too
// many failures, and slow each one down.

var LOGIN_MAX_ATTEMPTS = 5;
var LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
var LOGIN_FAIL_DELAY_MS = 400;
var LOGIN_FAIL_DELAY_CAP_MS = 2000;

function loginAttemptKey(username) {
  return "loginfail_" + String(username || "").trim().toLowerCase();
}

function readLoginLock(username) {
  var raw = PropertiesService.getScriptProperties().getProperty(loginAttemptKey(username));
  var state = null;
  try { state = raw ? JSON.parse(raw) : null; } catch (err) { state = null; }
  return {
    attempts: state ? Number(state.n) || 0 : 0,
    until: state ? Number(state.until) || 0 : 0
  };
}

function recordLoginFailure(username) {
  var props = PropertiesService.getScriptProperties();
  var state = readLoginLock(username);
  var now = Date.now();

  // A lockout that has already lapsed gives a clean slate, so one further typo
  // does not immediately re-lock someone who just waited the window out.
  var attempts = (state.until && now > state.until) ? 0 : state.attempts;
  attempts++;

  var until = attempts >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_LOCKOUT_MS : (state.until || 0);
  props.setProperty(loginAttemptKey(username), JSON.stringify({ n: attempts, until: until }));

  // Best-effort slowdown — a failed sleep must never break the response.
  try {
    Utilities.sleep(Math.min(LOGIN_FAIL_DELAY_CAP_MS, LOGIN_FAIL_DELAY_MS * attempts));
  } catch (err) { /* deliberately ignored */ }

  return attempts;
}

function clearLoginFailures(username) {
  PropertiesService.getScriptProperties().deleteProperty(loginAttemptKey(username));
}

function formatLockoutWait(until) {
  var minutes = Math.ceil(Math.max(0, until - Date.now()) / 60000);
  if (minutes < 1) minutes = 1;
  return minutes + (minutes === 1 ? " minute" : " minutes");
}

// ====================== LOGIN ======================

function handleLogin(e) {
  var username = String(e.parameter.username || "").trim().toLowerCase();
  var password = String(e.parameter.password || "").trim();

  // Refuse before doing any work — no sheet read, no hashing. That is what makes
  // the lockout a real limit rather than a cosmetic one.
  var lock = readLoginLock(username);
  if (lock.until > Date.now()) {
    return jsonOut({
      success: false,
      locked: true,
      message: "Too many failed attempts. Try again in " + formatLockoutWait(lock.until) + "."
    });
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var usersSheet = ss.getSheetByName("Users");
  if (!usersSheet) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Users sheet not found" })).setMimeType(ContentService.MimeType.JSON);
  }

  var lastRow = usersSheet.getLastRow();
  if (lastRow < 2) {
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: "No users configured" })).setMimeType(ContentService.MimeType.JSON);
  }

  var usersData = usersSheet.getRange(2, 1, lastRow - 1, 4).getValues();
  var hashedPassword = sha256(password);

  for (var i = 0; i < usersData.length; i++) {
    var userRow = usersData[i];
    var dbUsername = String(userRow[0] || "").trim().toLowerCase();
    var dbPasswordHash = String(userRow[1] || "").trim();
    var dbFullName = String(userRow[2] || "").trim();
    var dbRole = String(userRow[3] || "").trim();

    if (dbUsername === username && dbPasswordHash === hashedPassword) {
      clearLoginFailures(username);

      /* THE EDGE READ TOKEN. See publish-cache.gs: the data routes have never been gated (this
         file gates only the admin routes), so a copy served from a CDN needs a credential of its
         own — short-lived, HMAC-signed here, verified at the edge without either side calling
         the other. Omitted when the edge is not configured, and a client that never receives one
         reads every module from /exec exactly as it does today. */
      var loginBody = {
        success: true,
        token: issueSessionToken(dbUsername, dbFullName, dbRole),
        user: {
          username: dbUsername,
          fullName: dbFullName,
          role: dbRole
        }
      };

      if (typeof edgeTokenForLogin_ === 'function') {
        var edgeToken = edgeTokenForLogin_(dbUsername);
        if (edgeToken) loginBody.cdnToken = edgeToken;
      }

      return jsonOut(loginBody);
    }
  }

  recordLoginFailure(username);
  // Generic message on purpose: it distinguishes nothing, so the response cannot
  // be used to probe which usernames exist.
  return jsonOut({ success: false, message: "Invalid username or password" });
}

// ====================== MAINTENANCE MODE ======================

function handleGetSettings(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("AppSettings");
  
  if (!sheet) {
    sheet = ss.insertSheet("AppSettings");
    sheet.appendRow(["Key", "Value", "UpdatedAt", "UpdatedBy"]);
    sheet.appendRow(["maintenance", "false", new Date().toISOString(), "system"]);
    return ContentService.createTextOutput(JSON.stringify({ maintenance: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  var data = sheet.getDataRange().getValues();
  var settings = {};
  
  for (var i = 1; i < data.length; i++) {
    var key = String(data[i][0]).trim();
    var value = String(data[i][1]).trim();
    if (key === "maintenance") {
      settings.maintenance = (value === "true");
    }
  }
  
  return ContentService.createTextOutput(JSON.stringify(settings))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleSetMaintenance(e) {
  var auth = resolveSession(e, ADMIN_ROLE);
  if (auth.error) return auth.error;

  var enabled = (e.parameter.enabled === "true");

  // The actor comes from the token, and ONLY from the token. ?admin= used to be
  // stamped straight into the sheet, so any caller could forge the audit trail;
  // the client no longer sends it and the gate above guarantees a session exists
  // here, so there is no fallback and no second source of truth. The session is
  // the one the gate already resolved — reading it again here was a second read.
  var admin = auth.session ? auth.session.u : "unknown";
  
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("AppSettings");
  
  if (!sheet) {
    sheet = ss.insertSheet("AppSettings");
    sheet.appendRow(["Key", "Value", "UpdatedAt", "UpdatedBy"]);
  }
  
  var data = sheet.getDataRange().getValues();
  var found = false;
  
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === "maintenance") {
      sheet.getRange(i + 1, 2).setValue(enabled ? "true" : "false");
      sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
      sheet.getRange(i + 1, 4).setValue(admin);
      found = true;
      break;
    }
  }
  
  if (!found) {
    sheet.appendRow(["maintenance", enabled ? "true" : "false", new Date().toISOString(), admin]);
  }
  
  Logger.log("Maintenance mode " + (enabled ? "ENABLED" : "DISABLED") + " by " + admin);
  
  return ContentService.createTextOutput(JSON.stringify({ success: true, maintenance: enabled }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ====================== LOGOUT ======================
// Revokes the token server-side. Without this, "logout" was client-side only and
// a token that had already been copied stayed valid for its full TTL.
//
// NOTE: nothing in the app calls this route yet — handleLogout() in index.html only
// clears localStorage, so a signed-out token stays valid until its TTL expires. The
// route is kept because the fix is one call away.

function handleLogout(e) {
  var token = (e && e.parameter && e.parameter.token) ? String(e.parameter.token) : "";
  return jsonOut({ success: true, revoked: revokeSessionToken(token) });
}

// ====================== HELPERS ======================

function sha256(input) {
  var rawHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, input, Utilities.Charset.UTF_8);
  var hash = '';
  for (var i = 0; i < rawHash.length; i++) {
    var byte = rawHash[i];
    if (byte < 0) byte += 256;
    var hex = byte.toString(16);
    if (hex.length === 1) hex = '0' + hex;
    hash += hex;
  }
  return hash;
}

function generateHash(plainTextPassword) {
  var hash = sha256(plainTextPassword);
  Logger.log('Password: ' + plainTextPassword);
  Logger.log('Hash: ' + hash);
  return hash;
}

// ====================== KEEP-ALIVE ======================
// Warm-up ping — keeps Google Apps Script server alive to reduce cold start.
// Called on page load before any other API request.

function handleKeepAlive() {
  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}