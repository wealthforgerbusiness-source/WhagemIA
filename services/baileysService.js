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
const businessPrompts = new Map(); // cache en mémoire (perdu au redémarrage, voir Firestore ci-dessous)

async function startWhatsappSession(firebaseUid, userEmail, businessPrompt, onQrCode, usePairingCode, phoneNumber) {
  // Sessions Baileys stockées dans Firestore : elles survivent aux redéploiements
  // et aux mises en veille de Render (avant : disque local, effacé à chaque redémarrage).
  const { state, saveCreds } = await useFirestoreAuthState(firebaseUid);
  const { version } = await fetchLatestBaileysVersion();

  businessPrompts.set(firebaseUid, businessPrompt);

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  activeSockets.set(firebaseUid, sock);
  if (onQrCode) qrCallbacks.set(firebaseUid, onQrCode);

  // Si l'utilisateur n'a qu'un téléphone : demander un code de pairage au lieu du QR
  if (usePairingCode && phoneNumber && !sock.authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(phoneNumber);
      const callback = qrCallbacks.get(firebaseUid);
      if (callback) callback(null, code); // null pour le QR, code pour le pairing
    } catch (err) {
      console.error('Erreur génération pairing code:', err.message);
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !usePairingCode) {
      const callback = qrCallbacks.get(firebaseUid);
      if (callback) callback(qr, null);
    }

    if (connection === 'open') {
      console.log(`WhatsApp connecté pour ${firebaseUid}`);

      // Récupère le numéro WhatsApp réellement connecté
      const connectedNumber = sock.user?.id?.split(':')[0] || sock.user?.id?.split('@')[0];

      if (connectedNumber) {
        const whatsappNumberHash = crypto
          .createHash('sha256')
          .update(connectedNumber)
          .digest('hex');

        // Anti-abus : vérifier si ce numéro a déjà utilisé l'essai sur un autre compte
        const existingByNumber = await userModel.findUserByWhatsappHash(whatsappNumberHash);

        if (existingByNumber && existingByNumber.id !== firebaseUid) {
          console.warn(`Numéro déjà utilisé par un autre compte: ${firebaseUid}`);
          await sock.end();
          activeSockets.delete(firebaseUid);
          const callback = qrCallbacks.get(firebaseUid);
          if (callback) callback(null, null, 'NUMBER_ALREADY_USED');
          return;
        }

        // Créer ou récupérer l'utilisateur en base
        let user = await userModel.getUserById(firebaseUid);
        if (!user) {
          user = await userModel.createUser({
            firebaseUid,
            email: userEmail,
            whatsappNumberHash,
          });
        }

        await userModel.updateUser(firebaseUid, { businessPrompt });
      } else {
        console.warn(
          `Impossible de lire le numéro WhatsApp connecté pour ${firebaseUid} — ` +
          `l'utilisateur ne sera pas créé en base et le bot ne répondra pas tant que ce n'est pas corrigé.`
        );
      }

      await sessionModel.saveSessionStatus(firebaseUid, {
        connected: true,
        lastActiveAt: new Date().toISOString(),
      });
      await sessionModel.setLastProcessedTimestamp(firebaseUid, new Date().toISOString());

      qrCallbacks.delete(firebaseUid);
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;

      await sessionModel.saveSessionStatus(firebaseUid, { connected: false });
      activeSockets.delete(firebaseUid);

      if (shouldReconnect) {
        console.log(`Reconnexion WhatsApp pour ${firebaseUid}...`);
        const savedPrompt = businessPrompts.get(firebaseUid) || businessPrompt;
        startWhatsappSession(firebaseUid, userEmail, savedPrompt, null, false, null);
      } else {
        console.log(`Déconnexion définitive pour ${firebaseUid} (logout)`);
        businessPrompts.delete(firebaseUid);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const prompt = businessPrompts.get(firebaseUid) || businessPrompt;
    await handleIncomingMessage(firebaseUid, sock, msg, prompt);
  });

  return sock;
}

