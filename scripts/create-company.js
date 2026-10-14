'use strict';
// Cadastra uma empresa pelo terminal (o cadastro completo, com consulta do CNPJ, fica no Painel Master).
// Uso: npm run create-company -- "Nome da Empresa" [--cnpj 00.000.000/0000-00] [--teste 14]
const { get } = require('../src/db');
const { createCompany } = require('../src/companies');

const args = process.argv.slice(2);
const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
if (!name || name.length < 2) { console.error('Uso: npm run create-company -- "Nome da Empresa" [--cnpj 00000000000000] [--teste 14]'); process.exit(1); }
const cnpj = opt('cnpj') ? opt('cnpj').replace(/\D/g, '') : null;
if (cnpj && cnpj.length !== 14) { console.error('CNPJ precisa ter 14 dígitos.'); process.exit(1); }
if (cnpj && get('SELECT 1 FROM companies WHERE cnpj = ?', cnpj)) { console.error('Já existe uma empresa com este CNPJ.'); process.exit(1); }
const trialDays = opt('teste') ? Number(opt('teste')) : null;
const id = createCompany({ name, cnpj, status: trialDays ? 'trial' : 'active', trialEndsAt: trialDays ? Date.now() + trialDays * 86_400_000 : null });
const c = get('SELECT id, slug, status FROM companies WHERE id = ?', id);
console.log(`Empresa criada: nº ${c.id}, endereço curto "${c.slug}", situação ${c.status}.`);
console.log(`Agora crie o administrador: npm run create-admin -- admin@empresa.com.br "Nome" --empresa ${c.slug}`);
