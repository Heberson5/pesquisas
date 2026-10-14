'use strict';
// Cadastro e ciclo de vida das empresas (usado pelo Painel Master e pelo autocadastro).
//   • CNPJ: dígitos conferidos, um cadastro por CNPJ (mesmo cancelado, até a exclusão definitiva)
//     e situação "ATIVA" na Receita. Se a consulta estiver fora do ar, o Master pode preencher à mão.
//   • Situação: em teste, ativa, suspensa, cancelada (com motivo), e exclusão definitiva só de empresa cancelada.
const fs = require('node:fs');
const path = require('node:path');
const { get, all, run, tx, MEDIA_DIR } = require('./db');
const { HttpError, bad, str, email: emailField } = require('./validate');
const cnpjLib = require('./cnpj');
const { createCompany, forgetKeys, STATUS_LABEL } = require('./companies');
const { BR_ZONES } = require('./zones');
const { hashPassword, randomToken } = require('./security');
const { sendInvite } = require('./invites');

const UFS = new Set(['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO']);
const opt = (v, field, max) => str(v, { field, max, optional: true }) || null;

function addressInput(a) {
  if (a === undefined || a === null) return null;
  if (typeof a !== 'object' || Array.isArray(a)) throw bad('Endereço inválido.');
  const uf = a.uf ? String(a.uf).toUpperCase() : null;
  if (uf && !UFS.has(uf)) throw bad('UF inválida.');
  const cep = a.cep ? String(a.cep).replace(/\D/g, '') : null;
  if (cep && cep.length !== 8) throw bad('CEP inválido.');
  return {
    street: opt(a.street, 'logradouro', 150), number: opt(a.number, 'número', 20), complement: opt(a.complement, 'complemento', 80),
    district: opt(a.district, 'bairro', 80), city: opt(a.city, 'cidade', 80), uf, cep: cep ? `${cep.slice(0, 5)}-${cep.slice(5)}` : null,
  };
}

// Valida os dados digitados (ou trazidos da Receita e conferidos pelo Master).
function companyInput(b = {}, { requireCnpj = true } = {}) {
  const cnpj = b.cnpj ? cnpjLib.digits(b.cnpj) : null;
  if (requireCnpj && !cnpj) throw bad('Informe o CNPJ.');
  if (cnpj && !cnpjLib.isValid(cnpj)) throw bad('CNPJ inválido (confira os dígitos).');
  const tz = b.timezone || null;
  if (tz && !BR_ZONES.includes(tz)) throw bad('Fuso horário inválido.');
  const phone = b.phone ? String(b.phone).replace(/\D/g, '') : null;
  if (b.phone && !/^\d{10,13}$/.test(phone || '')) throw bad('Telefone inválido.');
  return {
    cnpj,
    name: str(b.name, { field: 'nome da empresa', min: 2, max: 60 }),
    legalName: opt(b.legalName, 'razão social', 150),
    tradeName: opt(b.tradeName, 'nome fantasia', 150),
    address: addressInput(b.address),
    phone,
    contactEmail: b.contactEmail ? emailField(b.contactEmail) : null,
    billingEmail: b.billingEmail ? emailField(b.billingEmail) : null,
    timezone: tz,
    notes: opt(b.notes, 'observações', 1000),
  };
}

// Confere o CNPJ: duplicado é sempre recusado; na Receita, só cadastra empresa ATIVA.
// Fora do ar: o Master segue com os dados digitados (manual = true); o autocadastro não.
async function checkCnpj(cnpj, { exceptId = null, allowManual = true } = {}) {
  const dup = get('SELECT id, name, status FROM companies WHERE cnpj = ? AND id <> ?', cnpj, exceptId ?? -1);
  if (dup) throw new HttpError(409, `Já existe uma empresa com este CNPJ: ${dup.name} (${STATUS_LABEL[dup.status]}).`);
  const r = await cnpjLib.lookup(cnpj);
  if (r.found && !r.data.active) throw new HttpError(422, `Este CNPJ está com situação "${r.data.status || 'desconhecida'}" na Receita Federal. Só é possível cadastrar empresa ATIVA.`);
  if (r.notFound) throw new HttpError(422, 'CNPJ não encontrado na Receita Federal.');
  if (r.unavailable && !allowManual) throw new HttpError(503, 'A consulta do CNPJ está indisponível no momento. Tente novamente em alguns minutos.');
  return r.found ? { status: r.data.status, data: r.data } : { status: null, data: null, manual: true };
}

