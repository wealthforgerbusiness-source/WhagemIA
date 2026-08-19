const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const crypto = require('crypto');
const pino = require('pino');

const { useFirestoreAuthState } = require('./firestoreAuthState');
const geminiService = require('./geminiService');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');

const activeSockets = new Map();
const qrCallbacks = new Map();
const businessPrompts = new Map();
const manuallyStopped = new Set();
const startingSessions = new Set();

async function startWhatsappSession(
  firebaseUid,
  userEmail,
  businessPrompt,
  onQrCode = null,
  connectionMethod = 'qr',
  phoneNumber = null
) {
  if (startingSessions.has(firebaseUid)) {
    console.log(`⏳ Session déjà en démarrage: ${firebaseUid}`);
    return activeSockets.get(firebaseUid) || null;
  }

  const existingSocket = activeSockets.get(firebaseUid);

  if (existingSocket) {
    console.log(`✅ Socket déjà actif: ${firebaseUid}`);
    return existingSocket;
  }

  startingSessions.add(firebaseUid);
  manuallyStopped.delete(firebaseUid);

  try {
    console.log(
      `🚀 Démarrage WhatsApp ${firebaseUid} | méthode=${connectionMethod}`
    );

    const { state, saveCreds } =
      await useFirestoreAuthState(firebaseUid);

    const { version } =
      await fetchLatestBaileysVersion();

    businessPrompts.set(
      firebaseUid,
      businessPrompt || ''
    );

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['WhagemIA', 'Chrome', '1.0.0'],
    });

    activeSockets.set(firebaseUid, sock);

    if (onQrCode) {
      qrCallbacks.set(firebaseUid, onQrCode);
    }

    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (error) {
        console.error(
          `❌ Erreur sauvegarde Firestore ${firebaseUid}:`,
          error.message
        );
      }
    });

    let pairingRequested = false;

    sock.ev.on('connection.update', async (update) => {
      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      // =====================================================
      // QR CODE
      // =====================================================

      if (qr && connectionMethod === 'qr') {
        console.log(
          `📲 QR CODE généré pour ${firebaseUid}`
        );

        const callback =
          qrCallbacks.get(firebaseUid);

        if (callback) {
          callback(qr, null, null);
        }
      }

      // =====================================================
      // CODE DE PAIRAGE
      // =====================================================

      if (
        connectionMethod === 'pairing' &&
        phoneNumber &&
        !state.creds.registered &&
        !pairingRequested &&
        (connection === 'connecting' || qr)
      ) {
        pairingRequested = true;

        try {
          const cleanPhone =
            String(phoneNumber).replace(/\D/g, '');

          if (!cleanPhone) {
            throw new Error(
              'Numéro de téléphone invalide'
            );
          }

          console.log(
            `📱 Demande code de pairage pour ${firebaseUid}`
          );

          const code =
            await sock.requestPairingCode(
              cleanPhone
            );

          console.log(
            `🔐 Code de pairage ${firebaseUid}: ${code}`
          );

          const callback =
            qrCallbacks.get(firebaseUid);

          if (callback) {
            callback(null, code, null);
          }
        } catch (error) {
          console.error(
            `❌ Erreur code pairage ${firebaseUid}:`,
            error.message
          );

          const callback =
            qrCallbacks.get(firebaseUid);

          if (callback) {
            callback(
              null,
              null,
              'PAIRING_CODE_ERROR'
            );
          }

          pairingRequested = false;
        }
      }

      // =====================================================
      // CONNEXION OUVERTE
      // =====================================================

      if (connection === 'open') {
        console.log(
          `🟢 WhatsApp connecté: ${firebaseUid}`
        );

        try {
          const connectedNumber =
            sock.user?.id?.split(':')[0] ||
            sock.user?.id?.split('@')[0];

          if (!connectedNumber) {
            console.warn(
              `⚠️ Numéro WhatsApp impossible à récupérer: ${firebaseUid}`
            );
          } else {
            const whatsappNumberHash =
              crypto
                .createHash('sha256')
                .update(connectedNumber)
                .digest('hex');

            // ---------------------------------------------
            // Anti-abus
            // ---------------------------------------------

            const existingByNumber =
              await userModel.findUserByWhatsappHash(
                whatsappNumberHash
              );

            if (
              existingByNumber &&
              existingByNumber.id !== firebaseUid
            ) {
              console.warn(
                `⚠️ Numéro WhatsApp déjà utilisé: ${firebaseUid}`
              );

              manuallyStopped.add(firebaseUid);

              await sock.end();

              activeSockets.delete(firebaseUid);

              const callback =
                qrCallbacks.get(firebaseUid);

              if (callback) {
                callback(
                  null,
                  null,
                  'NUMBER_ALREADY_USED'
                );
              }

              return;
            }

            // ---------------------------------------------
            // Utilisateur
            // ---------------------------------------------

            let user =
              await userModel.getUserById(
                firebaseUid
              );

            if (!user) {
              await userModel.createUser({
                firebaseUid,
                email: userEmail,
                whatsappNumberHash,
              });
            } else {
              await userModel.updateUser(
                firebaseUid,
                {
                  whatsappNumberHash,
                  businessPrompt:
                    businessPrompt || '',
                }
              );
            }
          }

          // ---------------------------------------------
          // Session Firestore
          // ---------------------------------------------

          await sessionModel.saveSessionStatus(
            firebaseUid,
            {
              connected: true,
              lastActiveAt:
                new Date().toISOString(),
            }
          );

          await sessionModel.setLastProcessedTimestamp(
            firebaseUid,
            new Date().toISOString()
          );

          qrCallbacks.delete(firebaseUid);

          console.log(
            `✅ Session WhatsApp prête: ${firebaseUid}`
          );
        } catch (error) {
          console.error(
            `❌ Erreur après connexion ${firebaseUid}:`,
            error.message
          );
        }
      }

      // =====================================================
      // CONNEXION FERMÉE
      // =====================================================

      if (connection === 'close') {
        console.log(
          `🔴 Connexion WhatsApp fermée: ${firebaseUid}`
        );

        activeSockets.delete(firebaseUid);

        await sessionModel.saveSessionStatus(
          firebaseUid,
          {
            connected: false,
          }
        );

        // ---------------------------------------------
        // Arrêt manuel
        // ---------------------------------------------

        if (
          manuallyStopped.has(firebaseUid)
        ) {
          console.log(
            `🛑 Arrêt manuel confirmé: ${firebaseUid}`
          );

          qrCallbacks.delete(firebaseUid);

          return;
        }

        // ---------------------------------------------
        // Déconnexion WhatsApp
        // ---------------------------------------------

        const statusCode =
          new Boom(
            lastDisconnect?.error
          )?.output?.statusCode;

        const shouldReconnect =
          statusCode !==
          DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log(
            `🔄 Reconnexion automatique: ${firebaseUid}`
          );

          const user =
            await userModel.getUserById(
              firebaseUid
            );

          if (!user) {
            console.warn(
              `⚠️ Utilisateur introuvable pour reconnexion: ${firebaseUid}`
            );

            return;
          }

          // Ne reconnecte pas un bot désactivé
          if (!user.botEnabled) {
            console.log(
              `🛑 Bot désactivé, pas de reconnexion: ${firebaseUid}`
            );

            return;
          }

          try {
            await startWhatsappSession(
              firebaseUid,
              user.email,
              user.businessPrompt || '',
              null,
              'qr',
              null
            );
          } catch (error) {
            console.error(
              `❌ Erreur reconnexion ${firebaseUid}:`,
              error.message
            );
          }
        } else {
          console.log(
            `🚪 Session WhatsApp déconnectée définitivement: ${firebaseUid}`
          );

          businessPrompts.delete(firebaseUid);
          qrCallbacks.delete(firebaseUid);
        }
      }
    });

    // =====================================================
    // MESSAGES
    // =====================================================

    sock.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages?.[0];

        if (!msg) return;
        if (!msg.message) return;
        if (msg.key.fromMe) return;

        const prompt =
          businessPrompts.get(firebaseUid) ||
          businessPrompt ||
          '';

        await handleIncomingMessage(
          firebaseUid,
          sock,
          msg,
          prompt
        );
      }
    );

    return sock;
  } finally {
    startingSessions.delete(firebaseUid);
  }
}

