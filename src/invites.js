'use strict';
// Convite de usuário: em vez de alguém definir a senha por ele, o próprio usuário recebe um link
// (válido por 7 dias, uso único) para criar a senha. Usa a mesma tabela e a mesma tela da redefinição de senha.
const { get, run } = require('./db');
const { randomToken, sha256 } = require('./security');
const { queueEmail, renderEmail } = require('./notify');
const { getSettings, platformBranding } = require('./settings');
const { publicUrl } = require('./config');

const INVITE_TTL = 7 * 86_400_000;

function sendInvite(userId, { invitedBy = null } = {}) {
  const u = get('SELECT id, name, email, role, company_id FROM users WHERE id = ? /* tenant-ok: usuário já validado pelo chamador */', userId);
  if (!u) throw new Error('Usuário inexistente.');
  const token = randomToken(32);
  const now = Date.now();
  run('DELETE FROM password_resets WHERE user_id = ?', u.id);
  run("INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, kind) VALUES (?,?,?,?, 'invite')", sha256(token), u.id, now, now + INVITE_TTL);
  const brand = u.company_id ? getSettings(u.company_id) : platformBranding();
  const company = u.company_id ? get('SELECT name FROM companies WHERE id = ?', u.company_id)?.name : null;
  const ROLE = { master: 'Master da plataforma', admin: 'Administrador', gestor: 'Gestor de unidade' };
  const { html, text } = renderEmail({
    brand, title: 'Seu acesso ao painel de pesquisa de satisfação',
    intro: `Olá, ${u.name}. ${invitedBy ? invitedBy + ' criou' : 'Foi criado'} um acesso para você${company ? ` na empresa ${company}` : ''}. Clique no botão para criar a sua senha. O link vale por 7 dias e só pode ser usado uma vez.`,
    rows: [['E-mail de acesso', u.email], ['Perfil', ROLE[u.role] || u.role]],
    button: { label: 'Criar minha senha', url: `${publicUrl}/admin/#/redefinir/${token}` },
    footer: 'Se você não esperava este convite, ignore este e-mail.',
  });
  queueEmail({ to: u.email, subject: `${brand.companyName}: seu acesso ao painel`, text, html, kind: 'invite', companyId: u.company_id });
  return { expiresAt: now + INVITE_TTL };
}

module.exports = { sendInvite, INVITE_TTL };
