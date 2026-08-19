const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');
const { db } = require('../config/firebase');

// Remplace useMultiFileAuthState (disque local, effacé à chaque redémarrage Render)
// par un stockage Firestore qui survit aux redéploiements et aux mises en veille.
async function useFirestoreAuthState(firebaseUid) {
  const keysCollRef = db
    .collection('whatsapp_sessions')
    .doc(firebaseUid)
    .collection('keys');

  async function readData(key) {
    try {
      const doc = await keysCollRef.doc(key).get();
      if (!doc.exists) return null;
      const raw = doc.data().value;
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return null;
    }
  }

  async function writeData(key, data) {
    const raw = JSON.stringify(data, BufferJSON.replacer);
    await keysCollRef.doc(key).set({ value: raw });
  }

  async function removeData(key) {
    await keysCollRef.doc(key).delete().catch(() => {});
  }

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
    // Utile pour la déconnexion définitive (logout) : purge toute la session
    clearSession: async () => {
      const snapshot = await keysCollRef.get();
      await Promise.all(snapshot.docs.map((d) => d.ref.delete()));
    },
  };
}

module.exports = { useFirestoreAuthState };
