const express = require('express');
const router = express.Router();

const { verifyFirebaseToken } = require('../middleware/authMiddleware');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const baileysService = require('../services/baileysService');

// ============================================================
// VERROUS PAR UTILISATEUR
// Évite qu'un double clic OFF/ON lance plusieurs sockets
// pour le même compte.
// ============================================================
const toggleLocks = new Map();

async function withUserLock(firebaseUid, callback) {
  const previousLock = toggleLocks.get(firebaseUid) || Promise.resolve();

  let releaseLock;

  const currentLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  toggleLocks.set(
    firebaseUid,
    previousLock.then(() => currentLock)
  );

  await previousLock;

  try {
    return await callback();
  } finally {
    releaseLock();

    // Nettoyage du lock uniquement si c'est toujours celui-ci
    if (toggleLocks.get(firebaseUid)) {
      toggleLocks.delete(firebaseUid);
    }
  }
}


// ============================================================
// GET /api/user/me
// Récupérer les informations du dashboard
// ============================================================
router.get('/me', verifyFirebaseToken, async (req, res) => {
  try {
    const firebaseUid = req.firebaseUid;

    const user = await userModel.getUserById(firebaseUid);

    if (!user) {
      return res.status(404).json({
        error: 'Utilisateur non trouvé',
      });
    }

    const session =
      await sessionModel.getSessionStatus(firebaseUid);

    const activeSocket =
      baileysService.getActiveSocket(firebaseUid);

    res.json({
      ...user,

      session: {
        ...(session || {}),
        connected:
          session?.connected === true && !!activeSocket,
      },
    });
  } catch (error) {
    console.error(
      'Erreur /me:',
      error.message
    );

    return res.status(500).json({
      error: 'Erreur serveur',
    });
  }
});


