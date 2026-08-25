/**
 * Nag-u-update ng AGING DURATION sa Column X bilang STATIC VALUES (Format: 0d 8h 2m)
 * para sa parehong "Node DOWN Tickets" at "Backbone Tickets" sheets.
 */
function updateAgingDurationColP() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Mga sheet na kailangang i-process
  const targetSheets = ["Node DOWN Tickets", "Backbone Tickets"];
  
  const TICKET_DATE_COL = 15; // Column O (Date Endorsed)
  const AGING_COL = 24;       // Column X (Aging Duration)
  
  targetSheets.forEach(sheetName => {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      Logger.log(`Sheet "${sheetName}" not found. Skipping...`);
      return;
    }
    
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return; // Walang data na ipo-process
    
    // Batch get values para mabilis
    const ticketDates = sheet.getRange(2, TICKET_DATE_COL, lastRow - 1, 1).getValues();
    const now = new Date();
    const agingValues = [];

    for (let i = 0; i < ticketDates.length; i++) {
      const rawDate = ticketDates[i][0];
      
      if (rawDate && rawDate instanceof Date && !isNaN(rawDate)) {
        const diffMs = now - rawDate;

        // Kapag future date o pumasok sa invalid range
        if (diffMs < 0) {
          agingValues.push(["0d 0h 0m"]);
          continue;
        }

        // Kwenta ng Days, Hours, at Minutes
        const totalMinutes = Math.floor(diffMs / (1000 * 60));
        const diffDays = Math.floor(totalMinutes / (24 * 60));
        const remainingHours = Math.floor((totalMinutes % (24 * 60)) / 60);
        const remainingMinutes = totalMinutes % 60;

        // Formatted Output: halimbawa "0d 8h 2m"
        const durationStr = `${diffDays}d ${remainingHours}h ${remainingMinutes}m`;
        agingValues.push([durationStr]);
      } else {
        agingValues.push([""]); // Bakante kapag walang valid date
      }
    }

    // Batch write pabalik sa Column X
    sheet.getRange(2, AGING_COL, agingValues.length, 1).setValues(agingValues);
    Logger.log(`Successfully updated ${agingValues.length} rows in "${sheetName}" Column P (Aging Duration).`);
  });
}