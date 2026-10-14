'use strict';
// Rotação da chave mestra (APP_SECRET), por exemplo se houver suspeita de vazamento.
// 1) Gere a nova:  openssl rand -base64 48
// 2) No .env: APP_SECRET=<nova>  e  APP_SECRET_PREVIOUS=<antiga>   (reinicie: tudo continua funcionando)
// 3) Faça backup e rode:  docker compose exec app node scripts/rotate-secret.js
//    Regrava com a chave nova: 2FA dos usuários, links/QR Codes, contatos de clientes, senhas de e-mail,
//    tokens de WhatsApp e do Mercado Pago. Se algo não abrir, NADA é alterado.
// 4) Os códigos de recuperação do 2FA não podem ser regravados (só existe o "resumo" deles): mantenha a
//    APP_SECRET_PREVIOUS até os usuários gerarem códigos novos, ou remova-a e peça para gerarem.
// 5) Atenção: a assinatura dos webhooks de cada empresa muda — avise quem integra por webhook.
const { all, run, tx } = require('../src/db');
const vault = require('../src/vault');
const { keysFor, encryptFor, decryptFor, lookupFor } = require('../src/companies');

if (!vault.rotating) { console.error('Defina APP_SECRET (nova) e APP_SECRET_PREVIOUS (antiga) antes de rodar.'); process.exit(1); }
const force = process.argv.includes('--force');
const failures = [];
const reopen = (blob, where, companyId = null) => {
  if (!blob) return null;
  const plain = companyId ? decryptFor(companyId, blob) : vault.decrypt(blob);
  if (plain === null) failures.push(where);
  return plain;
};
const count = {};
const inc = (k) => { count[k] = (count[k] || 0) + 1; };

tx(() => {
  for (const u of all('SELECT id, totp_secret_enc FROM users WHERE totp_secret_enc IS NOT NULL /* tenant-ok: rotação da chave de toda a plataforma */')) {
    const p = reopen(u.totp_secret_enc, `usuário ${u.id} (2FA)`);
    if (p !== null) { run('UPDATE users SET totp_secret_enc = ? WHERE id = ? /* tenant-ok: rotação */', vault.encrypt(p), u.id); inc('2FA'); }
  }
  for (const b of all('SELECT id, public_token_enc FROM branches WHERE public_token_enc IS NOT NULL /* tenant-ok: rotação */')) {
    const t = reopen(b.public_token_enc, `unidade ${b.id} (QR Code)`);
    if (t !== null) { run('UPDATE branches SET public_token_enc = ?, public_token_hash = ? WHERE id = ? /* tenant-ok: rotação */', vault.encrypt(t), vault.lookup('link:' + t), b.id); inc('QR Codes'); }
  }
  for (const c of all('SELECT id FROM companies')) {
    keysFor(c.id);
    for (const r of all('SELECT id, contact_name_enc, contact_phone_enc, contact_email_enc FROM responses WHERE company_id = ? AND (contact_name_enc IS NOT NULL OR contact_phone_enc IS NOT NULL OR contact_email_enc IS NOT NULL)', c.id)) {
      const n = reopen(r.contact_name_enc, `resposta ${r.id} (nome)`, c.id);
      const ph = reopen(r.contact_phone_enc, `resposta ${r.id} (telefone)`, c.id);
      const em = reopen(r.contact_email_enc, `resposta ${r.id} (e-mail)`, c.id);
      run('UPDATE responses SET contact_name_enc = ?, contact_phone_enc = ?, contact_email_enc = ?, contact_phone_lookup = ?, contact_email_lookup = ? WHERE id = ? AND company_id = ?',
        encryptFor(c.id, n), encryptFor(c.id, ph), encryptFor(c.id, em), ph ? lookupFor(c.id, 'phone:' + ph) : null, em ? lookupFor(c.id, 'email:' + em) : null, r.id, c.id);
      inc('contatos de clientes');
    }
    const row = all("SELECT value FROM company_settings WHERE company_id = ? AND key = 'delivery'", c.id)[0];
    if (row) {
      const d = JSON.parse(row.value);
      if (d.smtp?.passEnc) d.smtp.passEnc = encryptFor(c.id, reopen(d.smtp.passEnc, `empresa ${c.id} (senha do e-mail)`, c.id));
      if (d.whatsapp?.tokenEnc) d.whatsapp.tokenEnc = encryptFor(c.id, reopen(d.whatsapp.tokenEnc, `empresa ${c.id} (token do WhatsApp)`, c.id));
      run("UPDATE company_settings SET value = ? WHERE company_id = ? AND key = 'delivery'", JSON.stringify(d), c.id); inc('e-mail/WhatsApp das empresas');
    }
  }
  for (const key of ['delivery', 'billing']) {
    const row = all('SELECT value FROM platform_settings WHERE key = ?', key)[0];
    if (!row) continue;
    const d = JSON.parse(row.value);
    for (const path of [['smtp', 'passEnc'], ['whatsapp', 'tokenEnc'], [null, 'tokenEnc'], [null, 'secretEnc']]) {
      const obj = path[0] ? d[path[0]] : d;
      if (obj?.[path[1]]) obj[path[1]] = vault.encrypt(reopen(obj[path[1]], `plataforma (${key}.${path.filter(Boolean).join('.')})`));
    }
    run('UPDATE platform_settings SET value = ? WHERE key = ?', JSON.stringify(d), key); inc('segredos da plataforma');
  }
  if (failures.length && !force) throw new Error(`${failures.length} dado(s) não abriram com nenhuma das chaves (nada foi alterado):\n  ` + failures.slice(0, 20).join('\n  ') + '\nConfira as chaves ou rode com --force para regravar o resto.');
});
console.log('Rotação concluída:', count);
const rc = all('SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE used_at IS NULL')[0].n;
if (rc) console.log(`Atenção: ${rc} código(s) de recuperação do 2FA ainda usam a chave antiga. Mantenha APP_SECRET_PREVIOUS até os usuários gerarem códigos novos (Minha conta → 2FA).`);
