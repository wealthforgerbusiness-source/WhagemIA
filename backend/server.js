require('dotenv').config();
const express = require('express');
const cors = require('cors');

const userRoutes = require('./routes/userRoutes');
const webhookRoutes = require('./routes/webhookRoutes');
const whatsappRoutes = require('./routes/whatsappRoutes');

const app = express();

app.use(cors());

app.get('/', (req, res) => {
  res.json({ status: 'WhagemIA backend en ligne', version: '1.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.use('/webhooks', webhookRoutes);

app.use(express.json());
app.use('/api/user', userRoutes);
app.use('/api/whatsapp', whatsappRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`WhagemIA backend démarré sur le port ${PORT}`);
});
