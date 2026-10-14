'use strict';
// Segurança extra: corrente da auditoria, aviso de acesso novo, sessões abertas, confirmação de ação sensível
// e chaves de acesso (passkeys) com um autenticador simulado (chave P-256 gerada no teste).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { start, stop, Client, makeUser, get, run, all, COMPANY } = (() => { const h = require('./helpers'); return { ...h, all: require('../src/db').all }; })();
const { verifyChain } = require('../src/auditChain');
const { publicUrl } = require('../src/config');

let admin; let master;
test.before(async () => {
  await start();
  makeUser('adm@sx.local', 'admin');
  admin = new Client(); await admin.login('adm@sx.local', 'SenhaForte123');
  makeUser('master@sx.local', 'master');
  master = new Client(); await master.login('master@sx.local', 'SenhaForte123');
});
test.after(stop);

test('auditoria encadeada: íntegra; edição ou exclusão no meio é detectada; retenção (apagar as mais antigas) não quebra', async () => {
  for (let i = 0; i < 4; i++) await admin.req('POST', '/api/admin/branches', { body: { code: 'AU' + i, name: 'Auditoria ' + i } });
  assert.equal((await admin.req('GET', '/api/admin/audit/verify')).json.ok, true);
  const ids = all('SELECT id FROM audit_log WHERE company_id = ? ORDER BY id', COMPANY).map((r) => r.id);
  // Retenção: apaga os mais antigos → continua íntegra.
  run('DELETE FROM audit_log WHERE id = ?', ids[0]);
  assert.equal(verifyChain(all, COMPANY).ok, true);
  // Alguém edita um registro do meio direto no banco → acusa.
  const mid = ids[2];
  run("UPDATE audit_log SET detail = '{\"code\":\"FALSO\"}' WHERE id = ?", mid);
  const v = (await admin.req('GET', '/api/admin/audit/verify')).json;
  assert.equal(v.ok, false); assert.equal(v.brokenAt, mid);
  const m = (await master.req('GET', '/api/admin/master/audit/verify')).json;
  assert.equal(m.ok, false); assert.ok(m.chains.find((c) => c.companyId === null).ok, 'corrente da plataforma intacta');
  // Apagar um do meio também é detectado.
  run('DELETE FROM audit_log WHERE id = ?', mid);
  assert.equal(verifyChain(all, COMPANY).brokenAt, ids[3]);
});

test('aviso de novo acesso: o primeiro login não avisa; outro navegador/rede avisa; o mesmo não repete', async () => {
  makeUser('alerta@sx.local', 'admin');
  const n = () => get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'login_alert' AND recipient = 'alerta@sx.local'").n;
  const c1 = new Client('10.9.1.5');
  await c1.req('POST', '/api/admin/login', { body: { email: 'alerta@sx.local', password: 'SenhaForte123' }, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' } });
  assert.equal(n(), 0);
  await new Client('10.9.1.77').req('POST', '/api/admin/login', { body: { email: 'alerta@sx.local', password: 'SenhaForte123' }, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/121.0 Safari/537.36' } });
  assert.equal(n(), 0, 'mesmo navegador e mesma rede');
  await new Client('172.20.5.5').req('POST', '/api/admin/login', { body: { email: 'alerta@sx.local', password: 'SenhaForte123' }, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Mobile Safari/604.1' } });
  assert.equal(n(), 1, 'aparelho novo');
});

test('sessões abertas: lista, encerra outra e encerra todas as outras (nunca a atual)', async () => {
  const other = new Client(); await other.login('adm@sx.local', 'SenhaForte123');
  const list = (await admin.req('GET', '/api/admin/me/sessions')).json;
  assert.ok(list.sessions.length >= 2); assert.equal(list.sessions.filter((s) => s.current).length, 1);
  assert.ok(!JSON.stringify(list).includes('token_hash'));
  const victim = list.sessions.find((s) => !s.current);
  assert.equal((await admin.req('DELETE', `/api/admin/me/sessions/${victim.id}`)).json.removed, 1);
  const cur = list.sessions.find((s) => s.current);
  assert.equal((await admin.req('DELETE', `/api/admin/me/sessions/${cur.id}`)).json.removed, 0, 'não encerra a própria sessão por aqui');
  const third = new Client(); await third.login('adm@sx.local', 'SenhaForte123');
  await admin.req('POST', '/api/admin/me/sessions/revoke-others');
  assert.equal((await third.req('GET', '/api/admin/me')).status, 401);
  assert.equal((await admin.req('GET', '/api/admin/me')).status, 200);
});

// ---------------------------------------------------------------- passkeys com autenticador simulado
function cbor(v) {
  const head = (type, n) => (n < 24 ? Buffer.from([(type << 5) | n]) : n < 256 ? Buffer.from([(type << 5) | 24, n]) : n < 65536 ? Buffer.from([(type << 5) | 25, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(5); b[0] = (type << 5) | 26; b.writeUInt32BE(n, 1); return b; })());
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('tipo');
}
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const { origin, hostname: rpId } = new URL(publicUrl);
const authenticator = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(32); let counter = 0;
  return {
    credId: credId.toString('base64url'),
    create(challenge, { flags = 0x45 } = {}) {
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
      const len = Buffer.alloc(2); len.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha(rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), len, credId, cose]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
      return { id: credId.toString('base64url'), rawId: credId.toString('base64url'), type: 'public-key',
        response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])).toString('base64url') } };
    },
    get(challenge, { originOverride, count } = {}) {
      counter = count ?? counter + 1;
      const cnt = Buffer.alloc(4); cnt.writeUInt32BE(counter);
      const authData = Buffer.concat([sha(rpId), Buffer.from([0x05]), cnt]);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: originOverride || origin }));
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(clientDataJSON)]), privateKey);
      return { id: credId.toString('base64url'), type: 'public-key',
        response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: signature.toString('base64url') } };
    },
  };
};

