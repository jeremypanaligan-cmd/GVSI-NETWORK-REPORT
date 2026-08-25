/**
 * Nag-u-update ng AGING DURATION sa Column X bilang STATIC VALUES (Format: 0d 8h 2m).
 * Ino-optimize nito ang performance ng GVSI NetPulse sa pamamagitan ng pag-alis ng volatile NOW() formulas.
 */
function updateAgingDurationStatic() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // Sheet name at Column Indexes base sa configuration mo:
  const sheet = ss.getSheetByName("OLT DOWN Tickets") || ss.getSheets()[0]; 
  
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return; // Walang data na ipo-process

  const TICKET_DATE_COL = 15;  // Column O (Date Endorse)
  const AGING_COL = 24;       // Column X (Aging Duration)
  
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

      // Formatted Output: halimbawa "0d 8h 2m" o "3d 5h 30m"
      const durationStr = `${diffDays}d ${remainingHours}h ${remainingMinutes}m`;

      agingValues.push([durationStr]);
    } else {
      agingValues.push([""]); // Bakante kapag walang valid date
    }
  }

  // Batch write pabalik sa Column X
  sheet.getRange(2, AGING_COL, agingValues.length, 1).setValues(agingValues);
  
  Logger.log(`Successfully updated ${agingValues.length} rows in Column X (Aging Duration).`);
}