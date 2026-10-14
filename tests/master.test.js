'use strict';
// Painel Master: CNPJ (dígitos, duplicado, situação na Receita, consulta fora do ar), cadastro com convite,
// situação da empresa, exclusão definitiva, configurações gerais, autocadastro, saúde/capacidade e auditoria.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, stop, Client, makeUser, get, run, COMPANY } = require('./helpers');
const cnpjLib = require('../src/cnpj');

// CNPJs com dígitos válidos usados nos testes.
const ATIVA = '11222333000181';
const BAIXADA = '11444777000161';
const INEXISTENTE = '45997418000153';
const FORA_DO_AR = '19131243000197';
const OUTRA_ATIVA = '06990590000123';
const AUTO = '33000167000101';
const FORA_DO_AR_2 = '55666777001072';

const brasilApi = (cnpj, situacao, extra = {}) => ({ cnpj, razao_social: `EMPRESA ${cnpj} LTDA`, nome_fantasia: 'LOJA EXEMPLO', descricao_situacao_cadastral: situacao,
  data_inicio_atividade: '2015-03-02', cnae_fiscal: 4781400, cnae_fiscal_descricao: 'Comércio varejista de artigos do vestuário', descricao_tipo_de_logradouro: 'AVENIDA',
  logradouro: 'PAULISTA', numero: '1000', complemento: 'SALA 1', bairro: 'BELA VISTA', municipio: 'SAO PAULO', uf: 'SP', cep: '01310100', ddd_telefone_1: '1133334444', email: 'contato@exemplo.com.br', ...extra });
const calls = [];
// Simula a BrasilAPI e a ReceitaWS (no sandbox não há acesso à internet).
cnpjLib.net.fetch = async (url) => {
  calls.push(url);
  const json = (status, body) => ({ status, ok: status < 300, text: async () => JSON.stringify(body) });
  const c = url.split('/').pop();
  if (c === FORA_DO_AR || c === FORA_DO_AR_2) throw new Error('fetch failed');
  if (url.includes('brasilapi')) {
    if (c === INEXISTENTE) return json(404, { message: 'CNPJ não encontrado' });
    if (c === OUTRA_ATIVA) return json(500, { message: 'erro' }); // cai na ReceitaWS
    return json(200, brasilApi(c, c === BAIXADA ? 'BAIXADA' : 'ATIVA'));
  }
  if (c === INEXISTENTE) return json(200, { status: 'ERROR', message: 'CNPJ inválido' });
  return json(200, { status: 'OK', nome: 'OUTRA EMPRESA S/A', fantasia: 'OUTRA', situacao: 'ATIVA', abertura: '10/01/2010', cnpj: cnpjLib.format(c),
    atividade_principal: [{ code: '56.11-2-01', text: 'Restaurantes e similares' }], logradouro: 'RUA DAS FLORES', numero: '12', complemento: '', bairro: 'CENTRO',
    municipio: 'CURITIBA', uf: 'PR', cep: '80.010-000', telefone: '(41) 3333-2222', email: 'OUTRA@EXEMPLO.COM' });
};

let master; let admin;
const mk = (body) => master.req('POST', '/api/admin/master/companies', { body: { name: 'Loja Exemplo', ...body } });

test.before(async () => {
  await start();
  makeUser('master@p.local', 'master');
  master = new Client(); await master.login('master@p.local', 'SenhaForte123');
  makeUser('adm@p.local', 'admin');
  admin = new Client(); await admin.login('adm@p.local', 'SenhaForte123');
});
test.after(stop);

test('CNPJ: dígitos verificadores e formatação', () => {
  for (const ok of [ATIVA, '11.222.333/0001-81', BAIXADA, OUTRA_ATIVA, AUTO]) assert.ok(cnpjLib.isValid(ok), ok);
  for (const no of ['11222333000182', '00000000000000', '1122233300018', 'abc', '', null, '11.222.333/0001-8X']) assert.ok(!cnpjLib.isValid(no), String(no));
  assert.equal(cnpjLib.format(ATIVA), '11.222.333/0001-81');
});

