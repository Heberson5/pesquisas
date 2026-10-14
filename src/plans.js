'use strict';
// Planos: limites (unidades, tablets, usuários, pesquisas, respostas no mês) e recursos (PowerPoint, WhatsApp, webhook).
// Empresa sem plano = sem limites. Respostas NUNCA são recusadas por limite (não se perde opinião de cliente):
// a 80% e a 100% do mês, administradores e Masters recebem um aviso para trocar de plano.
const { get, all, run } = require('./db');
const { HttpError, bad, str, int } = require('./validate');
const { companyTz } = require('./companies');

const LIMITS = {
  branches: 'Unidades', devices: 'Tablets ativos', users: 'Usuários ativos', surveys: 'Pesquisas ativas', responsesMonth: 'Respostas por mês',
};
const FEATURES = { pptx: 'Relatório em PowerPoint', whatsapp: 'Alertas por WhatsApp', webhook: 'Integração por webhook' };

const parse = (j) => { try { return JSON.parse(j || '{}') || {}; } catch { return {}; } };
const shape = (p) => (p ? { id: p.id, name: p.name, description: p.description, priceCents: p.price_cents, active: !!p.active, position: p.position,
  limits: parse(p.limits_json), features: parse(p.features_json) } : null);

const listPlans = ({ onlyActive = false } = {}) => all(`SELECT * FROM plans ${onlyActive ? 'WHERE active = 1' : ''} ORDER BY position, price_cents`).map(shape);
const getPlan = (planId) => shape(planId ? get('SELECT * FROM plans WHERE id = ?', planId) : null);
const planOf = (companyId) => getPlan(get('SELECT plan_id FROM companies WHERE id = ?', companyId)?.plan_id);

// Início do mês no fuso da empresa.
function monthStart(companyId, now = Date.now()) {
  const tz = companyTz(companyId);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return require('./time').parseLocal(`${parts.year}-${parts.month}-01T00:00`, tz);
}

function usage(companyId, now = Date.now()) {
  return get(`SELECT (SELECT COUNT(*) FROM branches WHERE company_id = ? AND active = 1) AS branches,
      (SELECT COUNT(*) FROM devices WHERE company_id = ? AND active = 1) AS devices,
      (SELECT COUNT(*) FROM users WHERE company_id = ? AND active = 1) AS users,
      (SELECT COUNT(*) FROM surveys WHERE company_id = ? AND active = 1) AS surveys,
      (SELECT COUNT(*) FROM responses WHERE company_id = ? AND submitted_at >= ?) AS responsesMonth`,
  companyId, companyId, companyId, companyId, companyId, monthStart(companyId, now));
}

// Antes de criar algo: recusa se o limite do plano já foi atingido.
function assertLimit(companyId, key, adding = 1) {
  const plan = planOf(companyId);
  const max = plan?.limits?.[key];
  if (!plan || max === undefined || max === null) return;
  const used = usage(companyId)[key];
  if (used + adding > max) {
    throw Object.assign(new HttpError(403, `Limite do plano ${plan.name} atingido: ${LIMITS[key].toLowerCase()} — ${used} de ${max}. Para aumentar, peça a troca de plano.`), { code: 'PLAN_LIMIT' });
  }
}

const hasFeature = (companyId, f) => { const p = planOf(companyId); return !p || p.features?.[f] === true; };
function assertFeature(companyId, f) {
  if (!hasFeature(companyId, f)) throw Object.assign(new HttpError(403, `O recurso "${FEATURES[f]}" não faz parte do plano ${planOf(companyId).name}. Para usar, peça a troca de plano.`), { code: 'PLAN_FEATURE' });
}

// Visão para a tela "Plano e uso".
function planView(companyId) {
  const plan = planOf(companyId); const u = usage(companyId);
  return {
    plan, usage: u,
    rows: Object.entries(LIMITS).map(([k, label]) => {
      const max = plan?.limits?.[k] ?? null;
      return { key: k, label, used: u[k], max, pct: max ? Math.round((u[k] / max) * 100) : null };
    }),
    features: Object.entries(FEATURES).map(([k, label]) => ({ key: k, label, enabled: !plan || plan.features?.[k] === true })),
  };
}

