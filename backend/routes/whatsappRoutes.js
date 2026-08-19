const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');

const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const baileysService = require('../services/baileysService');

/**
 * POST /api/whatsapp/connect
 *
 * Permet de connecter WhatsApp :
 * - QR code
 * - Code de pairage
 */
router.post('/connect', verifyFirebaseToken, async (req, res) => {
  const firebaseUid = req.firebaseUid;

  const {
    businessPrompt,
    usePairingCode = false,
    phoneNumber = null,
  } = req.body;

  // ---------------------------------------------------------
  // VALIDATION
  // ---------------------------------------------------------

  if (
    !businessPrompt ||
    typeof businessPrompt !== 'string' ||
    businessPrompt.trim().length < 10
  ) {
    return res.status(400).json({
      error: "Description de l'entreprise requise (au moins 10 caractères)",
    });
  }

  if (usePairingCode) {
    if (!phoneNumber || typeof phoneNumber !== 'string') {
      return res.status(400).json({
        error: 'Numéro de téléphone requis pour le code de pairage',
      });
    }

    // WhatsApp attend généralement le numéro sans +
    const cleanPhoneNumber = phoneNumber.replace(/[^\d]/g, '');

    if (cleanPhoneNumber.length < 8) {
      return res.status(400).json({
        error: 'Numéro de téléphone WhatsApp invalide',
      });
    }
  }

  // ---------------------------------------------------------
  // ÉVITER DE LANCER DEUX CONNEXIONS EN MÊME TEMPS
  // ---------------------------------------------------------

  const existingSocket = baileysService.getActiveSocket(firebaseUid);

  if (existingSocket) {
    console.log(
      `⚠️ Une session WhatsApp existe déjà pour ${firebaseUid}`
    );

    return res.status(409).json({
      error: 'Une connexion WhatsApp est déjà en cours ou active.',
      connected: false,
      alreadyStarted: true,
    });
  }

  // ---------------------------------------------------------
  // CONNEXION
  // ---------------------------------------------------------

  let responseSent = false;
  let timeoutId = null;

  const sendOnce = (statusCode, data) => {
    if (responseSent || res.headersSent) return;

    responseSent = true;

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    return res.status(statusCode).json(data);
  };

  try {
    console.log(
      `🚀 Démarrage WhatsApp ${firebaseUid} | méthode=${
        usePairingCode ? 'pairing' : 'qr'
      }`
    );

    await baileysService.startWhatsappSession(
      firebaseUid,
      req.userEmail,
      businessPrompt.trim(),

      /**
       * CALLBACK QR / PAIRING
       */
      async (qr, pairingCode, errorCode) => {
        try {
          // ---------------------------------------------------
          // NUMÉRO DÉJÀ UTILISÉ
          // ---------------------------------------------------

          if (errorCode === 'NUMBER_ALREADY_USED') {
            return sendOnce(403, {
              error:
                "Ce numéro WhatsApp a déjà utilisé l'essai gratuit sur un autre compte.",
              code: 'NUMBER_ALREADY_USED',
            });
          }

          // ---------------------------------------------------
          // CODE DE PAIRAGE
          // ---------------------------------------------------

          if (pairingCode) {
            console.log(
              `🔐 Code de pairage envoyé au dashboard: ${firebaseUid}`
            );

            return sendOnce(200, {
              pairingCode,
              method: 'pairing',
              connected: false,
            });
          }

          // ---------------------------------------------------
          // QR CODE
          // ---------------------------------------------------

          if (qr) {
            console.log(
              `📲 QR reçu pour ${firebaseUid} (${qr.length} caractères)`
            );

            let qrImage;

            try {
              /*
               * Niveau de correction L = moins de données
               * supplémentaires que H.
               *
               * On garde une marge raisonnable pour les QR
               * générés par les différentes versions de WhatsApp.
               */
              qrImage = await QRCode.toDataURL(qr, {
                errorCorrectionLevel: 'L',
                margin: 2,
                width: 400,
              });
            } catch (qrError) {
              console.error(
                `❌ Erreur génération image QR ${firebaseUid}:`,
                qrError.message
              );

              /*
               * Très important :
               * on ne renvoie PAS une fausse connexion.
               */
              return sendOnce(500, {
                error:
                  "Impossible de générer l'image du QR WhatsApp.",
                code: 'QR_GENERATION_ERROR',
              });
            }

            console.log(
              `✅ QR envoyé au dashboard: ${firebaseUid}`
            );

            return sendOnce(200, {
              qrCode: qrImage,
              method: 'qr',
              connected: false,
            });
          }
        } catch (callbackError) {
          console.error(
            `❌ Erreur callback WhatsApp ${firebaseUid}:`,
            callbackError.message
          );

          return sendOnce(500, {
            error: 'Erreur lors de la préparation de la connexion WhatsApp.',
          });
        }
      },

      usePairingCode,

      usePairingCode
        ? phoneNumber.replace(/[^\d]/g, '')
        : null
    );

    // ---------------------------------------------------------
    // TIMEOUT
    // ---------------------------------------------------------

    timeoutId = setTimeout(() => {
      if (responseSent || res.headersSent) return;

      console.warn(
        `⏱️ Timeout connexion WhatsApp ${firebaseUid}`
      );

      responseSent = true;

      return res.status(408).json({
        error:
          "WhatsApp n'a pas envoyé de QR ou de code de pairage dans le délai prévu.",
        code: 'CONNECTION_TIMEOUT',
        connected: false,
      });
    }, 30000);

  } catch (error) {
    console.error(
      `❌ Erreur connexion WhatsApp ${firebaseUid}:`,
      error
    );

    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Erreur lors de la connexion WhatsApp',
        connected: false,
      });
    }
  }
});

module.exports = router;
