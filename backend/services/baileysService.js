const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');

const geminiService = require('./geminiService');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');

const activeSockets = new Map();
const qrCallbacks = new Map();
const businessPrompts = new Map();

// Permet de distinguer :
// - fermeture volontaire par l'utilisateur
// - déconnexion réelle de WhatsApp
const manuallyStopped = new Set();

// Empêche plusieurs connexions simultanées pour le même utilisateur
const startingSessions = new Set();

const SESSIONS_DIR = path.join(__dirname, '..', 'baileys_sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/**
 * Démarre ou redémarre une session WhatsApp.
 */
async function startWhatsappSession(
  firebaseUid,
  userEmail,
  businessPrompt,
  onQrCode,
  usePairingCode,
  phoneNumber
) {
  // Si une session est déjà en cours de démarrage,
  // on ne crée pas une deuxième connexion.
  if (startingSessions.has(firebaseUid)) {
    console.log(`Session déjà en cours de démarrage pour ${firebaseUid}`);
    return activeSockets.get(firebaseUid) || null;
  }

  // Si un socket existe déjà et est actif, on le réutilise.
  const existingSocket = activeSockets.get(firebaseUid);

  if (existingSocket) {
    console.log(`WhatsApp déjà actif pour ${firebaseUid}`);
    return existingSocket;
  }

  startingSessions.add(firebaseUid);

  // Une nouvelle demande de démarrage annule le statut "arrêté manuellement".
  manuallyStopped.delete(firebaseUid);

  const sessionPath = path.join(SESSIONS_DIR, firebaseUid);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    businessPrompts.set(firebaseUid, businessPrompt);

    console.log(`Démarrage WhatsApp pour ${firebaseUid}`);

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

    /**
     * Sauvegarde les credentials Baileys.
     */
    sock.ev.on('creds.update', async () => {
      try {
        await saveCreds();
      } catch (error) {
        console.error(
          `Erreur sauvegarde credentials WhatsApp ${firebaseUid}:`,
          error.message
        );
      }
    });

    /**
     * Code de pairage.
     */
    if (
      usePairingCode &&
      phoneNumber &&
      !sock.authState.creds.registered
    ) {
      try {
        const code = await sock.requestPairingCode(phoneNumber);

        const callback = qrCallbacks.get(firebaseUid);

        if (callback) {
          callback(null, code);
        }

        console.log(`Code de pairage généré pour ${firebaseUid}`);
      } catch (error) {
        console.error(
          `Erreur génération pairing code ${firebaseUid}:`,
          error.message
        );
      }
    }

    /**
     * Événements de connexion WhatsApp.
     */
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      /**
       * QR CODE
       */
      if (qr && !usePairingCode) {
        const callback = qrCallbacks.get(firebaseUid);

        if (callback) {
          callback(qr, null);
        }
      }

      /**
       * CONNEXION RÉUSSIE
       */
      if (connection === 'open') {
        console.log(`WhatsApp connecté pour ${firebaseUid}`);

        // On récupère le socket actuel.
        // Important pour éviter qu'un ancien socket écrase un nouveau.
        if (activeSockets.get(firebaseUid) !== sock) {
          console.warn(
            `Ancienne session ignorée pour ${firebaseUid}`
          );
          return;
        }

        const connectedNumber =
          sock.user?.id?.split(':')[0] ||
          sock.user?.id?.split('@')[0];

        if (connectedNumber) {
          const whatsappNumberHash = crypto
            .createHash('sha256')
            .update(connectedNumber)
            .digest('hex');

          /**
           * Anti-abus :
           * un numéro WhatsApp ne peut pas être utilisé
           * sur plusieurs comptes.
           */
          const existingByNumber =
            await userModel.findUserByWhatsappHash(
              whatsappNumberHash
            );

          if (
            existingByNumber &&
            existingByNumber.id !== firebaseUid
          ) {
            console.warn(
              `Numéro WhatsApp déjà utilisé par un autre compte: ${firebaseUid}`
            );

            manuallyStopped.add(firebaseUid);

            try {
              await sock.logout();
            } catch (error) {
              console.error(
                `Erreur logout numéro déjà utilisé ${firebaseUid}:`,
                error.message
              );
            }

            if (activeSockets.get(firebaseUid) === sock) {
              activeSockets.delete(firebaseUid);
            }

            const callback = qrCallbacks.get(firebaseUid);

            if (callback) {
              callback(null, null, 'NUMBER_ALREADY_USED');
            }

            return;
          }

          /**
           * Création/récupération de l'utilisateur.
           */
          let user = await userModel.getUserById(firebaseUid);

          if (!user) {
            user = await userModel.createUser({
              firebaseUid,
              email: userEmail,
              whatsappNumberHash,
            });
          }

          await userModel.updateUser(firebaseUid, {
            businessPrompt,
            whatsappNumberHash,
          });
        } else {
          console.warn(
            `Impossible de récupérer le numéro WhatsApp connecté pour ${firebaseUid}`
          );
        }

        /**
         * Mise à jour du statut en base.
         */
        await sessionModel.saveSessionStatus(firebaseUid, {
          connected: true,
          lastActiveAt: new Date().toISOString(),
        });

        await sessionModel.setLastProcessedTimestamp(
          firebaseUid,
          new Date().toISOString()
        );

        qrCallbacks.delete(firebaseUid);

        console.log(
          `Session WhatsApp prête pour ${firebaseUid}`
        );
      }

      /**
       * CONNEXION FERMÉE
       */
      if (connection === 'close') {
        const statusCode =
          new Boom(lastDisconnect?.error)?.output?.statusCode;

        console.log(
          `Connexion WhatsApp fermée pour ${firebaseUid}. Code: ${statusCode}`
        );

        /**
         * IMPORTANT :
         * Si l'utilisateur a volontairement désactivé le bot,
         * surtout NE PAS reconnecter.
         */
        if (manuallyStopped.has(firebaseUid)) {
          console.log(
            `Arrêt volontaire détecté pour ${firebaseUid}. Pas de reconnexion.`
          );

          if (activeSockets.get(firebaseUid) === sock) {
            activeSockets.delete(firebaseUid);
          }

          await sessionModel.saveSessionStatus(firebaseUid, {
            connected: false,
          });

          return;
        }

        /**
         * Si le socket fermé n'est plus le socket actif,
         * on ne touche pas au nouveau socket.
         */
        if (activeSockets.get(firebaseUid) === sock) {
          activeSockets.delete(firebaseUid);
        }

        await sessionModel.saveSessionStatus(firebaseUid, {
          connected: false,
        });

        /**
         * LOGOUT WHATSAPP
         *
         * Dans ce cas, WhatsApp a réellement invalidé
         * la session.
         */
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(
            `Session WhatsApp expirée/déconnectée pour ${firebaseUid}`
          );

          businessPrompts.delete(firebaseUid);

          const callback = qrCallbacks.get(firebaseUid);

          if (callback) {
            callback(null, null, 'SESSION_EXPIRED');
          }

          return;
        }

        /**
         * AUTRE DÉCONNEXION :
         * on tente une reconnexion automatique.
         */
        console.log(
          `Reconnexion automatique WhatsApp pour ${firebaseUid}...`
        );

        const savedPrompt =
          businessPrompts.get(firebaseUid) || businessPrompt;

        setTimeout(() => {
          if (!manuallyStopped.has(firebaseUid)) {
            startWhatsappSession(
              firebaseUid,
              userEmail,
              savedPrompt,
              null,
              false,
              null
            ).catch((error) => {
              console.error(
                `Erreur reconnexion WhatsApp ${firebaseUid}:`,
                error.message
              );
            });
          }
        }, 3000);
      }
    });

    /**
     * Réception des messages WhatsApp.
     */
    sock.ev.on(
      'messages.upsert',
      async ({ messages, type }) => {
        if (type !== 'notify') return;

        const msg = messages[0];

        if (!msg?.message) return;
        if (msg.key?.fromMe) return;

        /**
         * Vérifie que ce socket est toujours le socket actif.
         */
        if (activeSockets.get(firebaseUid) !== sock) {
          return;
        }

        const prompt =
          businessPrompts.get(firebaseUid) ||
          businessPrompt;

        await handleIncomingMessage(
          firebaseUid,
          sock,
          msg,
          prompt
        );
      }
    );

    return sock;
  } catch (error) {
    console.error(
      `Erreur démarrage WhatsApp ${firebaseUid}:`,
      error
    );

    activeSockets.delete(firebaseUid);

    throw error;
  } finally {
    startingSessions.delete(firebaseUid);
  }
}

