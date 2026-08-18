require('dotenv').config();
const express = require('express');
const cors = require('cors');

const userRoutes = require('./routes/userRoutes');
const webhookRoutes = require('./routes/webhookRoutes');

const app = express();

app.use(cors());

app.get('/', (req, res) => {
  res.json({ status: 'WhagemIA backend en ligne', version: '1.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// Webhook AVANT express.json() global, car il a besoin du body brut
app.use('/webhooks', webhookRoutes);

// Le reste des routes utilise le JSON parsé normalement
app.use(express.json());
app.use('/api/user', userRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`WhagemIA backend démarré sur le port ${PORT}`);
});
