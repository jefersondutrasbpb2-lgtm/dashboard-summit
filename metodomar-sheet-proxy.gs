/**
 * Proxy da planilha de vendas do Método MAR para o dashboard.
 * Mesmo padrão do script que já roda para a planilha do Summit — só troca
 * o ID da planilha e o nome da aba.
 */
function doGet() {
  var id = '1yVQgtFwbCMpcu4aDP3Ghz9wv4tuvYnhNRdRtNBuQYCw';
  var aba = 'Página1';
  var ss = SpreadsheetApp.openById(id);
  var sheet = ss.getSheetByName(aba);
  var data = sheet.getDataRange().getValues();
  var json = JSON.stringify(data);
  var output = ContentService.createTextOutput(json);
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}
