/**
 * Apps Script Web App — proxy do Mercado Pago para a plataforma do curso.
 *
 * O que este arquivo faz:
 *  - Cria cobranças Pix dinâmicas (QR code + copia-e-cola) via API do Mercado Pago.
 *  - Responde consultas de status de uma cobrança (usadas pelo polling da página).
 *  - Recebe o webhook do Mercado Pago quando um pagamento é aprovado e atualiza
 *    automaticamente o usuário (ou o cadastro/anamnese) no JSONBin — sem precisar
 *    de nenhuma ação manual do admin.
 *
 * COMO PUBLICAR (uma única vez):
 *  1. Acesse https://script.google.com/ → Novo projeto.
 *  2. Apague o conteúdo padrão de Code.gs e cole o conteúdo deste arquivo.
 *  3. Vá em "Configurações do projeto" (ícone de engrenagem) → "Propriedades do script"
 *     → "Adicionar propriedade do script" e cadastre estas três:
 *       MP_ACCESS_TOKEN   = seu Access Token de produção do Mercado Pago (APP_USR-...)
 *       JSONBIN_BIN_ID    = 69fbc777250b1311c313d5f9   (o mesmo BIN_ID do index.html)
 *       JSONBIN_API_KEY   = a mesma X-Master-Key usada no index.html
 *  4. Clique em "Implantar" → "Nova implantação" → tipo "Aplicativo da Web".
 *     - Executar como: "Eu" (sua conta)
 *     - Quem pode acessar: "Qualquer pessoa"
 *  5. Copie a URL gerada (termina em /exec). Cole essa URL no painel admin da
 *     plataforma, na aba "Mensalidades" → card "Integração Mercado Pago".
 *  6. No painel do Mercado Pago (developers.mercadopago.com.br/panel), na sua
 *     aplicação, vá em "Webhooks" → "Configurar notificações" → cole a mesma URL
 *     do passo 5 e marque o evento "Pagamentos".
 *
 * Depois disso, tudo funciona sozinho: a página pede uma cobrança, mostra o QR,
 * e quando o participante paga, o Mercado Pago avisa este script, que libera o
 * acesso automaticamente.
 */

function doGet(e) {
  return handleRequest(e);
}
function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    var params = (e && e.parameter) || {};
    var body = {};
    if (e && e.postData && e.postData.contents) {
      try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
    }

    if (params.action === 'criarPix') return criarCobrancaPix(params);
    if (params.action === 'statusPix') return statusCobrancaPix(params.paymentId);

    // Webhook do Mercado Pago: chega como POST, com "type"/"topic" indicando pagamento.
    var tipo = params.type || body.type || params.topic;
    var paymentId = params['data.id'] || (body.data && body.data.id) || params.id;
    if (tipo === 'payment' && paymentId) {
      return processarWebhookPagamento(paymentId);
    }

    return jsonResponse({ ok: false, erro: 'ação desconhecida' });
  } catch (err) {
    return jsonResponse({ ok: false, erro: String(err) });
  }
}

function getProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function mpHeaders() {
  return { Authorization: 'Bearer ' + getProp('MP_ACCESS_TOKEN') };
}

/**
 * Cria uma cobrança Pix. Parâmetros esperados (query string):
 *  - valor: número (ex.: 150.00)
 *  - referencia: identificador único usado para casar o pagamento com o
 *    participante depois, no formato "usuario-123" ou "cadastro-456"
 *  - nome, email: dados do pagador (email precisa ter formato válido)
 */
