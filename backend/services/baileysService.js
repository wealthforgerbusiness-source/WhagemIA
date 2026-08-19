const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const crypto = require('crypto');
const pino = require('pino');
const qrcode = require('qrcode');

const {
  useFirestoreAuthState,
} = require('./firestoreAuthState');

const geminiService = require('./geminiService');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');
const notifier = require('./notificationService');

const activeSockets = new Map();
const qrCallbacks = new Map();
const businessPrompts = new Map();

const manuallyStopped = new Set();
const startingSessions = new Set();
const connectedSockets = new Set();

async function startWhatsappSession(
  firebaseUid,
  userEmail,
  businessPrompt,
  onQrCode = null,
  connectionMethod = 'qr',
  phoneNumber = null
) {
  if (startingSessions.has(firebaseUid)) {
    console.log(
      `⏳ Session déjà en démarrage: ${firebaseUid}`
    );

    return activeSockets.get(firebaseUid) || null;
  }

  const existingSocket =
    activeSockets.get(firebaseUid);

  if (existingSocket) {
    console.log(
      `⚠️ Socket déjà présent: ${firebaseUid}`
    );

    return existingSocket;
  }

  startingSessions.add(firebaseUid);
  manuallyStopped.delete(firebaseUid);

  try {
    console.log(
      `🚀 Démarrage WhatsApp ${firebaseUid} | méthode=${connectionMethod}`
    );

    const {
      state,
      saveCreds,
    } = await useFirestoreAuthState(firebaseUid);

    let versionInfo;
    try {
      versionInfo = await fetchLatestBaileysVersion();
      console.log(`[baileysService] fetchLatestBaileysVersion OK: ${JSON.stringify(versionInfo)}`);
    } catch (err) {
      console.error('[baileysService] fetchLatestBaileysVersion failed:', err && (err.stack || err));
      // fallback: leave version undefined to let makeWASocket use default
      versionInfo = undefined;
    }

    const version = versionInfo?.version ? versionInfo.version : undefined;

    businessPrompts.set(
      firebaseUid,
      businessPrompt || ''
    );

    /*
     * IMPORTANT :
     * On considère la session comme NON CONNECTÉE
     * tant que connection !== 'open'.
     */
    connectedSockets.delete(firebaseUid);

    await sessionModel.saveSessionStatus(
      firebaseUid,
      {
        connected: false,
      }
    );

    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({
        level: 'silent',
      }),
      printQRInTerminal: false,
      browser: [
        'WhagemIA',
        'Chrome',
        '1.0.0',
      ],
    });

    activeSockets.set(
      firebaseUid,
      sock
    );

    if (onQrCode) {
      qrCallbacks.set(
        firebaseUid,
        onQrCode
      );
    }

    /*
     * Sauvegarde des credentials.
     */
    sock.ev.on(
      'creds.update',
      async () => {
        try {
          await saveCreds();

          console.log(
            `💾 Credentials Firestore sauvegardées: ${firebaseUid}`
          );
        } catch (error) {
          console.error(
            `❌ Erreur sauvegarde credentials ${firebaseUid}:`,
            error && (error.stack || error)
          );
        }
      }
    );

    let pairingRequested = false;

    sock.ev.on(
      'connection.update',
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr,
        } = update;

        if (
          qr &&
          connectionMethod === 'qr'
        ) {
          console.log(
            `📲 QR CODE généré pour ${firebaseUid}`
          );

          // generate dataURL to send directly to frontend
          try {
            const dataUrl = await qrcode.toDataURL(qr);
            notifier.emitFor(firebaseUid, { event: 'qr', data: { qr, dataUrl } });
          } catch (err) {
            console.error(`[baileysService] qrcode.toDataURL failed for ${firebaseUid}:`, err && (err.stack || err));
            notifier.emitFor(firebaseUid, { event: 'qr', data: { qr } });
          }

          const callback =
            qrCallbacks.get(firebaseUid);

          if (callback) {
            try {
              await callback(
                qr,
                null,
                null
              );

              console.log(
                `✅ QR transmis au dashboard: ${firebaseUid}`
              );
            } catch (error) {
              console.error(
                `❌ Erreur transmission QR ${firebaseUid}:`,
                error && (error.stack || error)
              );
            }
          }
        }

        if (
          connectionMethod === 'pairing' &&
          phoneNumber &&
          !state.creds.registered &&
          !pairingRequested &&
          (
            connection === 'connecting' ||
            !!qr
          )
        ) {
          pairingRequested = true;

          try {
            const cleanPhone =
              String(phoneNumber)
                .replace(/\D/g, '');

            if (
              !cleanPhone ||
              cleanPhone.length < 9
            ) {
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
              `🔐 Code de pairage généré pour ${firebaseUid}: ${code}`
            );

            notifier.emitFor(firebaseUid, { event: 'pairing', data: { code } });

            const callback =
              qrCallbacks.get(firebaseUid);

            if (callback) {
              await callback(
                null,
                code,
                null
              );
            }
          } catch (error) {
            console.error(
              `❌ Erreur code pairage ${firebaseUid}:`,
              error && (error.stack || error)
            );

            notifier.emitFor(firebaseUid, { event: 'error', data: { code: 'PAIRING_CODE_ERROR' } });

            const callback =
              qrCallbacks.get(firebaseUid);

            if (callback) {
              await callback(
                null,
                null,
                'PAIRING_CODE_ERROR'
              );
            }

            pairingRequested = false;
          }
        }

        if (
          connection === 'open'
        ) {
          console.log(
            `🟢 WhatsApp connecté: ${firebaseUid}`
          );

          notifier.emitFor(firebaseUid, { event: 'connected', data: { connected: true } });

          if (
            activeSockets.get(
              firebaseUid
            ) !== sock
          ) {
            console.warn(
              `⚠️ Ancienne socket ignorée: ${firebaseUid}`
            );

            return;
          }

          try {
            const connectedNumber =
              sock.user?.id
                ?.split(':')[0] ||
              sock.user?.id
                ?.split('@')[0];

            if (!connectedNumber) {
              throw new Error(
                'Numéro WhatsApp impossible à récupérer'
              );
            }

            const whatsappNumberHash =
              crypto
                .createHash('sha256')
                .update(
                  connectedNumber
                )
                .digest('hex');

            const existingByNumber =
              await userModel.findUserByWhatsappHash(
                whatsappNumberHash
              );

            if (
              existingByNumber &&
              existingByNumber.id !==
                firebaseUid
            ) {
              console.warn(
                `⚠️ Numéro WhatsApp déjà utilisé: ${firebaseUid}`
              );

              manuallyStopped.add(
                firebaseUid
              );

              try {
                await sock.logout();
              } catch (error) {
                console.error(
                  `Erreur logout numéro déjà utilisé ${firebaseUid}:`,
                  error && (error.stack || error)
                );
              }

              activeSockets.delete(
                firebaseUid
              );

              connectedSockets.delete(
                firebaseUid
              );

              await sessionModel.saveSessionStatus(
                firebaseUid,
                {
                  connected: false,
                }
              );

              const callback =
                qrCallbacks.get(
                  firebaseUid
                );

              if (callback) {
                await callback(
                  null,
                  null,
                  'NUMBER_ALREADY_USED'
                );
              }

              notifier.emitFor(firebaseUid, { event: 'error', data: { code: 'NUMBER_ALREADY_USED' } });

              return;
            }

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

            connectedSockets.add(
              firebaseUid
            );

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

            qrCallbacks.delete(
              firebaseUid
            );

            console.log(
              `✅ Session WhatsApp prête: ${firebaseUid}`
            );
          } catch (error) {
            console.error(
              `❌ Erreur après connexion ${firebaseUid}:`,
              error && (error.stack || error)
            );

            notifier.emitFor(firebaseUid, { event: 'error', data: { code: 'CONNECTION_ERROR', message: error?.message } });

            connectedSockets.delete(
              firebaseUid
            );

            await sessionModel.saveSessionStatus(
              firebaseUid,
              {
                connected: false,
              }
            );

            const callback =
              qrCallbacks.get(
                firebaseUid
              );

            if (callback) {
              await callback(
                null,
                null,
                'CONNECTION_ERROR'
              );
            }
          }
        }

        if (
          connection === 'close'
        ) {
          const statusCode =
            new Boom(
              lastDisconnect?.error
            )?.output?.statusCode;

          console.log(
            `🔴 Connexion WhatsApp fermée: ${firebaseUid} | code=${statusCode}`
          );

          notifier.emitFor(firebaseUid, { event: 'disconnected', data: { code: statusCode } });

          connectedSockets.delete(
            firebaseUid
          );

          if (
            activeSockets.get(
              firebaseUid
            ) === sock
          ) {
            activeSockets.delete(
              firebaseUid
            );
          }

          await sessionModel.saveSessionStatus(
            firebaseUid,
            {
              connected: false,
            }
          );

          if (
            manuallyStopped.has(
              firebaseUid
            )
          ) {
            console.log(
              `🛑 Arrêt manuel confirmé: ${firebaseUid}`
            );

            qrCallbacks.delete(
              firebaseUid
            );

            return;
          }

          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {
            console.log(
              `🚪 Session WhatsApp déconnectée définitivement: ${firebaseUid}`
            );

            businessPrompts.delete(
              firebaseUid
            );

            const callback =
              qrCallbacks.get(
                firebaseUid
              );

            if (callback) {
              await callback(
                null,
                null,
                'SESSION_EXPIRED'
              );
            }

            notifier.emitFor(firebaseUid, { event: 'error', data: { code: 'SESSION_EXPIRED' } });

            qrCallbacks.delete(
              firebaseUid
            );

            return;
          }

          try {
            const user =
              await userModel.getUserById(
                firebaseUid
              );

            if (!user) {
              return;
            }

            if (!user.botEnabled) {
              console.log(
                `🛑 Bot désactivé, aucune reconnexion: ${firebaseUid}`
              );

              return;
            }

            if (
              user.status === 'expired'
            ) {
              console.log(
                `⏭️ Abonnement expiré, aucune reconnexion: ${firebaseUid}`
              );

              return;
            }

            setTimeout(
              async () => {
                try {
                  if (
                    manuallyStopped.has(
                      firebaseUid
                    )
                  ) {
                    return;
                  }

                  if (
                    activeSockets.has(
                      firebaseUid
                    )
                  ) {
                    return;
                  }

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
                    `❌ Erreur reconnexion automatique ${firebaseUid}:`,
                    error && (error.stack || error)
                  );
                }
              },
              3000
            );
          } catch (error) {
            console.error(
              `❌ Erreur préparation reconnexion ${firebaseUid}:`,
              error && (error.stack || error)
            );
          }
        }
      }
    );

    sock.ev.on(
      'messages.upsert',
      async ({
        messages,
        type,
      }) => {
        if (
          type !== 'notify'
        ) {
          return;
        }

        const msg =
          messages?.[0];

        if (!msg) {
          return;
        }

        if (!msg.message) {
          return;
        }

        if (
          msg.key?.fromMe
        ) {
          return;
        }

        if (
          activeSockets.get(
            firebaseUid
          ) !== sock
        ) {
          return;
        }

        if (
          !connectedSockets.has(
            firebaseUid
          )
        ) {
          return;
        }

        const prompt =
          businessPrompts.get(
            firebaseUid
          ) ||
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
  } catch (error) {
    console.error(
      `❌ Erreur démarrage WhatsApp ${firebaseUid}:`,
      error && (error.stack || error)
    );

    activeSockets.delete(
      firebaseUid
    );

    connectedSockets.delete(
      firebaseUid
    );

    notifier.emitFor(firebaseUid, { event: 'error', data: { message: error?.message || String(error) } });

    throw error;
  } finally {
    startingSessions.delete(
      firebaseUid
    );
  }
}

