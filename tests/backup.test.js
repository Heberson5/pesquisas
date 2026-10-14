'use strict';
// Backup: banco criptografado com a frase, mídias de todas as empresas copiadas, restauração só com a frase certa.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pesquisa-bkp-'));
const env = { ...process.env, DB_FILE: path.join(dir, 'b.db'), DATA_DIR: dir, MEDIA_DIR: path.join(dir, 'media'), BACKUP_DIR: path.join(dir, 'backups'), NODE_ENV: 'test',
  APP_SECRET: 'segredo-do-teste-de-backup-com-mais-de-32-caracteres' };
const run = (args, extra = {}) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8' });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('backup criptografado inclui as mídias das empresas e só abre com a frase certa', () => {
  run(['-e', "require('./src/db').run(\"INSERT INTO settings (key, value) VALUES ('marcador', '\\\"DADO-SECRETO-123\\\"')\")"]);
  fs.mkdirSync(path.join(dir, 'media', '7'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'media', '7', 'a'.repeat(32)), 'logo-da-empresa-7');
  const out = run(['scripts/backup.js'], { BACKUP_PASSPHRASE: 'frase-de-backup-bem-longa' });
  assert.match(out, /criptografado, 1 mídia/);
  const enc = fs.readdirSync(path.join(dir, 'backups')).find((f) => f.endsWith('.db.enc'));
  assert.ok(enc, 'arquivo .db.enc criado');
  assert.ok(!fs.readdirSync(path.join(dir, 'backups')).some((f) => f.endsWith('.db')), 'não sobra cópia aberta');
  const raw = fs.readFileSync(path.join(dir, 'backups', enc));
  assert.ok(!raw.includes('DADO-SECRETO-123') && !raw.includes('SQLite format'), 'conteúdo ilegível');
  assert.equal(fs.readFileSync(path.join(dir, 'backups', 'media', '7', 'a'.repeat(32)), 'utf8'), 'logo-da-empresa-7');
  assert.throws(() => run(['scripts/restore-backup.js', path.join(dir, 'backups', enc), path.join(dir, 'x.db')], { BACKUP_PASSPHRASE: 'frase-errada-bem-longa-xx' }));
  run(['scripts/restore-backup.js', path.join(dir, 'backups', enc), path.join(dir, 'restaurado.db')], { BACKUP_PASSPHRASE: 'frase-de-backup-bem-longa' });
  assert.ok(fs.readFileSync(path.join(dir, 'restaurado.db')).includes('DADO-SECRETO-123'));
});
