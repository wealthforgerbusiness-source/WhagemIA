const express = require('express');
const router = express.Router();

const {
  verifyFirebaseToken,
} = require('../middleware/authMiddleware');

const baileysService =
  require('../services/baileysService');

const userModel =
  require('../models/userModel');

const sessionModel =
  require('../models/sessionModel');

const notifier = require('../services/notificationService');

const connectionStates = new Map();

// existing POST /connect ... (unchanged) -- assume already on branch

// SSE endpoint for real-time events
router.get('/events', async (req, res) => {
  // verify token via middleware logic but eventsource can't send Authorization header easily
  // reuse verifyFirebaseToken by calling it manually
  try {
    await new Promise((resolve, reject) => {
      verifyFirebaseToken(req, res, (err) => {
        // express middleware doesn't pass err, so we check res.headersSent for auth failures
        if (res.headersSent) return reject(new Error('Unauthorized'));
        resolve();
      });
    });
  } catch (err) {
    // verifyFirebaseToken already sent 401
    return;
  }

  const firebaseUid = req.firebaseUid;

  // set SSE headers
  res.writeHead(200, {
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/event-stream',
  });

  // send a ping to keep connection
  res.write(`event: ping\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

  const send = (payload) => {
    try {
      const eventName = payload.event || 'message';
      const data = payload.data || {};
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      console.error('SSE send error:', e && (e.stack || e));
    }
  };

  const listener = (payload) => {
    send(payload);
  };

  notifier.on(firebaseUid, listener);

  // when client connects, also send current state if any
  const state = connectionStates.get(firebaseUid);
  if (state) {
    send({ event: 'state', data: state });
  }

  req.on('close', () => {
    notifier.removeListener(firebaseUid, listener);
  });
});

module.exports = router;
