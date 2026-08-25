/**
 * Custom Formula Function para mag-extract ng NPE equipment names lamang.
 * Usage sa Sheet: =EXTRACT_NODE(I2)
 */
function EXTRACT_NODE(text) {
  if (!text) return "";

  text = String(text);

  // Helper function para suriin kung ang linya ay MAY "- up" o "UP" status sa dulo
  function isUpStatus(line) {
    return /(?:-\s*|\s+)up\b/i.test(line);
  }

  // Strictly NPE Matcher (hal. CSA002-NPE-01, BGB001-NPE-01, CVI001-NPE-01)
  var npeRegex = /\b[A-Z0-9]{3,6}[-_\s]?NPE(?:[0-9]{2}|-[0-9]{2}|-[A-Z0-9]+)?\b/gi;

  // 1. Suriin kung may "AFFECTED:" o "AFF:" section
  if (/(?:affected|aff)\s*:/i.test(text)) {
    var parts = text.split(/(?:affected|aff)\s*:/i);
    if (parts.length > 1) {
      // Tinanggal ang '/' sa split para hindi maputol sa mga port numbers (hal. GigabitEthernet0/2/3)
      var afterNodes = parts[1].split(/(?:dt:|affected users)/i)[0];
      
      var lines = afterNodes.split(/\r?\n/);
      var filteredNodes = [];

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        
        // Kung ang linya ay WALANG status na UP/up
        if (!isUpStatus(line)) {
          var match = line.match(npeRegex);
          if (match && match.length > 0) {
            for (var m = 0; m < match.length; m++) {
              filteredNodes.push(match[m].trim().toUpperCase());
            }
          }
        }
      }

      if (filteredNodes.length > 0) {
        // Kumuha lamang ng Natatangi (Unique) na NPEs
        var uniqueNodes = filteredNodes.filter(function(item, pos) {
          return filteredNodes.indexOf(item) === pos;
        });
        return uniqueNodes.join(", ");
      }
    }
  }

  // 2. Kapag WALANG "AFFECTED:" / "AFF:", hahanapin sa BUONG TEXT kada linya
  var allLines = text.split(/\r?\n/);
  var fallbackNodes = [];

  for (var k = 0; k < allLines.length; k++) {
    var singleLine = allLines[k];
    if (!isUpStatus(singleLine)) {
      var singleMatch = singleLine.match(npeRegex);
      if (singleMatch && singleMatch.length > 0) {
        for (var n = 0; n < singleMatch.length; n++) {
          fallbackNodes.push(singleMatch[n].trim().toUpperCase());
        }
      }
    }
  }

  if (fallbackNodes.length > 0) {
    var uniqueFallback = fallbackNodes.filter(function(item, pos) {
      return fallbackNodes.indexOf(item) === pos;
    });
    return uniqueFallback.join(", ");
  }

  return "";
}

/**
 * AUTOMATION PROCESSOR: Gamitin ito para awtomatikong punan ang Column Q
 * mula sa Column I para sa Node DOWN Tickets sheet.
 */
function processAllNodeDownRows() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Node DOWN Tickets");
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var descriptions = sheet.getRange(2, 9, lastRow - 1, 1).getValues(); // Column I
  var results = [];

  for (var i = 0; i < descriptions.length; i++) {
    var text = String(descriptions[i][0] || "");
    results.push([EXTRACT_NODE(text)]);
  }

  // Isulat sa Column Q (Column 17)
  sheet.getRange(2, 17, results.length, 1).setValues(results);
}