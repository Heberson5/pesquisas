'use strict';
// Criptografia de dados pessoais (LGPD) e segredos: AES-256-GCM com chave derivada do APP_SECRET.
// "lookup" gera um identificador determinístico (HMAC) para buscar um telefone/e-mail sem guardá-lo aberto.
//
// Dois níveis de chave:
//   • PLATAFORMA (formato "v1."): tokens de tablet/QR Code, 2FA dos usuários, credenciais da plataforma.
//   • EMPRESA (formato "c1.<empresa>."): contatos de clientes, senhas de e-mail e tokens de WhatsApp de cada empresa.
//     Cada empresa tem um "sal" aleatório próprio; a chave é derivada do APP_SECRET + sal + id da empresa.
//     Um dado da empresa B não abre com a chave da empresa A, e apagar o sal torna os dados ilegíveis (apagamento seguro).
//
// Rotação da chave mestra: com APP_SECRET_PREVIOUS definido, o que não abrir com a chave atual é tentado com a
// anterior (só leitura). O script rotate-secret regrava tudo com a atual; depois a anterior pode ser removida.
const crypto = require('node:crypto');
const { appSecret, appSecretPrevious } = require('./config');

const ring = (secret) => {
  const d = (label) => Buffer.from(crypto.hkdfSync('sha256', secret, 'pesquisa-satisfacao', label, 32));
  return { enc: d('enc-v1'), look: d('lookup-v1'), sign: d('sign-v1') };
};
const CUR = ring(appSecret);
const PREV = appSecretPrevious ? ring(appSecretPrevious) : null;
const ENC_KEY = CUR.enc;
const LOOKUP_KEY = CUR.look;
const SIGN_KEY = CUR.sign;

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
  return open(ENC_KEY, iv, tag, data) ?? (PREV ? open(PREV.enc, iv, tag, data) : null);
}
const lookup = (value) => (value ? crypto.createHmac('sha256', LOOKUP_KEY).update(String(value)).digest('hex') : null);
// Todas as versões do identificador (atual e, durante a rotação, a anterior) — para buscas.
const lookupAll = (value) => (value ? [CUR, PREV].filter(Boolean).map((k) => crypto.createHmac('sha256', k.look).update(String(value)).digest('hex')) : []);
const sign = (value) => crypto.createHmac('sha256', SIGN_KEY).update(String(value)).digest('base64url');

// ---------------------------------------------------------------- nível empresa
const newSalt = () => crypto.randomBytes(32).toString('base64url');
const keyCache = new Map();
function companyKeys(companyId, salt) {
  if (!Number.isInteger(companyId) || companyId < 1 || typeof salt !== 'string' || salt.length < 20) throw new Error('Chave de empresa inválida.');
  const cacheKey = `${companyId}:${salt}`;
  if (!keyCache.has(cacheKey)) {
    const k = (secret, label) => Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from(salt, 'base64url'), `empresa:${companyId}:${label}`, 32));
    const prev = appSecretPrevious ? Object.freeze({ enc: k(appSecretPrevious, 'enc-v1'), look: k(appSecretPrevious, 'lookup-v1') }) : null;
    keyCache.set(cacheKey, Object.freeze({ id: companyId, enc: k(appSecret, 'enc-v1'), look: k(appSecret, 'lookup-v1'), sign: k(appSecret, 'sign-v1'), prev }));
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
  return open(keys.enc, iv, tag, data) ?? (keys.prev ? open(keys.prev.enc, iv, tag, data) : null);
}
const lookupK = (keys, value) => (value ? crypto.createHmac('sha256', keys.look).update(String(value)).digest('hex') : null);
const lookupAllK = (keys, value) => (value ? [keys.look, keys.prev?.look].filter(Boolean).map((k) => crypto.createHmac('sha256', k).update(String(value)).digest('hex')) : []);
const signK = (keys, value) => crypto.createHmac('sha256', keys.sign).update(String(value)).digest('base64url');

// Normalizações usadas antes do lookup, para que "(11) 99999-0000" e "11999990000" coincidam.
const normPhone = (p) => String(p || '').replace(/\D/g, '').replace(/^55(?=\d{10,11}$)/, '');
const normEmail = (e) => String(e || '').trim().toLowerCase();

module.exports = {
  encrypt, decrypt, lookup, lookupAll, sign, normPhone, normEmail,
  newSalt, companyKeys, forgetCompanyKeys, encryptK, decryptK, lookupK, lookupAllK, signK, rotating: !!PREV,
};