// ============================================================
// TRAITEMENT DES MESSAGES
// ============================================================

async function handleIncomingMessage(
  firebaseUid,
  sock,
  msg,
  businessPrompt
) {
  try {
    const user =
      await userModel.getUserById(firebaseUid);

    if (!user) return;

    if (
      !user.botEnabled ||
      user.status === 'expired'
    ) {
      return;
    }

    // --------------------------------------------------------
    // QUOTA
    // --------------------------------------------------------

    const tokensInUsed =
      Number(user.tokensInUsed || 0);

    const tokensOutUsed =
      Number(user.tokensOutUsed || 0);

    const tokensInLimit =
      Number(user.tokensInLimit || 0);

    const tokensOutLimit =
      Number(user.tokensOutLimit || 0);

    if (
      tokensInUsed >= tokensInLimit ||
      tokensOutUsed >= tokensOutLimit
    ) {
      await userModel.updateUser(
        firebaseUid,
        {
          status: 'expired',
          botEnabled: false,
        }
      );

      await sock.sendMessage(
        msg.key.remoteJid,
        {
          text:
            'Service temporairement indisponible. Merci de renouveler votre abonnement pour continuer.',
        }
      );

      return;
    }

    // --------------------------------------------------------
    // ANCIENS MESSAGES
    // --------------------------------------------------------

    const lastProcessed =
      await sessionModel.getLastProcessedTimestamp(
        firebaseUid
      );

    const msgTimestamp =
      Number(msg.messageTimestamp || 0) * 1000;

    if (
      lastProcessed &&
      msgTimestamp <
        new Date(lastProcessed).getTime()
    ) {
      return;
    }

    // --------------------------------------------------------
    // MESSAGE
    // --------------------------------------------------------

    const userMessage =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!userMessage.trim()) return;

    // --------------------------------------------------------
    // GEMINI
    // --------------------------------------------------------

    let text;
    let tokensIn;
    let tokensOut;

    try {
      ({
        text,
        tokensIn,
        tokensOut,
      } =
        await geminiService.generateReply(
          businessPrompt,
          userMessage
        ));
    } catch (error) {
      console.error(
        `❌ Erreur Gemini ${firebaseUid}:`,
        error.message
      );

      await sock.sendMessage(
        msg.key.remoteJid,
        {
          text:
            'Désolé, je rencontre un souci technique en ce moment. Réessayez dans un instant.',
        }
      );

      return;
    }

    // --------------------------------------------------------
    // COMPTEUR TOKENS
    // --------------------------------------------------------

    const usage =
      await userModel.incrementTokenUsage(
        firebaseUid,
        tokensIn,
        tokensOut
      );

    if (usage.limitReached) {
      await sock.sendMessage(
        msg.key.remoteJid,
        {
          text:
            'Service temporairement indisponible. Merci de renouveler votre abonnement pour continuer.',
        }
      );

      return;
    }

    // --------------------------------------------------------
    // RÉPONSE WHATSAPP
    // --------------------------------------------------------

    await sock.sendMessage(
      msg.key.remoteJid,
      {
        text,
      }
    );
  } catch (error) {
    console.error(
      `❌ Erreur traitement message ${firebaseUid}:`,
      error.message
    );
  }
}

