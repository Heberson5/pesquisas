'use strict';
// Painel (estatísticas), lista de respostas, exportações e exclusão — sempre da empresa em uso,
// no escopo do usuário (gestor: só as unidades dele).
// Exclusão de respostas: Administrador (só na própria empresa) e Master (em qualquer empresa, depois de entrar nela).
const express = require('express');
const { get, all, run, tx, auditReq } = require('../db');
const { requireCompany, requirePerm } = require('../auth');
const { P } = require('../permissions');
const { HttpError, int, id } = require('../validate');
const { responseFilter, computeStats, reportFor } = require('../stats');
const { placeholders } = require('../scope');
const { companyTz } = require('../companies');

const router = express.Router();
router.use(requireCompany);

router.get('/stats', requirePerm(P.DASHBOARD), (req, res) => res.json(computeStats(req.user, req.query)));

function listResponses(user, query, limit, offset) {
  const f = responseFilter(user, query);
  const total = get(`SELECT COUNT(*) AS n FROM responses r ${f.sql}`, ...f.params).n;
  const rows = all(`SELECT r.id, r.uuid, r.submitted_at, r.started_at, r.channel, r.lang, r.geo_lat, r.geo_lng, r.geo_city, r.geo_uf, r.geo_region, COALESCE(r.device_label, d.name) AS device_label, b.name AS branch, b.city AS branch_city, s.title AS survey, d.name AS device
      FROM responses r JOIN branches b ON b.id = r.branch_id JOIN surveys s ON s.id = r.survey_id
      LEFT JOIN devices d ON d.id = r.device_id ${f.sql} ORDER BY r.submitted_at DESC LIMIT ? OFFSET ?`, ...f.params, limit, offset);
  if (rows.length) {
    const ans = all(`SELECT a.response_id, q.text, q.type, q.is_nps, a.value_num, a.value_text FROM answers a
        JOIN questions q ON q.id = a.question_id WHERE a.response_id IN (${placeholders(rows)}) ORDER BY q.position`, ...rows.map((r) => r.id));
    for (const r of rows) r.answers = ans.filter((a) => a.response_id === r.id).map((a) => ({
      question: a.text, type: a.type, is_nps: !!a.is_nps, value: displayValue(a),
    }));
  }
  return { total, rows };
}

function displayValue(a) {
  if (a.type === 'yesno') return a.value_num ? 'Sim' : 'Não';
  if (a.type === 'multi') return JSON.parse(a.value_text).join(', ');
  return a.value_text ?? String(a.value_num);
}

router.get('/responses', requirePerm(P.DASHBOARD), (req, res) => {
  const page = int(req.query.page || '1', { field: 'página', min: 1, max: 100000 });
  res.json({ page, pageSize: 25, ...listResponses(req.user, req.query, 25, (page - 1) * 25) });
});

// Respostas, casos e anotações ligados a ela saem juntos (ON DELETE CASCADE). Fica registrado na auditoria.
router.delete('/responses/:id', requirePerm(P.DELETE_RESPONSES), (req, res) => {
  const rid = id(req.params.id);
  const r = get('SELECT id, branch_id, survey_id, submitted_at FROM responses WHERE id = ? AND company_id = ?', rid, req.user.companyId);
  if (!r) throw new HttpError(404, 'Resposta não encontrada.');
  run('DELETE FROM responses WHERE id = ? AND company_id = ?', rid, req.user.companyId);
  auditReq(req, 'response.delete', { id: rid, branchId: r.branch_id, surveyId: r.survey_id }, r.branch_id);
  res.json({ ok: true });
});

// Exclusão em lote do que está filtrado na tela (útil para limpar os testes). Exige digitar a palavra EXCLUIR.
router.post('/responses/delete-filtered', requirePerm(P.DELETE_RESPONSES), (req, res) => {
  if (req.body?.confirm !== 'EXCLUIR') throw new HttpError(400, 'Digite EXCLUIR para confirmar.');
  require('./auth').confirmSensitive(req); // exclusão em lote também exige a senha (e o código do 2FA, se ativo)
  const f = responseFilter(req.user, req.body?.filter && typeof req.body.filter === 'object' ? req.body.filter : {});
  const n = tx(() => run(`DELETE FROM responses WHERE company_id = ? AND id IN (SELECT r.id FROM responses r ${f.sql})`, req.user.companyId, ...f.params).changes);
  auditReq(req, 'responses.delete_filtered', { count: Number(n), filter: req.body?.filter || {} });
  res.json({ ok: true, deleted: Number(n) });
});

// Exportação CSV (protege contra "CSV injection" ao abrir no Excel).
function csvCell(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return '"' + String(v).replace('.', ',') + '"'; // número de verdade (ex.: coordenada negativa) não é fórmula
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

router.get('/responses.csv', requirePerm(P.EXPORT), (req, res) => {
  const { rows } = listResponses(req.user, req.query, 100000, 0);
  const tz = companyTz(req.user.companyId);
  const questions = [...new Set(rows.flatMap((r) => (r.answers || []).map((a) => a.question)))];
  const lines = [['Data/hora', 'Unidade', 'Pesquisa', 'Dispositivo', 'Canal', 'Cidade da loja', 'Cidade (cliente)', 'UF (cliente)', 'Região (cliente)', 'Latitude aprox.', 'Longitude aprox.', ...questions].map(csvCell).join(';')];
  for (const r of rows) {
    const map = Object.fromEntries((r.answers || []).map((a) => [a.question, a.value]));
    lines.push([new Date(r.submitted_at).toLocaleString('pt-BR', { timeZone: tz }), r.branch, r.survey, r.device_label || r.device, r.channel === 'link' ? 'QR Code' : 'Tablet', r.branch_city,
      r.geo_city, r.geo_uf, r.geo_region, r.geo_lat, r.geo_lng, ...questions.map((q) => map[q])]
      .map(csvCell).join(';'));
  }
  auditReq(req, 'responses.export', { count: rows.length, filter: req.query });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="respostas.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

router.get('/report.pptx', requirePerm(P.EXPORT), async (req, res) => {
  require('../plans').assertFeature(req.user.companyId, 'pptx');
  const { buffer: buf } = await reportFor(req.user, req.query, req.user.name);
  auditReq(req, 'report.pptx', { filter: req.query });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  res.set('Content-Disposition', `attachment; filename="relatorio-nps-${new Date().toISOString().slice(0, 10)}.pptx"`);
  res.send(buf);
});

module.exports = router;
