'use strict';
// Cria (ou redefine a senha de) um ADMINISTRADOR de uma empresa pelo terminal do servidor.
// Uso: npm run create-admin -- email@empresa.com "Nome Completo" --empresa endereco-curto-ou-numero
// Se só existir uma empresa, o --empresa pode ser omitido.
const { get, all, run } = require('../src/db');
const { hashPassword } = require('../src/security');
const { askPassword, validEmail } = require('./_prompt');

const args = process.argv.slice(2);
const i = args.indexOf('--empresa');
const ref = i >= 0 ? args[i + 1] : null;
const [email, name = 'Administrador'] = i >= 0 ? args.filter((_, k) => k !== i && k !== i + 1) : args;
if (!validEmail(email)) { console.error('Uso: npm run create-admin -- email@empresa.com "Nome" --empresa endereco-curto'); process.exit(1); }

let company = ref ? get('SELECT id, name FROM companies WHERE slug = ? OR id = ?', ref, Number(ref) || -1) : null;
if (!ref) {
  const list = all('SELECT id, name, slug FROM companies ORDER BY id');
  if (list.length === 1) company = list[0];
  else {
    console.error(list.length ? 'Informe a empresa com --empresa. Empresas: ' + list.map((c) => `${c.slug} (nº ${c.id})`).join(', ') : 'Nenhuma empresa cadastrada. Use antes: npm run create-company -- "Nome"');
    process.exit(1);
  }
}
if (!company) { console.error('Empresa não encontrada.'); process.exit(1); }

askPassword('ADMIN_PASSWORD').then((password) => {
  const mail = email.toLowerCase();
  const existing = get('SELECT id, company_id, role FROM users WHERE email = ?', mail);
  if (existing && (existing.role === 'master' || existing.company_id !== company.id)) { console.error('Este e-mail já está em uso em outra conta.'); process.exit(1); }
  if (existing) {
    run("UPDATE users SET password_hash = ?, role = 'admin', permissions = NULL, active = 1, failed_logins = 0, locked_until = NULL WHERE id = ?", hashPassword(password), existing.id);
    run('DELETE FROM sessions WHERE user_id = ?', existing.id);
    console.log(`Senha redefinida e usuário promovido a administrador de "${company.name}".`);
  } else {
    run("INSERT INTO users (company_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,'admin',?)", company.id, name, mail, hashPassword(password), Date.now());
    console.log(`Administrador de "${company.name}" criado.`);
  }
});
