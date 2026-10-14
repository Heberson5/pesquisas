'use strict';
// Rotas do Master (dono da plataforma). Nesta fase: lista de empresas e "entrar na empresa" para dar suporte.
// Entrar exige um motivo, dura no máximo 2 horas e fica registrado na auditoria da empresa e da plataforma.
const express = require('express');
const { get, all, run, audit } = require('../db');
const { requireMaster, ACTING_MS } = require('../auth');
const { HttpError, str, id } = require('../validate');
const { STATUS_LABEL } = require('../companies');

const router = express.Router();
router.use('/master', requireMaster);

router.get('/master/companies', (req, res) => {
  const rows = all(`SELECT c.id, c.name, c.slug, c.status, c.cnpj, c.created_at,
      (SELECT COUNT(*) FROM branches b WHERE b.company_id = c.id) AS branches,
      (SELECT COUNT(*) FROM devices d WHERE d.company_id = c.id AND d.active = 1) AS devices,
      (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS users,
      (SELECT COUNT(*) FROM responses r WHERE r.company_id = c.id AND r.submitted_at >= ?) AS responses30d
    FROM companies c ORDER BY c.name /* tenant-ok: tela do Master, todas as empresas */`, Date.now() - 30 * 86_400_000);
  res.json(rows.map((c) => ({ ...c, statusLabel: STATUS_LABEL[c.status] })));
});

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

module.exports = router;
