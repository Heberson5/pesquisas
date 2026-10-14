'use strict';
// Configurações da empresa em uso (marca, alertas, envio de e-mail/WhatsApp) e auditoria.
// Tudo aqui vale só para a empresa em uso; o Master só chega aqui depois de "entrar na empresa".
const express = require('express');
const { get, all, auditReq } = require('../db');
const { rateLimiter } = require('../security');
const { requireCompany, requirePerm } = require('../auth');
const { P } = require('../permissions');
const { HttpError, bad, int } = require('../validate');
const { getSettings, saveSettings } = require('../settings');
const { queueEmail, queueWhatsApp, renderEmail, processOutbox, outboxStatus, webhookSecret, whatsappCheck } = require('../notify');
const delivery = require('../delivery');
const { settingsFor } = require('./account');
const { scope, placeholders } = require('../scope');

const router = express.Router();
router.use(requireCompany);

router.get('/settings', (req, res) => res.json(settingsFor(req.user)));

const admin = requirePerm(P.SETTINGS);
const testLimiter = rateLimiter({ windowMs: 60 * 60_000, max: 5, keyFn: (req) => 'test:' + req.user.id, message: 'Limite de testes atingido. Aguarde um pouco.' });

router.get('/settings/notifications', admin, (req, res) => {
  const cid = req.user.companyId;
  const recent = all('SELECT id, kind, channel, status, attempts, last_error, created_at, sent_at FROM outbox WHERE company_id = ? ORDER BY id DESC LIMIT 30', cid);
  res.json({ ...outboxStatus(cid), webhookSecret: webhookSecret(cid), recent });
});

router.post('/settings/test-email', admin, testLimiter, async (req, res) => {
  const cid = req.user.companyId;
  const s = getSettings(cid);
  const { html, text } = renderEmail({ brand: s, title: 'E-mail de teste', intro: 'Se você recebeu esta mensagem, o envio de e-mails do sistema de pesquisa está funcionando.' });
  queueEmail({ to: req.user.email, subject: `${s.companyName}: e-mail de teste`, text, html, kind: 'test', companyId: cid });
  await processOutbox(5);
  const last = get("SELECT status, last_error FROM outbox WHERE kind = 'test' AND company_id = ? ORDER BY id DESC LIMIT 1", cid);
  res.json({ sent: last.status === 'sent', error: last.last_error });
});

// Envia agora o relatório semanal (para testar) — mesmo conteúdo do envio automático.
router.post('/settings/weekly-report/send-now', admin, testLimiter, async (req, res) => {
  const r = await require('../scheduled').sendWeeklyReportFor(req.user.companyId, { force: true });
  await processOutbox(50);
  auditReq(req, 'report.weekly_manual', r);
  res.json(r);
});

router.put('/settings', admin, (req, res) => {
  const saved = saveSettings(req.user.companyId, req.body);
  auditReq(req, 'settings.update', { companyName: saved.companyName });
  res.json(saved);
});

// ---------------------------------------------------------------- envio: e-mail (SMTP) e WhatsApp próprios da empresa
router.get('/settings/delivery', admin, (req, res) => res.json(delivery.publicView(req.user.companyId)));
router.put('/settings/delivery', admin, async (req, res) => {
  const b = req.body || {};
  const view = await delivery.save(req.user.companyId, { smtp: b.smtp, whatsapp: b.whatsapp });
  // Auditoria sem segredos: só registra o que foi alterado.
  auditReq(req, 'settings.delivery', { smtp: b.smtp === undefined ? undefined : (b.smtp?.clear ? 'removido' : 'alterado'), whatsapp: b.whatsapp === undefined ? undefined : (b.whatsapp?.clear ? 'removido' : 'alterado') });
  res.json(view);
});
router.post('/settings/test-whatsapp', admin, testLimiter, async (req, res) => {
  const cid = req.user.companyId;
  try {
    const info = await whatsappCheck(cid);
    let queued = false;
    const phone = String(req.body?.phone || '').replace(/[\s().+-]/g, '');
    const s = getSettings(cid);
    if (phone) {
      if (!/^\d{10,15}$/.test(phone)) throw bad('Número inválido. Digite DDI + DDD + número (ex.: 5511999990000).');
      if (!s.alerts.whatsappTemplate) throw bad('Informe o "Modelo aprovado do WhatsApp" para enviar uma mensagem de teste.');
      queueWhatsApp(/^\d{10,11}$/.test(phone) ? '55' + phone : phone, { template: s.alerts.whatsappTemplate, language: s.alerts.whatsappLanguage, params: ['Teste', '10', 'Mensagem de teste'] }, 'test', cid);
      await processOutbox(5);
      const last = get("SELECT status, last_error FROM outbox WHERE kind = 'test' AND channel = 'whatsapp' AND company_id = ? ORDER BY id DESC LIMIT 1", cid);
      if (last.status !== 'sent') return res.json({ ok: false, ...info, error: last.last_error || 'Falha no envio.' });
      queued = true;
    }
    res.json({ ok: true, ...info, sentTest: queued });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    res.json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------- auditoria da empresa
// Gestor com a permissão de auditoria vê só o que aconteceu nas unidades dele.
router.get('/audit', requirePerm(P.AUDIT), (req, res) => {
  const limit = int(req.query.limit || '300', { field: 'limite', min: 1, max: 1000 });
  const s = scope(req.user);
  if (s && !s.length) return res.json([]);
  res.json(all(`SELECT l.id, l.at, l.action, l.detail, l.ip, l.user_id, l.as_master, u.email, u.name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id
    WHERE l.company_id = ? ${s ? `AND l.branch_id IN (${placeholders(s)})` : ''} ORDER BY l.id DESC LIMIT ?`, req.user.companyId, ...(s || []), limit));
});

module.exports = router;
