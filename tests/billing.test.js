'use strict';
// Faturamento (Mercado Pago simulado): credenciais, assinatura no cartão, notificações assinadas e idempotentes,
// PIX/boleto só pelo Master, fim do teste grátis, atraso → suspensão no fim do 5º dia útil, painel limitado e liberação.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, stop, Client, makeUser, get, run, newCompany } = require('./helpers');
const mp = require('../src/mercadopago');
const billing = require('../src/billing');
const { graceDeadline, addBusinessDays } = require('../src/businessDays');

const TOKEN = 'TEST-1234567890123456-101415-abcdefabcdefabcdefabcdefabcdef12-123456789';
const SECRET = 'segredoDoWebhookMercadoPago123';
const calls = [];
const resources = { payments: {}, preapprovals: {}, authorized: {} };
mp.net.fetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
  const json = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });
  const u = new URL(url);
  if (u.pathname === '/users/me') return json(200, { id: 99, nickname: 'PLATAFORMA', email: 'dono@plataforma.com', site_id: 'MLB' });
  if (u.pathname === '/preapproval' && opts.method === 'POST') return json(201, { id: 'pre-' + calls.length, init_point: 'https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=x', status: 'pending' });
  if (u.pathname === '/checkout/preferences') return json(201, { id: 'pref-' + calls.length, init_point: 'https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=y' });
  let m;
  if ((m = /^\/preapproval\/(.+)$/.exec(u.pathname))) {
    if (opts.method === 'PUT') return json(200, { id: m[1], status: 'cancelled' });
    return resources.preapprovals[m[1]] ? json(200, resources.preapprovals[m[1]]) : json(404, { message: 'not found' });
  }
  if ((m = /^\/v1\/payments\/(.+)$/.exec(u.pathname))) return resources.payments[m[1]] ? json(200, resources.payments[m[1]]) : json(404, { message: 'not found' });
  if ((m = /^\/authorized_payments\/(.+)$/.exec(u.pathname))) return resources.authorized[m[1]] ? json(200, resources.authorized[m[1]]) : json(404, { message: 'not found' });
  return json(404, { message: 'rota não simulada ' + u.pathname });
};

// Notificação como o Mercado Pago envia (com x-signature válida, salvo se pedirmos o contrário).
function notify(type, id, { badSig = false, ts = Math.floor(Date.now() / 1000) } = {}) {
  const requestId = crypto.randomUUID();
  const v1 = crypto.createHmac('sha256', badSig ? 'outro-segredo-qualquer-123' : SECRET).update(`id:${String(id).toLowerCase()};request-id:${requestId};ts:${ts};`).digest('hex');
  return new Client().req('POST', `/api/webhooks/mercadopago?type=${type}&data.id=${id}`, {
    body: { type, action: 'updated', data: { id } }, headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId } });
}

let master; let admin; let gestor; let cid; let plan; let tok; let branch;
const kioskCfg = () => new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tok } });
const company = () => get('SELECT * FROM companies WHERE id = ?', cid);

test.before(async () => {
  await start();
  makeUser('master@bill.local', 'master');
  master = new Client(); await master.login('master@bill.local', 'SenhaForte123');
  cid = newCompany('Empresa Cobrança');
  plan = get("SELECT id, price_cents FROM plans WHERE name = 'Profissional'");
  run("UPDATE companies SET plan_id = ?, status = 'trial', trial_ends_at = ? WHERE id = ?", plan.id, Date.now() + 5 * 86_400_000, cid);
  makeUser('adm@bill.local', 'admin', 'SenhaForte123', [], { companyId: cid });
  admin = new Client(); await admin.login('adm@bill.local', 'SenhaForte123');
  branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'B1', name: 'Cobrança 1' } })).json.id;
  makeUser('gestor@bill.local', 'gestor', 'SenhaForte123', [branch], { companyId: cid });
  gestor = new Client(); await gestor.login('gestor@bill.local', 'SenhaForte123');
  const d = await admin.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tab' } });
  tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
});
test.after(stop);

