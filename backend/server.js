require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// Route de test
app.get('/', (req, res) => {
  res.json({ status: 'WhagemIA backend en ligne', version: '1.0.0' });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`WhagemIA backend démarré sur le port ${PORT}`);
});
