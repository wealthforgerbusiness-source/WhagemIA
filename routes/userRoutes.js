const express = require('express');
const router = express.Router();
const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const baileysService = require('../services/baileysService');

// Récupérer les infos du dashboard utilisateur (quotas, statut, etc.)
router.get('/me', verifyFirebaseToken, async (req, res) => {
  try {
    const user = await userModel.getUserById(req.firebaseUid);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    const session = await sessionModel.getSessionStatus(req.firebaseUid);

    res.json({
      ...user,
      session: session || { connected: false },
    });
  } catch (error) {
    console.error('Erreur /me:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Activer / désactiver le bot manuellement depuis le dashboard
router.post('/toggle-bot', verifyFirebaseToken, async (req, res) => {
  try {
    const user = await userModel.getUserById(req.firebaseUid);

    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    if (user.status === 'expired') {
      return res.status(403).json({
        error: 'Abonnement expiré, impossible de réactiver le bot sans paiement',
      });
    }

    const newBotEnabled = !user.botEnabled;

    // Si on réactive le bot, on met à jour le timestamp pour ignorer les anciens messages
    if (newBotEnabled) {
      await sessionModel.setLastProcessedTimestamp(
        req.firebaseUid,
        new Date().toISOString()
      );
    }

    await userModel.updateUser(req.firebaseUid, { botEnabled: newBotEnabled });

    res.json({ botEnabled: newBotEnabled });
  } catch (error) {
    console.error('Erreur /toggle-bot:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Modifier les instructions de l'IA après la connexion initiale
router.patch('/prompt', verifyFirebaseToken, async (req, res) => {
  try {
    const { businessPrompt } = req.body;

    if (!businessPrompt || businessPrompt.trim().length < 10) {
      return res.status(400).json({
        error: 'Description de l\'entreprise requise (au moins 10 caractères)',
      });
    }

    await userModel.updateUser(req.firebaseUid, { businessPrompt: businessPrompt.trim() });

    // Si une session WhatsApp est déjà active, on met à jour le prompt utilisé en mémoire
    // tout de suite, sans avoir besoin de redémarrer la connexion.
    baileysService.updateBusinessPrompt(req.firebaseUid, businessPrompt.trim());

    res.json({ businessPrompt: businessPrompt.trim() });
  } catch (error) {
    console.error('Erreur /prompt:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
