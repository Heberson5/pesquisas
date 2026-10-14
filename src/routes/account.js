'use strict';
// Conta do próprio usuário: dados da sessão (/me), sair, trocar senha e preferências de notificação.
// Funciona também para o Master fora de uma empresa.
const express = require('express');
const { get, run, auditReq } = require('../db');
const { hashPassword, verifyPassword, passwordPolicyError, rateLimiter } = require('../security');
const { destroySession, destroyUserSessions } = require('../auth');
const { bad } = require('../validate');
const { QUESTION_TYPES, DISPLAYS, LANG_LABELS, CONTACT_MODES } = require('../surveys');
const { getSettings, platformBranding } = require('../settings');
const { P, GRANTABLE, LABELS } = require('../permissions');
const { STATUS_LABEL } = require('../companies');

const router = express.Router();
const passwordLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 20, message: 'Muitas tentativas. Aguarde 15 minutos.' });

// Menor privilégio: quem não cuida das configurações recebe só o que a interface usa (marca, ícones, meta).
function settingsFor(user) {
  if (!user.companyId) return null;
  const s = getSettings(user.companyId);
  if (user.can(P.SETTINGS)) return s;
  const { companyName, primaryColor, accentColor, logoMediaId, menuIcons, defaultDisplay, ratingIcon, colorScheme, faceStyle, defaultNpsGoal } = s;
  return { companyName, primaryColor, accentColor, logoMediaId, menuIcons, defaultDisplay, ratingIcon, colorScheme, faceStyle, defaultNpsGoal };
}

router.post('/logout', (req, res) => {
  destroySession(req, res);
  auditReq(req, 'logout');
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  const u = get('SELECT totp_enabled, notify_detractors, notify_reports, notify_offline, whatsapp FROM users WHERE id = ? /* tenant-ok: linha do próprio usuário logado */', req.user.id);
  const c = req.user.company;
  res.json({
    user: {
      id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, mfaEnabled: !!u.totp_enabled, whatsapp: u.whatsapp || '',
      notify: { detractors: !!u.notify_detractors, reports: !!u.notify_reports, offline: !!u.notify_offline },
      permissions: [...req.user.perms],
    },
    company: c ? { id: c.id, name: c.name, slug: c.slug, status: c.status, statusLabel: STATUS_LABEL[c.status], lockKind: c.lock_kind || null, statusReason: c.status === 'suspended' || c.status === 'past_due' ? c.status_reason : null,
      trialEndsAt: c.status === 'trial' ? get('SELECT trial_ends_at FROM companies WHERE id = ?', c.id).trial_ends_at : null } : null,
    acting: req.user.acting ? { until: req.user.acting.until, reason: req.user.acting.reason } : null,
    mfaSetupRequired: req.user.mfaSetupRequired, csrf: req.user.csrf,
    questionTypes: QUESTION_TYPES, displays: DISPLAYS, langs: LANG_LABELS, contactModes: CONTACT_MODES,
    grantable: GRANTABLE.map((p) => ({ id: p, label: LABELS[p] })),
    platform: (({ companyName, primaryColor, accentColor }) => ({ companyName, primaryColor, accentColor }))(platformBranding()),
    settings: req.user.mfaSetupRequired ? null : settingsFor(req.user),
  });
});

// Preferências de notificação do próprio usuário.
router.put('/me/notifications', (req, res) => {
  const b = req.body || {};
  const f = (v, cur) => (v === undefined ? cur : v === true ? 1 : v === false ? 0 : (() => { throw bad('Valor inválido.'); })());
  const u = get('SELECT notify_detractors, notify_reports, notify_offline FROM users WHERE id = ? /* tenant-ok: linha do próprio usuário logado */', req.user.id);
  run('UPDATE users SET notify_detractors = ?, notify_reports = ?, notify_offline = ? WHERE id = ? /* tenant-ok: linha do próprio usuário logado */',
    f(b.detractors, u.notify_detractors), f(b.reports, u.notify_reports), f(b.offline, u.notify_offline), req.user.id);
  if (b.whatsapp !== undefined) {
    // WhatsApp pessoal (opcional): só números, com DDI. 10–11 dígitos = Brasil, o 55 é acrescentado.
    if (typeof b.whatsapp !== 'string') throw bad('WhatsApp inválido.');
    let digits = b.whatsapp.replace(/[\s().+-]/g, '');
    if (digits && !/^\d{10,15}$/.test(digits)) throw bad('WhatsApp inválido. Digite DDD + número (ex.: 11 99999-0000).');
    if (/^\d{10,11}$/.test(digits)) digits = '55' + digits;
    run('UPDATE users SET whatsapp = ? WHERE id = ? /* tenant-ok: linha do próprio usuário logado */', digits || null, req.user.id);
  }
  res.json({ ok: true });
});

router.post('/me/password', passwordLimiter, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ? /* tenant-ok: linha do próprio usuário logado */', req.user.id);
  if (!verifyPassword(String(req.body?.current || ''), u.password_hash)) throw bad('Senha atual incorreta.');
  const err = passwordPolicyError(req.body?.password);
  if (err) throw bad(err);
  run('UPDATE users SET password_hash = ? WHERE id = ? /* tenant-ok: linha do próprio usuário logado */', hashPassword(req.body.password), u.id);
  destroyUserSessions(u.id);
  auditReq(req, 'user.password_changed');
  destroySession(req, res);
  res.json({ ok: true });
});

module.exports = router;
module.exports.settingsFor = settingsFor;
