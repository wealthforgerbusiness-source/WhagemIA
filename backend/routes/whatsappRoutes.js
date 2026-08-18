const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const baileysService = require('../services/baileysService');
const userModel = require('../models/userModel');
const crypto = require('crypto');

// Démarrer une connexion WhatsApp et récupérer le QR code en base64
router.post('/connect', verifyFirebaseToken, async (req, res) => {
  const { businessPrompt } = req.body;

  if (!businessPrompt || businessPrompt.trim().length < 10) {
    return res.status(400).json({
      error: 'Description de l\'entreprise requise (au moins 10 caractères)',
    });
  }

  try {
    let qrSent = false;

    await baileysService.startWhatsappSession(
      req.firebaseUid,
      businessPrompt,
      async (qr) => {
        if (qrSent) return;
        qrSent = true;
        const qrImage = await QRCode.toDataURL(qr);
        res.json({ qrCode: qrImage });
      }
    );

    // Timeout de sécurité si le QR ne s'affiche jamais
    setTimeout(() => {
      if (!qrSent) {
        res.status(500).json({ error: 'Impossible de générer le QR code, réessayez' });
      }
    }, 15000);
  } catch (error) {
    console.error('Erreur connexion WhatsApp:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erreur lors de la connexion WhatsApp' });
    }
  }
});

// Appelé une fois que la connexion WhatsApp est confirmée (depuis le frontend, après polling du statut)
router.post('/confirm-connection', verifyFirebaseToken, async (req, res) => {
  const { whatsappNumber } = req.body;

  if (!whatsappNumber) {
    return res.status(400).json({ error: 'Numéro WhatsApp requis' });
  }

  const whatsappNumberHash = crypto
    .createHash('sha256')
    .update(whatsappNumber)
    .digest('hex');

  const existing = await userModel.findUserByWhatsappHash(whatsappNumberHash);

  if (existing && existing.id !== req.firebaseUid) {
    return res.status(403).json({
      error: 'Ce numéro WhatsApp a déjà utilisé l\'essai gratuit sur un autre compte',
    });
  }

  const user = await userModel.createUser({
    firebaseUid: req.firebaseUid,
    email: req.userEmail,
    whatsappNumberHash,
  });

  res.json({ user });
});

module.exports = router;
