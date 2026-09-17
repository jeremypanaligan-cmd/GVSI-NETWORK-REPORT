/**
 * ==================== TRIGGER SETUP ====================
 *
 * Run setupAllTriggers() once in the Apps Script editor to (re)create the
 * time-driven triggers.
 *
 * WHY THIS FILE EXISTS EVEN THOUGH THE TRIGGERS ARE ALREADY INSTALLED:
 * triggers are installed objects that belong to the Apps Script PROJECT, not to
 * any file. Deleting this file would not remove them, and copying the
 * spreadsheet would not carry them across — but the Triggers page shows only
 * the event type, never the cadence. So this header and TRIGGER_PLAN are the
 * only written record of the schedule. Keep them in step with reality.
 *
 * SCHEDULE
 *   updateAgingDurationStatic   every 15 min    OLT aging            (AgingDurationColX.gs)
 *   warmOltCache                every 15 min    OLT cache pre-warm   (olt-cache-warmer.gs)
 *   updateAgingDurationColP     every 30 min    Node/Backbone aging  (AgingDurationColP(BBxNODE).gs)
 *   processBackboneTickets      every hour      Backbone link extract(ExtractLinksinBB.gs)
 *   autoExportSheetToExcel      daily 06:00 PHT Excel backup         (autoBackupsheet.gs)
 *
 * SAFETY — why setupAllTriggers() validates before it deletes:
 * removeAllTriggers() runs first, and ScriptApp.newTrigger(unknownName).create()
 * throws. So a single bad name used to wipe every live trigger and then die
 * partway through recreating them, leaving FEWER triggers than before. The
 * handler check below runs before anything is removed, so a bad plan is a no-op
 * instead of an outage. That failure mode was not hypothetical — see the
 * processAllNodeDownRows note.
 *
 * WHY processAllNodeDownRows IS NOT IN THE PLAN
 *   It was a real function until v3.5.0 (commit 94b0934, 2026-08-30, "Backend
 *   Cleanup"), when node extraction stopped being script-driven: EXTRACT_NODE()
 *   was renamed EXTRACT_AFFECTED_NPE() and moved into the sheet as a formula
 *   (=EXTRACT_AFFECTED_NPE(I2)), which recalculates on its own. The trigger
 *   entry was left behind pointing at a function that no longer exists.
 *
 *   Do NOT restore it from git history as-is. That version wrote node names to
 *   Column Q, while the dashboard now reads them from Column AA over a
 *   27-column range (COL.NODE_EQUIPMENT in code.gs). A restored copy would
 *   quietly write a column nothing reads. If node processing ever needs a
 *   trigger again, write a function that targets the current column and add it
 *   to TRIGGER_PLAN.
 *
 *   (For the record it was never Supabase-related: the Supabase node sync was
 *   syncNodeDownTickets() in supabase-sync.gs, a separate file that has since
 *   been removed along with Supabase itself.)
 *
 * TO ADD A TRIGGER
 *   1. Write the handler function.
 *   2. Add an entry to TRIGGER_PLAN with its schedule.
 *   3. Run setupAllTriggers() — it will refuse to run if the handler is missing.
 */

/* The desired set of time-driven triggers, as data. setupAllTriggers() reads
   this both to validate handlers and to create the triggers, so the schedule
   can only be stated once. `apply` receives a fresh TriggerBuilder and returns
   a configured builder; the caller calls .create() on it. */
var TRIGGER_PLAN = [
  {
    fn: 'updateAgingDurationStatic',
    schedule: 'every 15 minutes',
    apply: function (t) { return t.timeBased().everyMinutes(15); }
  },
  {
    fn: 'warmOltCache',
    schedule: 'every 15 minutes (same cadence as the aging writer)',
    apply: function (t) { return t.timeBased().everyMinutes(15); }
  },
  {
    fn: 'updateAgingDurationColP',
    schedule: 'every 30 minutes',
    apply: function (t) { return t.timeBased().everyMinutes(30); }
  },
  {
    fn: 'processBackboneTickets',
    schedule: 'every hour',
    apply: function (t) { return t.timeBased().everyHours(1); }
  },
  {
    fn: 'autoExportSheetToExcel',
    schedule: 'daily at 06:00 Asia/Manila',
    apply: function (t) { return t.timeBased().atHour(6).everyDays(1).inTimezone('Asia/Manila'); }
  }
];

/**
 * Does a top-level function with this name exist in the project?
 *
 * Apps Script exposes top-level functions on the global object, so a name that
 * is not defined resolves to undefined. The lookup is wrapped because it is the
 * one part of this file that cannot be exercised outside Apps Script: if it
 * ever throws, the caller sees the handler as missing and aborts before
 * removing anything. Failing closed is the whole point.
 */
function triggerHandlerExists_(name) {
  try {
    var g = (typeof globalThis !== 'undefined' && globalThis) ? globalThis : this;
    return typeof g[name] === 'function';
  } catch (e) {
    return false;
  }
}