test('passkey: cadastro exige senha e 2FA ativo; login com a chave; origem errada, contador clonado e chave alheia são recusados', async () => {
  makeUser('passkey@sx.local', 'master');
  const c = new Client(); await c.login('passkey@sx.local', 'SenhaForte123');
  assert.equal((await c.req('POST', '/api/admin/webauthn/register/options', { body: { password: 'SenhaForte123' } })).status, 400, 'exige 2FA ativo');
  const setup = await c.req('POST', '/api/admin/mfa/setup', { body: { password: 'SenhaForte123' } });
  const secret = setup.json.secret;
  // Gera o código pelo mesmo algoritmo do servidor.
  const hotp = (step) => { const key = (() => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const ch of secret.replace(/=+$/, '')) bits += A.indexOf(ch).toString(2).padStart(5, '0'); const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); })();
    const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step)); const hm = crypto.createHmac('sha1', key).update(msg).digest(); const o = hm[19] & 15;
    return String(((hm.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0'); };
  const step0 = Math.floor(Date.now() / 30000);
  assert.equal((await c.req('POST', '/api/admin/mfa/enable', { body: { code: hotp(step0) } })).status, 200);
  assert.equal((await c.req('POST', '/api/admin/webauthn/register/options', { body: { password: 'errada' } })).status, 403);
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?', 'passkey@sx.local');
  const opt = await c.req('POST', '/api/admin/webauthn/register/options', { body: { password: 'SenhaForte123', code: hotp(step0 + 1) } });
  assert.equal(opt.status, 200, opt.text); assert.equal(opt.json.rp.id, rpId);
  const key = authenticator();
  assert.equal((await c.req('POST', '/api/admin/webauthn/register', { body: { credential: key.create(opt.json.challenge, { flags: 0x41 }) } })).status, 400, 'sem verificação do usuário (UV) não cadastra');
  // O mesmo código não vale duas vezes (proteção contra repetição); no teste, liberamos para não esperar 30 s.
  run('UPDATE users SET totp_last_step = NULL WHERE email = ?', 'passkey@sx.local');
  const opt2 = await c.req('POST', '/api/admin/webauthn/register/options', { body: { password: 'SenhaForte123', code: hotp(step0) } });
  assert.equal(opt2.status, 200, opt2.text);
  const reg = await c.req('POST', '/api/admin/webauthn/register', { body: { credential: key.create(opt2.json.challenge), name: 'Notebook' } });
  assert.equal(reg.status, 201, reg.text);
  assert.equal((await c.req('GET', '/api/admin/webauthn')).json[0].name, 'Notebook');
  // Login: senha → desafio com a chave.
  const login = async () => { const x = new Client(); const r = await x.req('POST', '/api/admin/login', { body: { email: 'passkey@sx.local', password: 'SenhaForte123' } }); return { x, r }; };
  let { x, r } = await login();
  assert.equal(r.json.mfaRequired, true); assert.equal(r.json.webauthn.allowCredentials[0].id, key.credId);
  assert.equal((await x.req('POST', '/api/admin/login/webauthn', { body: { challenge: r.json.challenge, credential: key.get(r.json.webauthn.challenge, { originOverride: 'https://phishing.example' }) } })).status, 401, 'origem falsa');
  ({ x, r } = await login());
  const ok = await x.req('POST', '/api/admin/login/webauthn', { body: { challenge: r.json.challenge, credential: key.get(r.json.webauthn.challenge) } });
  assert.equal(ok.status, 200, ok.text); x.csrf = ok.json.csrf;
  assert.equal((await x.req('GET', '/api/admin/me')).json.user.role, 'master');
  // Desafio é de uso único.
  assert.equal((await x.req('POST', '/api/admin/login/webauthn', { body: { challenge: r.json.challenge, credential: key.get(r.json.webauthn.challenge) } })).status, 401);
  // Contador voltando (chave clonada) é recusado.
  ({ x, r } = await login());
  assert.equal((await x.req('POST', '/api/admin/login/webauthn', { body: { challenge: r.json.challenge, credential: key.get(r.json.webauthn.challenge, { count: 1 }) } })).status, 401);
  // Chave de outra pessoa não serve.
  const intruder = authenticator();
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?', 'passkey@sx.local');
  ({ x, r } = await login());
  const forged = intruder.get(r.json.webauthn.challenge); forged.id = key.credId;
  assert.equal((await x.req('POST', '/api/admin/login/webauthn', { body: { challenge: r.json.challenge, credential: forged } })).status, 401, 'assinatura de outra chave');
});
