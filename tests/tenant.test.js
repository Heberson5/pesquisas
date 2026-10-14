'use strict';
// Multiempresa: uma empresa nunca vê nem altera nada de outra; Master entra na empresa com motivo e prazo;
// permissões liberáveis do gestor; criptografia com chave própria de cada empresa; varredura do SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, stop, Client, makeUser, get, run, COMPANY, newCompany } = require('./helpers');
const { decryptFor } = require('../src/companies');

const A = { id: COMPANY }; const B = {};
let master;
const kiosk = (tok, body) => new Client().req('POST', '/api/kiosk/responses', { body, headers: { Authorization: 'Bearer ' + tok } });

// Monta uma empresa completa: administrador, unidade, pesquisa, tablet, resposta com contato (gera caso) e usuário gestor.
async function setup(c, tag) {
  makeUser(`adm@${tag}.local`, 'admin', 'SenhaForte123', [], { companyId: c.id });
  c.admin = new Client(); await c.admin.login(`adm@${tag}.local`, 'SenhaForte123');
  c.branch = (await c.admin.req('POST', '/api/admin/branches', { body: { code: tag.toUpperCase(), name: `Unidade ${tag}` } })).json.id;
  c.survey = (await c.admin.req('POST', '/api/admin/surveys', { body: { title: `Pesquisa ${tag}`, welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    contact_mode: 'always', questions: [{ text: 'Nota?', type: 'nps', is_nps: true }, { text: 'Comente', type: 'text' }] } })).json.id;
  await c.admin.req('PUT', `/api/admin/branches/${c.branch}/survey`, { body: { surveyId: c.survey } });
  c.q = (await c.admin.req('GET', `/api/admin/surveys/${c.survey}`)).json.questions;
  const d = await c.admin.req('POST', '/api/admin/devices', { body: { branchId: c.branch, name: `Tablet ${tag}` } });
  c.device = d.json.id;
  c.tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } })).json.token;
  const r = await kiosk(c.tok, { uuid: crypto.randomUUID(), surveyId: c.survey, answers: [{ questionId: c.q[0].id, value: 2 }, { questionId: c.q[1].id, value: `Segredo da ${tag}` }],
    contact: { name: `Cliente ${tag}`, phone: '11988887777', consent: true } });
  assert.equal(r.status, 201, r.text);
  c.response = get('SELECT id FROM responses WHERE company_id = ? ORDER BY id DESC LIMIT 1', c.id).id;
  c.case = get('SELECT id FROM cases WHERE company_id = ? ORDER BY id DESC LIMIT 1', c.id)?.id;
  c.schedule = (await c.admin.req('POST', '/api/admin/schedules', { body: { surveyId: c.survey, branchId: c.branch, startsAt: '2030-01-01T08:00', endsAt: '2030-01-02T08:00' } })).json.id;
  c.gestorId = makeUser(`gestor@${tag}.local`, 'gestor', 'SenhaForte123', [c.branch], { companyId: c.id });
}

test.before(async () => {
  await start();
  B.id = newCompany('Empresa Beta');
  await setup(A, 'alfa');
  await setup(B, 'beta');
  makeUser('master@plataforma.local', 'master');
  master = new Client(); await master.login('master@plataforma.local', 'SenhaForte123');
});
test.after(stop);

test('listas da empresa A não mostram nada da empresa B', async () => {
  for (const url of ['/api/admin/branches', '/api/admin/surveys', '/api/admin/devices', '/api/admin/responses', '/api/admin/users', '/api/admin/audit',
    '/api/admin/stats', '/api/admin/schedules', '/api/admin/cases', '/api/admin/settings/notifications']) {
    const r = await A.admin.req('GET', url);
    assert.equal(r.status, 200, url + ' ' + r.text);
    assert.doesNotMatch(r.text, /beta|Beta/, url);
  }
  const csv = await A.admin.req('GET', '/api/admin/responses.csv');
  assert.doesNotMatch(csv.text, /beta|Beta/);
});

