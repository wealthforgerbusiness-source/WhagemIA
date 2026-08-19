const express = require('express');
const router = express.Router();

const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const baileysService = require('../services/baileysService');

const whatsappConnectionData = new Map();

/*
|--------------------------------------------------------------------------
| GET /me
|--------------------------------------------------------------------------
| Récupère les informations de l'utilisateur connecté.
*/
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

    const connectionData =
      whatsappConnectionData.get(req.firebaseUid) || null;

    const activeSocket =
      baileysService.getActiveSocket(req.firebaseUid);

    res.json({
      ...user,

      session: {
        ...(session || {}),
        connected: !!activeSocket || !!session?.connected,
      },

      whatsappConnection: connectionData || {
        status: activeSocket ? 'connected' : 'idle',
        qrCode: null,
        pairingCode: null,
        error: null,
      },
    });
  } catch (error) {
    console.error('Erreur /me:', error.message);

    res.status(500).json({
      error: 'Erreur serveur',
    });
  }
});

/*
|--------------------------------------------------------------------------
| POST /whatsapp/connect
|--------------------------------------------------------------------------
| Lance une connexion WhatsApp.
|
| QR :
| {
|   "method": "qr"
| }
|
| Pairing :
| {
|   "method": "pairing",
|   "phoneNumber": "33612345678"
| }
|--------------------------------------------------------------------------
*/
router.post(
  '/whatsapp/connect',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid = req.firebaseUid;

    try {
      const {
        method = 'qr',
        phoneNumber = null,
      } = req.body || {};

      if (
        method !== 'qr' &&
        method !== 'pairing'
      ) {
        return res.status(400).json({
          error: 'Méthode de connexion invalide.',
        });
      }

      const user =
        await userModel.getUserById(firebaseUid);

      if (!user) {
        return res.status(404).json({
          error: 'Utilisateur non trouvé',
        });
      }

      if (user.status === 'expired') {
        return res.status(403).json({
          error:
            'Abonnement expiré, impossible de connecter WhatsApp.',
        });
      }

      /*
       * Vérifier si une session est déjà active.
       */
      const existingSocket =
        baileysService.getActiveSocket(firebaseUid);

      if (existingSocket) {
        whatsappConnectionData.set(
          firebaseUid,
          {
            status: 'connected',
            qrCode: null,
            pairingCode: null,
            error: null,
          }
        );

        return res.json({
          success: true,
          status: 'connected',
          connected: true,
        });
      }

      /*
       * Le code de pairage nécessite un numéro.
       */
      if (
        method === 'pairing' &&
        !phoneNumber
      ) {
        return res.status(400).json({
          error:
            'Numéro de téléphone obligatoire pour le code de pairage.',
        });
      }

      /*
       * Nettoyage du numéro.
       */
      let cleanPhoneNumber = null;

      if (phoneNumber) {
        cleanPhoneNumber = String(
          phoneNumber
        ).replace(/\D/g, '');
      }

      if (
        method === 'pairing' &&
        (!cleanPhoneNumber ||
          cleanPhoneNumber.length < 9)
      ) {
        return res.status(400).json({
          error:
            'Numéro de téléphone invalide. Utilisez le numéro avec indicatif pays.',
        });
      }

      /*
       * Initialiser l'état de connexion.
       */
      whatsappConnectionData.set(
        firebaseUid,
        {
          status: 'connecting',
          qrCode: null,
          pairingCode: null,
          error: null,
        }
      );

      /*
       * Callback appelée par Baileys lorsqu'un QR,
       * un code de pairage ou une erreur est disponible.
       */
      const onQrCode = async (
        qr,
        pairingCode,
        errorCode
      ) => {
        try {
          /*
           * QR reçu.
           *
           * Le service Baileys convertit normalement
           * le QR en Data URL avant d'appeler cette callback.
           */
          if (qr) {
            console.log(
              `📲 QR WhatsApp reçu pour ${firebaseUid}`
            );

            whatsappConnectionData.set(
              firebaseUid,
              {
                status: 'qr_ready',
                qrCode: qr,
                pairingCode: null,
                error: null,
              }
            );

            return;
          }

          /*
           * Code de pairage reçu.
           */
          if (pairingCode) {
            console.log(
              `🔐 Code de pairage reçu pour ${firebaseUid}: ${pairingCode}`
            );

            whatsappConnectionData.set(
              firebaseUid,
              {
                status: 'pairing_ready',
                qrCode: null,
                pairingCode,
                error: null,
              }
            );

            return;
          }

          /*
           * Erreur.
           */
          if (errorCode) {
            console.error(
              `❌ Erreur connexion WhatsApp ${firebaseUid}: ${errorCode}`
            );

            whatsappConnectionData.set(
              firebaseUid,
              {
                status: 'error',
                qrCode: null,
                pairingCode: null,
                error: errorCode,
              }
            );
          }
        } catch (error) {
          console.error(
            `❌ Erreur callback WhatsApp ${firebaseUid}:`,
            error.message
          );
        }
      };

      /*
       * Démarrer Baileys.
       */
      await baileysService.startWhatsappSession(
        firebaseUid,
        user.email,
        user.businessPrompt || '',
        onQrCode,
        method,
        cleanPhoneNumber
      );

      console.log(
        `🚀 Connexion WhatsApp lancée pour ${firebaseUid} (${method})`
      );

      /*
       * Ne pas attendre le QR ici.
       *
       * Le frontend va interroger /whatsapp/connect-status.
       */
      return res.json({
        success: true,
        status: 'connecting',
        connected: false,
        method,
      });
    } catch (error) {
      console.error(
        `❌ Erreur /whatsapp/connect ${firebaseUid}:`,
        error
      );

      whatsappConnectionData.set(
        firebaseUid,
        {
          status: 'error',
          qrCode: null,
          pairingCode: null,
          error: error.message,
        }
      );

      return res.status(500).json({
        success: false,
        status: 'error',
        error:
          'Impossible de démarrer la connexion WhatsApp.',
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| GET /whatsapp/connect-status
|--------------------------------------------------------------------------
| Le frontend utilise cette route pour récupérer :
|
| - QR
| - code de pairage
| - connexion réussie
| - erreur
|--------------------------------------------------------------------------
*/
router.get(
  '/whatsapp/connect-status',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid = req.firebaseUid;

    try {
      /*
       * Vérifier d'abord le socket réel.
       */
      const activeSocket =
        baileysService.getActiveSocket(
          firebaseUid
        );

      if (activeSocket) {
        whatsappConnectionData.set(
          firebaseUid,
          {
            status: 'connected',
            qrCode: null,
            pairingCode: null,
            error: null,
          }
        );

        return res.json({
          success: true,
          status: 'connected',
          connected: true,
          qrCode: null,
          pairingCode: null,
          error: null,
        });
      }

      /*
       * Sinon récupérer l'état temporaire.
       */
      const data =
        whatsappConnectionData.get(
          firebaseUid
        );

      if (!data) {
        return res.json({
          success: true,
          status: 'idle',
          connected: false,
          qrCode: null,
          pairingCode: null,
          error: null,
        });
      }

      return res.json({
        success: true,
        status: data.status || 'connecting',
        connected: false,
        qrCode: data.qrCode || null,
        pairingCode:
          data.pairingCode || null,
        error: data.error || null,
      });
    } catch (error) {
      console.error(
        `❌ Erreur /whatsapp/connect-status ${firebaseUid}:`,
        error.message
      );

      return res.status(500).json({
        success: false,
        status: 'error',
        connected: false,
        error:
          'Impossible de récupérer le statut WhatsApp.',
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| POST /whatsapp/disconnect
|--------------------------------------------------------------------------
| Déconnexion manuelle de WhatsApp.
|--------------------------------------------------------------------------
*/
router.post(
  '/whatsapp/disconnect',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid = req.firebaseUid;

    try {
      await baileysService.stopWhatsappSession(
        firebaseUid
      );

      whatsappConnectionData.delete(
        firebaseUid
      );

      await sessionModel.saveSessionStatus(
        firebaseUid,
        {
          connected: false,
        }
      );

      return res.json({
        success: true,
        connected: false,
      });
    } catch (error) {
      console.error(
        `❌ Erreur déconnexion WhatsApp ${firebaseUid}:`,
        error.message
      );

      return res.status(500).json({
        success: false,
        error:
          'Impossible de déconnecter WhatsApp.',
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| POST /toggle-bot
|--------------------------------------------------------------------------
| Activer / désactiver le bot.
|--------------------------------------------------------------------------
*/
router.post(
  '/toggle-bot',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid = req.firebaseUid;

    try {
      const user =
        await userModel.getUserById(
          firebaseUid
        );

      if (!user) {
        return res.status(404).json({
          error: 'Utilisateur non trouvé',
        });
      }

      if (user.status === 'expired') {
        return res.status(403).json({
          error:
            'Abonnement expiré, impossible de réactiver le bot sans paiement',
        });
      }

      const newBotEnabled =
        !user.botEnabled;

      /*
       * Activation.
       */
      if (newBotEnabled) {
        console.log(
          `🔄 Réactivation du bot WhatsApp pour ${firebaseUid}`
        );

        /*
         * Ignorer les anciens messages.
         */
        await sessionModel.setLastProcessedTimestamp(
          firebaseUid,
          new Date().toISOString()
        );

        /*
         * Activer le bot AVANT de démarrer
         * la session.
         */
        await userModel.updateUser(
          firebaseUid,
          {
            botEnabled: true,
          }
        );

        /*
         * Vérifier si WhatsApp est déjà connecté.
         */
        const existingSocket =
          baileysService.getActiveSocket(
            firebaseUid
          );

        if (existingSocket) {
          console.log(
            `✅ WhatsApp déjà connecté pour ${firebaseUid}`
          );

          return res.json({
            botEnabled: true,
            connected: true,
          });
        }

        /*
         * Si aucune session active, tenter
         * de reprendre la session Firestore.
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
            error:
              'Le bot est activé mais WhatsApp n’a pas pu être reconnecté.',
          });
        }
      }

      /*
       * Désactivation.
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
          `❌ Erreur arrêt session ${firebaseUid}:`,
          error.message
        );
      }

      whatsappConnectionData.delete(
        firebaseUid
      );

      await sessionModel.saveSessionStatus(
        firebaseUid,
        {
          connected: false,
        }
      );

      return res.json({
        botEnabled: false,
        connected: false,
      });
    } catch (error) {
      console.error(
        `❌ Erreur /toggle-bot ${firebaseUid}:`,
        error.message
      );

      return res.status(500).json({
        error: 'Erreur serveur',
      });
    }
  }
);

module.exports = router;
