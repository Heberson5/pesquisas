'use strict';
// Autenticação do painel: login em duas etapas (senha + 2FA), recuperação de senha por e-mail
// e gerenciamento do 2FA do próprio usuário.
const express = require('express');
const { get, all, run, tx, audit: auditRaw } = require('../db');
const wa = require('../webauthn');
const { hashPassword, verifyPassword, DUMMY_HASH, randomToken, sha256, passwordPolicyError, rateLimiter } = require('../security');
const { createSession, destroyUserSessions, requireUser } = require('../auth');
const { HttpError, bad } = require('../validate');
const totp = require('../totp');
const { encrypt, decrypt, lookup, lookupAll } = require('../vault');
const { getSettings, getPlatform, platformBranding } = require('../settings');
const { queueEmail, renderEmail } = require('../notify');
const { publicUrl } = require('../config');

const router = express.Router();
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;
const CHALLENGE_TTL = 5 * 60_000;
const RESET_TTL = 30 * 60_000;

const loginLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 20, message: 'Muitas tentativas de login. Aguarde 15 minutos.' });
const forgotLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 5, message: 'Muitas solicitações. Aguarde 15 minutos.' });
const forgotPerEmail = rateLimiter({ windowMs: 60 * 60_000, max: 3, keyFn: (req) => 'e:' + sha256(String(req.body?.email || '').toLowerCase()), message: 'Muitas solicitações. Aguarde 15 minutos.' });
const mfaLimiter = rateLimiter({ windowMs: 15 * 60_000, max: 15, message: 'Muitas tentativas. Aguarde 15 minutos.' });

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
// 2FA obrigatório: Master sempre (salvo se desligado nas configurações gerais da plataforma);
// Administrador conforme a configuração da empresa.
function mfaRequiredFor(u) {
  if (u.role === 'master') return getPlatform('security', {}).masterMfa !== false;
  const cid = u.company_id ?? u.companyId;
  return u.role === 'admin' && !!cid && getSettings(cid).requireAdminMfa;
}
// Auditoria no "livro" da empresa do usuário (Master: no da plataforma).
const audit = (userId, action, detail, ip, user = null) => {
  const u = user || (userId ? get('SELECT company_id, role FROM users WHERE id = ?', userId) : null);
  auditRaw(userId, action, detail, ip, { companyId: u?.company_id ?? null, asMaster: u?.role === 'master' });
};
// Marca dos e-mails e do app autenticador: a da empresa; para o Master, a da plataforma.
const brandOf = (u) => (u.company_id ? getSettings(u.company_id) : platformBranding());
const companyBlocked = (u) => {
  if (!u.company_id) return false;
  const c = get('SELECT status FROM companies WHERE id = ?', u.company_id);
  return !c || c.status === 'canceled';
};

function registerFailure(user, req, action) {
  const fails = user.failed_logins + 1;
  const lock = fails >= LOCK_AFTER;
  run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', lock ? 0 : fails, lock ? Date.now() + LOCK_MS : null, user.id);
  audit(user.id, action, null, req.ip);
}

function finishLogin(res, req, user) {
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', user.id);
  const setupRequired = !user.totp_enabled && mfaRequiredFor(user);
  const csrf = createSession(res, user, req, { setupRequired });
  audit(user.id, 'login.ok', { mfa: !!user.totp_enabled }, req.ip);
  try { loginAlert(user, req); } catch (e) { console.error('[alerta de login]', e.message); }
  return { user: publicUser(user), csrf, mfaSetupRequired: setupRequired };
}

