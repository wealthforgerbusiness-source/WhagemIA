const express = require('express');
const router = express.Router();

const {
  verifyFirebaseToken,
} = require('../middleware/authMiddleware');

const userModel =
  require('../models/userModel');

const sessionModel =
  require('../models/sessionModel');

const baileysService =
  require('../services/baileysService');

router.get(
  '/me',
  verifyFirebaseToken,
  async (req, res) => {
    try {
      const firebaseUid =
        req.firebaseUid;

      const user =
        await userModel.getUserById(
          firebaseUid
        );

      if (!user) {
        return res.status(404).json({
          error:
            'Utilisateur non trouvé',
        });
      }

      const session =
        await sessionModel.getSessionStatus(
          firebaseUid
        );

      /*
       * IMPORTANT :
       * Ne jamais considérer simplement un socket
       * comme connecté.
       *
       * session.connected devient true uniquement
       * lorsque Baileys reçoit connection === 'open'.
       */
      res.json({
        ...user,

        session: {
          ...(session || {}),
          connected:
            session?.connected === true,
        },
      });
    } catch (error) {
      console.error(
        'Erreur /me:',
        error.message
      );

      res.status(500).json({
        error:
          'Erreur serveur',
      });
    }
  }
);

router.post(
  '/toggle-bot',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid =
      req.firebaseUid;

    try {
      const user =
        await userModel.getUserById(
          firebaseUid
        );

      if (!user) {
        return res.status(404).json({
          error:
            'Utilisateur non trouvé',
        });
      }

      if (
        user.status === 'expired'
      ) {
        return res.status(403).json({
          error:
            'Abonnement expiré, impossible de réactiver le bot sans paiement',
        });
      }

      const newBotEnabled =
        !user.botEnabled;

      /*
       * =====================================================
       * ACTIVATION
       * =====================================================
       */
      if (newBotEnabled) {
        console.log(
          `🔄 Réactivation du bot WhatsApp pour ${firebaseUid}`
        );

        await sessionModel.setLastProcessedTimestamp(
          firebaseUid,
          new Date().toISOString()
        );

        await userModel.updateUser(
          firebaseUid,
          {
            botEnabled: true,
          }
        );

        /*
         * Si WhatsApp est réellement connecté,
         * rien à faire.
         */
        if (
          baileysService.isWhatsappConnected(
            firebaseUid
          )
        ) {
          console.log(
            `✅ WhatsApp réellement connecté pour ${firebaseUid}`
          );

          return res.json({
            botEnabled: true,
            connected: true,
            status: 'connected',
          });
        }

        /*
         * Si une connexion est en cours,
         * on ne crée pas une deuxième socket.
         */
        if (
          baileysService.getActiveSocket(
            firebaseUid
          )
        ) {
          console.log(
            `⏳ Connexion WhatsApp déjà en cours pour ${firebaseUid}`
          );

          return res.json({
            botEnabled: true,
            connected: false,
            status: 'connecting',
          });
        }

        /*
         * Sinon on tente de restaurer les credentials
         * Firestore.
         */
        try {
          await baileysService.startWhatsappSession(
            firebaseUid,
            user.email,
            user.businessPrompt || '',
            null,
            'qr',
            null
          );

          console.log(
            `🚀 Session WhatsApp relancée pour ${firebaseUid}`
          );

          return res.json({
            botEnabled: true,
            connected: false,
            status: 'connecting',
          });
        } catch (error) {
          console.error(
            `❌ Erreur relance WhatsApp ${firebaseUid}:`,
            error.message
          );

          return res.status(500).json({
            botEnabled: true,
            connected: false,
            status: 'error',
            error:
              'Le bot est activé mais WhatsApp n’a pas pu être reconnecté.',
          });
        }
      }

      /*
       * =====================================================
       * DÉSACTIVATION
       * =====================================================
       */
      console.log(
        `🛑 Désactivation du bot WhatsApp pour ${firebaseUid}`
      );

      await userModel.updateUser(
        firebaseUid,
        {
          botEnabled: false,
        }
      );

      try {
        await baileysService.stopWhatsappSession(
          firebaseUid
        );
      } catch (error) {
        console.error(
          `❌ Erreur arrêt WhatsApp ${firebaseUid}:`,
          error.message
        );
      }

      await sessionModel.saveSessionStatus(
        firebaseUid,
        {
          connected: false,
        }
      );

      return res.json({
        botEnabled: false,
        connected: false,
        status: 'disconnected',
      });
    } catch (error) {
      console.error(
        `❌ Erreur /toggle-bot ${firebaseUid}:`,
        error.message
      );

      return res.status(500).json({
        error:
          'Erreur serveur',
      });
    }
  }
);

module.exports = router;
