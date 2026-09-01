/**
 * Proxy do Meta Ads para os dashboards (Summit Paraíba e Método MAR).
 *
 * O QUE ISSO FAZ
 * Busca gasto, impressões, cliques, leads, compras e receita reportados
 * pelo Meta Ads e devolve os números já calculados em JSON. O token de
 * acesso do Meta fica guardado nas "Propriedades do script" (criptografado
 * pelo Google), nunca aparece no código nem no dashboard público.
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
 *
 * PARÂMETROS ACEITOS NA URL
 *   days=7|30|90|0            -> atalho pros mesmos períodos do Gerenciador
 *   since=YYYY-MM-DD&until=…  -> período customizado
 *   campaign_filter=palavra   -> só campanhas cujo nome contém essa palavra
 *                                 (case-insensitive). Vazio = todas as campanhas
 *                                 da conta. Usado quando a mesma conta roda mais
 *                                 de um evento ao mesmo tempo.
 */

// Tipos de ação do Meta que contam como "lead" pra este dashboard. Cobre
// formulário nativo (Instant Form / lead do site) e clique-pra-conversa no
// WhatsApp. Se os números não baterem com o Gerenciador, ajuste esta lista.
var LEAD_ACTION_TYPES = {
  'lead': 1,
  'onsite_conversion.lead_grouped': 1,
  'onsite_conversion.messaging_conversation_started_7d': 1
};