/**
 * Traitement des messages entrants.
 */
async function handleIncomingMessage(
  firebaseUid,
  sock,
  msg,
  businessPrompt
) {
  try {
    const user = await userModel.getUserById(firebaseUid);

    if (!user) return;

    /**
     * Si le bot est désactivé ou le compte expiré,
     * il ne répond pas.
     */
    if (!user.botEnabled || user.status === 'expired') {
      return;
    }

    const lastProcessed =
      await sessionModel.getLastProcessedTimestamp(
        firebaseUid
      );

    const msgTimestamp =
      (msg.messageTimestamp || 0) * 1000;

    if (
      lastProcessed &&
      msgTimestamp < new Date(lastProcessed).getTime()
    ) {
      return;
    }

    const userMessage =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    if (!userMessage.trim()) return;

    let text;
    let tokensIn;
    let tokensOut;

    try {
      ({
        text,
        tokensIn,
        tokensOut,
      } = await geminiService.generateReply(
        businessPrompt,
        userMessage
      ));
    } catch (geminiError) {
      console.error(
        `Erreur Gemini pour ${firebaseUid}:`,
        geminiError.message
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
            "Service temporairement indisponible. Merci de renouveler votre abonnement pour continuer.",
        }
      );

      return;
    }

    await sock.sendMessage(
      msg.key.remoteJid,
      { text }
    );
  } catch (error) {
    console.error(
      `Erreur traitement message pour ${firebaseUid}:`,
      error.message
    );
  }
}