function criarCobrancaPix(params) {
  var valor = Number(params.valor);
  var referencia = String(params.referencia || '');
  var nome = params.nome || 'Participante';
  var email = params.email || 'participante@exemplo.com';

  if (!valor || valor <= 0 || !referencia) {
    return jsonResponse({ ok: false, erro: 'valor ou referência inválidos' });
  }

  var payload = {
    transaction_amount: valor,
    description: 'Mensalidade do curso — ' + nome,
    payment_method_id: 'pix',
    external_reference: referencia,
    payer: { email: email }
  };

  var resp = UrlFetchApp.fetch('https://api.mercadopago.com/v1/payments', {
    method: 'post',
    contentType: 'application/json',
    headers: Object.assign(mpHeaders(), { 'X-Idempotency-Key': Utilities.getUuid() }),
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());

  if (!data.id) {
    return jsonResponse({ ok: false, erro: data.message || 'Não foi possível criar a cobrança', detalhe: data });
  }

  var tx = data.point_of_interaction && data.point_of_interaction.transaction_data;
  return jsonResponse({
    ok: true,
    paymentId: data.id,
    status: data.status,
    qrCode: tx ? tx.qr_code : '',
    qrCodeBase64: tx ? tx.qr_code_base64 : ''
  });
}

/** Consulta o status de uma cobrança (usado pelo polling da página). */
function statusCobrancaPix(paymentId) {
  if (!paymentId) return jsonResponse({ ok: false, erro: 'paymentId ausente' });
  var resp = UrlFetchApp.fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
    method: 'get',
    headers: mpHeaders(),
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());
  return jsonResponse({ ok: true, status: data.status, referencia: data.external_reference });
}

/** Recebido quando o Mercado Pago notifica um evento de pagamento. */
function processarWebhookPagamento(paymentId) {
  var resp = UrlFetchApp.fetch('https://api.mercadopago.com/v1/payments/' + paymentId, {
    method: 'get',
    headers: mpHeaders(),
    muteHttpExceptions: true
  });
  var data = JSON.parse(resp.getContentText());
  if (data.status === 'approved' && data.external_reference) {
    aplicarPagamentoConfirmado(data.external_reference, data.id);
  }
  return jsonResponse({ ok: true });
}

/**
 * Atualiza o JSONBin quando um pagamento é confirmado.
 * referencia no formato "usuario-<id>" (mensalidade) ou "cadastro-<id>" (inscrição).
 */
function aplicarPagamentoConfirmado(referencia, paymentId) {
  var binId = getProp('JSONBIN_BIN_ID');
  var apiKey = getProp('JSONBIN_API_KEY');
  var base = 'https://api.jsonbin.io/v3/b/' + binId;

  var getResp = UrlFetchApp.fetch(base + '/latest', { headers: { 'X-Master-Key': apiKey } });
  var record = JSON.parse(getResp.getContentText()).record;
  var respostas = record.respostas || {};

  var agora = new Date();
  var fuso = 'GMT-3';
  var dataHoje = Utilities.formatDate(agora, fuso, 'yyyy-MM-dd');
  var fim = new Date(agora);
  fim.setMonth(fim.getMonth() + 1);
  var dataFim = Utilities.formatDate(fim, fuso, 'yyyy-MM-dd');
  var dataHoraTexto = Utilities.formatDate(agora, fuso, "dd/MM/yyyy HH:mm:ss");

  var mudou = false;

  if (referencia.indexOf('usuario-') === 0) {
    var usuarioId = referencia.replace('usuario-', '');
    var usuario = (respostas.usuarios || []).filter(function (u) { return String(u.id) === usuarioId; })[0];
    if (usuario) {
      usuario.pagamento = 'em dia';
      usuario.bloqueado = false;
      usuario.mensalidadeInicio = dataHoje;
      usuario.mensalidadeFim = dataFim;
      usuario.ultimoPagamentoMP = { paymentId: paymentId, confirmadoEm: dataHoraTexto };
      mudou = true;
    }
  } else if (referencia.indexOf('cadastro-') === 0) {
    var cadastroId = referencia.replace('cadastro-', '');
    var cadastro = (respostas.cadastros || []).filter(function (c) { return String(c.id) === cadastroId; })[0];
    if (cadastro) {
      cadastro.pagamentoConfirmadoMP = { paymentId: paymentId, confirmadoEm: dataHoraTexto };
      mudou = true;
    }
  }

  if (mudou) {
    UrlFetchApp.fetch(base, {
      method: 'put',
      contentType: 'application/json',
      headers: { 'X-Master-Key': apiKey },
      payload: JSON.stringify(record),
      muteHttpExceptions: true
    });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
