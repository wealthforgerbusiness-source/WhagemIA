const admin = require('firebase-admin');
const {
  initAuthCreds,
  BufferJSON,
} = require('@whiskeysockets/baileys');

if (!admin.apps.length) {
  throw new Error(
    'Firebase Admin doit être initialisé avant firestoreAuthState.js'
  );
}

const db = admin.firestore();

/*
|--------------------------------------------------------------------------
| Firestore Auth State pour Baileys
|--------------------------------------------------------------------------
|
| Structure Firestore :
|
| baileys_sessions/{firebaseUid}
|
| {
|   creds: {...},
|   keys: {...},
|   updatedAt: ...
| }
|
|--------------------------------------------------------------------------
*/

async function useFirestoreAuthState(firebaseUid) {
  if (!firebaseUid) {
    throw new Error(
      'firebaseUid est obligatoire pour utiliser Firestore Auth State'
    );
  }

  const docRef = db
    .collection('baileys_sessions')
    .doc(firebaseUid);

  const snapshot = await docRef.get();

  let creds;
  let keys;

  /*
  |--------------------------------------------------------------------------
  | CHARGEMENT SESSION EXISTANTE
  |--------------------------------------------------------------------------
  */

  if (snapshot.exists) {
    const data = snapshot.data();

    try {
      if (data.payload) {
        const parsed = JSON.parse(
          data.payload,
          BufferJSON.reviver
        );

        creds = parsed.creds;
        keys = parsed.keys || {};
      } else {
        creds = data.creds
          ? JSON.parse(
              JSON.stringify(data.creds),
              BufferJSON.reviver
            )
          : null;

        keys = data.keys
          ? JSON.parse(
              JSON.stringify(data.keys),
              BufferJSON.reviver
            )
          : {};
      }

      if (!creds) {
        console.log(
          `⚠️ Credentials Firestore absents pour ${firebaseUid}, nouvelle session`
        );

        creds = initAuthCreds();
        keys = {};
      } else {
        console.log(
          `💾 Session Baileys Firestore chargée pour ${firebaseUid}`
        );
      }
    } catch (error) {
      console.error(
        `❌ Session Firestore corrompue pour ${firebaseUid}:`,
        error.message
      );

      /*
       * On repart avec une nouvelle session.
       * Le prochain démarrage générera un QR.
       */
      creds = initAuthCreds();
      keys = {};
    }
  } else {
    console.log(
      `🆕 Aucune session Firestore pour ${firebaseUid}, création`
    );

    creds = initAuthCreds();
    keys = {};
  }

  /*
  |--------------------------------------------------------------------------
  | STATE BAILEYS
  |--------------------------------------------------------------------------
  */

  const state = {
    creds,

    keys: {
      /*
      |--------------------------------------------------------------------------
      | GET KEYS
      |--------------------------------------------------------------------------
      */

      get: async (type, ids) => {
        const result = {};

        if (!keys[type]) {
          return result;
        }

        for (const id of ids) {
          if (
            keys[type][id] !== undefined &&
            keys[type][id] !== null
          ) {
            result[id] = keys[type][id];
          }
        }

        return result;
      },

      /*
      |--------------------------------------------------------------------------
      | SET KEYS
      |--------------------------------------------------------------------------
      */

      set: async (data) => {
        for (const type of Object.keys(data)) {
          if (!keys[type]) {
            keys[type] = {};
          }

          for (const id of Object.keys(data[type])) {
            const value = data[type][id];

            /*
             * Baileys peut supprimer certaines clés
             * en envoyant null.
             */
            if (value === null) {
              delete keys[type][id];
            } else {
              keys[type][id] = value;
            }
          }
        }

        /*
         * Sauvegarde immédiatement les clés.
         *
         * Important pour éviter de perdre les mises à jour
         * de session entre deux redémarrages Render.
         */
        await saveToFirestore();
      },
    },
  };

  /*
  |--------------------------------------------------------------------------
  | SAUVEGARDE FIRESTORE
  |--------------------------------------------------------------------------
  */

  let saveInProgress = false;
  let saveQueued = false;

  async function saveToFirestore() {
    /*
     * Évite plusieurs écritures Firestore simultanées.
     */
    if (saveInProgress) {
      saveQueued = true;
      return;
    }

    saveInProgress = true;

    try {
      const payload = JSON.stringify(
        {
          creds: state.creds,
          keys,
        },
        BufferJSON.replacer
      );

      await docRef.set(
        {
          payload,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          firebaseUid,
        },
        {
          merge: true,
        }
      );

      console.log(
        `💾 Session Baileys sauvegardée dans Firestore: ${firebaseUid}`
      );
    } catch (error) {
      console.error(
        `❌ Erreur sauvegarde session Firestore ${firebaseUid}:`,
        error.message
      );

      throw error;
    } finally {
      saveInProgress = false;

      if (saveQueued) {
        saveQueued = false;

        /*
         * Sauvegarde la dernière version.
         */
        await saveToFirestore();
      }
    }
  }

  /*
  |--------------------------------------------------------------------------
  | SAVE CREDS
  |--------------------------------------------------------------------------
  */

  const saveCreds = async () => {
    await saveToFirestore();
  };

  /*
  |--------------------------------------------------------------------------
  | RETOUR BAILEYS
  |--------------------------------------------------------------------------
  */

  return {
    state,
    saveCreds,
  };
}

module.exports = {
  useFirestoreAuthState,
};