test('consulta: BrasilAPI primeiro, ReceitaWS se falhar; não encontrado e fora do ar', async () => {
  const a = await cnpjLib.lookup(ATIVA);
  assert.equal(a.found, true); assert.equal(a.data.source, 'BrasilAPI'); assert.equal(a.data.active, true);
  assert.equal(a.data.address.city, 'Sao Paulo'); assert.equal(a.data.address.street, 'Avenida Paulista'); assert.equal(a.data.address.cep, '01310-100');
  const b = await cnpjLib.lookup(OUTRA_ATIVA);
  assert.equal(b.data.source, 'ReceitaWS'); assert.equal(b.data.legalName, 'OUTRA EMPRESA S/A'); assert.equal(b.data.email, 'outra@exemplo.com'); assert.equal(b.data.openedAt, '2010-01-10');
  assert.equal((await cnpjLib.lookup(BAIXADA)).data.active, false);
  assert.equal((await cnpjLib.lookup(INEXISTENTE)).notFound, true);
  assert.equal((await cnpjLib.lookup(FORA_DO_AR)).unavailable, true);
  assert.equal((await cnpjLib.lookup('11222333000182')).invalid, true);
});

test('só o Master acessa o Painel Master', async () => {
  for (const [m, url] of [['GET', '/api/admin/master/companies'], ['POST', '/api/admin/master/companies'], ['GET', `/api/admin/master/cnpj/${ATIVA}`],
    ['GET', '/api/admin/master/platform'], ['PUT', '/api/admin/master/platform'], ['GET', '/api/admin/master/health'], ['GET', '/api/admin/master/audit'],
    ['GET', '/api/admin/master/delivery'], ['DELETE', `/api/admin/master/companies/${COMPANY}`], ['POST', `/api/admin/master/companies/${COMPANY}/status`]]) {
    assert.equal((await admin.req(m, url, { body: {} })).status, 403, `${m} ${url}`);
  }
  assert.equal((await new Client().req('GET', '/api/admin/master/companies')).status, 401);
});

test('cadastro: preenche com a Receita, convida o administrador e recusa CNPJ inválido, inativo ou inexistente', async () => {
  const look = await master.req('GET', `/api/admin/master/cnpj/${ATIVA}`);
  assert.equal(look.status, 200); assert.equal(look.json.data.legalName, `EMPRESA ${ATIVA} LTDA`); assert.equal(look.json.duplicate, null);
  assert.equal((await mk({ cnpj: '11222333000182' })).status, 400);
  assert.equal((await mk({ cnpj: BAIXADA })).status, 422);
  assert.equal((await mk({ cnpj: INEXISTENTE })).status, 422);
  const r = await mk({ cnpj: '11.222.333/0001-81', admin: { name: 'Dona da Loja', email: 'dona@loja.com.br' } });
  assert.equal(r.status, 201, r.text);
  const c = get('SELECT * FROM companies WHERE id = ?', r.json.id);
  assert.equal(c.cnpj, ATIVA); assert.equal(c.status, 'trial'); assert.ok(c.trial_ends_at > Date.now() + 13 * 86_400_000);
  assert.equal(c.legal_name, `EMPRESA ${ATIVA} LTDA`); assert.equal(c.receita_status, 'ATIVA'); assert.match(c.cnae, /4781400/);
  assert.equal(JSON.parse(c.address_json).uf, 'SP');
  // Convite: e-mail com link de uso único; o administrador cria a própria senha e entra.
  const mail = get("SELECT * FROM outbox WHERE kind = 'invite' AND recipient = 'dona@loja.com.br'");
  const token = /#\/redefinir\/([A-Za-z0-9_-]+)/.exec(mail.body_text)[1];
  assert.equal(get('SELECT kind FROM password_resets WHERE user_id = ?', r.json.userId).kind, 'invite');
  assert.equal((await new Client().login('dona@loja.com.br', 'SenhaForte123')).status, 401, 'sem senha antes do convite');
  assert.equal((await new Client().req('POST', '/api/admin/password/reset', { body: { token, password: 'MinhaSenha2026' } })).status, 200);
  const dona = new Client();
  assert.equal((await dona.login('dona@loja.com.br', 'MinhaSenha2026')).status, 200);
  const me = (await dona.req('GET', '/api/admin/me')).json;
  assert.equal(me.company.id, r.json.id); assert.equal(me.user.role, 'admin');
  assert.equal((await new Client().req('POST', '/api/admin/password/reset', { body: { token, password: 'OutraSenha2026' } })).status, 400, 'link de uso único');
});

