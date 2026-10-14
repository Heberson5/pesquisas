'use strict';
// Notificações do Mercado Pago (pagamentos e assinaturas).
// Segurança: confere a assinatura x-signature (HMAC-SHA256 com a "assinatura secreta" do painel do Mercado Pago),
// recusa notificação velha, e NUNCA confia no conteúdo: busca o pagamento/assinatura na API antes de dar baixa.
// Cada evento é processado uma única vez (tabela billing_events).
const express = require('express');
const { audit } = require('../db');
const { rateLimiter } = require('../security');
const mp = require('../mercadopago');
const billing = require('../billing');

const router = express.Router();
router.use(rateLimiter({ windowMs: 60_000, max: 300, message: 'Muitas notificações.' }));

router.post('/mercadopago', async (req, res) => {
  const topic = String(req.query.type || req.query.topic || req.body?.type || req.body?.topic || '').slice(0, 64);
  const dataId = String(req.query['data.id'] || req.query.id || req.body?.data?.id || '').slice(0, 64);
  const sig = mp.verifySignature({ signature: req.get('x-signature'), requestId: req.get('x-request-id'), dataId });
  if (!sig.ok) {
    // Sem a assinatura secreta configurada, segue (a baixa só acontece depois de consultar a API); com ela, recusa.
    if (mp.credentials().webhookSecret) {
      audit(null, 'billing.webhook_rejected', { topic, dataId, reason: sig.reason }, req.ip, { companyId: null });
      return res.status(401).json({ error: 'Assinatura inválida.' });
    }
  }
  if (!topic || !dataId) return res.status(200).json({ ok: true, ignored: true });
  try {
    const r = await billing.handleNotification(topic, dataId);
    res.status(200).json({ ok: true, ...r });
  } catch (e) {
    // 5xx faz o Mercado Pago tentar de novo mais tarde.
    console.error('[mercadopago] notificação', topic, dataId, e.message);
    res.status(e.mpStatus === 404 ? 200 : 503).json({ ok: false });
  }
});

module.exports = router;