// ============================================================
// POST /api/user/toggle-bot
//
// OFF
//   → botEnabled false
//   → fermeture réelle du socket
//   → aucune reconnexion automatique
//
// ON
//   → botEnabled true
//   → utilisation des credentials Firestore
//   → reconnexion de la session existante
//   → pas de nouveau QR si les credentials sont valides
// ============================================================
router.post(
  '/toggle-bot',
  verifyFirebaseToken,
  async (req, res) => {
    const firebaseUid = req.firebaseUid;

    return withUserLock(firebaseUid, async () => {
      try {
        console.log(
          `\n========== TOGGLE BOT ${firebaseUid} ==========`
        );

        // ------------------------------------------------------
        // RÉCUPÉRER UTILISATEUR
        // ------------------------------------------------------
        const user =
          await userModel.getUserById(firebaseUid);

        if (!user) {
          console.warn(
            `⚠️ Utilisateur introuvable: ${firebaseUid}`
          );

          return res.status(404).json({
            error: 'Utilisateur non trouvé',
          });
        }

        // ------------------------------------------------------
        // VÉRIFIER ABONNEMENT
        // ------------------------------------------------------
        if (user.status === 'expired') {
          console.warn(
            `⚠️ Abonnement expiré: ${firebaseUid}`
          );

          return res.status(403).json({
            error:
              'Abonnement expiré, impossible de réactiver le bot sans paiement',
            botEnabled: false,
          });
        }

        // ------------------------------------------------------
        // NOUVEL ÉTAT
        // ------------------------------------------------------
        const newBotEnabled = !Boolean(user.botEnabled);

        console.log(
          `👤 ${firebaseUid} : botEnabled ${user.botEnabled} → ${newBotEnabled}`
        );


        // ======================================================
        // ACTIVATION
        // ======================================================
        if (newBotEnabled === true) {
          console.log(
            `🟢 Activation du bot pour ${firebaseUid}`
          );

          // ----------------------------------------------------
          // Ignorer les anciens messages
          // ----------------------------------------------------
          await sessionModel.setLastProcessedTimestamp(
            firebaseUid,
            new Date().toISOString()
          );

          // ----------------------------------------------------
          // Activer le bot AVANT le démarrage
          // ----------------------------------------------------
          await userModel.updateUser(
            firebaseUid,
            {
              botEnabled: true,
            }
          );

          // ----------------------------------------------------
          // Vérifier si un socket existe déjà
          // ----------------------------------------------------
          const existingSocket =
            baileysService.getActiveSocket(firebaseUid);

          if (existingSocket) {
            console.log(
              `✅ Socket déjà présent pour ${firebaseUid}`
            );

            return res.json({
              success: true,
              botEnabled: true,
              connected: true,
              status: 'connected',
              message: 'Bot déjà connecté à WhatsApp.',
            });
          }

          // ----------------------------------------------------
          // Aucun socket → démarrage / reconnexion
          // ----------------------------------------------------
          console.log(
            `📱 Aucun socket pour ${firebaseUid}`
          );

          console.log(
            `🔄 Tentative de reconnexion WhatsApp avec Firestore...`
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

            /*
             * IMPORTANT :
             * startWhatsappSession() crée le socket mais
             * la connexion WhatsApp peut prendre quelques secondes.
             *
             * On ne ment donc pas au frontend avec connected:true.
             */
            console.log(
              `⏳ Session WhatsApp lancée pour ${firebaseUid}, connexion en cours...`
            );

            return res.json({
              success: true,
              botEnabled: true,
              connected: false,
              status: 'connecting',
              message:
                'Bot activé. Connexion WhatsApp en cours...',
            });
          } catch (error) {
            console.error(
              `❌ Échec démarrage WhatsApp ${firebaseUid}:`,
              error.message
            );

            // Si le démarrage échoue immédiatement,
            // on remet le bot OFF pour éviter un état incohérent.
            await userModel.updateUser(
              firebaseUid,
              {
                botEnabled: false,
              }
            );

            await sessionModel.saveSessionStatus(
              firebaseUid,
              {
                connected: false,
              }
            );

            return res.status(500).json({
              success: false,
              botEnabled: false,
              connected: false,
              status: 'error',
              error:
                'Impossible de démarrer la connexion WhatsApp.',
            });
          }
        }


        // ======================================================
        // DÉSACTIVATION
        // ======================================================
        console.log(
          `🔴 Désactivation du bot pour ${firebaseUid}`
        );

        // ------------------------------------------------------
        // Désactiver le bot en base
        // ------------------------------------------------------
        await userModel.updateUser(
          firebaseUid,
          {
            botEnabled: false,
          }
        );

        // ------------------------------------------------------
        // Arrêter réellement WhatsApp
        // ------------------------------------------------------
        try {
          console.log(
            `🛑 Arrêt du socket WhatsApp pour ${firebaseUid}...`
          );

          await baileysService.stopWhatsappSession(
            firebaseUid
          );

          console.log(
            `✅ Socket WhatsApp arrêté pour ${firebaseUid}`
          );
        } catch (error) {
          console.error(
            `❌ Erreur arrêt WhatsApp ${firebaseUid}:`,
            error.message
          );
        }

        // ------------------------------------------------------
        // Mettre Firestore à jour
        // ------------------------------------------------------
        await sessionModel.saveSessionStatus(
          firebaseUid,
          {
            connected: false,
            lastActiveAt:
              new Date().toISOString(),
          }
        );

        console.log(
          `✅ Bot complètement désactivé pour ${firebaseUid}`
        );

        return res.json({
          success: true,
          botEnabled: false,
          connected: false,
          status: 'disconnected',
          message: 'Bot désactivé.',
        });
      } catch (error) {
        console.error(
          `❌ Erreur /toggle-bot pour ${firebaseUid}:`,
          error
        );

        return res.status(500).json({
          success: false,
          error: 'Erreur serveur',
        });
      }
    });
  }
);


module.exports = router;
