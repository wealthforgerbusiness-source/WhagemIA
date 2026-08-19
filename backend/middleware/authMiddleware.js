const { auth } = require('../config/firebase');

// Vérifie le token Firebase envoyé par le frontend et attache l'utilisateur à la requête
async function verifyFirebaseToken(req, res, next) {
  // Accept Authorization header OR ?token=... (EventSource doesn't support custom headers)
  const authHeader = req.headers.authorization;

  let idToken = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    idToken = authHeader.split('Bearer ')[1];
  } else if (req.query && req.query.token) {
    idToken = req.query.token;
  }

  if (!idToken) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.firebaseUid = decodedToken.uid;
    req.userEmail = decodedToken.email;
    next();
  } catch (error) {
    console.error('Erreur vérification token:', error && (error.stack || error));
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

module.exports = { verifyFirebaseToken };
