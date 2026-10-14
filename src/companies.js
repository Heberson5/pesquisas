'use strict';
// Empresas (clientes da plataforma): leitura, criação, situação e criptografia própria de cada uma.
const { get, run, all } = require('./db');
const vault = require('./vault');
const config = require('./config');
const { slugify } = require('./migrations');

const STATUS_LABEL = { trial: 'Em teste', active: 'Ativa', past_due: 'Pagamento em atraso', suspended: 'Suspensa', canceled: 'Cancelada' };
// Situações em que tablets e QR Codes deixam de aceitar respostas.
const BLOCKED = new Set(['suspended', 'canceled']);

const getCompany = (companyId) => (companyId ? get('SELECT * FROM companies WHERE id = ?', companyId) : null);
const listCompanies = () => all('SELECT id, name, slug, status, cnpj, created_at FROM companies ORDER BY name');

// Fuso padrão da empresa (usado quando a unidade e o tablet não definem um).
function companyTz(companyId) {
  const c = companyId ? get('SELECT timezone FROM companies WHERE id = ?', companyId) : null;
  return c?.timezone || config.timezone;
}

function uniqueSlug(name) {
  const base = slugify(name);
  let slug = base; let i = 2;
  while (get('SELECT 1 FROM companies WHERE slug = ?', slug)) slug = `${base}-${i++}`;
  return slug;
}

function createCompany({ name, legalName = null, cnpj = null, status = 'active', timezone = null, billingEmail = null, trialEndsAt = null }) {
  const now = Date.now();
  const r = run(`INSERT INTO companies (name, legal_name, cnpj, slug, status, trial_ends_at, timezone, billing_email, key_salt, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, name, legalName, cnpj, uniqueSlug(name), status, trialEndsAt, timezone, billingEmail, vault.newSalt(), now, now);
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------- criptografia por empresa
function keysFor(companyId) {
  const c = get('SELECT id, key_salt FROM companies WHERE id = ?', companyId);
  if (!c) throw new Error('Empresa inexistente.');
  return vault.companyKeys(c.id, c.key_salt);
}
const encryptFor = (companyId, plain) => vault.encryptK(keysFor(companyId), plain);
const decryptFor = (companyId, blob) => (blob ? vault.decryptK(keysFor(companyId), blob) : null);
const lookupFor = (companyId, value) => vault.lookupK(keysFor(companyId), value);
const signFor = (companyId, value) => vault.signK(keysFor(companyId), value);

module.exports = {
  STATUS_LABEL, BLOCKED, getCompany, listCompanies, companyTz, createCompany, uniqueSlug,
  keysFor, encryptFor, decryptFor, lookupFor, signFor,
};
