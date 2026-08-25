/**
 * Ino-automate ang pag-extract ng Affected Links (Column Y) at Link Count (Column Z)
 * batay sa Ticket Description na nasa Column I.
 */
function processBackboneTickets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("Backbone Tickets");
  if (!sheet) return;

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  // Column I = 9th Column (Ticket Description)
  const descColumnIndex = 9; 
  const descData = sheet.getRange(2, descColumnIndex, lastRow - 1, 1).getValues();

  const outputY = []; // List ng Links (Comma separated)
  const outputZ = []; // Count ng Links

  // Flexible Regex Patterns para sa Interface/Port Level Links
  const interfacePatterns = [
    // Nahuhuli ang kahit anong Node Name (1, 2, o higit pang hyphens) na may Gigabit/GE/25GE Ports
    /[A-Z0-9]+(?:-[A-Z0-9]+)+.*(?:GigabitEthernet|25GE\d*|GE\d*)[^\n]+/gi,
    
    // Low Power format
    /LP\s+[A-Z0-9]+(?:-[A-Z0-9]+)+[^\n]+/gi,
    
    // Simpleng Port to Port Format (e.g. CVI001-NPE01 GE0/2/5 TO QNI001-NPE-01 GE0/2/1)
    /[A-Z0-9]+(?:-[A-Z0-9]+)+\s+GE\d+\/\d+\/\d+[^\n]+/gi
  ];

  descData.forEach(row => {
    const text = row[0] ? row[0].toString() : "";
    
    if (!text) {
      outputY.push(["-"]);
      outputZ.push([0]);
      return;
    }

    const lines = text.split('\n');
    let extractedInterfaces = [];
    let fallbackRoute = "";

    lines.forEach(line => {
      let cleanLine = line.trim();
      if (!cleanLine) return;

      // Filter out noise / date time / header lines
      if (/^(DT:|DT\s*:|AFF:|AFFECTED:|Affected:|Aff|FYA|ON HOLD|ref|cur)/i.test(cleanLine)) {
        return;
      }

      // Linisin ang Ticket ID prefix (e.g., "TT-20260819-00000472 | ")
      let pureLine = cleanLine.replace(/^TT-\d+-\d+#?\s*\|\s*/i, "").trim();

      // Check kung nag-match sa Interface Patterns
      const isInterfaceMatch = interfacePatterns.some(pattern => {
        pattern.lastIndex = 0; // Reset regex state
        return pattern.test(pureLine);
      });

      if (isInterfaceMatch) {
        extractedInterfaces.push(pureLine);
      } else if (!fallbackRoute) {
        // Kunin ang text EKSAKTO pagkatapos ng 'LINK DOWN |' o 'LOW POWER |'
        const match = pureLine.match(/(?:LINK DOWN|LOW POWER|MULTIPLE LINK DOWN|MULTIPLE LOW POWER)\s*\|\s*(.+)$/i);
        if (match && match[1]) {
          fallbackRoute = match[1].trim();
        }
      }
    });

    // PRIORITY LOGIC:
    // 1. Kapag may detalyadong interface lines (Multiple Links), iyon ang kunin at bilangin
    if (extractedInterfaces.length > 0) {
      outputY.push([extractedInterfaces.join(', ')]);
      outputZ.push([extractedInterfaces.length]);
    } 
    // 2. Kapag walang interface lines, i-extract ang route name pagkatapos ng LINK DOWN / LOW POWER
    else if (fallbackRoute) {
      outputY.push([fallbackRoute]);
      outputZ.push([1]);
    } 
    // 3. Fallback kapag walang nahanap
    else {
      outputY.push(["-"]);
      outputZ.push([0]);
    }
  });

  // Isusulat nang sabay sa Column Y (25) at Column Z (26)
  sheet.getRange(2, 25, outputY.length, 1).setValues(outputY);
  sheet.getRange(2, 26, outputZ.length, 1).setValues(outputZ);
}