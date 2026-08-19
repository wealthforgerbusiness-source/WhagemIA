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

// notifier located under backend/services
const notifier = require('../backend/services/notificationService');

const activeSockets = new Map();
const qrCallbacks = new Map();
const businessPrompts = new Map();

// ============================================================
// NOUVEAU : permet de différencier
// - une fermeture volontaire depuis le dashboard
// - une vraie déconnexion WhatsApp / réseau
// ============================================================
const manuallyStopped = new Set();


// ============================================================
// DÉMARRER UNE SESSION WHATSAPP
// ============================================================
async function startWhatsappSession(
  firebaseUid,
  userEmail,
  businessPrompt,
  onQrCode,
  usePairingCode,
  phoneNumber
) {
  console.log(`🚀 Démarrage session WhatsApp pour ${firebaseUid}`);

  // Si on redémarre volontairement la session,
  // on retire le statut "arrêté manuellement".
  manuallyStopped.delete(firebaseUid);

  // Si un ancien socket existe encore, on ne crée pas un doublon.
  const existingSocket = activeSockets.get(firebaseUid);

  if (existingSocket) {
    console.log(`ℹ️ Une session WhatsApp existe déjà pour ${firebaseUid}`);
    return existingSocket;
  }

  // ==========================================================
  // FIRESTORE AUTH STATE
  // ==========================================================
  const { state, saveCreds } = await useFirestoreAuthState(firebaseUid);

  const { version } = await fetchLatestBaileysVersion();

  businessPrompts.set(firebaseUid, businessPrompt || '');

  // ==========================================================
  // CRÉATION DU SOCKET WHATSAPP
  // ==========================================================
  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  activeSockets.set(firebaseUid, sock);

  if (onQrCode) {
    qrCallbacks.set(firebaseUid, onQrCode);
  }

  // ==========================================================
  // PAIRING CODE
  // ==========================================================
  if (usePairingCode && phoneNumber && !sock.authState.creds.registered) {
    try {
      console.log(`📱 Génération du code de pairage pour ${firebaseUid}`);

      const code = await sock.requestPairingCode(phoneNumber);

      const callback = qrCallbacks.get(firebaseUid);

      if (callback) {
        callback(null, code);
      }
    } catch (err) {
      console.error(`❌ Erreur génération pairing code pour ${firebaseUid}:`, err.message);
      const callback = qrCallbacks.get(firebaseUid);
      if (callback) callback(null, null, 'PAIRING_GENERATION_FAILED');
    }
  }

  // ==========================================================
  // SAUVEGARDE DES CREDENTIALS FIRESTORE
  // ==========================================================
  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (error) {
      console.error(`❌ Erreur sauvegarde credentials Firestore ${firebaseUid}:`, error.message);
    }
  });

  // ==========================================================
  // CONNEXION WHATSAPP
  // ==========================================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // --------------------------------------------------------
    // QR CODE
    // --------------------------------------------------------
    if (qr && !usePairingCode) {
      console.log(`📲 Nouveau QR code WhatsApp pour ${firebaseUid}`);

      const callback = qrCallbacks.get(firebaseUid);

      if (callback) {
        callback(qr, null);
      }
    }

    // --------------------------------------------------------
    // CONNEXION OUVERTE
    // --------------------------------------------------------
    if (connection === 'open') {
      console.log(`✅ WhatsApp connecté pour ${firebaseUid}`);

      try {
        const connectedNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0];

        if (connectedNumber) {
          const whatsappNumberHash = crypto.createHash('sha256').update(connectedNumber).digest('hex');

          const existingByNumber = await userModel.findUserByWhatsappHash(whatsappNumberHash);

          if (existingByNumber && existingByNumber.id !== firebaseUid) {
            console.warn(`⚠️ Numéro WhatsApp déjà utilisé par un autre compte: ${firebaseUid}`);

            manuallyStopped.add(firebaseUid);

            try {
              await sock.end();
            } catch (error) {
              console.error(`Erreur fermeture socket ${firebaseUid}:`, error.message);
            }

            if (activeSockets.get(firebaseUid) === sock) {
              activeSockets.delete(firebaseUid);
            }

            const callback = qrCallbacks.get(firebaseUid);

            if (callback) {
              callback(null, null, 'NUMBER_ALREADY_USED');
            }

            // notify number already used
            notifier.emit(firebaseUid, {
              status: 'error',
              error: 'NUMBER_ALREADY_USED',
              updatedAt: new Date().toISOString(),
            });

            return;
          }

          let user = await userModel.getUserById(firebaseUid);

          if (!user) {
            user = await userModel.createUser({
              firebaseUid,
              email: userEmail,
              whatsappNumberHash,
            });

            console.log(`👤 Utilisateur créé en base: ${firebaseUid}`);
          }

          await userModel.updateUser(firebaseUid, {
            businessPrompt: businessPrompt || '',
            whatsappNumberHash,
          });
        } else {
          console.warn(`⚠️ Impossible de récupérer le numéro WhatsApp pour ${firebaseUid}`);
        }

        await sessionModel.saveSessionStatus(firebaseUid, {
          connected: true,
          lastActiveAt: new Date().toISOString(),
        });

        await sessionModel.setLastProcessedTimestamp(firebaseUid, new Date().toISOString());

        qrCallbacks.delete(firebaseUid);

        // notify connected
        notifier.emit(firebaseUid, {
          status: 'connected',
          connected: true,
          updatedAt: new Date().toISOString(),
        });

        console.log(`🟢 Session WhatsApp prête pour ${firebaseUid}`);
      } catch (error) {
        console.error(`❌ Erreur après connexion WhatsApp ${firebaseUid}:`, error.message);
      }
    }

    // --------------------------------------------------------
    // CONNEXION FERMÉE
    // --------------------------------------------------------
    if (connection === 'close') {
      console.log(`🔴 Connexion WhatsApp fermée pour ${firebaseUid}`);

      if (activeSockets.get(firebaseUid) === sock) {
        activeSockets.delete(firebaseUid);
      }

      await sessionModel.saveSessionStatus(firebaseUid, { connected: false });

      // ======================================================
      // ARRÊT VOLONTAIRE DEPUIS LE DASHBOARD
      // ======================================================
      if (manuallyStopped.has(firebaseUid)) {
        console.log(`🛑 Session arrêtée volontairement pour ${firebaseUid} — aucune reconnexion`);

        qrCallbacks.delete(firebaseUid);

        // notify disconnected
        notifier.emit(firebaseUid, {
          status: 'disconnected',
          connected: false,
          updatedAt: new Date().toISOString(),
        });

        return;
      }

      // ======================================================
      // DÉTERMINER SI BAILEYS DOIT RECONNECTER
      // ======================================================
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log(`🔄 Reconnexion automatique WhatsApp pour ${firebaseUid}...`);

        const savedPrompt = businessPrompts.get(firebaseUid) || businessPrompt || '';

        try {
          await startWhatsappSession(firebaseUid, userEmail, savedPrompt, null, false, null);
        } catch (error) {
          console.error(`❌ Erreur reconnexion WhatsApp ${firebaseUid}:`, error.message);
        }
      } else {
        console.log(`🚪 Déconnexion définitive WhatsApp pour ${firebaseUid} (logout)`);

        businessPrompts.delete(firebaseUid);
        qrCallbacks.delete(firebaseUid);

        notifier.emit(firebaseUid, {
          status: 'disconnected',
          connected: false,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  });

  // ==========================================================
  // MESSAGES ENTRANTS
  // ==========================================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];

    if (!msg) return;

    if (!msg.message) return;

    if (msg.key.fromMe) return;

    const prompt = businessPrompts.get(firebaseUid) || businessPrompt || '';

    await handleIncomingMessage(firebaseUid, sock, msg, prompt);
  });

  return sock;
}