// ============================================================
// ARRÊTER UNE SESSION
// ============================================================

async function stopWhatsappSession(firebaseUid) {
  console.log(
    `🛑 Arrêt demandé pour ${firebaseUid}`
  );

  manuallyStopped.add(firebaseUid);

  const sock =
    activeSockets.get(firebaseUid);

  if (sock) {
    try {
      await sock.end(
        new Error('Session arrêtée manuellement')
      );
    } catch (error) {
      console.error(
        `Erreur fermeture socket ${firebaseUid}:`,
        error.message
      );
    }
  }

  activeSockets.delete(firebaseUid);

  await sessionModel.saveSessionStatus(
    firebaseUid,
    {
      connected: false,
    }
  );

  console.log(
    `✅ Session arrêtée: ${firebaseUid}`
  );
}

// ============================================================
// SOCKET ACTIF
// ============================================================

function getActiveSocket(firebaseUid) {
  return activeSockets.get(firebaseUid) || null;
}

// ============================================================
// RECONNEXION AU DÉMARRAGE DU SERVEUR
// ============================================================

async function reconnectAllActiveSessions() {
  console.log(
    '🔄 Recherche des sessions WhatsApp à reconnecter...'
  );

  let uids = [];

  try {
    uids =
      await sessionModel.getAllConnectedUids();
  } catch (error) {
    console.error(
      '❌ Impossible de récupérer les sessions:',
      error.message
    );

    return;
  }

  console.log(
    `📊 ${uids.length} session(s) trouvée(s)`
  );

  for (const firebaseUid of uids) {
    try {
      const user =
        await userModel.getUserById(
          firebaseUid
        );

      if (!user) continue;

      if (!user.botEnabled) {
        console.log(
          `⏭️ Bot désactivé: ${firebaseUid}`
        );

        continue;
      }

      if (
        user.status === 'expired'
      ) {
        console.log(
          `⏭️ Abonnement expiré: ${firebaseUid}`
        );

        continue;
      }

      await startWhatsappSession(
        firebaseUid,
        user.email,
        user.businessPrompt || '',
        null,
        'qr',
        null
      );

      console.log(
        `🔄 Reconnexion lancée: ${firebaseUid}`
      );
    } catch (error) {
      console.error(
        `❌ Reconnexion impossible ${firebaseUid}:`,
        error.message
      );
    }
  }
}

module.exports = {
  startWhatsappSession,
  stopWhatsappSession,
  getActiveSocket,
  reconnectAllActiveSessions,
};
