'use strict';
// Unidades (filiais), link/QR Code, campanhas agendadas e tablets — sempre dentro da empresa em uso.
// Gestor: só as unidades dele; cria unidades novas só se o Administrador liberar.
const express = require('express');
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { get, all, run, tx, auditReq } = require('../db');
const { pairingCode, sha256 } = require('../security');
const { requireCompany, requirePerm } = require('../auth');
const { P } = require('../permissions');
const { HttpError, bad, str, int, bool, id } = require('../validate');
const { emailList } = require('../settings');
const zones = require('../zones');
const { scope, assertBranch, placeholders } = require('../scope');
const { encrypt, decrypt, lookup } = require('../vault');
const { publicUrl } = require('../config');
const { parseLocal } = require('../time');
const { companyTz } = require('../companies');

const router = express.Router();
router.use(requireCompany);
const PAIR_TTL_MS = 15 * 60_000;

// ---------------------------------------------------------------- unidades
router.get('/branches', (req, res) => {
  const s = scope(req.user);
  const rows = all(`SELECT b.id, b.code, b.name, b.city, b.active, b.survey_id, s.title AS survey_title, b.alert_emails, b.alert_phones, b.nps_goal, b.hours_json, b.timezone, b.public_enabled, b.company_id,
      (SELECT COUNT(*) FROM devices d WHERE d.branch_id = b.id AND d.active = 1) AS devices,
      (SELECT GROUP_CONCAT(u.name, ', ') FROM user_branches ub JOIN users u ON u.id = ub.user_id WHERE ub.branch_id = b.id AND u.role = 'gestor' AND u.active = 1) AS gestores
    FROM branches b LEFT JOIN surveys s ON s.id = b.survey_id AND s.company_id = b.company_id
    WHERE b.company_id = ? ${s ? (s.length ? `AND b.id IN (${placeholders(s)})` : 'AND 0') : ''} ORDER BY b.name`, req.user.companyId, ...(s || []));
  // Fuso em uso agora (escolhido ou informado pelo tablet).
  res.json(rows.map((b) => ({ ...b, effective_tz: zones.forBranch(b) })));
});
router.get('/timezones', (req, res) => res.json({ company: companyTz(req.user.companyId), choices: zones.ZONE_CHOICES }));

// Fuso da unidade: null = Automático (usa o do tablet); senão um fuso do Brasil.
function timezoneInput(v) {
  if (v === undefined || v === null || v === '' || v === 'auto') return null;
  if (typeof v !== 'string' || !zones.usable(v)) throw bad('Fuso horário inválido.');
  return v;
}

// Telefones para WhatsApp no formato internacional, só dígitos (ex.: 5511999990000).
function phoneList(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 5) throw bad('Informe no máximo 5 telefones.');
  if (!v.every((p) => typeof p === 'string' && /^[\d\s()+.-]{8,25}$/.test(p))) throw bad('Telefone inválido: use apenas números (ex.: 5511999990000).');
  const out = [...new Set(v.map((p) => p.replace(/\D/g, '')))];
  for (const p of out) if (!/^\d{12,15}$/.test(p)) throw bad('Telefone inválido: use DDI + DDD + número (ex.: 5511999990000).');
  return out;
}

// Horário de funcionamento: 7 itens (domingo a sábado), cada um null (fechado) ou { open: 'HH:MM', close: 'HH:MM' }.
// null no total = sempre aberto.
function hoursInput(v) {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 7) throw bad('Horário de funcionamento inválido.');
  const hm = /^([01]\d|2[0-3]):[0-5]\d$/;
  const out = v.map((d) => {
    if (d === null) return null;
    if (!d || typeof d !== 'object' || !hm.test(d.open) || !hm.test(d.close) || d.open >= d.close) throw bad('Horário inválido (use HH:MM e abertura antes do fechamento).');
    return { open: d.open, close: d.close };
  });
  return JSON.stringify(out);
}

