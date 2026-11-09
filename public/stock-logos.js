/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — Logo emiten di samping kode saham
 *
 * Modul MANDIRI: TIDAK mengubah kode render menu mana pun. Ia hanya
 * mengamati DOM (MutationObserver) dan menyisipkan <img class="sl-logo">
 * bulat di depan elemen kode saham yang dikenal.
 *
 * Gambar: /logos/<KODE>.png (disimpan di repo, diperbarui oleh
 * scripts/fetch-logos.js + .github/workflows/refresh-logos.yml).
 * Daftar kode yang punya logo: /logos/index.json → kode di luar daftar
 * (kode broker, BUY/SELL, IHSG, '—', dll.) otomatis diabaikan.
 *
 * Keamanan terhadap kode lama:
 *  - img pakai pointer-events:none → klik tetap jatuh ke elemen kode
 *    (handler yang cek e.target, mis. Tracker overview, tetap jalan).
 *  - alt="" → textContent elemen tidak berubah (id-sticky.js, pencarian).
 *  - Elemen ber-lebar tetap / teks gradient → img disisipkan sebagai
 *    SIBLING sebelum elemen, bukan di dalamnya.
 *  - Kalau kode menimpa isi elemen (textContent = ...), observer
 *    memasang ulang / memperbarui logo.
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var BASE = '/logos/';

  // mode: 'in'  = prepend di dalam elemen
  //       'before' = sibling sebelum elemen
  //       'box' = isi kotak logo (valuasi .vl-logo)
  var RULES = [
    // Dashboard
    { sel: '.st-code', mode: 'before' },
    { sel: '.wi-code', mode: 'before' },
    { sel: '.stock-name-block .ticker', mode: 'in', cls: 'sl-lg' },
    { sel: '.ticker-code', mode: 'in' },
    { sel: '.rec-modal-ticker', mode: 'in', cls: 'sl-lg' },
    { sel: 'td.yoy-label', mode: 'in' },
    { sel: '.consensus-chart-wrap > div > div:first-child', mode: 'in' },
    // Pencarian (header, chart, menabung)
    { sel: '.search-item > .code', mode: 'before' },
    { sel: '.pl-search-item > .code', mode: 'before' },
    // Pasar / screening / heatmap
    { sel: 'td.scr-c-code', mode: 'in' },
    { sel: '.pl-tile > .tc', mode: 'in' },
    // Consensus
    { sel: '.cs-ticker', mode: 'in' },
    { sel: '.firm-recs-stock', mode: 'in' },
    { sel: '.ov-latest-stock', mode: 'in' },
    // Tracker
    { sel: '.tr-rec-tk', mode: 'in' },
    { sel: '.tr-scn-tick', mode: 'in' },
    { sel: '.tr-live-card-tick', mode: 'in' },
    { sel: '.tr-ov-latest-tick', mode: 'in' },
    { sel: '.tr-anl-hero-tick', mode: 'in', cls: 'sl-lg' },
    { sel: '.tr-recmodal-tick', mode: 'in', cls: 'sl-lg' },
    // Valuasi
    { sel: '#vlHead .vl-logo', mode: 'box' },
    { sel: '#vlProjTableHeader > div > span:first-child', mode: 'in' },
    // Smart Money (admin)
    { sel: '.smm-rrow > .c', mode: 'in' },
    { sel: '.smm-dvrow > .c', mode: 'in' },
    { sel: '.smm-quick > button', mode: 'in' },
    { sel: '.smm-pchip > b', mode: 'in' },
    { sel: 'tr[data-act="quick"] b.mono-n', mode: 'in' }
  ];
  var ALL_SEL = RULES.map(function (r) { return r.sel; }).join(',');

  var codes = null; // Set kode yang punya logo

  function injectCss() {
    var css =
      'img.sl-logo{display:inline-block;width:1.25em;height:1.25em;min-width:1.25em;' +
      'border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:.35em;' +
      'background:#fff;box-shadow:0 0 0 1px var(--border,rgba(0,0,0,.12));' +
      'pointer-events:none;user-select:none;flex:0 0 auto;position:relative;top:-.08em}' +
      'img.sl-logo.sl-before{width:18px;height:18px;min-width:18px;top:0;margin-right:6px}' +
      '@media (max-width:600px){.st-item>img.sl-logo{width:15px;height:15px;min-width:15px;margin-right:4px}}' +
      'img.sl-logo.sl-lg{width:.85em;height:.85em;min-width:.85em;top:0;vertical-align:-.08em;margin-right:.25em}' +
      '.sl-logo-box{position:relative;overflow:hidden}' +
      '.sl-logo-box>img.sl-logo{position:absolute;inset:0;width:100%;height:100%;min-width:0;' +
      'margin:0;top:0;border-radius:inherit;box-shadow:none;object-fit:contain;padding:12%;box-sizing:border-box}';
    var st = document.createElement('style');
    st.id = 'sl-logo-css';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // Ambil kode dari teks elemen (abaikan img logo sendiri). Untuk elemen
  // ber-isi campuran (mis. tr-live-card-tick: "BBCA <badge>"), pakai
  // node teks pertama yang tidak kosong.
  function readCode(el) {
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        var t = n.nodeValue.trim();
        if (t) return t.toUpperCase();
      } else if (n.nodeType === 1 && !(n.classList && n.classList.contains('sl-logo'))) {
        return '';
      }
    }
    return '';
  }

  function makeImg(code, extraCls) {
    var img = document.createElement('img');
    img.className = 'sl-logo' + (extraCls ? ' ' + extraCls : '');
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.dataset.code = code;
    img.src = BASE + code + '.png';
    img.onerror = function () { this.style.display = 'none'; };
    return img;
  }

  function setImg(img, code) {
    if (img.dataset.code !== code) {
      img.dataset.code = code;
      img.style.display = '';
      img.src = BASE + code + '.png';
    }
  }

  function decorate(el, mode, cls) {
    var code = readCode(el);
    var ok = code && codes.has(code);

    if (mode === 'before') {
      var prev = el.previousElementSibling;
      var has = prev && prev.classList.contains('sl-logo') ? prev : null;
      if (!ok) { if (has) has.remove(); return; }
      if (has) setImg(has, code);
      else el.parentNode.insertBefore(makeImg(code, 'sl-before'), el);
      return;
    }

    var first = el.firstElementChild;
    var own = first && first.classList.contains('sl-logo') ? first : null;
    if (!ok) {
      if (own) own.remove();
      if (mode === 'box') el.classList.remove('sl-logo-box');
      return;
    }
    if (own) { setImg(own, code); return; }
    if (mode === 'box') el.classList.add('sl-logo-box');
    el.insertBefore(makeImg(code, cls || ''), el.firstChild);
  }

  function scan() {
    for (var r = 0; r < RULES.length; r++) {
      var list = document.querySelectorAll(RULES[r].sel);
      for (var i = 0; i < list.length; i++) decorate(list[i], RULES[r].mode, RULES[r].cls);
    }
  }

  var queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; scan(); });
  }

  // Abaikan mutasi yang hanya berasal dari logo kita sendiri.
  function relevant(m) {
    if (m.type === 'characterData') return true;
    var lists = [m.addedNodes, m.removedNodes];
    for (var k = 0; k < 2; k++) {
      for (var i = 0; i < lists[k].length; i++) {
        var n = lists[k][i];
        if (!(n.nodeType === 1 && n.classList.contains('sl-logo'))) return true;
      }
    }
    return false;
  }

  function start() {
    injectCss();
    scan();
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (relevant(muts[i])) { schedule(); return; }
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  fetch(BASE + 'index.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || !Array.isArray(j.codes) || !j.codes.length) return;
      codes = new Set(j.codes);
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
      else start();
    })
    .catch(function () { /* tanpa logo → UI tetap seperti semula */ });

  // Untuk diagnosa manual dari console.
  window.__stockLogos = { rescan: function () { if (codes) scan(); }, selector: ALL_SEL };
})();
