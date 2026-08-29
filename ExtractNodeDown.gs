/**
 * Custom Formula Function para i-extract ang PRIMARY affected NPE(s) lamang.
 * I-skip ang secondary NPEs (link endpoints) at non-NPE devices (AGG, etc.)
 * 
 * Usage sa Sheet: =EXTRACT_AFFECTED_NPE(I2)
 * 
 * Examples:
 * - Single: "SZI001-NPE-01" (from single node down)
 * - Multiple: "BYV001-NPE-01, SLV001-NPE-01, SLV001-NPE-02" (from multiple node down)
 */
function EXTRACT_AFFECTED_NPE(text) {
  if (!text) return "";
  text = String(text);

  // NPE name matcher: SZI001-NPE-01, BGB001-NPE-02, BYV001-NPE-01, etc.
  var npeRegex = /\b[A-Z0-9]{3,6}[-_]?NPE[-_]?\d{2}\b/gi;

  // Patterns that indicate SECONDARY NPE (link endpoint, not actually down)
  var secondaryPatterns = /LINK\s+TO|GigabitEthernet|XGigabitEthernet|MEMBER\s+\d|\bGE\d|Fa\d|Gi\d|Shelf\d|NE\d{4}|S\d{4}-Shelf/i;

  // === Strategy A: From AFFECTED: section — collect all CLEAN NPE lines ===
  if (/(?:affected|aff)\s*:/i.test(text)) {
    var parts = text.split(/(?:affected|aff)\s*:/i);
    if (parts.length > 1) {
      var afterAffected = parts[1].split(/(?:dt:|note:)/i)[0];
      var lines = afterAffected.split(/\r?\n/);
      var primaryNpes = [];

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;

        // Skip lines with secondary patterns (these are link endpoints, not down)
        if (secondaryPatterns.test(line)) continue;

        // Check if this line contains an NPE
        var match = line.match(npeRegex);
        if (match && match.length > 0) {
          for (var m = 0; m < match.length; m++) {
            var npe = match[m].trim().toUpperCase();
            // Avoid duplicates
            if (primaryNpes.indexOf(npe) === -1) {
              primaryNpes.push(npe);
            }
          }
        }
      }

      if (primaryNpes.length > 0) {
        return primaryNpes.join(", ");
      }
    }
  }

  // === Strategy B: From ticket title (after "NODE DOWN |") ===
  var titleMatch = text.match(/NODE\s+DOWN\s*\|\s*([A-Z0-9][-_A-Z0-9]*NPE[-_A-Z0-9]*)/i);
  if (titleMatch) {
    return titleMatch[1].toUpperCase();
  }

  // === Strategy C: Fallback — first NPE in entire text ===
  var fallbackMatch = text.match(npeRegex);
  if (fallbackMatch && fallbackMatch.length > 0) {
    return fallbackMatch[0].toUpperCase();
  }

  return "";
}