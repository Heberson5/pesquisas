'use strict';
// Cliente mínimo da API do Mercado Pago (somente o que o faturamento usa).
//   • Assinatura no cartão: /preapproval (o cliente cadastra o cartão na página do Mercado Pago; nada de cartão passa por aqui).
//   • PIX/boleto: /checkout/preferences sem cartão (link de pagamento).
//   • Consulta de pagamento, assinatura e cobrança da assinatura (as notificações nunca são confiáveis sozinhas:
//     sempre buscamos o dado na API antes de dar baixa).
//   • Validação da assinatura das notificações (cabeçalho x-signature, HMAC-SHA256).
// O token de acesso fica criptografado nas configurações da plataforma (Master → Configurações gerais → Faturamento).
const crypto = require('node:crypto');
const { getPlatform, setPlatform } = require('./settings');
const { encrypt, decrypt } = require('./vault');
const { bad, HttpError } = require('./validate');

const API = 'https://api.mercadopago.com';
const net = { fetch: (...a) => fetch(...a), timeoutMs: 15_000 }; // trocável nos testes

function stored() { return getPlatform('billing', {}) || {}; }
function credentials() {
  const s = stored();
  return { accessToken: s.tokenEnc ? decrypt(s.tokenEnc) : (process.env.MP_ACCESS_TOKEN || null), webhookSecret: s.secretEnc ? decrypt(s.secretEnc) : (process.env.MP_WEBHOOK_SECRET || null) };
}
const configured = () => !!credentials().accessToken;

function publicView() {
  const s = stored(); const c = credentials();
  return { configured: !!c.accessToken, tokenSet: !!c.accessToken, tokenHint: c.accessToken ? c.accessToken.slice(0, 8) + '…' + c.accessToken.slice(-4) : null,
    secretSet: !!c.webhookSecret, sandbox: c.accessToken ? /^TEST-/.test(c.accessToken) : false, source: s.tokenEnc ? 'painel' : c.accessToken ? 'servidor' : null,
    graceBusinessDays: 5 };
}

function save(input = {}) {
  const s = stored();
  if (input.clear === true) { setPlatform('billing', {}); return publicView(); }
  if (input.accessToken !== undefined && input.accessToken !== '') {
    const t = String(input.accessToken).trim();
    if (!/^(APP_USR|TEST)-[A-Za-z0-9-]{20,200}$/.test(t)) throw bad('Token de acesso inválido. Copie o "Access Token" de Suas integrações → Credenciais (começa com APP_USR- ou TEST-).');
    s.tokenEnc = encrypt(t);
  }
  if (input.webhookSecret !== undefined && input.webhookSecret !== '') {
    const w = String(input.webhookSecret).trim();
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(w)) throw bad('Assinatura secreta inválida. Copie de Suas integrações → Webhooks → Assinatura secreta.');
    s.secretEnc = encrypt(w);
  }
  setPlatform('billing', s);
  return publicView();
}

async function call(method, path, body = null, { idempotencyKey = null } = {}) {
  const { accessToken } = credentials();
  if (!accessToken) throw new HttpError(503, 'O Mercado Pago ainda não foi configurado pela plataforma.');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;
  let res;
  try {
    res = await net.fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(net.timeoutMs) });
  } catch (e) { throw Object.assign(new HttpError(502, 'Não foi possível falar com o Mercado Pago agora. Tente novamente em instantes.'), { cause: e }); }
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`;
    throw Object.assign(new HttpError(res.status === 404 ? 404 : 502, `Mercado Pago recusou a operação: ${String(msg).slice(0, 200)}`), { mpStatus: res.status });
  }
  return json;
}

const cents = (v) => Math.round(Number(v) * 100);
const reais = (c) => Math.round(c) / 100;

// Assinatura mensal no cartão. O cliente é levado ao init_point para cadastrar o cartão.
const createPreapproval = ({ companyId, reason, payerEmail, amountCents, backUrl }) => call('POST', '/preapproval', {
  reason: String(reason).slice(0, 100), external_reference: `company:${companyId}`, payer_email: payerEmail, back_url: backUrl, status: 'pending',
  auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: reais(amountCents), currency_id: 'BRL' },
}, { idempotencyKey: `preapproval-${companyId}-${amountCents}-${Math.floor(Date.now() / 600_000)}` });
const getPreapproval = (id) => call('GET', `/preapproval/${encodeURIComponent(id)}`);
const updatePreapproval = (id, body) => call('PUT', `/preapproval/${encodeURIComponent(id)}`, body);
const getAuthorizedPayment = (id) => call('GET', `/authorized_payments/${encodeURIComponent(id)}`);
const getPayment = (id) => call('GET', `/v1/payments/${encodeURIComponent(id)}`);

// Link de pagamento só com PIX e boleto (cartão fica de fora: cartão é sempre pela assinatura).
const createPixBoletoPreference = ({ invoiceId, title, amountCents, payerEmail, notificationUrl, backUrl, expiresAt }) => call('POST', '/checkout/preferences', {
  items: [{ id: `invoice-${invoiceId}`, title: String(title).slice(0, 120), quantity: 1, unit_price: reais(amountCents), currency_id: 'BRL' }],
  external_reference: `invoice:${invoiceId}`, payer: payerEmail ? { email: payerEmail } : undefined,
  payment_methods: { excluded_payment_types: [{ id: 'credit_card' }, { id: 'debit_card' }, { id: 'prepaid_card' }], installments: 1 },
  notification_url: notificationUrl, back_urls: { success: backUrl, pending: backUrl, failure: backUrl }, auto_return: 'approved',
  expires: !!expiresAt, date_of_expiration: expiresAt ? new Date(expiresAt).toISOString().replace('Z', '-00:00') : undefined,
  statement_descriptor: 'PESQUISA NPS',
}, { idempotencyKey: `pref-${invoiceId}-${amountCents}` });

const testConnection = () => call('GET', '/users/me');

// Notificação: x-signature = "ts=<seg>,v1=<hex>"; manifesto "id:<data.id>;request-id:<x-request-id>;ts:<ts>;".
function verifySignature({ signature, requestId, dataId }) {
  const { webhookSecret } = credentials();
  if (!webhookSecret) return { ok: false, reason: 'sem assinatura secreta configurada' };
  const parts = Object.fromEntries(String(signature || '').split(',').map((kv) => kv.split('=').map((x) => x.trim())).filter((kv) => kv.length === 2));
  if (!parts.ts || !parts.v1 || !/^[0-9a-f]{64}$/i.test(parts.v1)) return { ok: false, reason: 'assinatura ausente ou malformada' };
  const id = /^[a-z0-9]+$/i.test(String(dataId || '')) ? String(dataId).toLowerCase() : String(dataId || '');
  let manifest = '';
  if (id) manifest += `id:${id};`;
  if (requestId) manifest += `request-id:${requestId};`;
  manifest += `ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', webhookSecret).update(manifest).digest('hex');
  const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1.toLowerCase()));
  // Rejeita notificações velhas (proteção contra reenvio): 1 hora de tolerância.
  const tsMs = Number(parts.ts) * (String(parts.ts).length <= 10 ? 1000 : 1);
  if (ok && Math.abs(Date.now() - tsMs) > 3_600_000) return { ok: false, reason: 'notificação antiga' };
  return ok ? { ok: true } : { ok: false, reason: 'assinatura não confere' };
}

module.exports = {
  net, API, configured, credentials, publicView, save, cents, reais,
  createPreapproval, getPreapproval, updatePreapproval, getAuthorizedPayment, getPayment, createPixBoletoPreference, testConnection, verifySignature,
};
