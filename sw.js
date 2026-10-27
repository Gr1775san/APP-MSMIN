/* Service worker de Estructural MSMIN: deja la app abrible sin señal.
   Los datos (Supabase) nunca se guardan aquí; la lista de apps se guarda aparte en el teléfono. */
const VERSION = 'msmin-v8';
const BASE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png', './icons/logo.png', './icons/logo-animado.jpg', './icons/fondo-inicio-movil.jpg', './icons/fondo-inicio.jpg'];
const CDN = ['https://cdn.jsdelivr.net/', 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(BASE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range') || req.destination === 'video') return; // los videos van directo a la red
  const url = new URL(req.url);

  // Página: primero la red (para recibir versiones nuevas), si no hay señal la copia guardada.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req, { cache: 'no-store' }).then((r) => { // siempre la versión publicada, sin copia vieja del navegador
      const copia = r.clone(); caches.open(VERSION).then((c) => c.put('./index.html', copia)); return r;
    }).catch(() => caches.match('./index.html')));
    return;
  }

  const propio = url.origin === self.location.origin;
  const cdn = CDN.some((p) => req.url.startsWith(p));
  if (!propio && !cdn) return; // Supabase y apps de Google: siempre directo a la red

  // Archivos fijos: la copia guardada y, en segundo plano, se actualiza.
  e.respondWith(caches.match(req).then((guardado) => {
    const red = fetch(req, propio ? { cache: 'no-cache' } : undefined).then((r) => {
      if (r && (r.ok || r.type === 'opaque')) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put(req, copia)); }
      return r;
    }).catch(() => guardado);
    return guardado || red;
  }));
});
