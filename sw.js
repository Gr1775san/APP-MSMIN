/* Service worker de Estructural MSMIN: deja la app abrible sin señal y la abre al instante.
   Los datos (Supabase) nunca se guardan aquí; la lista de apps se guarda aparte en el teléfono.
   Al publicar cambios en index.html, subir VERSION: los teléfonos se actualizan solos al abrir. */
const VERSION = 'msmin-v17';
const BASE = ['./', './index.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png', './icons/logo.png', './icons/logo-animado.jpg', './icons/fondo-inicio-movil.jpg', './icons/fondo-inicio.jpg'];
const CDN = ['https://cdn.jsdelivr.net/', 'https://fonts.googleapis.com/', 'https://fonts.gstatic.com/'];
const ESPERA_RED = 2500; // ms: si la red no responde en este tiempo, se abre la copia guardada

self.addEventListener('install', (e) => {
  // cache: 'reload' → baja la versión publicada, no una copia vieja del navegador
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(BASE.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range') || req.destination === 'video') return; // los videos van directo a la red
  const url = new URL(req.url);

  // Página: se pide a la red, pero si tarda más de ESPERA_RED (poca señal en terreno) o falla,
  // se abre la copia guardada. La respuesta de la red igual queda guardada para la próxima vez.
  if (req.mode === 'navigate') {
    const red = fetch(req, { cache: 'no-store' }).then((r) => {
      if (r && r.ok) { const copia = r.clone(); e.waitUntil(caches.open(VERSION).then((c) => c.put('./index.html', copia))); }
      return r;
    });
    e.respondWith(new Promise((listo) => {
      let resuelto = false;
      const usarCopia = () => caches.match('./index.html').then((g) => { if (g && !resuelto) { resuelto = true; listo(g); } return g; });
      const t = setTimeout(usarCopia, ESPERA_RED);
      red.then((r) => { clearTimeout(t); if (!resuelto) { resuelto = true; listo(r); } })
        .catch(() => { clearTimeout(t); usarCopia().then((g) => { if (!g && !resuelto) { resuelto = true; listo(Response.error()); } }); });
    }));
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