test('dias úteis: Carnaval, Sexta-feira Santa, fins de semana e prazo de suspensão', () => {
  assert.equal(addBusinessDays('2026-02-13', 5), '2026-02-24', 'pula fim de semana e Carnaval');
  assert.equal(addBusinessDays('2026-04-01', 1), '2026-04-02');
  assert.equal(addBusinessDays('2026-04-02', 1), '2026-04-06', 'pula Sexta-feira Santa');
  assert.equal(addBusinessDays('2026-12-23', 5), '2026-12-31', 'pula Natal');
  // Vence 13/10/2026 (terça): 5º dia útil = 20/10; suspende à meia-noite de 21/10 (horário de Brasília).
  assert.equal(new Date(graceDeadline('2026-10-13', 'America/Sao_Paulo')).toISOString(), '2026-10-21T03:00:00.000Z');
});

test('credenciais do Mercado Pago: só o Master, validadas, criptografadas e nunca devolvidas', async () => {
  assert.equal((await admin.req('PUT', '/api/admin/master/billing', { body: { accessToken: TOKEN } })).status, 403);
  assert.equal((await master.req('PUT', '/api/admin/master/billing', { body: { accessToken: 'chave-errada' } })).status, 400);
  const r = await master.req('PUT', '/api/admin/master/billing', { body: { accessToken: TOKEN, webhookSecret: SECRET } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.configured, true); assert.equal(r.json.secretSet, true); assert.equal(r.json.sandbox, true);
  assert.ok(!r.text.includes(TOKEN) && !r.text.includes(SECRET));
  assert.ok(!get("SELECT value FROM platform_settings WHERE key = 'billing'").value.includes(TOKEN), 'criptografado no banco');
  const t = await master.req('POST', '/api/admin/master/billing/test');
  assert.equal(t.json.account.nickname, 'PLATAFORMA');
  assert.equal(calls.at(-1).headers.Authorization, 'Bearer ' + TOKEN);
});

test('assinatura no cartão: o administrador assina; gestor não; a notificação assinada ativa a empresa', async () => {
  assert.equal((await gestor.req('POST', '/api/admin/billing/subscribe')).status, 403);
  const g = (await gestor.req('GET', '/api/admin/billing')).json;
  assert.equal(g.limited, true); assert.equal(g.invoices, undefined, 'gestor não vê valores');
  const s = await admin.req('POST', '/api/admin/billing/subscribe');
  assert.equal(s.status, 200, s.text);
  assert.match(s.json.url, /^https:\/\/www\.mercadopago\.com\.br\//);
  const sent = calls.find((c) => c.url.endsWith('/preapproval') && c.method === 'POST').body;
  assert.equal(sent.external_reference, `company:${cid}`); assert.equal(sent.auto_recurring.transaction_amount, plan.price_cents / 100);
  assert.equal(sent.auto_recurring.currency_id, 'BRL'); assert.equal(sent.payer_email, 'adm@bill.local');
  resources.preapprovals['pre-abc'] = { id: 'pre-abc', status: 'authorized', external_reference: `company:${cid}`, last_modified: '2026-10-14T09:00:00Z' };
  assert.equal((await notify('subscription_preapproval', 'pre-abc', { badSig: true })).status, 401, 'assinatura falsa recusada');
  assert.equal(company().mp_preapproval_id, null);
  assert.equal((await notify('subscription_preapproval', 'pre-abc', { ts: Math.floor(Date.now() / 1000) - 7200 })).status, 401, 'notificação velha recusada');
  const ok = await notify('subscription_preapproval', 'pre-abc');
  assert.equal(ok.status, 200, ok.text);
  const c = company();
  assert.equal(c.mp_preapproval_id, 'pre-abc'); assert.equal(c.mp_preapproval_status, 'authorized'); assert.equal(c.status, 'active');
  assert.ok(c.billing_day >= 1 && c.billing_day <= 28);
  assert.equal((await notify('subscription_preapproval', 'pre-abc')).json.duplicate, true, 'mesma notificação não processa duas vezes');
  assert.equal((await admin.req('POST', '/api/admin/billing/subscribe')).status, 409, 'já assinado');
});

test('cobrança aprovada da assinatura vira fatura paga (sem duplicar)', async () => {
  resources.authorized['7001'] = { id: 7001, preapproval_id: 'pre-abc', status: 'processed', transaction_amount: plan.price_cents / 100, currency_id: 'BRL', payment: { id: 555001, status: 'approved' } };
  assert.equal((await notify('subscription_authorized_payment', '7001')).status, 200);
  assert.equal((await notify('subscription_authorized_payment', '7001')).json.duplicate, true);
  const paid = get("SELECT * FROM invoices WHERE company_id = ? AND status = 'paid'", cid);
  assert.equal(paid.mp_payment_id, '555001'); assert.equal(paid.amount_cents, plan.price_cents); assert.equal(paid.method, 'card');
  assert.equal(get('SELECT COUNT(*) AS n FROM invoices WHERE company_id = ?', cid).n, 1);
  const view = (await admin.req('GET', '/api/admin/billing')).json;
  assert.equal(view.invoices.length, 1); assert.equal(view.plan.name, 'Profissional');
});

test('rotina cria a fatura do próximo mês 7 dias antes do vencimento', async () => {
  const c = company();
  const due = billing.addMonthsKeepDay(new Date().toISOString().slice(0, 10), 1, c.billing_day);
  const sixDaysBefore = Date.parse(due + 'T15:00:00Z') - 6 * 86_400_000;
  const r = await billing.runBilling(sixDaysBefore);
  assert.equal(r.invoices, 1);
  const inv = get("SELECT * FROM invoices WHERE company_id = ? AND status = 'open'", cid);
  assert.equal(inv.due_date, due); assert.equal(inv.period, due.slice(0, 7));
  assert.equal((await billing.runBilling(sixDaysBefore)).invoices, 0, 'não duplica a fatura do mês');
});

test('atraso: em atraso após o vencimento, suspensa no fim do 5º dia útil; painel limitado e tablets param; pagou, volta', async () => {
  const inv = get("SELECT * FROM invoices WHERE company_id = ? AND status = 'open'", cid);
  const deadline = graceDeadline(inv.due_date, 'America/Sao_Paulo');
  assert.equal(billing.reevaluate(cid, Date.parse(inv.due_date + 'T15:00:00Z') + 86_400_000), 'active', 'cartão: 3 dias de tolerância para a cobrança cair');
  assert.equal(billing.reevaluate(cid, Date.parse(inv.due_date + 'T15:00:00Z') + 4 * 86_400_000), 'past_due');
  assert.equal(company().status, 'past_due');
  assert.equal((await admin.req('GET', '/api/admin/branches')).status, 200, 'em atraso: tudo funciona');
  assert.equal((await kioskCfg()).status, 200);
  assert.equal(billing.reevaluate(cid, deadline - 60_000), 'past_due', 'um minuto antes do prazo ainda não suspende');
  assert.equal(billing.reevaluate(cid, deadline + 1), 'suspended');
  assert.equal(company().lock_kind, 'overdue');
  const blocked = await admin.req('GET', '/api/admin/branches');
  assert.equal(blocked.status, 402); assert.equal(blocked.json.code, 'COMPANY_LOCKED');
  assert.equal((await admin.req('GET', '/api/admin/billing')).status, 200, 'tela de pagamento liberada');
  assert.equal((await admin.req('GET', '/api/admin/me')).json.company.status, 'suspended');
  assert.equal((await kioskCfg()).status, 423, 'tablets param');
  assert.ok(get("SELECT 1 FROM outbox WHERE kind = 'billing' AND recipient = 'master@bill.local'"), 'Master avisado da suspensão');
  // Pagamento menor que a fatura não libera.
  resources.payments['9001'] = { id: 9001, status: 'approved', currency_id: 'BRL', transaction_amount: 1, external_reference: `invoice:${inv.id}`, payment_type_id: 'bank_transfer', payment_method_id: 'pix' };
  await notify('payment', '9001');
  assert.equal(get('SELECT status FROM invoices WHERE id = ?', inv.id).status, 'open');
  // Pagamento certo (PIX) libera na hora.
  resources.payments['9002'] = { id: 9002, status: 'approved', currency_id: 'BRL', transaction_amount: inv.amount_cents / 100, external_reference: `invoice:${inv.id}`, payment_type_id: 'bank_transfer', payment_method_id: 'pix' };
  const p = await notify('payment', '9002');
  assert.equal(p.status, 200, p.text);
  assert.equal(get('SELECT status, method FROM invoices WHERE id = ?', inv.id).method, 'pix');
  assert.equal(company().status, 'active');
  assert.equal((await admin.req('GET', '/api/admin/branches')).status, 200);
  assert.equal((await kioskCfg()).status, 200);
});

test('PIX/boleto: só o Master gera e envia; valida forma de cobrança; baixa manual exige observação', async () => {
  assert.equal((await master.req('POST', `/api/admin/master/companies/${cid}/billing`, { body: { method: 'cheque' } })).status, 400);
  assert.equal((await master.req('POST', `/api/admin/master/companies/${cid}/billing`, { body: { method: 'pix_boleto', billingDay: 31 } })).status, 400);
  assert.equal((await master.req('POST', `/api/admin/master/companies/${cid}/billing`, { body: { method: 'pix_boleto', billingDay: 10, autoInvoice: true } })).status, 200);
  assert.equal((await admin.req('POST', '/api/admin/billing/subscribe')).status, 400, 'empresa no PIX/boleto não assina cartão');
  const inv = await master.req('POST', `/api/admin/master/companies/${cid}/invoices`, { body: { dueDate: '2026-11-10', description: 'Implantação' , amountCents: 50000 } });
  assert.equal(inv.status, 201, inv.text);
  assert.equal((await admin.req('POST', `/api/admin/master/invoices/${inv.json.id}/pix`, { body: { send: true } })).status, 403);
  const pix = await master.req('POST', `/api/admin/master/invoices/${inv.json.id}/pix`, { body: { send: true } });
  assert.equal(pix.status, 200, pix.text); assert.match(pix.json.url, /^https:\/\//);
  const pref = calls.filter((c) => c.url.endsWith('/checkout/preferences')).at(-1).body;
  assert.equal(pref.external_reference, `invoice:${inv.json.id}`); assert.equal(pref.items[0].unit_price, 500);
  assert.deepEqual(pref.payment_methods.excluded_payment_types.map((x) => x.id).sort(), ['credit_card', 'debit_card', 'prepaid_card']);
  assert.ok(get("SELECT 1 FROM outbox WHERE kind = 'billing' AND recipient = 'adm@bill.local' AND body_text LIKE '%PIX%'"), 'link enviado por e-mail');
  assert.equal((await master.req('POST', `/api/admin/master/invoices/${inv.json.id}/paid`, { body: {} })).status, 400);
  assert.equal((await master.req('POST', `/api/admin/master/invoices/${inv.json.id}/paid`, { body: { note: 'Pago por transferência' } })).status, 200);
  assert.equal(get('SELECT status FROM invoices WHERE id = ?', inv.json.id).status, 'paid');
});

test('fim do teste grátis sem assinatura: suspende com a tela de pagamento; suspensão manual não é desfeita pela rotina', async () => {
  const c2 = newCompany('Empresa Teste Grátis');
  run("UPDATE companies SET plan_id = ?, status = 'trial', trial_ends_at = ? WHERE id = ?", plan.id, Date.now() - 1000, c2);
  makeUser('adm2@bill.local', 'admin', 'SenhaForte123', [], { companyId: c2 });
  const a2 = new Client(); await a2.login('adm2@bill.local', 'SenhaForte123');
  await billing.runBilling();
  const c = get('SELECT status, lock_kind FROM companies WHERE id = ?', c2);
  assert.equal(c.status, 'suspended'); assert.equal(c.lock_kind, 'trial_expired');
  assert.equal((await a2.req('GET', '/api/admin/stats')).status, 402);
  assert.equal((await a2.req('POST', '/api/admin/billing/subscribe')).status, 200, 'pode assinar mesmo bloqueada');
  // Suspensão feita pelo Master fica, mesmo sem faturas em aberto.
  await master.req('POST', `/api/admin/master/companies/${c2}/status`, { body: { status: 'active' } });
  await master.req('POST', `/api/admin/master/companies/${c2}/status`, { body: { status: 'suspended', reason: 'Pedido do cliente' } });
  await billing.runBilling();
  assert.equal(get('SELECT lock_kind, status FROM companies WHERE id = ?', c2).lock_kind, 'manual');
});

// ---------------------------------------------------------------- correções da revisão independente
const mkCompany = (name, extra = '') => {
  const id = newCompany(name);
  run(`UPDATE companies SET plan_id = ?, status = 'active', billing_method = 'card', billing_day = 10, mp_preapproval_id = ?, mp_preapproval_status = 'authorized' ${extra} WHERE id = ?`, plan.id, 'pre-' + name, id);
  return id;
};
const st = (id) => get('SELECT status, lock_kind, mp_preapproval_status FROM companies WHERE id = ?', id);

test('assinatura cancelada/pausada no Mercado Pago não dá acesso grátis: a fatura continua sendo gerada e vence', async () => {
  const id = mkCompany('rev-cancelada');
  resources.preapprovals['pre-rev-cancelada'] = { id: 'pre-rev-cancelada', status: 'cancelled', external_reference: `company:${id}`, last_modified: '2026-10-01T10:00:00Z' };
  await notify('subscription_preapproval', 'pre-rev-cancelada');
  assert.equal(st(id).mp_preapproval_status, 'cancelled');
  const due = billing.addMonthsKeepDay(new Date().toISOString().slice(0, 10), 1, 10);
  await billing.runBilling(Date.parse(due + 'T15:00:00Z') - 5 * 86_400_000);
  const inv = get("SELECT * FROM invoices WHERE company_id = ? AND status = 'open'", id);
  assert.ok(inv, 'fatura criada mesmo com a assinatura cancelada');
  assert.equal(billing.reevaluate(id, graceDeadline(inv.due_date, 'America/Sao_Paulo') + 4 * 86_400_000), 'suspended');
});

test('assinatura que volta a ser autorizada depois de pausada é reconhecida (não é tratada como repetida)', async () => {
  const id = mkCompany('rev-pausa');
  const send = async (status, when) => { resources.preapprovals['pre-rev-pausa'] = { id: 'pre-rev-pausa', status, external_reference: `company:${id}`, last_modified: when }; return notify('subscription_preapproval', 'pre-rev-pausa'); };
  await send('authorized', '2026-10-01T10:00:00Z');
  await send('paused', '2026-10-02T10:00:00Z');
  assert.equal(st(id).mp_preapproval_status, 'paused');
  const r = await send('authorized', '2026-10-03T10:00:00Z');
  assert.notEqual(r.json.duplicate, true);
  assert.equal(st(id).mp_preapproval_status, 'authorized');
});

test('cancelar a empresa cancela a assinatura no Mercado Pago; exclusão definitiva recusa assinatura ativa', async () => {
  const id = mkCompany('rev-cancelar-empresa');
  run("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = 'master@bill.local'");
  const before = calls.length;
  const r = await master.req('POST', `/api/admin/master/companies/${id}/status`, { body: { status: 'canceled', reason: 'Encerrou o contrato', password: 'SenhaForte123' } });
  assert.equal(r.status, 200, r.text);
  const put = calls.slice(before).find((c) => c.method === 'PUT' && c.url.endsWith('/preapproval/pre-rev-cancelar-empresa'));
  assert.ok(put && put.body.status === 'cancelled', 'assinatura cancelada no Mercado Pago');
  assert.equal(st(id).mp_preapproval_status, 'cancelled');
  const id2 = mkCompany('rev-purge');
  run("UPDATE companies SET status = 'canceled' WHERE id = ?", id2);
  assert.equal((await master.req('DELETE', `/api/admin/master/companies/${id2}`, { body: { confirmName: 'rev-purge', password: 'SenhaForte123' } })).status, 409);
});

test('prorrogar o teste de empresa suspensa manualmente tira a trava (a rotina volta a valer)', async () => {
  const id = mkCompany('rev-trial', ", status = 'suspended', lock_kind = 'manual'");
  assert.equal((await master.req('POST', `/api/admin/master/companies/${id}/trial`, { body: { days: 1 } })).status, 200);
  assert.deepEqual([st(id).status, st(id).lock_kind], ['trial', null]);
  run("UPDATE companies SET mp_preapproval_status = NULL, mp_preapproval_id = NULL WHERE id = ?", id);
  assert.equal(billing.reevaluate(id, Date.now() + 3 * 86_400_000), 'suspended', 'teste vencido volta a suspender');
});

test('fatura vencida não reabre empresa com o teste grátis encerrado', () => {
  const id = newCompany('rev-teste-encerrado');
  run("UPDATE companies SET plan_id = ?, status = 'suspended', lock_kind = 'trial_expired' WHERE id = ?", plan.id, id);
  billing.createInvoice(id, { amountCents: 1000, description: 'Teste', dueDate: '2026-10-12', method: 'pix_boleto' });
  assert.equal(billing.reevaluate(id, Date.parse('2026-10-14T15:00:00Z')), 'suspended');
  assert.equal(st(id).lock_kind, 'trial_expired');
});

test('cobrança do cartão menor que a fatura não dá baixa; troca de plano atualiza o valor da assinatura', async () => {
  const id = mkCompany('rev-valor');
  const inv = billing.createInvoice(id, { amountCents: plan.price_cents, description: 'Mês', dueDate: '2026-10-20', method: 'card' });
  resources.authorized['8801'] = { id: 8801, preapproval_id: 'pre-rev-valor', status: 'processed', transaction_amount: 1, currency_id: 'BRL', payment: { id: 991001, status: 'approved' } };
  await notify('subscription_authorized_payment', '8801');
  assert.equal(get('SELECT status FROM invoices WHERE id = ?', inv).status, 'open');
  resources.authorized['8802'] = { id: 8802, preapproval_id: 'pre-rev-valor', status: 'processed', transaction_amount: plan.price_cents / 100, currency_id: 'BRL', payment: { status: 'approved' } };
  await notify('subscription_authorized_payment', '8802');
  assert.equal(get('SELECT status FROM invoices WHERE id = ?', inv).status, 'open', 'sem o número do pagamento, espera');
  const rede = get("SELECT id, price_cents FROM plans WHERE name = 'Rede'");
  const before = calls.length;
  assert.equal((await master.req('POST', `/api/admin/master/companies/${id}/plan`, { body: { planId: rede.id } })).status, 200);
  const put = calls.slice(before).find((c) => c.method === 'PUT' && c.url.endsWith('/preapproval/pre-rev-valor'));
  assert.equal(put.body.auto_recurring.transaction_amount, rede.price_cents / 100);
});
