const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const baileysService = require('../services/baileysService');

// Démarrer une connexion WhatsApp — supporte QR code OU code de pairage
router.post('/connect', verifyFirebaseToken, async (req, res) => {
  const { businessPrompt, usePairingCode, phoneNumber } = req.body;

  if (!businessPrompt || businessPrompt.trim().length < 10) {
    return res.status(400).json({
      error: 'Description de l\'entreprise requise (au moins 10 caractères)',
    });
  }

  if (usePairingCode && !phoneNumber) {
    return res.status(400).json({
      error: 'Numéro de téléphone requis pour le code de pairage',
    });
  }

  try {
    let responseSent = false;

    await baileysService.startWhatsappSession(
      req.firebaseUid,
      req.userEmail,
      businessPrompt,
      async (qr, pairingCode, errorCode) => {
        if (responseSent) return;

        if (errorCode === 'NUMBER_ALREADY_USED') {
          responseSent = true;
          return res.status(403).json({
            error: 'Ce numéro WhatsApp a déjà utilisé l\'essai gratuit sur un autre compte',
          });
        }

        if (pairingCode) {
          responseSent = true;
          return res.json({ pairingCode });
        }

        if (qr) {
          responseSent = true;
          const qrImage = await QRCode.toDataURL(qr);
          return res.json({ qrCode: qrImage });
        }
      },
      usePairingCode,
      phoneNumber
    );

    setTimeout(() => {
      if (!responseSent) {
        res.status(500).json({ error: 'Délai dépassé, réessayez' });
      }
    }, 20000);
  } catch (error) {
    console.error('Erreur connexion WhatsApp:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erreur lors de la connexion WhatsApp' });
    }
  }
});

module.exports = router;