// ============================================================
// TRAITEMENT DES MESSAGES
// ============================================================
async function handleIncomingMessage(firebaseUid, sock, msg, businessPrompt) {
  try {
    const user = await userModel.getUserById(firebaseUid);

    if (!user) return;

    if (!user.botEnabled) return;

    if (user.status === 'expired') return;

    const alreadyOverLimit = user.tokensInUsed >= user.tokensInLimit || user.tokensOutUsed >= user.tokensOutLimit;

    if (alreadyOverLimit) {
      if (user.status !== 'expired') {
        await userModel.updateUser(firebaseUid, { status: 'expired', botEnabled: false });
      }

      await sock.sendMessage(msg.key.remoteJid, { text: 'Service temporairement indisponible. Merci de renouveler votre abonnement pour continuer.' });

      return;
    }

    const lastProcessed = await sessionModel.getLastProcessedTimestamp(firebaseUid);

    const msgTimestamp = (msg.messageTimestamp || 0) * 1000;

    if (lastProcessed && msgTimestamp < new Date(lastProcessed).getTime()) {
      return;
    }

    const userMessage = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

    if (!userMessage.trim()) return;

    let text; let tokensIn; let tokensOut;

    try {
      ({ text, tokensIn, tokensOut } = await geminiService.generateReply(businessPrompt, userMessage));
    } catch (geminiError) {
      console.error(`❌ Erreur Gemini pour ${firebaseUid}:`, geminiError.message);

      try {
        await sock.sendMessage(msg.key.remoteJid, { text: 'Désolé, je rencontre un souci technique en ce moment. Réessayez dans un instant.' });
      } catch (sendError) {
        console.error(`Erreur envoi message erreur Gemini ${firebaseUid}:`, sendError.message);
      }

      return;
    }

    const usage = await userModel.incrementTokenUsage(firebaseUid, tokensIn, tokensOut);

    if (usage.limitReached) {
      await sock.sendMessage(msg.key.remoteJid, { text: 'Service temporairement indisponible. Merci de renouveler votre abonnement pour continuer.' });
      return;
    }

    await sock.sendMessage(msg.key.remoteJid, { text });
  } catch (error) {
    console.error(`❌ Erreur traitement message pour ${firebaseUid}:`, error.message);
  }
}


