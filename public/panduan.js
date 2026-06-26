/* ════════════════════════════════════════════════════════════════════════
 * panduan.js — Tur interaktif "Panduan Terminal" (tanpa library)
 *
 * Dipakai di dua halaman:
 *   • Dashboard (index.html) → tur penuh: (HP: switch PC) → pilih saham →
 *     Dashboard → Consensus → Valuasi → Simulasi → Pasar Live → lanjut ke Billing.
 *   • Billing (billing.html) → 2 langkah penutup (sorot paket + tombol panduan),
 *     plus mengatur tombol "Panduan Terminal": user AKTIF → buka tur di dashboard;
 *     user NON-AKTIF → tombol mati (hanya gerak sedikit / nudge).
 *
 * Auto-start SEKALI untuk user baru (ditandai di localStorage). Ulangi via billing.
 * Mesin tur ringan: overlay spotlight (box-shadow) + kartu penjelasan + Lanjut/
 * Kembali/Tutup, auto-scroll ke elemen, tunggu-aksi (tap switch / pilih saham),
 * dan pindah antar menu. Mengikuti tema (var --card/--text/--accent dari halaman).
 * ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var W = window, D = document;
  var DONE_KEY = 'es_pandu_done_v1';     // penanda sudah pernah (auto-start sekali)
  var RESUME_KEY = 'es_pandu_resume';    // lanjutkan langkah penutup di billing

  var IS_DASH = !!D.getElementById('page-dashboard');
  var IS_BILL = !!D.getElementById('guideBtn');
  if (!IS_DASH && !IS_BILL) return;

  // ── util ──
  function $(s, r) { try { return (r || D).querySelector(s); } catch (e) { return null; } }
  function vis(e) {
    if (!e) return false;
    if (e.offsetParent === null && getComputedStyle(e).position !== 'fixed') return false;
    var r = e.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function isMobileDevice() {
    try { return D.body.classList.contains('is-mobile-device') || Math.min(screen.width, screen.height) <= 640; }
    catch (e) { return false; }
  }
  function isDesktopView() {
    try {
      if (typeof W.isDesktopView === 'function') return !!W.isDesktopView();
      return D.documentElement.getAttribute('data-view') === 'desktop';
    } catch (e) { return false; }
  }
  // Resolver target: kembalikan elemen pertama yang terlihat dari daftar selector.
  function S() {
    var a = arguments;
    return function () { for (var i = 0; i < a.length; i++) { var e = $(a[i]); if (e && vis(e)) return e; } return null; };
  }
  // Cari kartu berdasarkan teks judul (tahan perubahan DOM).
  function T(text) {
    var low = String(text).toLowerCase();
    var sels = ['.card-title', '.pl-win-title', '.vl-tb-label', '.cv-sec-title', 'h2', 'h3'];
    return function () {
      for (var s = 0; s < sels.length; s++) {
        var n = D.querySelectorAll(sels[s]);
        for (var i = 0; i < n.length; i++) {
          if ((n[i].textContent || '').toLowerCase().indexOf(low) >= 0 && vis(n[i])) {
            return n[i].closest('.card, .pl-window, .vl-card, .cv-card') || n[i];
          }
        }
      }
      return null;
    };
  }
  function findTab(text) {
    var low = String(text).toLowerCase();
    var sels = ['.cv-tab', '.vl-tab', '.period-tab', '.wl-seg-btn'];
    for (var s = 0; s < sels.length; s++) {
      var n = D.querySelectorAll(sels[s]);
      for (var i = 0; i < n.length; i++) {
        if ((n[i].textContent || '').toLowerCase().indexOf(low) >= 0 && vis(n[i])) return n[i];
      }
    }
    return null;
  }
  function TAB(text) { return function () { return findTab(text); }; }
  function gotoPage(name) {
    try { if (typeof W.showPage === 'function') W.showPage(name); } catch (e) {}
    try { if (name === 'valuasi' && typeof W.vlEnsureCharts === 'function') W.vlEnsureCharts(); } catch (e) {}
    try { if (name === 'pasar' && typeof W.plEnsure === 'function') W.plEnsure(); } catch (e) {}
  }
  function setDone() { try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {} }

  // ── style ──
  var Z = 2147480000;
  var css =
    '#pandu-dim{position:fixed;inset:0;background:rgba(8,5,25,.5);z-index:' + Z + ';opacity:0;transition:opacity .25s;pointer-events:none}' +
    '#pandu-dim.on{opacity:1}' +
    '#pandu-spot{position:fixed;z-index:' + (Z + 1) + ';border-radius:12px;box-shadow:0 0 0 9999px rgba(8,5,25,.62);border:2px solid var(--accent,#6d28d9);' +
      'transition:left .35s cubic-bezier(.4,0,.2,1),top .35s cubic-bezier(.4,0,.2,1),width .35s,height .35s,opacity .2s;pointer-events:none;opacity:0;animation:pandu-pulse 1.8s ease-in-out infinite}' +
    '@keyframes pandu-pulse{0%,100%{box-shadow:0 0 0 9999px rgba(8,5,25,.62),0 0 0 0 rgba(124,92,255,.35)}50%{box-shadow:0 0 0 9999px rgba(8,5,25,.62),0 0 0 7px rgba(124,92,255,0)}}' +
    '#pandu-card{position:fixed;z-index:' + (Z + 3) + ';max-width:340px;width:calc(100vw - 32px);background:var(--card,#1f1450);color:var(--text,#f4f2ff);' +
      'border:1px solid var(--border,#4a3590);border-radius:14px;box-shadow:0 14px 50px rgba(0,0,0,.5);padding:18px 18px 14px;' +
      'font-family:"Plus Jakarta Sans",system-ui,sans-serif;opacity:0;transition:opacity .25s,left .3s,top .3s}' +
    '#pandu-card.on{opacity:1}' +
    '#pandu-title{font-size:16px;font-weight:800;margin:0 18px 7px 0;line-height:1.25}' +
    '#pandu-body{font-size:13.5px;line-height:1.55;color:var(--text2,#c4b8e8)}' +
    '#pandu-foot{display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:10px}' +
    '#pandu-count{font-size:11px;color:var(--text3,#8b7eb8);font-weight:600}' +
    '.pandu-btns{display:flex;gap:8px}' +
    '#pandu-card button{font-family:inherit;cursor:pointer;border-radius:9px;font-size:13px;font-weight:700;padding:9px 14px;border:1px solid var(--border,#4a3590);background:transparent;color:var(--text,#f4f2ff);transition:filter .15s,background .15s}' +
    '#pandu-next{background:var(--accent,#6d28d9)!important;border-color:var(--accent,#6d28d9)!important;color:#fff!important}' +
    '#pandu-next:hover{filter:brightness(1.08)}' +
    '#pandu-back:hover{background:var(--bg2,rgba(255,255,255,.06))}' +
    '#pandu-x{position:absolute;top:7px;right:9px;background:none!important;border:none!important;color:var(--text2,#c4b8e8)!important;font-size:22px;line-height:1;padding:2px 6px!important}' +
    '#pandu-wait{font-size:11px;color:var(--accent,#c4a3ff);font-weight:700}' +
    /* welcome */
    '#pandu-welcome{position:fixed;inset:0;z-index:' + (Z + 5) + ';background:rgba(8,5,25,.66);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .25s}' +
    '#pandu-welcome.show{opacity:1}' +
    '#pandu-welcome .pw-box{background:var(--card,#1f1450);color:var(--text,#f4f2ff);border:1px solid var(--border,#4a3590);border-radius:18px;max-width:380px;width:100%;padding:30px 26px;text-align:center;box-shadow:0 16px 60px rgba(0,0,0,.5);font-family:"Plus Jakarta Sans",system-ui,sans-serif}' +
    '#pandu-welcome .pw-emoji{font-size:42px;margin-bottom:8px}' +
    '#pandu-welcome .pw-title{font-size:19px;font-weight:800;margin-bottom:8px;line-height:1.25}' +
    '#pandu-welcome .pw-body{font-size:14px;color:var(--text2,#c4b8e8);line-height:1.55;margin-bottom:20px}' +
    '#pandu-welcome .pw-btn{font-family:inherit;cursor:pointer;border:none;border-radius:11px;font-size:15px;font-weight:800;padding:13px 22px;width:100%;background:var(--accent,#6d28d9);color:#fff}' +
    '#pandu-welcome .pw-btn:hover{filter:brightness(1.08)}' +
    /* nudge tombol non-aktif */
    '@keyframes pandu-nudge{0%,100%{transform:translateX(0)}20%{transform:translateX(-4px)}60%{transform:translateX(4px)}}' +
    '.pandu-nudge{animation:pandu-nudge .32s ease}';
  var styleEl = D.createElement('style'); styleEl.id = 'pandu-style'; styleEl.textContent = css;

  // ── engine ──
  var spot, dim, card, active = false, steps = [], idx = 0, pollTimer = null, curTarget = null, built = false;
  function build() {
    if (built) return; built = true;
    D.head.appendChild(styleEl);
    dim = D.createElement('div'); dim.id = 'pandu-dim';
    spot = D.createElement('div'); spot.id = 'pandu-spot';
    card = D.createElement('div'); card.id = 'pandu-card';
    card.innerHTML =
      '<button id="pandu-x" aria-label="Tutup">\u00d7</button>' +
      '<div id="pandu-title"></div><div id="pandu-body"></div>' +
      '<div id="pandu-foot"><span id="pandu-count"></span>' +
      '<span class="pandu-btns"><button id="pandu-back">Kembali</button>' +
      '<span id="pandu-wait" style="display:none">menunggu\u2026</span>' +
      '<button id="pandu-next">Lanjut</button></span></div>';
    D.body.appendChild(dim); D.body.appendChild(spot); D.body.appendChild(card);
    $('#pandu-x', card).onclick = finish;
    $('#pandu-back', card).onclick = function () { go(idx - 1); };
    $('#pandu-next', card).onclick = function () {
      var s = steps[idx]; if (s && s.onNext) { s.onNext(); } else { go(idx + 1); }
    };
    W.addEventListener('resize', reposition);
    W.addEventListener('scroll', reposition, true);
    D.addEventListener('keydown', function (e) { if (active && e.key === 'Escape') finish(); });
  }

  function clearPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

  function go(i) {
    if (i < 0) i = 0;
    if (i >= steps.length) { finish(); return; }
    idx = i; var s = steps[i];
    clearPoll();
    var delay = 60;
    if (s.page) { gotoPage(s.page); delay = 480; }
    setTimeout(function () {
      if (s.tab) { var t = findTab(s.tab); if (t) { try { t.click(); } catch (e) {} } }
      setTimeout(function () { renderStep(s); }, s.tab ? 320 : 0);
    }, delay);
  }

  function renderStep(s) {
    active = true; curTarget = s.target || null;
    $('#pandu-title', card).textContent = s.title || '';
    $('#pandu-body', card).innerHTML = s.body || '';
    $('#pandu-count', card).textContent = (idx + 1) + ' / ' + steps.length;
    var back = $('#pandu-back', card), next = $('#pandu-next', card), wait = $('#pandu-wait', card);
    back.style.visibility = idx > 0 ? 'visible' : 'hidden';
    next.textContent = s.nextLabel || (idx === steps.length - 1 ? 'Selesai' : 'Lanjut');
    // langkah tunggu-aksi (tap switch PC / pilih saham)
    if (s.waitFor) {
      next.style.display = 'none'; wait.style.display = '';
      pollTimer = setInterval(function () { try { if (s.waitFor()) { clearPoll(); go(idx + 1); } } catch (e) {} }, 350);
    } else {
      next.style.display = ''; wait.style.display = 'none';
    }
    dim.classList.add('on'); card.classList.add('on');
    reposition();
  }

  function reposition() {
    if (!active) return;
    var el = curTarget ? curTarget() : null;
    if (el && vis(el)) {
      var r = el.getBoundingClientRect();
      if (r.top < 70 || r.bottom > innerHeight - 70) {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
        setTimeout(place, 320); return;
      }
      place();
    } else {
      spot.style.opacity = '0';
      var cw0 = card.offsetWidth || 320, ch0 = card.offsetHeight || 150;
      card.style.left = Math.max(16, (innerWidth - cw0) / 2) + 'px';
      card.style.top = Math.max(16, (innerHeight - ch0) / 2) + 'px';
    }
    function place() {
      var r = el.getBoundingClientRect(), pad = 8;
      spot.style.opacity = '1';
      spot.style.left = (r.left - pad) + 'px'; spot.style.top = (r.top - pad) + 'px';
      spot.style.width = (r.width + pad * 2) + 'px'; spot.style.height = (r.height + pad * 2) + 'px';
      var cw = card.offsetWidth || 320, ch = card.offsetHeight || 150;
      var left = Math.min(Math.max(16, r.left), innerWidth - cw - 16);
      var top;
      if (r.bottom + ch + 16 < innerHeight) top = r.bottom + 14;
      else if (r.top - ch - 16 > 0) top = r.top - ch - 14;
      else top = Math.max(16, (innerHeight - ch) / 2);
      card.style.left = left + 'px'; card.style.top = top + 'px';
    }
  }

  function start(arr) { build(); steps = arr || []; if (!steps.length) return; idx = 0; active = true; setDone(); go(0); }
  function finish() {
    active = false; clearPoll(); setDone();
    try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
    if (spot) spot.style.opacity = '0';
    if (dim) dim.classList.remove('on');
    if (card) card.classList.remove('on');
  }

  // ── definisi langkah: DASHBOARD (tur penuh) ──
  function buildDashSteps() {
    var s = [];
    if (isMobileDevice() && !isDesktopView()) {
      s.push({ target: S('#viewToggle'), waitFor: isDesktopView,
        title: 'Beralih ke tampilan PC', body: 'Panduan ini paling pas dilihat di mode PC. <b>Tap tombol ini</b> dulu ya \uD83D\uDC46' });
    }
    s.push({ target: S('#searchInput', '#searchInputMobile'),
      title: 'Pilih saham', body: 'Mulai dengan memilih <b>saham apa saja</b> di sini. Semua penjelasan berikutnya akan mengikuti saham yang kamu pilih.' });
    // Dashboard
    s.push({ page: 'dashboard', target: T('Statistik Deskriptif'),
      title: 'Statistik Deskriptif', body: 'Angka-angka kunci saham secara sekilas: rata-rata, sebaran harga, dan ringkasan lainnya.' });
    s.push({ page: 'dashboard', target: T('Rekomendasi Analis'),
      title: 'Rekomendasi Analis', body: 'Kumpulan rekomendasi sekuritas: tanggal, target harga, potensi return, dan tingkat risiko.' });
    s.push({ page: 'dashboard', target: T('Watchlist'),
      title: 'Watchlist IDX Terpilih', body: 'Saham-saham pilihan yang bisa diurutkan dari potensi tertinggi atau yang terbaru.' });
    // Consensus
    s.push({ page: 'consensus', tab: 'Overview', target: T('Market Sentiment'),
      title: 'Consensus \u2014 Overview', body: 'Peta besar pasar: sentimen, kondisi per sektor, dan saham yang paling banyak direkomendasikan analis.' });
    s.push({ page: 'consensus', tab: 'Per Firm', target: TAB('Per Firm'),
      title: 'Consensus \u2014 Per Firm', body: 'Rekam jejak & akurasi tiap sekuritas: komposisi rekomendasi dan performanya (berhenti dihitung saat target tercapai).' });
    // Valuasi
    s.push({ page: 'valuasi', target: S('#vlStockSearch'),
      title: 'Valuasi \u2014 Pilih Emiten', body: 'Pilih saham yang ingin dinilai kewajaran harganya di sini.' });
    s.push({ page: 'valuasi', tab: 'Ringkasan', target: T('imbal hasil'),
      title: 'Valuasi \u2014 Ringkasan', body: 'Inti valuasi: <b>potensi % keuntungan</b> dengan basis tahunan terakhir (2025), plus asumsi pertumbuhan harga, imbal hasil dividen, dan payout ratio.' });
    s.push({ page: 'valuasi', target: S('#page-valuasi .vl-table'),
      title: 'Proyeksi Harga', body: 'Perkiraan harga & potensi tiap tahun ke depan. Pada grafik, cubit/zoom untuk melihat tahun berikutnya.' });
    s.push({ page: 'valuasi', tab: 'Perbandingan', target: TAB('Perbandingan'),
      title: 'Valuasi \u2014 Perbandingan', body: 'Nilai wajar dari berbagai metode (PER/PBV/PSR dll) lengkap dengan status <b>Murah / Wajar / Mahal</b>.' });
    // Simulasi
    s.push({ page: 'menabung', target: T('Pengaturan Portofolio'),
      title: 'Simulasi Menabung', body: 'Simulasikan nabung saham: pilih saham, metode DCA/sekaligus (lump sum), dan tanggal mulai.' });
    s.push({ page: 'menabung', target: T('Hasil Simulasi'),
      title: 'Hasil Simulasi', body: 'Lihat hasilnya \u2014 dengan/tanpa dividen, serta dividen tunai atau diputar lagi (reinvest).' });
    // Pasar Live
    s.push({ page: 'pasar', target: S('.pl-title'),
      title: 'Pasar Live', body: 'Headline berita, insight, dan data makro terkini \u2014 semua dalam satu layar.' });
    // Penutup → billing
    s.push({ target: null, title: '\uD83C\uDF89 Selesai!',
      body: 'Kamu sudah keliling Economstock Terminal. Yuk lihat paket langganannya.',
      nextLabel: 'Lanjut ke Billing \u2192',
      onNext: function () { setDone(); try { sessionStorage.setItem(RESUME_KEY, '1'); } catch (e) {} location.href = '/billing?panduan=end'; } });
    return s;
  }

  // ── definisi langkah: BILLING (penutup) ──
  function buildBillSteps() {
    return [
      { target: S('.grid', '.plan'), title: 'Paket Langganan', body: 'Pilih durasi langganan yang paling pas untukmu di sini.' },
      { target: S('#guideBtn'), title: 'Ulangi Panduan', body: 'Mau mengulang panduan ini lagi? Buka dari tombol ini kapan saja.', nextLabel: 'Selesai' }
    ];
  }

  // ── welcome (wajib mulai) ──
  function showWelcome() {
    build();
    var ov = D.createElement('div'); ov.id = 'pandu-welcome';
    ov.innerHTML = '<div class="pw-box"><div class="pw-emoji">\uD83D\uDC4B</div>' +
      '<div class="pw-title">Selamat datang di Economstock Terminal!</div>' +
      '<div class="pw-body">Yuk kenalan sebentar dengan fitur-fiturnya (\u00b11 menit).</div>' +
      '<button class="pw-btn" id="pw-start">Mulai Panduan</button></div>';
    D.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    $('#pw-start', ov).onclick = function () { setDone(); ov.remove(); start(buildDashSteps()); };
  }

  // ── init dashboard ──
  function initDash() {
    var params = new URLSearchParams(location.search);
    if (params.get('panduan') === '1') { setTimeout(function () { start(buildDashSteps()); }, 800); return; }
    var done; try { done = localStorage.getItem(DONE_KEY); } catch (e) {}
    if (done) return;
    // Auto-start sekali: tunggu profil siap (dashboard = user aktif).
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var p = W.__ES_PROFILE;
      if (p && p.authenticated) { clearInterval(t); showWelcome(); }
      else if (tries > 25) { clearInterval(t); }
    }, 400);
  }

  // ── init billing ──
  function initBill() {
    build();
    var gb = D.getElementById('guideBtn');
    function nudge() { if (!gb) return; gb.classList.remove('pandu-nudge'); void gb.offsetWidth; gb.classList.add('pandu-nudge'); }
    var activeOk = false;
    fetch('/api/me', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (me) {
      activeOk = !!(me && (me.is_admin || (me.subscription && me.subscription.active)));
    }).catch(function () {});
    if (gb) {
      gb.addEventListener('click', function (e) {
        e.preventDefault();
        if (activeOk) location.href = '/dashboard?panduan=1';
        else nudge();
      });
    }
    var params = new URLSearchParams(location.search);
    var resume = false; try { resume = sessionStorage.getItem(RESUME_KEY) === '1'; } catch (e) {}
    if (params.get('panduan') === 'end' || resume) { setTimeout(function () { start(buildBillSteps()); }, 700); }
  }

  // expose (untuk debugging / tombol "?" di masa depan)
  W.Panduan = { start: function () { start(buildDashSteps()); }, finish: finish };

  if (IS_DASH) initDash(); else if (IS_BILL) initBill();
})();