test('empresa A não lê nem altera recursos da empresa B pelo id (404/400, nada muda)', async () => {
  const a = A.admin;
  const tries = [
    ['GET', `/api/admin/surveys/${B.survey}`], ['PUT', `/api/admin/surveys/${B.survey}`, { title: 'Invadida', welcome_title: 'x', thanks_title: 'x', thanks_seconds: 5, idle_seconds: 30, questions: [{ text: 'X?', type: 'nps' }] }],
    ['POST', `/api/admin/surveys/${B.survey}/duplicate`], ['GET', `/api/admin/surveys/${B.survey}/breakdown`],
    ['PUT', `/api/admin/branches/${B.branch}`, { code: 'ZZ', name: 'Invadida' }], ['PUT', `/api/admin/branches/${B.branch}/survey`, { surveyId: A.survey }],
    ['PUT', `/api/admin/branches/${A.branch}/survey`, { surveyId: B.survey }],
    ['GET', `/api/admin/branches/${B.branch}/public-link`], ['POST', `/api/admin/branches/${B.branch}/public-link`, { enabled: true }],
    ['POST', '/api/admin/devices', { branchId: B.branch, name: 'Intruso' }], ['POST', `/api/admin/devices/${B.device}/revoke`], ['POST', `/api/admin/devices/${B.device}/pairing-code`],
    ['DELETE', `/api/admin/responses/${B.response}`], ['DELETE', `/api/admin/schedules/${B.schedule}`],
    ['POST', '/api/admin/schedules', { surveyId: B.survey, branchId: A.branch, startsAt: '2030-01-01T08:00', endsAt: '2030-01-02T08:00' }],
    ['PUT', `/api/admin/users/${B.gestorId}`, { name: 'Invadido', email: 'gestor@beta.local', branches: [] }],
    ['POST', '/api/admin/users', { name: 'Novo', email: 'novo@alfa.local', password: 'SenhaForte123', branches: [B.branch] }],
    ['GET', `/api/admin/cases/${B.case}`], ['PUT', `/api/admin/cases/${B.case}`, { status: 'resolvido' }],
    ['GET', `/api/admin/responses?branchId=${B.branch}`], ['GET', `/api/admin/stats?surveyId=${B.survey}`],
  ];
  for (const [m, url, body] of tries) {
    const r = await a.req(m, url, body ? { body } : {});
    assert.ok([400, 404].includes(r.status), `${m} ${url} → ${r.status} ${r.text}`);
    assert.doesNotMatch(r.text, /Segredo|Cliente beta/, url);
  }
  assert.equal(get('SELECT name FROM branches WHERE id = ?', B.branch).name, 'Unidade beta');
  assert.equal(get('SELECT active FROM devices WHERE id = ?', B.device).active, 1);
  assert.ok(get('SELECT 1 FROM responses WHERE id = ?', B.response));
  assert.ok(get('SELECT 1 FROM schedules WHERE id = ?', B.schedule));
  assert.equal(get('SELECT name FROM users WHERE id = ?', B.gestorId).name, 'gestor@beta.local');
  // Exclusão em lote só alcança a própria empresa.
  const n = get('SELECT COUNT(*) AS n FROM responses WHERE company_id = ?', B.id).n;
  await a.req('POST', '/api/admin/responses/delete-filtered', { body: { confirm: 'EXCLUIR', filter: { branchId: String(B.branch) } } });
  assert.equal(get('SELECT COUNT(*) AS n FROM responses WHERE company_id = ?', B.id).n, n);
});

test('mídia, LGPD e configurações também são separadas por empresa', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await B.admin.req('POST', '/api/admin/media', { raw: png, headers: { 'Content-Type': 'image/png' } });
  assert.equal(up.status, 201, up.text);
  assert.ok(fs.existsSync(path.join(process.env.MEDIA_DIR, String(B.id), up.json.id)), 'arquivo fica na pasta da empresa');
  assert.equal((await A.admin.req('PUT', '/api/admin/settings', { body: { logoMediaId: up.json.id } })).status, 400, 'A não usa a mídia de B');
  const found = await A.admin.req('POST', '/api/admin/privacy/search', { body: { phone: '11988887777' } });
  assert.equal(found.status, 200);
  assert.ok(found.json.length >= 1 && found.json.every((r) => !/beta/i.test(r.branch)), found.text);
  await A.admin.req('PUT', '/api/admin/settings', { body: { companyName: 'Alfa Ltda' } });
  assert.notEqual((await B.admin.req('GET', '/api/admin/settings')).json.companyName, 'Alfa Ltda');
  assert.equal((await new Client().req('GET', '/api/public/branding?empresa=empresa-beta')).json.companyName === 'Alfa Ltda', false);
});

