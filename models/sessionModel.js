const { db } = require('../config/firebase');

const SESSIONS_COLLECTION = 'sessions';

async function saveSessionStatus(firebaseUid, { connected, lastActiveAt }) {
  await db.collection(SESSIONS_COLLECTION).doc(firebaseUid).set(
    {
      connected,
      lastActiveAt: lastActiveAt || new Date().toISOString(),
    },
    { merge: true }
  );
}

async function getSessionStatus(firebaseUid) {
  const doc = await db.collection(SESSIONS_COLLECTION).doc(firebaseUid).get();
  if (!doc.exists) return null;
  return doc.data();
}

// Marque le timestamp à partir duquel le bot doit traiter les messages
// (utilisé pour ignorer les anciens messages non répondus à la réactivation)
async function setLastProcessedTimestamp(firebaseUid, timestamp) {
  await db.collection(SESSIONS_COLLECTION).doc(firebaseUid).set(
    { lastProcessedTimestamp: timestamp },
    { merge: true }
  );
}

async function getLastProcessedTimestamp(firebaseUid) {
  const doc = await db.collection(SESSIONS_COLLECTION).doc(firebaseUid).get();
  if (!doc.exists) return null;
  return doc.data().lastProcessedTimestamp || null;
}

// Liste les UID de tous les utilisateurs dont la session était marquée
// "connected: true" avant le dernier redémarrage — sert à tout reconnecter
// automatiquement au démarrage du serveur.
async function getAllConnectedUids() {
  const snapshot = await db
    .collection(SESSIONS_COLLECTION)
    .where('connected', '==', true)
    .get();

  return snapshot.docs.map((doc) => doc.id);
}

module.exports = {
  saveSessionStatus,
  getSessionStatus,
  setLastProcessedTimestamp,
  getLastProcessedTimestamp,
  getAllConnectedUids,
};
