require('dotenv').config();

const express = require('express');
const cors = require('cors');

// Initialise Firebase Admin AVANT les services qui utilisent Firestore
require('./config/firebase');

const userRoutes = require('./routes/userRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');
const adminRoutes = require('./routes/adminRoutes');

const baileysService = require('./services/baileysService');
const { startSubscriptionCron } = require('./jobs/subscriptionCron');

const app = express();

app.use(cors());

app.get('/', (req, res) => {
  res.json({
    status: 'WhagemIA backend en ligne',
    version: '1.0.0',
  });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
  });
});

app.use('/webhooks', webhookRoutes);

app.use(express.json());

app.use('/api/user', userRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/admin', adminRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(
    `🚀 WhagemIA backend démarré sur le port ${PORT}`
  );

  /*
   * Reconnexion automatique des sessions WhatsApp
   * enregistrées dans Firestore.
   */
  try {
    console.log(
      '🔄 Vérification des sessions WhatsApp à reconnecter...'
    );

    await baileysService.reconnectAllActiveSessions();

    console.log(
      '✅ Vérification des sessions WhatsApp terminée.'
    );
  } catch (err) {
    console.error(
      '❌ Erreur reconnexion auto au démarrage:',
      err.message
    );
  }

  /*
   * Vérification automatique des abonnements.
   */
  startSubscriptionCron();

  console.log(
    '✅ Cron des abonnements démarré.'
  );
});
