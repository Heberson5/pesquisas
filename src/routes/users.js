'use strict';
// Usuários da empresa em uso.
//   • Administrador (e Master dentro da empresa): cria Administradores e Gestores, define unidades e libera permissões.
//   • Gestor com a permissão "cadastrar gestores": cria e altera só Gestores das unidades dele, sem liberar permissões.
// O Master nunca aparece nem pode ser alterado aqui (não pertence a nenhuma empresa).
const express = require('express');
const { get, all, run, tx, auditReq } = require('../db');
const { hashPassword, passwordPolicyError } = require('../security');
const { requireCompany, destroyUserSessions } = require('../auth');
const { P, parseGrants, grantsInput } = require('../permissions');
const { HttpError, bad, str, id, email } = require('../validate');
const { resetUserMfa } = require('./auth');
const { scope } = require('../scope');
const { sendInvite } = require('../invites');
const { assertLimit } = require('../plans');
const { randomToken } = require('../security');

const router = express.Router();
router.use(requireCompany);

const canManageAll = (user) => user.can(P.USERS);
function requireUsersPerm(req, res, next) {
  if (!req.user.can(P.USERS) && !req.user.can(P.USERS_GESTORES)) throw new HttpError(403, 'Você não tem permissão para esta ação.');
  next();
}
router.use('/users', requireUsersPerm);

const branchesOf = (userId) => all('SELECT branch_id FROM user_branches WHERE user_id = ?', userId).map((r) => r.branch_id);

// Gestor com permissão limitada só enxerga gestores cujas unidades estão TODAS dentro das dele e que não
// tenham permissão que ele mesmo não tem (senão poderia "herdar" acessos que o administrador não lhe deu).
function visibleTo(user, target, targetBranches) {
  if (canManageAll(user)) return true;
  const s = scope(user) || [];
  return target.role === 'gestor' && targetBranches.length > 0 && targetBranches.every((b) => s.includes(b))
    && (Array.isArray(target.permissions) ? target.permissions : parseGrants(target.permissions)).every((p) => user.can(p));
}

router.get('/users', (req, res) => {
  const cid = req.user.companyId;
  const users = all('SELECT id, name, email, role, active, locked_until, created_at, totp_enabled, permissions FROM users WHERE company_id = ? ORDER BY name', cid);
  const links = all('SELECT ub.user_id, ub.branch_id FROM user_branches ub JOIN branches b ON b.id = ub.branch_id WHERE b.company_id = ?', cid);
  res.json(users.map((u) => ({ ...u, branches: links.filter((l) => l.user_id === u.id).map((l) => l.branch_id), permissions: parseGrants(u.permissions) }))
    .filter((u) => visibleTo(req.user, u, u.branches)));
});

function userInput(req, isNew) {
  const body = req.body || {};
  const cid = req.user.companyId;
  const all_ = canManageAll(req.user);
  const u = {
    name: str(body.name, { field: 'nome', min: 2, max: 100 }),
    email: email(body.email),
    role: all_ && body.role === 'admin' ? 'admin' : 'gestor',
    active: body.active === false ? 0 : 1,
    branches: Array.isArray(body.branches) ? [...new Set(body.branches.map((b) => id(b, 'unidade')))] : [],
    // Só o Administrador libera permissões extras (e só para gestores).
    grants: all_ && body.role !== 'admin' ? grantsInput(body.permissions) : null,
    password: body.password || null,
    invite: isNew && body.invite === true && !body.password, // convite: o próprio usuário cria a senha pelo link do e-mail
  };
  if (!all_ && body.role === 'admin') throw new HttpError(403, 'Você só pode cadastrar gestores.');
  if ((isNew && !u.invite) || u.password) {
    const err = passwordPolicyError(u.password);
    if (err) throw bad(err);
  }
  for (const b of u.branches) if (!get('SELECT 1 FROM branches WHERE id = ? AND company_id = ?', b, cid)) throw bad('Unidade inválida.');
  if (!all_) {
    const s = scope(req.user) || [];
    if (!u.branches.length) throw bad('Escolha ao menos uma das suas unidades.');
    if (!u.branches.every((b) => s.includes(b))) throw new HttpError(403, 'Você só pode vincular gestores às suas unidades.');
  }
  return u;
}