test('contato criptografado com a chave da própria empresa: a chave de outra empresa não abre', async () => {
  const enc = get('SELECT contact_phone_enc FROM responses WHERE id = ?', B.response).contact_phone_enc;
  assert.match(enc, new RegExp(`^c1\\.${B.id}\\.`));
  assert.ok(decryptFor(B.id, enc));
  assert.equal(decryptFor(A.id, enc), null);
  const lookA = get('SELECT contact_phone_lookup FROM responses WHERE id = ?', A.response).contact_phone_lookup;
  const lookB = get('SELECT contact_phone_lookup FROM responses WHERE id = ?', B.response).contact_phone_lookup;
  assert.notEqual(lookA, lookB, 'mesmo telefone gera índices diferentes em cada empresa');
});

test('tablet de uma empresa não envia para pesquisa de outra', async () => {
  const r = await kiosk(A.tok, { uuid: crypto.randomUUID(), surveyId: B.survey, answers: [{ questionId: B.q[0].id, value: 9 }] });
  assert.notEqual(r.status, 201);
  assert.equal(get('SELECT COUNT(*) AS n FROM responses WHERE survey_id = ? AND company_id <> ?', B.survey, B.id).n, 0);
});

test('Master: sem empresa escolhida só vê a lista; entra com motivo, por tempo limitado, e fica na auditoria', async () => {
  const blocked = await master.req('GET', '/api/admin/branches');
  assert.equal(blocked.status, 409); assert.equal(blocked.json.code, 'COMPANY_REQUIRED');
  const list = await master.req('GET', '/api/admin/master/companies');
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.map((c) => c.name).sort(), ['Empresa Beta', 'Empresa Teste']);
  assert.equal((await A.admin.req('GET', '/api/admin/master/companies')).status, 403, 'administrador não é Master');
  assert.equal((await master.req('POST', '/api/admin/master/act', { body: { companyId: B.id, reason: 'x' } })).status, 400, 'motivo obrigatório');
  assert.equal((await master.req('POST', '/api/admin/master/act', { body: { companyId: 999, reason: 'Suporte ao cliente' } })).status, 404);
  const act = await master.req('POST', '/api/admin/master/act', { body: { companyId: B.id, reason: 'Suporte: limpeza de testes' } });
  assert.equal(act.status, 200);
  const me = (await master.req('GET', '/api/admin/me')).json;
  assert.equal(me.company.id, B.id); assert.ok(me.acting.until > Date.now());
  const br = await master.req('GET', '/api/admin/branches');
  assert.match(br.text, /Unidade beta/); assert.doesNotMatch(br.text, /Unidade alfa/);
  // Master exclui resposta em qualquer empresa (depois de entrar nela), com auditoria marcada.
  assert.equal((await master.req('DELETE', `/api/admin/responses/${B.response}`)).status, 200);
  const logs = (await B.admin.req('GET', '/api/admin/audit')).json;
  assert.ok(logs.some((l) => l.action === 'master.enter_company' && l.as_master === 1));
  assert.ok(logs.some((l) => l.action === 'response.delete' && l.as_master === 1));
  assert.ok(!(await A.admin.req('GET', '/api/admin/audit')).json.some((l) => l.action === 'master.enter_company'));
  // Prazo vencido: volta a ficar sem empresa.
  run('UPDATE sessions SET acting_until = ? WHERE acting_company_id = ?', Date.now() - 1, B.id);
  assert.equal((await master.req('GET', '/api/admin/branches')).status, 409);
  await master.req('POST', '/api/admin/master/act', { body: { companyId: A.id, reason: 'Conferência de dados' } });
  assert.equal((await master.req('POST', '/api/admin/master/leave')).status, 200);
  assert.equal((await master.req('GET', '/api/admin/branches')).status, 409);
});

test('empresa cancelada: login bloqueado, sessões derrubadas e tablets param', async () => {
  const C = { id: newCompany('Empresa Cancelada') };
  await setup(C, 'gama');
  run("UPDATE companies SET status = 'canceled' WHERE id = ?", C.id);
  assert.equal((await C.admin.req('GET', '/api/admin/branches')).status, 403);
  assert.equal((await new Client().login('adm@gama.local', 'SenhaForte123')).status, 403);
  const r = await kiosk(C.tok, { uuid: crypto.randomUUID(), surveyId: C.survey, answers: [{ questionId: C.q[0].id, value: 9 }] });
  assert.equal(r.status, 423);
  run("UPDATE companies SET status = 'suspended' WHERE id = ?", C.id);
  assert.equal((await new Client().req('GET', '/api/kiosk/config', { headers: { Authorization: 'Bearer ' + C.tok } })).status, 423);
});

