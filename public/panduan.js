/* ════════════════════════════════════════════════════════════════════════
 * panduan.js — Tur interaktif "Panduan Terminal" (tanpa library)
 *
 * • Dashboard (index.html): tur LENGKAP — tiap kartu/kolom + semua popup
 *   (detail rekomendasi, detail firm, info ⓘ, multiple/MoS, dll). Tiap halaman
 *   diawali kolom pencarian. Urutan: Dashboard → Consensus → Valuasi →
 *   Simulasi → Pasar Live → lanjut ke Billing.
 * • Billing (billing.html): 2 langkah penutup + atur tombol "Panduan Terminal"
 *   (AKTIF → buka tur; NON-AKTIF → tombol mati, hanya gerak sedikit/nudge).
 *
 * Auto-start SEKALI utk user baru (localStorage). Di HP, setelah sapaan muncul
 * pilihan tampilan HP / PC. Mesin tur: spotlight + kartu + Lanjut/Kembali/Tutup,
 * auto-scroll, tunggu-aksi, buka/tutup popup (pre/cleanup), pindah antar menu.
 * ════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var W = window, D = document;
  var DONE_KEY = 'es_pandu_done_v1';
  var RESUME_KEY = 'es_pandu_resume';

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
  function call(fn, arg) { try { if (typeof W[fn] === 'function') { arg === undefined ? W[fn]() : W[fn](arg); return true; } } catch (e) {} return false; }
  function clickFirst(sel) { var e = $(sel); if (e) { try { e.click(); return true; } catch (x) {} } return false; }
  function setDone() { try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {} }

  // Resolver: elemen pertama yang terlihat dari daftar selector.
  function S() { var a = arguments; return function () { for (var i = 0; i < a.length; i++) { var e = $(a[i]); if (e && vis(e)) return e; } return null; }; }
  // Cari kartu berdasarkan teks judul.
  function T(text) {
    var low = String(text).toLowerCase();
    var sels = ['.card-title', '.pl-win-title', '.vl-tb-label', '.cv-sec-title', 'h2', 'h3'];
    return function () {
      for (var s = 0; s < sels.length; s++) {
        var n = D.querySelectorAll(sels[s]);
        for (var i = 0; i < n.length; i++) {
          if ((n[i].textContent || '').toLowerCase().indexOf(low) >= 0 && vis(n[i]))
            return n[i].closest('.card, .pl-window, .vl-card, .cv-card, .vl-panel') || n[i];
        }
      }
      return null;
    };
  }
  function findTab(text) {
    var low = String(text).toLowerCase(), sels = ['.cv-tab', '.vl-tab', '.period-tab', '.wl-seg-btn'];
    for (var s = 0; s < sels.length; s++) { var n = D.querySelectorAll(sels[s]); for (var i = 0; i < n.length; i++) { if ((n[i].textContent || '').toLowerCase().indexOf(low) >= 0 && vis(n[i])) return n[i]; } }
    return null;
  }
  function TAB(text) { return function () { return findTab(text); }; }

  function gotoPage(name) {
    if (!isDesktopView()) { var b = D.getElementById('bn-' + name); if (b && vis(b)) { try { b.click(); return; } catch (e) {} } }
    var t = $('.nav-tab[onclick^="showPage(\'' + name + '\')"]');
    if (t && vis(t)) { try { t.click(); } catch (e) {} }
    else { call('showPage', name); }
    if (name === 'valuasi') call('vlEnsureCharts');
    if (name === 'pasar') call('plEnsure');
  }

  // ── style ──
  var Z = 2147480000;
  var css =
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
    '.pandu-btns{display:flex;gap:8px;align-items:center}' +
    '#pandu-card button{font-family:inherit;cursor:pointer;border-radius:9px;font-size:13px;font-weight:700;padding:9px 14px;border:1px solid var(--border,#4a3590);background:transparent;color:var(--text,#f4f2ff)}' +
    '#pandu-next{background:var(--accent,#6d28d9)!important;border-color:var(--accent,#6d28d9)!important;color:#fff!important}' +
    '#pandu-next:hover{filter:brightness(1.08)}' +
    '#pandu-x{position:absolute;top:7px;right:9px;background:none!important;border:none!important;color:var(--text2,#c4b8e8)!important;font-size:22px;line-height:1;padding:2px 6px!important}' +
    '#pandu-wait{font-size:11px;color:var(--accent,#c4a3ff);font-weight:700}' +
    '#pandu-welcome{position:fixed;inset:0;z-index:' + (Z + 5) + ';background:rgba(8,5,25,.66);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .25s}' +
    '#pandu-welcome.show{opacity:1}' +
    '#pandu-welcome .pw-box{background:var(--card,#1f1450);color:var(--text,#f4f2ff);border:1px solid var(--border,#4a3590);border-radius:18px;max-width:390px;width:100%;padding:30px 26px;text-align:center;box-shadow:0 16px 60px rgba(0,0,0,.5);font-family:"Plus Jakarta Sans",system-ui,sans-serif}' +
    '#pandu-welcome .pw-emoji{font-size:42px;margin-bottom:8px}' +
    '#pandu-welcome .pw-title{font-size:19px;font-weight:800;margin-bottom:8px;line-height:1.25}' +
    '#pandu-welcome .pw-body{font-size:14px;color:var(--text2,#c4b8e8);line-height:1.55;margin-bottom:20px}' +
    '#pandu-welcome .pw-btn{font-family:inherit;cursor:pointer;border:none;border-radius:11px;font-size:15px;font-weight:800;padding:13px 22px;width:100%;background:var(--accent,#6d28d9);color:#fff}' +
    '#pandu-welcome .pw-btn:hover{filter:brightness(1.08)}' +
    '#pandu-welcome .pw-row{display:flex;gap:10px}' +
    '#pandu-welcome .pw-row .pw-btn{flex:1}' +
    '#pandu-welcome .pw-btn.alt{background:transparent;color:var(--text,#f4f2ff);border:1px solid var(--border,#4a3590)}' +
    '@keyframes pandu-nudge{0%,100%{transform:translateX(0)}20%{transform:translateX(-4px)}60%{transform:translateX(4px)}}' +
    '.pandu-nudge{animation:pandu-nudge .32s ease}';
  var styleEl = D.createElement('style'); styleEl.id = 'pandu-style'; styleEl.textContent = css;

  // ── engine ──
  var spot, card, active = false, steps = [], idx = 0, pollTimer = null, curTarget = null, built = false, lastShown = -1, curPage = null;
  function build() {
    if (built) return; built = true;
    D.head.appendChild(styleEl);
    spot = D.createElement('div'); spot.id = 'pandu-spot';
    card = D.createElement('div'); card.id = 'pandu-card';
    card.innerHTML =
      '<button id="pandu-x" aria-label="Tutup">\u00d7</button>' +
      '<div id="pandu-title"></div><div id="pandu-body"></div>' +
      '<div id="pandu-foot"><span id="pandu-count"></span>' +
      '<span class="pandu-btns"><button id="pandu-back">Kembali</button>' +
      '<span id="pandu-wait" style="display:none">menunggu\u2026</span>' +
      '<button id="pandu-next">Lanjut</button></span></div>';
    D.body.appendChild(spot); D.body.appendChild(card);
    $('#pandu-x', card).onclick = finish;
    $('#pandu-back', card).onclick = function () { go(idx - 1); };
    $('#pandu-next', card).onclick = function () { var s = steps[idx]; if (s && s.onNext) s.onNext(); else go(idx + 1); };
    W.addEventListener('resize', reposition);
    W.addEventListener('scroll', reposition, true);
    D.addEventListener('keydown', function (e) { if (active && e.key === 'Escape') finish(); });
  }
  function clearPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function cleanupLast() { if (lastShown >= 0 && steps[lastShown] && steps[lastShown].cleanup) { try { steps[lastShown].cleanup(); } catch (e) {} } }

  function go(i) {
    cleanupLast();
    if (i < 0) i = 0;
    if (i >= steps.length) { finish(); return; }
    idx = i; var s = steps[i]; clearPoll();
    var d1 = 40;
    if (s.page && s.page !== curPage) { gotoPage(s.page); curPage = s.page; d1 = 540; }
    setTimeout(function () {
      if (s.tab) { var t = findTab(s.tab); if (t) { try { t.click(); } catch (e) {} } }
      setTimeout(function () {
        if (s.pre) { try { s.pre(); } catch (e) {} }
        setTimeout(function () { renderStep(s); }, s.pre ? 400 : 0);
      }, s.tab ? 320 : 0);
    }, d1);
  }

  function renderStep(s) {
    active = true; curTarget = s.target || null; lastShown = idx;
    $('#pandu-title', card).textContent = s.title || '';
    $('#pandu-body', card).innerHTML = s.body || '';
    $('#pandu-count', card).textContent = (idx + 1) + ' / ' + steps.length;
    var back = $('#pandu-back', card), next = $('#pandu-next', card), wait = $('#pandu-wait', card);
    back.style.visibility = idx > 0 ? 'visible' : 'hidden';
    next.textContent = s.nextLabel || (idx === steps.length - 1 ? 'Selesai' : 'Lanjut');
    if (s.waitFor) {
      next.style.display = 'none'; wait.style.display = '';
      pollTimer = setInterval(function () { try { if (s.waitFor()) { clearPoll(); go(idx + 1); } } catch (e) {} }, 350);
    } else { next.style.display = ''; wait.style.display = 'none'; }
    card.classList.add('on');
    reposition();
  }

  function reposition() {
    if (!active) return;
    var el = curTarget ? curTarget() : null;
    if (el && vis(el)) {
      var r = el.getBoundingClientRect();
      if (r.top < 70 || r.bottom > innerHeight - 70) {
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
        setTimeout(place, 330); return;
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
      var left = Math.min(Math.max(16, r.left), innerWidth - cw - 16), top;
      if (r.bottom + ch + 16 < innerHeight) top = r.bottom + 14;
      else if (r.top - ch - 16 > 0) top = r.top - ch - 14;
      else top = Math.max(16, (innerHeight - ch) / 2);
      card.style.left = left + 'px'; card.style.top = top + 'px';
    }
  }

  function start(arr) { build(); steps = arr || []; if (!steps.length) return; idx = 0; lastShown = -1; curPage = null; active = true; setDone(); go(0); }
  function finish() {
    cleanupLast(); active = false; clearPoll(); setDone();
    try { sessionStorage.removeItem(RESUME_KEY); } catch (e) {}
    if (spot) spot.style.opacity = '0';
    if (card) card.classList.remove('on');
  }

  // ── popup helpers (pre/cleanup) ──
  function pInfo(trigSel) { return { pre: function () { clickFirst(trigSel); }, target: S('#infoModalOverlay .info-modal', '#infoModalOverlay>div', '#infoModalOverlay'), cleanup: function () { call('closeInfoModal'); } }; }
  function pMethod(key) { return { pre: function () { call('vlMethodInfo', key); }, target: S('#vlMethodModal .vl-method-card', '#vlMethodModal>div', '#vlMethodModal'), cleanup: function () { call('vlCloseMethod'); } }; }

  // ── DASHBOARD: tur lengkap ──
  function buildSteps() {
    var s = [];
    function P(o) { s.push(o); }

    // DASHBOARD (diawali kolom pencarian)
    P({ page: 'dashboard', target: S('#searchInput', '#searchInputMobile'), title: 'Pilih Saham', body: 'Mulai dari kolom pencarian ini \u2014 ketik kode saham (mis. BBRI). Seluruh data di Terminal akan mengikuti saham yang kamu pilih.' });
    P({ page: 'dashboard', target: S('#stockTicker'), title: 'Harga Berjalan', body: 'Pita harga saham yang bergerak; klik salah satu untuk langsung membukanya.' });
    P({ page: 'dashboard', target: T('Statistik Deskriptif'), title: 'Statistik Deskriptif', body: 'Ringkasan angka kunci: rata-rata return, volatilitas, dan sebaran harga.' });
    P({ page: 'dashboard', target: S('.card-chart'), title: 'Grafik Harga', body: 'Grafik harga (bulanan/harian) lengkap dengan garis tren linier.' });
    P(merge({ page: 'dashboard', title: 'Cara Baca Tren Linier', body: 'Tombol \u24D8 ini menjelaskan zona akumulasi (di bawah tren) & distribusi (di atas tren).' }, pInfo('[onclick*="Cara Baca Tren"]')));
    P({ page: 'dashboard', target: S('.period-tabs'), title: 'Rentang Waktu', body: 'Ganti rentang grafik: 1B / 3B / 1T / ALL.' });
    P({ page: 'dashboard', target: T('Rekomendasi Analis'), title: 'Rekomendasi Analis', body: 'Daftar rekomendasi sekuritas untuk saham ini: tanggal, target, return, risiko.' });
    P(merge({ page: 'dashboard', title: 'Detail Rekomendasi (popup)', body: 'Klik salah satu baris \u2192 muncul popup detail rekomendasi seperti ini. Lengkap dengan target & analisisnya.' },
      { pre: function () { clickFirst('#page-dashboard [onclick^="showRecDetail"]'); }, target: S('#recDetailModal .rec-modal', '#recDetailModal>div', '#recDetailModal'), cleanup: function () { call('closeRecDetail'); } }));
    P({ page: 'dashboard', target: T('Price Target Blueprint'), title: 'Price Target Blueprint', body: 'Blueprint target harga ala Economstock \u2014 area beli & jual secara profesional.' });
    P({ page: 'dashboard', target: T('Consensus Analyst'), title: 'Konsensus Analis', body: 'Ringkasan konsensus (Beli/Tahan/Jual) para analis untuk saham ini.' });
    P({ page: 'dashboard', target: T('Watchlist'), title: 'Watchlist IDX Terpilih', body: 'Saham-saham pilihan; bisa diurutkan dari potensi tertinggi atau yang terbaru.' });

    // CONSENSUS (diawali kolom pencarian)
    P({ page: 'consensus', tab: 'Overview', target: S('#consensusSearch'), title: 'Consensus \u2014 Cari Saham', body: 'Mulai dari kolom pencarian ini untuk memfilter saham pada konsensus.' });
    P({ page: 'consensus', tab: 'Overview', target: T('Market Sentiment'), title: 'Market Sentiment', body: 'Suasana pasar keseluruhan berdasarkan rekomendasi analis.' });
    P({ page: 'consensus', target: T('Upside Tertinggi'), title: 'Upside Tertinggi', body: 'Saham dengan potensi kenaikan tertinggi versi analis.' });
    P({ page: 'consensus', target: T('Aktivitas Rekomendasi'), title: 'Aktivitas Rekomendasi', body: 'Seberapa ramai rekomendasi keluar dari waktu ke waktu.' });
    P({ page: 'consensus', target: T('Sektor'), title: 'Sektor \u00b7 Komposisi', body: 'Komposisi BUY/NEUTRAL/SELL per sektor.' });
    P({ page: 'consensus', target: T('Top 10 Firm Aktif'), title: 'Top 10 Firm Aktif', body: 'Sekuritas yang paling aktif mengeluarkan rekomendasi.' });
    P({ page: 'consensus', target: T('Saham Paling Direkomendasikan'), title: 'Paling Direkomendasikan', body: 'Saham dengan jumlah rekomendasi BUY terbanyak.' });
    P({ page: 'consensus', target: T('Konsensus Terbaru'), title: 'Konsensus Terbaru', body: 'Rekomendasi analis paling baru yang masuk.' });
    P({ page: 'consensus', tab: 'Per Saham', target: TAB('Per Saham'), title: 'Tab Per Saham', body: 'Lihat konsensus untuk satu saham spesifik di tab ini.' });
    P({ page: 'consensus', tab: 'Per Firm', target: S('#firmSearch'), title: 'Per Firm \u2014 Cari Sekuritas', body: 'Cari sekuritas/firm di kolom pencarian ini.' });
    P({ page: 'consensus', target: T('Daftar Rekomendasi'), title: 'Daftar Rekomendasi', body: 'Semua rekomendasi dari firm terpilih.' });
    P({ page: 'consensus', target: T('Avg Performance'), title: 'Performa Rata-rata', body: 'Rata-rata performa rekomendasi aktif firm (berhenti dihitung saat target tercapai).' });
    P(merge({ page: 'consensus', title: 'Detail Firm (popup)', body: 'Klik salah satu firm \u2192 muncul panel detail: komposisi rekomendasi & grafik performanya.' },
      { pre: function () { clickFirst('#page-consensus [onclick^="showFirmDetail"]'); }, target: S('#firmDetailPanel'), cleanup: function () { call('closeFirmDetail'); } }));

    // VALUASI (diawali kolom pencarian)
    P({ page: 'valuasi', target: S('#vlStockSearch'), title: 'Valuasi \u2014 Pilih Emiten', body: 'Mulai dari kolom pencarian ini untuk memilih emiten yang ingin dinilai.' });
    P({ page: 'valuasi', tab: 'Ringkasan', target: T('Window Rata-rata'), title: 'Window Rata-rata Multiple', body: 'Atur jumlah tahun yang dipakai merata-rata multiple (PER/PBV/PSR).' });
    P(merge({ page: 'valuasi', title: 'Penjelasan Window (popup)', body: 'Tombol \u24D8 menjelaskan arti window rata-rata multiple dengan bahasa awam.' }, pMethod('window')));
    P({ page: 'valuasi', tab: 'Ringkasan', target: T('Proyeksi Harga'), title: 'Proyeksi Harga 5 Tahun', body: 'Inti valuasi: potensi % keuntungan dengan basis tahunan terakhir (2025).' });
    P(merge({ page: 'valuasi', title: 'Penjelasan Proyeksi (popup)', body: 'Tombol \u24D8 menerangkan cara grafik proyeksi dihitung.' }, pMethod('chartproj')));
    P({ page: 'valuasi', target: T('Harga Saham'), title: 'Grafik Harga (Valuasi)', body: 'Grafik harga bulanan/harian saham yang dinilai.' });
    P(merge({ page: 'valuasi', title: 'Penjelasan Grafik (popup)', body: 'Tombol \u24D8 menjelaskan grafik harga di halaman valuasi.' }, pMethod('chartharian')));
    P({ page: 'valuasi', target: T('Tabel Proyeksi'), title: 'Tabel Proyeksi G&L', body: 'Perkiraan harga & potensi keuntungan tiap tahun ke depan.' });
    P(merge({ page: 'valuasi', title: 'Penjelasan Tabel (popup)', body: 'Tombol \u24D8 menerangkan isi tabel proyeksi.' }, pMethod('projgl')));
    P(merge({ page: 'valuasi', title: 'Detail MoS & Multiple (popup)', body: 'Tombol ini membuka rincian Margin of Safety & multiple valuasi.' },
      { pre: function () { call('vlOpenMultModal'); }, target: S('#vlMultModal .vl-mult-card', '#vlMultModal>div', '#vlMultModal'), cleanup: function () { call('vlCloseMultModal'); } }));
    P({ page: 'valuasi', tab: 'Fundamental', target: T('Data Fundamental'), title: 'Data Fundamental Tahunan', body: 'Data fundamental per tahun + TTM (12 bulan terakhir).' });
    P(merge({ page: 'valuasi', title: 'Arti TTM (popup)', body: 'Tombol \u24D8 menjelaskan apa itu TTM (Trailing Twelve Months).' }, pMethod('ttm')));
    P({ page: 'valuasi', tab: 'Dividen', target: T('Dividen per Saham'), title: 'Dividen per Saham', body: 'Riwayat & proyeksi dividen per lembar saham.' });
    P({ page: 'valuasi', target: T('Kalkulator Yield'), title: 'Kalkulator Yield Dividen', body: 'Hitung imbal hasil dividen dari harga beli tertentu.' });
    P({ page: 'valuasi', target: T('Gaji dari Dividen'), title: 'Gaji dari Dividen', body: 'Simulasi "gaji bulanan" dari dividen sesuai jumlah lot.' });
    P({ page: 'valuasi', tab: 'Perbandingan', target: T('Perbandingan Metode'), title: 'Perbandingan Metode Valuasi', body: 'Nilai wajar dari banyak metode (PER/PBV/PSR dll) + status Murah/Wajar/Mahal.' });
    P(merge({ page: 'valuasi', title: 'Penjelasan Metode (popup)', body: 'Tombol \u24D8 di tiap metode menjelaskan cara & asumsinya.' }, pMethod('wacc')));

    // SIMULASI (diawali kolom pencarian)
    P({ page: 'menabung', target: S('#savingStockSearch'), title: 'Simulasi \u2014 Pilih Saham', body: 'Mulai dari kolom pencarian ini untuk memilih saham yang disimulasikan.' });
    P({ page: 'menabung', target: T('Pengaturan Portofolio'), title: 'Pengaturan Portofolio', body: 'Atur metode nabung (DCA/sekaligus), tanggal mulai, dan batas beli/jual.' });
    P(merge({ page: 'menabung', title: 'Panduan Batas Beli & Jual (popup)', body: 'Tombol \u24D8 menjelaskan cara menentukan batas beli & jual dari YoY Analysis.' }, pInfo('[onclick*="Panduan Batas Beli"]')));
    P({ page: 'menabung', target: T('Ringkasan'), title: 'Ringkasan Portofolio', body: 'Ringkasan modal, unit, dan nilai investasi simulasimu.' });
    P({ page: 'menabung', target: T('Hasil Simulasi'), title: 'Hasil Simulasi', body: 'Hasil akhir \u2014 dengan/tanpa dividen, tunai atau diputar lagi (reinvest).' });
    P({ page: 'menabung', target: T('Detail Per Periode'), title: 'Detail Per Periode', body: 'Rincian tiap pembelian: tanggal, harga, unit, modal, dan nilai.' });

    // PASAR LIVE (diawali kolom pencarian)
    P({ page: 'pasar', target: S('#plNewsQ', '.pl-news-search'), title: 'Pasar Live \u2014 Cari Berita', body: 'Cari berita atau kode saham di kolom pencarian ini.' });
    P({ page: 'pasar', target: T('Market Chart'), title: 'Market Chart', body: 'Grafik indeks & pasar secara live.' });
    P({ page: 'pasar', target: T('Heatmap Sektor'), title: 'Heatmap Sektor', body: 'Peta panas performa tiap sektor hari ini.' });
    P({ page: 'pasar', target: T('Seasonality'), title: 'Seasonality', body: 'Pola musiman pasar/indeks dari data historis.' });
    P({ page: 'pasar', target: T('Headlines'), title: 'Headlines', body: 'Kumpulan headline berita pasar terkini dari berbagai sumber.' });

    // PENUTUP → BILLING
    P({ target: null, title: '\uD83C\uDF89 Selesai!', body: 'Itu dia keliling lengkap Economstock Terminal. Yuk lihat paket langganannya.',
      nextLabel: 'Lanjut ke Billing \u2192', onNext: function () { setDone(); try { sessionStorage.setItem(RESUME_KEY, '1'); } catch (e) {} location.href = '/billing?panduan=end'; } });
    return s;
  }
  function merge(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }

  // ── BILLING: penutup ──
  function buildBillSteps() {
    return [
      { target: S('.grid', '.plan'), title: 'Paket Langganan', body: 'Pilih durasi langganan yang paling pas untukmu di sini.' },
      { target: S('#guideBtn'), title: 'Ulangi Panduan', body: 'Mau mengulang panduan ini lagi? Buka dari tombol ini kapan saja.', nextLabel: 'Selesai' }
    ];
  }

  // ── peluncuran (welcome + pilihan HP/PC) ──
  function launch() { build(); if (isMobileDevice()) showChoice(); else start(buildSteps()); }
  function showWelcome() {
    build();
    var ov = D.createElement('div'); ov.id = 'pandu-welcome';
    ov.innerHTML = '<div class="pw-box"><div class="pw-emoji">\uD83D\uDC4B</div>' +
      '<div class="pw-title">Selamat datang di Economstock Terminal!</div>' +
      '<div class="pw-body">Yuk kenalan dengan fitur-fiturnya. Panduan singkat per kolom & popup.</div>' +
      '<button class="pw-btn" id="pw-start">Mulai Panduan</button></div>';
    D.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    $('#pw-start', ov).onclick = function () { setDone(); ov.remove(); if (isMobileDevice()) showChoice(); else start(buildSteps()); };
  }
  function showChoice() {
    var ov = D.createElement('div'); ov.id = 'pandu-welcome';
    ov.innerHTML = '<div class="pw-box"><div class="pw-emoji">\uD83D\uDCF1\uD83D\uDCBB</div>' +
      '<div class="pw-title">Pilih tampilan panduan</div>' +
      '<div class="pw-body">Panduan lebih lengkap & nyaman di tampilan PC. Pilih sesuai seleramu.</div>' +
      '<div class="pw-row"><button class="pw-btn alt" id="pw-hp">Tampilan HP</button><button class="pw-btn" id="pw-pc">Tampilan PC</button></div></div>';
    D.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    $('#pw-hp', ov).onclick = function () { ov.remove(); call('applyViewMode', 'mobile'); setTimeout(function () { start(buildSteps()); }, 250); };
    $('#pw-pc', ov).onclick = function () { ov.remove(); call('applyViewMode', 'desktop'); setTimeout(function () { start(buildSteps()); }, 450); };
  }

  // ── init dashboard ──
  function initDash() {
    var params = new URLSearchParams(location.search);
    if (params.get('panduan') === '1') { setTimeout(launch, 700); return; }
    var done; try { done = localStorage.getItem(DONE_KEY); } catch (e) {}
    if (done) return;
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
    var gb = D.getElementById('guideBtn'), activeOk = false;
    function nudge() { if (!gb) return; gb.classList.remove('pandu-nudge'); void gb.offsetWidth; gb.classList.add('pandu-nudge'); }
    fetch('/api/me', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (me) {
      activeOk = !!(me && (me.is_admin || (me.subscription && me.subscription.active)));
    }).catch(function () {});
    if (gb) gb.addEventListener('click', function (e) { e.preventDefault(); if (activeOk) location.href = '/dashboard?panduan=1'; else nudge(); });
    var params = new URLSearchParams(location.search), resume = false;
    try { resume = sessionStorage.getItem(RESUME_KEY) === '1'; } catch (e) {}
    if (params.get('panduan') === 'end' || resume) setTimeout(function () { start(buildBillSteps()); }, 700);
  }

  W.Panduan = { start: launch, finish: finish };
  if (IS_DASH) initDash(); else if (IS_BILL) initBill();
})();
