// ====================== ADMIN & LOGIN MODULE ======================
// Separate file for authentication and admin functions
// Keeps code.gs clean for data fetching

// ====================== LOGIN ======================

function handleLogin(e) {
  var username = String(e.parameter.username || "").trim().toLowerCase();
  var password = String(e.parameter.password || "").trim();

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
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        user: {
          username: dbUsername,
          fullName: dbFullName,
          role: dbRole
        }
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Invalid username or password" })).setMimeType(ContentService.MimeType.JSON);
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
  var enabled = (e.parameter.enabled === "true");
  var admin = e.parameter.admin || "unknown";
  
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

// ====================== ACTIVE USERS ======================

function handleGetActiveUsers(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("ActiveUsers");
  
  if (!sheet) {
    sheet = ss.insertSheet("ActiveUsers");
    sheet.appendRow(["Username", "FullName", "LastSeen"]);
    return ContentService.createTextOutput(JSON.stringify({ users: [] }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  var data = sheet.getDataRange().getValues();
  var users = [];
  var now = new Date().getTime();
  var rowsToDelete = [];
  
  for (var i = 1; i < data.length; i++) {
    var lastSeen = new Date(data[i][2]).getTime();
    var diffMinutes = (now - lastSeen) / (1000 * 60);
    
    if (diffMinutes > 5) {
      rowsToDelete.push(i + 1);
    } else {
      users.push({
        username: String(data[i][0]).trim(),
        fullName: String(data[i][1]).trim(),
        lastSeen: data[i][2]
      });
    }
  }
  
  for (var j = rowsToDelete.length - 1; j >= 0; j--) {
    sheet.deleteRow(rowsToDelete[j]);
  }
  
  return ContentService.createTextOutput(JSON.stringify({ users: users }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleHeartbeat(e) {
  var username = e.parameter.username || "";
  var fullName = e.parameter.fullName || "";
  
  if (!username) {
    return ContentService.createTextOutput(JSON.stringify({ success: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("ActiveUsers");
  
  if (!sheet) {
    sheet = ss.insertSheet("ActiveUsers");
    sheet.appendRow(["Username", "FullName", "LastSeen"]);
  }
  
  var data = sheet.getDataRange().getValues();
  var found = false;
  
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === username.toLowerCase()) {
      sheet.getRange(i + 1, 3).setValue(new Date().toISOString());
      found = true;
      break;
    }
  }
  
  if (!found) {
    sheet.appendRow([username, fullName, new Date().toISOString()]);
  }
  
  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleRemoveActiveUser(e) {
  var username = e.parameter.username || "";
  
  if (!username) {
    return ContentService.createTextOutput(JSON.stringify({ success: false }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("ActiveUsers");
  
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ success: true }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  
  var data = sheet.getDataRange().getValues();
  
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === username.toLowerCase()) {
      sheet.deleteRow(i + 1);
      break;
    }
  }
  
  return ContentService.createTextOutput(JSON.stringify({ success: true }))
    .setMimeType(ContentService.MimeType.JSON);
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