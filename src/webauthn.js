'use strict';
// Chaves de acesso (passkeys / WebAuthn) como segundo fator, resistentes a phishing: a chave só assina para o
// endereço verdadeiro do painel. Implementação enxuta, sem dependências:
//   • cadastro: atestado "none" (não exigimos fabricante), chave ES256 (P-256) ou RS256;
//   • login: confere desafio de uso único, origem, hash do domínio (rpId), presença e verificação do usuário (UV),
//     a assinatura e o contador (aparelho clonado é recusado).
const crypto = require('node:crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const fromB64u = (s) => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > 20_000) throw new Error('Dado inválido.');
  return Buffer.from(s, 'base64url');
};

// ---------------------------------------------------------------- CBOR (só o que WebAuthn usa)
function cborDecode(buf) {
  let pos = 0;
  const need = (n) => { if (pos + n > buf.length) throw new Error('CBOR truncado.'); };
  const readLen = (info) => {
    if (info < 24) return info;
    const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[info];
    if (!size) throw new Error('CBOR não suportado.');
    need(size);
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i];
    pos += size;
    return v;
  };
  const item = (depth = 0) => {
    if (depth > 16) throw new Error('CBOR profundo demais.');
    need(1);
    const b = buf[pos++]; const type = b >> 5; const info = b & 31;
    if (type === 7) {
      if (info === 20) return false; if (info === 21) return true; if (info === 22) return null;
      throw new Error('CBOR não suportado.');
    }
    const len = readLen(info);
    switch (type) {
      case 0: return len;
      case 1: return -1 - len;
      case 2: need(len); pos += len; return buf.subarray(pos - len, pos);
      case 3: need(len); pos += len; return buf.subarray(pos - len, pos).toString('utf8');
      case 4: { if (len > 1000) throw new Error('CBOR grande demais.'); const a = []; for (let i = 0; i < len; i++) a.push(item(depth + 1)); return a; }
      case 5: { if (len > 1000) throw new Error('CBOR grande demais.'); const m = new Map(); for (let i = 0; i < len; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      default: throw new Error('CBOR não suportado.');
    }
  };
  const value = item();
  return { value, length: pos };
}

// authenticatorData: rpIdHash(32) flags(1) signCount(4) [attestedCredentialData] [extensions]
function parseAuthData(buf) {
  if (buf.length < 37) throw new Error('Dados do autenticador inválidos.');
  const flags = buf[32];
  const out = { rpIdHash: buf.subarray(0, 32), up: !!(flags & 1), uv: !!(flags & 4), at: !!(flags & 64), signCount: buf.readUInt32BE(33) };
  if (out.at) {
    if (buf.length < 55) throw new Error('Dados do autenticador inválidos.');
    const idLen = buf.readUInt16BE(53);
    if (idLen < 16 || idLen > 1023 || buf.length < 55 + idLen) throw new Error('Credencial inválida.');
    out.credentialId = buf.subarray(55, 55 + idLen);
    const cose = cborDecode(buf.subarray(55 + idLen));
    out.coseKey = cose.value;
  }
  return out;
}

// Chave COSE → JWK (para o crypto do Node).
function coseToJwk(m) {
  if (!(m instanceof Map)) throw new Error('Chave inválida.');
  const kty = m.get(1); const alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1) {
    const x = m.get(-2); const y = m.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('Chave inválida.');
    return { alg: -7, jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) } };
  }
  if (kty === 3 && alg === -257) {
    const n = m.get(-1); const e = m.get(-2);
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e) || n.length < 256) throw new Error('Chave inválida.');
    return { alg: -257, jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) } };
  }
  throw new Error('Tipo de chave não suportado (use uma chave de acesso moderna).');
}

const newChallenge = () => b64u(crypto.randomBytes(32));

function checkClientData(clientDataJSON, { type, challenge, origin }) {
  let cd;
  try { cd = JSON.parse(fromB64u(clientDataJSON).toString('utf8')); } catch { throw new Error('Resposta inválida do navegador.'); }
  if (cd.type !== type) throw new Error('Tipo de operação inválido.');
  const a = Buffer.from(String(cd.challenge || '')); const b = Buffer.from(challenge);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Desafio inválido ou expirado.');
  if (cd.origin !== origin) throw new Error('Origem não permitida.');
  return cd;
}

// Cadastro de uma chave de acesso. Devolve o que deve ser guardado.
function verifyRegistration(cred, { challenge, origin, rpId }) {
  if (!cred || cred.type !== 'public-key' || !cred.response) throw new Error('Credencial inválida.');
  checkClientData(cred.response.clientDataJSON, { type: 'webauthn.create', challenge, origin });
  const att = cborDecode(fromB64u(cred.response.attestationObject)).value;
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('Atestado inválido.');
  const ad = parseAuthData(att.get('authData'));
  if (!crypto.timingSafeEqual(ad.rpIdHash, crypto.createHash('sha256').update(rpId).digest())) throw new Error('Domínio não confere.');
  if (!ad.up || !ad.uv) throw new Error('A chave precisa confirmar que é você (biometria ou PIN).');
  if (!ad.at || !ad.credentialId) throw new Error('Credencial ausente.');
  const { alg, jwk } = coseToJwk(ad.coseKey);
  crypto.createPublicKey({ key: jwk, format: 'jwk' }); // valida a chave
  return { credentialId: b64u(ad.credentialId), alg, jwk, signCount: ad.signCount };
}

// Login com a chave. stored = { public_key_jwk, alg, sign_count }.
function verifyAssertion(cred, stored, { challenge, origin, rpId }) {
  if (!cred || cred.type !== 'public-key' || !cred.response) throw new Error('Credencial inválida.');
  checkClientData(cred.response.clientDataJSON, { type: 'webauthn.get', challenge, origin });
  const authData = fromB64u(cred.response.authenticatorData);
  const ad = parseAuthData(authData);
  if (!crypto.timingSafeEqual(ad.rpIdHash, crypto.createHash('sha256').update(rpId).digest())) throw new Error('Domínio não confere.');
  if (!ad.up || !ad.uv) throw new Error('A chave precisa confirmar que é você (biometria ou PIN).');
  const data = Buffer.concat([authData, crypto.createHash('sha256').update(fromB64u(cred.response.clientDataJSON)).digest()]);
  const key = crypto.createPublicKey({ key: JSON.parse(stored.public_key_jwk), format: 'jwk' });
  const ok = crypto.verify(stored.alg === -257 ? 'sha256' : 'sha256', data, stored.alg === -257 ? key : { key, dsaEncoding: 'der' }, fromB64u(cred.response.signature));
  if (!ok) throw new Error('Assinatura inválida.');
  if (stored.sign_count > 0 && ad.signCount > 0 && ad.signCount <= stored.sign_count) throw new Error('Contador da chave voltou: possível cópia. Use outro fator e avise o administrador.');
  return { signCount: ad.signCount };
}

// Origem e domínio esperados: os do endereço público configurado (PUBLIC_URL).
function relyingParty() {
  const u = new URL(require('./config').publicUrl);
  return { origin: u.origin, rpId: u.hostname };
}

module.exports = { cborDecode, parseAuthData, coseToJwk, newChallenge, verifyRegistration, verifyAssertion, relyingParty, b64u, fromB64u };