test('permissões liberáveis: gestor só cria unidade quando o administrador libera', async () => {
  const g = new Client(); await g.login('gestor@alfa.local', 'SenhaForte123');
  assert.equal((await g.req('POST', '/api/admin/branches', { body: { code: 'G1', name: 'Nova do gestor' } })).status, 403);
  const me = (await g.req('GET', '/api/admin/me')).json;
  assert.ok(!me.user.permissions.includes('branches.create'));
  assert.ok(!me.user.permissions.includes('responses.delete'));
  // Permissão que nunca pode ser liberada para gestor.
  assert.equal((await A.admin.req('PUT', `/api/admin/users/${A.gestorId}`, { body: { name: 'Gestor', email: 'gestor@alfa.local', branches: [A.branch], permissions: ['responses.delete'] } })).status, 400);
  assert.equal((await A.admin.req('PUT', `/api/admin/users/${A.gestorId}`, { body: { name: 'Gestor', email: 'gestor@alfa.local', branches: [A.branch], permissions: ['branches.create', 'users.gestores'] } })).status, 200);
  assert.equal((await g.req('GET', '/api/admin/me')).status, 401, 'mudança de permissão derruba a sessão');
  await g.login('gestor@alfa.local', 'SenhaForte123');
  const nb = await g.req('POST', '/api/admin/branches', { body: { code: 'G1', name: 'Nova do gestor' } });
  assert.equal(nb.status, 201);
  assert.ok((await g.req('GET', '/api/admin/branches')).json.some((b) => b.id === nb.json.id), 'gestor fica responsável pela unidade que criou');
  // Cadastrar gestores: só gestor, só nas próprias unidades, sem liberar permissões.
  assert.equal((await g.req('POST', '/api/admin/users', { body: { name: 'Adm', email: 'adm2@alfa.local', password: 'SenhaForte123', role: 'admin' } })).status, 403);
  const other = (await A.admin.req('POST', '/api/admin/branches', { body: { code: 'OX', name: 'Outra' } })).json.id;
  assert.equal((await g.req('POST', '/api/admin/users', { body: { name: 'G2', email: 'g2@alfa.local', password: 'SenhaForte123', branches: [other] } })).status, 403);
  const created = await g.req('POST', '/api/admin/users', { body: { name: 'G2', email: 'g2@alfa.local', password: 'SenhaForte123', branches: [A.branch], permissions: ['audit.view'] } });
  assert.equal(created.status, 201, created.text);
  assert.equal(get('SELECT permissions FROM users WHERE id = ?', created.json.id).permissions, null, 'gestor não libera permissões');
  const users = (await g.req('GET', '/api/admin/users')).json;
  assert.ok(users.every((u) => u.role === 'gestor'), 'não enxerga administradores');
});

