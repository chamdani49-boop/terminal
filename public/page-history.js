/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — tombol Back/Forward browser untuk pindah halaman.
 *
 * Pindah halaman di SPA ini lewat showPage() dan tidak menyentuh riwayat
 * browser, jadi tombol back tidak punya tujuan. Modul ini membungkus
 * window.showPage dari luar (index.html tidak diubah): setiap pindah halaman
 * menambah satu entri riwayat, dan back kembali ke halaman sebelumnya.
 * Pindah lewat popstate memakai klik menu yang sudah ada, supaya efek
 * samping tiap halaman (plEnsure, vlEnsureCharts, dll) tetap jalan.
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__esPageHistory) return;
  window.__esPageHistory = true;
  var orig = window.showPage;
  if (typeof orig !== 'function') return;

  var cur = null, busy = false, armed = false;
  // Pemanggilan showPage saat aplikasi dimuat (auto-redirect scope, dll) tidak menambah riwayat.
  setTimeout(function () { armed = true; }, 2500);

  function pageNow() {
    var act = document.querySelector('.page.active');
    return act && act.id ? act.id.replace(/^page-/, '') : null;
  }
  function navEl(name) {
    var tabs = document.querySelectorAll('.nav-tabs .nav-tab');
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].getAttribute('onclick') || '').indexOf("'" + name + "'") >= 0) return tabs[i];
    }
    return document.getElementById('bn-' + name);
  }

  // Entri awal diberi status halaman aktif supaya back dari halaman pertama tidak diabaikan.
  cur = pageNow();
  if (cur) { try { history.replaceState({ es: 1, page: cur }, '', location.href); } catch (_) {} }

  window.showPage = function (name) {
    var r = orig.apply(this, arguments);
    if (name && name !== 'menabung' && name !== cur) {
      var st = { es: 1, page: name };
      try {
        if (armed && !busy) history.pushState(st, '', location.href);
        else history.replaceState(st, '', location.href);
      } catch (_) {}
      cur = name;
    }
    return r;
  };

  window.addEventListener('popstate', function (e) {
    var st = e.state;
    if (!st || !st.es || !st.page) return;
    busy = true;
    try {
      var el = navEl(st.page);
      if (el) el.click();
      else {
        window.showPage(st.page);
        if (st.page === 'smartmoney' && window.SmartMoney && window.SmartMoney.open) window.SmartMoney.open(true);
      }
    } catch (_) {}
    busy = false;
    cur = st.page;
  });
})();