// Aviso de acesso em aparelho novo: navegador/sistema + rede (/24) nunca vistos nos últimos 90 dias.
const uaFamily = (ua) => {
  const s = String(ua || '');
  const os = /Windows/.test(s) ? 'Windows' : /iPhone|iPad/.test(s) ? 'iOS' : /Android/.test(s) ? 'Android' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : 'outro';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'navegador';
  return `${br} no ${os}`;
};
const netOf = (ip) => (/^\d+\.\d+\.\d+\.\d+$/.test(ip || '') ? ip.split('.').slice(0, 3).join('.') : String(ip || '').split(':').slice(0, 4).join(':'));
function loginAlert(user, req) {
  const device = uaFamily(req.get('user-agent'));
  const key = sha256(`${device}|${netOf(req.ip)}`);
  const known = get('SELECT 1 FROM login_history WHERE user_id = ? AND device_key = ? AND at > ?', user.id, key, Date.now() - 90 * 86_400_000);
  const first = !get('SELECT 1 FROM login_history WHERE user_id = ?', user.id);
  run('INSERT INTO login_history (user_id, device_key, ip, user_agent, at) VALUES (?,?,?,?,?)', user.id, key, req.ip, String(req.get('user-agent') || '').slice(0, 300), Date.now());
  run('DELETE FROM login_history WHERE user_id = ? AND at < ?', user.id, Date.now() - 180 * 86_400_000);
  if (known || first) return; // o primeiro acesso da conta não gera aviso
  const brand = brandOf(user);
  const { html, text } = renderEmail({ brand, title: 'Novo acesso à sua conta',
    intro: `Olá, ${user.name}. Sua conta foi acessada de um aparelho ou rede que não usava antes. Se foi você, não precisa fazer nada.`,
    rows: [['Quando', new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })], ['Aparelho', device], ['IP', String(req.ip || '')]],
    button: { label: 'Ver acessos e encerrar sessões', url: `${publicUrl}/admin/#/conta` },
    footer: 'Não reconhece? Troque a senha agora em Minha conta (isso encerra todas as sessões) e avise o administrador.' });
  queueEmail({ to: user.email, subject: `${brand.companyName}: novo acesso à sua conta`, text, html, kind: 'login_alert', companyId: user.company_id ?? null });
}

// Etapa 1: e-mail e senha.
router.post('/login', loginLimiter, (req, res) => {
  const mail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
  const password = typeof req.body?.password === 'string' ? req.body.password.slice(0, 200) : '';
  const user = get('SELECT * FROM users WHERE email = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', mail);
  const ok = verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
  const generic = new HttpError(401, 'E-mail ou senha inválidos.');
  if (!user || !user.active) { audit(null, 'login.failed', { email: mail }, req.ip); throw generic; }
  if (companyBlocked(user)) { audit(user.id, 'login.company_canceled', null, req.ip, user); throw new HttpError(403, 'O acesso desta empresa foi cancelado.'); }
  if (user.locked_until && user.locked_until > Date.now()) {
    audit(user.id, 'login.locked', null, req.ip);
    throw new HttpError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente em 15 minutos.');
  }
  if (!ok) { registerFailure(user, req, 'login.failed'); throw generic; }
  if (user.totp_enabled) {
    // Senha correta, mas falta o código do app autenticador: devolve um desafio de uso único (5 min).
    const challenge = randomToken(32);
    run('DELETE FROM mfa_challenges WHERE user_id = ? OR created_at < ?', user.id, Date.now() - CHALLENGE_TTL);
    // Se o usuário tem chave de acesso (passkey), oferece também esse caminho (mais rápido e à prova de phishing).
    const creds = all('SELECT credential_id FROM webauthn_credentials WHERE user_id = ?', user.id);
    const waChallenge = creds.length ? wa.newChallenge() : null;
    run('INSERT INTO mfa_challenges (token_hash, user_id, created_at, wa_challenge) VALUES (?,?,?,?)', sha256(challenge), user.id, Date.now(), waChallenge);
    return res.json({ mfaRequired: true, challenge,
      webauthn: waChallenge ? { challenge: waChallenge, rpId: wa.relyingParty().rpId, timeout: 120000, userVerification: 'required',
        allowCredentials: creds.map((c) => ({ type: 'public-key', id: c.credential_id })) } : null });
  }
  res.json(finishLogin(res, req, user));
});

// Etapa 2: código do autenticador (6 dígitos) ou código de recuperação.
router.post('/login/mfa', loginLimiter, mfaLimiter, (req, res) => {
  const challenge = typeof req.body?.challenge === 'string' ? req.body.challenge : '';
  const code = typeof req.body?.code === 'string' ? req.body.code.trim() : '';
  const c = challenge.length <= 100 ? get('SELECT * FROM mfa_challenges WHERE token_hash = ?', sha256(challenge)) : null;
  const expired = new HttpError(401, 'Sessão de login expirada. Entre novamente com e-mail e senha.');
  if (!c || c.created_at < Date.now() - CHALLENGE_TTL || c.attempts >= 5) { if (c) run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash); throw expired; }
  const user = get('SELECT * FROM users WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', c.user_id);
  if (!user || !user.active || !user.totp_enabled || companyBlocked(user)) throw expired;
  if (user.locked_until && user.locked_until > Date.now()) throw new HttpError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente em 15 minutos.');

  let valid = false;
  const step = totp.verify(decrypt(user.totp_secret_enc) || '', code, user.totp_last_step);
  if (step !== null) {
    run('UPDATE users SET totp_last_step = ? WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', step, user.id);
    valid = true;
  } else {
    const norm = totp.normalizeRecovery(code);
    if (norm.length === 10) {
      const hashes = lookupAll('rc:' + norm); // durante a rotação da chave mestra, aceita também o código gravado com a anterior
      const r = run(`UPDATE mfa_recovery_codes SET used_at = ? WHERE rowid = (SELECT rowid FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL AND code_hash IN (${hashes.map(() => '?').join(',')}) LIMIT 1)`, Date.now(), user.id, ...hashes);
      if (r.changes === 1) { valid = true; audit(user.id, 'mfa.recovery_code_used', null, req.ip); }
    }
  }
  if (!valid) {
    run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', c.token_hash);
    registerFailure(user, req, 'login.mfa_failed');
    throw new HttpError(401, 'Código inválido.');
  }
  run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash);
  res.json(finishLogin(res, req, user));
});

