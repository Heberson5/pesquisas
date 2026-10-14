'use strict';
// Retenção de dados (LGPD): apaga automaticamente o que passou do prazo definido em Configurações,
// empresa por empresa (cada uma com os próprios prazos).
const { all, run, audit } = require('./db');
const { getSettings } = require('./settings');
const { anonymize } = require('./routes/privacy');

const MONTH = 30 * 86_400_000;

function applyRetentionFor(companyId, now = Date.now()) {
  const r = getSettings(companyId).retention;
  // Contatos vencidos: remove os dados pessoais.
  const contacts = all('SELECT id FROM responses WHERE company_id = ? AND anonymized_at IS NULL AND contact_consent_at IS NOT NULL AND submitted_at < ?',
    companyId, now - r.contactsMonths * MONTH).map((x) => x.id);
  anonymize(companyId, contacts);
  // Coordenadas aproximadas vencidas: mantém só cidade/UF/região (estatística), apaga o ponto no mapa.
  const g = run('UPDATE responses SET geo_lat = NULL, geo_lng = NULL WHERE company_id = ? AND geo_lat IS NOT NULL AND submitted_at < ?', companyId, now - r.contactsMonths * MONTH);
  // Comentários livres vencidos (podem conter dados pessoais escritos pelo cliente).
  const old = now - r.commentsMonths * MONTH;
  const c = run(`DELETE FROM answers WHERE question_id IN (SELECT id FROM questions WHERE type = 'text')
    AND response_id IN (SELECT id FROM responses WHERE company_id = ? AND submitted_at < ?)`, companyId, old);
  run(`UPDATE case_notes SET text = '[removido por prazo de retenção]' WHERE text IS NOT NULL AND at < ? AND text <> '[removido por prazo de retenção]'
    AND case_id IN (SELECT id FROM cases WHERE company_id = ?)`, old, companyId);
  const a = run('DELETE FROM audit_log WHERE company_id = ? AND at < ?', companyId, now - r.auditMonths * MONTH);
  const result = { contacts: contacts.length, coordinates: Number(g.changes), comments: Number(c.changes), audit: Number(a.changes) };
  if (result.contacts || result.coordinates || result.comments || result.audit) audit(null, 'lgpd.retention', result, null, { companyId });
  return result;
}

// Todas as empresas (inclusive suspensas: o prazo da LGPD continua valendo). Devolve os totais e o detalhe por empresa.
function applyRetention(now = Date.now()) {
  const total = { contacts: 0, coordinates: 0, comments: 0, audit: 0, byCompany: {} };
  for (const { id } of all('SELECT id FROM companies ORDER BY id /* tenant-ok: rotina percorre todas as empresas */')) {
    const r = applyRetentionFor(id, now);
    total.byCompany[id] = r;
    for (const k of ['contacts', 'coordinates', 'comments', 'audit']) total[k] += r[k];
  }
  return total;
}

module.exports = { applyRetention, applyRetentionFor };
