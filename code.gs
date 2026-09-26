// ==================== COLUMN INDEX CONSTANTS ====================
// Prevents breakage when sheet structure changes
var COL = {
  // OLT DOWN Tickets (Columns A-AB)
  OLT_PROVINCE: 0,       // A
  OLT_MUNICIPALITY: 1,   // B
  OLT_NAME: 2,           // C
  OLT_TICKET_NO: 5,      // F
  OLT_CAUSE: 6,          // G
  OLT_IMPACT: 10,        // K (Index 10) — same column NODE_IMPACT and BB_IMPACT read
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

function doGet(e, warmTtlOverride) {
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
  var oltShape = (oltShapeParam === 2 || oltShapeParam === 3 || oltShapeParam === 4) ? oltShapeParam : 1;

  // ---------------- ROUTING: Login, Admin, Keep-Alive ----------------
  // All handled by admin.gs functions
  if (action === "login")          return handleLogin(e);
  if (action === "logout")         return handleLogout(e);
  if (action === "keepalive")      return handleKeepAlive();
  if (action === "getSettings")    return handleGetSettings(e);
  if (action === "setMaintenance") return handleSetMaintenance(e);
  /* Read-only, admin-gated and manual only. Nothing here is polled: a diagnostics card
     that refreshed itself would be the load it exists to measure. See diagnostics.gs. */
  if (action === "diag") {
    /* Two separate pastes. An admin who curls this before pasting diagnostics.gs should get
       an envelope that says so, not an HTML error page. */
    if (typeof handleDiagnostics !== 'function') {
      return jsonOut({ error: "diagnostics_unavailable", retryable: false });
    }
    return handleDiagnostics(e);
  }
  // Data-freshness revision. One PropertiesService read, no sheet access, no
  // build — cheap enough for the app to poll, and the only thing it can learn
  // from it is that the sheet changed, which is already public in the data
  // routes below.
  if (action === "rev")            return handleGetRev();
  /* The whole opening of the app, in one execution and one round trip. Additive: a client
     that does not know this route is unaffected, and a client that asks an older
     deployment for it gets the unknown-action envelope below and falls back to the five
     routes it used before. See handleBundle(). */
  if (action === "bundle")         return handleBundle();
  // An action we do NOT recognise must never fall through to the data branch below:
  // `type` defaults to "nap" there, so a typo — or a route that has been RETIRED, as
  // the presence routes were (heartbeat / getActiveUsers / removeActiveUser) — would
  // silently answer with a full NAP payload. That is the heaviest branch in the app,
  // and a device still holding the previous shell would spend it, once a minute, on a
  // response it never reads.
  //
  // `retryable: false` for the same reason the build guard says true: a route that
  // no longer exists cannot start existing, so the client must spend ONE request on
  // it rather than the whole retry budget. fetchWithRetry() reads this field and is
  // the only part of the app that does.
  if (action) {
    return jsonOut({ error: "Unknown action: " + action, retryable: false });
  }

  /* The `type` parameter has the same hole the action guard above closes, and it
     is worth closing the same way.

     `type` defaults to "nap" a few lines up, and the branch chain below ends in
     an unfiltered `else` — the NAP default. So a typo, or a type that has been
     renamed (the OLT sheet is called "NLZ OLT Report", which invites
     ?type=oltreport), is answered with the full NAP payload: the heaviest branch
     in the app, once a cycle per device, for a response its caller never reads.
     Because nothing warms a key for a type that does not exist, each of those
     requests also paid a cold build.

     DATA_TYPES is not a new list. It is the one the invalidation trigger and the
     rev route already share, so this check cannot drift from them. */
  if (DATA_TYPES.indexOf(type) === -1) {
    Logger.log("Unknown type: " + type);
    return jsonOut({ error: "Unknown type: " + type, type: type, retryable: false });
  }

  // ---------------- DATA FETCHING ----------------
  // ---------------- 1. Cache Check ----------------
  var cache = CacheService.getScriptCache();
  var cacheKey = cacheKeyFor_(type, oltShape);

  // Differentiable TTL: 60s para sa critical tickets, 180s para sa summaries.
  // Stated once, in cacheTtlFor_(): the bundle route below has to judge an expired
  // PropertiesService entry by the same number, and two copies of this rule is how the two
  // routes would come to disagree about whether a payload is still alive.
  var cacheTTL = cacheTtlFor_(type);

  /* ---------------- REBUILD INTENT ----------------

     A cache HIT returns the stored bytes and never rewrites them, so nothing
     that arrives while an entry is alive can shorten its life. That is the
     whole of the 2026-09-18 lag: a DOWN ticket was deleted from the sheet at
     14:06:09 and the dashboard still showed it at 14:17:09. The warmer had
     written a 1080 s entry at ~13:59, every app refresh in between was a hit,
     and only the TTL running out produced a fresh build — the app was asking
     more often than the server was allowed to answer differently.

     Freshness therefore needs a way to say "do not read the cache this time",
     and exactly two callers are allowed to say it:

     1. THE WARMER, through the second positional argument. That argument is
        unreachable over HTTP: Apps Script's entry point calls doGet(e) with the
        query-string event and nothing else, so `e.parameter.*` is the only
        channel a caller controls. The override now means BOTH "write with this
        longer TTL" AND "rebuild now". Without the second half a warm run that
        arrives while the previous entry is still alive does nothing at all —
        it returns the hit and exits — so a warmer whose interval is shorter
        than the TTL it sets would refresh on every OTHER run, and the schedule
        the header promises would quietly not be the schedule in force.
        Clamped to 30 minutes so a bad caller cannot pin the cache indefinitely.

     2. ?fresh=1, for the app's REFRESH button, rate-limited per type by
        claimForcedRebuild() — see the note there for why the worst case this
        admits is the behaviour the app had before the warmer existed. */
  var rebuildNow = false;

  if (warmTtlOverride > 0 && warmTtlOverride <= 1800) {
    cacheTTL = warmTtlOverride;
    rebuildNow = true;
  } else if (String((e && e.parameter && e.parameter.fresh) || "") === "1") {
    rebuildNow = claimForcedRebuild(type);
  }

  // PropertiesService has no TTL of its own, so a payload stored there is
  // stamped with its write time and expired here by hand.
  var PROP_TS_KEY = propStampKey_(cacheKey);

  try {
    // Try CacheService first (100KB limit)
    // A rebuild intent must reach the sheet: both reads below are skipped for it,
    // which is what lets the warmer and the REFRESH button produce a genuinely
    // fresh payload instead of another hit.
    var cachedData = rebuildNow ? null : cache.get(cacheKey);
    if (cachedData) {
      return ContentService.createTextOutput(cachedData)
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Fallback: PropertiesService (500KB limit) for payloads too big for
    // CacheService. Nothing expires these on its own, so a missing stamp counts
    // as expired and anything older than cacheTTL is dropped — otherwise one
    // oversized payload would be served forever and silently freeze a module.
    var props = PropertiesService.getScriptProperties();
    var propData = rebuildNow ? null : props.getProperty(cacheKey);
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

  /* The handle itself can fail, and it is the FIRST thing every build does — so
     it needs the same net as the reads below it rather than sitting above the
     guard. When it throws, Apps Script answers with an HTML error page. */
  /* Opens the build: records where it is, before anything can throw. */
  beginBuild_(type);

  var ss;
  try {
    ss = SpreadsheetApp.getActiveSpreadsheet();
  } catch (handleErr) {
    return buildFailedOut_(type, handleErr);
  }

  var resultData = null;

  /* Revision of this module's data at the moment the build started — captured
     BEFORE the first sheet read, so the write path below can tell whether an
     edit landed while this build was reading. */
  buildStage_("revision");
  /* dataRevOf_ swallows its own failure and answers 0, so this read cannot throw
     — it only records the revision the build started against. */
  var buildStartRev = dataRevOf_(type);
  buildCtx_.rev = buildStartRev;

  /* ---------------- BUILD GUARD ----------------

     Everything from here to the cache write below reads the spreadsheet, and it
     was the only part of doGet with no net under it: the cache read above is
     wrapped and the cache write below is wrapped, so a failure in either of
     those costs a cache — while a failure HERE escaped the function entirely.

     What Apps Script does with an escaped exception is not an error response. It
     is an HTML error page (measured: ~8 KB of markup, which also arrived as a 404
     through the googleusercontent echo hop). The app asks for JSON, so res.json()
     threw on it, and because the shared fetch gate had cut every module down to a
     single attempt, one transient hiccup was a module with no data at all —
     the failure mode that was mistaken for a bad deployment URL.

     A Sheets read is exactly what fails transiently here: up to 461 rows behind a
     filtered QUERY view, racing the triggers that write to the same sheets.

     This guard turns that into an ANSWER instead of a page. Apps Script cannot
     set an HTTP status on a web app response — every reply is a 200 — so
     `retryable` is the only channel that can distinguish "this was a hiccup, ask
     again" from "this request was wrong". It is read in exactly one place:
     fetchWithRetry() in index.html. */
  try {

if (type === "backbone") {
    // ---------------- BACKBONE LINKS DATA ----------------
    var bbSheet = openSheet_(ss, "backbone", "Backbone Tickets");
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
    var nodeSheet = openSheet_(ss, "node", "Node DOWN Tickets");
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
    var lcpSheet = openSheet_(ss, "lcp", "NLZ LCP Report");
    if (!lcpSheet) {
      resultData = { lcpAging: [], lcpImpact: [] };
    } else {
      var agingRaw = lcpSheet.getRange("A24:F39").getValues();
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

      var impactRaw = lcpSheet.getRange("A2:F18").getValues();
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
var oltSheet = openSheet_(ss, "olt", "NLZ OLT Report");
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
    var impactMap = {}; // Ticket-level IMPACT (Column K): SA = service affecting
    var clientsMap = {}; // Fallback: total clients per ticket
    var oltClientsMap = {}; // NEW: per-OLT client lookup { ticketKey: { oltName: count } }
    
    var ticketSheet = openSheet_(ss, "olt-tickets", "OLT DOWN Tickets");
    if (ticketSheet) {
      var lastRowTix = ticketSheet.getLastRow();
      if (lastRowTix >= 2) {
        var tixData = ticketSheet.getRange(2, 1, lastRowTix - 1, 28).getValues();
        for (var t = 0; t < tixData.length; t++) {
          var ticketNoRaw = tixData[t][COL.OLT_TICKET_NO];
          var causeRaw = tixData[t][COL.OLT_CAUSE];
          var impactRaw = tixData[t][COL.OLT_IMPACT];
          var remarksRaw = tixData[t][COL.OLT_REMARKS];
          var agingRaw = tixData[t][COL.OLT_AGING];
          var clientsRaw = tixData[t][COL.OLT_CLIENTS];
          var oltsRaw = tixData[t][COL.OLT_NAMES_AB];
          
          if (ticketNoRaw && String(ticketNoRaw).trim() !== "") {
            var tKey = String(ticketNoRaw).trim().toUpperCase();
            agingMap[tKey] = agingRaw ? String(agingRaw).trim() : "-";
            remarksMap[tKey] = remarksRaw ? String(remarksRaw).trim() : "-";
            causeMap[tKey] = causeRaw ? String(causeRaw).trim() : "-";
            impactMap[tKey] = impactRaw ? String(impactRaw).trim().toUpperCase() : "-";
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
        var impact = "-";

        if (status !== "UP" && ticketNo && ticketNo !== "N/A") {
          var tKey = String(ticketNo).trim().toUpperCase();
          if (agingMap[tKey]) aging = agingMap[tKey];
          if (remarksMap[tKey]) remarks = remarksMap[tKey];
          if (causeMap[tKey]) downtimeCause = causeMap[tKey];
          if (impactMap[tKey]) impact = impactMap[tKey];
          
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
          "CA": clientsAffected,
          "IM": impact
        });
      }
    }
    // Compute meta summary for the compact shapes
    var oltMeta = { total: oltList.length, up: 0, down: 0, lowPower: 0, uplinkDown: 0, degradation: 0, clientsDown: 0, clientsSA: 0 };
    for (var oi = 0; oi < oltList.length; oi++) {
      var os = oltList[oi].S;
      if (os === "UP") oltMeta.up++;
      else if (os === "DOWN") { oltMeta.down++; oltMeta.clientsDown += parseInt(oltList[oi].CA) || 0; }
      else if (os && os.indexOf("LOW POWER") !== -1) oltMeta.lowPower++;
      else if (os && os.indexOf("UPLINK DOWN") !== -1) oltMeta.uplinkDown++;
      else if (os && os.indexOf("DEGRADATION") !== -1) oltMeta.degradation++;

      /* Affected Clients (SA) is scoped by the TICKET's IMPACT, not by the row's status,
         so it is accumulated BESIDE the status chain rather than inside one of its arms —
         an OLT sitting in LOW POWER whose ticket is SA counts, and a DOWN ticket marked
         NSA does not. clientsDown keeps its own meaning: the Analytics tab and the daily
         snapshot in db.js still read it, and a snapshot is never corrected after the
         fact, so changing what that number means would rewrite history. */
      if (os !== "UP" && String(oltList[oi].IM || "").toUpperCase() === "SA") {
        oltMeta.clientsSA += parseInt(oltList[oi].CA) || 0;
      }
    }

    /* When this payload was built. It rides INSIDE the cached bytes, so a cache
       HIT reports the original build time instead of the time of the hit — the
       only way a client can tell how old the picture it is looking at really
       is. Without it, a stale snapshot is indistinguishable from a fresh one,
       which is how a deleted ticket stayed on screen for 11 minutes with a
       "just updated" chip under it.

       Deliberately NOT a per-request stamp on the response envelope: that would
       have to be added outside the cached string and would therefore report the
       hit, not the build — exactly backwards. */
    var builtAtMs = Date.now();
    oltMeta.builtAt = builtAtMs;

    if (oltShape === 4) {
      /* Lazy healthy-fleet drill-down. The ordinary dashboard remains shape=3,
         so UP rows move over the wire only after an operator asks for them. */
      var upRows = oltList.filter(function(row) { return row.S === "UP"; });
      var upCompact = compactOltRows(upRows);
      resultData = { v: 4, f: upCompact.f, p: upCompact.p, m: upCompact.m,
                     meta: oltMeta, r: upCompact.r };
    } else if (oltShape === 3) {
      // Problem-only rows: filter out UP OLTs, return compact with meta summary
      var problemRows = oltList.filter(function(row) { return row.S !== "UP"; });
      var compact = compactOltRows(problemRows);
      resultData = { v: 3, f: compact.f, p: compact.p, m: compact.m, meta: oltMeta, r: compact.r };
    } else if (oltShape === 2) {
      resultData = compactOltRows(oltList);
      // Sibling key on the compact envelope: decodeOltCompact reads only f/p/m/r.
      resultData.builtAt = builtAtMs;
    } else {
      resultData = oltList;
    }
  }
}

  } else {
    // ---------------- NAP DATA (DEFAULT) ----------------
    var napSheet = openSheet_(ss, "nap", "NLZ NAP Report");
    if (!napSheet) {
      resultData = [];
    } else {
      var napRaw = napSheet.getRange("A2:F19").getValues(); 
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

  } catch (buildErr) {
    return buildFailedOut_(type, buildErr);
  }

// ---------------- SAVE TO CACHE (Dynamic TTL per Type) ----------------
  var jsonResponse = JSON.stringify(resultData);
  var payloadSize = jsonResponse.length;
  
  try {
    /* A build can race an edit. Reading the sheet takes ~3-4 s, and an
       invalidation can land in the middle of it — and by then the cache is
       already empty, so writing this payload would put a pre-edit snapshot into
       a cache that was just cleared and the app would serve it for the full TTL.
       That is the 2026-09-18 failure re-created in a narrower window, so a build
       whose revision moved is not cached at all: this request still returns what
       it built (its caller is waiting), and the next reader rebuilds against a
       sheet that has stopped moving.

       Two property reads per build, against a 50,000/day quota. */
    var revMovedDuringBuild = dataRevOf_(type) !== buildStartRev;

    // CacheService limit: 100KB per key
    // PropertiesService limit: 500KB per property (fallback for large payloads)
    if (revMovedDuringBuild) {
      Logger.log("Cache write skipped for " + type +
                 ": the data revision moved while this build was reading (an edit landed mid-build).");
    } else if (payloadSize <= 90000) {
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

  /* THE SLOW-BUILD HOOK — the only line of this feature that runs on every build.

     It sits here because this is the one position every build passes through, after the
     cache write and before the response. It costs one integer comparison: the recorder
     compares against DIAG_SLOW_BUILD_MS and writes nothing below it, so a healthy build
     never touches the property store at all.

     A cache HIT never reaches this line — doGet returns at the top of the cache block,
     before beginBuild_() — so this is paid only on a MISS, which is the whole reason it
     is here rather than next to a successful build's first line.

     Known without being fixed here: this hook sits after the cache try/catch, so a missing
     diagnostics.gs cannot take the request down, and the loud-once warning below is what
     stops that from being a silent dead hook. tests/diagnostics.test.js asserts the five
     build-running suites load diagnostics.gs for the same reason. */
  if (typeof recordSlowBuild_ === 'function') {
    recordSlowBuild_(type, Date.now() - buildCtx_.startedAt, buildCtx_.stage, buildCtx_.sheet);
  } else if (!diagMissingWarned_) {
    diagMissingWarned_ = true;
    Logger.log("⚠️ diagnostics.gs is not deployed — the slow-build hook is inert");
  }

  return ContentService.createTextOutput(jsonResponse)
    .setMimeType(ContentService.MimeType.JSON);
}

/* ==================== BUILD DIAGNOSTICS ====================

   What a caught exception in a build does NOT carry: which sheet was being read,
   which branch was running, how long it had been running, and which revision the
   data was at. Those four are what turn "a build failed" into "look at this read
   on this sheet", and the Executions log is the only place they can be seen — so
   they are recorded as the build goes, and spent in one line when it fails.

   A module-level object rather than an argument threaded through six branches. An
   execution is single-threaded, and the one entry point that can build resets it
   first (beginBuild_), so a value can only ever describe the current build. */

var buildCtx_ = { type: "", stage: "", sheet: "", rev: 0, startedAt: 0 };

/* Said once per execution, not once per build: the slow-build hook is reached on every
   cache MISS, and a warning repeated five times a pass is a warning nobody reads. */
var diagMissingWarned_ = false;

function beginBuild_(type) {
  buildCtx_.type = type;
  buildCtx_.stage = "spreadsheet";
  buildCtx_.sheet = "";
  buildCtx_.rev = 0;
  buildCtx_.startedAt = Date.now();
}

function buildStage_(stage) {
  buildCtx_.stage = stage;
}

/* Every sheet lookup in the build goes through here, so each one both records
   where the build is and reports a sheet that is not there.

   A MISSING SHEET IS NOT AN EXCEPTION. Each branch answers [] for it, which is
   byte-for-byte what it answers when the sheet exists and holds no rows — so a
   renamed tab reads exactly like "no incidents today", and nothing said
   otherwise. That is not a build failure and never reached the failure log; it is
   logged here, because "which sheet is this module reading" is the same question
   in both cases.

   `stage` names the branch (or the part of one) the read belongs to, so the log
   can point at a read rather than at a module. */
function openSheet_(ss, stage, name) {
  buildCtx_.stage = stage;
  buildCtx_.sheet = name;
  /* A missing HANDLE is not a missing sheet. It means the build can read nothing
     at all, so it must not be reported as an empty payload for this one module —
     that is the silent-empty answer this helper exists to remove. Thrown, with
     the sheet that could not be reached named, rather than left to surface as
     "Cannot read properties of null" three frames deeper. */
  if (!ss) throw new Error("No spreadsheet handle while opening \"" + name + "\"");

  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    Logger.log("⚠️ Sheet not found: \"" + name + "\" (type=" + buildCtx_.type +
               ", stage=" + stage + ") — answering with an empty payload, exactly" +
               " as it would if the sheet were there and empty.");
  }
  return sheet;
}

/* One shape for "the build could not run", used by both guards in doGet: the
   spreadsheet handle and the reads that follow it.

   Two callers, one envelope, so the client has a single thing to classify. The
   field that matters is `retryable`, and it exists because Apps Script CANNOT
   set an HTTP status on a web app response — every reply is a 200 — so the
   status line can never carry this. `true` means "a transient condition; the
   same request can succeed in a moment", and fetchWithRetry() in index.html is
   the only reader that acts on it.

   The exception text is passed through rather than hidden. The endpoint is
   already behind the app's session token, and this string is the only thing that
   separates "Sheets service is temporarily unavailable" from "Cannot read
   properties of null" in a log — two failures that want different responses from
   whoever reads it.

   What is LOGGED is deliberately richer than what is SENT. The response carries
   only what the client classifies on; everything that pins a failure to a place —
   the stage, the sheet, the revision, the elapsed time, the first stack frames —
   goes to the Executions log, where the next reader is looking for the cause. The
   envelope is a contract with fetchWithRetry() in index.html and does not grow
   fields for diagnostics. */
function buildFailedOut_(type, err) {
  var msg = String((err && err.message) || err || "unknown");
  var elapsedMs = buildCtx_.startedAt ? (Date.now() - buildCtx_.startedAt) : 0;

  Logger.log("❌ Build failed" +
             " | type=" + type +
             " | stage=" + (buildCtx_.stage || "unknown") +
             " | sheet=\"" + (buildCtx_.sheet || "(none)") + "\"" +
             " | rev=" + (buildCtx_.rev || "(unread)") +
             " | after " + elapsedMs + "ms" +
             " | " + msg);

  /* The message says what broke; the first stack frames say WHERE, which is the
     difference between "Cannot read properties of null" on a sheet read and the
     same words on a row loop. Three frames is enough to tell those apart, and
     short enough to stay one log entry. */
  if (err && err.stack) {
    var frames = String(err.stack).split("\n").slice(1, 4).join(" | ").replace(/\s+/g, " ").trim();
    if (frames) Logger.log("   frames: " + frames);
  }

  /* The same facts as the line above, made readable over HTTP instead of only from the
     Executions page — see diagnostics.gs. Guarded on existence because the two files are
     separate pastes: a code.gs without diagnostics.gs must still answer the caller, and
     must say it is not recording rather than being quietly inert. */
  if (typeof recordBuildFailure_ === 'function') {
    recordBuildFailure_(type, {
      message: msg,
      stage: buildCtx_.stage,
      sheet: buildCtx_.sheet,
      rev: buildCtx_.rev,
      elapsedMs: elapsedMs
    });
  } else {
    Logger.log("⚠️ diagnostics.gs is not deployed — this failure was logged but not recorded");
  }

  return jsonOut({
    error: "build_failed",
    type: type,
    message: msg,
    retryable: true
  });
}

/* ==================== DATA FRESHNESS ====================

   Freshness for a cache-first read path is not a TTL problem, it is a
   notification problem. The TTL only decides how often a MISS can happen; what
   the app sees is "the last build", and nothing tells it when that build went
   out of date. Three pieces make it observable:

     1. cache-invalidation.gs drops the cache for a module as soon as the sheet
        it reads is edited, so the NEXT request rebuilds. That is the real
        near-real-time path, and it costs one trigger run per edit.
     2. ?action=rev exposes a per-type counter that the same trigger bumps, so
        the app can learn that something changed without asking for 26 KB of
        data (or paying a cold build) to find out. One PropertiesService read,
        no spreadsheet access at all.
     3. meta.builtAt travels INSIDE the cached payload, so a hit can still be
        honest about its age. See the note where it is set, in the OLT branch.

   What the trigger cannot see, and why the warmer and the TTL still matter:
   Apps Script does not fire onEdit/onChange for its OWN writes ("Script
   executions and API requests don't cause triggers to run"), and it never fired
   for IMPORTRANGE recalculations — see the old note in triggers.gs. So a value
   that arrives by formula or by script has no invalidation at all, and is
   bounded only by the warm cadence. Both paths are needed; neither is enough.
*/

/* Every module the app can ask for, in one list. The invalidation trigger, the
   rev route and the rev payload all read it, so registering a module is one
   line here rather than three string lists that can drift apart. */
var DATA_TYPES = ["nap", "lcp", "olt", "node", "backbone"];

/* Cache keys a type can live under. OLT is the only type with variants: the
   legacy shape keeps the base key and compact shapes get one each. A stale
   variant left behind is still served to whichever client asks for it, so
   invalidation has to clear all three. */
function dataCacheKeysFor_(type) {
  return [
    "cache_v2_" + type,
    "cache_v2_" + type + "_c2",
    "cache_v2_" + type + "_c3",
    "cache_v2_" + type + "_c4"
  ];
}

/* How long one type must wait between forced rebuilds. */
var FORCE_FRESH_MIN_MS = 60000;

function forceFreshClaimKey_(type) {
  return "force_fresh_at_" + type;
}

/**
 * May this ?fresh=1 request skip the cache?
 *
 * The REFRESH button has to be able to mean it — a 3 s rebuild is a good trade
 * for an operator who is looking at an outage and wants the current picture.
 * What it must not become is a way to turn the dashboard into a rebuild loop,
 * so the claim is taken at most once per type per minute.
 *
 * The ceiling on abuse is therefore the behaviour the app had BEFORE the warmer
 * existed: one cold build per minute per type, on demand. The warmer never made
 * that impossible to reach — it only made it unnecessary — so this cannot be
 * worse than a state that already ran in production.
 *
 * Failures resolve to false (serve the cache), because the cost of refusing a
 * forced rebuild is a slightly stale view, and the cost of throwing inside
 * doGet is no view at all.
 */
function claimForcedRebuild(type) {
  try {
    var props = PropertiesService.getScriptProperties();
    var key = forceFreshClaimKey_(type);
    var last = Number(props.getProperty(key)) || 0;
    var now = Date.now();
    if (now - last < FORCE_FRESH_MIN_MS) return false;
    props.setProperty(key, String(now));
    return true;
  } catch (err) {
    Logger.log("Forced rebuild claim failed (" + type + "): " + err.message);
    return false;
  }
}

/* ---------------- Revision counters ----------------

   One counter per type, bumped whenever that module's cache is invalidated.
   The app only has to notice that a number moved, which is why the poll route
   can stay free of sheet access.

   Cost of the poll, against the documented quota of 50,000 Properties
   read/write calls per day (consumer accounts): currentDataRev_() uses ONE read
   (getProperties returns them all). At a 30 s poll while the tab is visible —
   and none at all while it is hidden — that is ~1,440 reads per device per 12 h
   day, so a 10-device dashboard spends ~14,000 of the 50,000. If the estate
   ever grows past ~30 permanently-open devices, raise the poll interval before
   raising the device count. */
var REV_PREFIX = "data_rev_";

function bumpDataRev_(types) {
  var props = PropertiesService.getScriptProperties();
  var revs = {};
  for (var i = 0; i < types.length; i++) {
    var key = REV_PREFIX + types[i];
    var next = (Number(props.getProperty(key)) || 0) + 1;
    props.setProperty(key, String(next));
    revs[types[i]] = next;
  }
  return revs;
}

/**
 * The revision of one module's data, as a number.
 *
 * Used as a build-time witness: the read path captures it BEFORE touching the
 * sheet and compares it again before caching, so a build that raced an edit
 * cannot install the pre-edit snapshot it just read. An unreadable revision
 * resolves to 0 on both sides, which compares equal and lets the build cache
 * normally — a bookkeeping failure must never stop the dashboard.
 */
function dataRevOf_(type) {
  try {
    return Number(PropertiesService.getScriptProperties().getProperty(REV_PREFIX + type)) || 0;
  } catch (err) {
    return 0;
  }
}

function currentDataRev_() {
  var all = PropertiesService.getScriptProperties().getProperties() || {};
  var rev = {};
  for (var i = 0; i < DATA_TYPES.length; i++) {
    rev[DATA_TYPES[i]] = Number(all[REV_PREFIX + DATA_TYPES[i]]) || 0;
  }
  return rev;
}

function handleGetRev() {
  return jsonOut({ ok: true, rev: currentDataRev_() });
}

/* ---------------- The three key/TTL rules, in one place each ----------------

   Both the request path and the bundle route need to answer "which key is this module
   stored under, how long may an entry live, and what is its timestamp stored as". Two
   copies of any of those is how the two routes would come to disagree — one of them
   serving a payload the other calls expired. */

function cacheKeyFor_(type, shape) {
  return "cache_v2_" + type + (shape >= 2 ? "_c" + shape : "");
}

/* The TTL a build that no warmer asked for is cached with. */
function cacheTtlFor_(type) {
  return (type === "node" || type === "olt" || type === "backbone") ? 60 : 180;
}

/* CacheService has no TTL of its own, so the PropertiesService fallback is stamped with
   its write time and expired by hand against cacheTtlFor_(). */
function propStampKey_(cacheKey) {
  return cacheKey + "_cached_at";
}

/* ==================== THE OPENING BUNDLE ====================

   index.html fetches ONE module on load (nap); lcp, node and backbone arrive on their first
   tab click, and olt through its own loader. So a session that glances at three tabs spends
   four round trips — and every one of them pays Apps Script's fixed cost in full: ~1.1-1.5 s
   of startup plus the 302 -> googleusercontent echo hop, whatever the payload is. Measured
   sizes from the warm pass:

       olt 629 B    nap 742 B    lcp 512 B    node 1980 B    backbone 1640 B
       ------------------------------------------------------------- 5,503 bytes total

   So the opening was spending ~6 s of protocol overhead to move 5.5 KB — and, before the
   warm TTL was raised to outlive its interval, whichever of those requests landed in the
   cold window paid a full build on top of it (see olt-cache-warmer.gs).

   This route answers all five in ONE execution: one floor instead of four or five, and every
   tab the operator switches to afterwards is already in memory.

   READ-ONLY, and that is the whole design. It never builds, never touches the
   spreadsheet, never writes a cache entry and never moves a revision — so asking for
   everything is incapable of adding load. A warm cache is answered with a handful of
   CacheService reads; a cold one is answered with `missing`, which is the truth, and the
   client fetches what is missing over the routes it already has. A version that built the
   missing modules inline would be a second, slower copy of the request path, and it would
   put up to five full builds between an operator and the screen they just opened.

   Shape: OLT comes from cache_v2_olt_c3, the shape the dashboard actually asks for, via
   the same dashboardShapeFor_() the diagnostics report uses. shape=4 is deliberately
   absent — nothing warms it and its view is lazy by design.
*/

/* The one OLT shape the dashboard reads.

   Stated once, and asked for by name — warmOltCache() states shape=3 for the same reason.
   The bundle route and the diagnostics report both have to read the payload the APP reads,
   and "which shape is that" is exactly the kind of fact that gets copied and then drifts. */
var DASHBOARD_OLT_SHAPE = 3;

/**
 * The shape a module is stored and read in. Only OLT has more than one.
 * @return {number}
 */
function dashboardShapeFor_(type) {
  return (type === 'olt') ? DASHBOARD_OLT_SHAPE : 1;
}

/**
 * The key each module is read from.
 *
 * Derived from DATA_TYPES rather than restated. That list is already the one the
 * invalidation trigger and the rev route share; a second copy here would be a second
 * thing to forget to update, and the failure it produces is silent — a module that the
 * bundle never asks for simply reports itself missing forever.
 *
 * @return {Array<{type: string, key: string}>}
 */
function bundleKeys_() {
  var entries = [];
  for (var i = 0; i < DATA_TYPES.length; i++) {
    var type = DATA_TYPES[i];
    entries.push({ type: type, key: cacheKeyFor_(type, dashboardShapeFor_(type)) });
  }
  return entries;
}

/**
 * The PropertiesService fallback for one key, applying doGet's expiry rule.
 *
 * Expired or unstamped counts as MISSING, exactly as it does on the request path. The
 * one deliberate difference: this route does not DELETE the entry it rejected. Dropping
 * a dead entry is the next real request's job — a read-only route must not be the thing
 * that mutates state, or "asking what is cached" becomes a write.
 *
 * @return {string|null} the stored payload, or null when there is nothing live
 */
function bundlePropertyEntry_(props, key, type) {
  var value = props.getProperty(key);
  if (!value) return null;

  /* The stamp IS the age, so there is no separate "unstamped" case to handle: a missing
     stamp reads as 0, and 0 against any TTL is 19700 days old. Written as one comparison
     rather than a guard plus a comparison, because the extra guard was a branch nothing
     could observe — the mutation pass is what said so. */
  var cachedAt = Number(props.getProperty(propStampKey_(key))) || 0;
  if ((Date.now() - cachedAt) / 1000 >= cacheTtlFor_(type)) return null; // expired
  return value;
}

/**
 * Every module's live payload, in one response.
 *
 * @return {ContentService.TextOutput} { ok, at, bundle, missing }
 */
function handleBundle() {
  var start = Date.now();
  var entries = bundleKeys_();

  var keys = [];
  for (var i = 0; i < entries.length; i++) keys.push(entries[i].key);

  /* One read for all five. CacheService.getAll() answers with only the keys that are
     present, so a miss is an absent key rather than a null value — read it that way. */
  var found = {};
  try {
    found = CacheService.getScriptCache().getAll(keys) || {};
  } catch (err) {
    /* Fail open onto the slower path, never onto an error: with `found` empty every
       module is reported missing, and the client falls back to fetching them one by one
       exactly as it did before this route existed. */
    Logger.log('\u26a0\ufe0f bundle: cache read failed (' + err.message +
               ') — every module will be reported missing');
    found = {};
  }

  var bundle = {};
  var missing = [];
  var props = null;

  for (var e = 0; e < entries.length; e++) {
    var type = entries[e].type;
    var raw = found[entries[e].key];

    if (!raw) {
      try {
        if (!props) props = PropertiesService.getScriptProperties();
        raw = bundlePropertyEntry_(props, entries[e].key, type);
      } catch (err) {
        Logger.log('\u26a0\ufe0f bundle: property fallback failed for ' + type +
                   ' (' + err.message + ')');
        raw = null;
      }
    }

    if (!raw) { missing.push(type); continue; }

    /* Parsed rather than passed through as a string. An escaped JSON string inside JSON
       roughly doubles those bytes and hands the client a second parse to do; the whole
       point of this route is to move less, not more. A value that will not parse is
       treated as missing for the same reason doGet treats an unreadable stamp as
       expired: the honest answer is "not available", not a broken payload. */
    try {
      bundle[type] = JSON.parse(raw);
    } catch (err) {
      Logger.log('\u26a0\ufe0f bundle: cached payload for ' + type + ' is not JSON (' +
                 err.message + ') — reporting it missing');
      missing.push(type);
    }
  }

  var sent = entries.length - missing.length;

  /* One line per open, and the only evidence there is that the app is actually using
     this route — plus, when something is cold, which module it was. */
  Logger.log('\ud83d\udce6 bundle: ' + sent + ' of ' + entries.length + ' published' +
             (missing.length ? ' — missing: ' + missing.join(', ') : '') +
             ' in ' + (Date.now() - start) + 'ms');

  return jsonOut({
    ok: true,
    at: Date.now(),
    bundle: bundle,
    missing: missing
  });
}

/* The response fields of an OLT row, in the order the compact shape positions
   them. Sent as `f` in the payload so the client reads the order rather than
   assuming it — a hardcoded copy on each side is exactly how a field swap would
   go unnoticed.

   The order is the one the legacy objects are built in above, so a decoded row is
   not merely equal to a legacy row but identical to it key-for-key. That keeps the
   round trip provable by string comparison (see tests/olt-payload.test.js). */
var OLT_ROW_FIELDS = ["P", "M", "N", "S", "T", "AG", "RM", "DC", "CA", "IM"];

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
