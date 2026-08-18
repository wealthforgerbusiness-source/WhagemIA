const { db } = require('../config/firebase');

const USERS_COLLECTION = 'users';

// Créer un nouvel utilisateur (essai gratuit) après connexion WhatsApp réussie
async function createUser({ firebaseUid, email, whatsappNumberHash }) {
  const userRef = db.collection(USERS_COLLECTION).doc(firebaseUid);

  const existing = await userRef.get();
  if (existing.exists) {
    return { id: userRef.id, ...existing.data() };
  }

  const newUser = {
    email,
    whatsappNumberHash,
    plan: 'trial',
    status: 'active',
    tokensInLimit: 20000,
    tokensOutLimit: 20000,
    tokensInUsed: 0,
    tokensOutUsed: 0,
    botEnabled: true,
    trialUsed: true,
    subscriptionRenewsAt: null,
    createdAt: new Date().toISOString(),
    lastReactivatedAt: new Date().toISOString(),
  };

  await userRef.set(newUser);
  return { id: userRef.id, ...newUser };
}

// Vérifier si un numéro WhatsApp a déjà utilisé l'essai gratuit (anti-abus)
async function findUserByWhatsappHash(whatsappNumberHash) {
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .where('whatsappNumberHash', '==', whatsappNumberHash)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

// Trouver un utilisateur par email (utile pour le webhook Chariow)
async function findUserByEmail(email) {
  const snapshot = await db
    .collection(USERS_COLLECTION)
    .where('email', '==', email)
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function getUserById(firebaseUid) {
  const doc = await db.collection(USERS_COLLECTION).doc(firebaseUid).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function updateUser(firebaseUid, updates) {
  await db.collection(USERS_COLLECTION).doc(firebaseUid).update(updates);
}

// Incrémenter la conso de tokens et vérifier si la limite est atteinte
async function incrementTokenUsage(firebaseUid, tokensIn, tokensOut) {
  const userRef = db.collection(USERS_COLLECTION).doc(firebaseUid);
  const doc = await userRef.get();
  if (!doc.exists) return null;

  const data = doc.data();
  const newTokensInUsed = data.tokensInUsed + tokensIn;
  const newTokensOutUsed = data.tokensOutUsed + tokensOut;

  const limitReached =
    newTokensInUsed >= data.tokensInLimit ||
    newTokensOutUsed >= data.tokensOutLimit;

  const updates = {
    tokensInUsed: newTokensInUsed,
    tokensOutUsed: newTokensOutUsed,
  };

  if (limitReached) {
    updates.status = 'expired';
    updates.botEnabled = false;
  }

  await userRef.update(updates);

  return { ...data, ...updates, limitReached };
}

module.exports = {
  createUser,
  findUserByWhatsappHash,
  findUserByEmail,
  getUserById,
  updateUser,
  incrementTokenUsage,
};