// ... rest unchanged

async function handleIncomingMessage(
  firebaseUid,
  sock,
  msg,
  businessPrompt
) {
  try {
    const user =
      await userModel.getUserById(
        firebaseUid
      );

    if (!user) {
      return;
    }

    if (
      !user.botEnabled ||
      user.status === 'expired'
    ) {
      return;
    }

    const tokensInUsed =
      Number(
        user.tokensInUsed || 0
      );

    const tokensOutUsed =
      Number(
        user.tokensOutUsed || 0
      );

    const tokensInLimit =
      Number(
        user.tokensInLimit || 0
      );

    const tokensOutLimit =
      Number(
        user.tokensOutLimit || 0
      );

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

    const lastProcessed =
      await sessionModel.getLastProcessedTimestamp(
        firebaseUid
      );

    const msgTimestamp =
      Number(
        msg.messageTimestamp || 0
      ) * 1000;

    if (
      lastProcessed &&
      msgTimestamp <
        new Date(
          lastProcessed
        ).getTime()
    ) {
      return;
    }

    const userMessage =
      msg.message
        .conversation ||
      msg.message
        .extendedTextMessage
        ?.text ||
      '';

    if (
      !userMessage.trim()
    ) {
      return;
    }

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
        error && (error.stack || error)
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

    if (
      usage.limitReached
    ) {
      await sock.sendMessage(
        msg.key.remoteJid,
        {
          text:
            'Service temporairement indisponible. Merci de renouveler votre abonnement pour continuer.',
        }
      );

      return;
    }

    await sock.sendMessage(
      msg.key.remoteJid,
      {
        text,
      }
    );
  } catch (error) {
    console.error(
      `❌ Erreur traitement message ${firebaseUid}:`,
      error && (error.stack || error)
    );
  }
}

