const ADMIN_EMAILS = [
  'ton-email@gmail.com', // remplace par ton vrai email Google (celui utilisé pour te connecter)
];

function verifyAdmin(req, res, next) {
  if (!ADMIN_EMAILS.includes(req.userEmail)) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  next();
}

module.exports = { verifyAdmin };
