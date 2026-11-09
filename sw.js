/* MoDa : service worker (inspiré de Securechat)
   - Ouverture instantanée : la page, app.js et les bibliothèques viennent du cache.
   - Mises à jour rapides : à chaque ouverture, index.html et app.js sont re-téléchargés en contournant
     tous les caches ; s'ils ont changé, la page est prévenue et se recharge (sans jamais couper une partie).
   - Les appels Firebase ne sont jamais mis en cache (aucune donnée de jeu n'est stockée ici). */
const VERSION = 'moda-v22';
const SHELL = 'shell-' + VERSION;
const LIBS = 'libs-' + VERSION;
const FILES = ['./', 'index.html', 'app.js', 'sim.js', 'simcore.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];
const WATCHED = ['index.html', 'app.js', 'sim.js', 'simcore.js']; // les fichiers dont un changement déclenche la mise à jour
const LIB_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.all(FILES.map((f) => c.add(new Request(f, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      const hadOld = keys.some((k) => k !== SHELL && k !== LIBS && k.indexOf('shell-') === 0);
      return Promise.all(keys.filter((k) => k !== SHELL && k !== LIBS).map((k) => caches.delete(k)))
        .then(() => self.clients.claim())
        .then(() => (hadOld ? notifyClients() : null));
    })
  );
});

const cacheable = (res) => res && (res.ok || res.type === 'opaque');

function notifyClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((list) => list.forEach((c) => c.postMessage({ type: 'sw-update' })));
}

// Re-télécharge un fichier en contournant le cache HTTP (GitHub Pages garde 10 min), compare, met à jour, prévient si changé
async function revalidate(req) {
  try {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(req);
    const res = await fetch(req, { cache: 'reload' });
    if (!cacheable(res)) return;
    let changed = false;
    if (cached && res.type !== 'opaque') {
      const [a, b] = await Promise.all([cached.clone().text(), res.clone().text()]);
      changed = a !== b;
    }
    await cache.put(req, res.clone());
    return changed;
  } catch (err) { return false; /* hors ligne : on garde la version en cache */ }
}

// Met à jour TOUS les fichiers surveillés, puis prévient la page une seule fois (évite de recharger un app.js périmé)
async function refreshAll(force) {
  const res = await Promise.all(['./', ...WATCHED].map((f) => revalidate(new Request(new URL(f, self.registration.scope).href))));
  if (force || res.some(Boolean)) await notifyClients();
}

const isWatched = (url) => url.origin === self.location.origin &&
  (url.pathname.endsWith('/') || WATCHED.some((f) => url.pathname.endsWith('/' + f)));

// Répond tout de suite avec le cache s'il existe, et rafraîchit en arrière-plan
function staleWhileRevalidate(event, cacheName, watched) {
  const req = event.request;
  event.respondWith(
    caches.open(cacheName).then(async (cache) => {
      const cached = await cache.match(req);
      if (watched) {
        const refresh = revalidate(req).then((ch) => (ch ? refreshAll(true) : null));
        if (cached) { event.waitUntil(refresh); return cached; }
        await refresh;
        return (await cache.match(req)) || fetch(req).catch(() => Response.error());
      }
      const network = fetch(req).then((res) => { if (cacheable(res)) cache.put(req, res.clone()); return res; }).catch(() => null);
      if (cached) { event.waitUntil(network); return cached; }
      return (await network) || Response.error();
    })
  );
}

// Bibliothèques versionnées (…/10.14.1/…) : le cache gagne toujours
function cacheFirst(event, cacheName) {
  const req = event.request;
  event.respondWith(
    caches.open(cacheName).then(async (cache) => {
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (cacheable(res)) cache.put(req, res.clone());
        return res;
      } catch (err) { return Response.error(); }
    })
  );
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    if (url.pathname.indexOf('/__/') === 0) return; // pages d'authentification Firebase
    staleWhileRevalidate(event, SHELL, isWatched(url));
    return;
  }
  if (LIB_HOSTS.includes(url.hostname)) {
    if (/\/\d+\.\d+\.\d+\//.test(url.pathname) || url.hostname === 'fonts.gstatic.com') cacheFirst(event, LIBS);
    else staleWhileRevalidate(event, LIBS, false);
  }
  // Firebase Auth / Realtime Database : directement par le réseau
});

// La page peut demander une vérification (retour au premier plan, vérification périodique)
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'check') {
    event.waitUntil(refreshAll(false));
  }
});