async function handleIncomingMessage(firebaseUid, sock, msg, businessPrompt) {
  try {
    const user = await userModel.getUserById(firebaseUid);
    if (!user) return;

    if (!user.botEnabled || user.status === 'expired') return;

    // Vérification du quota AVANT d'appeler Gemini (donc avant toute dépense).
    // Auparavant le check se faisait après l'appel : le message qui faisait
    // dépasser le quota était quand même généré et facturé.
    const alreadyOverLimit =
      user.tokensInUsed >= user.tokensInLimit ||
      user.tokensOutUsed >= user.tokensOutLimit;

    if (alreadyOverLimit) {
      if (user.status !== 'expired') {
        await userModel.updateUser(firebaseUid, {
          status: 'expired',
          botEnabled: false,
        });
      }
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'Service temporairement indisponible. Merci de renouveler votre abonnement pour continuer.',
      });
      return;
    }

    const lastProcessed = await sessionModel.getLastProcessedTimestamp(firebaseUid);
    const msgTimestamp = (msg.messageTimestamp || 0) * 1000;
    if (lastProcessed && msgTimestamp < new Date(lastProcessed).getTime()) {
      return;
    }

    const userMessage =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!userMessage.trim()) return;

    let text, tokensIn, tokensOut;
    try {
      ({ text, tokensIn, tokensOut } = await geminiService.generateReply(
        businessPrompt,
        userMessage
      ));
    } catch (geminiError) {
      // On isole l'appel Gemini : si le modèle change de nom, est retiré, ou que la clé API
      // est invalide, on le voit clairement dans les logs au lieu d'un échec silencieux,
      // et le client WhatsApp reçoit un message au lieu de ne rien recevoir du tout.
      console.error(`Erreur Gemini pour ${firebaseUid}:`, geminiError.message);
      await sock.sendMessage(msg.key.remoteJid, {
        text: "Désolé, je rencontre un souci technique en ce moment. Réessayez dans un instant.",
      });
      return;
    }

    const usage = await userModel.incrementTokenUsage(
      firebaseUid,
      tokensIn,
      tokensOut
    );

    if (usage.limitReached) {
      await sock.sendMessage(msg.key.remoteJid, {
        text: 'Service temporairement indisponible. Merci de renouveler votre abonnement pour continuer.',
      });
      return;
    }

    await sock.sendMessage(msg.key.remoteJid, { text });
  } catch (error) {
    console.error(`Erreur traitement message pour ${firebaseUid}:`, error.message);
  }
}

async function stopWhatsappSession(firebaseUid) {
  const sock = activeSockets.get(firebaseUid);
  if (sock) {
    sock.end();
    activeSockets.delete(firebaseUid);
  }
}

function getActiveSocket(firebaseUid) {
  return activeSockets.get(firebaseUid);
}

// Relance automatiquement toutes les sessions qui étaient connectées avant
// un redémarrage / une mise en veille du serveur (Render gratuit endort le
// service après ~15 min sans trafic). Les creds étant maintenant dans Firestore,
// aucun nouveau QR code n'est nécessaire.
async function reconnectAllActiveSessions() {
  const uids = await sessionModel.getAllConnectedUids();
  console.log(`Reconnexion automatique de ${uids.length} session(s) au démarrage...`);

  for (const firebaseUid of uids) {
    try {
      const user = await userModel.getUserById(firebaseUid);
      if (!user || !user.businessPrompt) continue;

      await startWhatsappSession(
        firebaseUid,
        user.email,
        user.businessPrompt,
        null,
        false,
        null
      );
    } catch (error) {
      console.error(`Erreur reconnexion auto pour ${firebaseUid}:`, error.message);
    }
  }
}

module.exports = {
  startWhatsappSession,
  stopWhatsappSession,
  getActiveSocket,
  reconnectAllActiveSessions,
};
