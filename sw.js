/*
 * DompetKu v2 — service worker
 * Semua file aplikasi disimpan saat install, jadi aplikasi bisa dibuka tanpa internet.
 * Strategi: tampilkan dari cache lebih dulu, lalu perbarui cache di latar belakang
 * (versi baru aktif pada pembukaan berikutnya). Tidak menyentuh IndexedDB, jadi data aman saat update.
 * Setelah mengubah file aplikasi, naikkan CACHE (mis. v2-1 -> v2-2).
 */
const CACHE = 'dompetku-v2-1';
const ASSETS = [
  './', 'index.html', 'css/style.css',
  'js/ledger.js', 'js/db.js', 'js/chart.js', 'js/app.js',
  'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('dompetku-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => null);
        if (hit) { net.catch(() => {}); return hit; }
        return net.then((res) => res || (req.mode === 'navigate' ? cache.match('index.html') : Response.error()));
      })
    )
  );
});
