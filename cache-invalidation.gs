/**
 * ==================== CACHE INVALIDATION ON SHEET EDIT ====================
 *
 * Drops a module's cached payload the moment the sheet it reads is edited, so
 * the NEXT request rebuilds instead of being served the previous build.
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-18 a DOWN ticket was deleted from "OLT DOWN Tickets" at 14:06:09.
 * The dashboard still showed it at 14:17:09 — 11 minutes — while the app was
 * refreshing the whole time. Nothing about that was the app's fault: a cache
 * HIT returns the stored bytes and never rewrites them (code.gs), so every one
 * of those refreshes was answered with the same 13:59 snapshot, and only the
 * warmer's TTL running out produced a fresh build.
 *
 * Shortening TTLs cannot fix that class of lag, because the TTL only decides
 * how often a miss is ALLOWED to happen. What fixes it is knowing that the
 * underlying data changed, which is what this file adds: one trigger run, a few
 * cache deletions, and the next reader builds from the sheet.
 *
 * COST
 *
 * One trigger execution per edit, a few milliseconds each: no spreadsheet read,
 * no rebuild, no API call unless the optional relay is configured. It counts
 * against the triggers-total-runtime quota (90 min/day on consumer accounts),
 * so ~1,000 edits a day cost well under a minute. Both handlers are wrapped
 * defensively — an exception here must never surface as a broken cell, and the
 * worst case is that a stale entry lives out its TTL as it does today.
 *
 * WHY INSTALLABLE RATHER THAN SIMPLE TRIGGERS
 *
 * Simple onEdit() only runs for the editing user's own session (and, per the
 * Sheets docs, queues up to 2 events). Installable triggers run as the installer
 * and fire for every user with edit access, which is what a shared NOC sheet
 * needs: the analyst who deletes the ticket is usually not the account that
 * owns this script.
 *
 * WHAT THIS CANNOT SEE — and why the warmer still has to run
 *
 *   - Script and API writes. Google's documented restriction: "Script
 *     executions and API requests don't cause triggers to run." So the aging
 *     writers in this project editing Column X do NOT fire these handlers. That
 *     is also why there is no invalidation loop to guard against.
 *   - Formula recalculations, including anything arriving through IMPORTRANGE.
 *     This was already known here — see the note in triggers.gs — and it is the
 *     case that the warm cadence and the TTL in olt-cache-warmer.gs still cover.
 *
 * A payload that changes by formula therefore has no invalidation, which is why
 * ?action=rev and meta.builtAt exist: the first tells the app to look again, the
 * second tells it how old what it is looking at really is. A trigger fire only
 * moves the rev for the module it actually invalidated, so the app is never told
 * to refetch something that did not change.
 *
 * RACE WORTH KNOWING ABOUT — and where it is actually closed
 *
 * A rebuild reads the sheet for ~3-4 s, so an edit can land in the middle of one
 * and the write that follows would install a pre-edit snapshot into a cache that
 * this file has just cleared. That is handled in code.gs, not here: the read
 * path captures the module's revision before its first sheet read and refuses to
 * cache a payload whose revision moved while it was building. This file only has
 * to make the revision move, which it does AFTER the deletions below — so there
 * is no ordering in which a client can be sent to a cache that still holds the
 * old bytes.
 */

/* Sheet name -> the modules whose cached payload that sheet feeds.
   Names are matched exactly; a rename shows up as an unknown sheet, which is
   logged and ignored rather than silently invalidating nothing. */
var SHEET_TO_DATA_TYPES = {
  "NLZ OLT Report":    ["olt"],
  "OLT DOWN Tickets":  ["olt"],
  "Node DOWN Tickets": ["node"],
  "Backbone Tickets":  ["backbone"],
  "NLZ LCP Report":    ["lcp"],
  "NLZ NAP Report":    ["nap"]
};

/* Sheets whose edits do not change any dashboard payload. Listed so that
   "ignore this" is a decision recorded here rather than an accident of what
   somebody remembered to map. */
var IGNORED_SHEETS = { "Users": true, "AppSettings": true };

