'use strict';
// Painel Master (dono da plataforma): empresas (cadastro com consulta do CNPJ, situação, convite do administrador,
// exclusão definitiva), entrar em uma empresa para dar suporte, configurações gerais, saúde/capacidade e auditoria da plataforma.
// Entrar numa empresa exige um motivo, dura no máximo 2 horas e fica registrado na auditoria da empresa e da plataforma.
const express = require('express');
const { get, all, run, audit } = require('../db');
const { requireMaster, ACTING_MS } = require('../auth');
const { HttpError, bad, str, id, int } = require('../validate');
const { STATUS_LABEL } = require('../companies');
const { rateLimiter } = require('../security');
const cnpjLib = require('../cnpj');
const admin = require('../companyAdmin');
const platform = require('../platform');
const health = require('../health');
const delivery = require('../delivery');
const { sendInvite } = require('../invites');
const { confirmSensitive } = require('./auth');

const router = express.Router();
router.use('/master', requireMaster);

// Auditoria da plataforma (company_id nulo); quando a ação é sobre uma empresa, ela também vai para a auditoria dela.
const pAudit = (req, action, detail, companyId = null) => {
  audit(req.user.id, action, detail, req.ip, { companyId: null, asMaster: true });
  if (companyId) audit(req.user.id, action, detail, req.ip, { companyId, asMaster: true });
};

router.get('/master/companies', (req, res) => {
  const rows = all(`SELECT c.id, c.name, c.slug, c.status, c.cnpj, c.created_at, c.trial_ends_at, c.origin, c.receita_status, c.plan_id,
      (SELECT p.name FROM plans p WHERE p.id = c.plan_id) AS plan_name,
      (SELECT COUNT(*) FROM branches b WHERE b.company_id = c.id) AS branches,
      (SELECT COUNT(*) FROM devices d WHERE d.company_id = c.id AND d.active = 1) AS devices,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS users,
      (SELECT COUNT(*) FROM responses r WHERE r.company_id = c.id AND r.submitted_at >= ?) AS responses30d
    FROM companies c ORDER BY c.name /* tenant-ok: tela do Master, todas as empresas */`, Date.now() - 30 * 86_400_000);
  res.json(rows.map((c) => ({ ...c, statusLabel: STATUS_LABEL[c.status] })));
});

// Consulta do CNPJ para preencher o formulário. Não grava nada.
const cnpjLimiter = rateLimiter({ windowMs: 60_000, max: 20, keyFn: (req) => 'cnpj:' + req.user.id, message: 'Muitas consultas. Aguarde um minuto.' });
router.get('/master/cnpj/:cnpj', cnpjLimiter, async (req, res) => {
  const c = cnpjLib.digits(req.params.cnpj);
  if (!cnpjLib.isValid(c)) throw bad('CNPJ inválido (confira os dígitos).');
  const dup = get('SELECT id, name, status FROM companies WHERE cnpj = ?', c);
  const r = await cnpjLib.lookup(c);
  res.json({ cnpj: c, formatted: cnpjLib.format(c), duplicate: dup ? { id: dup.id, name: dup.name, statusLabel: STATUS_LABEL[dup.status] } : null, ...r });
});

router.post('/master/companies', async (req, res) => {
  const b = req.body || {};
  const status = b.status === 'active' ? 'active' : 'trial';
  const trialDays = b.trialDays !== undefined ? int(b.trialDays, { field: 'dias de teste', min: 1, max: 90 }) : platform.signupConfig().trialDays;
  const planId = b.planId ? id(b.planId, 'plano') : null;
  if (planId && !get('SELECT 1 FROM plans WHERE id = ?', planId)) throw bad('Plano inexistente.');
  const r = await admin.registerCompany(b, { origin: 'master', status, trialDays, planId, admin: b.admin?.email ? b.admin : null, invitedBy: req.user.name });
  pAudit(req, 'company.create', { id: r.id, name: b.name, cnpj: cnpjLib.digits(b.cnpj), status, receita: r.receita, manual: r.manual, adminInvited: !!r.userId }, r.id);
  res.status(201).json(r);
});

router.get('/master/companies/:id', (req, res) => res.json(admin.companyDetails(id(req.params.id))));

