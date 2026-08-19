const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const crypto = require('crypto');
const pino = require('pino');

const {
  useFirestoreAuthState,
  clearFirestoreAuthState,
} = require('./firestoreAuthState');

const geminiService = require('./geminiService');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');

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

    const { version } =
      await fetchLatestBaileysVersion();

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
            error.message
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

        /*
         * =====================================================
         * QR CODE
         * =====================================================
         *
         * IMPORTANT :
         * On transmet le QR BRUT.
         *
         * La route API ne doit PAS refaire QRCode.toDataURL()
         * dessus.
         */
        if (
          qr &&
          connectionMethod === 'qr'
        ) {
          console.log(
            `📲 QR CODE généré pour ${firebaseUid}`
          );

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
                error.message
              );
            }
          }
        }

        /*
         * =====================================================
         * CODE DE PAIRAGE
         * =====================================================
         */
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
              error.message
            );

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

        /*
         * =====================================================
         * CONNEXION OUVERTE
         * =====================================================
         */
        if (
          connection === 'open'
        ) {
          console.log(
            `🟢 WhatsApp connecté: ${firebaseUid}`
          );

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
                  error.message
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

            /*
             * C'EST ICI SEULEMENT qu'on passe
             * connected à true.
             */
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
              error.message
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
                'CONNECTION_ERROR'
              );
            }
          }
        }

        /*
         * =====================================================
         * CONNEXION FERMÉE
         * =====================================================
         */
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

          /*
           * ARRÊT MANUEL
           */
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

          /*
           * SESSION LOGGED OUT
           */
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

            /*
             * Le device a été délié côté WhatsApp (logout, y compris
             * depuis le téléphone). On nettoie les credentials Firestore
             * pour être sûr qu'un futur démarrage régénère bien un QR.
             */
            try {
              await clearFirestoreAuthState(
                firebaseUid
              );

              console.log(
                `🗑️ Credentials Firestore supprimées (loggedOut): ${firebaseUid}`
              );
            } catch (error) {
              console.error(
                `Erreur suppression credentials Firestore ${firebaseUid}:`,
                error.message
              );
            }

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

            qrCallbacks.delete(
              firebaseUid
            );

            return;
          }

          /*
           * RECONNEXION AUTOMATIQUE
           */
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
                    user.businessPrompt ||
                      '',
                    null,
                    'qr',
                    null
                  );
                } catch (error) {
                  console.error(
                    `❌ Erreur reconnexion automatique ${firebaseUid}:`,
                    error.message
                  );
                }
              },
              3000
            );
          } catch (error) {
            console.error(
              `❌ Erreur préparation reconnexion ${firebaseUid}:`,
              error.message
            );
          }
        }
      }
    );

    /*
     * =====================================================
     * MESSAGES
     * =====================================================
     */
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
      error
    );

    activeSockets.delete(
      firebaseUid
    );

    connectedSockets.delete(
      firebaseUid
    );

    throw error;
  } finally {
    startingSessions.delete(
      firebaseUid
    );
  }
}

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
      error.message
    );
  }
}

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
      /*
       * VRAI LOGOUT :
       * délie l'appareil côté WhatsApp (contrairement à sock.end()
       * qui ferme juste la connexion locale sans rien dire à WhatsApp).
       */
      await sock.logout();

      console.log(
        `🔓 Logout WhatsApp effectué: ${firebaseUid}`
      );
    } catch (error) {
      console.error(
        `Erreur logout WhatsApp ${firebaseUid}:`,
        error.message
      );

      /*
       * Si le logout échoue (ex: déjà déconnecté côté WhatsApp,
       * ou socket dans un état bancal), on force quand même
       * la fermeture locale pour ne pas laisser un socket zombie.
       */
      try {
        await sock.end(
          new Error(
            'Session arrêtée manuellement'
          )
        );
      } catch (endError) {
        console.error(
          `Erreur fermeture socket ${firebaseUid}:`,
          endError.message
        );
      }
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

  /*
   * SUPPRESSION DES CREDENTIALS FIRESTORE :
   * sans ça, même après un logout, si jamais la suppression n'a pas
   * lieu la prochaine session peut retrouver des clés Signal orphelines.
   * On force la suppression explicite ici, côté serveur (droits admin).
   */
  try {
    await clearFirestoreAuthState(
      firebaseUid
    );

    console.log(
      `🗑️ Credentials Firestore supprimées: ${firebaseUid}`
    );
  } catch (error) {
    console.error(
      `Erreur suppression credentials Firestore ${firebaseUid}:`,
      error.message
    );
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

function updateBusinessPrompt(
  firebaseUid,
  businessPrompt
) {
  businessPrompts.set(
    firebaseUid,
    businessPrompt || ''
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
      error.message
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
        error.message
      );
    }
  }
}

module.exports = {
  startWhatsappSession,
  stopWhatsappSession,
  getActiveSocket,
  isWhatsappConnected,
  updateBusinessPrompt,
  reconnectAllActiveSessions,
};
