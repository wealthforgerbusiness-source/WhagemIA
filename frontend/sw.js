const CACHE_NAME = 'whagemia-v2'; // ⚠️ change ce numéro à CHAQUE déploiement pour forcer la mise à jour
const ASSETS_TO_CACHE = [
  '/css/variables.css',
  '/css/style.css',
  '/assets/logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/') || event.request.url.includes('/webhooks/')) {
    return;
  }

  // Pages HTML (navigation) : toujours aller chercher la dernière version sur le
  // réseau en premier. Le cache ne sert que si le téléphone est hors-ligne.
  // C'est ça qui manquait : avant, une page HTML mise en cache une fois restait
  // affichée indéfiniment, même après un nouveau déploiement.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Fichiers statiques (CSS, images) : cache d'abord, réseau en secours.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || 'WhagemIA';
  const options = {
    body: data.body || '',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
