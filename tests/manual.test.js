'use strict';
// Notas de versão e manual: o servidor só entrega (texto e imagens) o que o perfil/permissão da pessoa pode usar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, stop, Client, makeUser, run } = require('./helpers');
const manual = require('../src/manual');

let admin; let gestor; let master;
test.before(async () => {
  await start();
  makeUser('adm@man.local', 'admin'); admin = new Client(); await admin.login('adm@man.local', 'SenhaForte123');
  makeUser('ges@man.local', 'gestor'); gestor = new Client(); await gestor.login('ges@man.local', 'SenhaForte123');
  makeUser('mas@man.local', 'master'); master = new Client(); await master.login('mas@man.local', 'SenhaForte123');
});
test.after(stop);

const ids = (m) => m.sections.map((s) => s.id);
const text = (m) => JSON.stringify(m);

test('gestor só recebe as seções e novidades das permissões dele', async () => {
  const m = (await gestor.req('GET', '/api/admin/manual')).json;
  for (const id of ['painel', 'casos', 'pesquisas', 'unidades', 'tablets', 'primeiro-acesso']) assert.ok(ids(m).includes(id), id);
  for (const id of ['configuracoes', 'plano-faturamento', 'usuarios', 'excluir-respostas', 'lgpd', 'auditoria', 'criar-unidade', 'gestores', 'master-empresas', 'master-plataforma']) {
    assert.ok(!ids(m).includes(id), id);
  }
  assert.doesNotMatch(text(m), /Mercado Pago|Master|faturamento\.jpg|configuracoes\.jpg/i);
});

test('permissão liberada pelo administrador passa a mostrar a seção correspondente', async () => {
  run("UPDATE users SET permissions = ? WHERE email = 'ges@man.local'", JSON.stringify(['privacy.manage', 'branches.create']));
  const g = new Client(); await g.login('ges@man.local', 'SenhaForte123');
  const m = (await g.req('GET', '/api/admin/manual')).json;
  assert.ok(ids(m).includes('lgpd')); assert.ok(ids(m).includes('criar-unidade')); assert.ok(!ids(m).includes('usuarios'));
});

test('administrador vê a administração da empresa, mas nada do Master; Master vê tudo', async () => {
  const a = (await admin.req('GET', '/api/admin/manual')).json;
  for (const id of ['configuracoes', 'plano-faturamento', 'usuarios', 'excluir-respostas']) assert.ok(ids(a).includes(id), id);
  assert.ok(!ids(a).some((id) => id.startsWith('master-')));
  const m = (await master.req('GET', '/api/admin/manual')).json;
  assert.equal(m.sections.length, manual.SECTIONS.length);
});

test('imagens: só saem para quem pode ver a seção; nome inválido é recusado', async () => {
  assert.equal((await gestor.req('GET', '/api/admin/manual/img/faturamento.jpg')).status, 404);
  assert.equal((await gestor.req('GET', '/api/admin/manual/img/master-saude.jpg')).status, 404);
  assert.equal((await admin.req('GET', '/api/admin/manual/img/master-saude.jpg')).status, 404);
  assert.equal((await gestor.req('GET', '/api/admin/manual/img/painel.jpg')).status, 200);
  assert.equal((await admin.req('GET', '/api/admin/manual/img/faturamento.jpg')).status, 200);
  assert.equal((await master.req('GET', '/api/admin/manual/img/master-saude.jpg')).status, 200);
  for (const bad of ['..%2F..%2Fsrc%2Fdb.js', '.env', 'painel.svg']) assert.equal((await master.req('GET', '/api/admin/manual/img/' + bad)).status, 404, bad);
  assert.equal((await new Client().req('GET', '/api/admin/manual/img/painel.jpg')).status, 401);
});

test('todas as imagens citadas no manual existem', () => {
  for (const s of manual.SECTIONS) for (const i of s.images || []) assert.ok(fs.existsSync(path.join(__dirname, '..', 'manual', 'img', i.file)), i.file);
});

test('novidades: aparecem uma vez por versão', async () => {
  assert.equal((await admin.req('GET', '/api/admin/me')).json.whatsNew, true);
  await admin.req('POST', '/api/admin/manual/seen');
  assert.equal((await admin.req('GET', '/api/admin/me')).json.whatsNew, false);
});

test('telas do painel: toda página do menu é uma função declarada (evita erro de inicialização no navegador)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'admin.js'), 'utf8');
  const pages = src.slice(src.indexOf('const PAGES = ['), src.indexOf('];', src.indexOf('const PAGES = [')));
  const names = [...pages.matchAll(/\['[^']+', '[^']+', (\w+),/g)].map((m) => m[1]);
  assert.ok(names.length >= 15);
  for (const n of names) assert.match(src, new RegExp(`(async )?function ${n}\\(`), `${n} precisa ser "function ${n}(...)" (const daria erro antes de definida)`);
});
