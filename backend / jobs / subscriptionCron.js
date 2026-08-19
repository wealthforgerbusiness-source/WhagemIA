const cron = require('node-cron');
const { db } = require('../config/firebase');
const userModel = require('../models/userModel');
const baileysService = require('../services/baileysService');

// Sans cette tâche, un abonnement n'est réévalué QUE quand Chariow renvoie
// un nouveau webhook "successful.sale". Si un renouvellement échoue côté
// Chariow (carte refusée, abonnement annulé...) et qu'aucun nouveau webhook
// n'arrive, l'utilisateur garde un accès illimité en pratique tant que son
// quota de tokens n'est pas atteint. Cette tâche ferme ce trou : chaque jour,
// elle coupe le bot des comptes payants dont la date de renouvellement est
// dépassée sans qu'un nouveau paiement n'ait été enregistré.
async function checkExpiredSubscriptions() {
  const now = new Date().toISOString();

  const snapshot = await db
    .collection('users')
    .where('status', '==', 'active')
    .where('subscriptionRenewsAt', '<=', now)
    .get();

  if (snapshot.empty) {
    console.log('[subscriptionCron] Aucun abonnement expiré aujourd\'hui.');
    return;
  }

  console.log(`[subscriptionCron] ${snapshot.size} abonnement(s) expiré(s) à traiter.`);

  for (const doc of snapshot.docs) {
    const firebaseUid = doc.id;
    const user = doc.data();

    // Les essais gratuits (plan 'trial') sont gérés par leur propre limite de
    // tokens, pas par subscriptionRenewsAt (qui reste null pour eux) — donc
    // ils ne sont de toute façon jamais sélectionnés par la requête ci-dessus.
    try {
      await userModel.updateUser(firebaseUid, {
        status: 'expired',
        botEnabled: false,
      });

      const sock = baileysService.getActiveSocket(firebaseUid);
      if (sock) {
        // On coupe la génération de réponses immédiatement, sans attendre
        // qu'un message arrive et déclenche le check dans handleIncomingMessage.
        console.log(`[subscriptionCron] Bot désactivé pour ${user.email} (${firebaseUid}) — abonnement non renouvelé.`);
      }
    } catch (error) {
      console.error(`[subscriptionCron] Erreur pour ${firebaseUid}:`, error.message);
    }
  }
}

function startSubscriptionCron() {
  // Tous les jours à 3h du matin (heure du serveur Render, généralement UTC)
  cron.schedule('0 3 * * *', () => {
    console.log('[subscriptionCron] Vérification des abonnements...');
    checkExpiredSubscriptions().catch((err) =>
      console.error('[subscriptionCron] Échec de la vérification:', err.message)
    );
  });

  console.log('[subscriptionCron] Tâche planifiée (tous les jours à 3h).');
}

module.exports = { startSubscriptionCron, checkExpiredSubscriptions };