// Etapa 2 com chave de acesso (passkey) no lugar do código de 6 dígitos.
router.post('/login/webauthn', loginLimiter, mfaLimiter, (req, res) => {
  const challenge = typeof req.body?.challenge === 'string' ? req.body.challenge : '';
  const c = challenge.length <= 100 ? get('SELECT * FROM mfa_challenges WHERE token_hash = ?', sha256(challenge)) : null;
  const expired = new HttpError(401, 'Sessão de login expirada. Entre novamente com e-mail e senha.');
  if (!c || !c.wa_challenge || c.created_at < Date.now() - CHALLENGE_TTL || c.attempts >= 5) { if (c) run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash); throw expired; }
  const user = get('SELECT * FROM users WHERE id = ? /* tenant-ok: login */', c.user_id);
  if (!user || !user.active || !user.totp_enabled || companyBlocked(user)) throw expired;
  if (user.locked_until && user.locked_until > Date.now()) throw new HttpError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente em 15 minutos.');
  const cred = req.body?.credential;
  const stored = typeof cred?.id === 'string' ? get('SELECT * FROM webauthn_credentials WHERE credential_id = ? AND user_id = ?', cred.id, user.id) : null;
  try {
    if (!stored) throw new Error('Chave de acesso não cadastrada nesta conta.');
    const r = wa.verifyAssertion(cred, stored, { challenge: c.wa_challenge, ...wa.relyingParty() });
    run('UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ? WHERE id = ?', r.signCount, Date.now(), stored.id);
  } catch (e) {
    run('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?', c.token_hash);
    registerFailure(user, req, 'login.webauthn_failed');
    throw new HttpError(401, e.message);
  }
  run('DELETE FROM mfa_challenges WHERE token_hash = ?', c.token_hash);
  res.json(finishLogin(res, req, user));
});

// ---------------------------------------------------------------- recuperação de senha
// Resposta sempre igual (não revela se o e-mail existe). O link usa PUBLIC_URL — nunca o Host da requisição.
router.post('/password/forgot', forgotLimiter, forgotPerEmail, (req, res) => {
  const mail = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';
  const user = mail ? get('SELECT * FROM users WHERE email = ? AND active = 1 /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', mail) : null;
  if (user && !companyBlocked(user)) {
    const token = randomToken(32);
    run('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?', user.id, Date.now());
    run('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', sha256(token), user.id, Date.now(), Date.now() + RESET_TTL);
    const s = brandOf(user);
    const { html, text } = renderEmail({
      brand: s, title: 'Redefinição de senha',
      intro: `Olá, ${user.name}. Recebemos um pedido para redefinir sua senha do painel. O link vale por 30 minutos e só pode ser usado uma vez. Se não foi você, ignore este e-mail — sua senha continua a mesma.`,
      button: { label: 'Criar nova senha', url: `${publicUrl}/admin/#/redefinir/${token}` },
      footer: `Pedido feito a partir do IP ${req.ip}.`,
    });
    queueEmail({ to: user.email, subject: `${s.companyName}: redefinição de senha`, text, html, kind: 'password_reset', companyId: user.company_id });
    audit(user.id, 'password.reset_requested', null, req.ip);
  } else {
    audit(null, 'password.reset_unknown', { email: mail.slice(0, 80) }, req.ip);
  }
  res.json({ ok: true, message: 'Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.' });
});

