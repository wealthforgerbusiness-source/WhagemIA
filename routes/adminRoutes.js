const express = require('express');
const router = express.Router();
const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const { verifyAdmin } = require('../middleware/adminMiddleware');
const { db } = require('../config/firebase');

const CHARIOW_FEE_PERCENT = 0.15; // confirmé : Chariow prend 15% par vente

// Prix Gemini 3.1 Flash Lite (à réajuster si Google change ses tarifs)
const GEMINI_INPUT_PRICE_PER_M = 0.25;  // $ / 1M tokens entrée
const GEMINI_OUTPUT_PRICE_PER_M = 1.50; // $ / 1M tokens sortie

// Coût fixe mensuel d'hébergement (Render Starter + disque persistant ~1 Go).
// À AJUSTER si tu changes de plan Render.
const RENDER_MONTHLY_COST = 7.25;

router.get('/overview', verifyFirebaseToken, verifyAdmin, async (req, res) => {
  try {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    const stats = {
      totalUsers: users.length,
      activeUsers: users.filter((u) => u.status === 'active').length,
      expiredUsers: users.filter((u) => u.status === 'expired').length,
      trialUsers: users.filter((u) => u.plan === 'trial').length,
      startUsers: users.filter((u) => u.plan === 'start').length,
      moyenUsers: users.filter((u) => u.plan === 'moyen').length,
      premiumUsers: users.filter((u) => u.plan === 'premium').length,
      botsActive: users.filter((u) => u.botEnabled).length,
    };

    // MRR : revenu récurrent mensuel brut (abonnements payants actifs uniquement)
    const planPrices = { start: 5, moyen: 10, premium: 20 };
    const mrr = users
      .filter((u) => u.status === 'active' && planPrices[u.plan])
      .reduce((sum, u) => sum + planPrices[u.plan], 0);

    const chariowFees = mrr * CHARIOW_FEE_PERCENT;
    const netAfterChariow = mrr - chariowFees;

    // Coût Gemini RÉEL basé sur la conso effective (tous les utilisateurs,
    // essais gratuits inclus — ces tokens coûtent aussi de l'argent réel)
    const estimatedGeminiCost = users.reduce((sum, u) => {
      const inCost = ((u.tokensInUsed || 0) / 1_000_000) * GEMINI_INPUT_PRICE_PER_M;
      const outCost = ((u.tokensOutUsed || 0) / 1_000_000) * GEMINI_OUTPUT_PRICE_PER_M;
      return sum + inCost + outCost;
    }, 0);

    const estimatedMonthlyProfit =
      netAfterChariow - estimatedGeminiCost - RENDER_MONTHLY_COST;

    const round2 = (n) => Math.round(n * 100) / 100;

    stats.mrr = round2(mrr);
    stats.chariowFees = round2(chariowFees);
    stats.estimatedGeminiCost = round2(estimatedGeminiCost);
    stats.renderMonthlyCost = RENDER_MONTHLY_COST;
    stats.estimatedMonthlyProfit = round2(estimatedMonthlyProfit);

    res.json({ stats, users });
  } catch (error) {
    console.error('Erreur admin overview:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
