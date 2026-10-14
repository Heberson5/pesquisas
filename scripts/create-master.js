'use strict';
// Cria (ou redefine a senha de) um usuário MASTER — o dono da plataforma, que vê todas as empresas.
// Uso: npm run create-master -- voce@seudominio.com.br "Seu Nome"
const { get, run } = require('../src/db');
const { hashPassword } = require('../src/security');
const { askPassword, validEmail } = require('./_prompt');

const [email, name = 'Master'] = process.argv.slice(2);
if (!validEmail(email)) { console.error('Uso: npm run create-master -- email@dominio.com "Nome"'); process.exit(1); }

askPassword('MASTER_PASSWORD').then((password) => {
  const mail = email.toLowerCase();
  const existing = get('SELECT id, role FROM users WHERE email = ?', mail);
  if (existing && existing.role !== 'master') { console.error('Este e-mail já pertence a um usuário de empresa. Use outro e-mail para o Master.'); process.exit(1); }
  if (existing) {
    run('UPDATE users SET password_hash = ?, active = 1, failed_logins = 0, locked_until = NULL WHERE id = ?', hashPassword(password), existing.id);
    run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    console.log('Senha do Master redefinida.');
  } else {
    run("INSERT INTO users (company_id, name, email, password_hash, role, created_at) VALUES (NULL, ?, ?, ?, 'master', ?)", name, mail, hashPassword(password), Date.now());
    console.log('Master criado. No primeiro login será pedido o 2FA (aplicativo autenticador).');
  }
});