/**
 * ARRÊT VOLONTAIRE DU BOT
 *
 * Utilisé quand l'utilisateur clique sur OFF.
 */
async function stopWhatsappSession(firebaseUid) {
  console.log(
    `Arrêt volontaire du bot WhatsApp pour ${firebaseUid}`
  );

  /**
   * On indique AVANT sock.end()
   * que cette fermeture est volontaire.
   */
  manuallyStopped.add(firebaseUid);

  const sock = activeSockets.get(firebaseUid);

  if (sock) {
    try {
      sock.end(undefined);
    } catch (error) {
      console.error(
        `Erreur arrêt WhatsApp ${firebaseUid}:`,
        error.message
      );
    }

    if (activeSockets.get(firebaseUid) === sock) {
      activeSockets.delete(firebaseUid);
    }
  }

  await sessionModel.saveSessionStatus(firebaseUid, {
    connected: false,
  });

  console.log(
    `Bot WhatsApp arrêté pour ${firebaseUid}`
  );
}

/**
 * REDÉMARRAGE DU BOT
 *
 * À appeler quand l'utilisateur clique sur ON.
 */
async function restartWhatsappSession(
  firebaseUid,
  userEmail,
  businessPrompt,
  onQrCode,
  usePairingCode,
  phoneNumber
) {
  console.log(
    `Réactivation du bot WhatsApp pour ${firebaseUid}`
  );

  /**
   * Annule le mode "arrêt volontaire".
   */
  manuallyStopped.delete(firebaseUid);

  /**
   * Si une ancienne socket existe encore,
   * on la ferme avant de redémarrer.
   */
  const oldSocket = activeSockets.get(firebaseUid);

  if (oldSocket) {
    try {
      oldSocket.end(undefined);
    } catch (error) {
      console.error(
        `Erreur fermeture ancienne session ${firebaseUid}:`,
        error.message
      );
    }

    activeSockets.delete(firebaseUid);
  }

  /**
   * On récupère le prompt actuel si nécessaire.
   */
  const savedPrompt =
    businessPrompts.get(firebaseUid) ||
    businessPrompt ||
    '';

  /**
   * IMPORTANT :
   * useMultiFileAuthState retrouve automatiquement
   * les credentials existants dans :
   *
   * backend/baileys_sessions/<firebaseUid>
   *
   * Donc normalement aucun nouveau QR n'est nécessaire.
   */
  return startWhatsappSession(
    firebaseUid,
    userEmail,
    savedPrompt,
    onQrCode,
    usePairingCode,
    phoneNumber
  );
}

/**
 * Retourne le socket actif.
 */
function getActiveSocket(firebaseUid) {
  return activeSockets.get(firebaseUid);
}

/**
 * Retourne l'état du socket.
 */
function isWhatsappActive(firebaseUid) {
  return activeSockets.has(firebaseUid);
}

module.exports = {
  startWhatsappSession,
  restartWhatsappSession,
  stopWhatsappSession,
  getActiveSocket,
  isWhatsappActive,
};
