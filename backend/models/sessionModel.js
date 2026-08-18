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

module.exports = {
  saveSessionStatus,
  getSessionStatus,
  setLastProcessedTimestamp,
  getLastProcessedTimestamp,
};
