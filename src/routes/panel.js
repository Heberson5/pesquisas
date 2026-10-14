'use strict';
// API do painel. Todas as rotas daqui exigem sessão (login, 2FA e recuperação de senha ficam em routes/auth.js).
// Ordem: conta do usuário e rotas do Master (funcionam sem empresa em uso) → rotas da empresa em uso.
const express = require('express');
const { requireUser } = require('../auth');

const router = express.Router();
router.use(requireUser);
router.use(require('./account'));
router.use(require('./master'));
router.use(require('./branches'));
router.use(require('./surveys'));
router.use(require('./responses'));
router.use(require('./users'));
router.use(require('./settings'));

module.exports = router;
