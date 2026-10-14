'use strict';
// Autenticação do painel (sessão em cookie HttpOnly + token CSRF) e do quiosque (token de dispositivo).
//
// Toda requisição do painel ganha um CONTEXTO montado aqui, a partir de dados que o servidor já conhece
// (nunca do que o navegador envia): usuário, papel, empresa em uso, permissões e unidades que pode ver.
const { get, all, run } = require('./db');
const { randomToken, sha256, safeEqual } = require('./security');
const { HttpError } = require('./validate');
const { permissionsFor } = require('./permissions');
const { BLOCKED } = require('./companies');

const SECURE_COOKIE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const COOKIE_NAME = SECURE_COOKIE ? '__Host-sid' : 'sid';
const IDLE_MS = 2 * 60 * 60 * 1000;      // 2h sem uso encerra a sessão
const ABSOLUTE_MS = 12 * 60 * 60 * 1000; // no máximo 12h por login
const ACTING_MS = 2 * 60 * 60 * 1000;    // o Master fica no máximo 2h dentro de uma empresa

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(value, maxAgeSec) {
  return [`${COOKIE_NAME}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
    SECURE_COOKIE ? 'Secure' : null, `Max-Age=${maxAgeSec}`].filter(Boolean).join('; ');
}

function createSession(res, user, req, { setupRequired = false } = {}) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = Date.now();
  // Sessões antigas do mesmo usuário continuam válidas (vários computadores),
  // mas o token novo sempre é gerado no login (evita fixação de sessão).
  run('INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen_at, ip, user_agent, mfa_setup_required) VALUES (?,?,?,?,?,?,?,?)',
    sha256(token), user.id, csrf, now, now, req.ip, String(req.get('user-agent') || '').slice(0, 300), setupRequired ? 1 : 0);
  res.append('Set-Cookie', cookieString(token, ABSOLUTE_MS / 1000));
  return csrf;
}

function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.append('Set-Cookie', cookieString('', 0));
}

function destroyUserSessions(userId) { run('DELETE FROM sessions WHERE user_id = ?', userId); }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MFA_SETUP_ALLOWED = new Set(['GET /me', 'POST /mfa/setup', 'POST /mfa/enable', 'POST /logout']);
// Empresa suspensa (falta de pagamento, fim do teste ou suspensão pela plataforma): o painel fica limitado à tela de pagamento.
const LOCK_ALLOWED = new Set(['GET /me', 'POST /logout', 'POST /me/password', 'GET /billing', 'POST /billing/subscribe',
  'GET /mfa', 'POST /mfa/setup', 'POST /mfa/enable', 'POST /mfa/disable', 'POST /mfa/recovery-codes']);

// Unidades que um gestor pode ver: só as vinculadas a ele E da empresa em uso.
const gestorScope = (userId, companyId) => all(`SELECT ub.branch_id FROM user_branches ub JOIN branches b ON b.id = ub.branch_id
  WHERE ub.user_id = ? AND b.company_id = ?`, userId, companyId).map((r) => r.branch_id);

// Middleware: exige sessão válida; em métodos que alteram dados exige CSRF + Origin.
function requireUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token || token.length > 100) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  const s = get(`SELECT s.*, u.name, u.email, u.role, u.active, u.company_id, u.permissions FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ?`, sha256(token));
  const now = Date.now();
  if (!s || !s.active || now - s.last_seen_at > IDLE_MS || now - s.created_at > ABSOLUTE_MS) {
    if (s) run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
    throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
  }
  if (!SAFE_METHODS.has(req.method)) {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) throw new HttpError(403, 'Origem não permitida.');
    if (!safeEqual(req.get('x-csrf-token'), s.csrf)) throw new HttpError(403, 'Token CSRF inválido.');
  }
  if (now - s.last_seen_at > 60_000) run('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?', now, s.token_hash);

  // Empresa em uso: a do usuário; para o Master, a escolhida em "Entrar na empresa" (vale 2h).
  let companyId = s.company_id;
  let acting = null;
  if (s.role === 'master') {
    companyId = null;
    if (s.acting_company_id && s.acting_until > now) {
      companyId = s.acting_company_id;
      acting = { companyId, until: s.acting_until, reason: s.acting_reason };
    } else if (s.acting_company_id) {
      run('UPDATE sessions SET acting_company_id = NULL, acting_until = NULL, acting_reason = NULL WHERE token_hash = ?', s.token_hash);
    }
  }
  const company = companyId ? get('SELECT id, name, slug, status, timezone, lock_kind, status_reason FROM companies WHERE id = ?', companyId) : null;
  if (s.role !== 'master') {
    if (!company) throw new HttpError(401, 'Sessão expirada. Faça login novamente.');
    if (company.status === 'canceled') {
      run('DELETE FROM sessions WHERE token_hash = ?', s.token_hash);
      throw new HttpError(403, 'O acesso desta empresa foi cancelado.');
    }
  }
  const perms = permissionsFor(s.role, s.permissions);
  req.user = {
    id: s.user_id, name: s.name, email: s.email, role: s.role, csrf: s.csrf, mfaSetupRequired: !!s.mfa_setup_required, sessionHash: s.token_hash,
    companyId: company?.id ?? null, company, acting, perms,
    scope: s.role === 'gestor' && company ? gestorScope(s.user_id, company.id) : null,
    can: (p) => perms.has(p),
  };
  if (company?.status === 'suspended' && s.role !== 'master' && !LOCK_ALLOWED.has(`${req.method} ${req.path}`)) {
    return res.status(402).json({ error: company.lock_kind === 'manual' ? 'O acesso desta empresa está suspenso pela plataforma.' : 'Pagamento pendente: o acesso está limitado à tela de faturamento.', code: 'COMPANY_LOCKED' });
  }
  // Usuário sem 2FA (quando obrigatório): só pode configurar o 2FA, ver seus dados ou sair.
  if (req.user.mfaSetupRequired && !MFA_SETUP_ALLOWED.has(`${req.method} ${req.path}`)) {
    return res.status(403).json({ error: 'Ative a autenticação em duas etapas para continuar.', code: 'MFA_SETUP_REQUIRED' });
  }
  next();
}

// Rotas da empresa: exige uma empresa em uso (o Master precisa "entrar na empresa" antes).
function requireCompany(req, res, next) {
  if (!req.user?.companyId) throw Object.assign(new HttpError(409, 'Escolha uma empresa para continuar.'), { code: 'COMPANY_REQUIRED' });
  next();
}

const requirePerm = (perm) => (req, res, next) => {
  if (!req.user?.can(perm)) throw new HttpError(403, 'Você não tem permissão para esta ação.');
  next();
};

function requireMaster(req, res, next) {
  if (req.user?.role !== 'master') throw new HttpError(403, 'Acesso restrito ao Master.');
  next();
}

// Middleware do quiosque: token do dispositivo no cabeçalho Authorization.
// A unidade e a empresa SEMPRE vêm do dispositivo — nunca do que o tablet envia.
function requireDevice(req, res, next) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.get('authorization') || '');
  if (!m) throw new HttpError(401, 'Dispositivo não autorizado.');
  const d = get(`SELECT d.*, b.name AS branch_name, b.active AS branch_active, b.survey_id, b.company_id AS branch_company_id, c.status AS company_status
                 FROM devices d JOIN branches b ON b.id = d.branch_id JOIN companies c ON c.id = b.company_id WHERE d.token_hash = ?`, sha256(m[1]));
  if (!d || !d.active || !d.branch_active || d.company_id !== d.branch_company_id) throw new HttpError(401, 'Dispositivo não autorizado.');
  if (BLOCKED.has(d.company_status)) throw new HttpError(423, 'Pesquisa indisponível no momento.');
  const now = Date.now();
  if (!d.last_seen_at || now - d.last_seen_at > 30_000) run('UPDATE devices SET last_seen_at = ?, last_ip = ? WHERE id = ? /* tenant-ok: dispositivo já validado acima */', now, req.ip, d.id);
  req.device = d;
  next();
}

module.exports = {
  createSession, destroySession, destroyUserSessions, requireUser, requireCompany, requirePerm, requireMaster, requireDevice,
  ACTING_MS, COOKIE_NAME,
};
