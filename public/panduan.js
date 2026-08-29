/* ════════════════════════════════════════════════════════════════════════
 * panduan.js — Tur interaktif "Panduan Terminal" (tanpa library)
 *
 * VERSI 2 (2026-07-26): Interaktif dengan wajib-aksi + scope-aware routing.
 *
 * • Dashboard (index.html): tur menyesuaikan scope langganan user
 *   - scope='full' / admin: TUR LENGKAP — Dashboard → Consensus → Valuasi
 *     → Tracker (dgn deep-dive firm profile) → Pasar Live → Billing
 *   - scope='tracker':  TUR TRACKER-ONLY — langsung ke menu Tracker,
 *     karena menu lain di-scope-blok. Tetap ditutup ke Billing.
 * • Billing (billing.html): 2 langkah penutup + atur tombol "Panduan Terminal".
 *   Tombol AKTIF (sudah langganan) → buka tur; NON-AKTIF (belum) → tombol
 *   TIDAK bisa di-click, muncul popup "Silahkan pilih paket dulu".
 *
 * INTERAKTIF (feel):
 *   Step yg punya kolom input / tombol popup akan menunggu USER benar-benar
 *   mengetik atau meng-klik sebelum bisa lanjut. Bukan cuma next-next tanpa
 *   nyentuh apapun. Mekanismenya lewat s.waitFor() polling: kalau kondisi
 *   terpenuhi (mis. input punya value >= 2 char, atau popup visible), tur
 *   auto-advance ke step berikutnya. Tombol "Lanjut" disembunyikan, diganti
 *   badge "menunggu…" supaya user paham perlu aksi.
 *
 * TRIGGER (initDash):
 *   1. Skip kalau localStorage DONE_KEY di-set atau server-side guide_seen=true.
 *   2. TUNGGU user login (__ES_PROFILE.authenticated=true).
 *   3. TUNGGU consent gate disetujui (__ES_PROFILE.tos_accepted=true).
 *   4. TUNGGU popup PWA (__ES_PWA_PENDING === true kalau lagi tampil).
 *   5. TUNGGU __ES_SCOPE di-set oleh _ensureAccess (bisa 'full' / 'tracker').
 *   6. showWelcome() → user klik Mulai → start(build func sesuai scope).
 *
 * Mesin tur: spotlight + kartu + Lanjut/Kembali/Tutup, auto-scroll,
 * tunggu-aksi, buka/tutup popup (pre/cleanup), pindah antar menu.
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
  function setDone() {
    try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {}
    try { fetch('/api/guide-seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch (e) {}
  }

  // Resolver: elemen pertama yang terlihat dari daftar selector.
  function S() { var a = arguments; return function () { for (var i = 0; i < a.length; i++) { var e = $(a[i]); if (e && vis(e)) return e; } return null; }; }
  // Cari kartu berdasarkan teks judul.
  function T(text) {
    var low = String(text).toLowerCase();
    var sels = ['.card-title', '.pl-win-title', '.vl-tb-label', '.cv-sec-title', 'h2', 'h3', '.tr-card-title'];
    return function () {
      for (var s = 0; s < sels.length; s++) {
        var n = D.querySelectorAll(sels[s]);
        for (var i = 0; i < n.length; i++) {
          if ((n[i].textContent || '').toLowerCase().indexOf(low) >= 0 && vis(n[i]))
            return n[i].closest('.card, .pl-window, .vl-card, .cv-card, .vl-panel, .tr-card') || n[i];
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

  // ── waitFor helpers ── interaksi wajib sebelum lanjut.
  //
  // Return function yg dipanggil poller: return true → advance.
  // Digunakan di steps yg punya input / popup / klik penting.
  //
  //   inputHas(sel, minLen): input sel punya minimal minLen char
  //   visibleOnce(sel):      elemen sel visible (biasanya popup)
  //   classIn(sel, cls):     elemen sel punya class cls (mis. active)
  function inputHas(sel, minLen) {
    minLen = minLen || 2;
    return function () {
      var e = $(sel);
      if (!e) return false;
      var v = (e.value || '').trim();
      return v.length >= minLen;
    };
  }
  function visibleOnce(sel) {
    return function () {
      var e = $(sel);
      return !!(e && vis(e));
    };
  }
  function classIn(sel, cls) {
    return function () {
      var e = $(sel);
      return !!(e && e.classList && e.classList.contains(cls));
    };
  }
  // Wait for elem to exist (with visibility) — for popup / dynamic content.
  function existsVis(sel) { return visibleOnce(sel); }

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
    '#pandu-body .pandu-hint{display:block;margin-top:8px;padding:6px 10px;background:rgba(124,92,255,.14);border-left:3px solid var(--accent,#6d28d9);border-radius:6px;font-size:12px;color:var(--text,#f4f2ff);font-weight:600}' +
    '#pandu-foot{display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:10px}' +
    '#pandu-count{font-size:11px;color:var(--text3,#8b7eb8);font-weight:600}' +
    '.pandu-btns{display:flex;gap:8px;align-items:center}' +
    '#pandu-card button{font-family:inherit;cursor:pointer;border-radius:9px;font-size:13px;font-weight:700;padding:9px 14px;border:1px solid var(--border,#4a3590);background:transparent;color:var(--text,#f4f2ff)}' +
    '#pandu-next{background:var(--accent,#6d28d9)!important;border-color:var(--accent,#6d28d9)!important;color:#fff!important}' +
    '#pandu-next:hover{filter:brightness(1.08)}' +
    '#pandu-next[disabled]{opacity:.4;cursor:not-allowed}' +
    '#pandu-x{position:absolute;top:7px;right:9px;background:none!important;border:none!important;color:var(--text2,#c4b8e8)!important;font-size:22px;line-height:1;padding:2px 6px!important}' +
    '#pandu-wait{font-size:11px;color:var(--accent,#c4a3ff);font-weight:700;display:inline-flex;align-items:center;gap:4px}' +
    '#pandu-wait::before{content:"";width:6px;height:6px;background:var(--accent,#c4a3ff);border-radius:50%;animation:pandu-wait-dot 1.2s ease-in-out infinite}' +
    '@keyframes pandu-wait-dot{0%,100%{opacity:1}50%{opacity:.3}}' +
    '#pandu-card.pandu-bottom{left:8px!important;right:8px!important;top:auto!important;bottom:10px;width:auto!important;max-width:none;max-height:44vh;overflow:auto;padding:13px 14px 11px}' +
    '#pandu-card.pandu-bottom #pandu-title{font-size:14px}' +
    '#pandu-card.pandu-bottom #pandu-body{font-size:12.5px}' +
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
    '#pandu-locked{position:fixed;inset:0;z-index:' + (Z + 5) + ';background:rgba(8,5,25,.72);display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;transition:opacity .25s;font-family:"Plus Jakarta Sans",system-ui,sans-serif}' +
    '#pandu-locked.show{opacity:1}' +
    '#pandu-locked .pl-box{background:var(--card,#1f1450);color:var(--text,#f4f2ff);border:1px solid var(--border,#4a3590);border-radius:16px;max-width:400px;width:100%;padding:26px 24px;text-align:center;box-shadow:0 16px 60px rgba(0,0,0,.5)}' +
    '#pandu-locked .pl-emoji{font-size:38px;margin-bottom:8px}' +
    '#pandu-locked .pl-title{font-size:17px;font-weight:800;margin-bottom:8px;line-height:1.25}' +
    '#pandu-locked .pl-body{font-size:13.5px;color:var(--text2,#c4b8e8);line-height:1.55;margin-bottom:18px}' +
    '#pandu-locked .pl-row{display:flex;gap:10px}' +
    '#pandu-locked .pl-btn{flex:1;font-family:inherit;cursor:pointer;border:none;border-radius:10px;font-size:14px;font-weight:800;padding:11px 16px;background:var(--accent,#6d28d9);color:#fff}' +
    '#pandu-locked .pl-btn.alt{background:transparent;color:var(--text,#f4f2ff);border:1px solid var(--border,#4a3590)}' +
    '#pandu-locked .pl-btn:hover{filter:brightness(1.08)}' +
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
      '<span id="pandu-wait" style="display:none">menunggu aksi\u2026</span>' +
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
      // Interaktif: sembunyikan tombol Lanjut awalnya, tampilkan indikator
      // menunggu. Poller cek kondisi tiap 300ms; kalau terpenuhi → auto-
      // advance. FALLBACK: setelah 20 detik, tampilkan tombol Lanjut lagi
      // (dgn label "Skip") supaya user tidak stuck kalau selector target
      // beda / condition never met.
      next.style.display = 'none'; wait.style.display = '';
      var waitStart = Date.now();
      pollTimer = setInterval(function () {
        try { if (s.waitFor()) { clearPoll(); go(idx + 1); return; } } catch (e) {}
        // Fallback escape hatch: 20 detik → tampilkan Skip button.
        if (Date.now() - waitStart > 20000 && next.style.display === 'none') {
          next.textContent = 'Lewati \u2192';
          next.style.display = '';
          wait.textContent = 'atau lewati';
        }
      }, 300);
    } else {
      next.style.display = ''; wait.style.display = 'none';
    }
    card.classList.add('on');
    reposition();
  }

  function reposition() {
    if (!active) return;
    var phone = isMobileDevice() && !isDesktopView();
    card.classList.toggle('pandu-bottom', !!phone);
    var el = curTarget ? curTarget() : null;
    if (!(el && vis(el))) {
      spot.style.opacity = '0';
      if (!phone) {
        var cw0 = card.offsetWidth || 320, ch0 = card.offsetHeight || 150;
        card.style.left = Math.max(16, (innerWidth - cw0) / 2) + 'px';
        card.style.top = Math.max(16, (innerHeight - ch0) / 2) + 'px';
      }
      return;
    }
    var r = el.getBoundingClientRect();
    var off = phone ? (r.top < 64 || r.top > innerHeight * 0.5) : (r.top < 70 || r.bottom > innerHeight - 70);
    if (off) {
      if (phone) { try { window.scrollBy({ top: r.top - 64, behavior: 'smooth' }); } catch (e) { window.scrollBy(0, r.top - 64); } }
      else { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} } }
      setTimeout(place, 340); return;
    }
    place();
    function place() {
      var rr = el.getBoundingClientRect(), pad = 8;
      spot.style.opacity = '1';
      spot.style.left = (rr.left - pad) + 'px'; spot.style.top = (rr.top - pad) + 'px';
      spot.style.width = (rr.width + pad * 2) + 'px'; spot.style.height = (rr.height + pad * 2) + 'px';
      if (phone) return;
      var cw = card.offsetWidth || 320, ch = card.offsetHeight || 150;
      var left = Math.min(Math.max(16, rr.left), innerWidth - cw - 16), top;
      if (rr.bottom + ch + 16 < innerHeight) top = rr.bottom + 14;
      else if (rr.top - ch - 16 > 0) top = rr.top - ch - 14;
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
  function merge(a, b) { for (var k in b) if (b.hasOwnProperty(k)) a[k] = b[k]; return a; }

  // Hint chip untuk indikasi aksi wajib di body text.
  function hint(text) { return '<span class="pandu-hint">\uD83D\uDC49 ' + text + '</span>'; }

  // ═══════════════════════════════════════════════════════════════════════
  // TUR LENGKAP — untuk user scope='full' / admin.
  // ═══════════════════════════════════════════════════════════════════════
  function buildSteps() {
    var s = [];
    function P(o) { s.push(o); }

    // ─── DASHBOARD (aksi wajib: ketik kode saham dulu) ───
    P({
      page: 'dashboard',
      target: S('#searchInput', '#searchInputMobile'),
      title: 'Pilih Saham',
      body: 'Mulai dari kolom pencarian ini. Data Terminal akan mengikuti saham yang kamu pilih.' + hint('Coba ketik BBRI atau BBCA di kolom pencarian.'),
      waitFor: function () {
        var e = $('#searchInput') || $('#searchInputMobile');
        return !!(e && (e.value || '').trim().length >= 3);
      }
    });
    P({ page: 'dashboard', target: S('#stockTicker'), title: 'Harga Berjalan', body: 'Pita harga saham yang bergerak. Klik salah satu untuk langsung membukanya.' });
    P({ page: 'dashboard', target: T('Statistik Deskriptif'), title: 'Statistik Deskriptif', body: 'Ringkasan angka kunci: rata-rata return, volatilitas, dan sebaran harga.' });

    // ─── Simulasi Menabung (modal — WAJIB klik tombolnya) ───
    P({
      page: 'dashboard',
      target: S('.btn-sim-open'),
      title: 'Simulasi Menabung',
      body: 'Tombol ini membuka jendela Simulasi Menabung: DCA / Lump Sum untuk Saham & Emas Antam.' + hint('Klik tombol Simulasi Investasi untuk membukanya.'),
      waitFor: visibleOnce('#simModal:not([hidden]), .sim-modal:not([hidden])')
    });
    P({ page: 'dashboard', target: T('Pengaturan Portofolio'), title: 'Pengaturan Portofolio', body: 'Pilih jenis investasi (Saham/Emas), sistem menabung (DCA/Lump), nominal, dan tanggal mulai.' });
    P({
      page: 'dashboard',
      target: S('#savingStockSearch'),
      title: 'Cari Saham untuk Simulasi',
      body: 'Ketik kode saham (mis. BBCA) untuk memilih saham yang mau disimulasikan.' + hint('Ketik minimal 3 huruf di kolom pencarian saham.'),
      waitFor: inputHas('#savingStockSearch', 3)
    });
    P({ page: 'dashboard', target: T('Ringkasan'), title: 'Ringkasan Simulasi', body: 'Total modal, unit terkumpul, dividen (kalau ada), dan nilai investasi hasil simulasi.' });
    P({ page: 'dashboard', target: T('Hasil Simulasi'), title: 'Hasil Simulasi', body: 'Grafik pertumbuhan investasi. Untuk saham: pilih dgn / tanpa dividen, dan tunai vs reinvest.' });
    P(merge({ page: 'dashboard', title: 'Detail Per Periode', body: 'Rincian tiap pembelian: tanggal, harga, unit, modal, dan nilai. Selesai — kita tutup modalnya.' },
      { target: T('Detail Per Periode'), cleanup: function () { call('closeSimModal'); } }));

    // ─── Konten Dashboard utama ───
    P({ page: 'dashboard', target: S('.card-chart'), title: 'Grafik Harga', body: 'Grafik harga (bulanan/harian) lengkap dengan garis tren linier + zona BELI/JUAL dari Price Target Blueprint.' });
    P(merge({
      page: 'dashboard',
      title: 'Cara Baca Tren Linier',
      body: 'Tombol \u24D8 menjelaskan zona akumulasi (di bawah tren) & distribusi (di atas tren).' + hint('Klik tombol \u24D8 untuk buka popup penjelasan.'),
      waitFor: existsVis('#infoModalOverlay:not([hidden]) .info-modal, #infoModalOverlay:not([hidden])')
    }, pInfo('[onclick*="Cara Baca Tren"]')));
    P({ page: 'dashboard', target: S('.period-tabs'), title: 'Rentang Waktu', body: 'Ganti rentang grafik: 1T / 3T / 5T / ALL.' });
    P({ page: 'dashboard', target: T('Rekomendasi Analis'), title: 'Rekomendasi Analis', body: 'Daftar rekomendasi sekuritas untuk saham ini: tanggal, target, return, risiko. Klik baris untuk detail chart.' });
    P(merge({
      page: 'dashboard',
      title: 'Detail Rekomendasi (popup)',
      body: 'Klik salah satu baris \u2192 muncul popup detail rekomendasi lengkap dgn target, analisis, dan grafik.' + hint('Popup akan terbuka otomatis.'),
      waitFor: existsVis('#recDetailModal:not([hidden]) .rec-modal, #recDetailModal:not([hidden])')
    }, { pre: function () { clickFirst('#page-dashboard [onclick^="showRecDetail"]'); }, target: S('#recDetailModal .rec-modal', '#recDetailModal>div', '#recDetailModal'), cleanup: function () { call('closeRecDetail'); } }));
    P({ page: 'dashboard', target: T('Price Target Blueprint'), title: 'Price Target Blueprint', body: 'Blueprint target harga ala Economstock \u2014 area beli & jual profesional. Ada dropdown Tgl Rujukan untuk lihat batas beli/jual di titik waktu berbeda.' });
    P({ page: 'dashboard', target: T('Consensus Analyst'), title: 'Konsensus Analis', body: 'Ringkasan konsensus (Beli/Tahan/Jual) para analis untuk saham ini.' });
    P({ page: 'dashboard', target: T('Watchlist'), title: 'Watchlist IDX Terpilih', body: 'Saham-saham pilihan; bisa diurutkan dari potensi tertinggi atau yang terbaru.' });

    // ─── CONSENSUS ───
    P({ page: 'consensus', tab: 'Overview', target: T('Market Sentiment'), title: 'Market Sentiment', body: 'Suasana pasar keseluruhan berdasarkan rekomendasi analis.' });
    P({ page: 'consensus', target: T('Upside Tertinggi'), title: 'Upside Tertinggi', body: 'Saham dengan potensi kenaikan tertinggi versi analis.' });
    P({ page: 'consensus', target: T('Sektor'), title: 'Sektor \u00b7 Komposisi', body: 'Komposisi BUY/NEUTRAL/SELL per sektor.' });
    P({ page: 'consensus', target: T('Top 10 Firm Aktif'), title: 'Top 10 Firm Aktif', body: 'Sekuritas yang paling aktif mengeluarkan rekomendasi.' });
    P({ page: 'consensus', target: T('Konsensus Terbaru'), title: 'Konsensus Terbaru', body: 'Rekomendasi analis paling baru yang masuk.' });
    P({ page: 'consensus', tab: 'Per Saham', target: TAB('Per Saham'), title: 'Tab Per Saham', body: 'Lihat konsensus untuk satu saham spesifik di tab ini.' });
    P({
      page: 'consensus',
      tab: 'Per Firm',
      target: S('#firmSearch'),
      title: 'Per Firm \u2014 Cari Sekuritas',
      body: 'Ketik nama sekuritas di kolom pencarian ini.' + hint('Coba ketik "RHB" atau "Mandiri".'),
      waitFor: inputHas('#firmSearch', 3)
    });
    P({ page: 'consensus', target: T('Daftar Rekomendasi'), title: 'Daftar Rekomendasi', body: 'Semua rekomendasi dari firm terpilih.' });
    P(merge({
      page: 'consensus',
      title: 'Detail Firm (popup)',
      body: 'Klik salah satu firm \u2192 muncul panel detail: komposisi rekomendasi & grafik performanya.',
      waitFor: existsVis('#firmDetailPanel:not([hidden])')
    }, { pre: function () { clickFirst('#page-consensus [onclick^="showFirmDetail"]'); }, target: S('#firmDetailPanel'), cleanup: function () { call('closeFirmDetail'); } }));

    // ─── VALUASI ───
    P({
      page: 'valuasi',
      target: S('#vlStockSearch'),
      title: 'Valuasi \u2014 Pilih Emiten',
      body: 'Mulai dari kolom pencarian ini untuk memilih emiten.' + hint('Ketik kode saham (mis. UNVR) untuk memuat valuasi.'),
      waitFor: inputHas('#vlStockSearch', 3)
    });
    P({ page: 'valuasi', tab: 'Ringkasan', target: T('Window Rata-rata'), title: 'Window Rata-rata Multiple', body: 'Atur jumlah tahun yang dipakai merata-rata multiple (PER/PBV/PSR).' });
    P({ page: 'valuasi', tab: 'Ringkasan', target: T('Proyeksi Harga'), title: 'Proyeksi Harga 5 Tahun', body: 'Inti valuasi: potensi % keuntungan dengan basis tahunan terakhir.' });
    P({ page: 'valuasi', target: T('Harga Saham'), title: 'Grafik Harga (Valuasi)', body: 'Grafik harga bulanan/harian saham yang dinilai.' });
    P({ page: 'valuasi', target: T('Tabel Proyeksi'), title: 'Tabel Proyeksi G&L', body: 'Perkiraan harga & potensi keuntungan tiap tahun ke depan.' });
    P({ page: 'valuasi', tab: 'Fundamental', target: T('Data Fundamental'), title: 'Data Fundamental Tahunan', body: 'Data fundamental per tahun + TTM (12 bulan terakhir).' });
    P({ page: 'valuasi', tab: 'Dividen', target: T('Dividen per Saham'), title: 'Dividen per Saham', body: 'Riwayat & proyeksi dividen per lembar saham.' });
    P({ page: 'valuasi', target: T('Kalkulator Yield'), title: 'Kalkulator Yield Dividen', body: 'Hitung imbal hasil dividen dari harga beli tertentu.' });
    P({ page: 'valuasi', target: T('Gaji dari Dividen'), title: 'Gaji dari Dividen', body: 'Simulasi "gaji bulanan" dari dividen sesuai jumlah lot.' });
    P({ page: 'valuasi', tab: 'Perbandingan', target: T('Perbandingan Metode'), title: 'Perbandingan Metode Valuasi', body: 'Nilai wajar dari banyak metode (PER/PBV/PSR dll) + status Murah/Wajar/Mahal.' });

    // ─── TRACKER (deep-dive, interaktif) ───
    trackerSteps(P, /* fullTour */ true);

    // ─── PASAR LIVE ───
    P({
      page: 'pasar',
      target: S('#plNewsQ', '.pl-news-search'),
      title: 'Pasar Live \u2014 Cari Berita',
      body: 'Cari berita atau kode saham di kolom pencarian ini.' + hint('Coba ketik "IHSG" atau nama saham.'),
      waitFor: inputHas('#plNewsQ', 3)
    });
    P({ page: 'pasar', target: T('Market Chart'), title: 'Market Chart', body: 'Grafik indeks & pasar secara live.' });
    P({ page: 'pasar', target: T('Heatmap Sektor'), title: 'Heatmap Sektor', body: 'Peta panas performa tiap sektor hari ini.' });
    P({ page: 'pasar', target: T('Seasonality'), title: 'Seasonality', body: 'Pola musiman pasar/indeks dari data historis.' });
    P({ page: 'pasar', target: T('Headlines'), title: 'Headlines', body: 'Kumpulan headline berita pasar terkini dari berbagai sumber.' });

    // ─── PENUTUP → BILLING ───
    P({ target: null, title: '\uD83C\uDF89 Selesai!', body: 'Itu dia keliling lengkap Economstock Terminal. Yuk lihat paket langganannya.',
      nextLabel: 'Lanjut ke Billing \u2192', onNext: function () { setDone(); try { sessionStorage.setItem(RESUME_KEY, '1'); } catch (e) {} location.href = '/billing?panduan=end'; } });
    return s;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TUR TRACKER-ONLY — untuk user scope='tracker'.
  // Dashboard/Consensus/Valuasi/Pasar dilewat (menu di-scope-blok).
  // ═══════════════════════════════════════════════════════════════════════
  function buildTrackerOnlySteps() {
    var s = [];
    function P(o) { s.push(o); }
    P({
      target: null,
      title: '\uD83D\uDC4B Selamat datang di Tracker!',
      body: 'Paket Tracker kamu memberi akses penuh ke menu Tracker \u2014 memantau performa rekomendasi trading para analis (Entry/TP/SL) vs IHSG. Yuk jelajahi.'
    });
    trackerSteps(P, /* fullTour */ false);
    P({
      target: null,
      title: '\uD83C\uDF89 Selesai!',
      body: 'Tracker tuntas dijelajahi. Butuh upgrade ke akses penuh (Dashboard, Valuasi, Consensus, Pasar)? Lihat di Billing.',
      nextLabel: 'Lanjut ke Billing \u2192',
      onNext: function () { setDone(); try { sessionStorage.setItem(RESUME_KEY, '1'); } catch (e) {} location.href = '/billing?panduan=end'; }
    });
    return s;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TRACKER STEPS — dipakai ulang di full tour & tracker-only tour.
  //
  // 5 sub-tab: Overview \u2192 Live \u2192 Analisis \u2192 Analis (dgn firm profile
  // deep-dive) \u2192 Performa.
  // ═══════════════════════════════════════════════════════════════════════
  function trackerSteps(P, fullTour) {
    // Overview (default sub-tab)
    P({ page: 'tracker', target: S('#tr-subtabs'), title: 'Menu Tracker', body: 'Tracker memantau performa rekomendasi trading analis vs IHSG. Ada 5 sub-tab: Overview, Live, Analisis, Analis, Performa.' });
    P({ page: 'tracker', target: T('Performa 30 Hari'), title: 'Performa 30 Hari', body: 'Grafik return kumulatif semua analis (garis warna) vs IHSG (garis merah) 30 hari terakhir. Sumbu Y (%) di sebelah kanan. Ada preset periode: 30D, Bulan Ini, Bulan\u25be, Tahun\u25be.' });
    P({ page: 'tracker', target: T('Distribusi Hasil'), title: 'Distribusi Hasil', body: 'Bar visual: berapa banyak rekomendasi yang hit TP1 / TP2, kena SL, atau expired.' });
    P({ page: 'tracker', target: T('Saham Paling Banyak di Rekom'), title: 'Saham Paling Banyak di Rekom', body: 'Top saham dengan rekomendasi terbanyak. Tombol \uD83D\uDCC5 di header buat filter tanggal.' });
    P({ page: 'tracker', target: T('Rekomendasi Terbaru'), title: 'Feed Rekomendasi Terbaru', body: 'Daftar rekomendasi terbaru. Setiap baris punya 3 zona klik: (1) kode saham \u2192 tab Analisis, (2) nama sekuritas \u2192 halaman profile firm, (3) area lain \u2192 popup detail rekomendasi.' });

    // Sub-tab: Live
    P({
      page: 'tracker',
      pre: function () { clickFirst('.tr-subtab-btn[data-subtab="live"]'); },
      target: S('.tr-subtab-btn[data-subtab="live"]'),
      title: 'Sub-tab Live',
      body: 'Semua rekomendasi yang sedang aktif (belum kena TP/SL/expired). Cocok untuk lihat "posisi berjalan" real-time.'
    });

    // Sub-tab: Analisis
    P({
      page: 'tracker',
      pre: function () { clickFirst('.tr-subtab-btn[data-subtab="analisis"]'); },
      target: S('.tr-subtab-btn[data-subtab="analisis"]'),
      title: 'Sub-tab Analisis',
      body: 'Analisis mendalam per saham \u2014 semua sekuritas yang pernah rekomendasi saham itu + track record mereka.'
    });

    // Sub-tab: Analis (WITH FIRM PROFILE DEEP-DIVE)
    P({
      page: 'tracker',
      pre: function () { clickFirst('.tr-subtab-btn[data-subtab="analis"]'); },
      target: S('.tr-subtab-btn[data-subtab="analis"]'),
      title: 'Sub-tab Analis',
      body: 'Ranking analis / sekuritas berdasarkan winrate & net return. Klik sekuritas manapun buat masuk profil detail.'
    });

    // Klik firm untuk masuk profile (wajib klik)
    P({
      page: 'tracker',
      target: S('.tr-firm-row, .tr-analyst-row, [onclick*="__TR_openFirm"], [data-firm-id]'),
      title: 'Buka Profil Sekuritas',
      body: 'Klik salah satu sekuritas untuk masuk ke halaman profil detail (KPI, chart, list rekomendasi).' + hint('Klik nama sekuritas manapun.'),
      waitFor: visibleOnce('#tr-view-profile:not([hidden])')
    });

    // Firm profile: KPI card
    P({ page: 'tracker', target: S('#trPfKpiStrip, .tr-pf-kpi'), title: 'KPI Sekuritas', body: 'Winrate, Net, Rata\u00b2, Trade Tercatat \u2014 metrik utama performa sekuritas ini.' });

    // Firm profile: Mode selector
    P({ page: 'tracker', target: S('#trPfSeg, .tr-pf-seg-wrap'), title: 'Mode Eksekusi', body: 'Ganti skenario: Beli di Entry vs Beli HAKA (open hari rilis), TP1 vs TP2. Semua KPI + chart + list re-hitung sesuai mode.' });

    // Firm profile: Date preset button + popup
    P({
      page: 'tracker',
      target: S('#trPfDateBtn'),
      title: 'Filter Periode',
      body: 'Klik tombol tanggal ini untuk buka popup preset periode: 30D (default), Bulan Ini, Bulan\u25be, Tahun\u25be, atau range custom via kalender.' + hint('Klik tombol tanggal \uD83D\uDCC5 untuk buka popup.'),
      waitFor: function () {
        var pop = $('#trPfCalPopup');
        return !!(pop && !pop.hidden && vis(pop));
      }
    });
    P({ page: 'tracker', target: S('#trPfChartPeriod'), title: 'Preset Periode', body: 'Pilih 30D (default), Bulan Ini, atau spesifik Bulan\u2192Tahun. Popup auto-close setelah pilih, semua panel (KPI + chart + list) refresh. Tombol \uD83C\uDF10 All di kalender = balik ke Semua Tanggal.' });

    // Firm profile: Chart
    P({
      page: 'tracker',
      pre: function () {
        // Close popup kalau masih terbuka dari step sebelumnya
        var pop = $('#trPfCalPopup');
        if (pop && !pop.hidden) { try { pop.hidden = true; } catch (e) {} }
      },
      target: S('#trPfDayChart, .tr-pf-daychart-wrap'),
      title: 'Grafik Performa Analis',
      body: 'Bar hijau/merah = P/L harian sekuritas. Bar abu = return harian IHSG (buat pembanding). Garis biru = kumulatif sekuritas. Hover mouse di chart untuk lihat tooltip detail.'
    });

    // Firm profile: Rec list
    P({ page: 'tracker', target: S('#trPfRecList, .tr-pf-rec-list'), title: 'Rekomendasi Sekuritas', body: 'List semua rekomendasi firm ini. Filter tabs: Semua / Aktif / Menunggu / TP1 / TP2 / SL / Expired. Klik salah satu \u2192 popup chart detail.' });

    // Close firm profile, back to Analis
    P({
      page: 'tracker',
      pre: function () {
        try { call('closeTrackerFirm'); } catch (e) {}
        var back = $('[onclick*="closeTrackerFirm"], .tr-pf-back');
        if (back) try { back.click(); } catch (e) {}
      },
      target: S('.tr-subtab-btn[data-subtab="analis"]'),
      title: 'Kembali ke List Analis',
      body: 'Kembali ke halaman list analis. Kamu bisa masuk ke firm lain kapan saja dari sini.'
    });

    // Sub-tab: Performa
    P({
      page: 'tracker',
      pre: function () { clickFirst('.tr-subtab-btn[data-subtab="perf"]'); },
      target: S('.tr-subtab-btn[data-subtab="perf"]'),
      title: 'Sub-tab Performa',
      body: 'Papan peringkat sekuritas + rekap bulanan performa. Bisa atur modal Rp & jumlah slot untuk simulasi portfolio ala trader.'
    });

    // Balik ke Overview
    P({
      page: 'tracker',
      pre: function () { clickFirst('.tr-subtab-btn[data-subtab="ringkasan"]'); },
      target: S('#tr-subtabs'),
      title: 'Kembali ke Overview',
      body: fullTour ? 'Kita kembali ke tab Overview. Tracker sudah lengkap dijelajah. Lanjut ke Pasar Live.' : 'Tracker sudah lengkap dijelajah.'
    });
  }

  // ── BILLING: penutup ──
  function buildBillSteps() {
    return [
      { target: S('.grid', '.plan'), title: 'Paket Langganan', body: 'Pilih durasi langganan yang paling pas untukmu di sini.' },
      { target: S('#guideBtn'), title: 'Ulangi Panduan', body: 'Mau mengulang panduan ini lagi? Buka dari tombol ini kapan saja.', nextLabel: 'Selesai' }
    ];
  }

  // ── peluncuran (welcome + pilihan HP/PC + scope routing) ──
  function launch() {
    build();
    if (isMobileDevice()) showChoice();
    else start(pickBuild());
  }
  // Pilih tur berdasar scope. Kalau tracker-only, langsung lompat ke Tracker.
  function pickBuild() {
    var scope = W.__ES_SCOPE;
    return (scope === 'tracker') ? buildTrackerOnlySteps() : buildSteps();
  }
  function showWelcome() {
    setDone();
    build();
    var scope = W.__ES_SCOPE;
    var isTrackerOnly = (scope === 'tracker');
    var bodyText = isTrackerOnly
      ? 'Yuk kenalan dengan menu Tracker. Panduan singkat per kolom & popup.'
      : 'Yuk kenalan dengan fitur-fiturnya. Panduan singkat per kolom & popup.';
    var ov = D.createElement('div'); ov.id = 'pandu-welcome';
    ov.innerHTML = '<div class="pw-box"><div class="pw-emoji">\uD83D\uDC4B</div>' +
      '<div class="pw-title">Selamat datang di Economstock Terminal!</div>' +
      '<div class="pw-body">' + bodyText + '</div>' +
      '<button class="pw-btn" id="pw-start">Mulai Panduan</button></div>';
    D.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    $('#pw-start', ov).onclick = function () {
      setDone(); ov.remove();
      if (isMobileDevice()) showChoice();
      else start(pickBuild());
    };
  }
  function showChoice() {
    var ov = D.createElement('div'); ov.id = 'pandu-welcome';
    ov.innerHTML = '<div class="pw-box"><div class="pw-emoji">\uD83D\uDCF1\uD83D\uDCBB</div>' +
      '<div class="pw-title">Pilih tampilan panduan</div>' +
      '<div class="pw-body">Panduan lebih lengkap & nyaman di tampilan PC. Pilih sesuai seleramu.</div>' +
      '<div class="pw-row"><button class="pw-btn alt" id="pw-hp">Tampilan HP</button><button class="pw-btn" id="pw-pc">Tampilan PC</button></div></div>';
    D.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    $('#pw-hp', ov).onclick = function () { ov.remove(); call('applyViewMode', 'mobile'); setTimeout(function () { start(pickBuild()); }, 250); };
    $('#pw-pc', ov).onclick = function () { ov.remove(); call('applyViewMode', 'desktop'); setTimeout(function () { start(pickBuild()); }, 450); };
  }

  // ── init dashboard ──
  function initDash() {
    var params = new URLSearchParams(location.search);
    if (params.get('panduan') === '1') { setTimeout(launch, 700); return; }
    var done; try { done = localStorage.getItem(DONE_KEY); } catch (e) {}
    if (done) return;
    // Poller: tunggu urutan auth → consent → PWA → scope → guide.
    // Naikkan tries di SETIAP tick supaya timeout cabut kalau sesuatu
    // stuck (mis. __ES_SCOPE never set karena API down).
    var tries = 0, authed = false;
    var t = setInterval(function () {
      tries++;
      if (tries > 40) { clearInterval(t); return; } // ~16 detik hard cap
      var p = W.__ES_PROFILE;
      if (p && p.authenticated) {
        authed = true;
        if (p.guide_seen) { clearInterval(t); try { localStorage.setItem(DONE_KEY, '1'); } catch (e) {} return; }
        if (p.tos_accepted === false) return;
        if (W.__ES_PWA_PENDING === true) return;
        // Tunggu __ES_SCOPE ter-set oleh _ensureAccess untuk routing tur
        // yg tepat (full vs tracker-only). Kalau setelah ~8 detik masih
        // undefined (mis. offline), lanjut aja (fallback full).
        if (W.__ES_SCOPE === undefined && tries < 20) return;
        clearInterval(t);
        showWelcome();
      } else if (!authed && tries > 25) { clearInterval(t); }
    }, 400);
  }

  // ── init billing ──
  //
  // Tombol "Panduan Terminal" di billing:
  //   - User sudah langganan / admin (activeOk=true) → klik buka /dashboard?panduan=1
  //   - User belum langganan → klik TIDAK buka apapun; popup "Pilih paket dulu"
  function initBill() {
    build();
    var gb = D.getElementById('guideBtn'), activeOk = false, meLoaded = false;
    fetch('/api/me', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (me) {
      activeOk = !!(me && (me.is_admin || (me.subscription && me.subscription.active)));
      meLoaded = true;
      // Kalau belum aktif, tandai tombol secara visual (opsional cue).
      if (gb && !activeOk) {
        try { gb.setAttribute('aria-disabled', 'true'); gb.title = 'Silahkan pilih paket dulu untuk membuka panduan.'; } catch (e) {}
      }
    }).catch(function () { meLoaded = true; });

    if (gb) {
      gb.addEventListener('click', function (e) {
        e.preventDefault();
        if (activeOk) {
          location.href = '/dashboard?panduan=1';
        } else {
          // Belum langganan → popup wajib pilih paket.
          showLockedGuidePopup();
        }
      });
    }

    var params = new URLSearchParams(location.search), resume = false;
    try { resume = sessionStorage.getItem(RESUME_KEY) === '1'; } catch (e) {}
    if (params.get('panduan') === 'end' || resume) setTimeout(function () { start(buildBillSteps()); }, 700);
  }

  // Popup "Silahkan pilih paket dulu" — muncul waktu user belum langganan
  // klik tombol Panduan Terminal di halaman billing.
  function showLockedGuidePopup() {
    var existing = D.getElementById('pandu-locked');
    if (existing) return; // Sudah tampil, hindari dobel
    var ov = D.createElement('div'); ov.id = 'pandu-locked';
    ov.innerHTML = '<div class="pl-box">' +
      '<div class="pl-emoji">\uD83D\uDD12</div>' +
      '<div class="pl-title">Panduan Butuh Langganan Aktif</div>' +
      '<div class="pl-body">Silahkan pilih paket dulu di halaman ini untuk mengaktifkan Panduan Terminal. ' +
      'Panduan akan otomatis tersedia setelah langganan aktif.</div>' +
      '<div class="pl-row">' +
      '<button class="pl-btn alt" id="pl-close">Nanti Saja</button>' +
      '<button class="pl-btn" id="pl-plans">Lihat Paket</button>' +
      '</div></div>';
    D.body.appendChild(ov);
    requestAnimationFrame(function () { ov.classList.add('show'); });
    var closeIt = function () {
      ov.classList.remove('show');
      setTimeout(function () { try { ov.remove(); } catch (e) {} }, 250);
    };
    $('#pl-close', ov).onclick = closeIt;
    $('#pl-plans', ov).onclick = function () {
      closeIt();
      // Scroll ke section paket di halaman billing.
      var plans = $('.plan-grid, .grid, .plan-cards, .plans, #plans');
      if (plans && plans.scrollIntoView) {
        try { plans.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { plans.scrollIntoView(); }
      }
    };
    // Klik luar box → close.
    ov.addEventListener('click', function (e) { if (e.target === ov) closeIt(); });
  }

  W.Panduan = { start: launch, finish: finish };
  if (IS_DASH) initDash(); else if (IS_BILL) initBill();
})();
