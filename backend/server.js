require('dotenv').config();

const express = require('express');
const cors = require('cors');

const userRoutes =
  require('./routes/userRoutes');

const webhookRoutes =
  require('./routes/webhookRoutes');

const whatsappRoutes =
  require('./routes/whatsappRoutes');

const adminRoutes =
  require('./routes/adminRoutes');

const baileysService =
  require('./services/baileysService');

const {
  startSubscriptionCron,
} = require('./jobs/subscriptionCron');

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.get(
  '/',
  (req, res) => {
    res.json({
      status:
        'WhagemIA backend en ligne',
      version: '1.0.0',
    });
  }
);

app.get(
  '/health',
  (req, res) => {
    res.json({
      ok: true,
      timestamp:
        new Date().toISOString(),
    });
  }
);

app.use(
  '/webhooks',
  webhookRoutes
);

app.use(
  express.json({
    limit: '2mb',
  })
);

app.use(
  '/api/user',
  userRoutes
);

app.use(
  '/api/whatsapp',
  whatsappRoutes
);

app.use(
  '/api/admin',
  adminRoutes
);

const PORT =
  process.env.PORT || 3000;

app.listen(
  PORT,
  async () => {
    console.log(
      `WhagemIA backend démarré sur le port ${PORT}`
    );

    /*
     * Reconnexion automatique après :
     * - redémarrage Render
     * - redeploy
     * - crash
     * - mise en veille
     */
    try {
      await baileysService.reconnectAllActiveSessions();

      console.log(
        '✅ Reconnexion automatique terminée'
      );
    } catch (error) {
      console.error(
        '❌ Erreur reconnexion automatique:',
        error.message
      );
    }

    startSubscriptionCron();

    console.log(
      '✅ Cron abonnements démarré'
    );
  }
);
