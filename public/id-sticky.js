/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — chip identitas melayang (kode + nama).
 *
 * Meniru chip sekuritas di Tracker > Analis (.tr-pf-ministicky): saat kartu
 * judul (hero) sudah ter-scroll lewat, muncul pill kecil di bawah ticker
 * berjalan berisi kotak kode + nama. Klik → kembali ke atas kartu judul.
 *
 * Dipakai di:
 *   - Tracker > Analisis   (kode saham)
 *   - Dashboard            (kode saham)
 *   - Valuasi, semua tab   (kode saham)
 *   - Consensus > profil firm analis (kode broker + nama sekuritas)
 *
 * Modul ini HANYA MEMBACA DOM yang sudah dirender menu masing-masing; tidak
 * mengubah logika/markup menu inti. Chip Tracker > Analis yang lama tetap
 * dipakai apa adanya (tidak diduplikasi di sini).
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function $(sel) { return document.querySelector(sel); }
  function txt(sel) {
    var el = $(sel);
    var t = el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    return (t === '—' || t === '-') ? '' : t;
  }
  function shown(el) { return !!(el && el.offsetParent !== null); }
  function pageActive(name) {
    var p = document.getElementById('page-' + name);
    return !!(p && p.classList.contains('active'));
  }

  var CONTEXTS = [
    { // Tracker > Analisis (per kode saham)
      type: 'stock',
      hero: '#tr-view-analisis .tr-anl-hero',
      active: function () {
        var pane = document.getElementById('tr-view-analisis');
        return pageActive('tracker') && shown(pane) && shown($('#trAnlContent'));
      },
      code: function () { return txt('#trAnlTick'); },
      name: function () { return txt('#trAnlName'); }
    },
    { // Dashboard (hero saham terpilih)
      type: 'stock',
      hero: '#stockHero',
      active: function () { return pageActive('dashboard') && !!$('#stockHero .stock-name-block .ticker'); },
      code: function () { return txt('#stockHero .stock-name-block .ticker'); },
      name: function () { return txt('#stockHero .stock-name-block .fullname'); }
    },
    { // Valuasi (header emiten, sama untuk semua sub-tab)
      type: 'stock',
      hero: '#vlHead',
      active: function () { return pageActive('valuasi') && !!$('#vlHead .vl-name'); },
      code: function () { return txt('#vlHead .vl-name'); },
      name: function () { return txt('#vlHead .vl-mid-name'); }
    },
    { // Consensus > profil firm analis
      type: 'firm',
      hero: '#firmHero',
      active: function () {
        var panel = document.getElementById('firmDetailPanel');
        return pageActive('consensus') && !!panel && panel.style.display !== 'none' && shown(panel);
      },
      code: function () { return ''; },
      name: function () { return txt('#firmName'); }
    }
  ];

  var chip = null, avEl = null, nmEl = null, curCtx = null;

  function injectCss() {
    if (document.getElementById('idStickyCss')) return;
    var st = document.createElement('style');
    st.id = 'idStickyCss';
    // Basis tampilan = class .tr-pf-ministicky (CSS sudah ada di index.html).
    // Tambahan: kotak kode saham lebar otomatis (4 huruf, mis. BBCA).
    st.textContent =
      '.id-sticky.is-stock .tr-pf-mini-av{width:auto;min-width:30px;padding:0 7px;font-size:11.5px}' +
      '.id-sticky .tr-pf-mini-sub{font-weight:500;color:var(--text2);margin-left:6px}' +
      '@media(max-width:520px){.id-sticky.is-stock .tr-pf-mini-av{min-width:26px;padding:0 6px;font-size:10.5px}}';
    document.head.appendChild(st);
  }

  function ensureChip() {
    if (chip) return chip;
    injectCss();
    chip = document.createElement('div');
    chip.className = 'tr-pf-ministicky id-sticky';
    chip.id = 'idSticky';
    chip.hidden = true;
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.innerHTML = '<span class="tr-pf-mini-av"></span><span class="tr-pf-mini-name"></span>';
    avEl = chip.firstChild;
    nmEl = chip.lastChild;
    function goTop() {
      var hero = curCtx && $(curCtx.hero);
      if (!hero) return;
      try { hero.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) { hero.scrollIntoView(); }
    }
    chip.addEventListener('click', goTop);
    chip.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goTop(); } });
    document.body.appendChild(chip);
    return chip;
  }

  // Batas bawah area sticky (header + ticker berjalan).
  function stickyBottom() {
    var tk = document.getElementById('stockTicker');
    if (tk && tk.getBoundingClientRect().height) return Math.max(0, tk.getBoundingClientRect().bottom);
    var tb = document.querySelector('.top-bar');
    return tb ? Math.max(0, tb.getBoundingClientRect().bottom) : 0;
  }

  function hide() { if (chip && !chip.hidden) chip.hidden = true; curCtx = null; }

  function render(ctx) {
    ensureChip();
    var code = ctx.code(), name = ctx.name();
    var av, foreign = false, label;
    if (ctx.type === 'firm') {
      if (!name) return false;
      var bk = (window.BrokerCodes && window.BrokerCodes.avatar) ? window.BrokerCodes.avatar(name) : null;
      av = bk ? bk.text : name.replace(/^PT\s+/i, '').split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();
      foreign = !!(bk && bk.foreign);
      label = name;
    } else {
      if (!code) return false;
      av = code;
      label = name && name.toUpperCase() !== code.toUpperCase() ? name : code;
    }
    if (avEl.textContent !== av) avEl.textContent = av;
    avEl.classList.toggle('brk-foreign', foreign);
    if (nmEl.textContent !== label) nmEl.textContent = label;
    chip.classList.toggle('is-stock', ctx.type === 'stock');
    chip.title = (ctx.type === 'firm' ? 'Kembali ke atas profil sekuritas' : 'Kembali ke atas · ' + code);
    return true;
  }

  // Chip lama Tracker > Analis (#trPfMiniSticky) disembunyikan oleh
  // IntersectionObserver-nya sendiri, yang TIDAK terpicu saat pindah menu
  // (hero tetap "tidak terlihat") → chip tertinggal di menu lain. Sembunyikan
  // bila pane Analis sudah tidak tampil.
  function hideStaleAnalisChip() {
    var old = document.getElementById('trPfMiniSticky');
    if (!old || old.hidden) return;
    var pane = document.getElementById('tr-view-analis');
    var panel = document.getElementById('trMdetPanel');
    var ok = pageActive('tracker') && shown(pane) && panel && panel.style.display !== 'none';
    if (!ok) old.hidden = true;
  }

  function update() {
    hideStaleAnalisChip();
    var ctx = null;
    for (var i = 0; i < CONTEXTS.length; i++) {
      try { if (CONTEXTS[i].active()) { ctx = CONTEXTS[i]; break; } } catch (_) {}
    }
    if (!ctx) { hide(); return; }
    var hero = $(ctx.hero);
    if (!shown(hero)) { hide(); return; }
    var top = stickyBottom();
    // Tampil saat kartu judul sudah lewat ke balik header+ticker.
    if (hero.getBoundingClientRect().bottom > top) { hide(); return; }
    if (!render(ctx)) { hide(); return; }
    curCtx = ctx;
    chip.style.top = (top + 6) + 'px';
    if (chip.hidden) chip.hidden = false;
  }

  var raf = 0;
  function schedule() {
    if (raf) return;
    raf = (window.requestAnimationFrame || setTimeout)(function () { raf = 0; update(); });
  }

  function init() {
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    // Ganti menu / sub-tab / saham → cek ulang setelah DOM ter-render.
    document.addEventListener('click', function () { setTimeout(schedule, 60); setTimeout(schedule, 400); }, true);
    // Jaring pengaman ringan: render async (fetch data) tanpa scroll/klik.
    setInterval(schedule, 1000);
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