function saveDetails(companyId, c, receita) {
  run(`UPDATE companies SET name = ?, legal_name = ?, trade_name = ?, cnpj = ?, address_json = ?, phone = ?, contact_email = ?, billing_email = ?,
      timezone = ?, notes = ?, cnae = COALESCE(?, cnae), opened_at = COALESCE(?, opened_at),
      receita_status = CASE WHEN ? THEN ? ELSE receita_status END, receita_checked_at = CASE WHEN ? THEN ? ELSE receita_checked_at END, updated_at = ?
    WHERE id = ?`,
  c.name, c.legalName, c.tradeName, c.cnpj, c.address ? JSON.stringify(c.address) : null, c.phone, c.contactEmail, c.billingEmail,
  c.timezone, c.notes, receita?.data?.cnae ?? null, receita?.data?.openedAt ?? null,
  receita ? 1 : 0, receita?.status ?? null, receita ? 1 : 0, receita?.status ? Date.now() : null, Date.now(), companyId);
}

// Cria a empresa e, se informado, o primeiro Administrador (com convite por e-mail ou senha definida no autocadastro).
async function registerCompany(input, { origin = 'master', status = 'trial', trialDays = 14, planId = null, admin = null, invitedBy = null, allowManual = true } = {}) {
  const c = companyInput(input);
  const receita = await checkCnpj(c.cnpj, { allowManual });
  // O que não foi digitado vem da Receita (razão social, nome fantasia, endereço, telefone, e-mail).
  if (receita.data) {
    const d = receita.data;
    c.legalName ||= d.legalName; c.tradeName ||= d.tradeName; c.address ||= d.address; c.phone ||= d.phone; c.contactEmail ||= d.email;
  }
  let adminUser = null;
  if (admin) {
    adminUser = { name: str(admin.name, { field: 'nome do administrador', min: 2, max: 100 }), email: emailField(admin.email), password: admin.password || null };
    if (get('SELECT 1 FROM users WHERE email = ? /* tenant-ok: e-mail é único na plataforma */', adminUser.email)) throw new HttpError(409, 'O e-mail do administrador já está em uso.');
  }
  const ids = tx(() => {
    if (get('SELECT 1 FROM companies WHERE cnpj = ?', c.cnpj)) throw new HttpError(409, 'Já existe uma empresa com este CNPJ.');
    const id = createCompany({ name: c.name, legalName: c.legalName, cnpj: c.cnpj, status,
      timezone: c.timezone, billingEmail: c.billingEmail, trialEndsAt: status === 'trial' ? Date.now() + trialDays * 86_400_000 : null });
    saveDetails(id, c, receita);
    run('UPDATE companies SET origin = ?, plan_id = ? WHERE id = ?', origin, planId, id);
    run("INSERT INTO company_settings (company_id, key, value) VALUES (?, 'companyName', ?)", id, JSON.stringify(c.name));
    let userId = null;
    if (adminUser) {
      userId = Number(run("INSERT INTO users (company_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,'admin',?)",
        id, adminUser.name, adminUser.email, hashPassword(adminUser.password || randomToken(24) + 'a1'), Date.now()).lastInsertRowid);
    }
    return { id, userId };
  });
  if (ids.userId && !adminUser.password) sendInvite(ids.userId, { invitedBy });
  return { ...ids, receita: receita.status, manual: !!receita.manual };
}

async function updateCompany(companyId, input) {
  const cur = get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!cur) throw new HttpError(404, 'Empresa não encontrada.');
  const c = companyInput(input);
  // Trocar o CNPJ passa pelas mesmas conferências do cadastro.
  const receita = c.cnpj !== cur.cnpj ? await checkCnpj(c.cnpj, { exceptId: companyId }) : null;
  saveDetails(companyId, c, receita);
  return { changedCnpj: !!receita };
}

