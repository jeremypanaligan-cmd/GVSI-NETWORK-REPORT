// ==================== COLUMN INDEX CONSTANTS ====================
// Prevents breakage when sheet structure changes
var COL = {
  // OLT DOWN Tickets (Columns A-AB)
  OLT_PROVINCE: 0,       // A
  OLT_MUNICIPALITY: 1,   // B
  OLT_NAME: 2,           // C
  OLT_TICKET_NO: 5,      // F
  OLT_CAUSE: 6,          // G
  OLT_REMARKS: 20,       // U
  OLT_AGING: 23,         // X
  OLT_CLIENTS: 25,       // Z
  OLT_NAMES_AB: 27,      // AB (OLT names for per-OLT lookup)
  
  // Node DOWN Tickets
  NODE_PROVINCE: 3,      // D (Index 3)
  NODE_IMPACT: 10,       // K (Index 10)
  NODE_DOWNTIME: 13,     // N (Index 13)
  NODE_REMARKS: 20,      // U (Index 20)
  NODE_AGING: 23,        // X (Index 23)
  NODE_COUNT: 24,        // Y (Index 24)
  NODE_EQUIPMENT: 26,    // AA (Index 26)
  
  // Backbone Tickets
  BB_PROVINCE: 3,        // D (Index 3)
  BB_TICKET: 5,          // F (Index 5)
  BB_SERVICE: 6,         // G (Index 6)
  BB_IMPACT: 10,         // K (Index 10)
  BB_CATEGORY: 11,       // L (Index 11)
  BB_DOWNTIME: 13,       // N (Index 13)
  BB_REMARKS: 20,        // U (Index 20)
  BB_AGING: 23,          // X (Index 23)
  BB_LINKS: 24,          // Y (Index 24)
  BB_LINK_COUNT: 25      // Z (Index 25)
};

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) ? e.parameter.action : "";
  var type = (e && e.parameter && e.parameter.type) ? e.parameter.type : "nap";

  // ---------------- LOGIN VIA GET (Workaround for POST redirect issue) ----------------
  if (action === "login") {
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

  // ---------------- DATA FETCHING ----------------
  // ---------------- 1. Cache Check ----------------
  var cache = CacheService.getScriptCache();
  var cacheKey = "cache_v2_" + type;
  try {
    // Try CacheService first (100KB limit)
    var cachedData = cache.get(cacheKey);
    if (cachedData) {
      return ContentService.createTextOutput(cachedData)
        .setMimeType(ContentService.MimeType.JSON);
    }
    // Fallback: Check PropertiesService (500KB limit) for large payloads
    var props = PropertiesService.getScriptProperties();
    var propData = props.getProperty(cacheKey);
    if (propData) {
      return ContentService.createTextOutput(propData)
        .setMimeType(ContentService.MimeType.JSON);
    }
  } catch (err) {
    Logger.log("Cache get error: " + err.message);
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var resultData = null;

if (type === "backbone") {
    // ---------------- BACKBONE LINKS DATA ----------------
    var bbSheet = ss.getSheetByName("Backbone Tickets");
    if (!bbSheet) {
      resultData = [];
    } else {
      var lastRowBB = bbSheet.getLastRow();
      if (lastRowBB < 2) {
        resultData = [];
      } else {
        var bbData = bbSheet.getRange(2, 1, lastRowBB - 1, 26).getValues(); // Columns A-Z
        var bbList = [];

        for (var b = 0; b < bbData.length; b++) {
          var rowB = bbData[b];
          var provinceRaw = String(rowB[COL.BB_PROVINCE] || "").trim();
          var ticketRaw = String(rowB[COL.BB_TICKET] || "").trim();
          var serviceRaw = String(rowB[COL.BB_SERVICE] || "").trim();
          var impactRaw = String(rowB[COL.BB_IMPACT] || "").trim();
          var issueRaw = String(rowB[COL.BB_CATEGORY] || "").trim();
          var downtimeRaw = rowB[COL.BB_DOWNTIME] ? formatDateVal(rowB[COL.BB_DOWNTIME]) : "-";
          var agingRaw = String(rowB[COL.BB_AGING] || "").trim();
          var linksRaw = String(rowB[COL.BB_LINKS] || "").trim();
          var countLinks = rowB[COL.BB_LINK_COUNT] !== "" ? rowB[COL.BB_LINK_COUNT] : 0;
          var remarksRaw = rowB[COL.BB_REMARKS] ? String(rowB[COL.BB_REMARKS]).trim() : "-";

          // I-filter ang mga walang tunay na data (hindi counted ang residual values)
          var hasRealData = (provinceRaw !== "" && provinceRaw !== "-") || (ticketRaw !== "" && ticketRaw !== "-" && ticketRaw !== "N/A");
          
          if (hasRealData) {
            bbList.push({
              "P": provinceRaw.replace(/_/g, " "),
              "T": ticketRaw || "-",
              "S": serviceRaw,
              "I": impactRaw || "-",
              "IS": issueRaw || "-",
              "DT": downtimeRaw || "-",
              "AG": agingRaw || "-",
              "L": linksRaw || "-",
              "LC": countLinks,
              "RM": remarksRaw
            });
          }
        }
        resultData = bbList;
      }
    }

  } else if (type === "node") {
    // ---------------- NODE DOWN DATA ----------------
    var nodeSheet = ss.getSheetByName("Node DOWN Tickets");
    if (!nodeSheet) {
      resultData = [];
    } else {
      var lastRowNode = nodeSheet.getLastRow();
      if (lastRowNode < 2) {
        resultData = [];
      } else {
        // Kumuha ng 27 columns (hanggang Column AA)
        var nodeData = nodeSheet.getRange(2, 1, lastRowNode - 1, 27).getValues();
        var nodeList = [];

        for (var n = 0; n < nodeData.length; n++) {
          var rowN = nodeData[n];
          var provinceRaw = String(rowN[COL.NODE_PROVINCE] || "").trim();
          var nodesRaw = String(rowN[COL.NODE_EQUIPMENT] || "").trim();

          if (provinceRaw !== "" || nodesRaw !== "") {
            nodeList.push({
              "P": provinceRaw.replace(/_/g, " "),
              "N": nodesRaw || "N/A",
              "C": rowN[COL.NODE_COUNT] !== "" ? rowN[COL.NODE_COUNT] : 0,
              "I": rowN[COL.NODE_IMPACT] || "N/A",
              "D": rowN[COL.NODE_DOWNTIME] ? formatDateVal(rowN[COL.NODE_DOWNTIME]) : "N/A",
              "AG": rowN[COL.NODE_AGING] || "N/A",
              "RM": rowN[COL.NODE_REMARKS] ? String(rowN[COL.NODE_REMARKS]).trim() : "-"
            });
          }
        }
        resultData = nodeList;
      }
    }
  
  } else if (type === "lcp") {
    // ---------------- LCP DATA ----------------
    var lcpSheet = ss.getSheetByName("NLZ LCP Report");
    if (!lcpSheet) {
      resultData = { lcpAging: [], lcpImpact: [] };
    } else {
      var agingRaw = lcpSheet.getRange("G24:L39").getValues();
      var lcpAging = [];
      for (var i = 0; i < agingRaw.length; i++) {
        var rowA = agingRaw[i];
        var area = rowA[0] ? String(rowA[0]).trim() : "";
        if (area !== "" && area.toUpperCase() !== "TOTAL") {
          lcpAging.push({
            "A": area,
            "P": rowA[1],
            "H": rowA[2],
            "D1": rowA[3],
            "D3": rowA[4],
            "T": rowA[5]
          });
        }
      }

      var impactRaw = lcpSheet.getRange("G2:K18").getValues();
      var lcpImpact = [];
      for (var j = 1; j < impactRaw.length; j++) {
        var rowI = impactRaw[j];
        var impArea = rowI[0] ? String(rowI[0]).trim() : "";
        if (impArea !== "" && impArea.toUpperCase() !== "TOTAL") {
          lcpImpact.push({
            "A": impArea,
            "P": rowI[1],
            "TT": rowI[2],
            "LCP": rowI[3],
            "C": rowI[4]
          });
        }
      }
      resultData = { "lcpAging": lcpAging, "lcpImpact": lcpImpact };
    }

  } else if (type === "olt") {
// ---------------- OLT DATA ----------------
var oltSheet = ss.getSheetByName("NLZ OLT Report");
if (!oltSheet) {
  resultData = [];
} else {
  var lastRowOlt = oltSheet.getLastRow();
  if (lastRowOlt < 3) {
    resultData = [];
  } else {
    var oltData = oltSheet.getRange(3, 2, lastRowOlt - 2, 12).getValues(); 
    var oltList = [];

    var agingMap = {};
    var remarksMap = {};
    var causeMap = {};
    var clientsMap = {}; // Fallback: total clients per ticket
    var oltClientsMap = {}; // NEW: per-OLT client lookup { ticketKey: { oltName: count } }
    
    var ticketSheet = ss.getSheetByName("OLT DOWN Tickets");
    if (ticketSheet) {
      var lastRowTix = ticketSheet.getLastRow();
      if (lastRowTix >= 2) {
        var tixData = ticketSheet.getRange(2, 1, lastRowTix - 1, 28).getValues();
        for (var t = 0; t < tixData.length; t++) {
          var ticketNoRaw = tixData[t][COL.OLT_TICKET_NO];
          var causeRaw = tixData[t][COL.OLT_CAUSE];
          var remarksRaw = tixData[t][COL.OLT_REMARKS];
          var agingRaw = tixData[t][COL.OLT_AGING];
          var clientsRaw = tixData[t][COL.OLT_CLIENTS];
          var oltsRaw = tixData[t][COL.OLT_NAMES_AB];
          
          if (ticketNoRaw && String(ticketNoRaw).trim() !== "") {
            var tKey = String(ticketNoRaw).trim().toUpperCase();
            agingMap[tKey] = agingRaw ? String(agingRaw).trim() : "-";
            remarksMap[tKey] = remarksRaw ? String(remarksRaw).trim() : "-";
            causeMap[tKey] = causeRaw ? String(causeRaw).trim() : "-";
            clientsMap[tKey] = clientsRaw !== "" && clientsRaw !== null ? String(clientsRaw).trim() : "0";
            
            // NEW: Build per-OLT client map from breakline format
            var oltNames = String(oltsRaw || "").split("\n").map(function(s) { return s.trim(); }).filter(function(s) { return s; });
            var clientCounts = String(clientsRaw || "").split("\n").map(function(s) { return s.trim(); }).filter(function(s) { return s; });
            var perOltMap = {};
            for (var p = 0; p < oltNames.length; p++) {
              var oltKey = oltNames[p].toUpperCase();
              perOltMap[oltKey] = parseInt(clientCounts[p]) || 0;
            }
            oltClientsMap[tKey] = perOltMap;
          }
        }
      }
    }

    for (var k = 0; k < oltData.length; k++) {
      var rowO = oltData[k];
      var oltName = rowO[2];

      if (oltName && String(oltName).trim() !== "" && String(oltName).toUpperCase() !== "TOTAL") {
        var status = "UP";
        var ticketNo = "N/A";

        if (rowO[4] === true) {
          status = "DOWN";
          ticketNo = rowO[8] || "N/A";
        } else if (rowO[5] === true) {
          status = "OLT UPLINK LOW POWER";
          ticketNo = rowO[9] || "N/A"; 
        } else if (rowO[6] === true) {
          status = "OLT UPLINK DOWN";
          ticketNo = rowO[10] || "N/A"; 
        } else if (rowO[7] === true) {
          status = "OLT SERVICE DEGRADATION";
          ticketNo = rowO[11] || "N/A"; 
        }

        var aging = "-";
        var remarks = "-";
        var downtimeCause = "-";
        var clientsAffected = "0";

        if (status !== "UP" && ticketNo && ticketNo !== "N/A") {
          var tKey = String(ticketNo).trim().toUpperCase();
          if (agingMap[tKey]) aging = agingMap[tKey];
          if (remarksMap[tKey]) remarks = remarksMap[tKey];
          if (causeMap[tKey]) downtimeCause = causeMap[tKey];
          
          // NEW: Look up by OLT name (not just ticket total) to avoid double-counting
          var perOlt = oltClientsMap[tKey] || {};
          var oltLookupKey = String(oltName).trim().toUpperCase();
          if (perOlt.hasOwnProperty(oltLookupKey)) {
            clientsAffected = String(perOlt[oltLookupKey]);
          } else if (clientsMap[tKey]) {
            clientsAffected = clientsMap[tKey]; // Fallback
          }
        }

        oltList.push({
          "P": rowO[0],
          "M": rowO[1],
          "N": oltName,
          "S": status,
          "T": ticketNo,
          "AG": aging,
          "RM": remarks,
          "DC": downtimeCause,
          "CA": clientsAffected
        });
      }
    }
    resultData = oltList;
  }
}

  } else {
    // ---------------- NAP DATA (DEFAULT) ----------------
    var napSheet = ss.getSheetByName("NLZ NAP Report");
    if (!napSheet) {
      resultData = [];
    } else {
      var napRaw = napSheet.getRange("H2:M19").getValues(); 
      var napList = [];

      for (var r = 1; r < napRaw.length; r++) {
        var rowN = napRaw[r];
        var areaNap = rowN[0] ? String(rowN[0]).trim() : "";
        if (areaNap !== "" && areaNap.toUpperCase() !== "TOTAL") {
          napList.push({
            "A": rowN[0],
            "P": rowN[1],
            "H": rowN[2],
            "D1": rowN[3],
            "D3": rowN[4],
            "T": rowN[5]
          });
        }
      }
      resultData = napList;
    }
  }

// ---------------- SAVE TO CACHE (Dynamic TTL per Type) ----------------
  var jsonResponse = JSON.stringify(resultData);
  var payloadSize = jsonResponse.length;
  
  // Differentiable TTL: 60s para sa critical tickets, 180s para sa summaries
  var cacheTTL = (type === "node" || type === "olt" || type === "backbone") ? 60 : 180;
  var cacheKey = "cache_v2_" + type;

  try {
    // CacheService limit: 100KB per key
    // PropertiesService limit: 500KB per property (fallback for large payloads)
    if (payloadSize <= 90000) {
      cache.put(cacheKey, jsonResponse, cacheTTL);
    } else if (payloadSize <= 450000) {
      // Fallback: Use PropertiesService for large payloads (e.g., OLT with 460+ rows)
      var props = PropertiesService.getScriptProperties();
      props.setProperty(cacheKey, jsonResponse);
      Logger.log("Cache overflow fallback: " + type + " using PropertiesService (" + payloadSize + " bytes)");
    } else {
      Logger.log("WARNING: Payload too large for any cache: " + type + " (" + payloadSize + " bytes)");
    }
  } catch (err) {
    Logger.log("Caching failed: " + err.message);
  }

  return ContentService.createTextOutput(jsonResponse)
    .setMimeType(ContentService.MimeType.JSON);
}


function doPost(e) {
  var payload = JSON.parse(e.postData.contents);
  var action = payload.action || "";

  if (action === "login") {
    var username = String(payload.username || "").trim().toLowerCase();
    var password = String(payload.password || "").trim();

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var usersSheet = ss.getSheetByName("Users");
    if (!usersSheet) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Users sheet not found" })).setMimeType(ContentService.MimeType.JSON);
    }

    var lastRow = usersSheet.getLastRow();
    if (lastRow < 2) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: "No users configured" })).setMimeType(ContentService.MimeType.JSON);
    }

    var usersData = usersSheet.getRange(2, 1, lastRow - 1, 4).getValues(); // Columns A-D
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

  return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Unknown action" })).setMimeType(ContentService.MimeType.JSON);
}

// SHA-256 hash function for password verification
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

// Helper: Generate password hash (run once to set up users)
function generateHash(plainTextPassword) {
  var hash = sha256(plainTextPassword);
  Logger.log('Password: ' + plainTextPassword);
  Logger.log('Hash: ' + hash);
  return hash;
}

function formatDateVal(d) {
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "MM/dd/yyyy HH:mm:ss");
  }
  return String(d);
}