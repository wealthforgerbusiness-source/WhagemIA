const {
  initAuthCreds,
  BufferJSON,
  proto,
} = require('@whiskeysockets/baileys');

const { db } = require('../config/firebase');

const SESSIONS_COLLECTION = 'whatsappAuth';

function keyDocumentId(type, id) {
  return Buffer.from(`${type}:${id}`).toString('base64url');
}

async function useFirestoreAuthState(firebaseUid) {
  const sessionRef = db
    .collection(SESSIONS_COLLECTION)
    .doc(firebaseUid);

  const keysCollection = sessionRef.collection('keys');

  const credsRef = sessionRef.collection('data').doc('creds');

  const credsSnapshot = await credsRef.get();

  let creds;

  if (credsSnapshot.exists && credsSnapshot.data()?.payload) {
    try {
      creds = JSON.parse(
        credsSnapshot.data().payload,
        BufferJSON.reviver
      );

      console.log(
        `✅ Credentials Firestore chargées pour ${firebaseUid}`
      );
    } catch (error) {
      console.error(
        `❌ Credentials Firestore invalides pour ${firebaseUid}:`,
        error.message
      );

      creds = initAuthCreds();
    }
  } else {
    creds = initAuthCreds();

    console.log(
      `🆕 Aucune session Firestore pour ${firebaseUid}, création`
    );
  }

  const state = {
    creds,

    keys: {
      get: async (type, ids) => {
        const result = {};

        await Promise.all(
          ids.map(async (id) => {
            const ref = keysCollection.doc(
              keyDocumentId(type, id)
            );

            const snapshot = await ref.get();

            if (!snapshot.exists) {
              return;
            }

            const data = snapshot.data();

            if (!data?.payload) {
              return;
            }

            try {
              let value = JSON.parse(
                data.payload,
                BufferJSON.reviver
              );

              /*
               * Baileys attend un objet proto pour
               * app-state-sync-key.
               */
              if (
                type === 'app-state-sync-key' &&
                value
              ) {
                value =
                  proto.Message.AppStateSyncKeyData.fromObject(
                    value
                  );
              }

              result[id] = value;
            } catch (error) {
              console.error(
                `❌ Erreur lecture clé ${type}/${id} pour ${firebaseUid}:`,
                error.message
              );
            }
          })
        );

        return result;
      },

      set: async (data) => {
        const operations = [];

        for (const type of Object.keys(data)) {
          const category = data[type];

          if (!category) {
            continue;
          }

          for (const id of Object.keys(category)) {
            const value = category[id];

            const ref = keysCollection.doc(
              keyDocumentId(type, id)
            );

            /*
             * Baileys supprime certaines clés en envoyant null.
             */
            if (value === null || value === undefined) {
              operations.push(
                ref.delete().catch(() => {})
              );

              continue;
            }

            const payload = JSON.stringify(
              value,
              BufferJSON.replacer
            );

            operations.push(
              ref.set(
                {
                  type,
                  keyId: id,
                  payload,
                  updatedAt: new Date().toISOString(),
                },
                { merge: true }
              )
            );
          }
        }

        await Promise.all(operations);
      },
    },
  };

  const saveCreds = async () => {
    const payload = JSON.stringify(
      state.creds,
      BufferJSON.replacer
    );

    await credsRef.set(
      {
        payload,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  };

  return {
    state,
    saveCreds,
  };
}

module.exports = {
  useFirestoreAuthState,
};
