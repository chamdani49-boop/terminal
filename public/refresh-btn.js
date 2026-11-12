/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — tombol Refresh kecil di top bar (semua halaman).
 *
 * Masalah: filter seperti tanggal di Tracker > Overview tidak punya cara
 * jelas untuk kembali ke awal. Tombol ↻ memuat ulang halaman (data terbaru,
 * semua filter kembali ke default) TAPI tetap membuka menu + sub-menu yang
 * sedang dilihat, tidak dilempar ke Dashboard.
 *
 * Modul ini tidak mengubah logika menu inti: tombol disisipkan lewat DOM di
 * depan tombol tema, dan navigasi setelah reload dilakukan dengan meng-klik
 * .nav-tab / tombol sub-menu yang sudah ada (sama seperti acct-nav.js).
 * Dimuat di index.html (via acct-nav.js), admin.html, dan billing.html.
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__esRefreshBtn) return;
  window.__esRefreshBtn = true;

  var KEY = 'es-refresh-restore';
  // Sub-menu per halaman: tombol yang aktif disimpan lalu di-klik lagi setelah reload.
  var SUBS = {
    pasar: ['#plSubTerminal', '#plSubScreening'],
    consensus: ['#cvTabOverview', '#cvTabStock', '#cvTabFirm'],
    valuasi: [".vl-tab[onclick*=\"'overview'\"]", ".vl-tab[onclick*=\"'fundamental'\"]", ".vl-tab[onclick*=\"'dividen'\"]", ".vl-tab[onclick*=\"'metode'\"]"],
    tracker: ['ringkasan', 'live', 'analisis', 'analis', 'perf'].map(function (s) { return '#tr-subtabs .tr-subtab-btn[data-subtab="' + s + '"]'; })
  };

  var ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';

  var CSS =
    '.es-refresh{width:36px;height:36px;border-radius:50%;border:1px solid var(--border);background:var(--card);color:var(--text2);' +
      'cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;padding:0;margin-left:4px;' +
      'transition:border-color .2s,color .2s,transform .2s;-webkit-tap-highlight-color:transparent}' +
    '.es-refresh:hover{color:var(--accent);border-color:var(--accent)}' +
    '.es-refresh:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
    '.es-refresh svg{transition:transform .35s}.es-refresh:hover svg{transform:rotate(-60deg)}' +
    '.es-refresh.spin svg{animation:esRfSpin .7s linear infinite}' +
    '@keyframes esRfSpin{to{transform:rotate(360deg)}}' +
    '@media (max-width:1200px){.es-refresh{width:32px;height:32px}}' +
    // HP sempit: logo sedikit mengecil supaya tombol muat tanpa mendorong tombol tema keluar layar.
    '@media (max-width:480px){.top-bar.has-es-refresh{gap:6px}.top-bar.has-es-refresh .logo{min-width:0;font-size:clamp(13px,4.2vw,20px)}.es-refresh{width:30px;height:30px;margin-left:0}.es-refresh svg{width:13px;height:13px}}' +
    '.es-refresh-toast{position:fixed;left:50%;top:72px;transform:translate(-50%,-8px);z-index:10050;opacity:0;pointer-events:none;' +
      'background:var(--card);color:var(--text);border:1px solid var(--border);border-radius:999px;padding:7px 14px;font-size:12.5px;font-weight:700;' +
      'box-shadow:0 8px 24px rgba(0,0,0,.18);transition:opacity .25s,transform .25s}' +
    '.es-refresh-toast.show{opacity:1;transform:translate(-50%,0)}';

  function activePage() {
    var p = document.querySelector('.page.active');
    return p && p.id ? p.id.replace(/^page-/, '') : null;
  }
  function activeSub(page) {
    var list = SUBS[page] || [];
    for (var i = 0; i < list.length; i++) {
      var el = document.querySelector(list[i]);
      if (el && (el.classList.contains('active') || el.classList.contains('on'))) return list[i];
    }
    return null;
  }

  function doRefresh(btn) {
    btn.classList.add('spin');
    btn.disabled = true;
    try {
      var page = activePage();
      if (page) sessionStorage.setItem(KEY, JSON.stringify({ path: location.pathname, page: page, sub: activeSub(page), t: Date.now() }));
    } catch (_) {}
    // hash #smartmoney dsb. tetap ikut; query string dipertahankan.
    location.reload();
  }

  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'es-refresh-toast'; t.setAttribute('role', 'status'); t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add('show'); });
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2000);
  }

  // Klik elemen begitu ada (menu Smart Money baru disisipkan belakangan oleh modulnya).
  function clickWhenReady(find, done, tries) {
    tries = tries == null ? 40 : tries;
    var el = find();
    if (el) { el.click(); if (done) done(); return; }
    if (tries > 0) setTimeout(function () { clickWhenReady(find, done, tries - 1); }, 200);
  }
  function navTabFor(page) {
    var tabs = document.querySelectorAll('.nav-tabs .nav-tab');
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].getAttribute('onclick') || '').indexOf("'" + page + "'") >= 0) return tabs[i];
    }
    return document.getElementById('bn-' + page);
  }

  function restore() {
    var st = null;
    try { st = JSON.parse(sessionStorage.getItem(KEY) || 'null'); sessionStorage.removeItem(KEY); } catch (_) {}
    if (!st || st.path !== location.pathname || Date.now() - st.t > 60000) return;
    var after = function () { toast('Halaman dimuat ulang · filter kembali ke awal'); };
    if (!st.page || !document.getElementById('page-' + st.page)) { after(); return; }
    var openSub = function () {
      if (!st.sub) { after(); return; }
      setTimeout(function () { clickWhenReady(function () { return document.querySelector(st.sub); }, after, 25); }, 150);
    };
    if (st.page === activePage()) { openSub(); return; }
    clickWhenReady(function () { return navTabFor(st.page); }, openSub);
  }

  function init() {
    if (document.getElementById('esRefresh')) return;
    var bar = document.querySelector('.top-bar');
    if (!bar) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    var btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'esRefresh'; btn.className = 'es-refresh';
    btn.title = 'Muat ulang halaman ini (data terbaru, semua filter kembali ke awal)';
    btn.setAttribute('aria-label', 'Muat ulang halaman');
    btn.innerHTML = ICON;
    btn.addEventListener('click', function () { doRefresh(btn); });
    var anchor = document.getElementById('viewToggle') || document.getElementById('themeToggle') || document.getElementById('themeBtn');
    bar.classList.add('has-es-refresh');
    if (anchor && anchor.parentNode === bar) bar.insertBefore(btn, anchor);
    else bar.appendChild(btn);
    restore();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
