'use strict';
// Corrente de resumos da auditoria. Cada empresa (e a plataforma) tem a sua: o registro guarda o resumo do
// anterior; se alguém editar ou apagar um registro do meio direto no banco, a verificação acusa onde quebrou.
// A retenção da LGPD apaga os registros MAIS ANTIGOS de uma empresa: a corrente continua íntegra a partir do primeiro que sobrou.
const crypto = require('node:crypto');

const auditHash = (prev, r) => crypto.createHash('sha256').update([prev || '', r.at, r.user_id ?? '', r.action, r.detail ?? '', r.ip ?? '',
  r.company_id ?? '', r.branch_id ?? '', r.as_master ? 1 : 0].join('␟')).digest('hex');

// Verifica uma corrente (company_id nulo = plataforma). Devolve { ok, rows, brokenAt }.
function verifyChain(all, companyId) {
  const rows = companyId === null
    ? all('SELECT * FROM audit_log WHERE company_id IS NULL ORDER BY id /* tenant-ok: verificação da auditoria */')
    : all('SELECT * FROM audit_log WHERE company_id = ? ORDER BY id', companyId);
  let prev = rows.length ? rows[0].prev_hash : null; // o primeiro que sobrou é a âncora
  for (const r of rows) {
    if (r.prev_hash !== prev || r.hash !== auditHash(r.prev_hash, r)) return { ok: false, rows: rows.length, brokenAt: r.id };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length, brokenAt: null };
}

module.exports = { auditHash, verifyChain };