// rest unchanged (stopWhatsappSession, getters, reconnectAllActiveSessions)

async function stopWhatsappSession(
  firebaseUid
) {
  console.log(
    `🛑 Arrêt demandé pour ${firebaseUid}`
  );

  manuallyStopped.add(
    firebaseUid
  );

  const sock =
    activeSockets.get(
      firebaseUid
    );

  connectedSockets.delete(
    firebaseUid
  );

  if (sock) {
    try {
      await sock.end(
        new Error(
          'Session arrêtée manuellement'
        )
      );
    } catch (error) {
      console.error(
        `Erreur fermeture socket ${firebaseUid}:`,
        error && (error.stack || error)
      );
    }

    if (
      activeSockets.get(
        firebaseUid
      ) === sock
    ) {
      activeSockets.delete(
        firebaseUid
      );
    }
  }

  await sessionModel.saveSessionStatus(
    firebaseUid,
    {
      connected: false,
    }
  );

  console.log(
    `✅ Session WhatsApp arrêtée: ${firebaseUid}`
  );
}

function getActiveSocket(
  firebaseUid
) {
  return (
    activeSockets.get(
      firebaseUid
    ) || null
  );
}

function isWhatsappConnected(
  firebaseUid
) {
  return connectedSockets.has(
    firebaseUid
  );
}

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
      error && (error.stack || error)
    );

    return;
  }

  console.log(
    `📊 ${uids.length} session(s) trouvée(s)`
  );

  for (
    const firebaseUid of uids
  ) {
    try {
      const user =
        await userModel.getUserById(
          firebaseUid
        );

      if (!user) {
        continue;
      }

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
        error && (error.stack || error)
      );
    }
  }
}

module.exports = {
  startWhatsappSession,
  stopWhatsappSession,
  getActiveSocket,
  isWhatsappConnected,
  reconnectAllActiveSessions,
};
