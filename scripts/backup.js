'use strict';
// Backup do banco (cópia consistente com VACUUM INTO, sem parar o sistema) e das mídias.
// Uso: node scripts/backup.js          → faz um backup agora
//      node scripts/backup.js --loop   → backup diário às 03:00 (horário da empresa)
// Guarda BACKUP_KEEP_DAYS dias (padrão 14). Destino: BACKUP_DIR (padrão /backups).
// Com BACKUP_PASSPHRASE definido, o banco sai CRIPTOGRAFADO (AES-256-GCM, chave derivada da frase com scrypt):
// pode ir para fora do servidor (nuvem, outro disco) sem expor os dados. Restaurar: scripts/restore-backup.js.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, MEDIA_DIR } = require('../src/db');
const { localNow } = require('../src/time');

const DIR = process.env.BACKUP_DIR || '/backups';
const KEEP_DAYS = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS || 14));

function backupOnce() {
  fs.mkdirSync(path.join(DIR, 'media'), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const file = path.join(DIR, `pesquisa-${stamp}.db`);
  if (!/^[\w/.-]+$/.test(file)) throw new Error('Caminho de backup inválido.');
  db.exec(`VACUUM INTO '${file}'`);
  fs.chmodSync(file, 0o600);
  let out = file;
  if (process.env.BACKUP_PASSPHRASE) { out = encryptFile(file, process.env.BACKUP_PASSPHRASE); fs.rmSync(file); }
  // Mídias são imutáveis (nome = id aleatório): copia só as novas — inclusive as pastas de cada empresa (media/<empresa>/<id>).
  let copied = 0;
  const copyDir = (src, dst) => {
    if (!fs.existsSync(src)) return;
    for (const name of fs.readdirSync(src)) {
      const from = path.join(src, name);
      if (/^\d+$/.test(name) && fs.statSync(from).isDirectory()) { fs.mkdirSync(path.join(dst, name), { recursive: true, mode: 0o700 }); copyDir(from, path.join(dst, name)); continue; }
      if (!/^[a-f0-9]{32}$/.test(name)) continue;
      const dest = path.join(dst, name);
      if (!fs.existsSync(dest)) { fs.copyFileSync(from, dest); copied++; }
    }
  };
  copyDir(MEDIA_DIR, path.join(DIR, 'media'));
  // Retenção
  const limit = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of fs.readdirSync(DIR)) {
    if (/^pesquisa-\d{8}-\d{6}\.db(\.enc)?$/.test(name) && fs.statSync(path.join(DIR, name)).mtimeMs < limit) fs.rmSync(path.join(DIR, name));
  }
  console.log(new Date().toISOString(), `backup ok: ${path.basename(out)} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)${out !== file ? ' criptografado' : ''}, ${copied} mídia(s) nova(s)`);
  return out;
}

// Formato: "PSQBK1" + sal(16) + iv(12) + dados + etiqueta(16). Frase mínima de 16 caracteres.
function keyFrom(passphrase, salt) {
  if (String(passphrase).length < 16) throw new Error('BACKUP_PASSPHRASE precisa ter pelo menos 16 caracteres.');
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function encryptFile(file, passphrase) {
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  const data = Buffer.concat([c.update(fs.readFileSync(file)), c.final()]);
  const out = file + '.enc';
  fs.writeFileSync(out, Buffer.concat([Buffer.from('PSQBK1'), salt, iv, data, c.getAuthTag()]), { mode: 0o600 });
  return out;
}
function decryptFile(file, passphrase, out) {
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 6).toString() !== 'PSQBK1') throw new Error('Arquivo não é um backup criptografado deste sistema.');
  const salt = buf.subarray(6, 22); const iv = buf.subarray(22, 34); const tag = buf.subarray(buf.length - 16);
  const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv);
  d.setAuthTag(tag);
  fs.writeFileSync(out, Buffer.concat([d.update(buf.subarray(34, buf.length - 16)), d.final()]), { mode: 0o600 });
}

async function loop() {
  let lastDay = null;
  for (;;) {
    const n = localNow();
    if (n.hour === 3 && lastDay !== n.date) {
      try { backupOnce(); lastDay = n.date; } catch (e) { console.error(new Date().toISOString(), 'FALHA NO BACKUP:', e.message); }
    }
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
}

module.exports = { backupOnce, encryptFile, decryptFile };
if (require.main === module) { if (process.argv.includes('--loop')) { backupOnce(); loop(); } else backupOnce(); }