function setupAllTriggers() {
  // The validator has to be able to resolve a name we know is defined, or the
  // all-clear below means nothing. If it cannot, stop rather than accept a
  // false clear and start deleting.
  if (!triggerHandlerExists_('removeAllTriggers')) {
    Logger.log('❌ setupAllTriggers aborted: cannot resolve function names in this runtime.');
    Logger.log('   The handler check is unreliable, so nothing was removed.');
    return;
  }

  // ---- STEP 1: validate every handler BEFORE touching the live triggers ----
  var missing = [];
  for (var i = 0; i < TRIGGER_PLAN.length; i++) {
    if (!triggerHandlerExists_(TRIGGER_PLAN[i].fn)) {
      missing.push(TRIGGER_PLAN[i].fn);
    }
  }

  if (missing.length > 0) {
    var liveCount = ScriptApp.getProjectTriggers().length;
    Logger.log('❌ setupAllTriggers aborted — NOTHING was removed.');
    Logger.log('   Missing handler function(s): ' + missing.join(', '));
    Logger.log('   Either create the function(s) or remove the entry from TRIGGER_PLAN.');
    Logger.log('   The existing ' + liveCount + ' trigger(s) are untouched.');
    return;
  }

  Logger.log('All ' + TRIGGER_PLAN.length + ' handler(s) verified. Replacing triggers…');

  // ---- STEP 2: safe to replace ----
  removeAllTriggers();

  var created = 0;
  for (var j = 0; j < TRIGGER_PLAN.length; j++) {
    var entry = TRIGGER_PLAN[j];
    try {
      TRIGGER_PLAN[j].apply(ScriptApp.newTrigger(entry.fn)).create();
      created++;
      Logger.log('✅ ' + entry.fn + ' — ' + entry.schedule);
    } catch (err) {
      Logger.log('❌ ' + entry.fn + ' — ' + err.message);
    }
  }

  Logger.log('');
  Logger.log('===============================');
  if (created === TRIGGER_PLAN.length) {
    Logger.log('All ' + created + ' triggers created successfully!');
  } else {
    Logger.log('⚠️ Only ' + created + ' of ' + TRIGGER_PLAN.length +
               ' triggers were created. Run listTriggers() to see what is live.');
  }
  Logger.log('View triggers: Apps Script → Triggers');
  Logger.log('===============================');
}

/**
 * Removes EVERY trigger in this project. Destructive: the project ends up with
 * none until setupAllTriggers() runs again. Prefer setupAllTriggers(), which
 * validates first and does this itself.
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
 * Lists the live triggers AND reports how they differ from TRIGGER_PLAN.
 *
 * The drift report is the useful part: the Apps Script UI shows the event type
 * but not the cadence, so "live" and "intended" can silently diverge — which is
 * exactly how a plan entry for a deleted function sat here unnoticed.
 */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();

  Logger.log('=== Live Triggers ===');
  Logger.log('Total: ' + triggers.length);

  // Handler names the plan expects.
  var planned = {};
  for (var i = 0; i < TRIGGER_PLAN.length; i++) {
    planned[TRIGGER_PLAN[i].fn] = TRIGGER_PLAN[i].schedule;
  }

  // A time-driven trigger reports itself as CLOCK. Read the enum when it is
  // available and fall back to the literal, so this keeps working either way.
  var clockType = (ScriptApp.EventType && ScriptApp.EventType.CLOCK) ? ScriptApp.EventType.CLOCK : 'CLOCK';

  var live = {};           // fn -> true, whatever the event type
  var liveTimeDriven = {}; // fn -> true, CLOCK only

  triggers.forEach(function(trigger, index) {
    var fn = trigger.getHandlerFunction();
    var eventType = String(trigger.getEventType());
    live[fn] = true;
    if (eventType === String(clockType)) liveTimeDriven[fn] = true;
    Logger.log((index + 1) + '. ' + fn);
    Logger.log('   Event: ' + eventType + (planned[fn] ? '  (planned: ' + planned[fn] + ')' : ''));
  });

  // ---- Drift report ----
  var notLive = [];    // planned, but no trigger installed at all
  var wrongType = [];  // installed, but not on a clock
  for (var key in planned) {
    if (!planned.hasOwnProperty(key)) continue;
    if (!live[key]) notLive.push(key);
    else if (!liveTimeDriven[key]) wrongType.push(key);
  }

  var notPlanned = [];
  Object.keys(live).forEach(function(fn) {
    if (!planned[fn]) notPlanned.push(fn);
  });

  Logger.log('');
  Logger.log('=== vs TRIGGER_PLAN ===');
  if (notLive.length === 0 && wrongType.length === 0 && notPlanned.length === 0) {
    Logger.log('✅ In sync.');
    return;
  }
  if (notLive.length > 0) {
    Logger.log('❌ Planned but NOT live (run setupAllTriggers): ' + notLive.join(', '));
  }
  if (wrongType.length > 0) {
    Logger.log('❌ Planned but NOT time-driven — it has a trigger, just not on a clock ' +
               '(this is how an on-change trigger hides a missing schedule): ' +
               wrongType.join(', '));
  }
  if (notPlanned.length > 0) {
    Logger.log('⚠️ Live but not in the plan (legacy/manual — add it to TRIGGER_PLAN or remove it): ' +
               notPlanned.join(', '));
  }
}
