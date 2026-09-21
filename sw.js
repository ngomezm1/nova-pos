/* NOVA POS — service worker.
 * La app tiene que abrir aunque no haya señal en el local: el casco de la app se
 * sirve desde caché y los datos viven en localStorage.
 */
var CACHE = 'nova-pos-v5';

var CASCO = [
  './',
  './index.html',
  './css/style.css',
  './js/store.js',
  './js/cloud.js',
  './js/ui.js',
  './manifest.webmanifest',
  './assets/logo.jpg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(CASCO); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) {
        return Promise.all(ks.map(function (k) {
          return k === CACHE ? null : caches.delete(k);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  // Nunca cachear Supabase: los datos deben venir frescos o fallar y reintentar.
  if (url.hostname.indexOf('supabase') !== -1) return;

  // Navegación: red primero, caché como respaldo.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function () {
        return caches.match('./index.html').then(function (r) { return r || caches.match('./'); });
      })
    );
    return;
  }

  // Todo lo demás: caché primero, y se refresca por detrás.
  e.respondWith(
    caches.match(req).then(function (hit) {
      var red = fetch(req).then(function (res) {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          var copia = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copia); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || red;
    })
  );
});
