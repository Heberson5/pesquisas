'use strict';
// Matriz de permissões num lugar só. As rotas perguntam "pode?" (can) em vez de testar o papel.
//   • Master: tudo, em qualquer empresa (depois de "entrar na empresa").
//   • Administrador: tudo dentro da própria empresa.
//   • Gestor: o padrão abaixo, só nas unidades dele, mais o que o Administrador liberar para ele.
const { bad } = require('./validate');

const P = Object.freeze({
  DASHBOARD: 'dashboard.view',      // painel, respostas e relatórios
  EXPORT: 'responses.export',       // CSV e PowerPoint
  CASES: 'cases.manage',            // tratar casos e ver contato do cliente
  SURVEYS: 'surveys.manage',        // criar e alterar pesquisas (e enviar a mídia de agradecimento)
  BRANCH_EDIT: 'branches.edit',     // alterar dados, horário, fuso, alertas e QR Code das unidades
  BRANCH_CREATE: 'branches.create', // criar unidades novas
  DEVICES: 'devices.manage',        // parear e revogar tablets
  SCHEDULES: 'schedules.manage',    // campanhas agendadas
  USERS_GESTORES: 'users.gestores', // cadastrar gestores nas próprias unidades
  USERS: 'users.manage',            // todos os usuários da empresa
  PRIVACY: 'privacy.manage',        // LGPD: buscar, exportar e apagar dados de um cliente
  AUDIT: 'audit.view',              // auditoria
  SETTINGS: 'settings.manage',      // marca, ícones, e-mail, WhatsApp, alertas e LGPD da empresa
  DELETE_RESPONSES: 'responses.delete',
});

const ALL = Object.values(P);
const GESTOR_DEFAULT = [P.DASHBOARD, P.EXPORT, P.CASES, P.SURVEYS, P.BRANCH_EDIT, P.DEVICES, P.SCHEDULES];
// O que o Administrador pode liberar, pessoa por pessoa, para um Gestor. Nunca: excluir respostas,
// configurações da empresa, todos os usuários (nem nada do Master ou de faturamento).
const GRANTABLE = [P.BRANCH_CREATE, P.USERS_GESTORES, P.PRIVACY, P.AUDIT];

const LABELS = {
  [P.DASHBOARD]: 'Ver painel, respostas e relatórios',
  [P.EXPORT]: 'Exportar CSV e PowerPoint',
  [P.CASES]: 'Tratar casos e ver contato do cliente',
  [P.SURVEYS]: 'Criar e alterar pesquisas',
  [P.BRANCH_EDIT]: 'Alterar as próprias unidades (dados, horário, fuso, alertas, QR Code)',
  [P.BRANCH_CREATE]: 'Criar unidades novas',
  [P.DEVICES]: 'Parear e revogar tablets',
  [P.SCHEDULES]: 'Agendar campanhas',
  [P.USERS_GESTORES]: 'Cadastrar gestores nas próprias unidades',
  [P.USERS]: 'Gerenciar todos os usuários da empresa',
  [P.PRIVACY]: 'LGPD: buscar, exportar e apagar dados de um cliente',
  [P.AUDIT]: 'Ver a auditoria das próprias unidades',
  [P.SETTINGS]: 'Configurações da empresa',
  [P.DELETE_RESPONSES]: 'Excluir respostas',
};

function parseGrants(json) {
  try { const v = JSON.parse(json || '[]'); return Array.isArray(v) ? v.filter((p) => GRANTABLE.includes(p)) : []; } catch { return []; }
}

// Permissões efetivas de um usuário (dentro da empresa em uso).
function permissionsFor(role, grantsJson) {
  if (role === 'master' || role === 'admin') return new Set(ALL);
  if (role === 'gestor') return new Set([...GESTOR_DEFAULT, ...parseGrants(grantsJson)]);
  return new Set();
}

// Valida a lista enviada pela tela: só permissões liberáveis.
function grantsInput(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > GRANTABLE.length) throw bad('Permissões inválidas.');
  for (const p of v) if (!GRANTABLE.includes(p)) throw bad('Esta permissão não pode ser liberada para gestor.');
  return [...new Set(v)];
}

module.exports = { P, ALL, GESTOR_DEFAULT, GRANTABLE, LABELS, permissionsFor, parseGrants, grantsInput };
