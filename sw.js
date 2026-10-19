/* Service worker: mette in cache tutta l'app al primo avvio, così sul telefono
 * funziona anche senza rete. I PDF non vengono mai toccati da qui: restano
 * nella memoria della pagina e non passano da nessuna cache.
 */
const CACHE = 'pdftool-v1';

const ASSETS = [
  './',
  'index.html',
  'app.js',
  'coords.js',
  'style.css',
  'manifest.json',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js',
  'vendor/pdf-lib.min.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      // tiene aggiornata la cache quando la rete c'è
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => new Response('non disponibile offline', { status: 503 })))
  );
});
