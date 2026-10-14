'use strict';
// Abre um backup criptografado (.db.enc) para restaurar.
// Uso: BACKUP_PASSPHRASE="..." node scripts/restore-backup.js /backups/pesquisa-AAAAMMDD-HHMMSS.db.enc /caminho/pesquisa.db
// Depois: pare o sistema, troque o arquivo do banco pelo restaurado e suba de novo (o APP_SECRET tem de ser o mesmo).
const fs = require('node:fs');
const [src, dst] = process.argv.slice(2);
if (!src || !dst || !process.env.BACKUP_PASSPHRASE) { console.error('Uso: BACKUP_PASSPHRASE="..." node scripts/restore-backup.js arquivo.db.enc destino.db'); process.exit(1); }
if (fs.existsSync(dst)) { console.error('O destino já existe; escolha outro nome para não sobrescrever.'); process.exit(1); }
const { decryptFile } = require('./backup');
try { decryptFile(src, process.env.BACKUP_PASSPHRASE, dst); console.log('Backup aberto em', dst); } catch (e) { console.error('Falhou (frase errada ou arquivo corrompido):', e.message); process.exit(1); }
