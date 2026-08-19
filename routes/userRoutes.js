const express = require('express');
const router = express.Router();

const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const baileysService = require('../services/baileysService');

// Récupérer les infos du dashboard utilisateur
router.get('/me', verifyFirebaseToken, async (req, res) => {
  try {
    const user = await userModel.getUserById(req.firebaseUid);

    if (!user) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé',
      });
    }

    const session = await sessionModel.getSessionStatus(
      req.firebaseUid
    );

    res.json({
      ...user,
      session: session || {
        connected: false,
      },
    });
  } catch (error) {
    console.error('Erreur /me:', error.message);

    res.status(500).json({
      error: 'Erreur serveur',
    });
  }
});

// Activer / désactiver le bot depuis le dashboard
router.post('/toggle-bot', verifyFirebaseToken, async (req, res) => {
  const firebaseUid = req.firebaseUid;

  try {
    const user = await userModel.getUserById(firebaseUid);

    if (!user) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé',
      });
    }

    // Vérifier l'abonnement
    if (user.status === 'expired') {
      return res.status(403).json({
        error:
          'Abonnement expiré, impossible de réactiver le bot sans paiement',
      });
    }

    const newBotEnabled = !user.botEnabled;

    // =========================================================
    // ACTIVATION
    // =========================================================
    if (newBotEnabled) {
      console.log(
        `🔄 Réactivation du bot WhatsApp pour ${firebaseUid}`
      );

      // Ignorer les anciens messages
      await sessionModel.setLastProcessedTimestamp(
        firebaseUid,
        new Date().toISOString()
      );

      // Activer le bot dans la base AVANT de démarrer WhatsApp
      await userModel.updateUser(firebaseUid, {
        botEnabled: true,
      });

      // Vérifier si un socket existe déjà
      const existingSocket =
        baileysService.getActiveSocket(firebaseUid);

      if (existingSocket) {
        console.log(
          `✅ Socket WhatsApp déjà actif pour ${firebaseUid}`
        );

        return res.json({
          botEnabled: true,
          connected: true,
        });
      }

      // Aucun socket : on tente de reconnecter
      console.log(
        `📱 Aucun socket actif pour ${firebaseUid}, lancement de la session WhatsApp...`
      );

      try {
        await baileysService.startWhatsappSession(
          firebaseUid,
          user.email,
          user.businessPrompt || '',
          null,
          false,
          null
        );

        console.log(
          `✅ Session WhatsApp relancée pour ${firebaseUid}`
        );

        return res.json({
          botEnabled: true,
          connected: true,
        });
      } catch (error) {
        console.error(
          `❌ Erreur relance session WhatsApp ${firebaseUid}:`,
          error.message
        );

        // Le bot reste activé, mais WhatsApp n'est pas connecté
        return res.status(500).json({
          botEnabled: true,
          connected: false,
          error:
            'Le bot est activé mais WhatsApp n’a pas pu être reconnecté.',
        });
      }
    }

    // =========================================================
    // DÉSACTIVATION
    // =========================================================
    console.log(
      `🛑 Désactivation du bot WhatsApp pour ${firebaseUid}`
    );

    // Désactiver le bot dans la base
    await userModel.updateUser(firebaseUid, {
      botEnabled: false,
    });

    // Arrêter réellement la session WhatsApp
    try {
      await baileysService.stopWhatsappSession(firebaseUid);

      console.log(
        `✅ Session WhatsApp arrêtée pour ${firebaseUid}`
      );
    } catch (error) {
      console.error(
        `❌ Erreur arrêt session WhatsApp ${firebaseUid}:`,
        error.message
      );
    }

    return res.json({
      botEnabled: false,
      connected: false,
    });
  } catch (error) {
    console.error(
      `Erreur /toggle-bot pour ${firebaseUid}:`,
      error.message
    );

    return res.status(500).json({
      error: 'Erreur serveur',
    });
  }
});

module.exports = router;
