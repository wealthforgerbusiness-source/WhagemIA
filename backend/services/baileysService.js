const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const pino = require('pino');

const geminiService = require('./geminiService');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');

// Stocke les connexions actives en mémoire (une par utilisateur)
const activeSockets = new Map();
const qrCallbacks = new Map();

const SESSIONS_DIR = path.join(__dirname, '..', 'baileys_sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

async function startWhatsappSession(firebaseUid, businessPrompt, onQrCode) {
  const sessionPath = path.join(SESSIONS_DIR, firebaseUid);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  activeSockets.set(firebaseUid, sock);
  if (onQrCode) qrCallbacks.set(firebaseUid, onQrCode);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const callback = qrCallbacks.get(firebaseUid);
      if (callback) callback(qr);
    }

    if (connection === 'open') {
      console.log(`WhatsApp connecté pour ${firebaseUid}`);
      await sessionModel.saveSessionStatus(firebaseUid, {
        connected: true,
        lastActiveAt: new Date().toISOString(),
      });
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
        startWhatsappSession(firebaseUid, businessPrompt, onQrCode);
      } else {
        console.log(`Déconnexion définitive pour ${firebaseUid} (logout)`);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    await handleIncomingMessage(firebaseUid, sock, msg, businessPrompt);
  });

  return sock;
}

async function handleIncomingMessage(firebaseUid, sock, msg, businessPrompt) {
  try {
    const user = await userModel.getUserById(firebaseUid);
    if (!user) return;

    // Bot désactivé manuellement ou abonnement expiré
    if (!user.botEnabled || user.status === 'expired') return;

    // Ignorer les messages antérieurs à la dernière réactivation
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

    const { text, tokensIn, tokensOut } = await geminiService.generateReply(
      businessPrompt,
      userMessage
    );

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

module.exports = {
  startWhatsappSession,
  stopWhatsappSession,
  getActiveSocket,
};
