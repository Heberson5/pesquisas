'use strict';
// Planos: limites de unidades, tablets, usuários e pesquisas; recursos (PowerPoint, webhook, WhatsApp);
// respostas nunca são recusadas, mas avisam a 80% e 100%; cadastro de planos pelo Master.
const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, Client, makeUser, get, run, newCompany } = require('./helpers');

let master; let admin; let cid; let planId;
const base = { welcome_title: 'Olá', thanks_title: 'Ok', thanks_seconds: 5, idle_seconds: 30, questions: [{ text: 'Nota?', type: 'nps', is_nps: true }] };

test.before(async () => {
  await start();
  makeUser('master@pl.local', 'master');
  master = new Client(); await master.login('master@pl.local', 'SenhaForte123');
  cid = newCompany('Empresa Plano');
  makeUser('adm@pl.local', 'admin', 'SenhaForte123', [], { companyId: cid });
  admin = new Client(); await admin.login('adm@pl.local', 'SenhaForte123');
});
test.after(stop);

test('Master cadastra plano com limites e recursos; valida; só o Master', async () => {
  const bad = [{ name: 'X', priceCents: 100 }, { name: 'Ok', priceCents: -1 }, { name: 'Ok', priceCents: 1, limits: { branches: -2 } }, { name: 'Ok', priceCents: 1, features: { pptx: 'sim' } }];
  for (const b of bad) assert.equal((await master.req('POST', '/api/admin/master/plans', { body: b })).status, 400, JSON.stringify(b));
  const r = await master.req('POST', '/api/admin/master/plans', { body: { name: 'Mínimo', priceCents: 9900,
    limits: { branches: 1, devices: 1, users: 2, surveys: 1, responsesMonth: 5 }, features: { pptx: false, webhook: false, whatsapp: false } } });
  assert.equal(r.status, 201, r.text); planId = r.json.id;
  assert.equal((await master.req('POST', '/api/admin/master/plans', { body: { name: 'mínimo', priceCents: 1 } })).status, 409, 'nome repetido');
  const list = (await master.req('GET', '/api/admin/master/plans')).json;
  assert.ok(list.plans.some((p) => p.name === 'Essencial'), 'planos iniciais criados pela migração');
  assert.equal((await admin.req('GET', '/api/admin/master/plans')).status, 403);
  assert.equal((await master.req('POST', `/api/admin/master/companies/${cid}/plan`, { body: { planId } })).status, 200);
  assert.equal((await master.req('DELETE', `/api/admin/master/plans/${planId}`)).status, 409, 'plano em uso não é excluído');
});

test('limites: unidade, tablet, pesquisa e usuário além do plano são recusados com explicação', async () => {
  const b1 = await admin.req('POST', '/api/admin/branches', { body: { code: 'A1', name: 'Uma' } });
  assert.equal(b1.status, 201);
  const b2 = await admin.req('POST', '/api/admin/branches', { body: { code: 'A2', name: 'Duas' } });
  assert.equal(b2.status, 403); assert.equal(b2.json.code, 'PLAN_LIMIT'); assert.match(b2.json.error, /1 de 1/);
  const inactive = await admin.req('POST', '/api/admin/branches', { body: { code: 'A3', name: 'Inativa', active: false } });
  assert.equal(inactive.status, 201, 'unidade inativa não conta');
  assert.equal((await admin.req('PUT', `/api/admin/branches/${inactive.json.id}`, { body: { code: 'A3', name: 'Inativa', active: true } })).status, 403, 'reativar respeita o limite');
  assert.equal((await admin.req('POST', '/api/admin/devices', { body: { branchId: b1.json.id, name: 'T1' } })).status, 201);
  assert.equal((await admin.req('POST', '/api/admin/devices', { body: { branchId: b1.json.id, name: 'T2' } })).status, 403);
  const s1 = await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Pesquisa um' } });
  assert.equal(s1.status, 201);
  assert.equal((await admin.req('POST', '/api/admin/surveys', { body: { ...base, title: 'Pesquisa dois' } })).status, 403);
  assert.equal((await admin.req('POST', `/api/admin/surveys/${s1.json.id}/duplicate`)).status, 403);
  assert.equal((await admin.req('POST', '/api/admin/users', { body: { name: 'G1', email: 'g1@pl.local', password: 'SenhaForte123', branches: [b1.json.id] } })).status, 201);
  assert.equal((await admin.req('POST', '/api/admin/users', { body: { name: 'G2', email: 'g2@pl.local', password: 'SenhaForte123', branches: [b1.json.id] } })).status, 403);
  const view = (await admin.req('GET', '/api/admin/plan')).json;
  assert.equal(view.plan.name, 'Mínimo');
  assert.deepEqual(view.rows.find((r) => r.key === 'branches'), { key: 'branches', label: 'Unidades', used: 1, max: 1, pct: 100 });
});

test('recursos fora do plano: PowerPoint e webhook bloqueados; empresa sem plano não tem limites', async () => {
  const p = await admin.req('GET', '/api/admin/report.pptx');
  assert.equal(p.status, 403); assert.equal(p.json.code, 'PLAN_FEATURE');
  assert.equal((await admin.req('PUT', '/api/admin/settings', { body: { alerts: { webhookUrl: 'https://hooks.exemplo.com/x' } } })).status, 403);
  assert.equal((await master.req('POST', `/api/admin/master/companies/${cid}/plan`, { body: { planId: null } })).status, 200);
  assert.equal((await admin.req('POST', '/api/admin/branches', { body: { code: 'A9', name: 'Sem limite' } })).status, 201);
  assert.equal((await admin.req('GET', '/api/admin/report.pptx')).status, 200);
  await master.req('POST', `/api/admin/master/companies/${cid}/plan`, { body: { planId } });
});

test('respostas além do plano são recebidas, com aviso a 80% e 100% (uma vez por nível)', async () => {
  const branch = get("SELECT id FROM branches WHERE company_id = ? AND code = 'A1'", cid).id;
  const survey = get('SELECT id FROM surveys WHERE company_id = ? LIMIT 1', cid).id;
  run('UPDATE branches SET survey_id = ? WHERE id = ?', survey, branch);
  const q = get('SELECT id FROM questions WHERE survey_id = ?', survey).id;
  const dev = get('SELECT id FROM devices WHERE company_id = ? LIMIT 1', cid).id;
  const code = (await admin.req('POST', `/api/admin/devices/${dev}/pairing-code`)).json.code;
  const tok = (await new Client().req('POST', '/api/kiosk/pair', { body: { code } })).json.token;
  const send = () => new Client().req('POST', '/api/kiosk/responses', { headers: { Authorization: 'Bearer ' + tok },
    body: { uuid: crypto.randomUUID(), surveyId: survey, answers: [{ questionId: q, value: 9 }] } });
  for (let i = 0; i < 7; i++) assert.equal((await send()).status, 201, 'nunca recusa resposta');
  const mails = get("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'quota' AND company_id = ? AND recipient = 'adm@pl.local'", cid).n;
  assert.equal(mails, 2, '80% e 100%, sem repetir');
  assert.ok(get("SELECT 1 FROM outbox WHERE kind = 'quota' AND recipient = 'master@pl.local'"), 'Master também é avisado');
});