// Mudança de situação. Suspender/cancelar derruba as sessões dos usuários da empresa.
const NEXT = new Set(['trial', 'active', 'suspended', 'canceled']);
function setStatus(companyId, status, reason) {
  const cur = get('SELECT id, status FROM companies WHERE id = ?', companyId);
  if (!cur) throw new HttpError(404, 'Empresa não encontrada.');
  if (!NEXT.has(status)) throw bad('Situação inválida.');
  if (status === cur.status) return cur.status;
  if (['suspended', 'canceled'].includes(status) && (!reason || String(reason).trim().length < 5)) throw bad('Informe o motivo (mínimo 5 caracteres).');
  tx(() => {
    run(`UPDATE companies SET status = ?, status_reason = ?, lock_kind = CASE WHEN ? = 'suspended' THEN 'manual' ELSE NULL END, canceled_at = CASE WHEN ? = 'canceled' THEN ? ELSE NULL END, updated_at = ?,
        trial_ends_at = CASE WHEN ? = 'trial' THEN COALESCE(trial_ends_at, ?) ELSE trial_ends_at END WHERE id = ?`,
    status, reason ? String(reason).trim().slice(0, 300) : null, status, status, Date.now(), Date.now(), status, Date.now() + 14 * 86_400_000, companyId);
    if (['suspended', 'canceled'].includes(status)) {
      run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
      run('UPDATE sessions SET acting_company_id = NULL, acting_until = NULL, acting_reason = NULL WHERE acting_company_id = ?', companyId);
    }
  });
  return cur.status;
}

// Exclusão definitiva (só de empresa cancelada): apaga todos os dados, os arquivos e a chave de criptografia.
// Depois disso o CNPJ fica livre para um novo cadastro.
const TENANT_TABLES = ['outbox', 'schedules', 'cases', 'responses', 'devices', 'user_branches', 'surveys', 'branches', 'media', 'company_settings', 'users'];
function purgeCompany(companyId) {
  const c = get('SELECT id, name, status, cnpj FROM companies WHERE id = ?', companyId);
  if (!c) throw new HttpError(404, 'Empresa não encontrada.');
  if (c.status !== 'canceled') throw new HttpError(409, 'Só é possível excluir definitivamente uma empresa cancelada.');
  const counts = {};
  tx(() => {
    run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
    run('DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
    run('DELETE FROM mfa_recovery_codes WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
    run('DELETE FROM mfa_challenges WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)', companyId);
    run('UPDATE audit_log SET user_id = NULL WHERE user_id IN (SELECT id FROM users WHERE company_id = ?) AND company_id IS NULL', companyId);
    for (const t of TENANT_TABLES) {
      if (t === 'user_branches') { counts[t] = Number(run('DELETE FROM user_branches WHERE branch_id IN (SELECT id FROM branches WHERE company_id = ?)', companyId).changes); continue; }
      if (t === 'surveys') run('DELETE FROM questions WHERE survey_id IN (SELECT id FROM surveys WHERE company_id = ?)', companyId);
      if (t === 'responses') run('DELETE FROM answers WHERE response_id IN (SELECT id FROM responses WHERE company_id = ?)', companyId);
      if (t === 'cases') run('DELETE FROM case_notes WHERE case_id IN (SELECT id FROM cases WHERE company_id = ?)', companyId);
      counts[t] = Number(run(`DELETE FROM ${t} WHERE company_id = ?`, companyId).changes);
    }
    run('DELETE FROM audit_log WHERE company_id = ?', companyId);
    run('DELETE FROM companies WHERE id = ?', companyId);
  });
  forgetKeys(companyId);
  fs.rmSync(path.join(MEDIA_DIR, String(companyId)), { recursive: true, force: true });
  return { name: c.name, cnpj: c.cnpj, counts };
}

function companyDetails(companyId) {
  const c = get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) throw new HttpError(404, 'Empresa não encontrada.');
  const { key_salt: _salt, address_json: addr, ...rest } = c;
  let address = null; try { address = addr ? JSON.parse(addr) : null; } catch { address = null; }
  const { planView } = require('./plans');
  return {
    ...rest, address, statusLabel: STATUS_LABEL[c.status], planUsage: planView(companyId),
    admins: all("SELECT id, name, email, active, totp_enabled, created_at FROM users WHERE company_id = ? AND role = 'admin' ORDER BY name", companyId),
    counts: get(`SELECT (SELECT COUNT(*) FROM branches WHERE company_id = ?) AS branches, (SELECT COUNT(*) FROM devices WHERE company_id = ? AND active = 1) AS devices,
      (SELECT COUNT(*) FROM users WHERE company_id = ? AND active = 1) AS users, (SELECT COUNT(*) FROM responses WHERE company_id = ?) AS responses,
      (SELECT COUNT(*) FROM surveys WHERE company_id = ?) AS surveys`, companyId, companyId, companyId, companyId, companyId),
  };
}

module.exports = { companyInput, checkCnpj, registerCompany, updateCompany, setStatus, purgeCompany, companyDetails, TENANT_TABLES };