// ============================================================
// ARRÊTER UNE SESSION WHATSAPP
// ============================================================
async function stopWhatsappSession(firebaseUid) {
  console.log(`🛑 Arrêt demandé pour la session WhatsApp ${firebaseUid}`);

  manuallyStopped.add(firebaseUid);

  const sock = activeSockets.get(firebaseUid);

  if (!sock) {
    console.log(`ℹ️ Aucun socket actif à arrêter pour ${firebaseUid}`);

    await sessionModel.saveSessionStatus(firebaseUid, { connected: false });

    notifier.emit(firebaseUid, {
      status: 'disconnected',
      connected: false,
      updatedAt: new Date().toISOString(),
    });

    return;
  }

  try {
    await sock.end();

    console.log(`✅ Socket WhatsApp arrêté pour ${firebaseUid}`);
  } catch (error) {
    console.error(`❌ Erreur arrêt socket ${firebaseUid}:`, error.message);
  }

  if (activeSockets.get(firebaseUid) === sock) {
    activeSockets.delete(firebaseUid);
  }

  await sessionModel.saveSessionStatus(firebaseUid, { connected: false });

  qrCallbacks.delete(firebaseUid);
}


// ============================================================
// RÉCUPÉRER LE SOCKET ACTIF
// ============================================================
function getActiveSocket(firebaseUid) {
  return activeSockets.get(firebaseUid);
}


// ============================================================
// RECONNEXION DE TOUTES LES SESSIONS AU DÉMARRAGE DU SERVEUR
// ============================================================
async function reconnectAllActiveSessions() {
  try {
    const uids = await sessionModel.getAllConnectedUids();

    console.log(`🔄 Reconnexion automatique de ${uids.length} session(s) au démarrage...`);

    for (const firebaseUid of uids) {
      try {
        if (manuallyStopped.has(firebaseUid)) {
          console.log(`⏭️ Session ${firebaseUid} ignorée : arrêt manuel`);
          continue;
        }

        const user = await userModel.getUserById(firebaseUid);

        if (!user) {
          console.warn(`⚠️ Utilisateur introuvable pour ${firebaseUid}`);
          continue;
        }

        if (!user.botEnabled) {
          console.log(`⏭️ Bot désactivé pour ${firebaseUid}, pas de reconnexion`);
          continue;
        }

        if (!user.businessPrompt) {
          console.warn(`⚠️ Aucun businessPrompt pour ${firebaseUid}`);
          continue;
        }

        console.log(`📱 Reconnexion de ${firebaseUid} avec les credentials Firestore...`);

        await startWhatsappSession(firebaseUid, user.email, user.businessPrompt, null, false, null);
      } catch (error) {
        console.error(`❌ Erreur reconnexion auto pour ${firebaseUid}:`, error.message);
      }
    }
  } catch (error) {
    console.error('❌ Erreur récupération des sessions au démarrage:', error.message);
  }
}


// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  startWhatsappSession,
  stopWhatsappSession,
  getActiveSocket,
  reconnectAllActiveSessions,
};