router.post('/password/reset', forgotLimiter, (req, res) => {
  const token = typeof req.body?.token === 'string' && req.body.token.length <= 100 ? req.body.token : '';
  const err = passwordPolicyError(req.body?.password);
  if (err) throw bad(err);
  const r = token ? get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(token)) : null;
  if (!r || r.used_at || r.expires_at < Date.now()) throw new HttpError(400, 'Link inválido ou expirado. Solicite um novo.');
  tx(() => {
    run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', Date.now(), r.token_hash);
    run('DELETE FROM password_resets WHERE user_id = ? AND token_hash <> ?', r.user_id, r.token_hash);
    run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', hashPassword(req.body.password), r.user_id);
  });
  destroyUserSessions(r.user_id);
  audit(r.user_id, r.kind === 'invite' ? 'invite.accepted' : 'password.reset_done', null, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- 2FA do próprio usuário (exige login)
// Configurar ou trocar o 2FA exige a senha atual (protege contra sessão esquecida aberta).
function verifyCurrentUser(req) {
  const u = get('SELECT * FROM users WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', req.user.id);
  if (!verifyPassword(String(req.body?.password || '').slice(0, 200), u.password_hash)) {
    registerFailure(u, req, 'mfa.bad_password');
    throw bad('Senha atual incorreta.');
  }
  return withoutHash(u);
}
// Dados da conta já conferida, sem o resumo da senha (nada adiante precisa dele).
const withoutHash = ({ password_hash: _hash, ...rest }) => rest;

router.get('/mfa', requireUser, (req, res) => {
  const u = get('SELECT totp_enabled FROM users WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', req.user.id);
  const left = get('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL', req.user.id).n;
  res.json({ enabled: !!u.totp_enabled, required: mfaRequiredFor({ role: req.user.role, company_id: get('SELECT company_id FROM users WHERE id = ?', req.user.id).company_id }), recoveryCodesLeft: left });
});

router.post('/mfa/setup', requireUser, mfaLimiter, async (req, res) => {
  const u = verifyCurrentUser(req);
  if (u.totp_enabled) throw new HttpError(409, 'O 2FA já está ativo. Desative antes de configurar um novo aparelho.');
  const secret = totp.generateSecret();
  run('UPDATE users SET totp_secret_enc = ?, totp_last_step = NULL WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', encrypt(secret), u.id);
  const url = totp.otpauthUrl(secret, u.email, brandOf(u).companyName);
  res.json({ secret, otpauthUrl: url, qr: await totp.qrDataUrl(url) });
});

function issueRecoveryCodes(userId) {
  const codes = totp.recoveryCodes();
  run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
  for (const c of codes) run('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES (?,?)', userId, lookup('rc:' + totp.normalizeRecovery(c)));
  return codes;
}

router.post('/mfa/enable', requireUser, mfaLimiter, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', req.user.id);
  if (u.totp_enabled) throw new HttpError(409, 'O 2FA já está ativo.');
  const secret = decrypt(u.totp_secret_enc);
  if (!secret) throw bad('Comece a configuração novamente.');
  const step = totp.verify(secret, String(req.body?.code || '').trim(), null);
  if (step === null) throw bad('Código inválido. Confira o horário do celular e tente de novo.');
  const codes = tx(() => {
    run('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', step, u.id);
    return issueRecoveryCodes(u.id);
  });
  // Derruba as outras sessões e libera a atual.
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', u.id, req.user.sessionHash);
  run('UPDATE sessions SET mfa_setup_required = 0 WHERE token_hash = ?', req.user.sessionHash);
  audit(u.id, 'mfa.enabled', null, req.ip);
  res.json({ ok: true, recoveryCodes: codes });
});

router.post('/mfa/recovery-codes', requireUser, mfaLimiter, (req, res) => {
  const u = verifyCurrentUser(req);
  if (!u.totp_enabled) throw bad('Ative o 2FA primeiro.');
  const codes = issueRecoveryCodes(u.id);
  audit(u.id, 'mfa.recovery_regenerated', null, req.ip);
  res.json({ recoveryCodes: codes });
});

router.post('/mfa/disable', requireUser, mfaLimiter, (req, res) => {
  const u = verifyCurrentUser(req);
  if (mfaRequiredFor(u)) throw new HttpError(403, u.role === 'master' ? 'O 2FA é obrigatório para o Master.' : 'O 2FA é obrigatório para administradores nesta empresa.');
  const step = totp.verify(decrypt(u.totp_secret_enc) || '', String(req.body?.code || '').trim(), u.totp_last_step);
  if (step === null) throw bad('Código inválido.');
  tx(() => {
    run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', u.id);
    run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', u.id);
    run('DELETE FROM webauthn_credentials WHERE user_id = ?', u.id);
  });
  audit(u.id, 'mfa.disabled', null, req.ip);
  res.json({ ok: true });
});

// Confirmação de ação sensível (cancelar/excluir empresa, etc.): senha atual e, se o 2FA estiver ativo, o código do aplicativo.
// Erros contam para o bloqueio da conta, como no login.
function confirmSensitive(req) {
  const u = get('SELECT * FROM users WHERE id = ? /* tenant-ok: conta do próprio usuário */', req.user.id);
  if (u.locked_until && u.locked_until > Date.now()) throw new HttpError(423, 'Conta temporariamente bloqueada por excesso de tentativas. Tente em 15 minutos.');
  if (!verifyPassword(String(req.body?.password || '').slice(0, 200), u.password_hash)) {
    registerFailure(u, req, 'confirm.bad_password');
    throw new HttpError(403, 'Senha incorreta. Confirme com a sua senha para continuar.');
  }
  if (u.totp_enabled) {
    const step = totp.verify(decrypt(u.totp_secret_enc) || '', String(req.body?.code || '').trim(), u.totp_last_step);
    if (step === null) { registerFailure(u, req, 'confirm.bad_code'); throw new HttpError(403, 'Código do aplicativo autenticador inválido.'); }
    run('UPDATE users SET totp_last_step = ? WHERE id = ? /* tenant-ok: conta do próprio usuário */', step, u.id);
  }
  run('UPDATE users SET failed_logins = 0 WHERE id = ? /* tenant-ok: conta do próprio usuário */', u.id);
  return withoutHash(u);
}

// ---------------------------------------------------------------- chaves de acesso (passkeys) do próprio usuário
// Complementam o 2FA (exigem o aplicativo autenticador já ativo, que continua como reserva).
router.get('/webauthn', requireUser, (req, res) => {
  res.json(all('SELECT id, name, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at', req.user.id));
});
router.post('/webauthn/register/options', requireUser, mfaLimiter, (req, res) => {
  const u = confirmSensitive(req);
  if (!u.totp_enabled) throw bad('Ative primeiro a verificação em duas etapas pelo aplicativo; a chave de acesso é um jeito mais rápido de confirmar.');
  if (get('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?', u.id).n >= 10) throw bad('Limite de 10 chaves por conta.');
  const challenge = wa.newChallenge();
  run('INSERT INTO webauthn_challenges (user_id, challenge, created_at) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET challenge = excluded.challenge, created_at = excluded.created_at', u.id, challenge, Date.now());
  const rp = wa.relyingParty();
  res.json({ challenge, rp: { id: rp.rpId, name: brandOf(u).companyName }, user: { id: wa.b64u(Buffer.from(`u${u.id}`)), name: u.email, displayName: u.name },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], timeout: 120000, attestation: 'none',
    authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
    excludeCredentials: all('SELECT credential_id FROM webauthn_credentials WHERE user_id = ?', u.id).map((c) => ({ type: 'public-key', id: c.credential_id })) });
});
router.post('/webauthn/register', requireUser, mfaLimiter, (req, res) => {
  const ch = get('SELECT * FROM webauthn_challenges WHERE user_id = ?', req.user.id);
  run('DELETE FROM webauthn_challenges WHERE user_id = ?', req.user.id); // uso único
  if (!ch || ch.created_at < Date.now() - 5 * 60_000) throw bad('O cadastro expirou. Comece de novo.');
  const name = String(req.body?.name || 'Chave de acesso').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) || 'Chave de acesso';
  let r;
  try { r = wa.verifyRegistration(req.body?.credential, { challenge: ch.challenge, ...wa.relyingParty() }); } catch (e) { throw bad(e.message); }
  if (get('SELECT 1 FROM webauthn_credentials WHERE credential_id = ?', r.credentialId)) throw new HttpError(409, 'Esta chave já está cadastrada.');
  run('INSERT INTO webauthn_credentials (user_id, credential_id, public_key_jwk, alg, sign_count, name, created_at) VALUES (?,?,?,?,?,?,?)',
    req.user.id, r.credentialId, JSON.stringify(r.jwk), r.alg, r.signCount, name, Date.now());
  audit(req.user.id, 'webauthn.added', { name }, req.ip);
  res.status(201).json({ ok: true });
});
router.delete('/webauthn/:id', requireUser, mfaLimiter, (req, res) => {
  confirmSensitive(req);
  const r = run('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?', Number(req.params.id) || 0, req.user.id);
  if (!r.changes) throw new HttpError(404, 'Chave não encontrada.');
  audit(req.user.id, 'webauthn.removed', null, req.ip);
  res.json({ ok: true });
});

module.exports = router;
module.exports.confirmSensitive = confirmSensitive;
module.exports.resetUserMfa = (userId) => tx(() => {
  run('DELETE FROM webauthn_credentials WHERE user_id = ?', userId);
  run('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ? /* tenant-ok: login/2FA: conta do próprio usuário (e-mail é único na plataforma) */', userId);
  run('DELETE FROM mfa_recovery_codes WHERE user_id = ?', userId);
  destroyUserSessions(userId);
});
