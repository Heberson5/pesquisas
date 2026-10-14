'use strict';
// Arquivos enviados (logos, ícones, imagens e vídeos de agradecimento): uma pasta por empresa,
// nome aleatório de 128 bits e tipo validado pelo conteúdo (nunca pela extensão).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { get, run, MEDIA_DIR } = require('./db');

fs.mkdirSync(MEDIA_DIR, { recursive: true });
const MEDIA_MAX = 25 * 1024 * 1024;

function mediaDirFor(companyId) {
  if (!Number.isInteger(companyId) || companyId < 1) throw new Error('Empresa inválida.');
  const dir = path.join(MEDIA_DIR, String(companyId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Caminho do arquivo de uma mídia. Arquivos de antes da versão multiempresa ficaram na pasta raiz.
function mediaPath(row) {
  const own = path.join(MEDIA_DIR, String(row.company_id), row.id);
  if (fs.existsSync(own)) return own;
  const legacy = path.join(MEDIA_DIR, row.id);
  return fs.existsSync(legacy) ? legacy : own;
}

// Valida pelo conteúdo (assinatura binária), não pela extensão nem pelo Content-Type do cliente.
function sniffMime(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'video/mp4';
  if (buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  return null; // SVG, HTML, PDF, executáveis etc. são recusados
}

function saveMedia(companyId, buf, mime, originalName) {
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(mediaDirFor(companyId), id), buf, { flag: 'wx', mode: 0o640 });
  run('INSERT INTO media (id, company_id, mime, size, original_name, created_at) VALUES (?,?,?,?,?,?)', id, companyId, mime, buf.length, originalName, Date.now());
  return id;
}

const mediaOf = (companyId, id) => (id ? get('SELECT id, company_id, mime FROM media WHERE id = ? AND company_id = ?', id, companyId) : null);

module.exports = { MEDIA_MAX, mediaDirFor, mediaPath, sniffMime, saveMedia, mediaOf };
