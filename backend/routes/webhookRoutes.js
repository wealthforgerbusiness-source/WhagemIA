const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const userModel = require('../models/userModel');

// Mapping des IDs produits Chariow vers les plans WhagemIA
const PRODUCT_PLAN_MAP = {
  'prd_fymelhio': { plan: 'start', tokensInLimit: 1000000, tokensOutLimit: 1000000 },
  'prd_7mimbvzb': { plan: 'moyen', tokensInLimit: 2500000, tokensOutLimit: 2500000 },
  'prd_xv5afl3a': { plan: 'premium', tokensInLimit: 6000000, tokensOutLimit: 6000000 },
};

router.post(
  '/chariow',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const receivedSignature = req.header('x-chariow-signature') || '';
      const expectedSignature =
        'sha256=' +
        crypto
          .createHmac('sha256', process.env.CHARIOW_WEBHOOK_SECRET)
          .update(req.body)
          .digest('hex');

      const a = Buffer.from(receivedSignature);
      const b = Buffer.from(expectedSignature);

      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.warn('Signature Chariow invalide');
        return res.status(401).send('Invalid signature');
      }

      res.status(200).send('OK');

      const payload = JSON.parse(req.body.toString('utf8'));

      if (payload.event !== 'successful.sale') {
        return;
      }

      const productId = payload.product?.id;
      const customerEmail = payload.customer?.email;
      const planInfo = PRODUCT_PLAN_MAP[productId];

      if (!planInfo) {
        console.warn(`Produit inconnu reçu du webhook: ${productId}`);
        return;
      }

      if (!customerEmail) {
        console.warn('Webhook sans email client, impossible de traiter');
        return;
      }

      const user = await userModel.findUserByEmail(customerEmail);

      if (!user) {
        console.warn(`Aucun utilisateur trouvé pour l'email: ${customerEmail}`);
        return;
      }

      await userModel.updateUser(user.id, {
        plan: planInfo.plan,
        status: 'active',
        botEnabled: true,
        tokensInLimit: planInfo.tokensInLimit,
        tokensOutLimit: planInfo.tokensOutLimit,
        tokensInUsed: 0,
        tokensOutUsed: 0,
        subscriptionRenewsAt: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000
        ).toISOString(),
        lastReactivatedAt: new Date().toISOString(),
      });

      console.log(`Abonnement ${planInfo.plan} activé pour ${customerEmail}`);
    } catch (error) {
      console.error('Erreur webhook Chariow:', error.message);
    }
  }
);

module.exports = router;
