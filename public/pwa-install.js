/* ══════════════════════════════════════════════════════════════════════
 * pwa-install.js — Popup "Pasang Terminal ke HP" + registrasi Service Worker
 *
 * Flow (dashboard saja — di-include dari index.html):
 *   1. Register /sw.js (syarat installability Chrome).
 *   2. Kalau app sudah dibuka dalam mode standalone (=user sudah pasang PWA):
 *      POST /api/pwa-installed → tandai di server → tidak pernah tampil lagi.
 *   3. Kalau in-app browser (webview) atau browser tidak dukung PWA: diam.
 *   4. Tangkap event `beforeinstallprompt` (Android/Chrome/Edge) untuk
 *      dipanggil belakangan saat user klik tombol "Pasang".
 *   5. Tunggu __ES_PROFILE ready → cek server:
 *        - pwa.should_prompt=false → diam (belum 7 hari sejak popup terakhir,
 *          atau user sudah installed).
 *        - pwa.should_prompt=true → tunggu tos_accepted=true (consent gate),
 *          lalu tampilkan popup.
 *      Untuk user BARU (guide_seen=false): set window.__ES_PWA_PENDING=true
 *      sebelum tos_accepted → panduan.js menahan diri sampai popup PWA
 *      selesai (dismiss / install / abaikan).
 *   6. Popup menampilkan tombol "Pasang Sekarang":
 *        - BIP tersedia → trigger native install prompt Chrome.
 *        - iOS Safari → swap ke instruksi 2 langkah (Share → Add to Home).
 *        - Lainnya (desktop/browser tanpa BIP) → instruksi generik.
 *   7. POST /api/pwa-shown saat popup benar-benar terlihat (untuk reset
 *      window 7-hari server-side).
 *   8. Popup ditutup / user install / user "Nanti saja" →
 *      __ES_PWA_PENDING=false, panduan.js boleh muncul (buat user baru).
 *
 * Visual: card ungu-gelap dgn ikon app besar, feature list ber-ikon, tombol
 * gradient premium. Konsisten dgn design system Terminal (var CSS
 * --card/--border/--accent/--grad/--text*). Fallback warna kalau var tak
 * ke-resolve (mis. dibuka sebelum theme applied).
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (!window || !document) return;
  var W = window, D = document;

  // ── State ──
  var deferredPrompt = null;      // beforeinstallprompt event tersimpan
  var modalShown = false;         // guard double-show
  var overlayEl = null;

  // ── UA detection ──
  var UA = navigator.userAgent || '';
  var isIOS = /iP(hone|od|ad)/.test(UA);
  var isAndroid = /Android/.test(UA);
  var isMac = /Macintosh/.test(UA) && 'ontouchend' in D;   // iPad iPadOS ≥13 spoof
  if (isMac) isIOS = true;

  // ── Standalone (sudah installed) detection ──
  function isStandalone() {
    try {
      if (W.matchMedia && W.matchMedia('(display-mode: standalone)').matches) return true;
      if (W.matchMedia && W.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (W.navigator && W.navigator.standalone === true) return true;   // iOS
      if (D.referrer && D.referrer.indexOf('android-app://') === 0) return true;
      return false;
    } catch (e) { return false; }
  }

  // ── Webview / in-app browser detection (skip: tak bisa install PWA) ──
  function isInAppBrowser() {
    var isIOSua = /iP(hone|od|ad)/.test(UA);
    var isAndroidUa = /Android/.test(UA);
    var appMarkers = [
      'Instagram', 'FBAN', 'FBAV', 'FB_IAB', 'FBIOS', 'Threads',
      'Line/', 'TikTok', 'Musical_ly', 'BytedanceWebview',
      'TwitterAndroid', 'Twitter for', 'X for', 'LinkedInApp',
      'MicroMessenger', 'WeChat', 'Snapchat', 'Pinterest', 'GSA/',
      'Messenger', 'KAKAOTALK', 'NAVER', 'DingTalk', 'Weibo', 'QQ/'
    ];
    var byApp = appMarkers.some(function (m) { return UA.indexOf(m) >= 0; });
    var byWv = isAndroidUa && /;\s*wv\)/.test(UA);
    var byIOS = false;
    if (isIOSua) {
      var legit = /Safari\//.test(UA) || /CriOS/.test(UA) || /FxiOS/.test(UA)
                || /EdgiOS/.test(UA) || /OPiOS/.test(UA) || /DuckDuckGo/.test(UA);
      byIOS = !legit;
    }
    return byApp || byWv || byIOS;
  }

  // ── API helpers ──
  function postJson(path) {
    try {
      return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    } catch (e) { return Promise.reject(e); }
  }

  // ── Service Worker registration + auto-reload on SW update ──
  //
  // Kalau SW versi baru aktif (mis. setelah bug fix di JS di-deploy),
  // SW akan `postMessage({type:'SW_UPDATED'})` ke semua tab. Kita auto-
  // reload sekali (dgn guard supaya tidak loop) supaya klien langsung
  // load HTML/JS fresh — user gak perlu manual Ctrl+Shift+R.
  //
  // Guard: `__ES_SW_RELOADED` di sessionStorage — kalau sudah reload
  // dalam session ini, jangan reload lagi (prevent infinite loop kalau
  // ada bug SW yg trigger message berulang).
  function _autoReloadOnSwUpdate() {
    try {
      navigator.serviceWorker.addEventListener('message', function (ev) {
        var data = ev && ev.data;
        if (!data || data.type !== 'SW_UPDATED') return;
        try {
          if (sessionStorage.getItem('__ES_SW_RELOADED') === '1') return;
          sessionStorage.setItem('__ES_SW_RELOADED', '1');
        } catch (_) {}
        // Kasih console info supaya user paham kalau lihat DevTools.
        try { console.info('[SW] versi baru aktif (' + (data.version || '?') + ') — auto-reload utk load kode fresh.'); } catch (_) {}
        // Reload dgn small delay supaya console log flushed & user gak
        // lihat "flicker" kalau lagi buka popup. `location.reload()` tanpa
        // arg = normal reload (pakai HTTP cache). Karena SW fetch handler
        // sudah pakai `cache: 'no-store'` untuk navigate, HTML pasti fresh.
        setTimeout(function () {
          try { location.reload(); } catch (_) {}
        }, 300);
      });
    } catch (_) {}
  }

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    // Pasang listener SW-message SEBELUM register, biar tidak ke-lewat
    // event `SW_UPDATED` yg fires cepat setelah install pertama.
    _autoReloadOnSwUpdate();
    // Delay registrasi supaya tak mengganggu main thread saat page-load kritis.
    W.addEventListener('load', function () {
      try {
        navigator.serviceWorker.register('/sw.js').catch(function () {
          // Fail-safe: kalau gagal register, tak apa — cuma popup PWA yg tak
          // bisa memicu BIP di Chrome. Fitur lain jalan normal.
        });
      } catch (e) {}
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // BOOT
  // ═════════════════════════════════════════════════════════════════════
  registerSW();

  // Sudah installed → beri tahu server (idempotent), keluar.
  if (isStandalone()) {
    // Tunggu __ES_PROFILE dulu supaya kita tahu user authenticated (endpoint
    // butuh session cookie). Kalau tidak authenticated, kita skip diam-diam.
    var stTries = 0, stTimer = setInterval(function () {
      var p = W.__ES_PROFILE;
      if (p && p.authenticated) {
        clearInterval(stTimer);
        try { postJson('/api/pwa-installed'); } catch (e) {}
      } else if (++stTries > 40) { clearInterval(stTimer); }
    }, 300);
    return;
  }

  // Webview → tak bisa install PWA → diam.
  if (isInAppBrowser()) return;

  // Simpan BIP untuk dipanggil belakangan.
  W.addEventListener('beforeinstallprompt', function (e) {
    try { e.preventDefault(); } catch (_) {}
    deferredPrompt = e;
  });

  // Selesai install (Android Chrome) → tandai server + tutup modal.
  W.addEventListener('appinstalled', function () {
    try { postJson('/api/pwa-installed'); } catch (e) {}
    hideModal();
  });

  // ═════════════════════════════════════════════════════════════════════
  // Wait profile → decide
  // ═════════════════════════════════════════════════════════════════════
  var profTries = 0;
  var profTimer = setInterval(function () {
    var p = W.__ES_PROFILE;
    if (p && p.authenticated) {
      clearInterval(profTimer);
      onProfileReady(p);
    } else if (++profTries > 40) {
      clearInterval(profTimer);   // 12 detik menyerah (user belum login)
    }
  }, 300);

  function onProfileReady(p) {
    var pwa = p.pwa || {};
    if (pwa.is_installed) return;
    if (!pwa.should_prompt) return;

    var isNewUser = !p.guide_seen;

    if (isNewUser) {
      // Beritahu panduan.js: tahan diri, ada popup PWA yang harus muncul dulu.
      W.__ES_PWA_PENDING = true;
      waitForConsent(function () {
        // Beri jeda 500ms agar consent gate fully close (fade-out CSS).
        setTimeout(showModal, 500);
      });
    } else {
      // User lama: kalau consent belum diterima (mis. TOS_VERSION dinaikkan),
      // tunggu selesai baru muncul.
      if (p.tos_accepted === false) {
        waitForConsent(function () { setTimeout(showModal, 500); });
      } else {
        // Beri jeda 1.5s supaya page settle, tak bertabrakan dgn splash.
        setTimeout(showModal, 1500);
      }
    }
  }

  function waitForConsent(cb) {
    var tries = 0;
    var timer = setInterval(function () {
      var p = W.__ES_PROFILE;
      if (p && p.tos_accepted === true) { clearInterval(timer); cb(); }
      else if (++tries > 400) { clearInterval(timer); /* 2 menit menyerah */ }
    }, 300);
  }

  // ═════════════════════════════════════════════════════════════════════
  // Modal UI
  // ═════════════════════════════════════════════════════════════════════
  var CSS =
    '.es-pwa-overlay{position:fixed;inset:0;z-index:2147483000;' +
      'background:rgba(6,4,20,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;' +
      'font-family:"Plus Jakarta Sans",system-ui,-apple-system,sans-serif;' +
      'opacity:0;transition:opacity .28s ease;pointer-events:none}' +
    '.es-pwa-overlay.show{opacity:1;pointer-events:auto}' +

    '.es-pwa-card{position:relative;background:var(--card,#1f1450);color:var(--text,#f4f2ff);' +
      'border:1px solid var(--border,#4a3590);border-radius:22px;' +
      'box-shadow:0 24px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.02) inset;' +
      'width:100%;max-width:410px;padding:26px 24px 22px;text-align:left;' +
      'transform:translateY(20px) scale(.96);transition:transform .32s cubic-bezier(.2,.9,.2,1);' +
      'max-height:calc(100vh - 40px);overflow-y:auto}' +
    '.es-pwa-overlay.show .es-pwa-card{transform:translateY(0) scale(1)}' +

    '.es-pwa-close{position:absolute;top:12px;right:12px;background:transparent;border:none;' +
      'color:var(--text3,#8b7eb8);width:32px;height:32px;border-radius:8px;font-size:22px;' +
      'line-height:1;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}' +
    '.es-pwa-close:hover{background:var(--bg2,rgba(255,255,255,.06));color:var(--text,#f4f2ff)}' +

    '.es-pwa-icon-wrap{position:relative;width:80px;height:80px;margin:6px auto 16px;display:flex;' +
      'align-items:center;justify-content:center}' +
    '.es-pwa-icon{width:80px;height:80px;border-radius:20px;' +
      'box-shadow:0 12px 30px rgba(109,40,217,.45),0 0 0 1px rgba(196,163,255,.35);' +
      'background:linear-gradient(135deg,#6d28d9,#2563eb);object-fit:cover;position:relative;z-index:2}' +
    '.es-pwa-icon-glow{position:absolute;inset:-14px;border-radius:50%;' +
      'background:radial-gradient(closest-side,rgba(124,92,255,.35),transparent 70%);' +
      'z-index:1;animation:es-pwa-pulse 2.4s ease-in-out infinite}' +
    '@keyframes es-pwa-pulse{0%,100%{opacity:.55;transform:scale(1)}50%{opacity:.95;transform:scale(1.08)}}' +

    '.es-pwa-title{font-size:20px;font-weight:800;line-height:1.25;text-align:center;' +
      'margin-bottom:6px;letter-spacing:-.01em}' +
    '.es-pwa-sub{font-size:13.5px;color:var(--text2,#c4b8e8);line-height:1.55;text-align:center;' +
      'margin-bottom:20px;padding:0 4px}' +

    '.es-pwa-features{list-style:none;padding:0;margin:0 0 20px;display:flex;flex-direction:column;gap:12px}' +
    '.es-pwa-features li{display:flex;gap:12px;align-items:flex-start;padding:11px 12px;' +
      'background:var(--bg2,rgba(124,92,255,.06));border:1px solid var(--border,#4a3590);' +
      'border-radius:12px}' +
    '.es-pwa-feat-icon{width:34px;height:34px;flex-shrink:0;border-radius:10px;' +
      'background:linear-gradient(135deg,rgba(109,40,217,.25),rgba(37,99,235,.2));' +
      'display:flex;align-items:center;justify-content:center;font-size:18px}' +
    '.es-pwa-feat-icon svg{width:18px;height:18px;color:#c4a3ff}' +
    '.es-pwa-feat-text{flex:1;font-size:13px;line-height:1.4;color:var(--text2,#c4b8e8)}' +
    '.es-pwa-feat-text b{display:block;color:var(--text,#f4f2ff);font-weight:700;font-size:13.5px;margin-bottom:1px}' +

    '.es-pwa-install-btn{width:100%;background:linear-gradient(135deg,#6d28d9 0%,#2563eb 100%);' +
      'color:#fff;font-family:inherit;font-size:15px;font-weight:800;padding:14px;border:none;' +
      'border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;' +
      'gap:9px;margin-bottom:8px;box-shadow:0 8px 24px rgba(109,40,217,.4);transition:transform .1s,filter .15s}' +
    '.es-pwa-install-btn:hover{filter:brightness(1.08)}' +
    '.es-pwa-install-btn:active{transform:translateY(1px)}' +
    '.es-pwa-install-btn svg{width:18px;height:18px}' +

    '.es-pwa-later{width:100%;background:transparent;color:var(--text2,#c4b8e8);' +
      'font-family:inherit;font-size:13px;font-weight:600;padding:10px;border:none;cursor:pointer;' +
      'text-decoration:underline;text-decoration-color:transparent;transition:text-decoration-color .2s}' +
    '.es-pwa-later:hover{text-decoration-color:var(--text2,#c4b8e8)}' +

    /* iOS/desktop instructions view */
    '.es-pwa-steps{display:none;flex-direction:column;gap:14px;margin-bottom:18px}' +
    '.es-pwa-card.instructions .es-pwa-features{display:none}' +
    '.es-pwa-card.instructions .es-pwa-steps{display:flex}' +
    '.es-pwa-card.instructions .es-pwa-install-btn{display:none}' +
    '.es-pwa-card.instructions .es-pwa-ok-btn{display:flex}' +

    '.es-pwa-step{display:flex;gap:14px;align-items:flex-start;padding:14px;' +
      'background:var(--bg2,rgba(124,92,255,.06));border:1px solid var(--border,#4a3590);border-radius:12px}' +
    '.es-pwa-step-num{width:28px;height:28px;flex-shrink:0;border-radius:50%;' +
      'background:linear-gradient(135deg,#6d28d9,#2563eb);color:#fff;font-weight:800;font-size:14px;' +
      'display:flex;align-items:center;justify-content:center}' +
    '.es-pwa-step-body{flex:1;font-size:13px;line-height:1.5;color:var(--text,#f4f2ff)}' +
    '.es-pwa-step-body b{font-weight:700}' +
    '.es-pwa-inline-icon{display:inline-flex;vertical-align:-4px;width:18px;height:18px;margin:0 3px;' +
      'color:var(--accent,#c4a3ff)}' +
    '.es-pwa-step-body .es-pwa-inline-icon svg{width:100%;height:100%}' +

    '.es-pwa-ok-btn{display:none;width:100%;background:linear-gradient(135deg,#6d28d9 0%,#2563eb 100%);' +
      'color:#fff;font-family:inherit;font-size:14px;font-weight:800;padding:13px;border:none;' +
      'border-radius:12px;cursor:pointer;align-items:center;justify-content:center;margin-bottom:8px;' +
      'box-shadow:0 6px 18px rgba(109,40,217,.35)}' +
    '.es-pwa-ok-btn:hover{filter:brightness(1.08)}' +

    /* Skema warna terang — override kalau data-theme=light */
    '[data-theme="light"] .es-pwa-card{background:#ffffff;color:#1a0f3c;border-color:#d4ccf0;' +
      'box-shadow:0 24px 70px rgba(109,40,217,.25)}' +
    '[data-theme="light"] .es-pwa-close{color:#6e6490}' +
    '[data-theme="light"] .es-pwa-close:hover{background:#f4f2ff;color:#1a0f3c}' +
    '[data-theme="light"] .es-pwa-sub{color:#6e6490}' +
    '[data-theme="light"] .es-pwa-features li{background:#f4f2ff;border-color:#d4ccf0}' +
    '[data-theme="light"] .es-pwa-feat-text{color:#6e6490}' +
    '[data-theme="light"] .es-pwa-feat-text b{color:#1a0f3c}' +
    '[data-theme="light"] .es-pwa-step{background:#f4f2ff;border-color:#d4ccf0}' +
    '[data-theme="light"] .es-pwa-step-body{color:#1a0f3c}' +
    '[data-theme="light"] .es-pwa-later{color:#6e6490}' +

    /* Mobile fine-tuning */
    '@media (max-width:420px){' +
      '.es-pwa-card{padding:22px 18px 18px;border-radius:20px}' +
      '.es-pwa-title{font-size:18px}' +
      '.es-pwa-features li{padding:10px}' +
      '.es-pwa-feat-icon{width:30px;height:30px;font-size:16px}' +
      '.es-pwa-feat-text{font-size:12.5px}' +
    '}';

  function injectCss() {
    if (D.getElementById('es-pwa-style')) return;
    var st = D.createElement('style'); st.id = 'es-pwa-style'; st.textContent = CSS;
    D.head.appendChild(st);
  }

  // SVG icons
  var ICON_DOWNLOAD =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>' +
    '</svg>';
  var ICON_SHARE_IOS =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 2v13"/><path d="m7 7 5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>' +
    '</svg>';
  var ICON_PLUS_SQUARE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8"/><path d="M8 12h8"/>' +
    '</svg>';
  var ICON_KEBAB =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="12" cy="6" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="18" r="1.3"/>' +
    '</svg>';

  function buildInstructions() {
    if (isIOS) {
      return '<div class="es-pwa-step"><div class="es-pwa-step-num">1</div>' +
        '<div class="es-pwa-step-body">Tap ikon <span class="es-pwa-inline-icon">' + ICON_SHARE_IOS +
        '</span> <b>Bagikan</b> di address bar Safari (bagian bawah layar).</div></div>' +
        '<div class="es-pwa-step"><div class="es-pwa-step-num">2</div>' +
        '<div class="es-pwa-step-body">Scroll ke bawah, tap <b>"Tambahkan ke Layar Utama"</b> ' +
        '(<i>Add to Home Screen</i>) <span class="es-pwa-inline-icon">' + ICON_PLUS_SQUARE + '</span></div></div>' +
        '<div class="es-pwa-step"><div class="es-pwa-step-num">3</div>' +
        '<div class="es-pwa-step-body">Tap <b>Tambahkan</b> di pojok kanan atas. Ikon Economstock muncul di layar utama.</div></div>';
    }
    // Android non-BIP / desktop
    return '<div class="es-pwa-step"><div class="es-pwa-step-num">1</div>' +
      '<div class="es-pwa-step-body">Tap ikon <span class="es-pwa-inline-icon">' + ICON_KEBAB +
      '</span> menu di pojok kanan atas browser.</div></div>' +
      '<div class="es-pwa-step"><div class="es-pwa-step-num">2</div>' +
      '<div class="es-pwa-step-body">Pilih <b>"Pasang aplikasi"</b> / <b>"Add to Home screen"</b> / <b>"Install app"</b>.</div></div>' +
      '<div class="es-pwa-step"><div class="es-pwa-step-num">3</div>' +
      '<div class="es-pwa-step-body">Konfirmasi <b>Pasang</b>. Terminal muncul sebagai app terpisah.</div></div>';
  }

  function buildModal() {
    var ov = D.createElement('div'); ov.className = 'es-pwa-overlay'; ov.id = 'es-pwa-overlay';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'es-pwa-title');
    ov.innerHTML =
      '<div class="es-pwa-card" id="es-pwa-card">' +
        '<button class="es-pwa-close" id="es-pwa-close" aria-label="Tutup">\u00d7</button>' +

        '<div class="es-pwa-icon-wrap">' +
          '<div class="es-pwa-icon-glow"></div>' +
          '<img class="es-pwa-icon" src="/icon.png" alt="Economstock" />' +
        '</div>' +

        '<div class="es-pwa-title" id="es-pwa-title">Pasang Economstock di HP-mu</div>' +
        '<div class="es-pwa-sub">Akses Terminal lebih cepat, tampil layar penuh seperti aplikasi asli.</div>' +

        '<ul class="es-pwa-features">' +
          '<li><div class="es-pwa-feat-icon">\u26A1</div><div class="es-pwa-feat-text"><b>Buka instan</b>Tap ikon di layar utama, langsung ke dashboard tanpa buka browser.</div></li>' +
          '<li><div class="es-pwa-feat-icon">\uD83D\uDCF1</div><div class="es-pwa-feat-text"><b>Layar penuh</b>Tanpa address bar, terasa seperti aplikasi native.</div></li>' +
          '<li><div class="es-pwa-feat-icon">\uD83C\uDFE0</div><div class="es-pwa-feat-text"><b>Ikon di layar utama</b>Sekali pasang, akses seumur hidup langganan.</div></li>' +
          '<li><div class="es-pwa-feat-icon">\uD83D\uDD12</div><div class="es-pwa-feat-text"><b>Login tetap aman</b>Sesi terenkripsi &amp; tersinkron seperti biasa.</div></li>' +
        '</ul>' +

        '<div class="es-pwa-steps" id="es-pwa-steps">' + buildInstructions() + '</div>' +

        '<button class="es-pwa-install-btn" id="es-pwa-install">' + ICON_DOWNLOAD + '<span>Pasang Sekarang</span></button>' +
        '<button class="es-pwa-ok-btn" id="es-pwa-ok"><span>Mengerti</span></button>' +
        '<button class="es-pwa-later" id="es-pwa-later">Nanti saja</button>' +
      '</div>';
    return ov;
  }

  function showModal() {
    if (modalShown) return;
    modalShown = true;

    injectCss();
    overlayEl = buildModal();
    D.body.appendChild(overlayEl);

    // Force reflow → transition in
    requestAnimationFrame(function () { overlayEl.classList.add('show'); });

    // Server-side: reset window 7-hari
    try { postJson('/api/pwa-shown'); } catch (e) {}

    var card = overlayEl.querySelector('#es-pwa-card');
    var installBtn = overlayEl.querySelector('#es-pwa-install');
    var okBtn = overlayEl.querySelector('#es-pwa-ok');
    var laterBtn = overlayEl.querySelector('#es-pwa-later');
    var closeBtn = overlayEl.querySelector('#es-pwa-close');

    // Click backdrop → close
    overlayEl.addEventListener('click', function (e) {
      if (e.target === overlayEl) hideModal();
    });

    // Escape key → close
    var onKey = function (e) { if (e.key === 'Escape') { hideModal(); D.removeEventListener('keydown', onKey); } };
    D.addEventListener('keydown', onKey);

    closeBtn.addEventListener('click', hideModal);
    laterBtn.addEventListener('click', hideModal);
    okBtn.addEventListener('click', hideModal);

    installBtn.addEventListener('click', function () {
      if (deferredPrompt) {
        // Android/Chrome/Edge: trigger native install prompt.
        try {
          deferredPrompt.prompt();
          if (deferredPrompt.userChoice && deferredPrompt.userChoice.then) {
            deferredPrompt.userChoice.then(function (choice) {
              if (choice && choice.outcome === 'accepted') {
                // 'appinstalled' event akan menutup modal juga; guard di sini.
                try { postJson('/api/pwa-installed'); } catch (e) {}
                hideModal();
              } else {
                // User batalkan native prompt → tetap tutup modal supaya tidak
                // mengganggu (popup sudah masuk hitungan 7 hari).
                hideModal();
              }
              deferredPrompt = null;
            });
          }
        } catch (e) {
          // Fallback: BIP corrupt / dipanggil ulang → tampilkan instruksi.
          card.classList.add('instructions');
        }
      } else {
        // Tak ada BIP (iOS / desktop tanpa install banner) → tampilkan instruksi.
        card.classList.add('instructions');
      }
    });
  }

  function hideModal() {
    W.__ES_PWA_PENDING = false;
    if (!overlayEl) return;
    overlayEl.classList.remove('show');
    setTimeout(function () {
      try { overlayEl && overlayEl.parentNode && overlayEl.parentNode.removeChild(overlayEl); } catch (e) {}
      overlayEl = null;
    }, 300);
  }

  // Expose kecil untuk debugging / tombol manual di masa depan
  W.__ES_PWA = { show: showModal, hide: hideModal, get deferred() { return deferredPrompt; } };
})();
