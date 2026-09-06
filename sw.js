const V = 'shopos-v1';
const SHELL = [
  './', 'index.html', 'style.css', 'config.js',
  'app.js', 'ui.js', 'db.js', 'money.js', 'sell.js', 'items.js', 'reports.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const put = (req, res) => { const cp = res.clone(); caches.open(V).then((c) => c.put(req, cp)); return res; };

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Library files are version-pinned and never change: cache first, so the app
  // still boots with no internet.
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((r) => put(e.request, r))));
    return;
  }

  // Supabase (and anything else remote) always goes to the network.
  if (url.origin !== location.origin) return;

  // Our own files: network first so updates land immediately, cache as fallback.
  e.respondWith(
    fetch(e.request).then((r) => put(e.request, r))
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('index.html')))
  );
});