router.put('/master/companies/:id', async (req, res) => {
  const cid = id(req.params.id);
  const r = await admin.updateCompany(cid, req.body || {});
  pAudit(req, 'company.update', { id: cid, name: req.body?.name, changedCnpj: r.changedCnpj }, cid);
  res.json({ ok: true, ...r });
});

// Situação: suspender e reativar com motivo; cancelar exige confirmar com senha (e código do 2FA, se ativo).
router.post('/master/companies/:id/status', (req, res) => {
  const cid = id(req.params.id);
  const status = String(req.body?.status || '');
  if (status === 'canceled') confirmSensitive(req);
  const before = admin.setStatus(cid, status, req.body?.reason);
  pAudit(req, 'company.status', { id: cid, from: before, to: status, reason: req.body?.reason || null }, cid);
  res.json({ ok: true, status, statusLabel: STATUS_LABEL[status] });
});

// Prorroga o teste grátis (útil enquanto o faturamento não está ligado).
router.post('/master/companies/:id/trial', (req, res) => {
  const cid = id(req.params.id);
  const days = int(req.body?.days, { field: 'dias', min: 1, max: 90 });
  const c = get('SELECT status, trial_ends_at FROM companies WHERE id = ?', cid);
  if (!c) throw new HttpError(404, 'Empresa não encontrada.');
  const until = Math.max(Date.now(), c.trial_ends_at || 0) + days * 86_400_000;
  run("UPDATE companies SET trial_ends_at = ?, status = CASE WHEN status IN ('trial','suspended') THEN 'trial' ELSE status END, updated_at = ? WHERE id = ?", until, Date.now(), cid);
  pAudit(req, 'company.trial_extended', { id: cid, days, until }, cid);
  res.json({ ok: true, trialEndsAt: until });
});

// Convida (ou reenvia o convite para) um administrador da empresa.
router.post('/master/companies/:id/admins', (req, res) => {
  const cid = id(req.params.id);
  if (!get('SELECT 1 FROM companies WHERE id = ?', cid)) throw new HttpError(404, 'Empresa não encontrada.');
  const b = req.body || {};
  if (b.userId) {
    const u = get("SELECT id, email FROM users WHERE id = ? AND company_id = ? AND role = 'admin'", id(b.userId), cid);
    if (!u) throw new HttpError(404, 'Administrador não encontrado.');
    sendInvite(u.id, { invitedBy: req.user.name });
    pAudit(req, 'company.admin_reinvited', { id: cid, email: u.email }, cid);
    return res.json({ ok: true, resent: true });
  }
  const name = str(b.name, { field: 'nome', min: 2, max: 100 });
  const mail = require('../validate').email(b.email);
  if (get('SELECT 1 FROM users WHERE email = ? /* tenant-ok: e-mail é único na plataforma */', mail)) throw new HttpError(409, 'Este e-mail já está em uso.');
  const { hashPassword, randomToken } = require('../security');
  const uid = Number(run("INSERT INTO users (company_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,'admin',?)",
    cid, name, mail, hashPassword(randomToken(24) + 'a1'), Date.now()).lastInsertRowid);
  sendInvite(uid, { invitedBy: req.user.name });
  pAudit(req, 'company.admin_invited', { id: cid, email: mail }, cid);
  res.status(201).json({ ok: true, id: uid });
});

// Exclusão definitiva de empresa CANCELADA: apaga tudo, inclusive a chave de criptografia. Exige senha (+2FA)
// e digitar o nome da empresa. Libera o CNPJ para novo cadastro.
router.delete('/master/companies/:id', (req, res) => {
  const cid = id(req.params.id);
  const c = get('SELECT name, status FROM companies WHERE id = ?', cid);
  if (!c) throw new HttpError(404, 'Empresa não encontrada.');
  if (c.status !== 'canceled') throw new HttpError(409, 'Cancele a empresa antes de excluí-la definitivamente.');
  if (String(req.body?.confirmName || '').trim() !== c.name) throw bad('Digite o nome da empresa exatamente como está cadastrado para confirmar.');
  confirmSensitive(req);
  const r = admin.purgeCompany(cid);
  audit(req.user.id, 'company.purged', r, req.ip, { companyId: null, asMaster: true });
  res.json({ ok: true, ...r });
});

