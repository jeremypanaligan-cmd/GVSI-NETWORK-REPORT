// ============================================
// SUPABASE CONFIG
// ============================================
const SUPABASE_URL = "https://fsebdacptgoknbjqdlor.supabase.co";
const SUPABASE_KEY = "sb_secret_aovETmmfnWYKlM3wGSvpwA_XCoVAj4O";

// ============================================
// ON CHANGE TRIGGER
// ============================================
function onChange(e) {
  const changeType = e.changeType;
  
  // Fire on any data change
  if (['EDIT', 'INSERT_ROW', 'DELETE_ROW', 'FORMAT', 'OTHER'].includes(changeType)) {
    syncAllModules();
  }
}

// ============================================
// SYNC ALL MODULES
// ============================================
function syncAllModules() {
  try {
    syncOltDownTickets();
    syncNodeDownTickets();
    syncBackboneTickets();
    syncLcpTickets();
    console.log("Sync completed at " + new Date().toISOString());
  } catch (err) {
    console.error("Sync error: " + err.message);
  }
}

// ============================================
// OLT DOWN TICKETS SYNC (FIXED)
// ============================================
function syncOltDownTickets() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("OLT DOWN Tickets");
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  const data = sheet.getRange(2, 1, lastRow - 1, 27).getValues();
  
  const tickets = data
    .filter(function(row) { return row[5]; })
    .map(function(row) {
      return {
        ticket_no: row[5],
        month_year: row[1],
        date: row[2] || null,
        province: row[3],
        area: row[4],
        downtime_cause: row[6],
        description: row[8] || null,
        impact: row[10] || null,
        issue: row[11] || null,
        from_team: row[12] || null,
        down_time: row[13] || null,
        date_endorsed: row[14] || null,
        remarks: row[20] || null,
        aging_duration: row[23] || null,
        number_of_olts: parseInt(row[24]) || 0,
        number_of_clients: parseInt(row[25]) || 0,
        equipments_affected: row[26] || null
      };
    });
  
  syncToSupabase("olt_down_tickets", tickets);
}

// ============================================
// NODE DOWN TICKETS SYNC
// ============================================
function syncNodeDownTickets() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Node DOWN Tickets");
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  const data = sheet.getRange(2, 1, lastRow - 1, 27).getValues();
  
  const tickets = data
    .filter(function(row) { return row[5]; })
    .map(function(row) {
      return {
        ticket_no: row[5],
        month_year: row[1],
        date: row[2] || null,
        province: row[3],
        area: row[4],
        description: row[8] || null,
        impact: row[9] || null,
        issue: row[10] || null,
        from_team: row[11] || null,
        down_time: row[12] || null,
        date_endorsed: row[13] || null,
        remarks: row[20] || null,
        aging_duration: row[22] || null,
        count_of_eqp: parseInt(row[24]) || 0,
        equipments_affected: row[25] || null
      };
    });
  
  syncToSupabase("node_down_tickets", tickets);
}

// ============================================
// BACKBONE TICKETS SYNC
// ============================================
function syncBackboneTickets() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Backbone Tickets");
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  const data = sheet.getRange(2, 1, lastRow - 1, 27).getValues();
  
  const tickets = data
    .filter(function(row) { return row[5]; })
    .map(function(row) {
      return {
        ticket_no: row[5],
        month_year: row[1],
        date: row[2] || null,
        province: row[3],
        area: row[4],
        service: row[6] || null,
        description: row[8] || null,
        impact: row[9] || null,
        category: row[10] || null,
        from_team: row[11] || null,
        down_time: row[12] || null,
        date_endorsed: row[13] || null,
        remarks: row[20] || null,
        aging_duration: row[22] || null,
        links_affected: row[23] || null,
        count_of_links: parseInt(row[24]) || 0
      };
    });
  
  syncToSupabase("backbone_tickets", tickets);
}

// ============================================
// LCP TICKETS SYNC
// ============================================
function syncLcpTickets() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("LCP Tickets");
  if (!sheet) return;
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  
  const data = sheet.getRange(2, 1, lastRow - 1, 27).getValues();
  
  const tickets = data
    .filter(function(row) { return row[5]; })
    .map(function(row) {
      return {
        ticket_no: row[5],
        month_year: row[1],
        date: row[2] || null,
        province: row[3],
        area: row[4],
        description: row[8] || null,
        impact: row[9] || null,
        issue: row[10] || null,
        from_team: row[11] || null,
        down_time: row[12] || null,
        date_endorsed: row[13] || null,
        remarks: row[20] || null,
        aging_duration: row[22] || null,
        clients: parseInt(row[9]) || 0
      };
    });
  
  syncToSupabase("lcp_tickets", tickets);
}

// ============================================
// GENERIC SYNC FUNCTION (SIMPLE)
// ============================================
function syncToSupabase(table, tickets) {
  var headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates"
  };
  
  if (tickets.length === 0) return;
  
  try {
    // Try bulk upsert
    var response = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/" + table + "?on_conflict=ticket_no", {
      method: "POST",
      headers: headers,
      payload: JSON.stringify(tickets),
      muteHttpExceptions: true
    });
    
    var code = response.getResponseCode();
    if (code === 200 || code === 201) {
      Logger.log(table + ": synced " + tickets.length + " tickets");
    } else {
      // If upsert fails, insert one by one
      var successCount = 0;
      tickets.forEach(function(ticket) {
        try {
          UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/" + table, {
            method: "POST",
            headers: headers,
            payload: JSON.stringify(ticket),
            muteHttpExceptions: true
          });
          successCount++;
        } catch (e) {
          // Skip duplicates
        }
      });
      Logger.log(table + ": synced " + successCount + " of " + tickets.length + " tickets");
    }
  } catch (err) {
    Logger.log(table + " sync error: " + err.message);
  }
}

// ============================================
// SETUP TRIGGER (run once) - TIME DRIVEN
// ============================================
function setupTrigger() {
  // Delete existing triggers
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "syncAllModules") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create time-driven trigger (every 5 minutes)
  ScriptApp.newTrigger("syncAllModules")
    .timeBased()
    .everyMinutes(5)
    .create();
  
  Logger.log("Time-driven trigger created: syncAllModules every 5 minutes");
}

// ============================================
// ON CHANGE (simple trigger - automatic)
// ============================================
function onChange(e) {
  // This fires on edits, inserts, deletes, formatting
  // But NOT on IMPORTRANGE refresh
  // We use time-driven trigger for that
  console.log("onChange fired: " + e.changeType);
}

// ============================================
// INITIAL SYNC (run once)
// ============================================
function initialSync() {
  syncAllModules();
  Logger.log("Initial sync completed!");
}