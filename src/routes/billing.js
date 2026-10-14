'use strict';
// Faturamento da empresa em uso (Administrador): situação, faturas e assinatura no cartão pelo Mercado Pago.
// Funciona também com a empresa suspensa (é a única tela liberada nesse caso).
const express = require('express');
const { requireCompany, requirePerm } = require('../auth');
const { P } = require('../permissions');
const { rateLimiter } = require('../security');
const billing = require('../billing');

const router = express.Router();
router.use('/billing', requireCompany);

router.get('/billing', (req, res) => {
  const o = billing.overview(req.user.companyId);
  // Gestor só fica sabendo da situação (para pedir ao administrador); valores e faturas são do administrador.
  if (!req.user.can(P.SETTINGS)) return res.json({ company: { status: o.company.status, status_reason: o.company.status_reason, lock_kind: o.company.lock_kind }, locked: o.locked, limited: true });
  res.json(o);
});

const subLimiter = rateLimiter({ windowMs: 60 * 60_000, max: 10, keyFn: (req) => 'sub:' + req.user.companyId, message: 'Muitas tentativas. Aguarde um pouco.' });
router.post('/billing/subscribe', requirePerm(P.SETTINGS), subLimiter, async (req, res) => {
  res.json(await billing.startCardSubscription(req.user.companyId, req.user));
});

module.exports = router;