// ---------------------------------------------------------------- planos
const plans = require('../plans');
router.get('/master/plans', (req, res) => {
  const counts = Object.fromEntries(all('SELECT plan_id, COUNT(*) AS n FROM companies WHERE plan_id IS NOT NULL GROUP BY plan_id /* tenant-ok: contagem por plano */').map((r) => [r.plan_id, r.n]));
  res.json({ plans: plans.listPlans().map((p) => ({ ...p, companies: counts[p.id] || 0 })), limits: plans.LIMITS, features: plans.FEATURES });
});
router.post('/master/plans', (req, res) => {
  const pid = plans.savePlan(null, req.body || {});
  pAudit(req, 'plan.create', { id: pid, name: req.body?.name });
  res.status(201).json({ id: pid });
});
router.put('/master/plans/:id', (req, res) => {
  const pid = id(req.params.id);
  plans.savePlan(pid, req.body || {});
  pAudit(req, 'plan.update', { id: pid, name: req.body?.name, priceCents: req.body?.priceCents });
  res.json({ ok: true });
});
// Plano em uso não é apagado (desative para não aparecer mais); sem uso pode ser excluído.
router.delete('/master/plans/:id', (req, res) => {
  const pid = id(req.params.id);
  const p = get('SELECT name FROM plans WHERE id = ?', pid);
  if (!p) throw new HttpError(404, 'Plano não encontrado.');
  if (get('SELECT 1 FROM companies WHERE plan_id = ? /* tenant-ok: uso do plano */', pid)) throw new HttpError(409, 'Há empresas neste plano. Troque o plano delas ou apenas desative este.');
  run('DELETE FROM plans WHERE id = ?', pid);
  pAudit(req, 'plan.delete', { id: pid, name: p.name });
  res.json({ ok: true });
});
// Troca o plano de uma empresa (null = sem limites).
router.post('/master/companies/:id/plan', (req, res) => {
  const cid = id(req.params.id);
  const c = get('SELECT plan_id FROM companies WHERE id = ?', cid);
  if (!c) throw new HttpError(404, 'Empresa não encontrada.');
  const planId = req.body?.planId === null ? null : id(req.body?.planId, 'plano');
  const p = planId ? get('SELECT name FROM plans WHERE id = ?', planId) : null;
  if (planId && !p) throw bad('Plano inexistente.');
  run('UPDATE companies SET plan_id = ?, updated_at = ? WHERE id = ?', planId, Date.now(), cid);
  pAudit(req, 'company.plan', { id: cid, from: c.plan_id, to: planId, plan: p?.name || 'sem limites' }, cid);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- faturamento (Mercado Pago)
const billing = require('../billing');
const mp = require('../mercadopago');
router.get('/master/billing', (req, res) => res.json(mp.publicView()));
router.put('/master/billing', (req, res) => {
  const b = req.body || {};
  if (b.clear === true) confirmSensitive(req);
  const view = mp.save({ accessToken: b.accessToken, webhookSecret: b.webhookSecret, clear: b.clear === true });
  pAudit(req, 'billing.credentials', { token: b.accessToken ? 'alterado' : undefined, secret: b.webhookSecret ? 'alterada' : undefined, cleared: b.clear === true || undefined });
  res.json(view);
});
router.post('/master/billing/test', rateLimiter({ windowMs: 60 * 60_000, max: 10, keyFn: (req) => 'mpt:' + req.user.id }), async (req, res) => {
  const me = await mp.testConnection();
  res.json({ ok: true, account: { id: me.id, nickname: me.nickname, email: me.email, site: me.site_id } });
});

// Todas as faturas (visão geral do Master), com filtro de situação.
router.get('/master/invoices', (req, res) => {
  const st = String(req.query.status || '');
  const today = new Date().toISOString().slice(0, 10);
  const where = st === 'overdue' ? "i.status = 'open' AND i.due_date < ?" : st === 'open' ? "i.status = 'open'" : st === 'paid' ? "i.status = 'paid'" : '1=1';
  const rows = all(`SELECT i.*, c.name AS company FROM invoices i JOIN companies c ON c.id = i.company_id WHERE ${where}
    ORDER BY i.due_date DESC, i.id DESC LIMIT 500 /* tenant-ok: visão geral do Master */`, ...(st === 'overdue' ? [today] : []));
  res.json(rows);
});
router.get('/master/companies/:id/billing', (req, res) => res.json(billing.overview(id(req.params.id))));
// Forma de cobrança: cartão (padrão, assinatura feita pelo cliente) ou PIX/boleto (gerado pelo Master, manual ou automático).
router.post('/master/companies/:id/billing', (req, res) => {
  const cid = id(req.params.id);
  if (!get('SELECT 1 FROM companies WHERE id = ?', cid)) throw new HttpError(404, 'Empresa não encontrada.');
  const b = req.body || {};
  if (!['card', 'pix_boleto'].includes(b.method)) throw bad('Forma de cobrança inválida.');
  const day = b.billingDay === null || b.billingDay === undefined || b.billingDay === '' ? null : int(b.billingDay, { field: 'dia do vencimento', min: 1, max: 28 });
  if (b.autoInvoice !== undefined && typeof b.autoInvoice !== 'boolean') throw bad('Valor inválido para envio automático.');
  run('UPDATE companies SET billing_method = ?, billing_day = ?, auto_invoice = ?, updated_at = ? WHERE id = ?', b.method, day, b.autoInvoice ? 1 : 0, Date.now(), cid);
  pAudit(req, 'billing.method', { id: cid, method: b.method, billingDay: day, autoInvoice: !!b.autoInvoice }, cid);
  res.json({ ok: true });
});
router.post('/master/companies/:id/invoices', (req, res) => {
  const cid = id(req.params.id);
  if (!get('SELECT 1 FROM companies WHERE id = ?', cid)) throw new HttpError(404, 'Empresa não encontrada.');
  const b = req.body || {};
  const plan = require('../plans').planOf(cid);
  const amountCents = b.amountCents !== undefined ? int(b.amountCents, { field: 'valor (centavos)', min: 1, max: 100_000_000 }) : plan?.priceCents;
  if (!amountCents) throw bad('Informe o valor (a empresa não tem plano pago).');
  const description = str(b.description || `Assinatura ${plan?.name || ''}`.trim(), { field: 'descrição', min: 3, max: 200 });
  const dueDate = String(b.dueDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(dueDate))) throw bad('Vencimento inválido.');
  const invId = billing.createInvoice(cid, { amountCents, description, dueDate, createdBy: req.user.id });
  pAudit(req, 'billing.invoice_created', { invoiceId: invId, amount: amountCents, due: dueDate, manual: true }, cid);
  res.status(201).json({ id: invId });
});
const invoiceOf = (iid) => { const i = get('SELECT * FROM invoices WHERE id = ? /* tenant-ok: tela do Master */', iid); if (!i) throw new HttpError(404, 'Fatura não encontrada.'); return i; };
router.post('/master/invoices/:id/pix', async (req, res) => {
  const inv = invoiceOf(id(req.params.id));
  const r = await billing.issuePixBoleto(inv.id, { send: req.body?.send === true });
  pAudit(req, 'billing.pix_issued', { invoiceId: inv.id, sent: req.body?.send === true }, inv.company_id);
  res.json(r);
});
router.post('/master/invoices/:id/paid', (req, res) => {
  const inv = invoiceOf(id(req.params.id));
  const note = str(req.body?.note, { field: 'observação', min: 3, max: 200 });
  billing.markPaid(inv.id, { by: req.user.id, method: 'manual', note });
  pAudit(req, 'billing.invoice_manual_paid', { invoiceId: inv.id, note }, inv.company_id);
  res.json({ ok: true });
});
router.post('/master/invoices/:id/cancel', (req, res) => {
  const inv = invoiceOf(id(req.params.id));
  if (inv.status !== 'open') throw new HttpError(409, 'Só é possível cancelar fatura em aberto.');
  const reason = str(req.body?.reason, { field: 'motivo', min: 3, max: 200 });
  run("UPDATE invoices SET status = 'canceled', notes = ?, updated_at = ? WHERE id = ? /* tenant-ok: tela do Master */", reason, Date.now(), inv.id);
  billing.reevaluate(inv.company_id);
  pAudit(req, 'billing.invoice_canceled', { invoiceId: inv.id, reason }, inv.company_id);
  res.json({ ok: true });
});
router.post('/master/companies/:id/subscription/cancel', async (req, res) => {
  const cid = id(req.params.id);
  const c = get('SELECT mp_preapproval_id FROM companies WHERE id = ?', cid);
  if (!c?.mp_preapproval_id) throw new HttpError(409, 'A empresa não tem assinatura no cartão.');
  confirmSensitive(req);
  await mp.updatePreapproval(c.mp_preapproval_id, { status: 'cancelled' });
  run("UPDATE companies SET mp_preapproval_status = 'cancelled', updated_at = ? WHERE id = ?", Date.now(), cid);
  pAudit(req, 'billing.subscription_canceled', { id: cid, preapprovalId: c.mp_preapproval_id }, cid);
  res.json({ ok: true });
});
router.post('/master/billing/run', async (req, res) => {
  const r = await billing.runBilling();
  pAudit(req, 'billing.run_manual', { invoices: r.invoices, sent: r.sent });
  res.json(r);
});

// ---------------------------------------------------------------- entrar / sair de uma empresa
router.post('/master/act', (req, res) => {
  const companyId = id(req.body?.companyId, 'empresa');
  const reason = str(req.body?.reason, { field: 'motivo', min: 5, max: 200 });
  const c = get('SELECT id, name FROM companies WHERE id = ?', companyId);
  if (!c) throw new HttpError(404, 'Empresa não encontrada.');
  const until = Date.now() + ACTING_MS;
  run('UPDATE sessions SET acting_company_id = ?, acting_until = ?, acting_reason = ? WHERE token_hash = ?', c.id, until, reason, req.user.sessionHash);
  // Registra nos dois lugares: na auditoria da plataforma e na da própria empresa.
  audit(req.user.id, 'master.enter_company', { companyId: c.id, company: c.name, reason }, req.ip, { companyId: null, asMaster: true });
  audit(req.user.id, 'master.enter_company', { reason }, req.ip, { companyId: c.id, asMaster: true });
  res.json({ ok: true, until });
});

router.post('/master/leave', (req, res) => {
  const was = req.user.companyId;
  run('UPDATE sessions SET acting_company_id = NULL, acting_until = NULL, acting_reason = NULL WHERE token_hash = ?', req.user.sessionHash);
  if (was) audit(req.user.id, 'master.leave_company', null, req.ip, { companyId: was, asMaster: true });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- configurações gerais, e-mail padrão, saúde e auditoria
router.get('/master/platform', (req, res) => res.json(platform.view()));
router.put('/master/platform', (req, res) => {
  const r = platform.save(req.body || {});
  pAudit(req, 'platform.settings', { changed: r.changed });
  res.json(r.view);
});

router.get('/master/delivery', (req, res) => res.json(delivery.publicView(null)));
router.put('/master/delivery', async (req, res) => {
  const b = req.body || {};
  const view = await delivery.save(null, { smtp: b.smtp, whatsapp: b.whatsapp });
  pAudit(req, 'platform.delivery', { smtp: b.smtp === undefined ? undefined : (b.smtp?.clear ? 'removido' : 'alterado'), whatsapp: b.whatsapp === undefined ? undefined : (b.whatsapp?.clear ? 'removido' : 'alterado') });
  res.json(view);
});

const testLimiter = rateLimiter({ windowMs: 60 * 60_000, max: 5, keyFn: (req) => 'mtest:' + req.user.id, message: 'Limite de testes atingido. Aguarde um pouco.' });
router.post('/master/test-email', testLimiter, async (req, res) => {
  const { queueEmail, renderEmail, processOutbox } = require('../notify');
  const brand = require('../settings').platformBranding();
  const { html, text } = renderEmail({ brand, title: 'E-mail de teste', intro: 'Se você recebeu esta mensagem, o e-mail padrão da plataforma está funcionando.' });
  queueEmail({ to: req.user.email, subject: `${brand.companyName}: e-mail de teste`, text, html, kind: 'test' });
  await processOutbox(5);
  const last = get("SELECT status, last_error FROM outbox WHERE kind = 'test' AND company_id IS NULL ORDER BY id DESC LIMIT 1 /* tenant-ok: envio da plataforma */");
  res.json({ sent: last?.status === 'sent', error: last?.last_error || null });
});

router.get('/master/health', (req, res) => res.json(health.snapshot()));

router.get('/master/audit', (req, res) => {
  const limit = int(req.query.limit || '300', { field: 'limite', min: 1, max: 1000 });
  res.json(all(`SELECT l.id, l.at, l.action, l.detail, l.ip, l.user_id, l.as_master, u.email, u.name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.company_id IS NULL ORDER BY l.id DESC LIMIT ? /* tenant-ok: auditoria da plataforma (sem empresa) */`, limit));
});

module.exports = router;
