/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — Service Worker (MINIMAL, non-caching)
 *
 * Tujuan: memenuhi syarat installability PWA di Chrome/Edge/Samsung Internet.
 * Chrome mensyaratkan sebuah service worker yang punya fetch handler untuk
 * bisa memicu event `beforeinstallprompt` dan menampilkan tombol "Install".
 *
 * KENAPA TIDAK CACHING?
 * Terminal adalah aplikasi data-heavy dengan JSON besar (data.json,
 * tracker.json, ohlc.json, valuation/*.json) yang di-refresh cron jam-an.
 * Cache offline berisiko menampilkan data basi tanpa disadari user. Cache
 * juga bisa bentrok dgn header `Cache-Control` gated di Worker (private,
 * s-maxage, stale-while-revalidate). Jadi SW ini SENGAJA passthrough:
 * biarkan browser + Worker + CDN yang mengatur cache seperti biasa.
 *
 * Kalau nanti mau full offline (mis. shell caching index.html), tambahkan
 * strategi cache-first HANYA untuk aset statis versi-tagged (JS/CSS
 * dengan hash) — JANGAN untuk *.json data.
 * ══════════════════════════════════════════════════════════════════════ */

const SW_VERSION = 'v1-2026-07-17';

self.addEventListener('install', (event) => {
  // Aktifkan SW baru segera setelah install → user tak perlu tutup tab.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Klaim semua tab yang sudah terbuka biar bisa langsung pakai SW ini.
    try { await self.clients.claim(); } catch (_) {}
    // Bersih-bersih cache lama kalau versi SW sebelumnya sempat menyimpan.
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}
  })());
});

self.addEventListener('fetch', (event) => {
  // Passthrough eksplisit HANYA untuk navigasi HTML. Chrome menganggap SW
  // "installable" bila handler fetch menangani permintaan navigasi paling
  // tidak sekali. Selain itu (aset, JSON, API), kita biarkan default —
  // browser fetch langsung tanpa perantara SW.
  const req = event.request;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => fetch('/index.html')));
  }
});

// Broadcast versi ke halaman kalau ditanya (debug / diag).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0] && event.ports[0].postMessage({ version: SW_VERSION });
  }
});
