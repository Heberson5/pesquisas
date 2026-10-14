'use strict';
// Migração: um banco da versão de empresa única vira a "empresa nº 1", sem perder nada,
// com os contatos regravados na chave da empresa e as configurações copiadas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pesquisa-mig-'));
const env = (extra = {}) => ({ ...process.env, DB_FILE: path.join(dir, 'old.db'), MEDIA_DIR: path.join(dir, 'media'), DATA_DIR: dir,
  NODE_ENV: 'test', DISABLE_JOBS: 'true', APP_SECRET: 'segredo-de-teste-da-migracao-com-mais-de-32-caracteres', ...extra });
const node = (code, extra) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', code], { cwd: ROOT, env: env(extra), encoding: 'utf8' });

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('banco de empresa única migra para a empresa nº 1 sem perder dados', () => {
  // 1) Banco "antigo": esquema anterior, sem empresas.
  node(`
    const { run } = require('./src/db');
    const { encrypt, lookup } = require('./src/vault');
    const now = Date.now();
    run("INSERT INTO settings (key, value) VALUES ('companyName', ?)", JSON.stringify('Rede Antiga'));
    run("INSERT INTO settings (key, value) VALUES ('primaryColor', ?)", JSON.stringify('#112233'));
    run("INSERT INTO settings (key, value) VALUES ('delivery', ?)", JSON.stringify({ smtp: null }));
    run("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Adm', 'adm@antiga.local', 'x', 'admin', ?)", now);
    run("INSERT INTO users (name, email, password_hash, role, created_at) VALUES ('Ges', 'ges@antiga.local', 'x', 'gestor', ?)", now);
    run("INSERT INTO branches (code, name, created_at) VALUES ('L1', 'Loja 1', ?)", now);
    run('INSERT INTO user_branches (user_id, branch_id) VALUES (2, 1)');
    run("INSERT INTO surveys (title, welcome_title, thanks_title, created_at, updated_at) VALUES ('Pesquisa', 'Oi', 'Ok', ?, ?)", now, now);
    run("INSERT INTO responses (uuid, branch_id, survey_id, submitted_at, received_at, contact_phone_enc, contact_phone_lookup, contact_consent_at) VALUES ('u1', 1, 1, ?, ?, ?, ?, ?)",
      now, now, encrypt('5511999990000'), lookup('phone:5511999990000'), now);
    run("INSERT INTO audit_log (at, action) VALUES (?, 'login.ok')", now);
  `, { PESQUISA_SKIP_MIGRATIONS: '1' });

  // 2) Sobe a versão nova: a migração roda sozinha.
  const out = JSON.parse(node(`
    const { get, all } = require('./src/db');
    const { decryptFor, lookupFor } = require('./src/companies');
    const c = get('SELECT * FROM companies');
    const r = get('SELECT * FROM responses');
    console.log(JSON.stringify({
      company: c, version: get('SELECT MAX(version) AS v FROM schema_migrations').v,
      users: all('SELECT email, role, company_id FROM users ORDER BY id'),
      branch: get('SELECT company_id, code FROM branches'), survey: get('SELECT company_id FROM surveys'),
      response: { company_id: r.company_id, enc: r.contact_phone_enc, phone: decryptFor(c.id, r.contact_phone_enc), lookupOk: r.contact_phone_lookup === lookupFor(c.id, 'phone:5511999990000') },
      settings: all('SELECT key, value FROM company_settings WHERE company_id = ? ORDER BY key', c.id),
      platformDelivery: !!get("SELECT 1 FROM platform_settings WHERE key = 'delivery'"),
      audit: get('SELECT company_id FROM audit_log'),
      links: all('SELECT * FROM user_branches'),
    }));
  `));
  assert.equal(out.version, require('../src/migrations').MIGRATIONS.at(-1).version);
  assert.equal(out.company.id, 1); assert.equal(out.company.name, 'Rede Antiga'); assert.equal(out.company.slug, 'rede-antiga'); assert.equal(out.company.status, 'active');
  assert.deepEqual(out.users, [{ email: 'adm@antiga.local', role: 'admin', company_id: 1 }, { email: 'ges@antiga.local', role: 'gestor', company_id: 1 }]);
  assert.equal(out.branch.company_id, 1); assert.equal(out.survey.company_id, 1);
  assert.equal(out.response.company_id, 1);
  assert.match(out.response.enc, /^c1\.1\./); assert.equal(out.response.phone, '5511999990000'); assert.ok(out.response.lookupOk);
  assert.deepEqual(out.settings.map((s) => s.key), ['companyName', 'primaryColor']);
  assert.ok(out.platformDelivery, 'e-mail/WhatsApp atual vira o padrão da plataforma');
  assert.equal(out.audit.company_id, 1);
  assert.deepEqual(out.links, [{ user_id: 2, branch_id: 1 }]);

  // 3) Subir de novo não repete a migração.
  const again = node("const { get } = require('./src/db'); console.log(get('SELECT COUNT(*) AS n FROM companies').n)");
  assert.equal(again.trim(), '1');
});

test('banco novo (vazio) não cria empresa sozinho', () => {
  fs.rmSync(path.join(dir, 'novo.db'), { force: true });
  const n = node("const { get } = require('./src/db'); console.log(get('SELECT COUNT(*) AS n FROM companies').n)", { DB_FILE: path.join(dir, 'novo.db') });
  assert.equal(n.trim(), '0');
});