function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('META_ACCESS_TOKEN');
  var actId = props.getProperty('META_AD_ACCOUNT_ID');

  if (!token || !actId) {
    return jsonOut({error: 'Configure META_ACCESS_TOKEN e META_AD_ACCOUNT_ID nas Propriedades do script.'});
  }

  // Usa os MESMOS períodos oficiais do Gerenciador de Anúncios (date_preset),
  // para os números baterem exatamente. Datas personalizadas usam time_range.
  var timeParam;
  if (e.parameter.since && e.parameter.until) {
    timeParam = 'time_range=' + encodeURIComponent(JSON.stringify({since: e.parameter.since, until: e.parameter.until}));
  } else {
    var days = (e.parameter.days || '30');
    var presetMap = {'7': 'last_7d', '30': 'last_30d', '90': 'last_90d', '0': 'maximum', 'all': 'maximum'};
    var preset = presetMap[days] || 'last_30d';
    timeParam = 'date_preset=' + preset;
  }

  // time_increment=1 pede uma linha por (campanha, dia) em vez de uma linha
  // por campanha só. Com isso dá pra somar tanto os totais por campanha
  // (agrupando os dias) quanto o ritmo diário de gasto/leads (agrupando as
  // campanhas), numa chamada só à API.
  var url = 'https://graph.facebook.com/v21.0/' + actId + '/insights' +
    '?level=campaign&limit=500&time_increment=1' +
    '&fields=campaign_name,spend,impressions,clicks,actions,action_values' +
    '&' + timeParam +
    '&access_token=' + encodeURIComponent(token);

  try {
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    var body = JSON.parse(resp.getContentText());

    if (body.error) {
      return jsonOut({error: 'Erro do Meta: ' + body.error.message});
    }

    // Filtro opcional por nome de campanha (?campaign_filter=palavra-chave), sem diferenciar
    // maiúsc/minúsc. Usado quando a mesma conta de anúncio roda mais de um evento/produto ao
    // mesmo tempo, para cada dashboard só ver as próprias campanhas. Sem o parâmetro, retorna
    // tudo como antes (comportamento padrão inalterado).
    var campaignFilter = (e.parameter.campaign_filter || '').toLowerCase().trim();
    var rawData = body.data || [];
    if (campaignFilter) {
      rawData = rawData.filter(function(row) {
        return String(row.campaign_name || '').toLowerCase().indexOf(campaignFilter) >= 0;
      });
    }

    function extractPurchasesRevenue(row) {
      var purchases = 0, revenue = 0;
      // IMPORTANTE: contar SOMENTE 'omni_purchase'. O Meta devolve a mesma compra
      // em várias linhas (omni_purchase, purchase, offsite_conversion.fb_pixel_purchase...).
      // Somar mais de uma conta a mesma venda 2x e dobra os números. 'omni_purchase'
      // é a métrica unificada e é a que bate com o Gerenciador de Anúncios.
      (row.actions || []).forEach(function(a) {
        if (a.action_type === 'omni_purchase') purchases += parseFloat(a.value || 0);
      });
      (row.action_values || []).forEach(function(a) {
        if (a.action_type === 'omni_purchase') revenue += parseFloat(a.value || 0);
      });
      return {purchases: purchases, revenue: revenue};
    }

    function extractLeads(row) {
      var leads = 0;
      (row.actions || []).forEach(function(a) {
        if (LEAD_ACTION_TYPES[a.action_type]) leads += parseFloat(a.value || 0);
      });
      return leads;
    }

    // ---- Agrupa por campanha (soma os dias de cada campanha) ----
    var byCampaign = {};
    var order = [];
    rawData.forEach(function(row) {
      var name = row.campaign_name;
      if (!byCampaign[name]) {
        byCampaign[name] = {campaign: name, spend: 0, impressions: 0, clicks: 0, leads: 0, purchases: 0, revenue: 0};
        order.push(name);
      }
      var pr = extractPurchasesRevenue(row);
      byCampaign[name].spend += parseFloat(row.spend || 0);
      byCampaign[name].impressions += parseFloat(row.impressions || 0);
      byCampaign[name].clicks += parseFloat(row.clicks || 0);
      byCampaign[name].leads += extractLeads(row);
      byCampaign[name].purchases += pr.purchases;
      byCampaign[name].revenue += pr.revenue;
    });

    var items = order.map(function(name) {
      var c = byCampaign[name];
      return {
        campaign: c.campaign,
        spend: c.spend,
        impressions: c.impressions,
        clicks: c.clicks,
        leads: c.leads,
        purchases: c.purchases,
        revenue: c.revenue,
        roas: c.spend > 0 ? (c.revenue / c.spend) : 0,
        ctr: c.impressions > 0 ? (c.clicks / c.impressions) * 100 : 0,
        cpc: c.clicks > 0 ? (c.spend / c.clicks) : 0,
        cpm: c.impressions > 0 ? (c.spend / c.impressions) * 1000 : 0,
        cpl: c.leads > 0 ? (c.spend / c.leads) : 0
      };
    });

    // ---- Agrupa por dia (soma as campanhas de cada dia) — ritmo diário ----
    var byDay = {};
    var dayOrder = [];
    rawData.forEach(function(row) {
      var date = row.date_start;
      if (!date) return;
      if (!byDay[date]) {
        byDay[date] = {date: date, spend: 0, leads: 0, purchases: 0, revenue: 0};
        dayOrder.push(date);
      }
      var pr = extractPurchasesRevenue(row);
      byDay[date].spend += parseFloat(row.spend || 0);
      byDay[date].leads += extractLeads(row);
      byDay[date].purchases += pr.purchases;
      byDay[date].revenue += pr.revenue;
    });
    dayOrder.sort();
    var daily = dayOrder.map(function(d) { return byDay[d]; });

    var totalImpressions = items.reduce(function(s, i) { return s + i.impressions; }, 0);

    // ---- Alcance e frequência: NÃO dá pra somar dia a dia (contaria a mesma
    // pessoa várias vezes e o número não bate com o Gerenciador). Por isso é
    // uma segunda chamada, pro período inteiro de uma vez só, sem time_increment. ----
    var reachUrl = 'https://graph.facebook.com/v21.0/' + actId + '/insights' +
      '?level=campaign&limit=500&fields=campaign_name,reach,frequency' +
      '&' + timeParam +
      '&access_token=' + encodeURIComponent(token);
    var reachByCampaign = {};
    var totalReach = 0, totalFrequency = 0;
    try {
      var reachResp = UrlFetchApp.fetch(reachUrl, {muteHttpExceptions: true});
      var reachBody = JSON.parse(reachResp.getContentText());
      if (!reachBody.error) {
        var reachData = reachBody.data || [];
        if (campaignFilter) {
          reachData = reachData.filter(function(row) {
            return String(row.campaign_name || '').toLowerCase().indexOf(campaignFilter) >= 0;
          });
        }
        reachData.forEach(function(row) {
          reachByCampaign[row.campaign_name] = {
            reach: parseFloat(row.reach || 0),
            frequency: parseFloat(row.frequency || 0)
          };
        });
        // Alcance total da conta/filtro: soma simples é uma aproximação (pode haver
        // gente alcançada por mais de uma campanha), mas é o mesmo critério que o
        // Gerenciador usa ao somar linhas de campanhas diferentes.
        totalReach = reachData.reduce(function(s, r) { return s + parseFloat(r.reach || 0); }, 0);
        totalFrequency = totalReach > 0 ? (totalImpressions / totalReach) : 0;
      }
    } catch (reachErr) {
      // Se essa segunda chamada falhar, segue sem alcance/frequência em vez de
      // quebrar o resto dos dados (que já vieram certos na primeira chamada).
    }
    items.forEach(function(it) {
      var r = reachByCampaign[it.campaign];
      it.reach = r ? r.reach : 0;
      it.frequency = r ? r.frequency : 0;
    });

    var totalSpend = items.reduce(function(s, i) { return s + i.spend; }, 0);
    var totalRevenue = items.reduce(function(s, i) { return s + i.revenue; }, 0);
    var totalPurchases = items.reduce(function(s, i) { return s + i.purchases; }, 0);
    var totalClicks = items.reduce(function(s, i) { return s + i.clicks; }, 0);
    var totalLeads = items.reduce(function(s, i) { return s + i.leads; }, 0);

    return jsonOut({
      items: items,
      daily: daily,
      totalSpend: totalSpend,
      totalRevenue: totalRevenue,
      totalPurchases: totalPurchases,
      totalImpressions: totalImpressions,
      totalClicks: totalClicks,
      totalLeads: totalLeads,
      totalReach: totalReach,
      totalFrequency: totalFrequency,
      totalRoas: totalSpend > 0 ? (totalRevenue / totalSpend) : 0,
      totalCtr: totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0,
      totalCpc: totalClicks > 0 ? (totalSpend / totalClicks) : 0,
      totalCpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : 0,
      totalCpl: totalLeads > 0 ? (totalSpend / totalLeads) : 0
    });
  } catch (err) {
    return jsonOut({error: 'Falha ao buscar dados do Meta: ' + err.message});
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