test('varredura do SQL: toda consulta a tabela de empresa filtra por company_id (ou explica o porquê)', () => {
  const TENANT = ['branches', 'surveys', 'media', 'devices', 'responses', 'cases', 'schedules', 'outbox', 'users', 'audit_log', 'company_settings'];
  const files = [];
  (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } })(path.join(__dirname, '..', 'src'));
  files.push(path.join(__dirname, '..', 'server.js'));
  const literal = /(`[^`]*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g;
  const problems = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = literal.exec(src))) {
      const sql = m[1];
      if (!/^.\s*(SELECT|UPDATE|DELETE|INSERT|WITH)\b/i.test(sql)) continue;
      if (!TENANT.some((t) => new RegExp(`\\b(FROM|JOIN|UPDATE|INTO)\\s+${t}\\b`, 'i').test(sql))) continue;
      // ${f.sql}/${geoWhere}: filtros montados por responseFilter/caseFilter, que sempre começam por company_id.
      if (/company_id|tenant-ok:|\$\{f\.sql\}|\$\{geoWhere\}/.test(sql)) continue;
      problems.push(`${path.relative(path.join(__dirname, '..'), f)}:${src.slice(0, m.index).split('\n').length} ${sql.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.deepEqual(problems, []);
  // E os filtros reaproveitados realmente começam pela empresa.
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'stats.js'), 'utf8'), /r\.company_id = \?/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'cases.js'), 'utf8'), /\['c\.company_id = \?'\]/);
});

test('gestor que cadastra gestores não assume a conta de outro gestor nem herda permissões', async () => {
  const b1 = (await A.admin.req('POST', '/api/admin/branches', { body: { code: 'TK1', name: 'Takeover 1' } })).json.id;
  const b2 = (await A.admin.req('POST', '/api/admin/branches', { body: { code: 'TK2', name: 'Takeover 2' } })).json.id;
  const g1 = makeUser('g1@tk.local', 'gestor', 'SenhaForte123', [b1, b2], { companyId: A.id, permissions: ['users.gestores'] });
  const g2 = makeUser('g2@tk.local', 'gestor', 'SenhaForte123', [b1], { companyId: A.id, permissions: ['privacy.manage'] });
  const g3 = makeUser('g3@tk.local', 'gestor', 'SenhaForte123', [b1], { companyId: A.id });
  void g1;
  const c = new Client(); await c.login('g1@tk.local', 'SenhaForte123');
  const list = (await c.req('GET', '/api/admin/users')).json.map((u) => u.email);
  assert.ok(list.includes('g3@tk.local')); assert.ok(!list.includes('g2@tk.local'), 'não vê quem tem permissão que ele não tem');
  assert.equal((await c.req('PUT', `/api/admin/users/${g2}`, { body: { name: 'G2', email: 'g2@tk.local', branches: [b1], password: 'NovaSenha12345' } })).status, 404);
  assert.equal((await c.req('PUT', `/api/admin/users/${g3}`, { body: { name: 'G3', email: 'g3@tk.local', branches: [b1], password: 'NovaSenha12345' } })).status, 403, 'não troca a senha de outro');
  assert.equal((await c.req('PUT', `/api/admin/users/${g3}`, { body: { name: 'G3', email: 'meu@atacante.com', branches: [b1] } })).status, 403, 'não troca o e-mail de outro');
  assert.equal((await c.req('PUT', `/api/admin/users/${g3}`, { body: { name: 'G3', email: 'g3@tk.local', branches: [b1], resetMfa: true } })).status, 403);
  assert.equal((await c.req('PUT', `/api/admin/users/${g3}`, { body: { name: 'Gestor Três', email: 'g3@tk.local', branches: [b1, b2] } })).status, 200, 'nome e unidades pode');
  assert.equal((await new Client().login('g3@tk.local', 'SenhaForte123')).status, 200, 'senha intacta');
});

test('gestor não altera pesquisa que já tem respostas de unidade fora do escopo dele', async () => {
  const outra = (await A.admin.req('POST', '/api/admin/branches', { body: { code: 'SV2', name: 'Outra unidade' } })).json.id;
  const sv = (await A.admin.req('POST', '/api/admin/surveys', { body: { title: 'Histórico', welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30,
    questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] } })).json.id;
  await A.admin.req('PUT', `/api/admin/branches/${outra}/survey`, { body: { surveyId: sv } });
  const d = await A.admin.req('POST', '/api/admin/devices', { body: { branchId: outra, name: 'Tablet SV2' } });
  const pr = await new Client().req('POST', '/api/kiosk/pair', { body: { code: d.json.code } });
  assert.equal(pr.status, 200, JSON.stringify([d.status, d.text, pr.text]));
  const tok = pr.json.token;
  const q = (await A.admin.req('GET', `/api/admin/surveys/${sv}`)).json.questions[0].id;
  assert.equal((await kiosk(tok, { uuid: crypto.randomUUID(), surveyId: sv, answers: [{ questionId: q, value: 3 }] })).status, 201);
  await A.admin.req('PUT', `/api/admin/branches/${outra}/survey`, { body: { surveyId: null } });
  const g = new Client(); await g.login('gestor@alfa.local', 'SenhaForte123');
  const body = { title: 'Mudada', welcome_title: 'x', thanks_title: 'x', thanks_seconds: 5, idle_seconds: 30, questions: [{ text: 'Outra?', type: 'nps' }] };
  assert.equal((await g.req('PUT', `/api/admin/surveys/${sv}`, { body })).status, 403);
  const listed = (await g.req('GET', '/api/admin/surveys')).json.find((s) => s.id === sv);
  assert.equal(listed.editable, false); assert.equal(listed.responses, 0, 'não vê o volume de outras unidades');
});
