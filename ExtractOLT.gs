function EXTRACT_OLT(text) {
  if (!text) return "";

  text = String(text);

  // Helper function para suriin kung ang linya ay MAY "- up" o "UP" sa tabi ng OLT name
  function isUpStatus(line) {
    // Naghahanap ng -UP, - UP, -up, - up, UP, o up bilang hiwalay na salita
    return /(?:-\s*|\s+)up\b/i.test(line);
  }

  // 1. Suriin kung may "Affected Nodes/Links"
  if (text.toLowerCase().includes("affected nodes/links")) {
    var parts = text.split(/affected nodes\/links/i);
    if (parts.length > 1) {
      var afterNodes = parts[1].split(/affected users/i)[0];
      
      // Hatiin kada linya para masuri ang OLT kasama ang katabing status (up / down)
      var lines = afterNodes.split(/\r?\n/);
      var filteredOlts = [];

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        
        // Kung ang linya ay WALANG status na UP/up
        if (!isUpStatus(line)) {
          var match = line.match(/[A-Z0-9]+-OLT-[0-9]+/gi);
          if (match && match.length > 0) {
            for (var m = 0; m < match.length; m++) {
              filteredOlts.push(match[m]);
            }
          }
        }
      }

      if (filteredOlts.length > 0) {
        // Kunin lang ang unique OLT names
        var uniqueOlts = filteredOlts.filter(function(item, pos) {
          return filteredOlts.indexOf(item) === pos;
        });
        return uniqueOlts.join("\n");
      }
    }
  }

  // 2. Kapag WALANG "Affected Nodes/Links", hahanapin sa BUONG TEXT kada linya
  var allLines = text.split(/\r?\n/);
  for (var k = 0; k < allLines.length; k++) {
    var singleLine = allLines[k];
    if (!isUpStatus(singleLine)) {
      var singleMatch = singleLine.match(/[A-Z0-9]+-OLT-[0-9]+/gi);
      if (singleMatch && singleMatch.length > 0) {
        return singleMatch[0]; // I-return ang pinakaunang hindi "UP" na OLT
      }
    }
  }

  return "";
}