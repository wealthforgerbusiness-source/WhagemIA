const express = require('express');
const router = express.Router();
const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const { verifyAdmin } = require('../middleware/adminMiddleware');
const { db } = require('../config/firebase');

// Vue d'ensemble : tous les utilisateurs + stats globales
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

    // Revenu mensuel estimé (avant frais Chariow)
    const planPrices = { start: 5, moyen: 10, premium: 20 };
    stats.estimatedMonthlyRevenue = users
      .filter((u) => u.status === 'active' && planPrices[u.plan])
      .reduce((sum, u) => sum + planPrices[u.plan], 0);

    res.json({ stats, users });
  } catch (error) {
    console.error('Erreur admin overview:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
