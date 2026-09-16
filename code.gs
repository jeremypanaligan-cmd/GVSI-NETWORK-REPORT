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
  NODE_TICKET: 5,        // F (Index 5)
  NODE_CAUSE: 6,         // G (Index 6)
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

  // OLT is 461 rows x 9 fields and was 96.9% of every API byte the app moved.
  // `shape=2` asks for the compact form: province and municipality become indices
  // into two dictionaries, and each row becomes a positional array whose field
  // order is carried in the payload itself, so the two sides cannot drift apart.
  // Measured from the live sheet: 50,179 -> 26,258 bytes (52%), same 461 rows.
  //
  // The legacy shape stays the default and gets its OWN cache entry, so a client
  // that has not reloaded yet is unaffected and the two shapes can never be served
  // to the wrong caller — the OLT payload is cached, and a cache hit is returned
  // before anything else looks at `shape`. Drop the legacy branch once every client
  // sends shape=2.
  var oltShapeParam = (type === "olt" && e && e.parameter && e.parameter.shape) ? parseInt(e.parameter.shape, 10) : 1;
  var oltShape = (oltShapeParam === 2 || oltShapeParam === 3) ? oltShapeParam : 1;

  // ---------------- ROUTING: Login, Admin, Keep-Alive ----------------
  // All handled by admin.gs functions
  if (action === "login")          return handleLogin(e);
  if (action === "logout")         return handleLogout(e);
  if (action === "keepalive")      return handleKeepAlive();
  if (action === "getSettings")    return handleGetSettings(e);
  if (action === "setMaintenance") return handleSetMaintenance(e);
  // An action we do NOT recognise must never fall through to the data branch below:
  // `type` defaults to "nap" there, so a typo — or a route that has been RETIRED, as
  // the presence routes were (heartbeat / getActiveUsers / removeActiveUser) — would
  // silently answer with a full NAP payload. That is the heaviest branch in the app,
  // and a device still holding the previous shell would spend it, once a minute, on a
  // response it never reads.
  if (action) {
    return jsonOut({ error: "Unknown action: " + action });
  }

  // ---------------- DATA FETCHING ----------------
  // ---------------- 1. Cache Check ----------------
  var cache = CacheService.getScriptCache();
  var cacheKey = "cache_v2_" + type + (oltShape >= 2 ? "_c" + oltShape : "");

  // Differentiable TTL: 60s para sa critical tickets, 180s para sa summaries
  var cacheTTL = (type === "node" || type === "olt" || type === "backbone") ? 60 : 180;

  // PropertiesService has no TTL of its own, so a payload stored there is
  // stamped with its write time and expired here by hand.
  var PROP_TS_KEY = cacheKey + "_cached_at";

  try {
    // Try CacheService first (100KB limit)
    var cachedData = cache.get(cacheKey);
    if (cachedData) {
      return ContentService.createTextOutput(cachedData)
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Fallback: PropertiesService (500KB limit) for payloads too big for
    // CacheService. Nothing expires these on its own, so a missing stamp counts
    // as expired and anything older than cacheTTL is dropped — otherwise one
    // oversized payload would be served forever and silently freeze a module.
    var props = PropertiesService.getScriptProperties();
    var propData = props.getProperty(cacheKey);
    if (propData) {
      var cachedAt = Number(props.getProperty(PROP_TS_KEY)) || 0;
      var ageSeconds = (Date.now() - cachedAt) / 1000;
      if (cachedAt > 0 && ageSeconds < cacheTTL) {
        return ContentService.createTextOutput(propData)
          .setMimeType(ContentService.MimeType.JSON);
      }
      props.deleteProperty(cacheKey);
      props.deleteProperty(PROP_TS_KEY);
      Logger.log("Stale PropertiesService cache dropped for " + type +
                 " (age " + Math.round(ageSeconds) + "s, ttl " + cacheTTL + "s)");
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
              "T": rowN[COL.NODE_TICKET] ? String(rowN[COL.NODE_TICKET]).trim() : "-",
              "DC": rowN[COL.NODE_CAUSE] ? String(rowN[COL.NODE_CAUSE]).trim() : "-",
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
    // Compute meta summary for the compact shapes
    var oltMeta = { total: oltList.length, up: 0, down: 0, lowPower: 0, uplinkDown: 0, degradation: 0, clientsDown: 0 };
    for (var oi = 0; oi < oltList.length; oi++) {
      var os = oltList[oi].S;
      if (os === "UP") oltMeta.up++;
      else if (os === "DOWN") { oltMeta.down++; oltMeta.clientsDown += parseInt(oltList[oi].CA) || 0; }
      else if (os && os.indexOf("LOW POWER") !== -1) oltMeta.lowPower++;
      else if (os && os.indexOf("UPLINK DOWN") !== -1) oltMeta.uplinkDown++;
      else if (os && os.indexOf("DEGRADATION") !== -1) oltMeta.degradation++;
    }

    if (oltShape === 3) {
      // Problem-only rows: filter out UP OLTs, return compact with meta summary
      var problemRows = oltList.filter(function(row) { return row.S !== "UP"; });
      var compact = compactOltRows(problemRows);
      resultData = { v: 3, f: compact.f, p: compact.p, m: compact.m, meta: oltMeta, r: compact.r };
    } else if (oltShape === 2) {
      resultData = compactOltRows(oltList);
    } else {
      resultData = oltList;
    }
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
  
  try {
    // CacheService limit: 100KB per key
    // PropertiesService limit: 500KB per property (fallback for large payloads)
    if (payloadSize <= 90000) {
      cache.put(cacheKey, jsonResponse, cacheTTL);

      // If this module previously overflowed into PropertiesService it may have
      // left a copy behind. Clear it, or that never-expiring copy would outlive
      // this fresh write and keep being served.
      var propsToClear = PropertiesService.getScriptProperties();
      if (propsToClear.getProperty(cacheKey)) {
        propsToClear.deleteProperty(cacheKey);
        propsToClear.deleteProperty(PROP_TS_KEY);
      }
    } else if (payloadSize <= 450000) {
      // Fallback for payloads too big for CacheService (e.g. OLT with 460+ rows).
      // These entries never expire, so stamp the write time — the read path
      // above enforces cacheTTL against it.
      var props = PropertiesService.getScriptProperties();
      props.setProperty(cacheKey, jsonResponse);
      props.setProperty(PROP_TS_KEY, String(Date.now()));
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

/* The response fields of an OLT row, in the order the compact shape positions
   them. Sent as `f` in the payload so the client reads the order rather than
   assuming it — a hardcoded copy on each side is exactly how a field swap would
   go unnoticed.

   The order is the one the legacy objects are built in above, so a decoded row is
   not merely equal to a legacy row but identical to it key-for-key. That keeps the
   round trip provable by string comparison (see tests/olt-payload.test.js). */
var OLT_ROW_FIELDS = ["P", "M", "N", "S", "T", "AG", "RM", "DC", "CA"];

/* Fields replaced by an index into a dictionary. Keys are the dictionary names. */
var OLT_DICT_FIELDS = { "P": "p", "M": "m" };

/*
  Encode OLT rows for the wire: { v, f, p, m, r }

    v   shape version
    f   field order for every row in r
    p   province dictionary   (index -> name)
    m   municipality dictionary
    r   rows, each an array of values in `f` order

  Why both a dictionary AND positional rows: province and municipality repeat across
  461 rows, but so does every field NAME. Measured on the live sheet, the repeated
  keys alone were 14,291 bytes (28% of the payload) and the two name columns another
  ~8,000. The dictionary by itself only takes the payload to 89%; the positional rows
  are what get it to 52%. Same rows, same values, no aggregation.

  Dictionary lookups are prefixed so a value like "constructor" or "__proto__" can
  never collide with something on Object.prototype.
*/
function compactOltRows(rows) {
  if (!rows || !rows.length) return { v: 2, f: OLT_ROW_FIELDS, p: [], m: [], r: [] };

  var dictionaries = { p: [], m: [] };
  var indexes = { p: {}, m: {} };

  function intern(dictName, value) {
    var key = "k" + String(value === null || value === undefined ? "" : value);
    if (!Object.prototype.hasOwnProperty.call(indexes[dictName], key)) {
      indexes[dictName][key] = dictionaries[dictName].length;
      dictionaries[dictName].push(key.slice(1));
    }
    return indexes[dictName][key];
  }

  var compact = [];
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var out = [];
    for (var c = 0; c < OLT_ROW_FIELDS.length; c++) {
      var field = OLT_ROW_FIELDS[c];
      var dict = OLT_DICT_FIELDS[field];
      out.push(dict ? intern(dict, row[field]) : row[field]);
    }
    compact.push(out);
  }

  return { v: 2, f: OLT_ROW_FIELDS, p: dictionaries.p, m: dictionaries.m, r: compact };
}

function formatDateVal(d) {
  if (d instanceof Date) {
    return Utilities.formatDate(d, Session.getScriptTimeZone(), "MM/dd/yyyy HH:mm:ss");
  }
  return String(d);
}