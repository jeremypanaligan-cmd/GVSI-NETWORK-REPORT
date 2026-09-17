/**
 * ==================== TRIGGER SETUP ====================
 * Run this function ONCE in the Apps Script editor to create all triggers.
 * 
 * After running, you can view all triggers at:
 * Apps Script → Triggers (clock icon in left sidebar)
 * 
 * TIME-DRIVEN Triggers:
 * - Aging Duration (OLT): Every 15 minutes
 * - OLT Cache Warmer: Every 15 minutes
 * - Aging Duration (Node/Backbone): Every 30 minutes
 * - Daily Excel Backup: Every day at 6:00 AM
 * 
 * ON-CHANGE Triggers (Simple - Auto-fires):
 * - Backbone Ticket Processing
 * - Node Ticket Processing
 * 
 * To remove all triggers, run: removeAllTriggers()
 */

function setupAllTriggers() {
  // Remove existing triggers first to avoid duplicates
  removeAllTriggers();
  
  // ==================== TIME-DRIVEN TRIGGERS ====================
  
  // 1. Aging Duration - OLT (Every 15 minutes)
  ScriptApp.newTrigger('updateAgingDurationStatic')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('✅ Created trigger: updateAgingDurationStatic (every 15 minutes)');
  
  // 2. OLT Cache Warmer (Every 15 minutes)
  ScriptApp.newTrigger('warmOltCache')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('✅ Created trigger: warmOltCache (every 15 minutes)');
  
  // 3. Aging Duration - Node & Backbone (Every 30 minutes)
  ScriptApp.newTrigger('updateAgingDurationColP')
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log('✅ Created trigger: updateAgingDurationColP (every 30 minutes)');
  
  // 4. Daily Excel Backup (6:00 AM daily, GMT+8)
  ScriptApp.newTrigger('autoExportSheetToExcel')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .inTimezone('Asia/Manila')
    .create();
  Logger.log('✅ Created trigger: autoExportSheetToExcel (daily at 6:00 AM PHT)');
  
  // ==================== ON-CHANGE TRIGGERS ====================
  // Note: onChange is a SIMPLE trigger - auto-fires on document content changes
  // No need to create via ScriptApp.newTrigger()
  // Just define the function and it fires automatically
  
  Logger.log('');
  Logger.log('===============================');
  Logger.log('Time-driven triggers created!');
  Logger.log('');
  Logger.log('ON-CHANGE Triggers (Auto-fires):');
  Logger.log('- processBackboneTickets() → fires on Backbone sheet changes');
  Logger.log('- processAllNodeDownRows() → fires on Node sheet changes');
  Logger.log('');
  Logger.log('NOTE: onChange fires on edits, inserts, deletes, formatting.');
  Logger.log('It does NOT fire on IMPORTRANGE refresh.');
  Logger.log('===============================');
}

/**
 * Removes all time-driven triggers for this script.
 * Run this to reset or clean up triggers.
 */
function removeAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var removedCount = 0;
  
  triggers.forEach(function(trigger) {
    ScriptApp.deleteTrigger(trigger);
    removedCount++;
    Logger.log('Removed trigger: ' + trigger.getHandlerFunction() + ' (' + trigger.getEventType() + ')');
  });
  
  Logger.log('Total triggers removed: ' + removedCount);
}

/**
 * Lists all current time-driven triggers.
 * Run this to see what triggers are active.
 */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  
  if (triggers.length === 0) {
    Logger.log('No active time-driven triggers found.');
    Logger.log('Run setupAllTriggers() to create triggers.');
    return;
  }
  
  Logger.log('=== Active Time-Driven Triggers ===');
  Logger.log('Total: ' + triggers.length);
  Logger.log('');
  
  triggers.forEach(function(trigger, index) {
    Logger.log((index + 1) + '. ' + trigger.getHandlerFunction());
    Logger.log('   Type: ' + trigger.getEventType());
    Logger.log('');
  });
  
  Logger.log('=== On-Change Triggers (Simple - Auto-fires) ===');
  Logger.log('- processBackboneTickets()');
  Logger.log('- processAllNodeDownRows()');
}

// ==================== ON-CHANGE FUNCTIONS ====================
// These are SIMPLE TRIGGERS - they fire automatically when document content changes
// No need to create via ScriptApp.newTrigger()

/**
 * Fires when Backbone Tickets sheet content changes.
 * Process Backbone tickets and sync to Supabase.
 */
function onChangeBackbone(e) {
  Logger.log('onChangeBackbone fired: ' + e.changeType);
  syncBackboneTickets();
}

/**
 * Fires when Node DOWN Tickets sheet content changes.
 * Process Node tickets and sync to Supabase.
 */
function onChangeNode(e) {
  Logger.log('onChangeNode fired: ' + e.changeType);
  syncNodeDownTickets();
}
