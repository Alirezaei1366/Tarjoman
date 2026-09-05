/* ترجمان — سرویس‌ورکر: کش پوسته آفلاین */
const VER = 'tarjoman-v1.1.0';
const CORE = [
  './', './index.html', './manifest.json', './icon.svg', './css/styles.css',
  './js/app.js', './js/config.js', './js/state.js', './js/utils.js',
  './js/services/gemini.js', './js/services/audio.js', './js/services/document.js',
  './js/workers/processor.worker.js'
];
const ALLOWED_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VER)
      .then(c => Promise.allSettled(CORE.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin && !ALLOWED_HOSTS.includes(url.hostname)) return;

  if (req.mode === 'navigate'){
    e.respondWith(
      fetch(req).then(r => {
        const c = r.clone();
        caches.open(VER).then(c2 => c2.put('./index.html', c));
        return r;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => {
      const net = fetch(req).then(r => {
        if (r && (r.ok || r.type === 'opaque')){
          const c = r.clone();
          caches.open(VER).then(c2 => c2.put(req, c));
        }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
