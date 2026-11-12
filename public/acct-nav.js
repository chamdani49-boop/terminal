/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — Menu navigasi di dropdown avatar akun.
 *
 * Mengisi #acctNav (di dalam #acctMenu) dengan daftar menu + sub-menu
 * halaman. Modul ini TIDAK mengubah logika menu inti: navigasi halaman
 * dilakukan dengan meng-klik .nav-tab yang sudah ada (jadi showPage,
 * plEnsure, vlEnsureCharts, overlay scope-tracker, dll tetap jalan persis
 * seperti klik menu biasa). Sub-menu meng-klik tombol tab yang sudah ada
 * di halaman tsb, atau scroll ke kartu/panel terkait.
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // type: 'click' → klik elemen selector · 'scroll' → scroll ke elemen
  var MENU = [
    { page: 'pasar', label: 'Pasar Live', ico: '📡', subs: [
      // pre = klik dulu tombol tampilan "Terminal" (panel-panel ini ada di sana)
      { label: 'Market Chart',   type: 'scroll', sel: '#plWinChartA',  pre: '#plSubTerminal' },
      { label: 'Heatmap Sektor', type: 'scroll', sel: '#plWinHeatmap', pre: '#plSubTerminal' },
      { label: 'Seasonality',    type: 'scroll', sel: '#plWinSeas',    pre: '#plSubTerminal' },
      { label: 'Headlines',      type: 'scroll', sel: '#plWinNews',    pre: '#plSubTerminal' },
      { label: 'Screening',      type: 'click',  sel: '#plSubScreening' }
    ]},
    { page: 'dashboard', label: 'Dashboard', ico: '📊', subs: [
      { label: 'Statistik Deskriptif', type: 'scroll', sel: '#statsCard' },
      { label: 'Grafik Harga',         type: 'scroll', sel: '#page-dashboard .card-chart' },
      { label: 'Rekomendasi Analis',   type: 'scroll', sel: '#page-dashboard .card-analyst' },
      { label: 'Price Target',         type: 'scroll', sel: '#page-dashboard .card-pt' },
      { label: 'Consensus Analyst',    type: 'scroll', sel: '#page-dashboard .card-consensus' },
      { label: 'Watchlist',            type: 'scroll', sel: '#page-dashboard .card-watchlist' },
      { label: 'Simulasi Investasi',   type: 'click',  sel: '#page-dashboard .btn-sim-open' }
    ]},
    { page: 'valuasi', label: 'Valuasi', ico: '💎', subs: [
      { label: 'Ringkasan',    type: 'click', sel: ".vl-tab[onclick*=\"'overview'\"]" },
      { label: 'Fundamental',  type: 'click', sel: ".vl-tab[onclick*=\"'fundamental'\"]" },
      { label: 'Dividen',      type: 'click', sel: ".vl-tab[onclick*=\"'dividen'\"]" },
      { label: 'Perbandingan', type: 'click', sel: ".vl-tab[onclick*=\"'metode'\"]" }
    ]},
    { page: 'consensus', label: 'Consensus', ico: '🔍', subs: [
      { label: 'Overview',  type: 'click', sel: '#cvTabOverview' },
      { label: 'Per Saham', type: 'click', sel: '#cvTabStock' },
      { label: 'Per Firm',  type: 'click', sel: '#cvTabFirm' }
    ]},
    { page: 'tracker', label: 'Tracker', ico: '📈', subs: [
      { label: 'Overview', type: 'click', sel: '#tr-subtabs .tr-subtab-btn[data-subtab="ringkasan"]' },
      { label: 'Live',     type: 'click', sel: '#tr-subtabs .tr-subtab-btn[data-subtab="live"]' },
      { label: 'Analisis', type: 'click', sel: '#tr-subtabs .tr-subtab-btn[data-subtab="analisis"]' },
      { label: 'Analis',   type: 'click', sel: '#tr-subtabs .tr-subtab-btn[data-subtab="analis"]' },
      { label: 'Performa', type: 'click', sel: '#tr-subtabs .tr-subtab-btn[data-subtab="perf"]' }
    ]}
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function navTabFor(page) {
    var tabs = document.querySelectorAll('.nav-tabs .nav-tab');
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].getAttribute('onclick') || '').indexOf("'" + page + "'") >= 0) return tabs[i];
    }
    return null;
  }

  function pageActive(page) {
    var el = document.getElementById('page-' + page);
    return !!(el && el.classList.contains('active'));
  }

  // Tinggi area sticky di atas konten (header + running ticker).
  function stickyOffset() {
    var off = 0;
    var tb = document.querySelector('.top-bar');
    if (tb) off = Math.max(off, tb.getBoundingClientRect().bottom);
    var tk = document.getElementById('stockTicker');
    if (tk) {
      var r = tk.getBoundingClientRect();
      if (r.height && getComputedStyle(tk).display !== 'none') off = Math.max(off, r.bottom);
    }
    return off + 10;
  }

  function scrollToEl(el) {
    var y = el.getBoundingClientRect().top + window.pageYOffset - stickyOffset();
    window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
  }

  function closeMenu() {
    var menu = document.getElementById('acctMenu');
    var wrap = document.getElementById('acctWrap');
    if (menu) menu.classList.remove('open');
    if (wrap) wrap.classList.remove('menu-open');
  }

  function go(gi, si) {
    var g = MENU[gi];
    if (!g) return;
    closeMenu();

    if (!pageActive(g.page)) {
      var tab = navTabFor(g.page);
      if (tab) tab.click();
      else if (typeof window.showPage === 'function') window.showPage(g.page);
    }

    if (si == null) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    var sub = g.subs[si];
    if (!sub) return;
    // Beri waktu halaman ter-render (display:none → block) sebelum aksi sub-menu.
    setTimeout(function () {
      // Halaman terkunci (mis. scope-tracker) → overlay preview yg tampil; stop.
      if (!pageActive(g.page)) return;
      if (sub.pre) {
        var preEl = document.querySelector(sub.pre);
        if (preEl && !preEl.classList.contains('on')) preEl.click();
      }
      var el = document.querySelector(sub.sel);
      if (!el) return;
      if (sub.type === 'click') {
        el.click();
        if (sub.sel.indexOf('btn-sim-open') < 0) {
          var bar = el.closest('.vl-tabs, .cv-nav-bar, #tr-subtabs, .pl-head') || el;
          scrollToEl(bar);
        }
      } else {
        scrollToEl(el);
      }
    }, 60);
  }

  function render() {
    var box = document.getElementById('acctNav');
    if (!box) return;
    var html = '<div class="acct-nav-title">Menu</div>';
    MENU.forEach(function (g, gi) {
      html += '<div class="acct-nav-group" data-page="' + esc(g.page) + '">' +
        '<div class="acct-nav-head">' +
          '<button type="button" class="acct-nav-page" data-g="' + gi + '">' +
            '<span class="acct-nav-ico" aria-hidden="true">' + g.ico + '</span>' + esc(g.label) +
          '</button>' +
          '<button type="button" class="acct-nav-tgl" data-tgl="' + esc(g.page) + '" aria-expanded="false" ' +
            'aria-label="Tampilkan/sembunyikan sub-menu ' + esc(g.label) + '" title="Tampilkan/sembunyikan sub-menu">' +
            '<span class="acct-nav-chev" aria-hidden="true"></span></button>' +
        '</div><div class="acct-nav-subs">';
      g.subs.forEach(function (s, si) {
        html += '<button type="button" class="acct-nav-sub" data-g="' + gi + '" data-s="' + si + '">' + esc(s.label) + '</button>';
      });
      html += '</div></div>';
    });
    box.innerHTML = html;

    box.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('button[data-tgl]');
      if (t) {
        e.preventDefault();
        e.stopPropagation();
        var pg = t.getAttribute('data-tgl');
        var grp = t.closest('.acct-nav-group');
        setOpen(pg, !(grp && grp.classList.contains('open')));
        return;
      }
      var b = e.target.closest && e.target.closest('button[data-g]');
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      var s = b.getAttribute('data-s');
      go(+b.getAttribute('data-g'), s == null ? null : +s);
    });
  }

  // Status buka/tutup sub-menu per halaman (diingat di browser).
  // Belum pernah diatur → default: hanya grup halaman yang sedang aktif terbuka.
  var OPEN_KEY = 'es_nav_open';
  function loadOpen() {
    try { return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') || {}; } catch (_) { return {}; }
  }
  function setOpen(page, open) {
    var st = loadOpen();
    st[page] = !!open;
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(st)); } catch (_) {}
    syncActive();
  }

  function syncActive() {
    var st = loadOpen();
    var groups = document.querySelectorAll('#acctNav .acct-nav-group');
    for (var i = 0; i < groups.length; i++) {
      var pg = groups[i].getAttribute('data-page');
      var act = pageActive(pg);
      var open = (pg in st) ? !!st[pg] : act;
      groups[i].classList.toggle('is-active', act);
      groups[i].classList.toggle('open', open);
      var tg = groups[i].querySelector('.acct-nav-tgl');
      if (tg) tg.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
  }

  function init() {
    render();
    syncActive();
    var btn = document.getElementById('acctBtn');
    if (btn) btn.addEventListener('click', syncActive);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Tombol Refresh di top bar (modul terpisah, public/refresh-btn.js). Dimuat dari sini
  // supaya index.html (area terkunci) tidak perlu diubah.
  if (!window.__esRefreshBtn && !document.querySelector('script[src^="/refresh-btn.js"]')) {
    var rs = document.createElement('script');
    rs.src = '/refresh-btn.js?v=20261112'; rs.defer = true;
    document.head.appendChild(rs);
  }
})();
