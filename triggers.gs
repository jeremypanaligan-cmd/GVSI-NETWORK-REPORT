/**
 * ==================== TRIGGER SETUP ====================
 * Run this function ONCE in the Apps Script editor to create all time-driven triggers.
 * 
 * After running, you can view all triggers at:
 * Apps Script → Triggers (clock icon in left sidebar)
 * 
 * Trigger Schedule:
 * - Aging Duration (OLT): Every 15 minutes
 * - Aging Duration (Node/Backbone): Every 30 minutes
 * - Backbone Ticket Processing: Every hour
 * - Node Ticket Processing: Every hour
 * - Daily Excel Backup: Every day at 6:00 AM
 * 
 * To remove all triggers, run: removeAllTriggers()
 */

function setupAllTriggers() {
  // Remove existing triggers first to avoid duplicates
  removeAllTriggers();
  
  // 1. Aging Duration - OLT (Every 15 minutes)
  ScriptApp.newTrigger('updateAgingDurationStatic')
    .timeBased()
    .everyMinutes(15)
    .create();
  Logger.log('✅ Created trigger: updateAgingDurationStatic (every 15 minutes)');
  
  // 2. Aging Duration - Node & Backbone (Every 30 minutes)
  ScriptApp.newTrigger('updateAgingDurationColP')
    .timeBased()
    .everyMinutes(30)
    .create();
  Logger.log('✅ Created trigger: updateAgingDurationColP (every 30 minutes)');
  
  // 3. Process Backbone Tickets (Every hour)
  ScriptApp.newTrigger('processBackboneTickets')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('✅ Created trigger: processBackboneTickets (every hour)');
  
  // 4. Process Node DOWN Tickets (Every hour)
  ScriptApp.newTrigger('processAllNodeDownRows')
    .timeBased()
    .everyHours(1)
    .create();
  Logger.log('✅ Created trigger: processAllNodeDownRows (every hour)');
  
  // 5. Daily Excel Backup (6:00 AM daily, GMT+8)
  ScriptApp.newTrigger('autoExportSheetToExcel')
    .timeBased()
    .atHour(6)
    .everyDays(1)
    .inTimezone('Asia/Manila')
    .create();
  Logger.log('✅ Created trigger: autoExportSheetToExcel (daily at 6:00 AM PHT)');
  
  Logger.log('');
  Logger.log('===============================');
  Logger.log('All triggers created successfully!');
  Logger.log('View triggers: Apps Script → Triggers');
  Logger.log('===============================');
}

/**
 * Removes all triggers for this script.
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
 * Lists all current triggers.
 * Run this to see what triggers are active.
 */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  
  if (triggers.length === 0) {
    Logger.log('No active triggers found.');
    Logger.log('Run setupAllTriggers() to create triggers.');
    return;
  }
  
  Logger.log('=== Active Triggers ===');
  Logger.log('Total: ' + triggers.length);
  Logger.log('');
  
  triggers.forEach(function(trigger, index) {
    Logger.log((index + 1) + '. ' + trigger.getHandlerFunction());
    Logger.log('   Type: ' + trigger.getEventType());
    if (trigger.getEventType() === 'TIME_DRIVEN') {
      var freq = trigger.getTriggerSource();
      Logger.log('   Frequency: ' + JSON.stringify(trigger.getTriggerSource()));
    }
    Logger.log('');
  });
}
