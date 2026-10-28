// Service worker clásico con precache: si alguna ruta no existe, la instalación falla.
const PRECACHE = ['./', 'index.html', 'js/lib/store.js', 'css/app.css', 'img/logo.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open('v1').then((cache) => cache.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
