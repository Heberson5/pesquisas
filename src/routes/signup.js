'use strict';
// Autocadastro de empresas (desligado por padrão; o Master liga em Configurações gerais).
// A empresa entra em teste grátis com o CNPJ conferido na Receita (só ATIVA) e quem cadastrou vira o Administrador.
// Proteções: limite por IP, campo-isca para robôs, tempo mínimo de preenchimento e aceite dos termos.
const express = require('express');
const { all, audit } = require('../db');
const { rateLimiter, passwordPolicyError } = require('../security');
const { HttpError, bad } = require('../validate');
const { registerCompany } = require('../companyAdmin');
const { signupConfig } = require('../platform');
const { queueEmail, renderEmail } = require('../notify');
const { platformBranding } = require('../settings');
const cnpjLib = require('../cnpj');

const router = express.Router();
const limiter = rateLimiter({ windowMs: 60 * 60_000, max: 5, message: 'Muitas tentativas de cadastro. Aguarde uma hora.' });
const lookupLimiter = rateLimiter({ windowMs: 60 * 60_000, max: 20, message: 'Muitas consultas. Aguarde uma hora.' });

router.get('/', (req, res) => {
  const s = signupConfig();
  res.json({ enabled: s.enabled, trialDays: s.trialDays });
});

const requireEnabled = (req, res, next) => { if (!signupConfig().enabled) throw new HttpError(404, 'Cadastro indisponível.'); next(); };

// Consulta pública do CNPJ (só quando o autocadastro está ligado): devolve apenas o que o formulário mostra.
router.get('/cnpj/:cnpj', requireEnabled, lookupLimiter, async (req, res) => {
  const c = cnpjLib.digits(req.params.cnpj);
  if (!cnpjLib.isValid(c)) throw bad('CNPJ inválido (confira os dígitos).');
  const r = await cnpjLib.lookup(c);
  if (!r.found) return res.json({ found: false, unavailable: !!r.unavailable, notFound: !!r.notFound });
  res.json({ found: true, active: r.data.active, status: r.data.status, legalName: r.data.legalName, tradeName: r.data.tradeName, city: r.data.address?.city, uf: r.data.address?.uf });
});

router.post('/', requireEnabled, limiter, async (req, res) => {
  const b = req.body || {};
  if (b.website) throw bad('Cadastro recusado.'); // campo invisível: só robô preenche
  const started = Number(b.startedAt);
  if (!Number.isFinite(started) || Date.now() - started < 5000) throw bad('Preencha o formulário com calma e tente de novo.');
  if (b.acceptTerms !== true) throw bad('É preciso aceitar os termos de uso e a política de privacidade.');
  const err = passwordPolicyError(b.password);
  if (err) throw bad(err);
  const cfg = signupConfig();
  const r = await registerCompany({ cnpj: b.cnpj, name: b.name, contactEmail: b.email, billingEmail: b.email },
    { origin: 'self', status: 'trial', trialDays: cfg.trialDays, admin: { name: b.adminName, email: b.email, password: b.password }, allowManual: false });
  audit(r.userId, 'company.self_signup', { id: r.id, name: b.name, cnpj: cnpjLib.digits(b.cnpj) }, req.ip, { companyId: null });
  audit(r.userId, 'company.self_signup', { name: b.name }, req.ip, { companyId: r.id });
  // Avisa os Masters.
  const { html, text } = renderEmail({ brand: platformBranding(), title: 'Nova empresa cadastrada pelo site',
    intro: 'Uma empresa se cadastrou sozinha e começou o teste grátis.',
    rows: [['Empresa', String(b.name || '')], ['CNPJ', cnpjLib.format(b.cnpj)], ['Administrador', `${b.adminName} <${b.email}>`], ['Teste grátis', `${cfg.trialDays} dias`]] });
  for (const m of all("SELECT email FROM users WHERE role = 'master' AND active = 1 /* tenant-ok: aviso para os Masters */")) {
    queueEmail({ to: m.email, subject: `Nova empresa: ${String(b.name || '').slice(0, 60)}`, text, html, kind: 'signup' });
  }
  res.status(201).json({ ok: true, trialDays: cfg.trialDays });
});

module.exports = router;