function setUserBranches(userId, branches) {
  run('DELETE FROM user_branches WHERE user_id = ?', userId);
  for (const b of branches) run('INSERT INTO user_branches (user_id, branch_id) VALUES (?,?)', userId, b);
}

router.post('/users', (req, res) => {
  const u = userInput(req, true);
  if (get('SELECT 1 FROM users WHERE email = ? /* tenant-ok: e-mail é único na plataforma */', u.email)) throw new HttpError(409, 'Este e-mail já está em uso.');
  if (u.active) assertLimit(req.user.companyId, 'users');
  const newId = tx(() => {
    const r = run('INSERT INTO users (company_id, name, email, password_hash, role, active, permissions, created_at) VALUES (?,?,?,?,?,?,?,?)',
      req.user.companyId, u.name, u.email, hashPassword(u.password || randomToken(24) + 'a1'), u.role, u.active, u.grants && u.grants.length ? JSON.stringify(u.grants) : null, Date.now());
    setUserBranches(Number(r.lastInsertRowid), u.role === 'admin' ? [] : u.branches);
    return Number(r.lastInsertRowid);
  });
  if (u.invite) sendInvite(newId, { invitedBy: req.user.name });
  auditReq(req, 'user.create', { id: newId, email: u.email, role: u.role, branches: u.branches, permissions: u.grants || [], invited: u.invite });
  res.status(201).json({ id: newId });
});

router.put('/users/:id', (req, res) => {
  const uid = id(req.params.id);
  const existing = get('SELECT * FROM users WHERE id = ? AND company_id = ?', uid, req.user.companyId);
  if (!existing || !visibleTo(req.user, existing, branchesOf(uid))) throw new HttpError(404, 'Usuário não encontrado.');
  const u = userInput(req, false);
  if (uid === req.user.id && (u.role !== existing.role || !u.active)) throw bad('Você não pode alterar o seu próprio perfil de acesso.');
  // Gestor que cadastra gestores não troca senha, e-mail nem 2FA de outra pessoa (isso permitiria entrar na conta dela).
  if (!canManageAll(req.user) && uid !== req.user.id && (u.password || u.email !== existing.email || req.body?.resetMfa === true)) {
    throw new HttpError(403, 'Senha, e-mail e 2FA de outro usuário só o administrador altera.');
  }
  if (get('SELECT 1 FROM users WHERE email = ? AND id <> ? /* tenant-ok: e-mail é único na plataforma */', u.email, uid)) throw new HttpError(409, 'Este e-mail já está em uso.');
  if (u.active && !existing.active) assertLimit(req.user.companyId, 'users');
  // Gestor com permissão limitada não mexe nas permissões; o Administrador define (gestor) ou limpa (admin).
  const grants = canManageAll(req.user) ? (u.role === 'admin' ? [] : u.grants) : parseGrants(existing.permissions);
  tx(() => {
    run('UPDATE users SET name=?, email=?, role=?, active=?, permissions=?, locked_until = CASE WHEN ? THEN NULL ELSE locked_until END WHERE id=? AND company_id=?',
      u.name, u.email, u.role, u.active, grants.length ? JSON.stringify(grants) : null, req.body?.unlock ? 1 : 0, uid, req.user.companyId);
    if (u.password) run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ? AND company_id = ?', hashPassword(u.password), uid, req.user.companyId);
    setUserBranches(uid, u.role === 'admin' ? [] : u.branches);
  });
  // Mudança de papel, de permissões, desativação ou senha nova derrubam as sessões abertas do usuário.
  if (u.password || !u.active || u.role !== existing.role || JSON.stringify(grants) !== JSON.stringify(parseGrants(existing.permissions))) destroyUserSessions(uid);
  // Reset do 2FA (celular perdido): o usuário configura de novo no próximo login.
  const resetMfa = req.body?.resetMfa === true;
  if (resetMfa) {
    if (uid === req.user.id) throw bad('Para trocar o seu próprio 2FA, use "Minha conta".');
    resetUserMfa(uid);
  }
  auditReq(req, 'user.update', { id: uid, email: u.email, role: u.role, active: u.active, passwordReset: !!u.password, resetMfa, permissions: grants });
  res.json({ ok: true });
});

module.exports = router;