test('CNPJ duplicado é recusado, mesmo com a empresa cancelada', async () => {
  const dup = await mk({ cnpj: ATIVA });
  assert.equal(dup.status, 409); assert.match(dup.json.error, /Já existe/);
  assert.ok((await master.req('GET', `/api/admin/master/cnpj/${ATIVA}`)).json.duplicate);
});

test('consulta fora do ar: o Master cadastra com os dados digitados (marcado como não conferido)', async () => {
  const r = await mk({ cnpj: FORA_DO_AR, name: 'Empresa Manual', legalName: 'Empresa Manual Ltda', address: { city: 'Recife', uf: 'PE', cep: '50000-000' } });
  assert.equal(r.status, 201, r.text); assert.equal(r.json.manual, true);
  const c = get('SELECT receita_status, legal_name, address_json FROM companies WHERE id = ?', r.json.id);
  assert.equal(c.receita_status, null); assert.equal(c.legal_name, 'Empresa Manual Ltda');
  for (const bad of [{ address: { uf: 'XX' } }, { address: { cep: '123' } }, { phone: 'abc' }, { timezone: 'Europe/Paris' }, { billingEmail: 'x' }, { name: 'a' }]) {
    const x = await master.req('PUT', `/api/admin/master/companies/${r.json.id}`, { body: { cnpj: FORA_DO_AR, name: 'Empresa Manual', ...bad } });
    assert.equal(x.status, 400, JSON.stringify(bad) + ' ' + x.text);
  }
  assert.equal((await master.req('PUT', `/api/admin/master/companies/${r.json.id}`, { body: { cnpj: ATIVA, name: 'Empresa Manual' } })).status, 409, 'trocar para CNPJ de outra empresa');
});

test('situação: suspender derruba sessões e para os tablets; cancelar exige senha; reativar volta', async () => {
  const cid = (await mk({ cnpj: OUTRA_ATIVA, name: 'Empresa Situação', status: 'active' })).json.id;
  makeUser('adm@situacao.local', 'admin', 'SenhaForte123', [], { companyId: cid });
  const a = new Client(); await a.login('adm@situacao.local', 'SenhaForte123');
  const branch = (await a.req('POST', '/api/admin/branches', { body: { code: 'S1', name: 'Situação 1' } })).json.id;
  const d = await a.req('POST', '/api/admin/devices', { body: { branchId: branch, name: 'Tab' } });
  const tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  const cfg = () => new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + tok } });
  assert.equal((await cfg()).status, 200);
  const st = (body) => master.req('POST', `/api/admin/master/companies/${cid}/status`, { body });
  assert.equal((await st({ status: 'suspended' })).status, 400, 'motivo obrigatório');
  assert.equal((await st({ status: 'suspended', reason: 'Pedido do cliente' })).status, 200);
  assert.equal((await a.req('GET', '/api/admin/me')).status, 401, 'sessão derrubada');
  assert.equal((await cfg()).status, 423);
  assert.equal((await st({ status: 'active' })).status, 200);
  assert.equal((await cfg()).status, 200);
  assert.equal((await st({ status: 'canceled', reason: 'Encerrou o contrato' })).status, 403, 'sem senha');
  assert.equal((await st({ status: 'canceled', reason: 'Encerrou o contrato', password: 'errada' })).status, 403);
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?', 'master@p.local');
  assert.equal((await st({ status: 'canceled', reason: 'Encerrou o contrato', password: 'SenhaForte123' })).status, 200);
  assert.equal(get('SELECT status FROM companies WHERE id = ?', cid).status, 'canceled');
  assert.equal((await st({ status: 'xyz' })).status, 400);
  const logs = (await master.req('GET', '/api/admin/master/audit')).json;
  assert.ok(logs.some((l) => l.action === 'company.status' && /canceled/.test(l.detail)));
});

