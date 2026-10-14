'use strict';
// Rotação da chave mestra: com a antiga em APP_SECRET_PREVIOUS tudo continua legível; o script regrava com a nova
// e depois a antiga pode sair. Chave errada: nada é alterado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pesquisa-rot-'));
const OLD = 'chave-antiga-de-teste-com-mais-de-trinta-e-dois-caracteres';
const NEW = 'chave-NOVA-de-teste-com-mais-de-trinta-e-dois-caracteres!!';
const node = (code, env, args = []) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...(code ? ['-e', code] : args)],
  { cwd: ROOT, env: { ...process.env, DB_FILE: path.join(dir, 'r.db'), DATA_DIR: dir, MEDIA_DIR: path.join(dir, 'm'), NODE_ENV: 'test', ...env }, encoding: 'utf8' });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const READ = `
  const { get } = require('./src/db'); const v = require('./src/vault'); const { decryptFor, lookupFor } = require('./src/companies');
  const r = get('SELECT * FROM responses'); const u = get('SELECT totp_secret_enc FROM users'); const b = get('SELECT * FROM branches');
  const d = JSON.parse(get("SELECT value FROM company_settings WHERE key = 'delivery'").value);
  console.log(JSON.stringify({ phone: decryptFor(1, r.contact_phone_enc), lookOk: r.contact_phone_lookup === lookupFor(1, 'phone:11999990000'),
    totp: v.decrypt(u.totp_secret_enc), link: v.decrypt(b.public_token_enc), linkOk: b.public_token_hash === v.lookup('link:TOKENPUBLICO123'),
    smtp: decryptFor(1, d.smtp.passEnc), enc: r.contact_phone_enc }));`;

test('rotação: lê com a anterior, regrava com a nova, depois funciona só com a nova', () => {
  node(`
    const { run } = require('./src/db'); const v = require('./src/vault'); const { createCompany, encryptFor, lookupFor } = require('./src/companies');
    const c = createCompany({ name: 'Rotação' }); const now = Date.now();
    run("INSERT INTO users (company_id, name, email, password_hash, role, created_at, totp_secret_enc) VALUES (?, 'A', 'a@r.local', 'x', 'admin', ?, ?)", c, now, v.encrypt('SEGREDO2FA'));
    run("INSERT INTO branches (company_id, code, name, created_at, public_token_enc, public_token_hash) VALUES (?, 'R1', 'Loja', ?, ?, ?)", c, now, v.encrypt('TOKENPUBLICO123'), v.lookup('link:TOKENPUBLICO123'));
    run("INSERT INTO surveys (company_id, title, welcome_title, thanks_title, created_at, updated_at) VALUES (?, 'P', 'O', 'O', ?, ?)", c, now, now);
    run("INSERT INTO responses (company_id, uuid, branch_id, survey_id, submitted_at, received_at, contact_phone_enc, contact_phone_lookup, contact_consent_at) VALUES (?, 'u', 1, 1, ?, ?, ?, ?, ?)",
      c, now, now, encryptFor(c, '11999990000'), lookupFor(c, 'phone:11999990000'), now);
    run("INSERT INTO company_settings (company_id, key, value) VALUES (?, 'delivery', ?)", c, JSON.stringify({ smtp: { host: 'smtp.x.com', passEnc: encryptFor(c, 'SENHASMTP') } }));
  `, { APP_SECRET: OLD });
  const before = JSON.parse(node(READ, { APP_SECRET: OLD }));
  assert.equal(before.phone, '11999990000');
  // Só com a nova (sem a anterior) nada abre.
  assert.equal(JSON.parse(node(READ, { APP_SECRET: NEW })).phone, null);
  // Com a anterior configurada, tudo continua legível antes de rodar o script.
  const during = JSON.parse(node(READ, { APP_SECRET: NEW, APP_SECRET_PREVIOUS: OLD }));
  assert.equal(during.phone, '11999990000'); assert.equal(during.totp, 'SEGREDO2FA'); assert.equal(during.smtp, 'SENHASMTP');
  // Chave anterior errada: o script recusa e não altera nada.
  assert.throws(() => node(null, { APP_SECRET: NEW, APP_SECRET_PREVIOUS: 'outra-chave-errada-com-mais-de-trinta-e-dois-caracteres' }, ['scripts/rotate-secret.js']));
  assert.equal(JSON.parse(node(READ, { APP_SECRET: OLD })).enc, before.enc, 'nada mudou');
  const out = node(null, { APP_SECRET: NEW, APP_SECRET_PREVIOUS: OLD }, ['scripts/rotate-secret.js']);
  assert.match(out, /Rotação concluída/);
  const after = JSON.parse(node(READ, { APP_SECRET: NEW }));
  assert.deepEqual([after.phone, after.lookOk, after.totp, after.link, after.linkOk, after.smtp], ['11999990000', true, 'SEGREDO2FA', 'TOKENPUBLICO123', true, 'SENHASMTP']);
  assert.notEqual(after.enc, before.enc);
  assert.equal(JSON.parse(node(READ, { APP_SECRET: OLD })).phone, null, 'a chave antiga não abre mais nada');
});
