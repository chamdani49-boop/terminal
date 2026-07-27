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

// BUMP versi saat kamu perlu paksa reload klien (mis. fix bug di JS/HTML
// yg users' browser masih cache versi lama). Alur:
//   1. Browser fetch sw.js pada tiap page load (via navigator.serviceWorker.
//      register). Kalau bytes-nya berbeda dgn versi yg terpasang → dianggap
//      SW baru → install → skipWaiting → activate → klien ter-claim.
//   2. Handler `activate` di bawah HAPUS SEMUA cache (walau SW kita
//      passthrough, browser HTTP cache tetap ada — clients.claim() bikin
//      SW baru langsung control tab existing).
//   3. Client reload berikutnya (mis. via message SW→client, atau user
//      manual refresh) dapat HTML/JS fresh dari server (bukan cache).
// Selalu bump ke tanggal + tag pendek supaya jelas kapan bumped.
const SW_VERSION = 'v5-2026-07-27-close-based-sl';

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
    // Beri tahu SEMUA tab yg terbuka bahwa SW versi baru sudah aktif →
    // klien bisa auto-reload utk load HTML/JS fresh. Listener dipasang
    // di public/pwa-install.js (`SW_UPDATED` handler). Kalau client
    // tidak pasang listener → no-op, tidak fatal.
    try {
      const clientList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
      clientList.forEach((c) => {
        try { c.postMessage({ type: 'SW_UPDATED', version: SW_VERSION }); } catch (_) {}
      });
    } catch (_) {}
  })());
});

self.addEventListener('fetch', (event) => {
  // Passthrough eksplisit HANYA untuk navigasi HTML. Chrome menganggap SW
  // "installable" bila handler fetch menangani permintaan navigasi paling
  // tidak sekali. Selain itu (aset, JSON, API), kita biarkan default —
  // browser fetch langsung tanpa perantara SW.
  //
  // `cache: 'no-store'` BYPASS HTTP cache untuk permintaan navigasi.
  // Alasan: sebelumnya user pernah stuck di kode HTML/JS LAMA (bug di
  // _recomputeRecState) walau sudah Ctrl+Shift+R karena Chrome kadang
  // tetap serve HTML dari disk cache. Dgn no-store, tiap load HTML
  // pasti fresh dari server. Aset JS/CSS/JSON tetap boleh di-cache
  // browser (mereka pakai Cache-Control masing-masing di _headers).
  const req = event.request;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).catch(() => fetch('/index.html'))
    );
  }
});

// Broadcast versi ke halaman kalau ditanya (debug / diag).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports[0] && event.ports[0].postMessage({ version: SW_VERSION });
  }
});
