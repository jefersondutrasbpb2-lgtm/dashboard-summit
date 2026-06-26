/**
 * Proxy do Meta Ads para o dashboard Summit Paraíba.
 *
 * O QUE ISSO FAZ
 * Busca gasto, compras e receita reportados pelo Meta Ads e devolve só os
 * números já calculados (gasto, ROAS) em JSON. O token de acesso do Meta
 * fica guardado nas "Propriedades do script" (criptografado pelo Google),
 * nunca aparece no código nem no dashboard público.
 *
 * COMO IMPLANTAR
 * 1. Acesse https://script.google.com e crie um novo projeto.
 * 2. Cole este código no editor (substitua o Code.gs padrão).
 * 3. Vá em "Configurações do projeto" (ícone de engrenagem) > "Propriedades do script"
 *    e adicione:
 *      META_ACCESS_TOKEN = <seu token de acesso do Meta com permissão ads_read>
 *      META_AD_ACCOUNT_ID = act_1437815673598994   (conta "Ancora X - Alternativo")
 * 4. Clique em Implantar > Nova implantação > tipo "App da Web".
 *    - Executar como: Eu
 *    - Quem pode acessar: Qualquer pessoa
 * 5. Copie a URL gerada (termina em /exec) e me envie. Eu coloco essa URL
 *    no dashboard como SCRIPT_URL_META.
 *
 * Como gerar o META_ACCESS_TOKEN:
 * Acesse https://developers.facebook.com/tools/explorer/, selecione seu
 * app, peça a permissão "ads_read" e gere um token. Para não precisar
 * renovar toda hora, troque por um token de longa duração (60 dias) ou,
 * melhor ainda, use um "System User Token" do Business Manager (não expira).
 */

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('META_ACCESS_TOKEN');
  var actId = props.getProperty('META_AD_ACCOUNT_ID');

  if (!token || !actId) {
    return jsonOut({error: 'Configure META_ACCESS_TOKEN e META_AD_ACCOUNT_ID nas Propriedades do script.'});
  }

  var days = (e.parameter.days || '30');
  var timeParam;
  if (days === '0' || days === 'all') {
    timeParam = 'date_preset=maximum';
  } else {
    var until = new Date();
    var since = new Date();
    since.setDate(since.getDate() - parseInt(days, 10));
    var fmt = function(d) { return d.toISOString().split('T')[0]; };
    timeParam = 'time_range=' + encodeURIComponent(JSON.stringify({since: fmt(since), until: fmt(until)}));
  }

  var url = 'https://graph.facebook.com/v21.0/' + actId + '/insights' +
    '?level=campaign&limit=200&fields=campaign_name,spend,actions,action_values' +
    '&' + timeParam +
    '&access_token=' + encodeURIComponent(token);

  try {
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    var body = JSON.parse(resp.getContentText());

    if (body.error) {
      return jsonOut({error: 'Erro do Meta: ' + body.error.message});
    }

    var items = (body.data || []).map(function(row) {
      var spend = parseFloat(row.spend || 0);
      var purchases = 0, revenue = 0;
      (row.actions || []).forEach(function(a) {
        if (a.action_type === 'omni_purchase' || a.action_type === 'purchase') {
          purchases += parseFloat(a.value || 0);
        }
      });
      (row.action_values || []).forEach(function(a) {
        if (a.action_type === 'omni_purchase' || a.action_type === 'purchase') {
          revenue += parseFloat(a.value || 0);
        }
      });
      return {
        campaign: row.campaign_name,
        spend: spend,
        purchases: purchases,
        revenue: revenue,
        roas: spend > 0 ? (revenue / spend) : 0
      };
    });

    var totalSpend = items.reduce(function(s, i) { return s + i.spend; }, 0);
    var totalRevenue = items.reduce(function(s, i) { return s + i.revenue; }, 0);
    var totalPurchases = items.reduce(function(s, i) { return s + i.purchases; }, 0);

    return jsonOut({
      items: items,
      totalSpend: totalSpend,
      totalRevenue: totalRevenue,
      totalPurchases: totalPurchases,
      totalRoas: totalSpend > 0 ? (totalRevenue / totalSpend) : 0
    });
  } catch (err) {
    return jsonOut({error: 'Falha ao buscar dados do Meta: ' + err.message});
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
