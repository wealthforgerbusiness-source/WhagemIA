const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const { Boom } = require('@hapi/boom');
const crypto = require('crypto');
const pino = require('pino');
const QRCode = require('qrcode');

const { useFirestoreAuthState } = require('./firestoreAuthState');
const geminiService = require('./geminiService');
const userModel = require('../models/userModel');
const sessionModel = require('../models/sessionModel');

const activeSockets = new Map();
const qrCallbacks = new Map();
const businessPrompts = new Map();

const manuallyStopped = new Set();
const startingSessions = new Set();

/*
|--------------------------------------------------------------------------
| DÉMARRAGE SESSION WHATSAPP
|--------------------------------------------------------------------------
*/
async function startWhatsappSession(
  firebaseUid,
  userEmail,
  businessPrompt,
  onQrCode = null,
  connectionMethod = 'qr',
  phoneNumber = null
) {
  /*
   * Évite plusieurs connexions simultanées
   * pour le même utilisateur.
   */
  if (startingSessions.has(firebaseUid)) {
    console.log(
      `⏳ Session déjà en démarrage: ${firebaseUid}`
    );

    return activeSockets.get(firebaseUid) || null;
  }

  /*
   * Si une socket existe déjà, on la réutilise.
   */
  const existingSocket =
    activeSockets.get(firebaseUid);

  if (existingSocket) {
    console.log(
      `✅ Socket déjà actif: ${firebaseUid}`
    );

    return existingSocket;
  }

  startingSessions.add(firebaseUid);

  /*
   * Une nouvelle connexion annule un arrêt manuel précédent.
   */
  manuallyStopped.delete(firebaseUid);

  try {
    console.log(
      `🚀 Démarrage WhatsApp ${firebaseUid} | méthode=${connectionMethod}`
    );

    /*
     * Auth Firestore.
     *
     * Les credentials WhatsApp ne sont PAS stockés
     * sur le disque Render.
     */
    const {
      state,
      saveCreds,
    } = await useFirestoreAuthState(
      firebaseUid
    );

    const { version } =
      await fetchLatestBaileysVersion();

    businessPrompts.set(
      firebaseUid,
      businessPrompt || ''
    );

    /*
     * Création socket Baileys.
     */
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

    /*
     * Sauvegarde callback QR / pairing.
     */
    if (onQrCode) {
      qrCallbacks.set(
        firebaseUid,
        onQrCode
      );
    }

    /*
     * Sauvegarde permanente des credentials
     * dans Firestore.
     */
    sock.ev.on(
      'creds.update',
      async () => {
        try {
          await saveCreds();

          console.log(
            `💾 Credentials WhatsApp sauvegardées: ${firebaseUid}`
          );
        } catch (error) {
          console.error(
            `❌ Erreur sauvegarde Firestore ${firebaseUid}:`,
            error.message
          );
        }
      }
    );

    let pairingRequested = false;

    /*
    |--------------------------------------------------------------------------
    | CONNECTION UPDATE
    |--------------------------------------------------------------------------
    */
    sock.ev.on(
      'connection.update',
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr,
        } = update;

        /*
        |--------------------------------------------------------------------------
        | QR CODE
        |--------------------------------------------------------------------------
        */
        if (
          qr &&
          connectionMethod === 'qr'
        ) {
          console.log(
            `📲 QR CODE généré pour ${firebaseUid}`
          );

          try {
            /*
             * Conversion du QR Baileys en image
             * directement affichable dans <img src="">
             */
            const qrDataUrl =
              await QRCode.toDataURL(qr, {
                errorCorrectionLevel: 'M',
                margin: 2,
                width: 360,
              });

            const callback =
              qrCallbacks.get(
                firebaseUid
              );

            if (callback) {
              await callback(
                qrDataUrl,
                null,
                null
              );
            }

            console.log(
              `✅ QR envoyé au dashboard: ${firebaseUid}`
            );
          } catch (error) {
            console.error(
              `❌ Erreur génération image QR ${firebaseUid}:`,
              error.message
            );

            const callback =
              qrCallbacks.get(
                firebaseUid
              );

            if (callback) {
              await callback(
                null,
                null,
                'QR_GENERATION_ERROR'
              );
            }
          }
        }

        /*
        |--------------------------------------------------------------------------
        | CODE DE PAIRAGE
        |--------------------------------------------------------------------------
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
              qrCallbacks.get(
                firebaseUid
              );

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
              qrCallbacks.get(
                firebaseUid
              );

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
        |--------------------------------------------------------------------------
        | CONNEXION OUVERTE
        |--------------------------------------------------------------------------
        */
        if (
          connection === 'open'
        ) {
          console.log(
            `🟢 WhatsApp connecté: ${firebaseUid}`
          );

          /*
           * Vérifie que cette socket est toujours
           * la socket active.
           */
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
            /*
             * Récupérer numéro WhatsApp.
             */
            const connectedNumber =
              sock.user?.id
                ?.split(':')[0] ||
              sock.user?.id
                ?.split('@')[0];

            if (
              !connectedNumber
            ) {
              console.warn(
                `⚠️ Numéro WhatsApp impossible à récupérer: ${firebaseUid}`
              );
            } else {
              const whatsappNumberHash =
                crypto
                  .createHash('sha256')
                  .update(
                    connectedNumber
                  )
                  .digest('hex');

              /*
               * Anti-abus.
               */
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

                if (
                  activeSockets.get(
                    firebaseUid
                  ) === sock
                ) {
                  activeSockets.delete(
                    firebaseUid
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
                    'NUMBER_ALREADY_USED'
                  );
                }

                return;
              }

              /*
               * Créer ou mettre à jour utilisateur.
               */
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

            /*
             * Statut Firestore.
             */
            await sessionModel.saveSessionStatus(
              firebaseUid,
              {
                connected: true,
                lastActiveAt:
                  new Date().toISOString(),
              }
            );

            /*
             * Ignorer les anciens messages.
             */
            await sessionModel.setLastProcessedTimestamp(
              firebaseUid,
              new Date().toISOString()
            );

            /*
             * La connexion est terminée.
             */
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
        |--------------------------------------------------------------------------
        | CONNEXION FERMÉE
        |--------------------------------------------------------------------------
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

          /*
           * Retirer uniquement cette socket.
           */
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
          |--------------------------------------------------------------------------
          | ARRÊT MANUEL
          |--------------------------------------------------------------------------
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
          |--------------------------------------------------------------------------
          | SESSION WHATSAPP EXPIRÉE / LOGGED OUT
          |--------------------------------------------------------------------------
          */
          if (
            statusCode ===
            DisconnectReason.loggedOut
          ) {
            console.log(
              `🚪 Session WhatsApp expirée/déconnectée définitivement: ${firebaseUid}`
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

            qrCallbacks.delete(
              firebaseUid
            );

            return;
          }

          /*
          |--------------------------------------------------------------------------
          | AUTRE DÉCONNEXION
          |--------------------------------------------------------------------------
          */
          console.log(
            `🔄 Tentative de reconnexion automatique: ${firebaseUid}`
          );

          try {
            const user =
              await userModel.getUserById(
                firebaseUid
              );

            if (!user) {
              console.warn(
                `⚠️ Utilisateur introuvable: ${firebaseUid}`
              );

              return;
            }

            /*
             * Ne pas reconnecter un bot désactivé.
             */
            if (
              !user.botEnabled
            ) {
              console.log(
                `🛑 Bot désactivé, aucune reconnexion: ${firebaseUid}`
              );

              return;
            }

            /*
             * Ne pas reconnecter un abonnement expiré.
             */
            if (
              user.status ===
              'expired'
            ) {
              console.log(
                `⏭️ Abonnement expiré, aucune reconnexion: ${firebaseUid}`
              );

              return;
            }

            /*
             * Petit délai pour éviter une boucle
             * de reconnexion trop agressive.
             */
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
    |--------------------------------------------------------------------------
    | MESSAGES WHATSAPP
    |--------------------------------------------------------------------------
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

        /*
         * Vérifie que cette socket est toujours
         * la socket active.
         */
        if (
          activeSockets.get(
            firebaseUid
          ) !== sock
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

    throw error;
  } finally {
    startingSessions.delete(
      firebaseUid
    );
  }
}

/*
|--------------------------------------------------------------------------
| TRAITEMENT DES MESSAGES
|--------------------------------------------------------------------------
*/
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

    /*
     * Bot désactivé ou abonnement expiré.
     */
    if (
      !user.botEnabled ||
      user.status === 'expired'
    ) {
      return;
    }

    /*
     * Vérification quota AVANT Gemini.
     */
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
      tokensInUsed >=
        tokensInLimit ||
      tokensOutUsed >=
        tokensOutLimit
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

    /*
     * Éviter de traiter les anciens messages.
     */
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

    /*
     * Texte utilisateur.
     */
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

    /*
     * Gemini.
     */
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

    /*
     * Comptabilisation tokens.
     */
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

    /*
     * Réponse WhatsApp.
     */
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

/*
|--------------------------------------------------------------------------
| ARRÊTER SESSION
|--------------------------------------------------------------------------
*/
async function stopWhatsappSession(
  firebaseUid
) {
  console.log(
    `🛑 Arrêt demandé pour ${firebaseUid}`
  );

  /*
   * Empêche le reconnect automatique.
   */
  manuallyStopped.add(
    firebaseUid
  );

  const sock =
    activeSockets.get(
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
        error.message
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

/*
|--------------------------------------------------------------------------
| SOCKET ACTIF
|--------------------------------------------------------------------------
*/
function getActiveSocket(
  firebaseUid
) {
  return (
    activeSockets.get(
      firebaseUid
    ) || null
  );
}

/*
|--------------------------------------------------------------------------
| RECONNEXION AU DÉMARRAGE DU SERVEUR
|--------------------------------------------------------------------------
*/
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

      if (
        !user.botEnabled
      ) {
        console.log(
          `⏭️ Bot désactivé: ${firebaseUid}`
        );

        continue;
      }

      if (
        user.status ===
        'expired'
      ) {
        console.log(
          `⏭️ Abonnement expiré: ${firebaseUid}`
        );

        continue;
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
