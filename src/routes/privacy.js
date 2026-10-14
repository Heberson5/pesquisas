'use strict';
// LGPD — pedidos do titular dos dados: localizar, exportar (portabilidade) e excluir/anonimizar os dados de uma pessoa.
// Administrador (empresa inteira) ou gestor com a permissão liberada (só as unidades dele).
// A busca é por telefone ou e-mail via HMAC com a chave DA EMPRESA: o dado aberto nunca é usado como índice,
// e uma empresa não consegue descobrir se o mesmo cliente respondeu em outra.
const express = require('express');
const { all, run, tx, auditReq } = require('../db');
const { requireUser, requireCompany, requirePerm } = require('../auth');
const { P } = require('../permissions');
const { bad, str } = require('../validate');
const { normPhone, normEmail } = require('../vault');
const { decryptFor, lookupFor, lookupAllFor } = require('../companies');
const { scope, placeholders } = require('../scope');
const { isEmail } = require('../notify');
const { rateLimiter } = require('../security');

const router = express.Router();
router.use(requireUser, requireCompany, requirePerm(P.PRIVACY), rateLimiter({ windowMs: 60_000, max: 30 }));

function matches(user, body) {
  const phone = body?.phone ? normPhone(str(body.phone, { field: 'telefone', max: 30 })) : null;
  const email = body?.email ? normEmail(str(body.email, { field: 'e-mail', max: 254 })) : null;
  if (phone && !/^\d{10,13}$/.test(phone)) throw bad('Telefone inválido.');
  if (email && !isEmail(email)) throw bad('E-mail inválido.');
  if (!phone && !email) throw bad('Informe telefone ou e-mail.');
  const cid = user.companyId;
  const s = scope(user);
  // Durante a rotação da chave mestra, busca também pelo identificador antigo.
  const ph = phone ? lookupAllFor(cid, 'phone:' + phone) : ['-'];
  const em = email ? lookupAllFor(cid, 'email:' + email) : ['-'];
  const rows = all(`SELECT r.id, r.submitted_at, r.contact_name_enc, r.contact_phone_enc, r.contact_email_enc, r.contact_consent_at, b.name AS branch, s.title AS survey
      FROM responses r JOIN branches b ON b.id = r.branch_id JOIN surveys s ON s.id = r.survey_id
      WHERE r.company_id = ? AND r.anonymized_at IS NULL AND (r.contact_phone_lookup IN (${placeholders(ph)}) OR r.contact_email_lookup IN (${placeholders(em)}))
      ${s ? (s.length ? `AND r.branch_id IN (${placeholders(s)})` : 'AND 0') : ''} ORDER BY r.submitted_at`,
  cid, ...ph, ...em, ...(s || []));
  return { rows, key: { phone: !!phone, email: !!email } };
}

router.post('/search', (req, res) => {
  const { rows, key } = matches(req.user, req.body);
  auditReq(req, 'privacy.search', { found: rows.length, by: key });
  res.json(rows.map((r) => ({ id: r.id, submitted_at: r.submitted_at, branch: r.branch, survey: r.survey, name: decryptFor(req.user.companyId, r.contact_name_enc) })));
});

router.post('/export', (req, res) => {
  const cid = req.user.companyId;
  const { rows } = matches(req.user, req.body);
  const data = rows.map((r) => ({
    data: new Date(r.submitted_at).toISOString(), unidade: r.branch, pesquisa: r.survey,
    contato: { nome: decryptFor(cid, r.contact_name_enc), telefone: decryptFor(cid, r.contact_phone_enc), email: decryptFor(cid, r.contact_email_enc),
      consentimento_em: new Date(r.contact_consent_at).toISOString() },
    respostas: all(`SELECT q.text AS pergunta, COALESCE(a.value_text, CAST(a.value_num AS TEXT)) AS resposta FROM answers a
      JOIN questions q ON q.id = a.question_id WHERE a.response_id = ? ORDER BY q.position`, r.id),
  }));
  auditReq(req, 'privacy.export', { count: rows.length });
  res.set('Content-Disposition', 'attachment; filename="dados-titular.json"');
  res.json({ geradoEm: new Date().toISOString(), registros: data });
});

// Exclusão: apaga contato e comentários livres; as notas numéricas ficam (sem vínculo com a pessoa)
// para não distorcer o NPS histórico. Só atua em respostas da empresa informada.
function anonymize(companyId, ids) {
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  tx(() => {
    run(`UPDATE responses SET contact_name_enc = NULL, contact_phone_enc = NULL, contact_email_enc = NULL, contact_phone_lookup = NULL,
      contact_email_lookup = NULL, geo_lat = NULL, geo_lng = NULL, anonymized_at = ? WHERE company_id = ? AND id IN (${ph})`, Date.now(), companyId, ...ids);
    run(`DELETE FROM answers WHERE response_id IN (SELECT id FROM responses WHERE company_id = ? AND id IN (${ph}))
      AND question_id IN (SELECT id FROM questions WHERE type = 'text')`, companyId, ...ids);
    run(`UPDATE case_notes SET text = '[removido a pedido do titular]' WHERE text IS NOT NULL
      AND case_id IN (SELECT id FROM cases WHERE company_id = ? AND response_id IN (${ph}))`, companyId, ...ids);
  });
}

router.post('/erase', (req, res) => {
  if (req.body?.confirm !== true) throw bad('Confirme a exclusão.');
  require('./auth').confirmSensitive(req);
  const { rows } = matches(req.user, req.body);
  anonymize(req.user.companyId, rows.map((r) => r.id));
  auditReq(req, 'privacy.erase', { count: rows.length });
  res.json({ ok: true, erased: rows.length });
});

module.exports = router;
module.exports.anonymize = anonymize;
