const express = require('express');
const router = express.Router();

const {
  verifyFirebaseToken,
} = require('../middleware/authMiddleware');

const baileysService =
  require('../services/baileysService');

const userModel =
  require('../models/userModel');

const sessionModel =
  require('../models/sessionModel');

const connectionStates = new Map();

router.post(
  '/connect',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid =
      req.firebaseUid;

    try {
      const {
        businessPrompt,
        usePairingCode = false,
        phoneNumber = null,
      } = req.body || {};

      if (
        !businessPrompt ||
        typeof businessPrompt !== 'string' ||
        businessPrompt.trim().length < 10
      ) {
        return res.status(400).json({
          error:
            "Description de l'entreprise requise (au moins 10 caractères)",
        });
      }

      if (
        usePairingCode &&
        !phoneNumber
      ) {
        return res.status(400).json({
          error:
            'Numéro de téléphone requis pour le code de pairage',
        });
      }

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
            'Abonnement expiré, impossible de connecter WhatsApp.',
        });
      }

      if (
        baileysService.isWhatsappConnected(
          firebaseUid
        )
      ) {
        return res.status(409).json({
          error:
            'WhatsApp est déjà connecté.',
          connected: true,
        });
      }

      if (
        baileysService.getActiveSocket(
          firebaseUid
        )
      ) {
        return res.status(409).json({
          error:
            'Une connexion WhatsApp est déjà en cours.',
          connected: false,
        });
      }

      const cleanPhoneNumber =
        phoneNumber
          ? String(phoneNumber)
              .replace(/\D/g, '')
          : null;

      if (
        usePairingCode &&
        (
          !cleanPhoneNumber ||
          cleanPhoneNumber.length < 9
        )
      ) {
        return res.status(400).json({
          error:
            'Numéro WhatsApp invalide. Utilisez le numéro avec indicatif pays.',
        });
      }

      connectionStates.set(
        firebaseUid,
        {
          status: 'connecting',
          qrCode: null,
          pairingCode: null,
          error: null,
          updatedAt:
            new Date().toISOString(),
        }
      );

      const onQrCode = async (
        qr,
        pairingCode,
        errorCode
      ) => {
        if (errorCode) {
          console.error(
            `❌ Connexion WhatsApp ${firebaseUid}: ${errorCode}`
          );

          connectionStates.set(
            firebaseUid,
            {
              status: 'error',
              qrCode: null,
              pairingCode: null,
              error: errorCode,
              updatedAt:
                new Date().toISOString(),
            }
          );

          return;
        }

        if (pairingCode) {
          console.log(
            `🔐 Code de pairage reçu: ${firebaseUid}`
          );

          connectionStates.set(
            firebaseUid,
            {
              status:
                'pairing_ready',
              qrCode: null,
              pairingCode,
              error: null,
              updatedAt:
                new Date().toISOString(),
            }
          );

          return;
        }

        if (qr) {
          console.log(
            `📲 QR reçu: ${firebaseUid} (${qr.length} caractères)`
          );

          /*
           * IMPORTANT :
           * qr est le QR BRUT de Baileys.
           * Aucune conversion QR ici.
           */
          connectionStates.set(
            firebaseUid,
            {
              status: 'qr_ready',
              qrCode: qr,
              pairingCode: null,
              error: null,
              updatedAt:
                new Date().toISOString(),
            }
          );

          console.log(
            `✅ QR stocké temporairement pour le dashboard: ${firebaseUid}`
          );
        }
      };

      await baileysService.startWhatsappSession(
        firebaseUid,
        user.email,
        businessPrompt.trim(),
        onQrCode,
        usePairingCode
          ? 'pairing'
          : 'qr',
        cleanPhoneNumber
      );

      await userModel.updateUser(
        firebaseUid,
        {
          businessPrompt:
            businessPrompt.trim(),
        }
      );

      console.log(
        `🚀 Connexion WhatsApp lancée pour ${firebaseUid}`
      );

      return res.json({
        success: true,
        status: 'connecting',
        connected: false,
        method:
          usePairingCode
            ? 'pairing'
            : 'qr',
      });
    } catch (error) {
      console.error(
        `❌ Erreur /connect ${firebaseUid}:`,
        error
      );

      connectionStates.set(
        firebaseUid,
        {
          status: 'error',
          qrCode: null,
          pairingCode: null,
          error: error.message,
          updatedAt:
            new Date().toISOString(),
        }
      );

      return res.status(500).json({
        success: false,
        connected: false,
        error:
          'Impossible de démarrer la connexion WhatsApp.',
      });
    }
  }
);

router.get(
  '/connect-status',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid =
      req.firebaseUid;

    try {
      const connected =
        baileysService.isWhatsappConnected(
          firebaseUid
        );

      if (connected) {
        return res.json({
          success: true,
          status: 'connected',
          connected: true,
          qrCode: null,
          pairingCode: null,
          error: null,
        });
      }

      const session =
        await sessionModel.getSessionStatus(
          firebaseUid
        );

      if (
        session?.connected === true
      ) {
        return res.json({
          success: true,
          status: 'connected',
          connected: true,
          qrCode: null,
          pairingCode: null,
          error: null,
        });
      }

      const state =
        connectionStates.get(
          firebaseUid
        );

      if (!state) {
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
        status:
          state.status ||
          'connecting',
        connected: false,
        qrCode:
          state.qrCode || null,
        pairingCode:
          state.pairingCode || null,
        error:
          state.error || null,
      });
    } catch (error) {
      console.error(
        `❌ Erreur connect-status ${firebaseUid}:`,
        error.message
      );

      return res.status(500).json({
        success: false,
        connected: false,
        status: 'error',
        error:
          'Impossible de récupérer le statut WhatsApp.',
      });
    }
  }
);

router.post(
  '/disconnect',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid =
      req.firebaseUid;

    try {
      await baileysService.stopWhatsappSession(
        firebaseUid
      );

      connectionStates.delete(
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
        `❌ Erreur disconnect ${firebaseUid}:`,
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

module.exports = router;
