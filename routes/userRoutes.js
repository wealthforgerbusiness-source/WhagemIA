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

      // Auparavant : ce endpoint ne faisait que changer le flag Firestore.
      // Si le socket WhatsApp avait disparu (redémarrage/mise en veille Render),
      // "réactiver" ne reconnectait rien. On relance donc la session ici si besoin,
      // en réutilisant les creds Firestore déjà enregistrées (pas de nouveau QR).
      const existingSocket = baileysService.getActiveSocket(req.firebaseUid);
      if (!existingSocket && user.businessPrompt) {
        baileysService
          .startWhatsappSession(
            req.firebaseUid,
            user.email,
            user.businessPrompt,
            null,
            false,
            null
          )
          .catch((err) =>
            console.error(
              `Erreur relance session pour ${req.firebaseUid}:`,
              err.message
            )
          );
      }
    }

    await userModel.updateUser(req.firebaseUid, { botEnabled: newBotEnabled });

    res.json({ botEnabled: newBotEnabled });
  } catch (error) {
    console.error('Erreur /toggle-bot:', error.message);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