test('exclusão definitiva: só de empresa cancelada, com nome + senha; apaga tudo e libera o CNPJ', async () => {
  const cid = get("SELECT id FROM companies WHERE name = 'Empresa Situação'").id;
  const active = get("SELECT id FROM companies WHERE name = 'Empresa Manual'").id;
  const del = (id, body) => master.req('DELETE', `/api/admin/master/companies/${id}`, { body });
  assert.equal((await del(active, { confirmName: 'Empresa Manual', password: 'SenhaForte123' })).status, 409, 'empresa não cancelada');
  assert.equal((await del(cid, { confirmName: 'Outro nome', password: 'SenhaForte123' })).status, 400);
  assert.equal((await del(cid, { confirmName: 'Empresa Situação', password: 'errada' })).status, 403);
  run('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?', 'master@p.local');
  const before = get('SELECT COUNT(*) AS n FROM branches WHERE company_id <> ?', cid).n;
  fs.mkdirSync(path.join(process.env.MEDIA_DIR, String(cid)), { recursive: true });
  const r = await del(cid, { confirmName: 'Empresa Situação', password: 'SenhaForte123' });
  assert.equal(r.status, 200, r.text);
  assert.equal(get('SELECT COUNT(*) AS n FROM companies WHERE id = ?', cid).n, 0);
  for (const t of ['users', 'branches', 'devices', 'responses', 'surveys', 'company_settings', 'audit_log']) assert.equal(get(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id = ?`, cid).n, 0, t);
  assert.equal(get('SELECT COUNT(*) AS n FROM branches WHERE company_id <> ?', cid).n, before, 'outras empresas intactas');
  assert.ok(!fs.existsSync(path.join(process.env.MEDIA_DIR, String(cid))), 'pasta de arquivos apagada');
  assert.equal((await mk({ cnpj: OUTRA_ATIVA, name: 'Nova dona do CNPJ' })).status, 201, 'CNPJ liberado');
});

test('configurações gerais validam e ficam na auditoria da plataforma', async () => {
  const cur = (await master.req('GET', '/api/admin/master/platform')).json;
  assert.equal(cur.signup.enabled, false);
  for (const body of [{ branding: { primaryColor: 'red' } }, { signup: { enabled: 'sim' } }, { signup: { trialDays: 0 } }, { capacity: { dbLimitMb: 1 } },
    { capacity: { alertEmails: ['não é e-mail'] } }, { security: { masterMfa: 'x' } }, { branding: { companyName: 'x' } }]) {
    assert.equal((await master.req('PUT', '/api/admin/master/platform', { body })).status, 400, JSON.stringify(body));
  }
  const ok = await master.req('PUT', '/api/admin/master/platform', { body: { branding: { companyName: 'Sauberlich Pesquisas', primaryColor: '#112233' } } });
  assert.equal(ok.status, 200); assert.equal(ok.json.branding.companyName, 'Sauberlich Pesquisas');
  assert.equal((await new Client().req('GET', '/api/public/branding')).json.companyName, 'Sauberlich Pesquisas');
  assert.ok((await master.req('GET', '/api/admin/master/audit')).json.some((l) => l.action === 'platform.settings'));
});

test('autocadastro: desligado por padrão; ligado, cria empresa em teste com o administrador', async () => {
  const body = (extra = {}) => ({ cnpj: AUTO, name: 'Autocadastro SA', adminName: 'Fulana', email: 'fulana@auto.com.br', password: 'SenhaForte123',
    acceptTerms: true, startedAt: Date.now() - 20_000, ...extra });
  assert.equal((await new Client().req('GET', '/api/public/signup')).json.enabled, false);
  assert.equal((await new Client().req('POST', '/api/public/signup', { body: body() })).status, 404);
  await master.req('PUT', '/api/admin/master/platform', { body: { signup: { enabled: true, trialDays: 7 } } });
  const c = new Client();
  assert.equal((await c.req('GET', `/api/public/signup/cnpj/${AUTO}`)).json.active, true);
  assert.equal((await c.req('POST', '/api/public/signup', { body: body({ website: 'http://spam' }) })).status, 400, 'robô (campo-isca)');
  assert.equal((await c.req('POST', '/api/public/signup', { body: body({ startedAt: Date.now() }) })).status, 400, 'rápido demais');
  assert.equal((await new Client().req('POST', '/api/public/signup', { body: body({ acceptTerms: false }) })).status, 400);
  assert.equal((await new Client().req('POST', '/api/public/signup', { body: body({ cnpj: BAIXADA }) })).status, 422);
  assert.equal((await new Client().req('POST', '/api/public/signup', { body: body({ cnpj: FORA_DO_AR_2 }) })).status, 503, 'sem conferência não há autocadastro');
  const r = await new Client().req('POST', '/api/public/signup', { body: body() });
  assert.equal(r.status, 201, r.text);
  const co = get('SELECT * FROM companies WHERE cnpj = ?', AUTO);
  assert.equal(co.status, 'trial'); assert.equal(co.origin, 'self'); assert.ok(co.trial_ends_at < Date.now() + 8 * 86_400_000);
  assert.ok(get("SELECT 1 FROM outbox WHERE kind = 'signup' AND recipient = 'master@p.local'"), 'Master avisado');
  const f = new Client(); assert.equal((await f.login('fulana@auto.com.br', 'SenhaForte123')).status, 200);
  assert.equal((await f.req('GET', '/api/admin/me')).json.company.id, co.id);
  await master.req('PUT', '/api/admin/master/platform', { body: { signup: { enabled: false } } });
});

test('saúde: indicadores com nível e aviso de capacidade aos Masters (sem repetir)', async () => {
  const h = await master.req('GET', '/api/admin/master/health');
  assert.equal(h.status, 200);
  assert.ok(h.json.indicators.find((i) => i.key === 'companies'));
  const { checkCapacity } = require('../src/health');
  await master.req('PUT', '/api/admin/master/platform', { body: { capacity: { companiesLimit: 2, alertEmails: ['ti@plataforma.com.br'] } } });
  const r = checkCapacity();
  assert.ok(r.alerted.includes('companies'), JSON.stringify(r.alerted));
  assert.ok(get("SELECT 1 FROM outbox WHERE kind = 'capacity' AND recipient = 'ti@plataforma.com.br'"));
  assert.equal(checkCapacity().sent, 0, 'mesmo nível não repete o aviso');
  await master.req('PUT', '/api/admin/master/platform', { body: { capacity: { companiesLimit: 300 } } });
});

test('administrador convida usuário por e-mail (sem definir senha)', async () => {
  const branch = (await admin.req('POST', '/api/admin/branches', { body: { code: 'CV', name: 'Convite' } })).json.id;
  const r = await admin.req('POST', '/api/admin/users', { body: { name: 'Convidado', email: 'convidado@p.local', invite: true, branches: [branch] } });
  assert.equal(r.status, 201, r.text);
  assert.ok(get("SELECT 1 FROM outbox WHERE kind = 'invite' AND recipient = 'convidado@p.local'"));
  assert.equal((await admin.req('POST', '/api/admin/users', { body: { name: 'Sem senha', email: 'semsenha@p.local', branches: [branch] } })).status, 400, 'sem convite, a senha é obrigatória');
});
