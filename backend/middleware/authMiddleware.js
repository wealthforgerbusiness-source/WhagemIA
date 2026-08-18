const { auth } = require('../config/firebase');

// Vérifie le token Firebase envoyé par le frontend et attache l'utilisateur à la requête
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  const idToken = authHeader.split('Bearer ')[1];

  try {
    const decodedToken = await auth.verifyIdToken(idToken);
    req.firebaseUid = decodedToken.uid;
    req.userEmail = decodedToken.email;
    next();
  } catch (error) {
    console.error('Erreur vérification token:', error.message);
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

module.exports = { verifyFirebaseToken };
