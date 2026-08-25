function autoExportSheetToExcel() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ssId = ss.getId();
  var sheetName = ss.getName();
  
  // Kunin ang kasalukuyang petsa at oras sa tamang format
  var dateTimeToday = Utilities.formatDate(new Date(), "GMT+8", "MMMM dd, yyyy - hh:mm a");
  
  // URL para i-convert ang Google Sheet sa .xlsx (Excel) format
  var url = "https://docs.google.com/spreadsheets/d/" + ssId + "/export?format=xlsx";
  
  var params = {
    method: "GET",
    headers: { "Authorization": "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  };
  
  var response = UrlFetchApp.fetch(url, params);
  var excelBlob = response.getBlob().setName(sheetName + "_" + Utilities.formatDate(new Date(), "GMT+8", "yyyyMMdd") + ".xlsx");
  
  // Ilagay ang email address kung saan ipapadala
  var emailRecipient = Session.getActiveUser().getEmail(); // O palitan ng "your_email@gmail.com"
  
  // Custom Subject
  var subject = "GVSI NetPulse DB (" + dateTimeToday + ")";
  var body = "Magandang araw,\n\nAttached ang automated Excel backup ng GVSI NetPulse Database para sa araw na ito (" + dateTimeToday + ").";
  
  GmailApp.sendEmail(emailRecipient, subject, body, {
    attachments: [excelBlob]
  });
}