function branchInput(body) {
  const code = str(body?.code, { field: 'código', min: 1, max: 20 }).toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(code)) throw bad('Código deve conter apenas letras, números, - e _.');
  return {
    code,
    name: str(body?.name, { field: 'nome', min: 2, max: 100 }),
    city: str(body?.city, { field: 'cidade', max: 100, optional: true }),
    active: body?.active === undefined ? 1 : (bool(body.active) ? 1 : 0),
    alert_emails: JSON.stringify(body?.alert_emails === undefined ? [] : emailList(body.alert_emails, 10)),
    alert_phones: JSON.stringify(phoneList(body?.alert_phones)),
    nps_goal: body?.nps_goal === undefined || body.nps_goal === null || body.nps_goal === '' ? null : int(body.nps_goal, { field: 'meta de NPS', min: -100, max: 100 }),
    hours_json: hoursInput(body?.hours),
    timezone: timezoneInput(body?.timezone),
  };
}

router.post('/branches', requirePerm(P.BRANCH_CREATE), (req, res) => {
  const cid = req.user.companyId;
  const b = branchInput(req.body);
  if (get('SELECT 1 FROM branches WHERE company_id = ? AND code = ?', cid, b.code)) throw new HttpError(409, 'Já existe uma unidade com esse código.');
  const newId = tx(() => {
    const r = run('INSERT INTO branches (company_id, code, name, city, active, alert_emails, alert_phones, nps_goal, hours_json, timezone, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      cid, b.code, b.name, b.city, b.active, b.alert_emails, b.alert_phones, b.nps_goal, b.hours_json, b.timezone, Date.now());
    // Gestor que cria uma unidade passa a ser responsável por ela.
    if (req.user.role === 'gestor') run('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)', req.user.id, r.lastInsertRowid);
    return Number(r.lastInsertRowid);
  });
  auditReq(req, 'branch.create', { id: newId, ...b }, newId);
  res.status(201).json({ id: newId });
});

router.put('/branches/:id', requirePerm(P.BRANCH_EDIT), (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  const b = branchInput(req.body);
  if (get('SELECT 1 FROM branches WHERE company_id = ? AND code = ? AND id <> ?', req.user.companyId, b.code, bid)) throw new HttpError(409, 'Já existe uma unidade com esse código.');
  run('UPDATE branches SET code = ?, name = ?, city = ?, active = ?, alert_emails = ?, alert_phones = ?, nps_goal = ?, hours_json = ?, timezone = ? WHERE id = ? AND company_id = ?',
    b.code, b.name, b.city, b.active, b.alert_emails, b.alert_phones, b.nps_goal, b.hours_json, b.timezone, bid, req.user.companyId);
  auditReq(req, 'branch.update', { id: bid, ...b }, bid);
  res.json({ ok: true });
});

// Define qual pesquisa os tablets da unidade exibem.
router.put('/branches/:id/survey', requirePerm(P.BRANCH_EDIT), (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  const sid = req.body?.surveyId === null ? null : id(req.body?.surveyId, 'pesquisa');
  if (sid && !get('SELECT 1 FROM surveys WHERE id = ? AND company_id = ? AND active = 1', sid, req.user.companyId)) throw bad('Pesquisa inexistente ou inativa.');
  run('UPDATE branches SET survey_id = ? WHERE id = ? AND company_id = ?', sid, bid, req.user.companyId);
  auditReq(req, 'branch.set_survey', { branchId: bid, surveyId: sid }, bid);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- link / QR Code por unidade
async function linkInfo(b) {
  const token = b.public_token_enc ? decrypt(b.public_token_enc) : null;
  if (!token) return { enabled: false, url: null, qr: null };
  const url = `${publicUrl}/r/${token}`;
  return { enabled: !!b.public_enabled, url, qr: await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 600 }) };
}
const branchRow = (user, bid) => get('SELECT * FROM branches WHERE id = ? AND company_id = ?', bid, user.companyId);

router.get('/branches/:id/public-link', async (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  res.json(await linkInfo(branchRow(req.user, bid)));
});

// Ativar/desativar ou gerar um novo link (o anterior deixa de funcionar — útil se um QR vazar).
router.post('/branches/:id/public-link', requirePerm(P.BRANCH_EDIT), async (req, res) => {
  const bid = id(req.params.id);
  assertBranch(req.user, bid);
  const b = branchRow(req.user, bid);
  const enabled = req.body?.enabled !== false;
  if (req.body?.regenerate === true || !b.public_token_enc) {
    // O código fica no nível da plataforma: é por ele que o QR Code descobre a empresa e a unidade.
    const token = crypto.randomBytes(24).toString('base64url');
    run('UPDATE branches SET public_token_enc = ?, public_token_hash = ? WHERE id = ? AND company_id = ?', encrypt(token), lookup('link:' + token), bid, req.user.companyId);
  }
  run('UPDATE branches SET public_enabled = ? WHERE id = ? AND company_id = ?', enabled ? 1 : 0, bid, req.user.companyId);
  auditReq(req, 'branch.public_link', { branchId: bid, enabled, regenerated: req.body?.regenerate === true }, bid);
  res.json(await linkInfo(branchRow(req.user, bid)));
});

// ---------------------------------------------------------------- campanhas agendadas
router.get('/schedules', (req, res) => {
  const s = scope(req.user);
  const rows = all(`SELECT c.id, c.survey_id, v.title AS survey, c.branch_id, b.name AS branch, c.starts_at, c.ends_at
    FROM schedules c JOIN surveys v ON v.id = c.survey_id LEFT JOIN branches b ON b.id = c.branch_id
    WHERE c.company_id = ? ${s ? `AND (c.branch_id IS NULL OR c.branch_id IN (${s.length ? placeholders(s) : 'NULL'}))` : ''}
    ORDER BY c.starts_at DESC LIMIT 200`, req.user.companyId, ...(s || []));
  // Cada campanha é mostrada no fuso da unidade dela (ou da empresa, quando vale para todas).
  const ctz = companyTz(req.user.companyId);
  res.json(rows.map((c) => ({ ...c, tz: c.branch_id ? zones.forBranch(branchRow(req.user, c.branch_id)) : ctz })));
});

router.post('/schedules', requirePerm(P.SCHEDULES), (req, res) => {
  const cid = req.user.companyId;
  const surveyId = id(req.body?.surveyId, 'pesquisa');
  if (!get('SELECT 1 FROM surveys WHERE id = ? AND company_id = ? AND active = 1', surveyId, cid)) throw bad('Pesquisa inexistente ou inativa.');
  const branchId = req.body?.branchId === null || req.body?.branchId === undefined || req.body?.branchId === '' ? null : id(req.body.branchId, 'unidade');
  if (branchId !== null) assertBranch(req.user, branchId);
  // Campanha para TODAS as unidades só para quem enxerga a empresa inteira.
  else if (scope(req.user)) throw new HttpError(403, 'Escolha uma das suas unidades.');
  // Data e hora digitadas valem no fuso da unidade escolhida (ou no da empresa, se for para todas).
  const tz = branchId !== null ? zones.forBranch(branchRow(req.user, branchId)) : companyTz(cid);
  const startsAt = parseLocal(req.body?.startsAt, tz);
  const endsAt = parseLocal(req.body?.endsAt, tz);
  if (startsAt === null || endsAt === null) throw bad('Datas inválidas (use dia e hora).');
  if (endsAt <= startsAt) throw bad('O fim precisa ser depois do início.');
  if (endsAt - startsAt > 366 * 86_400_000) throw bad('Campanha de no máximo 1 ano.');
  if (endsAt < Date.now()) throw bad('Essa campanha já terminou.');
  const r = run('INSERT INTO schedules (company_id, survey_id, branch_id, starts_at, ends_at, created_by, created_at) VALUES (?,?,?,?,?,?,?)',
    cid, surveyId, branchId, startsAt, endsAt, req.user.id, Date.now());
  auditReq(req, 'schedule.create', { id: r.lastInsertRowid, surveyId, branchId, startsAt, endsAt }, branchId);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

router.delete('/schedules/:id', requirePerm(P.SCHEDULES), (req, res) => {
  const sid = id(req.params.id);
  const c = get('SELECT * FROM schedules WHERE id = ? AND company_id = ?', sid, req.user.companyId);
  const s = scope(req.user);
  if (!c || (s && (c.branch_id === null || !s.includes(c.branch_id)))) throw new HttpError(404, 'Campanha não encontrada.');
  run('DELETE FROM schedules WHERE id = ? AND company_id = ?', sid, req.user.companyId);
  auditReq(req, 'schedule.delete', { id: sid }, c.branch_id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- dispositivos (tablets)
router.get('/devices', (req, res) => {
  const s = scope(req.user);
  const rows = all(`SELECT d.id, d.name, d.branch_id, b.name AS branch_name, d.active, d.paired_at, d.last_seen_at,
      d.pair_expires_at, d.timezone, d.timezone_at, (d.token_hash IS NOT NULL) AS paired
    FROM devices d JOIN branches b ON b.id = d.branch_id
    WHERE d.company_id = ? ${s ? (s.length ? `AND d.branch_id IN (${placeholders(s)})` : 'AND 0') : ''} ORDER BY b.name, d.name`, req.user.companyId, ...(s || []));
  res.json(rows.map((r) => ({ ...r, paired: !!r.paired, pairing_pending: !!(r.pair_expires_at && r.pair_expires_at > Date.now()) })));
});

function issuePairingCode(companyId, deviceId) {
  const code = pairingCode(8);
  // Gerar novo código invalida o token anterior (o tablet antigo perde acesso).
  run('UPDATE devices SET pair_code_hash = ?, pair_expires_at = ?, token_hash = NULL, active = 1 WHERE id = ? AND company_id = ?',
    sha256(code), Date.now() + PAIR_TTL_MS, deviceId, companyId);
  return { code, expiresAt: Date.now() + PAIR_TTL_MS };
}

router.post('/devices', requirePerm(P.DEVICES), (req, res) => {
  const branchId = id(req.body?.branchId, 'unidade');
  assertBranch(req.user, branchId);
  const name = str(req.body?.name, { field: 'nome', min: 2, max: 60 });
  const r = run('INSERT INTO devices (company_id, branch_id, name, created_at) VALUES (?,?,?,?)', req.user.companyId, branchId, name, Date.now());
  const pairing = issuePairingCode(req.user.companyId, Number(r.lastInsertRowid));
  auditReq(req, 'device.create', { id: r.lastInsertRowid, branchId, name }, branchId);
  res.status(201).json({ id: Number(r.lastInsertRowid), ...pairing });
});

function loadDeviceScoped(user, deviceId) {
  const d = get('SELECT * FROM devices WHERE id = ? AND company_id = ?', deviceId, user.companyId);
  if (!d) throw new HttpError(404, 'Dispositivo não encontrado.');
  assertBranch(user, d.branch_id);
  return d;
}

router.post('/devices/:id/pairing-code', requirePerm(P.DEVICES), (req, res) => {
  const d = loadDeviceScoped(req.user, id(req.params.id));
  const pairing = issuePairingCode(req.user.companyId, d.id);
  auditReq(req, 'device.new_code', { id: d.id }, d.branch_id);
  res.json(pairing);
});

router.post('/devices/:id/revoke', requirePerm(P.DEVICES), (req, res) => {
  const d = loadDeviceScoped(req.user, id(req.params.id));
  run('UPDATE devices SET active = 0, token_hash = NULL, pair_code_hash = NULL, pair_expires_at = NULL WHERE id = ? AND company_id = ?', d.id, req.user.companyId);
  auditReq(req, 'device.revoke', { id: d.id }, d.branch_id);
  res.json({ ok: true });
});

module.exports = router;
