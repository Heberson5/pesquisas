'use strict';
// Configurações gerais da plataforma (só o Master): marca da tela de login, autocadastro de empresas,
// padrões das empresas novas, segurança do Master e limites de capacidade.
const { getPlatform, setPlatform, platformBranding } = require('./settings');
const { CAPACITY_DEFAULTS, capacity } = require('./health');
const { bad, str, int, email } = require('./validate');

const SIGNUP_DEFAULTS = { enabled: false, trialDays: 14 };
const signupConfig = () => ({ ...SIGNUP_DEFAULTS, ...(getPlatform('signup', {}) || {}) });
const flag = (v, field) => { if (typeof v !== 'boolean') throw bad(`Valor inválido em "${field}".`); return v; };
const color = (v, field) => { if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw bad(`Cor inválida em "${field}" (use #rrggbb).`); return v.toLowerCase(); };

function view() {
  return {
    branding: platformBranding(),
    signup: signupConfig(),
    companyDefaults: { requireAdminMfa: (getPlatform('companyDefaults', {}) || {}).requireAdminMfa !== false },
    security: { masterMfa: (getPlatform('security', {}) || {}).masterMfa !== false },
    capacity: capacity(),
    capacityDefaults: CAPACITY_DEFAULTS,
  };
}

function save(input = {}) {
  if (!input || typeof input !== 'object') throw bad('Configurações inválidas.');
  const changed = [];
  if (input.branding !== undefined) {
    const b = input.branding || {};
    const cur = platformBranding();
    setPlatform('branding', {
      companyName: b.companyName !== undefined ? str(b.companyName, { field: 'nome da plataforma', min: 2, max: 60 }) : cur.companyName,
      primaryColor: b.primaryColor !== undefined ? color(b.primaryColor, 'cor principal') : cur.primaryColor,
      accentColor: b.accentColor !== undefined ? color(b.accentColor, 'cor de destaque') : cur.accentColor,
    });
    changed.push('marca');
  }
  if (input.signup !== undefined) {
    const s = input.signup || {}; const cur = signupConfig();
    setPlatform('signup', {
      enabled: s.enabled !== undefined ? flag(s.enabled, 'autocadastro') : cur.enabled,
      trialDays: s.trialDays !== undefined ? int(s.trialDays, { field: 'dias de teste grátis', min: 1, max: 90 }) : cur.trialDays,
    });
    changed.push('autocadastro');
  }
  if (input.companyDefaults !== undefined) {
    const cur = getPlatform('companyDefaults', {}) || {};
    if (input.companyDefaults?.requireAdminMfa !== undefined) cur.requireAdminMfa = flag(input.companyDefaults.requireAdminMfa, '2FA dos administradores');
    setPlatform('companyDefaults', cur);
    changed.push('padrões das empresas');
  }
  if (input.security !== undefined) {
    const cur = getPlatform('security', {}) || {};
    if (input.security?.masterMfa !== undefined) cur.masterMfa = flag(input.security.masterMfa, '2FA do Master');
    setPlatform('security', cur);
    changed.push('segurança');
  }
  if (input.capacity !== undefined) {
    const c = input.capacity || {}; const cur = capacity();
    const next = {
      dbLimitMb: c.dbLimitMb !== undefined ? int(c.dbLimitMb, { field: 'limite do banco (MB)', min: 100, max: 1_000_000 }) : cur.dbLimitMb,
      responsesPerDayLimit: c.responsesPerDayLimit !== undefined ? int(c.responsesPerDayLimit, { field: 'respostas por dia', min: 100, max: 100_000_000 }) : cur.responsesPerDayLimit,
      devicesLimit: c.devicesLimit !== undefined ? int(c.devicesLimit, { field: 'tablets', min: 10, max: 10_000_000 }) : cur.devicesLimit,
      companiesLimit: c.companiesLimit !== undefined ? int(c.companiesLimit, { field: 'empresas', min: 1, max: 1_000_000 }) : cur.companiesLimit,
      alertEmails: cur.alertEmails,
    };
    if (c.alertEmails !== undefined) {
      if (!Array.isArray(c.alertEmails) || c.alertEmails.length > 10) throw bad('Até 10 e-mails para os avisos de capacidade.');
      next.alertEmails = [...new Set(c.alertEmails.filter((e) => e !== '').map((e) => email(e)))];
    }
    setPlatform('capacity', next);
    changed.push('capacidade');
  }
  return { view: view(), changed };
}

module.exports = { view, save, signupConfig };
