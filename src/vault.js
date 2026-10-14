'use strict';
// Criptografia de dados pessoais (LGPD) e segredos: AES-256-GCM com chave derivada do APP_SECRET.
// "lookup" gera um identificador determinístico (HMAC) para buscar um telefone/e-mail sem guardá-lo aberto.
//
// Dois níveis de chave:
//   • PLATAFORMA (formato "v1."): tokens de tablet/QR Code, 2FA dos usuários, credenciais da plataforma.
//   • EMPRESA (formato "c1.<empresa>."): contatos de clientes, senhas de e-mail e tokens de WhatsApp de cada empresa.
//     Cada empresa tem um "sal" aleatório próprio; a chave é derivada do APP_SECRET + sal + id da empresa.
//     Um dado da empresa B não abre com a chave da empresa A, e apagar o sal torna os dados ilegíveis (apagamento seguro).
const crypto = require('node:crypto');
const { appSecret } = require('./config');

const derive = (label) => Buffer.from(crypto.hkdfSync('sha256', appSecret, 'pesquisa-satisfacao', label, 32));
const ENC_KEY = derive('enc-v1');
const LOOKUP_KEY = derive('lookup-v1');
const SIGN_KEY = derive('sign-v1');

function seal(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}
function open(key, iv, tag, data) {
  if (!iv || !tag || data === undefined) return null;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
}

// ---------------------------------------------------------------- nível plataforma
function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  return `v1.${seal(ENC_KEY, plain)}`;
}
function decrypt(blob) {
  if (!blob) return null;
  const [v, iv, tag, data] = String(blob).split('.');
  if (v !== 'v1') return null;
  return open(ENC_KEY, iv, tag, data);
}
const lookup = (value) => (value ? crypto.createHmac('sha256', LOOKUP_KEY).update(String(value)).digest('hex') : null);
const sign = (value) => crypto.createHmac('sha256', SIGN_KEY).update(String(value)).digest('base64url');

// ---------------------------------------------------------------- nível empresa
const newSalt = () => crypto.randomBytes(32).toString('base64url');
const keyCache = new Map();
function companyKeys(companyId, salt) {
  if (!Number.isInteger(companyId) || companyId < 1 || typeof salt !== 'string' || salt.length < 20) throw new Error('Chave de empresa inválida.');
  const cacheKey = `${companyId}:${salt}`;
  if (!keyCache.has(cacheKey)) {
    const k = (label) => Buffer.from(crypto.hkdfSync('sha256', appSecret, Buffer.from(salt, 'base64url'), `empresa:${companyId}:${label}`, 32));
    keyCache.set(cacheKey, Object.freeze({ id: companyId, enc: k('enc-v1'), look: k('lookup-v1'), sign: k('sign-v1') }));
  }
  return keyCache.get(cacheKey);
}
const forgetCompanyKeys = (companyId) => { for (const k of keyCache.keys()) if (k.startsWith(`${companyId}:`)) keyCache.delete(k); };

function encryptK(keys, plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  return `c1.${keys.id}.${seal(keys.enc, plain)}`;
}
// Só abre se o dado for da MESMA empresa da chave: um dado de outra empresa volta null (nunca é aberto).
function decryptK(keys, blob) {
  if (!blob) return null;
  const [v, cid, iv, tag, data] = String(blob).split('.');
  if (v !== 'c1' || Number(cid) !== keys.id) return null;
  return open(keys.enc, iv, tag, data);
}
const lookupK = (keys, value) => (value ? crypto.createHmac('sha256', keys.look).update(String(value)).digest('hex') : null);
const signK = (keys, value) => crypto.createHmac('sha256', keys.sign).update(String(value)).digest('base64url');

// Normalizações usadas antes do lookup, para que "(11) 99999-0000" e "11999990000" coincidam.
const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
const normEmail = (e) => String(e || '').trim().toLowerCase();

module.exports = {
  encrypt, decrypt, lookup, sign, normPhone, normEmail,
  newSalt, companyKeys, forgetCompanyKeys, encryptK, decryptK, lookupK, signK,
};
