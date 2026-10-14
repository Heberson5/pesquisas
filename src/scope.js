'use strict';
// Escopo por empresa e por unidade. Toda checagem de unidade confere PRIMEIRO a empresa em uso:
// um id de unidade de outra empresa é tratado como inexistente (404), nunca como "sem permissão".
const { get } = require('./db');
const { HttpError } = require('./validate');

// null = todas as unidades da empresa (Master e Administrador); senão a lista do gestor.
const scope = (user) => (user.role === 'gestor' ? (user.scope || []) : null);

function assertBranch(user, branchId) {
  const b = get('SELECT id FROM branches WHERE id = ? AND company_id = ?', branchId, user.companyId);
  const s = scope(user);
  if (!b || (s && !s.includes(branchId))) throw new HttpError(404, 'Unidade não encontrada.');
}

const placeholders = (arr) => arr.map(() => '?').join(',');

module.exports = { scope, assertBranch, placeholders };