// Validação do cadastro de plano (Master).
function planInput(b = {}) {
  const limits = {};
  for (const k of Object.keys(LIMITS)) {
    const v = b.limits?.[k];
    limits[k] = v === null || v === undefined || v === '' ? null : int(v, { field: LIMITS[k], min: 0, max: 10_000_000 });
  }
  const features = {};
  for (const k of Object.keys(FEATURES)) {
    const v = b.features?.[k];
    if (v !== undefined && typeof v !== 'boolean') throw bad(`Valor inválido em "${FEATURES[k]}".`);
    features[k] = v === true;
  }
  return {
    name: str(b.name, { field: 'nome do plano', min: 2, max: 40 }),
    description: str(b.description, { field: 'descrição', max: 200, optional: true }) || null,
    priceCents: int(b.priceCents, { field: 'preço (centavos)', min: 0, max: 100_000_000 }),
    active: b.active === false ? 0 : 1,
    position: b.position === undefined ? 0 : int(b.position, { field: 'ordem', min: 0, max: 1000 }),
    limits, features,
  };
}

function savePlan(planId, input) {
  const p = planInput(input);
  const dup = get('SELECT id FROM plans WHERE name = ? AND id <> ?', p.name, planId ?? -1);
  if (dup) throw new HttpError(409, 'Já existe um plano com esse nome.');
  const now = Date.now();
  if (planId) {
    if (!get('SELECT 1 FROM plans WHERE id = ?', planId)) throw new HttpError(404, 'Plano não encontrado.');
    run('UPDATE plans SET name=?, description=?, price_cents=?, limits_json=?, features_json=?, active=?, position=?, updated_at=? WHERE id=?',
      p.name, p.description, p.priceCents, JSON.stringify(p.limits), JSON.stringify(p.features), p.active, p.position, now, planId);
    return planId;
  }
  return Number(run('INSERT INTO plans (name, description, price_cents, limits_json, features_json, active, position, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    p.name, p.description, p.priceCents, JSON.stringify(p.limits), JSON.stringify(p.features), p.active, p.position, now, now).lastInsertRowid);
}

// Aviso de respostas no mês (80% e 100%), uma vez por nível por mês. Chamado depois de gravar uma resposta.
function checkResponseQuota(companyId, now = Date.now()) {
  const plan = planOf(companyId);
  const max = plan?.limits?.responsesMonth;
  if (!max) return null;
  const used = usage(companyId, now).responsesMonth;
  const level = used >= max ? 100 : used >= max * 0.8 ? 80 : 0;
  if (!level) return null;
  const { getState, setState, getSettings } = require('./settings');
  const month = new Date(monthStart(companyId, now)).toISOString().slice(0, 7);
  const st = getState(companyId, 'quotaAlert') || {};
  if (st.month === month && st.level >= level) return null;
  setState(companyId, 'quotaAlert', { month, level });
  const { queueEmail, renderEmail } = require('./notify');
  const s = getSettings(companyId);
  const company = get('SELECT name FROM companies WHERE id = ?', companyId).name;
  const { html, text } = renderEmail({ brand: s, title: level === 100 ? 'Limite de respostas do mês atingido' : 'Você já usou 80% das respostas do mês',
    intro: `A empresa ${company} recebeu ${used.toLocaleString('pt-BR')} respostas neste mês; o plano ${plan.name} inclui ${max.toLocaleString('pt-BR')}. As respostas continuam sendo recebidas normalmente, mas recomendamos trocar de plano.` });
  const to = all("SELECT email FROM users WHERE ((company_id = ? AND role = 'admin') OR role = 'master') AND active = 1 /* tenant-ok: administradores da empresa e Masters */", companyId).map((u) => u.email);
  for (const addr of to) queueEmail({ to: addr, subject: `${company}: ${level}% das respostas do plano no mês`, text, html, kind: 'quota', companyId });
  return level;
}

module.exports = { LIMITS, FEATURES, listPlans, getPlan, planOf, usage, assertLimit, hasFeature, assertFeature, planView, savePlan, planInput, checkResponseQuota, monthStart };