/**
 * Installable onEdit handler. Registered by setupAllTriggers() from TRIGGER_PLAN.
 *
 * Narrow on purpose: the sheet name is the only thing available in the event,
 * so a known sheet invalidates its own modules and nothing else. An unknown
 * sheet invalidates NOTHING — a renamed tab then costs at most a stale view
 * until its TTL expires, where a blanket invalidate would turn any unrelated
 * edit anywhere in the spreadsheet into a rebuild of every module.
 */
function handleSheetEdit(e) {
  try {
    var sheetName = editedSheetName_(e);
    if (!sheetName) return;

    if (IGNORED_SHEETS[sheetName]) return;

    var types = SHEET_TO_DATA_TYPES[sheetName];
    if (!types) {
      Logger.log('Cache invalidation skipped: sheet "' + sheetName +
                 '" is not mapped in SHEET_TO_DATA_TYPES.');
      return;
    }

    invalidateDataCache_(types, "edit:" + sheetName);
  } catch (err) {
    Logger.log("handleSheetEdit failed: " + err.message);
  }
}

/**
 * Installable onChange handler — structure changes (a removed row, a removed
 * column, a new grid). The event carries no sheet name, so this is the one case
 * that clears everything: the alternative is one module quietly serving a
 * payload that was built against a layout that no longer exists.
 */
function handleSheetChange(e) {
  try {
    var changeType = (e && e.changeType) ? String(e.changeType) : "unknown";
    invalidateDataCache_(DATA_TYPES, "structure:" + changeType);
  } catch (err) {
    Logger.log("handleSheetChange failed: " + err.message);
  }
}

function editedSheetName_(e) {
  if (!e || !e.range || typeof e.range.getSheet !== "function") return "";
  var sheet = e.range.getSheet();
  if (!sheet || typeof sheet.getName !== "function") return "";
  return String(sheet.getName()).trim();
}

/**
 * Remove every cache key for these types, then bump their revision counters.
 *
 * Order matters: the keys are gone BEFORE the rev moves, so a client that sees
 * a new revision is looking at a cache that is already empty and its next fetch
 * cannot be answered from the deleted entry.
 *
 * The PropertiesService copies are deleted unconditionally — they have no TTL of
 * their own (code.gs enforces the age by hand against a stamp property), so
 * leaving one behind would let a large payload outlive its invalidation.
 */
function invalidateDataCache_(types, reason) {
  var cache = CacheService.getScriptCache();
  var props = PropertiesService.getScriptProperties();
  var cleared = 0;

  try {
    for (var i = 0; i < types.length; i++) {
      var keys = dataCacheKeysFor_(types[i]);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        try {
          cache.remove(key);
        } catch (cacheErr) {
          Logger.log("cache.remove failed for " + key + ": " + cacheErr.message);
        }
        props.deleteProperty(key);
        props.deleteProperty(key + "_cached_at");
        cleared++;
      }
    }

    var revs = bumpDataRev_(types);
    Logger.log("Data cache invalidated (" + reason + "): " +
               types.join(", ") + " — " + cleared + " key(s), rev " +
               JSON.stringify(revs));

    notifyRelay_(revs);
  } catch (err) {
    Logger.log("invalidateDataCache_ failed (" + reason + "): " + err.message);
  }
}

/* ---------------- Optional outbound relay (off by default) ----------------

   Nothing in the browser can be pushed to by Apps Script — there is no socket
   and no webhook out of a doGet. A relay can: the cache worker in proxy/ holds
   its own connections, so one POST from here reaches every open dashboard at
   once, and the app never polls at all.

   Left off until it is configured on purpose. With the property unset no call is
   attempted and the rev poll is the only freshness channel, which is why the
   property is a setting rather than a build-time choice: turning the relay on
   must not require re-editing this file.

   muteHttpExceptions keeps a dead relay from turning an edit into a failed
   trigger execution — the local invalidation already happened, and losing the
   push costs a poll interval, not correctness. */

var NOTIFY_URL_PROPERTY = "notify_webhook_url";

function notifyRelay_(revs) {
  try {
    var url = PropertiesService.getScriptProperties().getProperty(NOTIFY_URL_PROPERTY);
    if (!url) return;

    UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({ rev: revs, at: new Date().toISOString() }),
      muteHttpExceptions: true
    });
  } catch (err) {
    Logger.log("notify relay failed: " + err.message);
  }
}
