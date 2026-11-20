/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — Smart Money › SCREENER (KHUSUS ADMIN)
 *
 * Sub-tab ke-4 menu Smart Money. Dimuat dinamis oleh smartmoney.js
 * (lihat ensureScreener) saat sub-tab "Screener" pertama kali dibuka.
 *
 * 6 tampilan (kalender flow ada di Broker Activity, smartmoney.js):
 *   1. Today        — sinyal terbaru + akurasi setup preset (backtest 3 bln)
 *   2. Gems         — skor gabungan harian + preset bullish / risiko
 *   3. Accumulation — posisi broker 6 bulan (floor, PnL, trapped) + flow 10 hari
 *   4. Smart Money  — smart money nampung ritel & P&L smart money
 *   5. Broker&Holder— associate broker, pemegang >5%, insider lintas saham
 *   6. Foreign      — intensitas arus asing + radar top 20 (peringkat harian)
 *
 * SUMBER DATA
 *   - Harga & teknikal (RSI, Stoch, 20d high) = ASLI dari /ohlc.json.
 *   - Nama, sektor, kapitalisasi = DATA (data.json) yang sudah dimuat situs.
 *   - Arus broker / asing / ritel / insider / holder = HANYA data asli R2
 *     (ringkasan screener/summary.json atau file per saham). Saham tanpa
 *     data asli tidak masuk daftar yang memakai arus broker. Tidak ada dummy.
 *   - Ritel = broker di RETAIL; smart money = broker lainnya.
 *
 * Modul ini tidak menyentuh menu inti. Semua akses ke internal Smart Money
 * lewat objek API yang dikirim smartmoney.js (window.SmartMoney._api).
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var A = null;            // API dari smartmoney.js
  var host = null;         // #smmPgScreener
  var U = null;            // universe hasil build
  var _waiters = null;     // callback saat universe sedang dibangun
  var RETAIL = { YP: 1, XL: 1, PD: 1, XC: 1, KK: 1, CP: 1, EP: 1 };
  var AXIS_MAX = 140, WIN = 126;
  var DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  var MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  var TIERS = [
    { k: 'diamond', label: 'Diamond', min: 80, color: '#38bdf8' },
    { k: 'gold', label: 'Gold', min: 65, color: '#f5b301' },
    { k: 'silver', label: 'Silver', min: 50, color: '#b6c2d1' },
    { k: 'bronze', label: 'Bronze', min: 35, color: '#d08a4a' }
  ];

  // ─────────────────────────── Util ───────────────────────────
  function esc(s) { return A.esc(s); }
  function nf(v, d) { return A.nf(v, d); }
  function fv(v, rp) { return A.fmtVal(v, rp); }
  function fl(v) { return A.fmtLot(v); }
  function fp(v, d) { return A.fmtPct(v, d); }
  function sc(v) { return v > 0 ? 'sx-up' : v < 0 ? 'sx-dn' : ''; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function tip(t) { return A.tip(t); }
  function iso(x) { var ms = x > 1e12 ? x : x * 1000; return new Date(ms).toISOString().slice(0, 10); }
  function dObj(d) { return new Date(d + 'T00:00:00Z'); }
  function dLong(d) { var o = dObj(d); return DAYS[o.getUTCDay()] + ', ' + o.getUTCDate() + ' ' + MONTHS[o.getUTCMonth()] + ' ' + o.getUTCFullYear(); }
  function dShort(d) { var o = dObj(d); return o.getUTCDate() + ' ' + MON[o.getUTCMonth()] + ' ' + String(o.getUTCFullYear()).slice(2); }
  function px(v) { return nf(v, v < 50 ? 1 : 0); }
  function sum(P, a, b) { a = Math.max(0, a); if (b < a) return 0; return P[b + 1] - P[a]; }
  function prefix(arr) { var P = new Float64Array(arr.length + 1); for (var i = 0; i < arr.length; i++) P[i + 1] = P[i] + arr[i]; return P; }
  function tierOf(s) { for (var i = 0; i < TIERS.length; i++) if (s >= TIERS[i].min) return TIERS[i]; return null; }
  function bk(code, type, name) { return A.bkTag(code, type || 'D', name || code); }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function load(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function mq(q) { return window.matchMedia && window.matchMedia(q).matches; }

  // Ikon garis (24×24, currentColor)
  var ICO = {
    today: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/>',
    gem: '<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M2 9h20M12 21L8 9l4-6 4 6-4 12"/>',
    layers: '<path d="M12 2l10 5-10 5L2 7z"/><path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>',
    funnel: '<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01"/>',
    book: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
    left: '<path d="M15 18l-6-6 6-6"/>',
    right: '<path d="M9 18l6-6-6-6"/>',
    spike: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/>',
    rotate: '<path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
    alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    down: '<path d="M23 18l-9.5-9.5-5 5L1 6"/><path d="M17 18h6v-6"/>',
    up: '<path d="M23 6l-9.5 9.5-5-5L1 18"/><path d="M17 6h6v6"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    ext: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"/>',
    radar: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="5"/><path d="M12 12l7-7"/>',
    bank: '<path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    check: '<path d="M20 6L9 17l-5-5"/>',
    bar: '<path d="M12 20V10M18 20V4M6 20v-4"/>',
    zap: '<path d="M13 2L3 14h9l-1 8 10-12h-9z"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    flow: '<path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/>',
    split: '<path d="M16 3h5v5M8 3H3v5M21 3l-9 9M3 3l9 9v9"/>',
    star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
    lightbulb: '<path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z"/>',
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    news: '<path d="M4 4h13a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2z"/><path d="M19 8h2v10a2 2 0 0 1-2 2M8 8h7M8 12h7M8 16h4"/>',
    dollar: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'
  };
  function ic(name, cls) {
    return '<svg class="sx-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICO[name] || '') + '</svg>';
  }

  // ─────────────────────────── Data: universe ───────────────────────────
  function stockMeta() {
    var meta = {};
    try {
      if (typeof DATA !== 'undefined' && DATA) {
        (DATA.stock_list || []).forEach(function (s) { meta[s.code] = { name: s.name, sector: s.sector, board: s.board }; });
        var f = DATA.fundamentals || {};
        Object.keys(f).forEach(function (k) { var x = meta[k] = meta[k] || {}; x.mcap = +f[k].mkt_cap || 0; x.shares = +f[k].shares || 0; });
      }
    } catch (_) {}
    return meta;
  }
  function buildAxis(T) {
    var cnt = {}, codes = Object.keys(T);
    codes.forEach(function (c) {
      (T[c].candles || []).forEach(function (k) { var d = iso(k[0]); cnt[d] = (cnt[d] || 0) + 1; });
    });
    var th = Math.max(1, codes.length * 0.3);
    var days = Object.keys(cnt).filter(function (d) { var w = dObj(d).getUTCDay(); return cnt[d] >= th && w !== 0 && w !== 6; }).sort();
    return days.slice(-AXIS_MAX);
  }

  function newArrs(m) {
    var n = m.n;
    ['val', 'smB', 'smS', 'smBL', 'smSL', 'rtB', 'rtS', 'rtBL', 'rtSL', 'fB', 'fS', 'fBL', 'fSL', 'blk'].forEach(function (k) { m[k] = new Float64Array(n); });
    m.ascBv = new Float32Array(n);
    m.brokers = [];
    m._posA = m._posR = null;
  }
  function newBroker(code, name, type, grp, fgn, n) {
    return { code: code, name: name, type: type, grp: grp, fgn: fgn, nv: new Float32Array(n),
      w: { bv: 0, sv: 0, bl: 0, sl: 0 }, ng: { bv: 0, sv: 0, bl: 0, sl: 0 }, n10: 0, trough: 0, peak: 0 };
  }
  function addFlow(m, b, t, bv, sv, bl, sl, fx) {
    m.val[t] += bv;
    if (b.grp === 'R') { m.rtB[t] += bv; m.rtS[t] += sv; m.rtBL[t] += bl; m.rtSL[t] += sl; }
    else { m.smB[t] += bv; m.smS[t] += sv; m.smBL[t] += bl; m.smSL[t] += sl; }
    if (fx) { m.fB[t] += fx[0]; m.fS[t] += fx[1]; m.fBL[t] += fx[2]; m.fSL[t] += fx[3]; }
    else if (b.fgn) { m.fB[t] += bv; m.fS[t] += sv; m.fBL[t] += bl; m.fSL[t] += sl; }
    b.nv[t] += bv - sv;
    if (t >= m.wS) { b.w.bv += bv; b.w.sv += sv; b.w.bl += bl; b.w.sl += sl; }
  }
  function finishBrokers(m) {
    var n = m.n;
    m.brokers.forEach(function (b) {
      var cum = 0, mn = 0, mnI = m.wS - 1, mx = 0, mxI = m.wS - 1, n10 = 0;
      for (var t = m.wS; t < n; t++) {
        cum += b.nv[t];
        if (cum < mn) { mn = cum; mnI = t; }
        if (cum > mx) { mx = cum; mxI = t; }
        if (t >= n - 10) n10 += b.nv[t];
      }
      b.trough = n - 1 - mnI; b.peak = n - 1 - mxI; b.n10 = n10;
    });
  }
  // Catatan: porsi KSEI asing TIDAK lagi diperkirakan dari arus transaksi (dulu arus × 0,85 dari titik awal 20%,
  // angka tiruan yang tampil seolah data KSEI). Kolom, preset, dan filter KSEI di tampilan Foreign dihapus.

  // Tanpa data asli: arus broker/asing/ritel/insider/holder KOSONG (tidak ada dummy).
  function blank(m) {
    newArrs(m);
    m.wS = m.n - Math.min(WIN, m.n - m.first);
    m.nBk = 0; m.asc = -1; m.h5 = []; m.ins = []; m.ff = null;
  }
  // Data asli R2 per saham → struktur model
  function applyReal(m, g) {
    if (!g) return;
    var idx = U.idx;
    if (g.hasBroker) {
      newArrs(m);
      m.wS = m.n - Math.min(WIN, m.n - m.first);
      var map = [];
      for (var t = 0; t < g.nF; t++) { var i = idx[g.days[g.off + t]]; map.push(i === undefined ? -1 : i); }
      g.brokers.forEach(function (rb) {
        var R = !!RETAIL[rb.code];
        var b = newBroker(rb.code, rb.name, rb.type, R ? 'R' : 'S', rb.type === 'F' && !R, m.n);
        for (var t2 = 0; t2 < g.nF; t2++) {
          var i2 = map[t2]; if (i2 < 0) continue;
          var fx = rb.fx ? [rb.fbv[t2], rb.fsv[t2], rb.fbl[t2], rb.fsl[t2]] : null;
          addFlow(m, b, i2, rb.bv[t2], rb.sv[t2], rb.bl[t2], rb.sl[t2], fx);
        }
        m.brokers.push(b);
      });
      finishBrokers(m);   // tanpa kolom f* → asing = broker bertipe F (lihat addFlow)
      m.nBk = m.brokers.length;
      m.asc = -1;
      var uw = g.holder && g.holder.profile && g.holder.profile.underwriters || [];
      var BC = window.BrokerCodes;
      for (var u = 0; u < uw.length && m.asc < 0; u++) {
        var hit = BC && BC.get ? BC.get(uw[u]) : null, code = hit ? hit.code : String(uw[u]).toUpperCase();
        m.brokers.forEach(function (b, bi) { if (m.asc < 0 && b.code === code) m.asc = bi; });
      }
      if (m.asc >= 0) {
        var ab = g.brokers.filter(function (x) { return x.code === m.brokers[m.asc].code; })[0];
        for (var t3 = 0; t3 < g.nF; t3++) if (map[t3] >= 0) m.ascBv[map[t3]] += ab.bv[t3];
      }
      m.realBroker = true;
    }
    if (g.trades && g.trades.length) {
      m.ins = [];
      g.trades.forEach(function (x) { var i3 = idx[x.mdate]; if (i3 !== undefined) m.ins.push({ name: x.name, role: x.role, act: x.action, shares: x.shares, price: x.price, value: x.value, t: i3 }); });
    }
    var H = g.holder;
    if (H && H.months && H.months.length >= 2) {
      m.h5 = [];
      var ms = H.months.slice(-4);
      for (var k = 1; k < ms.length; k++) {
        var prev = {}, cur = {};
        (H.mv[ms[k - 1]] || []).forEach(function (x) { prev[x.name] = x.pct; });
        (H.mv[ms[k]] || []).forEach(function (x) { cur[x.name] = x.pct; });
        var te = monthEndIdx(ms[k]);
        Object.keys(cur).concat(Object.keys(prev)).forEach(function (nm) {
          var a = prev[nm] || 0, b2 = cur[nm] || 0;
          if (Math.abs(b2 - a) >= 0.005 && Math.max(a, b2) >= 5 && !m.h5.some(function (e) { return e.name === nm && e.t === te; })) m.h5.push({ name: nm, prev: a, cur: b2, t: te });
        });
      }
      if (H.profile && H.profile.freeFloat) m.ff = H.profile.freeFloat > 1 ? H.profile.freeFloat / 100 : H.profile.freeFloat;
    }
    m.real = true;
    derive(m);
  }
  // Ringkasan seluruh pasar dari R2 (screener/summary.json, dibuat scripts/build-smartmoney-screener.js).
  // Format dijelaskan di header skrip itu. Nilai rupiah dalam satuan S.u.
  function applySummary(m, s, Sm) {
    var idx = U.idx, n = m.n, u = Sm.u || 1, days = Sm.days, map = days.map(function (d) { var i = idx[d]; return i === undefined ? -1 : i; });
    newArrs(m);
    m.wS = n - Math.min(WIN, n - m.first);
    var G = s.g || {};
    ['smB', 'smS', 'rtB', 'rtS', 'fB', 'fS'].forEach(function (k) { (G[k] || []).forEach(function (v, j) { if (map[j] >= 0) m[k][map[j]] += v * u; }); });
    ['smBL', 'smSL', 'rtBL', 'rtSL'].forEach(function (k) { (G[k] || []).forEach(function (v, j) { if (map[j] >= 0) m[k][map[j]] += v; }); });
    for (var t = 0; t < n; t++) {
      m.val[t] = m.smB[t] + m.rtB[t];
      var c = m.c[t] || 1; m.fBL[t] = m.fB[t] / (c * 100); m.fSL[t] = m.fS[t] / (c * 100);
    }
    var meta = {}; A.brokerList().forEach(function (b) { meta[b.code] = b; });
    var nvOff = days.length - ((s.bk && s.bk[0] && s.bk[0][1].length) || 0);
    m.asc = -1;
    (s.bk || []).forEach(function (row) {
      var cd = row[0], mt = meta[cd] || { code: cd, name: cd, foreign: false }, R = !!RETAIL[cd], ty = A.brokerType(mt);
      var b = newBroker(cd, A.titleCase(mt.name), ty, R ? 'R' : 'S', ty === 'F' && !R, n);
      (row[1] || []).forEach(function (v, j) { var i = map[j + nvOff]; if (i >= 0) b.nv[i] += v * u; });
      var w = row[2] || [0, 0, 0, 0];
      b.w = { bv: w[0] * u, sv: w[1] * u, bl: w[2], sl: w[3] };
      b.n10 = (row[3] || 0) * u; b.trough = row[4] || 0; b.peak = row[5] || 0;
      if (cd === s.asc) m.asc = m.brokers.length;
      m.brokers.push(b);
    });
    (s.ascBv || []).forEach(function (v, j) { var i = map[j + nvOff]; if (i >= 0) m.ascBv[i] += v * u; });
    m.nBk = Math.max(m.brokers.length, (s.bk || []).length);
    if (s.so) m.shares = s.so;
    if (s.ff != null) m.ff = s.ff;
    m.ins = [];
    (s.ins || []).forEach(function (x) {
      var ti = -1; for (var k = n - 1; k >= 0; k--) { if (U.axis[k] <= x[0]) { ti = k; break; } }
      if (ti >= 0) m.ins.push({ name: x[1], role: x[2], act: x[3], shares: x[4], price: x[5] || m.c[ti], value: x[4] * (x[5] || m.c[ti]), t: ti });
    });
    m.h5 = [];
    var byM = {}; (s.h5 || []).forEach(function (x) { (byM[x[0]] = byM[x[0]] || {})[x[1]] = x[2]; });
    var ms = Object.keys(byM).sort();
    for (var q = 1; q < ms.length; q++) {
      var pv = byM[ms[q - 1]], cu = byM[ms[q]], te = monthEndIdx(ms[q]);
      Object.keys(Object.assign({}, pv, cu)).forEach(function (nm) {
        var a = pv[nm] || 0, b2 = cu[nm] || 0;
        if (Math.abs(b2 - a) >= 0.005 && Math.max(a, b2) >= 5) m.h5.push({ name: nm, prev: a, cur: b2, t: te });
      });
    }
    m.real = m.realBroker = true; m.fromSummary = true;
    derive(m);
  }
  function loadSummary() {
    return (A.cachedJson ? A.cachedJson('/api/smartmoney/screener') : fetch('/api/smartmoney/screener', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }))
      .then(function (j) {
        if (!j || !j.stocks || !Array.isArray(j.days)) return 0;
        var cnt = 0;
        Object.keys(j.stocks).forEach(function (code) {
          var m = U.by[code]; if (!m) return;
          try { applySummary(m, j.stocks[code], j); cnt++; } catch (e) { console.warn('[screener] summary', code, e); }
        });
        U.summaryAt = j.updated || null;
        if (cnt) { U.bt = null; if (V.view === 'stk') { if (!(V.stk.sig && V.stk.sig.brk)) sigBump(); stkRefresh(); } else if (host && !host.hidden) renderView(); }
        return cnt;
      })
      .catch(function () { return 0; });
  }
  function monthEndIdx(ym) {
    var ax = U.axis, best = ax.length - 1;
    for (var i = ax.length - 1; i >= 0; i--) { if (ax[i].slice(0, 7) <= ym) { best = i; break; } }
    return best;
  }

  // Indikator turunan (dipakai skor, preset, backtest)
  function derive(m) {
    var n = m.n, c = m.c, i;
    m.sm = new Float64Array(n); m.rt = new Float64Array(n); m.fn = new Float64Array(n);
    var abs = new Float64Array(n);
    for (i = 0; i < n; i++) { m.sm[i] = m.smB[i] - m.smS[i]; m.rt[i] = m.rtB[i] - m.rtS[i]; m.fn[i] = m.fB[i] - m.fS[i]; abs[i] = Math.abs(m.sm[i]); }
    m.Psm = prefix(m.sm); m.Pval = prefix(m.val); m.Pfn = prefix(m.fn); m.Pblk = prefix(m.blk); m.Pabs = prefix(abs);
    m.ascN = new Float64Array(n);
    if (m.asc >= 0) { var nv = m.brokers[m.asc].nv; for (i = 0; i < n; i++) m.ascN[i] = nv[i]; }
    m.Pasc = prefix(m.ascN);
    m.st = new Int16Array(n); m.fst = new Int16Array(n); m.pos10 = new Int8Array(n);
    m.rsi = new Float32Array(n); m.sto = new Float32Array(n); m.hi20 = new Float64Array(n); m.score = new Float32Array(n);
    var s = 0, f = 0, ag = 0, al = 0;
    for (i = 0; i < n; i++) {
      if (m.val[i] > 0) {
        s = m.sm[i] > 0 ? (s > 0 ? s + 1 : 1) : m.sm[i] < 0 ? (s < 0 ? s - 1 : -1) : 0;
        f = m.fn[i] > 0 ? (f > 0 ? f + 1 : 1) : m.fn[i] < 0 ? (f < 0 ? f - 1 : -1) : 0;
      }
      m.st[i] = clamp(s, -999, 999); m.fst[i] = clamp(f, -999, 999);
      var p = 0; for (var j = Math.max(0, i - 9); j <= i; j++) if (m.sm[j] > 0) p++;
      m.pos10[i] = p;
      if (i > 0) {
        var ch = c[i] - c[i - 1], gn = ch > 0 ? ch : 0, ls = ch < 0 ? -ch : 0;
        if (i <= 14) { ag += gn / 14; al += ls / 14; }
        else { ag = (ag * 13 + gn) / 14; al = (al * 13 + ls) / 14; }
      }
      m.rsi[i] = i < 14 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al);
      var hh = -Infinity, ll = Infinity, h20 = -Infinity;
      for (var k = Math.max(0, i - 19); k <= i; k++) { if (m.h[k] > h20) h20 = m.h[k]; if (k >= i - 13) { if (m.h[k] > hh) hh = m.h[k]; if (m.l[k] < ll) ll = m.l[k]; } }
      m.sto[i] = hh > ll ? (c[i] - ll) / (hh - ll) * 100 : 50;
      m.hi20[i] = h20;
    }
    for (i = 0; i < n; i++) m.score[i] = gemAt(m, i);
  }
  function gemAt(m, t) {
    if (t < 20 || t - 20 < m.first) return 0;
    var v20 = sum(m.Pval, t - 19, t) || 1, v5 = sum(m.Pval, t - 4, t) || 1;
    var acc = Math.tanh(sum(m.Psm, t - 19, t) / v20 * 6);
    var st = clamp(m.st[t] / 8, -1, 1);
    var fo = Math.tanh(sum(m.Pfn, t - 4, t) / v5 * 12);
    var R = m.rsi[t], te = R < 30 ? 0.5 : R <= 45 ? 0.6 : R <= 55 ? 0.3 : R <= 70 ? 0.3 - (R - 55) / 15 * 0.9 : -1;
    var po = clamp((1 - m.c[t] / (m.hi20[t] || m.c[t])) * 8, 0, 1) * 2 - 1;
    return clamp(47 + 50 * (0.4 * acc + 0.2 * st + 0.15 * fo + 0.15 * te * 0.6 + 0.1 * po * 0.6), 0, 100);
  }
  function regime(m, t) {
    var s20 = sum(m.Psm, t - 19, t), p = m.pos10[t];
    if (s20 > 0 && p >= 6) return { k: 'acc', label: 'ACCUMULATION', pct: p * 10 };
    if (s20 < 0 && p <= 4) return { k: 'dist', label: 'DISTRIBUTION', pct: (10 - p) * 10 };
    return { k: 'neu', label: 'NEUTRAL', pct: Math.max(p, 10 - p) * 10 };
  }
  function avgVal(m, t, k) { return sum(m.Pval, t - k + 1, t) / k; }
  function liqOf(m, t) {
    var v = avgVal(m, t, 20);
    return v >= 1e10 ? { k: 'high', label: 'HIGH' } : v >= 1e9 ? { k: 'mid', label: 'MID' } : v >= 1e8 ? { k: 'low', label: 'LOW' } : { k: 'vlow', label: 'V.LOW' };
  }
  function ascRank(m, t, k) {
    if (m.asc < 0) return 99;
    var mine = 0, nets = m.brokers.map(function (b, i) { var s = 0; for (var d = Math.max(0, t - k + 1); d <= t; d++) s += b.nv[d]; if (i === m.asc) mine = s; return s; });
    return 1 + nets.filter(function (x) { return x > mine; }).length;
  }

  // ─────────────────────────── Preset sinyal ───────────────────────────
  var PRESETS = [
    { k: 'top', label: 'Top Gems', ico: 'gem', risk: false, desc: 'Skor gabungan tertinggi (bandar, asing, teknikal) dan rezim akumulasi.' },
    { k: 'spike', label: 'Spike Then Quiet', ico: 'spike', risk: false, desc: 'Ada lonjakan beli smart money 2-9 hari lalu, lalu harga & transaksi tenang. Pola "isi dulu, diam kemudian".' },
    { k: 'assoc', label: 'Associate Broker', ico: 'users', risk: false, desc: 'Broker penjamin emisi (associate) net beli 5 hari dan masuk 3 pembeli terbesar.' },
    { k: 'dual', label: 'Dual Confirmation', ico: 'shield', risk: false, desc: 'Bandar sedang akumulasi DAN asing net beli minimal 3 hari beruntun.' },
    { k: 'block', label: 'Block Absorption', ico: 'box', risk: false, desc: 'Transaksi blok / nego diserap smart money (>5% nilai transaksi 5 hari) sementara harga stabil.' },
    { k: 'oversold', label: 'Oversold Reversal', ico: 'rotate', risk: false, desc: 'RSI < 35 atau Stoch < 20 (jenuh jual) dan smart money mulai beli 3 hari terakhir.' },
    { k: 'distw', label: 'Distribution Watch', ico: 'alert', risk: true, desc: 'Smart money net jual 20 hari dan menjual minimal 3 hari beruntun. Waspada.' },
    { k: 'obdist', label: 'Overbought + Dist', ico: 'down', risk: true, desc: 'RSI > 68 (jenuh beli) sementara smart money net jual 5 hari. Rawan koreksi.' }
  ];
  var PRE_BY = {}; PRESETS.forEach(function (p) { PRE_BY[p.k] = p; });

  function spikeAt(m, t) {
    for (var d = t - 9; d <= t - 2; d++) {
      if (d < 21 || d < m.first + 20) continue;
      var avgAbs = sum(m.Pabs, d - 20, d - 1) / 20;
      if (!(m.sm[d] > 0 && m.sm[d] > 3 * avgAbs && m.val[d] > 0)) continue;
      var after = sum(m.Pval, d + 1, t) / (t - d);
      if (Math.abs(m.c[t] / m.c[d] - 1) < 0.04 && after < 0.7 * m.val[d]) return d;
    }
    return -1;
  }
  function presetHit(m, k, t) {
    if (!m.realBroker || t < 21 || t - 20 < m.first || !m.val[t]) return false;
    switch (k) {
      case 'top': return m.score[t] >= 50 && regime(m, t).k === 'acc';
      case 'spike': return spikeAt(m, t) >= 0;
      case 'assoc': return m.asc >= 0 && sum(m.Pasc, t - 4, t) > 0 && ascRank(m, t, 5) <= 3;
      case 'dual': return regime(m, t).k === 'acc' && m.fst[t] >= 3;
      case 'block': return sum(m.Pblk, t - 4, t) > 0.05 * sum(m.Pval, t - 4, t) && Math.abs(m.c[t] / m.c[t - 4] - 1) < 0.03;
      case 'oversold': return (m.rsi[t] < 35 || m.sto[t] < 20) && sum(m.Psm, t - 2, t) > 0;
      case 'distw': return sum(m.Psm, t - 19, t) < 0 && m.st[t] <= -3;
      case 'obdist': return m.rsi[t] > 68 && sum(m.Psm, t - 4, t) < 0;
    }
    return false;
  }
  function evidence(m, t) {
    var out = [], rg = regime(m, t);
    if (rg.k === 'acc') out.push(['g', 'ACCUMULATING • ' + rg.pct + '%']);
    else if (rg.k === 'dist') out.push(['r', 'DISTRIBUTING • ' + rg.pct + '%']);
    if (m.st[t] >= 3) out.push(['g', m.st[t] + 'D STREAK']);
    else if (m.st[t] <= -3) out.push(['r', (-m.st[t]) + 'D JUAL']);
    if (m.fst[t] >= 3) out.push(['g', 'FOREIGN ' + Math.min(m.fst[t], 20) + 'D BUYING']);
    else if (m.fst[t] <= -3) out.push(['r', 'FOREIGN ' + Math.min(-m.fst[t], 20) + 'D SELLING']);
    if (m.sto[t] < 20) out.push(['b', 'STOCH ' + Math.round(m.sto[t]) + ' OVERSOLD']);
    else if (m.sto[t] > 80) out.push(['y', 'STOCH ' + Math.round(m.sto[t]) + ' OVERBOUGHT']);
    if (m.rsi[t] < 30) out.push(['b', 'RSI ' + Math.round(m.rsi[t]) + ' OVERSOLD']);
    if (presetHit(m, 'assoc', t)) out.push(['g', 'ASSOC BROKER BELI']);
    if (presetHit(m, 'block', t)) out.push(['p', 'BLOCK ABSORPTION']);
    if (spikeAt(m, t) >= 0) out.push(['p', 'SPIKE → QUIET']);
    return out.slice(0, 4);
  }
  function chips(list) { return list.map(function (e) { return '<span class="sx-ev ' + e[0] + '">' + esc(e[1]) + '</span>'; }).join(''); }

  // Backtest 3 bulan: return 10 hari setelah sinyal vs rata-rata semua saham
  function backtest() {
    if (U.bt) return U.bt;
    var n = U.n, H = 10, end = n - 1 - H, start = Math.max(25, end - 62);
    var st = {}; PRESETS.forEach(function (p) { st[p.k] = { sum: 0, ex: 0, cnt: 0, up: 0, days: 0 }; });
    for (var d = start; d <= end; d++) {
      var rs = [], hit = {}, tot = 0, cnt = 0;
      U.list.forEach(function (m, i) {
        if (!m.tr[d] || d - 20 < m.first) { rs.push(null); return; }
        var r = m.c[d + H] / m.c[d] - 1; rs.push(r); tot += r; cnt++;
      });
      if (!cnt) continue;
      var avg = tot / cnt;
      PRESETS.forEach(function (p) {
        var s = st[p.k], any = false;
        U.list.forEach(function (m, i) {
          if (rs[i] == null || !presetHit(m, p.k, d)) return;
          s.sum += rs[i]; s.ex += rs[i] - avg; s.cnt++; if (rs[i] > 0) s.up++; any = true;
        });
        if (any) s.days++;
      });
    }
    var mk = 0, mc = 0;
    U.list.forEach(function (m) { var a = Math.max(m.first, n - 64); if (n - 1 - a > 40) { mk += m.c[n - 1] / m.c[a] - 1; mc++; } });
    PRESETS.forEach(function (p) {
      var s = st[p.k];
      s.avg = s.cnt ? s.sum / s.cnt * 100 : 0; s.excess = s.cnt ? s.ex / s.cnt * 100 : 0; s.upPct = s.cnt ? s.up / s.cnt * 100 : 0;
      s.label = s.cnt < 30 ? { k: 'na', t: 'DATA KURANG' } : s.excess > 2 ? { k: 'gg', t: 'LEBIH BAIK' } : s.excess > 0.5 ? { k: 'g', t: 'SEDIKIT LEBIH BAIK' } : s.excess < -0.5 ? { k: 'r', t: 'LEBIH BURUK' } : { k: 'n', t: 'SAMA SAJA' };
    });
    U.bt = { st: st, mkt: mc ? mk / mc * 100 : 0, H: H };
    return U.bt;
  }

  // ─────────────────────────── State ───────────────────────────
  var VIEWS = [
    { k: 'today', ico: 'today', label: 'Today', sub: 'Sinyal terbaik' },
    { k: 'gems', ico: 'gem', label: 'Gems', sub: 'Sinyal harian' },
    { k: 'accum', ico: 'layers', label: 'Accumulation', sub: 'Posisi broker 6 bln' },
    { k: 'smart', ico: 'funnel', label: 'Smart Money', sub: 'Nampung ritel & P&L' },
    { k: 'bh', ico: 'users', label: 'Broker & Holder', sub: 'Associate, >5%, insider' },
    { k: 'foreign', ico: 'globe', label: 'Foreign', sub: 'Intensitas & radar' }
  ];
  var V = {
    view: 'today', asOf: 0, guide: {}, acc: null,
    gems: { preset: 'top', tier: 0, cap: 'all', liq: 'all', sector: '', q: '', sort: 'score', dir: -1, limit: 50 },
    accum: { mode: 'pos', trend: 'acc', top: 5, market: 'reg', minLose: 0, minLoss: 0, maxDays: 0, minNet: 0, preset: '', q: '', sort: 'net', dir: -1, limit: 10 },
    smart: { mode: 'retail', a: null, b: null, rng: '1W', q: '', sort: 'sm', dir: -1, pl: 'all', limit: 50 },
    bh: { mode: 'assoc', per: '1W', hper: '3M', flip: false, q: '', lim: { a: 10, d: 10 } },
    stk: { code: '', q: '' },
    news: { per: '7D', q: '', limit: 30 },
    cons: { v: 'all', min: 3, q: '', sort: 'up', limit: 30 },
    foreign: { mode: 'int', side: 'acc', preset: 'all', per: '30D', liq: 0, show: 50, q: '', sort: 'score', dir: -1, rd: 7, rsort: 'days', rdir: -1, rexp: undefined }
  };
  function T0() { return U.n - 1 - V.asOf; }

  // ─────────────────────────── Bangun universe ───────────────────────────
  function ensureUniverse(cb) {
    if (U) { cb(); return; }
    if (_waiters) { _waiters.push(cb); return; }
    _waiters = [cb];
    progress(0, 'Memuat harga semua saham…');
    Promise.resolve(A.loadOhlc()).then(function (all) {
      var T = all && all.tickers || {};
      var axis = buildAxis(T);
      var idx = {}; axis.forEach(function (d, i) { idx[d] = i; });
      var mEnds = [];
      axis.forEach(function (d, i) { if (i === axis.length - 1 || axis[i + 1].slice(0, 7) !== d.slice(0, 7)) mEnds.push(i); });
      var meta = stockMeta();
      var codes = Object.keys(T).filter(function (c) { return /^[A-Z0-9]{4,6}$/.test(c); }).sort();
      var U2 = { axis: axis, idx: idx, n: axis.length, mEnds: mEnds, list: [], by: {}, sectors: [] };
      var i = 0;
      function step() {
        var end = Math.min(codes.length, i + 70);
        for (; i < end; i++) {
          try { var m = buildModel(codes[i], T, meta, U2); if (m) { U2.list.push(m); U2.by[m.code] = m; } } catch (e) { console.warn('[screener]', codes[i], e); }
        }
        progress(i / Math.max(1, codes.length), 'Menghitung ' + i + ' / ' + codes.length + ' saham…');
        if (i < codes.length) setTimeout(step, 0);
        else {
          var sec = {}; U2.list.forEach(function (m) { sec[m.sector] = 1; });
          U2.sectors = Object.keys(sec).filter(function (s) { return s && s !== '-'; }).sort();
          U = U2;
          var w = _waiters; _waiters = null;
          w.forEach(function (f) { f(); });
          // 1 file ringkasan untuk semua saham dulu; per saham hanya untuk yang belum tercakup
          loadSummary().then(function (cnt) { loadRealAll(cnt); });
        }
      }
      if (!axis.length) { U = U2; var w0 = _waiters; _waiters = null; w0.forEach(function (f) { f(); }); return; }
      step();
    });
  }
  function buildModel(code, T, meta, U2) {
    var cs = T[code] && T[code].candles; if (!cs || cs.length < 25) return null;
    var n = U2.n, o = new Float64Array(n), h = new Float64Array(n), l = new Float64Array(n), c = new Float64Array(n), tr = new Uint8Array(n);
    for (var j = 0; j < cs.length; j++) {
      var k = cs[j], i = U2.idx[iso(k[0])]; if (i === undefined) continue;
      var cl = +k[4]; if (!(cl > 0)) continue;
      o[i] = +k[1] || cl; h[i] = Math.max(+k[2] || cl, o[i], cl); l[i] = Math.min(+k[3] || cl, o[i], cl); c[i] = cl; tr[i] = 1;
    }
    var first = -1; for (var a = 0; a < n; a++) if (tr[a]) { first = a; break; }
    if (first < 0 || n - first < 25) return null;
    for (var b = 0; b < n; b++) { if (tr[b]) continue; var pv = b < first ? c[first] : c[b - 1]; o[b] = h[b] = l[b] = c[b] = pv; }
    var mt = meta[code] || {};
    var m = { code: code, name: mt.name || code, sector: mt.sector || '-', board: mt.board || '', mcap: mt.mcap || 0, shares: mt.shares || 0,
      n: n, first: first, o: o, h: h, l: l, c: c, tr: tr, real: false };
    blank(m);
    derive(m);
    return m;
  }
  // Saham yang punya file asli di R2 → hitung ulang dari data asli
  var _realDone = 0;
  // Pemuatan data broker (ringkasan + per saham) selesai. Sebelum ini, "belum ada data broker" TIDAK boleh
  // ditampilkan karena datanya masih dalam perjalanan.
  function brokerDone() { if (!U || U.brokerReady) return; U.brokerReady = true; if (!(V.stk.sig && V.stk.sig.brk)) sigBump(); if (host && !host.hidden) { if (V.view === 'stk') { if (V.stk.code) renderBody(); else stkRefresh(); } } }
  function loadRealAll(fromSum) {
    var tries = 0;
    (function waitIdx() {
      var codes = A.index();
      if (!codes) { if (++tries < 40) setTimeout(waitIdx, 500); else brokerDone(); return; }
      // Ringkasan sudah ada → hanya saham baru (di luar ringkasan) yang diambil per saham, maks 20.
      codes = codes.filter(function (c) { return U.by[c] && !U.by[c].fromSummary; }).slice(0, fromSum ? 20 : 150);
      var q = codes.slice(), busy = 0, dirty = false, timer = null;
      function flush() { timer = null; if (!dirty) return; dirty = false; U.bt = null; if (host && !host.hidden && V.view !== 'stk') renderView(); }
      function next() {
        if (!q.length && !busy) { brokerDone(); return; }
        while (busy < 4 && q.length) {
          var c = q.shift(); busy++;
          A.loadReal(c).then(function (code) { return function (g) {
            busy--;
            if (g) { try { applyReal(U.by[code], g); _realDone++; dirty = true; } catch (e) { console.warn('[screener] real', code, e); } }
            if (!timer) timer = setTimeout(flush, 700);
            next();
          }; }(c));
        }
      }
      next();
    })();
  }
  function progress(f, txt) {
    if (!host) return;
    var el = host.querySelector('#sxView');
    if (!el) return;
    if (V.view !== 'stk') {
      el.innerHTML = '<div class="sx-load"><div class="sx-spin"></div><b>' + esc(txt) + '</b><div class="sx-pbar"><i style="width:' + Math.round(f * 100) + '%"></i></div></div>';
      return;
    }
    setStat(txt);
    if (!el.querySelector('#spWeb')) { el.innerHTML = '<div class="sp-webhost"><div class="sp-web" id="spWeb"></div></div>'; setTimeout(spWebStart, 0); }
  }

  // ─────────────────────────── Panduan (cara pakai & manfaat) ───────────────────────────
  var GUIDE = {
    stk: {
      title: 'StockPro', ico: 'layers', desc: 'Satu halaman: berita, swing, konsensus, valuasi, trade, broker, insider, dan kepemilikan untuk satu kode saham.',
      how: [['search', 'Ketik kode atau nama saham, lalu pilih dari daftar.'], ['bar', 'Tiap kartu memberi kesimpulan (hijau = positif, kuning = netral, merah = waspada) beserta alasannya.'], ['ext', 'Tombol di kartu membuka halaman aslinya (Dashboard, Konsensus, Valuasi, Tracker, Broker Activity) untuk saham yang sama.'], ['sliders', 'Skor berbobot: Trade ×5, Broker ×4, Insider ×3, Swing ×2, lalu Valuasi, Konsensus, Kepemilikan, Berita ×1. Layak dibeli bila skor ≥ +25, Hindari bila ≤ −25.']],
      why: [['target', 'Tidak perlu membuka 6 menu satu per satu untuk tahu keadaan satu saham.'], ['shield', 'Sinyal yang saling bertentangan langsung kelihatan, misalnya konsensus positif tapi broker besar menjual.'], ['info', 'Kesimpulan berasal dari aturan sederhana, bukan rekomendasi investasi. Keputusan tetap di tangan Anda.']]
    },
    cons: {
      title: 'Konsensus Analis', ico: 'target', desc: 'Seberapa jauh target harga analis dari harga sekarang, dan seberapa kompak mereka.',
      how: [['sliders', 'Pilih kesimpulan: Condong beli, Tunggu, atau Waspada.'], ['users', 'Atur minimal jumlah analis supaya saham dengan 1-2 rekomendasi tidak menyesatkan.'], ['bar', 'Batang hijau/abu/merah = porsi BUY/NEUTRAL/SELL. Potensi = target rata-rata dibanding harga sekarang.'], ['ext', 'Tombol Detail Konsensus membuka halaman Konsensus untuk saham itu.']],
      why: [['target', 'Satu layar untuk tahu saham mana yang masih punya ruang naik menurut analis.'], ['shield', 'Saham yang harganya sudah melewati target ditandai Waspada.'], ['info', 'Kesimpulan ini ringkasan aturan sederhana, bukan rekomendasi investasi.']]
    },
    news: {
      title: 'Headlines per Saham', ico: 'news', desc: 'Berita terbaru yang menyebut kode saham, dikelompokkan per saham.',
      how: [['cal', 'Pilih rentang: 24 jam, 7 hari, atau 30 hari.'], ['search', 'Cari kode saham atau nama perusahaan.'], ['ext', 'Ketuk judul untuk membuka beritanya di tab baru. Tombol di bawah tiap saham membuka Broker Activity atau Pasar Live.']],
      why: [['news', 'Tahu saham mana yang sedang ramai diberitakan tanpa membaca semua portal.'], ['spike', 'Saham dengan banyak berita sering diikuti lonjakan volume.'], ['info', 'Berita hanya dicocokkan lewat kode saham di judul, jadi berita tanpa kode tidak muncul di sini.']]
    },
    today: {
      title: 'Today', ico: 'today', desc: 'Ringkasan sinyal terbaru setelah penutupan pasar. Entry ideal di sesi berikutnya.',
      how: [['cal', 'Geser tanggal dengan tombol ‹ › untuk melihat sinyal hari-hari sebelumnya.'], ['star', 'Kartu Setup Preset diurutkan dari yang paling bagus hasilnya 3 bulan terakhir.'], ['target', 'Label akurasi membandingkan return 10 hari setelah sinyal dengan rata-rata semua saham.'], ['ext', 'Ketuk saham untuk membuka Broker Activity, atau "Lihat semua" untuk daftar lengkap di Gems.']],
      why: [['zap', 'Satu layar untuk tahu saham mana yang layak dipantau besok pagi.'], ['shield', 'Tahu preset mana yang sedang bekerja di kondisi pasar sekarang, bukan sekadar teori.'], ['lightbulb', 'Hemat waktu: tidak perlu membuka ratusan saham satu per satu.']]
    },
    gems: {
      title: 'Top Gems', ico: 'gem', desc: 'Skor gabungan 0-100 dari pola bandar, arus asing, dan teknikal.',
      how: [['star', 'Pilih preset: Bullish untuk kandidat beli, Risk untuk saham yang sebaiknya dihindari.'], ['sliders', 'Saring dengan Tier, kapitalisasi pasar, likuiditas, dan sektor.'], ['bar', 'Ketuk judul kolom yang punya tanda panah untuk mengurutkan.'], ['ext', 'Ketuk baris saham untuk membuka detail broker-nya.']],
      why: [['gem', 'Menyaring ratusan saham menjadi watchlist pendek yang punya alasan jelas.'], ['info', 'Kolom Evidence menjelaskan KENAPA saham itu muncul.'], ['alert', 'Preset risiko membantu keluar lebih awal dari saham yang sedang didistribusi.']]
    },
    accum: {
      title: 'Accumulation', ico: 'layers', desc: 'Posisi broker terbesar selama ±6 bulan: di harga berapa mereka mengumpulkan.',
      how: [['sliders', 'Pilih Quick Preset atau atur filter di panel (Top brokers, tren, broker rugi, dll).'], ['target', 'Floor = rata-rata harga beli broker. Harga sekarang di bawah floor berarti broker itu rugi (TRAPPED).'], ['flow', 'Daily Flow 10d memperlihatkan konsistensi beli/jual smart money per hari.'], ['bar', 'Tombol Profiler membuka Broker Activity saham itu.']],
      why: [['shield', 'Floor bandar sering menjadi area support alami, karena bandar cenderung menjaga harga di atas modalnya.'], ['users', 'Broker yang nyangkut (trapped) punya alasan untuk menaikkan harga.'], ['zap', 'Early Bird menemukan akumulasi yang baru mulai, sebelum ramai.']]
    },
    smart: {
      title: 'Smart Money Nampung Retail', ico: 'funnel', desc: 'Saham yang dikumpulkan smart money saat ritel menjual.',
      how: [['cal', 'Atur rentang tanggal (cepat: 1W, 2W, 1M, 3M) atau pilih tanggal sendiri.'], ['funnel', 'Nampung Retail = smart money net beli sementara ritel net jual.'], ['dollar', 'Smart Money P&L = apakah posisi smart money sedang untung atau nyangkut.'], ['info', 'Avg = harga rata-rata transaksi. P&L = harga terakhir dibanding avg.']],
      why: [['up', 'Pola absorpsi (ritel melepas, bandar menampung) sering mendahului kenaikan.'], ['shield', 'Smart money yang masih nyangkut cenderung menahan harga agar tidak turun jauh.'], ['users', 'Ritel di sini = Stockbit, Ajaib, IPOT, Mirae, Phillip, Valbury, MNC.']]
    },
    bh: {
      title: 'Broker & Holder', ico: 'users', desc: 'Jejak pihak terafiliasi: broker penjamin emisi, pemegang >5%, dan orang dalam.',
      how: [['users', 'Associate Broker = broker penjamin emisi (underwriter) saham tersebut.'], ['rotate', '"Balik arah saja" hanya menampilkan saham yang arahnya berubah dibanding periode sebelumnya.'], ['bank', 'Holder >5% dan Insider menampilkan perubahan kepemilikan terbaru lintas saham.'], ['ext', 'Ketuk baris untuk membuka saham.']],
      why: [['lightbulb', 'Pihak terafiliasi biasanya paling paham kondisi perusahaan.'], ['star', 'Perubahan pemegang besar adalah kepemilikan nyata, bukan sekadar transaksi harian.'], ['alert', 'Balik jual oleh associate broker bisa menjadi tanda awal distribusi.']]
    },
    foreign: {
      title: 'Foreign Flow', ico: 'globe', desc: 'Seberapa kuat, konsisten, dan cepat arus dana asing di tiap saham.',
      how: [['sliders', 'Pilih Akumulasi / Distribusi, periode, lalu preset (Senyap, Akselerasi, Big Money, Divergen).'], ['target', 'Skor 0-100 = intensitas (47%), konsistensi (29%), akselerasi (24%).'], ['radar', 'Radar Top 20: tabel saham yang berulang masuk 20 besar net asing harian. Ketuk baris untuk grafik dan detail harian.'], ['ext', 'Ketuk saham untuk detail.']],
      why: [['globe', 'Asing sering menjadi penggerak utama saham big cap.'], ['moon', 'Preset Senyap menemukan akumulasi asing di saham kecil-menengah sebelum harga bergerak.'], ['shield', 'Konsistensi dan akselerasi menyaring arus sesaat, misalnya satu transaksi besar yang hanya terjadi sekali.']]
    }
  };
  // Penjelasan ikon (i) per tampilan: fungsi, tujuan, dan cara pakai.
  var VIEW_TIP = {
    stk: 'Fungsi: merangkum semua analisis satu saham dalam satu halaman. Tujuan: membantu memutuskan langkah berikutnya tanpa membuka banyak menu. Cara pakai: cari kode saham, baca kesimpulan tiap kartu, lalu buka halaman aslinya bila perlu detail.',
    cons: 'Fungsi: membandingkan target harga rata-rata analis dengan harga sekarang dan menghitung porsi BUY/NEUTRAL/SELL. Tujuan: tahu saham mana yang masih punya ruang naik menurut analis. Cara pakai: pilih kesimpulan, atur minimal analis, lalu ketuk Detail Konsensus untuk melihat rekomendasi per firm.',
    news: 'Fungsi: mengelompokkan berita (headlines.json) berdasarkan kode saham yang disebut di judul. Tujuan: melihat saham yang sedang jadi sorotan media. Cara pakai: pilih rentang waktu, cari kode, lalu ketuk judul untuk membaca beritanya.',
    today: 'Fungsi: menampilkan sinyal saham terbaru setelah bursa tutup, plus preset yang paling sering benar. Tujuan: tahu saham mana yang layak dipantau untuk sesi berikutnya tanpa membuka ratusan saham. Cara pakai: geser tanggal dengan ‹ ›, lihat kartu Setup Preset, lalu ketuk saham untuk membuka Broker Activity.',
    gems: 'Fungsi: memberi skor gabungan 0-100 (pola bandar, arus asing, teknikal) untuk tiap saham, lalu memfilter dengan preset. Tujuan: menyaring ratusan saham jadi daftar pendek yang punya alasan jelas. Cara pakai: pilih preset Bullish (kandidat beli) atau Risk (hindari), atur Tier, kapitalisasi, dan likuiditas, lalu ketuk baris untuk detailnya.',
    accum: 'Fungsi: menunjukkan broker terbesar dan harga rata-rata beli mereka selama ±6 bulan. Tujuan: melihat di harga berapa pemain besar mengumpulkan, dan apakah mereka sedang untung atau nyangkut. Cara pakai: pilih Quick Preset atau atur filter (broker teratas, tren, broker rugi). Floor = rata-rata beli broker; harga di bawah floor berarti rugi (TRAPPED).',
    smart: 'Fungsi: mencari saham yang dikumpulkan smart money saat ritel menjual, dan menghitung P&L posisi mereka. Tujuan: menangkap fase pemain besar menampung dari ritel. Cara pakai: atur rentang tanggal (1W, 2W, 1M, 3M, atau pilih sendiri), lalu lihat Nampung Retail (smart money beli, ritel jual) dan P&L (untung atau nyangkut).',
    bh: 'Fungsi: menelusuri pihak terafiliasi: broker penjamin emisi (associate), pemegang saham di atas 5%, dan orang dalam. Tujuan: melihat siapa yang menambah atau mengurangi kepemilikan di belakang layar. Cara pakai: pilih Associate Broker, Holder >5%, atau Insider, lalu ketuk baris untuk membuka Broker Activity. Balik arah menampilkan saham yang arahnya berubah dibanding periode sebelumnya.',
    foreign: 'Fungsi: mengukur kekuatan, konsistensi, dan kecepatan arus asing per saham (skor 0-100 dari intensitas 47%, konsistensi 29%, dan akselerasi 24%). Tujuan: menemukan saham yang sedang diakumulasi atau dilepas asing. Cara pakai: pilih Akumulasi atau Distribusi, periode, lalu preset (Senyap, Akselerasi, Big Money, Divergen). Radar Top 20: tabel saham yang paling sering masuk 20 besar net asing harian, lengkap dengan heat peringkat per hari.'
  };
  function vhead(k, right) {
    var g = GUIDE[k], open = V.guide[k];
    return '<div class="sx-vhead">' +
      '<div class="sx-vtitle"><span class="sx-vico">' + ic(g.ico) + '</span><div><h3>' + esc(g.title) + ' ' + tip(VIEW_TIP[k] || g.desc) + '</h3><p>' + esc(g.desc) + '</p></div></div>' +
      '<div class="sx-vright">' + (right || '') +
        '<div class="sx-gbtns" role="group" aria-label="Panduan">' +
          '<button class="sx-gbtn' + (open === 'how' ? ' on' : '') + '" data-sx="guide" data-v="how" aria-expanded="' + (open === 'how') + '">' + ic('book') + '<span>Cara pakai</span></button>' +
          '<button class="sx-gbtn' + (open === 'why' ? ' on' : '') + '" data-sx="guide" data-v="why" aria-expanded="' + (open === 'why') + '">' + ic('target') + '<span>Manfaat</span></button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    (open ? '<div class="sx-guide ' + open + '">' +
      '<div class="sx-guide-h">' + ic(open === 'how' ? 'book' : 'target') + '<b>' + (open === 'how' ? 'Cara menggunakan' : 'Manfaatnya untuk Anda') + '</b>' +
        '<button class="sx-x" data-sx="guide" data-v="' + open + '" aria-label="Tutup">' + ic('x') + '</button></div>' +
      '<ol class="sx-guide-l">' + g[open].map(function (s, i) {
        return '<li><span class="n">' + (open === 'how' ? (i + 1) : ic('check')) + '</span><span class="gi">' + ic(s[0]) + '</span><span>' + esc(s[1]) + '</span></li>';
      }).join('') + '</ol></div>' : '');
  }
  function seg(act, items, cur, cls) {
    return '<div class="sx-seg' + (cls ? ' ' + cls : '') + '">' + items.map(function (x) {
      return '<button data-sx="' + act + '" data-v="' + esc(x[0]) + '"' + (String(x[0]) === String(cur) ? ' class="on"' : '') + '>' + x[1] + '</button>';
    }).join('') + '</div>';
  }
  function searchBox(id, val, ph) {
    return '<label class="sx-search">' + ic('search') + '<input id="' + id + '" value="' + esc(val || '') + '" placeholder="' + esc(ph) + '" autocomplete="off" enterkeyhint="search"></label>';
  }
  function matchQ(m, q) { if (!q) return true; q = q.toUpperCase(); return m.code.indexOf(q) === 0 || m.name.toUpperCase().indexOf(q) >= 0; }
  function stockCell(m, sub) {
    return '<button class="sx-stk" data-sx="open" data-v="' + esc(m.code) + '"><b>' + esc(m.code) + (m.realBroker ? '<i class="sx-real" data-smm-tip="Data broker asli (R2)">●</i>' : '') + '</b><small>' + esc(sub != null ? sub : m.name) + '</small></button>';
  }
  function more(act, shown, total, v) {
    if (shown >= total) return '';
    return '<button class="sx-more" data-sx="' + act + '"' + (v ? ' data-v="' + v + '"' : '') + '>Tampilkan lagi <small>(' + nf(total - shown) + ' tersisa)</small></button>';
  }
  function empty(t) { return '<div class="sx-empty">' + ic('search') + '<p>' + t + '</p></div>'; }

  // ─────────────────────────── 1. TODAY ───────────────────────────
  function viewToday() {
    var t = T0(), d = U.axis[t], bt = backtest();
    var acc = 0, dis = 0, fnet = 0, gold = 0;
    U.list.forEach(function (m) {
      if (!m.realBroker || !m.val[t]) return;
      var rg = regime(m, t); if (rg.k === 'acc') acc++; else if (rg.k === 'dist') dis++;
      fnet += sum(m.Pfn, t - 4, t);
      if (m.score[t] >= 65) gold++;
    });
    var aligned = [];
    U.list.forEach(function (m) {
      var s = [];
      if (presetHit(m, 'assoc', t)) s.push(['g', 'ASSOC BELI']);
      if (m.h5.some(function (e) { return e.t <= t && e.t > t - 25 && e.cur > e.prev; })) s.push(['p', 'HOLDER >5% NAMBAH']);
      if (m.ins.some(function (e) { return e.t <= t && e.t > t - 25 && e.act === 'BUY'; })) s.push(['b', 'INSIDER BELI']);
      if (s.length >= 2) aligned.push({ m: m, s: s });
    });
    aligned.sort(function (a, b) { return b.s.length - a.s.length || b.m.score[t] - a.m.score[t]; });

    var bulls = PRESETS.filter(function (p) { return !p.risk; }).sort(function (a, b) { return bt.st[b.k].excess - bt.st[a.k].excess; });
    var risks = PRESETS.filter(function (p) { return p.risk; });
    var good = bulls.filter(function (p) { var l = bt.st[p.k].label.k; return l === 'g' || l === 'gg'; });
    var verdict = good.length
      ? 'Preset terbaik 3 bulan terakhir: <b>' + esc(good[0].label) + '</b> (' + fp(bt.st[good[0].k].excess) + ' vs saham lain / ' + bt.H + ' hari). Rata-rata saham ' + fp(bt.mkt) + ' dalam 3 bulan.'
      : 'Belum ada preset yang jelas lebih baik dari saham lain (rata-rata saham ' + fp(bt.mkt) + ' dalam 3 bulan). Tiga teratas paling mendekati, anggap sebagai watchlist, bukan sinyal beli.';

    function card(p) {
      var s = bt.st[p.k], hits = U.list.filter(function (m) { return presetHit(m, p.k, t); })
        .sort(function (a, b) { return p.risk ? a.score[t] - b.score[t] : b.score[t] - a.score[t]; });
      return '<article class="sx-pcard' + (p.risk ? ' risk' : '') + '">' +
        '<header><span class="pi">' + ic(p.ico) + '</span><b>' + esc(p.label) + '</b><span class="sx-lbl ' + s.label.k + '">' + s.label.t + '</span></header>' +
        '<div class="ps mono">vs saham lain <b class="' + sc(s.excess) + '">' + fp(s.excess) + '</b> / ' + bt.H + ' hari · naik ' + nf(s.upPct, 0) + '% · ' + s.days + ' hari' +
          tip(s.cnt + ' sinyal dalam 3 bulan. Return rata-rata ' + bt.H + ' hari setelah sinyal ' + fp(s.avg) + ', dibanding rata-rata semua saham pada hari yang sama.') + '</div>' +
        '<p class="pd">' + esc(p.desc) + '</p>' +
        (hits.length ? '<div class="pl">' + hits.slice(0, 4).map(function (m) {
          var ch = (m.c[t] / m.c[t - 1] - 1) * 100, ev = evidence(m, t)[0];
          return '<button class="prow" data-sx="open" data-v="' + esc(m.code) + '"><span class="c">' + esc(m.code) + '</span>' +
            '<span class="nm"><small>' + esc(m.name) + '</small><em class="' + (ev && ev[0] === 'r' ? 'sx-dn' : 'sx-up') + '">' + esc(ev ? ev[1] : regime(m, t).label) + '</em></span>' +
            '<span class="pr mono"><b>' + px(m.c[t]) + '</b><small class="' + sc(ch) + '">' + fp(ch) + '</small></span></button>';
        }).join('') + '</div>' : '<div class="pl none">' + ic('moon') + 'Tidak ada saham yang memenuhi hari ini.</div>') +
        '<button class="pf" data-sx="topen" data-v="' + p.k + '">Lihat semua (' + hits.length + ') ' + ic('right') + '</button>' +
      '</article>';
    }

    var accTbl = V.acc ? '<div class="sx-tw"><table class="sx-tbl sx-acctbl"><thead><tr><th>Preset</th><th>Sinyal</th><th>Hari</th><th>Rata-rata ' + bt.H + 'h</th><th>vs saham lain</th><th>Naik</th><th>Penilaian</th></tr></thead><tbody>' +
      PRESETS.map(function (p) { var s = bt.st[p.k]; return '<tr><td class="l">' + ic(p.ico) + ' ' + esc(p.label) + '</td><td>' + nf(s.cnt) + '</td><td>' + s.days + '</td><td class="' + sc(s.avg) + '">' + fp(s.avg) + '</td><td class="' + sc(s.excess) + '">' + fp(s.excess) + '</td><td>' + nf(s.upPct, 0) + '%</td><td><span class="sx-lbl ' + s.label.k + '">' + s.label.t + '</span></td></tr>'; }).join('') +
      '</tbody></table></div><p class="sx-note">Backtest ' + bt.H + ' hari bursa ke depan pada setiap hari sinyal selama ±3 bulan. Hanya saham dengan data broker asli yang dihitung. Hasil masa lalu bukan janji hasil.</p>' : '';

    return vhead('today') +
      '<div class="sx-daynav">' +
        '<div><small class="sx-cap">Sinyal terbaru</small><div class="sx-dn-row">' +
          '<button class="sx-ib" data-sx="daynav" data-v="-1" ' + (V.asOf >= 9 ? 'disabled' : '') + ' aria-label="Hari sebelumnya">' + ic('left') + '</button>' +
          '<h2>' + esc(dLong(d)) + '</h2>' +
          '<button class="sx-ib" data-sx="daynav" data-v="1" ' + (V.asOf <= 0 ? 'disabled' : '') + ' aria-label="Hari berikutnya">' + ic('right') + '</button></div>' +
          '<small class="sx-mute">Data setelah penutupan · entry ideal sesi berikutnya</small></div>' +
        '<div class="sx-kpis">' +
          '<div><small>' + ic('up') + 'Diakumulasi</small><b class="sx-up">' + nf(acc) + '</b></div>' +
          '<div><small>' + ic('down') + 'Didistribusi</small><b class="sx-dn">' + nf(dis) + '</b></div>' +
          '<div><small>' + ic('globe') + 'Asing 5 hari</small><b class="' + sc(fnet) + '">' + fv(fnet) + '</b></div>' +
          '<div><small>' + ic('gem') + 'Gems Gold+</small><b>' + nf(gold) + '</b></div>' +
        '</div>' +
      '</div>' +
      '<section class="sx-box">' +
        '<div class="sx-bh"><h4>' + ic('users') + 'Associate Broker &amp; Pemegang Saham ' + tip('Associate broker = broker penjamin emisi saham ini. Kartu ini menampilkan saham yang associate-nya net beli dalam 5 hari terakhir, serta pemegang di atas 5% yang baru menambah. Ketuk baris untuk membuka Broker Activity saham itu.') + '</h4><button class="sx-link" data-sx="view" data-v="bh">Buka Broker &amp; Holder ' + ic('right') + '</button></div>' +
        '<p class="sx-center"><b>' + aligned.length + ' saham dengan sinyal searah minggu ini</b><br><small class="sx-mute">Associate broker, holder &gt;5%, dan insider, minimal 2 sinyal searah.</small></p>' +
        (aligned.length ? '<div class="sx-align">' + aligned.slice(0, 8).map(function (x) {
          return '<button class="sx-arow" data-sx="open" data-v="' + esc(x.m.code) + '"><b>' + esc(x.m.code) + '</b><small>' + esc(x.m.name) + '</small><span>' + chips(x.s) + '</span></button>';
        }).join('') + '</div>' : '') +
      '</section>' +
      '<section>' +
        '<div class="sx-bh"><h4>' + ic('star') + 'Setup Preset ' + tip('Fungsi: menampilkan preset sinyal (mis. Dual Confirmation, Block Absorption, Oversold Reversal) beserta jumlah saham yang memenuhinya hari ini. Tujuan: melihat setup mana yang sedang bekerja. Akurasi preset = rata-rata return 10 hari setelah sinyal dibanding rata-rata semua saham dalam 3 bulan terakhir.') + '</h4><button class="sx-btn' + (V.acc ? ' on' : '') + '" data-sx="tacc">' + ic('bar') + 'Akurasi preset</button></div>' +
        accTbl +
        '<div class="sx-verdict">' + ic('lightbulb') + '<span><b>Terbaik saat ini.</b> ' + verdict + '</span></div>' +
        '<div class="sx-pgrid3">' + bulls.map(card).join('') + '</div>' +
        '<h5 class="sx-sub">' + ic('alert') + 'Risiko: saham yang sebaiknya dihindari</h5>' +
        '<div class="sx-pgrid3 two">' + risks.map(card).join('') + '</div>' +
      '</section>';
  }

  // ─────────────────────────── 2. GEMS ───────────────────────────
  var CAPS = [['all', 'All'], ['100', '100T+'], ['20', '20-100T'], ['5', '5-20T'], ['1', '1-5T'], ['0', '<1T']];
  function capOk(m, k) {
    if (k === 'all') return true;
    var v = (m.mcap || m.shares * m.c[m.n - 1]) / 1e12;
    return k === '100' ? v >= 100 : k === '20' ? v >= 20 && v < 100 : k === '5' ? v >= 5 && v < 20 : k === '1' ? v >= 1 && v < 5 : v < 1;
  }
  function gemsRows() {
    var st = V.gems, t = T0();
    var rows = U.list.filter(function (m) {
      if (!presetHit(m, st.preset, t)) return false;
      if (st.tier && m.score[t] < st.tier) return false;
      if (!capOk(m, st.cap)) return false;
      var lq = liqOf(m, t).k;
      if (st.liq === 'high' && lq !== 'high') return false;
      if (st.liq === 'mid' && lq !== 'mid') return false;
      if (st.liq === 'low' && lq !== 'low' && lq !== 'vlow') return false;
      if (st.liq === 'excl' && (lq === 'low' || lq === 'vlow')) return false;
      if (st.sector && m.sector !== st.sector) return false;
      return matchQ(m, st.q);
    });
    var key = { score: function (m) { return m.score[t]; }, chg: function (m) { return m.c[t] / m.c[t - 1]; }, rsi: function (m) { return m.rsi[t]; }, sto: function (m) { return m.sto[t]; } }[st.sort];
    rows.sort(function (a, b) { return (key(a) - key(b)) * st.dir; });
    return rows;
  }
  function viewGems() {
    var st = V.gems, t = T0(), p = PRE_BY[st.preset];
    var cnt = {}; PRESETS.forEach(function (x) { cnt[x.k] = 0; });
    U.list.forEach(function (m) { PRESETS.forEach(function (x) { if (presetHit(m, x.k, t)) cnt[x.k]++; }); });
    function pbtn(x) { return '<button class="sx-pchip' + (x.risk ? ' risk' : '') + (st.preset === x.k ? ' on' : '') + '" data-sx="gpre" data-v="' + x.k + '">' + ic(x.ico) + esc(x.label) + '<em>' + cnt[x.k] + '</em></button>'; }
    var tierCnt = TIERS.slice().reverse().map(function (tr) { return [tr.min, esc(tr.label) + '+ <small>(' + tr.min + ')</small>']; });
    return vhead('gems',
        '<div class="sx-days">' + seg('asof', [[0, 'Today'], [1, '−1D'], [2, '−2D'], [3, '−3D']], V.asOf) + '</div>') +
      '<div class="sx-bar">' +
        '<div class="sx-res"><b>' + ic('gem') + 'TOP GEMS</b><span>Hasil <b id="sxGCount">-</b></span><span class="sx-mute">' + esc(dShort(U.axis[t])) + '</span></div>' +
        searchBox('sxGQ', st.q, 'Kode saham…') +
        '<select class="sx-sel" id="sxGSector" aria-label="Sektor"><option value="">Semua sektor</option>' + U.sectors.map(function (s) { return '<option' + (s === st.sector ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
      '</div>' +
      '<div class="sx-presets">' +
        '<div class="sx-prow"><span class="sx-tag g">BULLISH</span><div class="sx-hs">' + PRESETS.filter(function (x) { return !x.risk; }).map(pbtn).join('') + '</div></div>' +
        '<div class="sx-prow"><span class="sx-tag r">RISK</span><div class="sx-hs">' + PRESETS.filter(function (x) { return x.risk; }).map(pbtn).join('') + '</div></div>' +
        '<p class="sx-pdesc">' + ic(p.ico) + '<b>' + esc(p.label) + ':</b> ' + esc(p.desc) + '</p>' +
      '</div>' +
      '<div class="sx-filters">' +
        '<div class="sx-frow"><span class="sx-cap">Tier</span>' + seg('gtier', [[0, 'Any']].concat(tierCnt), st.tier, 'sm sx-hs') + '</div>' +
        '<div class="sx-frow"><span class="sx-cap">Mkt cap</span>' + seg('gcap', CAPS, st.cap, 'sm sx-hs') + '</div>' +
        '<div class="sx-frow"><span class="sx-cap">Likuiditas</span>' + seg('gliq', [['all', 'All'], ['high', 'High'], ['mid', 'Mid'], ['low', 'Low'], ['excl', 'Excl Low']], st.liq, 'sm sx-hs') + tip('Rata-rata nilai transaksi 20 hari. High ≥ Rp10 M, Mid Rp1-10 M, Low < Rp1 M.') + '</div>' +
      '</div>' +
      '<div id="sxBody"></div>';
  }
  function bodyGems() {
    var st = V.gems, t = T0(), rows = gemsRows(), show = rows.slice(0, st.limit);
    var cEl = host.querySelector('#sxGCount'); if (cEl) cEl.textContent = nf(rows.length);
    function th(k, label, tp) { var on = st.sort === k; return '<th class="s' + (on ? ' on' : '') + '" data-sx="gsort" data-v="' + k + '">' + label + ' <i>' + (on ? (st.dir < 0 ? '↓' : '↑') : '↕') + '</i>' + (tp ? tip(tp) : '') + '</th>'; }
    function lblR(v) { return v < 30 ? ['b', 'OVERSOLD'] : v > 70 ? ['y', 'OVERBOUGHT'] : ['n', 'NEUTRAL']; }
    function lblS(v) { return v < 20 ? ['b', 'OVERSOLD'] : v > 80 ? ['y', 'OVERBOUGHT'] : ['n', '']; }
    function tri(m) {
      return '<div class="sx-tri">' + [t - 2, t - 1, t].map(function (i) { var tr = tierOf(m.score[i]); return '<i style="background:' + (tr ? tr.color : 'var(--bg3)') + '" data-smm-tip="' + esc(dShort(U.axis[i]) + ': skor ' + nf(m.score[i], 1)) + '"></i>'; }).join('') + '</div>';
    }
    if (!rows.length) return empty('Tidak ada saham yang cocok. Longgarkan filter Tier, Mkt cap, atau Likuiditas.');
    var tbl = '<div class="sx-tw sx-desk"><table class="sx-tbl sx-gems"><thead><tr>' +
      '<th class="l">Stock</th>' + th('score', 'Gem score', 'Skor 0-100: 35% pola bandar 20 hari, 20% streak beli, 15% asing 5 hari, 15% RSI, 15% jarak dari harga tertinggi 20 hari. Tier: Bronze 35, Silver 50, Gold 65, Diamond 80.') +
      '<th>3D trend' + tip('Warna tier 3 hari terakhir (T-2, T-1, hari ini) dan perubahan skor dibanding T-2.') + '</th>' + th('chg', 'Price') + th('rsi', 'RSI-14') + th('sto', 'Stoch %K') +
      '<th class="l">Regime' + tip('Rezim smart money 20 hari. Persen = porsi hari net beli (akumulasi) atau net jual (distribusi) dari 10 hari terakhir. d = streak hari beruntun.') + '</th><th class="l">Evidence</th></tr></thead><tbody>' +
      show.map(function (m) {
        var s = m.score[t], tr = tierOf(s), d3 = s - m.score[t - 2], ch = (m.c[t] / m.c[t - 1] - 1) * 100, lq = liqOf(m, t), rg = regime(m, t);
        var rl = lblR(m.rsi[t]), sl = lblS(m.sto[t]);
        return '<tr data-sx="open" data-v="' + esc(m.code) + '">' +
          '<td class="l">' + stockCell(m, m.sector) + '<span class="sx-liq ' + lq.k + '">LIQ ' + lq.label + '</span></td>' +
          '<td><span class="sx-score ' + (tr ? tr.k : '') + '">' + nf(s, 1) + '</span><small class="sx-tier ' + (tr ? tr.k : '') + '">' + (tr ? tr.label.toUpperCase() : '—') + '</small></td>' +
          '<td>' + tri(m) + '<small class="' + sc(d3) + '">' + (d3 >= 0 ? '+' : '') + nf(d3, 1) + ' vs T-2</small></td>' +
          '<td><b>' + px(m.c[t]) + '</b><small class="' + sc(ch) + '">' + fp(ch, 2) + '</small><small class="sx-mute">' + nf(m.c[t] / m.hi20[t] * 100, 1) + '% of 20d hi</small></td>' +
          '<td><b class="sx-l-' + rl[0] + '">' + Math.round(m.rsi[t]) + '</b><small class="sx-l-' + rl[0] + '">' + rl[1] + '</small><span class="sx-mb ' + rl[0] + '"><i style="width:' + clamp(m.rsi[t], 2, 100) + '%"></i></span></td>' +
          '<td><b class="sx-l-' + sl[0] + '">' + Math.round(m.sto[t]) + '</b><small class="sx-l-' + sl[0] + '">' + (sl[1] || '&nbsp;') + '</small><span class="sx-mb ' + sl[0] + '"><i style="width:' + clamp(m.sto[t], 2, 100) + '%"></i></span></td>' +
          '<td class="l"><b class="sx-reg ' + rg.k + '">' + rg.label + '</b><small>' + rg.pct + '% • ' + Math.abs(m.st[t]) + 'd</small></td>' +
          '<td class="l"><div class="sx-evs">' + chips(evidence(m, t)) + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
    var cards = '<div class="sx-cards sx-mob">' + show.map(function (m) {
      var s = m.score[t], tr = tierOf(s), ch = (m.c[t] / m.c[t - 1] - 1) * 100, lq = liqOf(m, t), rg = regime(m, t);
      return '<div class="sx-mc" data-sx="open" data-v="' + esc(m.code) + '">' +
        '<div class="r1"><b class="c">' + esc(m.code) + '</b><span class="sx-liq ' + lq.k + '">' + lq.label + '</span>' + tri(m) + '<span class="sx-score ' + (tr ? tr.k : '') + '">' + nf(s, 1) + '</span></div>' +
        '<div class="r2"><small>' + esc(m.name) + '</small><span class="mono"><b>' + px(m.c[t]) + '</b> <em class="' + sc(ch) + '">' + fp(ch, 2) + '</em></span></div>' +
        '<div class="r3"><span>RSI <b>' + Math.round(m.rsi[t]) + '</b></span><span>Stoch <b>' + Math.round(m.sto[t]) + '</b></span><span class="sx-reg ' + rg.k + '">' + rg.label.slice(0, 5) + ' ' + rg.pct + '%</span></div>' +
        '<div class="sx-evs">' + chips(evidence(m, t)) + '</div></div>';
    }).join('') + '</div>';
    return tbl + cards + more('gmore', show.length, rows.length);
  }

  // ─────────────────────────── 3. ACCUMULATION ───────────────────────────
  var ACC_PRE = [
    { k: 'solid', label: 'Solid Accum', desc: 'Minimal 80% top broker masih menambah posisi 10 hari terakhir dan rata-rata PnL > −3%.' },
    { k: 'trapped', label: 'Trapped', desc: 'Minimal 60% top broker rugi (harga di bawah floor mereka).' },
    { k: 'deep', label: 'Deep Loss', desc: 'Rata-rata PnL top broker ≤ −8%. Bandar nyangkut dalam.' },
    { k: 'early', label: 'Early Bird', desc: 'Broker #1 baru mulai mengumpulkan ≤ 30 hari bursa sejak titik terendahnya.' },
    { k: 'wall', label: 'The Wall', desc: 'Satu broker menguasai ≥ 40% net top broker. Ada "tembok" pembeli dominan.' },
    { k: 'conv', label: 'Conviction', desc: 'Semua top broker masih menambah posisi dan sudah mengumpulkan ≥ 90 hari.' }
  ];
  function positions(m, all) {
    var key = all ? '_posA' : '_posR';
    if (m[key]) return m[key];
    var c = m.c[m.n - 1];
    m[key] = m.brokers.map(function (b) {
      var bv = b.w.bv + (all ? b.ng.bv : 0), sv = b.w.sv + (all ? b.ng.sv : 0), bl = b.w.bl + (all ? b.ng.bl : 0), sl = b.w.sl + (all ? b.ng.sl : 0);
      var aB = bl > 0 ? bv / (bl * 100) : 0, aS = sl > 0 ? sv / (sl * 100) : 0;
      return { code: b.code, name: b.name, type: b.type, net: bv - sv, netL: bl - sl, aB: aB, aS: aS,
        pB: aB ? (c / aB - 1) * 100 : 0, pS: aS ? (aS / c - 1) * 100 : 0, n10: b.n10, trough: b.trough, peak: b.peak };
    });
    return m[key];
  }
  function accEntry(m, st) {
    var dist = st.trend === 'dist', rows = positions(m, st.market === 'all').slice(), c = m.c[m.n - 1];
    rows.sort(dist ? function (a, b) { return a.net - b.net; } : function (a, b) { return b.net - a.net; });
    var top = rows.slice(0, st.top).filter(function (x) { return dist ? x.net < 0 : x.net > 0; });
    if (!top.length) return null;
    var sNet = 0, wL = 0, wP = 0, lose = 0, pSum = 0, al = 0;
    top.forEach(function (x) {
      var a = dist ? x.aS : x.aB, p = dist ? x.pS : x.pB;
      sNet += x.net; wL += Math.abs(x.netL); wP += a * Math.abs(x.netL); pSum += p; if (p < 0) lose++;
      x.tr = dist ? (x.n10 < 0 ? 'DISTRIBUTING' : 'REBUYING') : (x.n10 > 0 ? 'ACCUMULATING' : 'REDUCING');
      x.ok = dist ? x.n10 < 0 : x.n10 > 0; if (x.ok) al++;
      x.days = dist ? x.peak : x.trough; x.p = p; x.a = a;
    });
    var up = 0, dn = 0, pos = 0, neg = 0;
    rows.forEach(function (x) { if (x.net > 0) { up++; pos += x.net; } else if (x.net < 0) { dn++; neg -= x.net; } });
    if (!m.realBroker) { var f = m.nBk / Math.max(1, rows.length); up = Math.round(up * f); dn = Math.round(dn * f); }
    var floor = wL ? wP / wL : 0;
    return { m: m, top: top, net: sNet, floor: floor, fpct: floor ? (c / floor - 1) * 100 : 0, lose: lose, avgP: pSum / top.length, days: top[0].days,
      conc: Math.abs(top[0].net / sNet), al: al, up: up, dn: dn, ratio: neg ? pos / neg : 0, c: c };
  }
  function accRows() {
    var st = V.accum;
    var rows = [];
    U.list.forEach(function (m) {
      if (!matchQ(m, st.q)) return;
      var e = accEntry(m, st); if (!e) return;
      var N = e.top.length;
      if (st.minLose && e.lose < st.minLose) return;
      if (st.minLoss && !(e.avgP <= -st.minLoss)) return;
      if (st.maxDays && e.days > st.maxDays) return;
      if (st.minNet && e.top.some(function (x) { return Math.abs(x.net) < st.minNet; })) return;
      switch (st.preset) {
        case 'solid': if (!(e.al >= Math.ceil(N * 0.8) && e.avgP > -3)) return; break;
        case 'trapped': if (!(e.lose >= Math.ceil(N * 0.6))) return; break;
        case 'deep': if (!(e.avgP <= -8)) return; break;
        case 'early': if (!(e.days <= 30)) return; break;
        case 'wall': if (!(e.conc >= 0.4)) return; break;
        case 'conv': if (!(e.al === N && Math.min.apply(null, e.top.map(function (x) { return x.days; })) >= 90)) return; break;
      }
      rows.push(e);
    });
    var key = { net: function (e) { return Math.abs(e.net); }, trapped: function (e) { return e.lose; }, pnl: function (e) { return e.avgP; }, days: function (e) { return e.days; }, conc: function (e) { return e.conc; }, floor: function (e) { return e.fpct; } }[st.sort];
    rows.sort(function (a, b) { return (key(a) - key(b)) * st.dir; });
    return rows;
  }
  function viewAccum() {
    var st = V.accum, desk = !mq('(max-width:1099px)');
    var nAct = (st.preset ? 1 : 0) + (st.minLose ? 1 : 0) + (st.minLoss ? 1 : 0) + (st.maxDays ? 1 : 0) + (st.minNet ? 1 : 0);
    var NETS = [[0, 'Any'], [1e9, '≥ Rp1 M'], [1e10, '≥ Rp10 M'], [5e10, '≥ Rp50 M'], [1e11, '≥ Rp100 M'], [1e12, '≥ Rp1 T']];
    var pre = st.preset ? ACC_PRE.filter(function (x) { return x.k === st.preset; })[0] : null;
    var side = '<details class="sx-side"' + (desk ? ' open' : '') + '><summary>' + ic('sliders') + 'Filter &amp; preset' + (nAct ? ' <em>' + nAct + ' aktif</em>' : '') + '</summary><div class="sx-side-in">' +
      '<div class="sx-sg"><h6>Quick preset</h6><div class="sx-qp">' + ACC_PRE.map(function (x) { return '<button class="' + (st.preset === x.k ? 'on' : '') + '" data-sx="apre" data-v="' + x.k + '" data-smm-tip="' + esc(x.desc) + '">' + esc(x.label) + '</button>'; }).join('') + '</div></div>' +
      '<div class="sx-sg"><h6>Top brokers</h6>' + seg('atop', [[3, 'Top 3'], [5, 'Top 5'], [10, 'Top 10']], st.top, 'full') + '</div>' +
      '<div class="sx-sg"><h6>Tren 6 bulan ' + tip('Akumulasi = broker dengan net beli terbesar. Distribusi = broker dengan net jual terbesar; floor diganti harga rata-rata jual.') + '</h6>' + seg('atrend', [['acc', 'Akumulasi'], ['dist', 'Distribusi']], st.trend, 'full') + '</div>' +
      '<div class="sx-sg"><h6>Pasar ' + tip('Reguler = hanya transaksi pasar reguler. Semua = ditambah pasar negosiasi (blok).') + '</h6>' + seg('amkt', [['reg', 'Reguler'], ['all', 'Semua']], st.market, 'full') + '</div>' +
      '<div class="sx-sg"><h6>Min broker rugi</h6><input class="sx-in" type="number" inputmode="numeric" min="0" max="10" id="sxMinLose" value="' + (st.minLose || '') + '" placeholder="0"></div>' +
      '<div class="sx-sg"><h6>Min rata-rata rugi %</h6><input class="sx-in" type="number" inputmode="decimal" min="0" max="90" id="sxMinLoss" value="' + (st.minLoss || '') + '" placeholder="0"></div>' +
      '<div class="sx-sg"><h6>Maks hari sejak titik terendah</h6><input class="sx-in" type="number" inputmode="numeric" min="0" max="200" id="sxMaxDays" value="' + (st.maxDays || '') + '" placeholder="bebas"></div>' +
      '<div class="sx-sg"><h6>Min net / broker</h6><select class="sx-sel full" id="sxMinNet">' + NETS.map(function (x) { return '<option value="' + x[0] + '"' + (+x[0] === st.minNet ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>' +
      '<button class="sx-btn full" data-sx="areset">' + ic('rotate') + 'Reset filter</button>' +
    '</div></details>';
    return vhead('accum') +
      '<div class="sx-bar">' + seg('amode', [['pos', ic('layers') + 'Positioning <small>6 bln</small>'], ['flow', ic('bar') + 'Daily Flow <small>10 hari</small>']], st.mode, 'big') + '</div>' +
      '<div class="sx-acc-grid">' +
        '<div class="sx-acc-main">' +
          '<div class="sx-bar">' + searchBox('sxAQ', st.q, 'Cari kode…') +
            '<span class="sx-mute"><b id="sxACount">-</b> saham · ' + esc(dShort(U.axis[U.n - 1])) + '</span>' +
            '<span class="sx-grow"></span>' +
            '<label class="sx-sortl"><span class="sx-cap">Urut</span><select class="sx-sel" id="sxASort">' +
              [['net', 'Net value'], ['trapped', 'Broker rugi'], ['pnl', 'Rata-rata PnL'], ['floor', 'Harga vs floor'], ['days', 'Hari'], ['conc', 'Konsentrasi #1']].map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === st.sort ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') +
            '</select></label><button class="sx-btn" data-sx="adir">' + (st.dir < 0 ? 'DESC ↓' : 'ASC ↑') + '</button>' +
          '</div>' +
          (pre ? '<p class="sx-pdesc">' + ic('sliders') + '<b>' + esc(pre.label) + ':</b> ' + esc(pre.desc) + ' <button class="sx-link" data-sx="apre" data-v="' + pre.k + '">Hapus</button></p>' : '') +
          '<div id="sxBody"></div>' +
        '</div>' + side +
      '</div>';
  }
  function bodyAccum() {
    var st = V.accum, rows = accRows(), dist = st.trend === 'dist';
    var cEl = host.querySelector('#sxACount'); if (cEl) cEl.textContent = nf(rows.length);
    if (!rows.length) return empty('Tidak ada saham yang cocok dengan filter ini.');
    var show = rows.slice(0, st.limit);
    if (st.mode === 'flow') return flow10(show) + more('amore', show.length, rows.length);
    return '<div class="sx-acc-list">' + show.map(function (e) {
      var m = e.m, N = e.top.length, hot = e.lose >= Math.ceil(N * 0.6);
      return '<article class="sx-acc">' +
        '<header>' +
          '<button class="sx-acode" data-sx="open" data-v="' + esc(m.code) + '">' + esc(m.code) + ic('ext') + '</button>' +
          '<span class="sx-akv"><small>Current</small><b>' + px(e.c) + '</b></span>' +
          '<span class="sx-akv ' + sc(e.fpct) + '"><small>' + (dist ? 'Avg jual' : 'Floor') + '</small><b>' + px(e.floor) + ' <em>(' + fp(e.fpct) + ')</em></b></span>' +
          '<span class="sx-akv"><small>Net</small><b class="' + sc(e.net) + '">' + fv(e.net) + '</b></span>' +
          '<span class="sx-grow"></span>' +
          '<button class="sx-prof" data-sx="open" data-v="' + esc(m.code) + '">' + ic('bar') + 'Profiler</button>' +
          '<span class="sx-ud" data-smm-tip="Jumlah broker net beli ↑ / net jual ↓ selama 6 bulan, dan rasio total net beli dibanding net jual.">' + e.up + '↑/' + e.dn + '↓ (' + nf(e.ratio, 1) + 'x)</span>' +
          (dist ? '<span class="sx-trap ok" data-smm-tip="Broker yang menjual di atas harga sekarang (sudah aman).">' + (N - e.lose) + '/' + N + ' JUAL DI ATAS</span>'
            : '<span class="sx-trap' + (hot ? ' hot' : '') + '" data-smm-tip="Broker yang harga rata-rata belinya di atas harga sekarang (sedang rugi).">' + e.lose + '/' + N + ' TRAPPED</span>') +
        '</header>' +
        '<div class="sx-tw"><table class="sx-tbl sx-acct"><thead><tr><th class="hn">#</th><th class="l">Broker</th><th>' + (dist ? 'Avg jual' : 'Floor') + '</th><th>PnL</th><th class="hl">Net lot</th><th>Net val</th><th class="l">Recent trend</th><th>Days' + tip(dist ? 'Hari bursa sejak puncak kumulatif net (mulai menjual).' : 'Hari bursa sejak titik terendah kumulatif net (mulai mengumpulkan).') + '</th></tr></thead><tbody>' +
          e.top.map(function (x, i) {
            return '<tr><td class="hn sx-mute">' + (i + 1) + '</td><td class="l">' + bk(x.code, x.type, x.name) + '</td><td>' + px(x.a) + '</td><td class="' + sc(x.p) + '">' + fp(x.p) + '</td>' +
              '<td class="hl">' + fl(x.netL) + '</td><td class="' + sc(x.net) + '">' + fv(x.net) + '</td>' +
              '<td class="l"><span class="sx-trd ' + (x.ok ? (dist ? 'r' : 'g') : 'y') + '">' + x.tr + '</span></td><td>' + x.days + 'd</td></tr>';
          }).join('') +
        '</tbody></table></div></article>';
    }).join('') + '</div>' + more('amore', show.length, rows.length);
  }
  function flow10(list) {
    var n = U.n, days = []; for (var t = n - 10; t < n; t++) days.push(t);
    return '<div class="sx-tw sx-stick"><table class="sx-tbl sx-flow"><thead><tr><th class="l">Saham</th>' + days.map(function (t) { var o = dObj(U.axis[t]); return '<th>' + o.getUTCDate() + ' ' + MON[o.getUTCMonth()] + '</th>'; }).join('') + '<th>Total 10h</th><th class="l">Top broker</th></tr></thead><tbody>' +
      list.map(function (e) {
        var m = e.m, mx = 0, tot = 0;
        days.forEach(function (t) { mx = Math.max(mx, Math.abs(m.sm[t])); tot += m.sm[t]; });
        var tb = m.brokers.slice().sort(function (a, b) { return b.n10 - a.n10; })[V.accum.trend === 'dist' ? m.brokers.length - 1 : 0];
        return '<tr><td class="l">' + stockCell(m, null) + '</td>' + days.map(function (t) {
          var v = m.sm[t], a = mx ? Math.abs(v) / mx : 0;
          return '<td class="hc" style="--a:' + (0.1 + a * 0.75).toFixed(2) + '" data-k="' + (v > 0 ? 'g' : v < 0 ? 'r' : 'n') + '" data-smm-tip="' + esc(m.code + ' · ' + dShort(U.axis[t]) + ': smart money net ' + fv(v, true)) + '">' + (v ? fv(v) : '·') + '</td>';
        }).join('') + '<td class="' + sc(tot) + '"><b>' + fv(tot) + '</b></td><td class="l">' + (tb ? bk(tb.code, tb.type, tb.name) + ' <small class="' + sc(tb.n10) + '">' + fv(tb.n10) + '</small>' : '-') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // ─────────────────────────── 4. SMART MONEY ───────────────────────────
  var RNG = [['1W', '1W', 5], ['2W', '2W', 10], ['1M', '1M', 21], ['3M', '3M', 63]];
  function smRange() {
    var st = V.smart, n = U.n;
    if (st.a == null || st.b == null) { var k = (RNG.filter(function (x) { return x[0] === st.rng; })[0] || RNG[0])[2]; st.b = n - 1; st.a = Math.max(0, n - k); }
    return [Math.min(st.a, st.b), Math.max(st.a, st.b)];
  }
  function idxOfDate(d) { var ax = U.axis; for (var i = ax.length - 1; i >= 0; i--) if (ax[i] <= d) return i; return 0; }
  function rangeAgg(m, a, b) {
    var sB = 0, sS = 0, sBL = 0, sSL = 0, rB = 0, rS = 0, rBL = 0, rSL = 0, v = 0;
    for (var t = a; t <= b; t++) { sB += m.smB[t]; sS += m.smS[t]; sBL += m.smBL[t]; sSL += m.smSL[t]; rB += m.rtB[t]; rS += m.rtS[t]; rBL += m.rtBL[t]; rSL += m.rtSL[t]; v += m.val[t]; }
    var smN = sB - sS, rtN = rB - rS, c = m.c[b];
    var smA = smN >= 0 ? (sBL ? sB / (sBL * 100) : 0) : (sSL ? sS / (sSL * 100) : 0);
    var rtA = rtN >= 0 ? (rBL ? rB / (rBL * 100) : 0) : (rSL ? rS / (rSL * 100) : 0);
    return { m: m, smN: smN, rtN: rtN, smL: sBL - sSL, smA: smA, rtA: rtA, smP: smA ? (c / smA - 1) * 100 : 0, rtP: rtA ? (c / rtA - 1) * 100 : 0, val: v, c: c, int: v ? smN / v * 100 : 0 };
  }
  function viewSmart() {
    var st = V.smart, r = smRange();
    return vhead('smart') +
      '<div class="sx-bar">' + seg('smode', [['retail', ic('funnel') + 'Nampung Retail'], ['pl', ic('bank') + 'Smart Money P&amp;L']], st.mode, 'big') + '</div>' +
      '<div class="sx-box sx-smhead">' +
        '<div class="sx-smt"><h4>' + ic(st.mode === 'pl' ? 'bank' : 'funnel') + (st.mode === 'pl' ? 'Smart Money P&amp;L' : 'Smart Money Nampung Retail Scanner') + ' ' + tip(st.mode === 'pl' ? 'Fungsi: menghitung untung atau rugi posisi smart money di tiap saham. Tujuan: tahu apakah pemain besar masih untung (boleh lanjut menahan) atau nyangkut (berpotensi dilepas). Avg = harga rata-rata transaksi mereka; P&L = harga terakhir dibanding avg.' : 'Fungsi: menyaring saham yang smart money-nya net beli saat ritel net jual. Tujuan: menangkap fase pemain besar menampung dari ritel. Cara pakai: pilih rentang tanggal, lalu urutkan kolom Nampung Retail.') + '</h4>' +
          '<p class="sx-mute">' + (st.mode === 'pl' ? 'Posisi smart money pada rentang terpilih: masih untung atau nyangkut di harga sekarang.' : 'Mencari saham yang dikumpulkan smart money sementara ritel menjual.') + '</p></div>' +
        '<div class="sx-smc">' + searchBox('sxSQ', st.q, 'Cari kode…') +
          '<div class="sx-range">' + ic('cal') + '<input type="date" id="sxFrom" min="' + U.axis[0] + '" max="' + U.axis[U.n - 1] + '" value="' + U.axis[r[0]] + '" aria-label="Dari">' +
            '<span>→</span><input type="date" id="sxTo" min="' + U.axis[0] + '" max="' + U.axis[U.n - 1] + '" value="' + U.axis[r[1]] + '" aria-label="Sampai"></div>' +
          seg('srng', RNG.map(function (x) { return [x[0], x[1]]; }), st.rng, 'sm') +
        '</div>' +
      '</div>' +
      (st.mode === 'pl' ? '<div class="sx-bar">' + seg('spl', [['all', 'Semua'], ['win', ic('up') + 'SM untung'], ['lose', ic('down') + 'SM nyangkut']], st.pl, 'sm') + '</div>' : '') +
      '<div id="sxBody"></div>';
  }
  function bodySmart() {
    var st = V.smart, r = smRange(), pl = st.mode === 'pl';
    var rows = [];
    U.list.forEach(function (m) {
      if (!matchQ(m, st.q)) return;
      var x = rangeAgg(m, r[0], r[1]);
      if (!(x.smN > 0)) return;
      if (!pl && !(x.rtN < 0)) return;
      if (pl && st.pl === 'win' && !(x.smP >= 0)) return;
      if (pl && st.pl === 'lose' && !(x.smP < 0)) return;
      x.pnlRp = x.smL * 100 * (x.c - x.smA);
      rows.push(x);
    });
    var keys = { sm: 'smN', rt: 'rtN', smp: 'smP', rtp: 'rtP', int: 'int', rp: 'pnlRp' };
    var k = keys[st.sort] || 'smN';
    rows.sort(function (a, b) { return (a[k] - b[k]) * st.dir; });
    var show = rows.slice(0, st.limit);
    function th(key, label, cls, tp) { var on = st.sort === key; return '<th class="s' + (cls ? ' ' + cls : '') + (on ? ' on' : '') + '" data-sx="ssort" data-v="' + key + '">' + label + ' <i>' + (on ? (st.dir < 0 ? '↓' : '↑') : '↕') + '</i>' + (tp ? tip(tp) : '') + '</th>'; }
    var head = '<div class="sx-found">' + ic(pl ? 'bank' : 'funnel') + 'Ditemukan <b>' + nf(rows.length) + ' saham</b> ' + (pl ? 'dengan posisi smart money net beli' : 'dengan pola absorpsi') + ' · ' + esc(dShort(U.axis[r[0]])) + ' → ' + esc(dShort(U.axis[r[1]])) + '</div>';
    if (!rows.length) return head + empty('Tidak ada saham pada rentang ini.');
    var tbl, cards;
    if (!pl) {
      tbl = '<div class="sx-tw sx-desk sx-stick"><table class="sx-tbl sx-smt2"><thead><tr><th class="l">Saham</th>' +
        th('sm', 'Smart money<br>net', '', 'Total beli dikurangi jual semua broker non-ritel pada rentang terpilih.') + th('rt', 'Retail<br>net', '', 'Total beli dikurangi jual broker ritel.') +
        th('int', 'Kekuatan', 'l', 'Net smart money dibanding total transaksi saham itu pada rentang yang sama.') +
        th('smp', 'Smart money<br>avg / P&amp;L', '', 'Harga rata-rata beli smart money dan posisi harga terakhir terhadapnya.') + th('rtp', 'Retail<br>avg / P&amp;L', '', 'Harga rata-rata jual ritel dan posisi harga terakhir terhadapnya.') + '</tr></thead><tbody>' +
        show.map(function (x) {
          return '<tr data-sx="open" data-v="' + esc(x.m.code) + '"><td class="l">' + stockCell(x.m) + '</td><td class="sx-up"><b>' + fv(x.smN) + '</b></td><td class="sx-dn"><b>' + fv(x.rtN) + '</b></td>' +
            '<td class="l"><span class="sx-ab"><i style="width:' + clamp(x.int * 4, 3, 100) + '%"></i></span><small>' + nf(x.int, 1) + '% transaksi</small></td>' +
            '<td>' + px(x.smA) + '<small class="' + sc(x.smP) + '">' + fp(x.smP, 2) + '</small></td><td>' + px(x.rtA) + '<small class="' + sc(x.rtP) + '">' + fp(x.rtP, 2) + '</small></td></tr>';
        }).join('') + '</tbody></table></div>';
      cards = '<div class="sx-cards sx-mob">' + show.map(function (x) {
        return '<div class="sx-mc" data-sx="open" data-v="' + esc(x.m.code) + '"><div class="r1"><b class="c">' + esc(x.m.code) + '</b><small class="grow">' + esc(x.m.name) + '</small></div>' +
          '<div class="sx-split"><div><small>Smart money</small><b class="sx-up">' + fv(x.smN) + '</b><em>' + px(x.smA) + ' · <span class="' + sc(x.smP) + '">' + fp(x.smP, 2) + '</span></em></div>' +
          '<div><small>Retail</small><b class="sx-dn">' + fv(x.rtN) + '</b><em>' + px(x.rtA) + ' · <span class="' + sc(x.rtP) + '">' + fp(x.rtP, 2) + '</span></em></div></div>' +
          '<span class="sx-ab"><i style="width:' + clamp(x.int * 4, 3, 100) + '%"></i></span></div>';
      }).join('') + '</div>';
    } else {
      tbl = '<div class="sx-tw sx-desk sx-stick"><table class="sx-tbl sx-smt2"><thead><tr><th class="l">Saham</th>' +
        th('sm', 'Posisi SM<br>net') + '<th>Avg beli SM</th><th>Harga</th>' + th('smp', 'P&amp;L %') + th('rp', 'Est. P&amp;L', '', 'Perkiraan untung/rugi belum terealisasi = net lot × 100 × (harga − avg beli).') + '<th class="l">Status</th>' + th('rtp', 'Retail P&amp;L') + '</tr></thead><tbody>' +
        show.map(function (x) {
          var w = x.smP >= 0;
          return '<tr data-sx="open" data-v="' + esc(x.m.code) + '"><td class="l">' + stockCell(x.m) + '</td><td class="sx-up"><b>' + fv(x.smN) + '</b></td><td>' + px(x.smA) + '</td><td>' + px(x.c) + '</td>' +
            '<td class="' + sc(x.smP) + '"><b>' + fp(x.smP, 2) + '</b></td><td class="' + sc(x.pnlRp) + '">' + fv(x.pnlRp) + '</td>' +
            '<td class="l"><span class="sx-trd ' + (w ? 'g' : 'r') + '">' + (w ? 'UNTUNG' : 'NYANGKUT') + '</span></td><td class="' + sc(x.rtP) + '">' + fp(x.rtP, 2) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
      cards = '<div class="sx-cards sx-mob">' + show.map(function (x) {
        var w = x.smP >= 0;
        return '<div class="sx-mc" data-sx="open" data-v="' + esc(x.m.code) + '"><div class="r1"><b class="c">' + esc(x.m.code) + '</b><small class="grow">' + esc(x.m.name) + '</small><span class="sx-trd ' + (w ? 'g' : 'r') + '">' + (w ? 'UNTUNG' : 'NYANGKUT') + '</span></div>' +
          '<div class="r3"><span>Net <b class="sx-up">' + fv(x.smN) + '</b></span><span>Avg <b>' + px(x.smA) + '</b></span><span>Harga <b>' + px(x.c) + '</b></span></div>' +
          '<div class="r3"><span>P&amp;L <b class="' + sc(x.smP) + '">' + fp(x.smP, 2) + '</b></span><span>Est. <b class="' + sc(x.pnlRp) + '">' + fv(x.pnlRp) + '</b></span></div></div>';
      }).join('') + '</div>';
    }
    return head + tbl + cards + more('smore', show.length, rows.length);
  }

  // ─────────────────────────── 5. BROKER & HOLDER ───────────────────────────
  var BH_PER = { '1D': 1, '1W': 5, '1M': 21 };
  var H_PER = { '1M': 25, '3M': 70 };
  function viewBH() {
    var st = V.bh, n = U.n, isA = st.mode === 'assoc';
    var k = isA ? BH_PER[st.per] : H_PER[st.hper], a = Math.max(0, n - k);
    return vhead('bh', '<span class="sx-dr">' + ic('cal') + esc(dShort(U.axis[a])) + ' – ' + esc(dShort(U.axis[n - 1])) + '</span>') +
      '<div class="sx-bar">' + seg('bmode', [['assoc', ic('users') + 'Associate Broker'], ['h5', ic('bank') + 'Holder &gt;5%'], ['ins', ic('user') + 'Insider']], st.mode, 'big') + '</div>' +
      '<div class="sx-bar">' +
        (isA ? seg('bper', [['1D', '1D'], ['1W', '1W'], ['1M', '1M']], st.per, 'sm') + seg('bflip', [['0', 'Semua'], ['1', ic('rotate') + 'Balik arah saja']], st.flip ? '1' : '0', 'sm')
          : seg('bhper', [['1M', '1 bulan'], ['3M', '3 bulan']], st.hper, 'sm')) +
        '<span class="sx-grow"></span>' + searchBox('sxBQ', st.q, 'Kode saham / broker / nama') +
      '</div>' +
      '<p class="sx-note">' + (isA ? 'Broker penjamin emisi (underwriter) yang terkait saham ini: net beli (akumulasi) vs net jual (distribusi) di pasar reguler. "Balik arah" = arah berubah dibanding periode sebelumnya. Klik baris untuk membuka Broker Activity.'
        : st.mode === 'h5' ? 'Perubahan porsi pemegang saham ≥ 5% per akhir bulan (data KSEI). Kiri = menambah, kanan = mengurangi.'
        : 'Transaksi direksi, komisaris, dan pengendali yang dilaporkan ke IDX / KSEI. Kiri = beli, kanan = jual.') + '</p>' +
      '<div id="sxBody"></div>';
  }
  function bodyBH() {
    var st = V.bh, n = U.n, q = (st.q || '').toUpperCase(), L = [], R = [];
    function qOk(m, extra) { return !q || m.code.indexOf(q) === 0 || m.name.toUpperCase().indexOf(q) >= 0 || (extra || '').toUpperCase().indexOf(q) >= 0; }
    if (st.mode === 'assoc') {
      var k = BH_PER[st.per], a = n - k, pa = Math.max(0, a - k);
      U.list.forEach(function (m) {
        if (m.asc < 0) return;
        var b = m.brokers[m.asc];
        if (!qOk(m, b.code)) return;
        var net = sum(m.Pasc, a, n - 1), prev = sum(m.Pasc, pa, a - 1); if (!net) return;
        var flip = prev !== 0 && (net > 0) !== (prev > 0);
        if (st.flip && !flip) return;
        var nb = 0, ns = 0, bvs = 0, val = sum(m.Pval, a, n - 1);
        for (var t = a; t < n; t++) { if (m.ascN[t] > 0) nb++; else if (m.ascN[t] < 0) ns++; bvs += m.ascBv[t]; }
        var nets = m.brokers.map(function (x) { var s = 0; for (var t2 = a; t2 < n; t2++) s += x.nv[t2]; return s; });
        var rank = 1 + nets.filter(function (x) { return net > 0 ? x > net : x < net; }).length;
        var row = { m: m, b: b, net: net, prev: prev, flip: flip, nb: nb, ns: ns, rank: rank, porsi: val ? bvs / val * 100 : 0, chg: (m.c[n - 1] / m.c[Math.max(0, a - 1)] - 1) * 100 };
        (net > 0 ? L : R).push(row);
      });
      L.sort(function (x, y) { return y.net - x.net; }); R.sort(function (x, y) { return x.net - y.net; });
      var row = function (x) {
        return '<button class="sx-brow" data-sx="open" data-v="' + esc(x.m.code) + '">' +
          '<span class="a"><b class="c">' + esc(x.m.code) + '</b>' + (x.flip ? '<span class="sx-flip ' + (x.net > 0 ? 'g' : 'r') + '">BALIK ' + (x.net > 0 ? 'BELI' : 'JUAL') + '</span>' : '') + '<small class="nm">' + esc(x.m.name) + '</small>' +
            '<small class="meta">' + bk(x.b.code, x.b.type, x.b.name) + ' · #' + x.rank + ' ' + (x.net > 0 ? 'beli' : 'jual') + '/' + x.m.nBk + ' · ' + x.nb + 'B/' + x.ns + 'S hari · porsi ' + nf(x.porsi, 1) + '%</small></span>' +
          '<span class="v mono"><b class="' + sc(x.net) + '">' + (x.net > 0 ? '+' : '') + fv(x.net) + '</b><small>lalu <em class="' + sc(x.prev) + '">' + (x.prev > 0 ? '+' : '') + fv(x.prev) + '</em></small></span>' +
          '<span class="p mono ' + sc(x.chg) + '">' + fp(x.chg) + '</span></button>';
      };
      return cols2('AKUMULASI', 'net beli', L, 'DISTRIBUSI', 'net jual', R, row);
    }
    var lim = H_PER[st.hper], t0 = n - lim;
    if (st.mode === 'h5') {
      U.list.forEach(function (m) {
        m.h5.forEach(function (e) {
          if (e.t < t0 || !qOk(m, e.name)) return;
          var x = { m: m, e: e, d: e.cur - e.prev };
          (x.d > 0 ? L : R).push(x);
        });
      });
      L.sort(function (a, b) { return b.d - a.d; }); R.sort(function (a, b) { return a.d - b.d; });
      return cols2('MENAMBAH', 'perubahan', L, 'MENGURANGI', 'perubahan', R, function (x) {
        return '<button class="sx-brow" data-sx="open" data-v="' + esc(x.m.code) + '"><span class="a"><b class="c">' + esc(x.m.code) + '</b><small class="nm">' + esc(x.m.name) + '</small>' +
          '<small class="meta">' + ic('bank') + esc(x.e.name) + ' · ' + esc(dShort(U.axis[x.e.t])) + '</small></span>' +
          '<span class="v mono"><b class="' + sc(x.d) + '">' + (x.d > 0 ? '+' : '') + nf(x.d, 2) + ' pp</b><small>' + nf(x.e.prev, 2) + '% → ' + nf(x.e.cur, 2) + '%</small></span></button>';
      });
    }
    U.list.forEach(function (m) {
      m.ins.forEach(function (e) {
        if (e.t < t0 || !qOk(m, e.name)) return;
        (e.act === 'BUY' ? L : R).push({ m: m, e: e });
      });
    });
    L.sort(function (a, b) { return b.e.value - a.e.value; }); R.sort(function (a, b) { return b.e.value - a.e.value; });
    return cols2('BELI', 'insider', L, 'JUAL', 'insider', R, function (x) {
      return '<button class="sx-brow" data-sx="open" data-v="' + esc(x.m.code) + '"><span class="a"><b class="c">' + esc(x.m.code) + '</b><small class="nm">' + esc(x.m.name) + '</small>' +
        '<small class="meta">' + ic('user') + esc(x.e.name) + ' <span class="sx-role">' + esc(x.e.role) + '</span> · ' + esc(dShort(U.axis[x.e.t])) + '</small></span>' +
        '<span class="v mono"><b class="' + (x.e.act === 'BUY' ? 'sx-up' : 'sx-dn') + '">' + fv(x.e.value, true) + '</b><small>' + fl(x.e.shares) + ' lbr @ ' + px(x.e.price) + '</small></span></button>';
    });
  }
  function cols2(lt, ls, L, rt, rs, R, row) {
    var st = V.bh;
    function col(side, title, s, arr, cls) {
      var lim = st.lim[side];
      return '<section class="sx-col"><header><b class="' + cls + '">' + ic(cls === 'sx-up' ? 'up' : 'down') + title + '</b><small>' + nf(arr.length) + ' saham · ' + s + '</small></header>' +
        (arr.length ? arr.slice(0, lim).map(row).join('') + more('bmore', Math.min(lim, arr.length), arr.length, side) : empty('Belum ada data.')) + '</section>';
    }
    return '<div class="sx-cols2">' + col('a', lt, ls, L, 'sx-up') + col('d', rt, rs, R, 'sx-dn') + '</div>';
  }

  // ─────────────────────────── 6. FOREIGN ───────────────────────────
  var FX_PER = { '1D': 1, '7D': 5, '30D': 21, '60D': 42 };
  var FX_PRE = [
    ['all', 'Semua', ''], ['quiet', 'Senyap (Small/Mid)', 'moon'],
    ['accel', 'Akselerasi', 'zap'], ['big', 'Big Money', 'bank'], ['div', 'Divergen', 'split']
  ];
  var FX_DESC = {
    all: 'Semua saham sesuai arah dan filter.', quiet: 'Kapitalisasi < Rp20 T dan harga relatif diam (±3%) walau asing aktif.',
    accel: 'Rata-rata harian paruh terakhir periode ≥ 2× paruh sebelumnya.',
    big: 'Net asing ≥ Rp10 M pada periode ini.', div: 'Asing membeli saat harga turun (atau menjual saat harga naik).'
  };
  function fxRows() {
    var st = V.foreign, n = U.n, k = FX_PER[st.per], a = Math.max(0, n - k), dist = st.side === 'dist', h = Math.max(1, Math.floor(k / 2));
    var rows = [];
    U.list.forEach(function (m) {
      if (a - 1 < m.first) return;
      var net = sum(m.Pfn, a, n - 1), val = sum(m.Pval, a, n - 1);
      if (!val || (dist ? net >= 0 : net <= 0)) return;
      var days = 0, pos = 0;
      for (var t = a; t < n; t++) { if (!m.val[t]) continue; days++; if (dist ? m.fn[t] < 0 : m.fn[t] > 0) pos++; }
      var r1 = sum(m.Pfn, n - h, n - 1) / h, r0 = k > 1 ? sum(m.Pfn, a, n - h - 1) / Math.max(1, k - h) : 0;
      if (dist) { r1 = -r1; r0 = -r0; }
      var accel = r0 > 0 ? r1 / r0 : r1 > 0 ? 99 : 0;
      var ff = m.shares * (m.ff || 0.3);
      var netL = 0; for (var t3 = a; t3 < n; t3++) netL += m.fBL[t3] - m.fSL[t3];
      var streak = Math.abs(m.fst[n - 1]);
      rows.push({ m: m, net: net, int: net / val * 100, ffp: ff ? netL * 100 / ff * 100 : 0, cons: days ? pos / days * 100 : 0,
        streak: (dist ? m.fst[n - 1] < 0 : m.fst[n - 1] > 0) ? streak : 0, accel: accel,
        chg: (m.c[n - 1] / m.c[Math.max(0, a - 1)] - 1) * 100, liq: avgVal(m, n - 1, 20) });
    });
    // skor: persentil intensitas & akselerasi dalam universe periode ini
    function pct(key) { var s = rows.map(function (x) { return Math.abs(x[key]); }).sort(function (x, y) { return x - y; }); return function (v) { var lo = 0, hi = s.length; while (lo < hi) { var md = (lo + hi) >> 1; if (s[md] < v) lo = md + 1; else hi = md; } return s.length ? lo / s.length : 0; }; }
    var pI = pct('int'), pA = pct('accel');
    rows.forEach(function (x) { x.score = Math.round(100 * (0.47 * pI(Math.abs(x.int)) + 0.29 * x.cons / 100 + 0.24 * pA(Math.abs(x.accel)))); });
    var all = rows.slice();
    rows = rows.filter(function (x) {
      if (!matchQ(x.m, st.q)) return false;
      if (st.liq && x.liq < st.liq) return false;
      switch (st.preset) {
        case 'quiet': return (x.m.mcap || x.m.shares * x.m.c[n - 1]) < 2e13 && Math.abs(x.chg) < 3;
        case 'accel': return x.accel >= 2;
        case 'big': return Math.abs(x.net) >= 1e10;
        case 'div': return dist ? x.chg > 0 : x.chg < 0;
      }
      return true;
    });
    var key = { score: 'score', int: 'int', ffp: 'ffp', cons: 'cons', accel: 'accel', net: 'net', chg: 'chg' }[st.sort] || 'score';
    var sgn = dist && (key === 'int' || key === 'ffp' || key === 'net') ? -1 : 1;
    rows.sort(function (x, y) { return (x[key] - y[key]) * st.dir * sgn; });
    return { rows: rows, all: all, a: a };
  }
  function viewForeign() {
    var st = V.foreign, rad = st.mode === 'radar';
    return vhead('foreign') +
      '<div class="sx-bar">' + seg('fmode', [['int', ic('target') + 'Flow Intensity'], ['radar', ic('radar') + 'Radar <small>Top 20</small>']], st.mode, 'big') + ' ' + tip('Flow Intensity = tabel saham diurutkan menurut skor arus asing. Radar Top 20 = tabel saham yang berulang masuk 20 besar net asing harian: heat peringkat per hari, jumlah hari masuk Top 20, rata-rata peringkat, total net asing, dan return harga. Ketuk baris untuk grafik dan detail harian.') + '</div>' +
      '<div class="sx-bar">' + seg('fside', [['acc', ic('up') + 'Akumulasi'], ['dist', ic('down') + 'Distribusi']], st.side, 'side') +
        (rad ? '' : '<div class="sx-hs sx-fpre">' + FX_PRE.map(function (p) { return '<button class="sx-pchip' + (st.preset === p[0] ? ' on' : '') + '" data-sx="fpre" data-v="' + p[0] + '" data-smm-tip="' + esc(FX_DESC[p[0]]) + '">' + (p[2] ? ic(p[2]) : '') + esc(p[1]) + '</button>'; }).join('') + '</div>') +
      '</div>' +
      '<div class="sx-bar">' + searchBox('sxFQ', st.q, 'Cari kode / nama…') +
        (rad
          ? '<label class="sx-lab"><span class="sx-cap">Hari trading</span>' + seg('rd', [[5, '5'], [7, '7'], [10, '10']], st.rd, 'sm') + '</label>'
          : '<label class="sx-lab"><span class="sx-cap">Periode</span>' + seg('fper', [['1D', '1D'], ['7D', '7D'], ['30D', '30D'], ['60D', '60D']], st.per, 'sm') + '</label>' +
            '<label class="sx-lab"><span class="sx-cap">Likuid ≥</span><select class="sx-sel" id="sxFLiq">' + [[0, 'Semua'], [1e9, 'Rp1 M'], [5e9, 'Rp5 M'], [1e10, 'Rp10 M'], [5e10, 'Rp50 M']].map(function (x) { return '<option value="' + x[0] + '"' + (+x[0] === st.liq ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label>' +
            '<label class="sx-lab"><span class="sx-cap">Tampil</span><select class="sx-sel" id="sxFShow">' + [20, 50, 100, 200].map(function (x) { return '<option' + (x === st.show ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label>') +
      '</div>' +
      '<div id="sxBody"></div>';
  }
  function bodyForeign() {
    if (V.foreign.mode === 'radar') return bodyRadar();
    var st = V.foreign, R = fxRows(), rows = R.rows, n = U.n, dist = st.side === 'dist';
    var head = '<div class="sx-found">' + ic('globe') + '<b>' + nf(rows.length) + '</b> saham · ' + esc(dShort(U.axis[R.a])) + ' s/d ' + esc(dShort(U.axis[n - 1])) + '</div>';
    if (!rows.length) return head + empty('Tidak ada saham yang cocok.');
    var show = rows.slice(0, st.show), mxI = 0;
    show.forEach(function (x) { mxI = Math.max(mxI, Math.abs(x.int)); });
    function th(k, label, tp, cls) { var on = st.sort === k; return '<th class="s' + (cls ? ' ' + cls : '') + (on ? ' on' : '') + '" data-sx="fsort" data-v="' + k + '">' + label + ' <i>' + (on ? (st.dir < 0 ? '↓' : '↑') : '↕') + '</i>' + (tp ? tip(tp) : '') + '</th>'; }
    var tbl = '<div class="sx-tw sx-desk sx-stick"><table class="sx-tbl sx-fx"><thead><tr><th class="l">Saham</th>' +
      th('score', 'Skor', 'Skor 0-100 dari tiga komponen: intensitas arus asing 47%, konsistensi arah harian 29%, dan akselerasi 24%. Makin tinggi, arus asing makin kuat dan konsisten.') +
      th('int', 'Intensitas', 'Net asing dibanding total nilai transaksi saham itu pada periode ini.', 'l') +
      th('ffp', 'Float%', 'Net lot asing dibanding jumlah saham free float.') +
      th('cons', 'Konsisten', 'Persentase hari bursa dengan arah yang sama (net beli untuk akumulasi).') +
      th('accel', 'Akselerasi', 'Rata-rata harian paruh akhir periode dibanding paruh awal. ▲ 2,0 = dua kali lebih kencang.') +
      th('net', 'Net') + th('chg', 'Harga%') + '</tr></thead><tbody>' +
      show.map(function (x) {
        return '<tr data-sx="open" data-v="' + esc(x.m.code) + '"><td class="l">' + stockCell(x.m) + '</td>' +
          '<td><span class="sx-fs' + (x.score >= 85 ? ' hot' : x.score >= 70 ? ' warm' : '') + '">' + x.score + '</span></td>' +
          '<td class="l"><span class="sx-ib2"><i class="' + (dist ? 'r' : 'g') + '" style="width:' + clamp(Math.abs(x.int) / (mxI || 1) * 100, 4, 100) + '%"></i></span><b class="' + sc(x.int) + '">' + fp(x.int) + '</b></td>' +
          '<td class="sx-pu">' + fp(x.ffp, 2) + '</td>' +
          '<td><b>' + nf(x.cons, 0) + '%</b>' + (x.streak >= 5 ? '<small class="sx-y">' + x.streak + ' hari beruntun</small>' : '') + '</td>' +
          '<td class="' + (x.accel >= 1 ? 'sx-up' : 'sx-dn') + '">' + (x.accel >= 1 ? '▲ ' : '▼ ') + (x.accel >= 99 ? 'baru' : nf(x.accel, 1)) + '</td>' +
          '<td class="' + sc(x.net) + '"><b>' + (x.net > 0 ? '+' : '') + fv(x.net) + '</b></td><td class="' + sc(x.chg) + '">' + fp(x.chg) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    var cards = '<div class="sx-cards sx-mob">' + show.map(function (x) {
      return '<div class="sx-mc" data-sx="open" data-v="' + esc(x.m.code) + '"><div class="r1"><b class="c">' + esc(x.m.code) + '</b><small class="grow">' + esc(x.m.name) + '</small><span class="sx-fs' + (x.score >= 85 ? ' hot' : x.score >= 70 ? ' warm' : '') + '">' + x.score + '</span></div>' +
        '<div class="r2"><span class="sx-ib2 w"><i class="' + (dist ? 'r' : 'g') + '" style="width:' + clamp(Math.abs(x.int) / (mxI || 1) * 100, 4, 100) + '%"></i></span><b class="' + sc(x.int) + ' mono">' + fp(x.int) + '</b></div>' +
        '<div class="r3"><span>Net <b class="' + sc(x.net) + '">' + fv(x.net) + '</b></span><span>Konsisten <b>' + nf(x.cons, 0) + '%</b></span><span>Akselerasi <b class="' + (x.accel >= 1 ? 'sx-up' : 'sx-dn') + '">' + (x.accel >= 99 ? 'baru' : nf(x.accel, 1)) + '</b></span></div>' +
        '<div class="r3"><span>Float <b class="sx-pu">' + fp(x.ffp, 2) + '</b></span><span>Harga <b class="' + sc(x.chg) + '">' + fp(x.chg) + '</b></span></div></div>';
    }).join('') + '</div>';
    return head + tbl + cards;
  }
  // ── Radar Top 20: peringkat net asing harian, saham yang berulang masuk Top 20 ──
  var RD_TOP = 20, RD_MIN = 3;
  function dDM(t) { var o = dObj(U.axis[t]); return o.getUTCDate() + ' ' + MON[o.getUTCMonth()]; }
  function rdLbl(i, d) { return 'D' + (i - (d - 1) === 0 ? '0' : String(i - (d - 1))); }
  function rdK(r) { return r <= 3 ? 'k1' : r <= 10 ? 'k2' : 'k3'; }
  function rdData() {
    var st = V.foreign, n = U.n, d = Math.min(st.rd, n), a = n - d, dist = st.side === 'dist', by = {}, t;
    for (t = a; t < n; t++) {
      var arr = [];
      for (var q = 0; q < U.list.length; q++) {
        var m = U.list[q];
        if (t < m.first || !m.val[t]) continue;
        var v = m.fn[t];
        if (dist ? v < 0 : v > 0) arr.push([m, v]);
      }
      arr.sort(function (x, y) { return dist ? x[1] - y[1] : y[1] - x[1]; });
      for (var r = 0; r < arr.length && r < RD_TOP; r++) {
        var cd = arr[r][0].code, o = by[cd] || (by[cd] = { m: arr[r][0], rk: new Array(d) });
        o.rk[t - a] = r + 1;
      }
    }
    var rows = [];
    Object.keys(by).forEach(function (cd) {
      var o = by[cd], m = o.m, cnt = 0, rs = 0, run = 0, best = 0, net = 0, i;
      for (i = 0; i < d; i++) {
        var rk = o.rk[i];
        if (rk) { cnt++; rs += rk; run++; if (run > best) best = run; } else run = 0;
        net += m.fn[a + i];
      }
      if (cnt < Math.min(RD_MIN, d)) return;
      var c0 = m.c[Math.max(0, a - 1)];
      rows.push({ m: m, rk: o.rk, cnt: cnt, avg: rs / cnt, run: best, net: net, ret: c0 ? (m.c[n - 1] / c0 - 1) * 100 : 0 });
    });
    return { rows: rows, a: a, n: n, d: d, dist: dist };
  }
  function rdChart(o, R) {
    var m = o.m, a = R.a, d = R.d, W = 520, H = 190, P = { l: 54, r: 54, t: 14, b: 26 }, i;
    var nets = [], pr = [];
    for (i = 0; i < d; i++) { nets.push(m.fn[a + i]); pr.push(m.c[a + i]); }
    var nMin = Math.min(0, Math.min.apply(null, nets)), nMax = Math.max(0, Math.max.apply(null, nets));
    if (nMax === nMin) nMax = nMin + 1;
    var pMin = Math.min.apply(null, pr), pMax = Math.max.apply(null, pr), pad = (pMax - pMin) * 0.12 || pMax * 0.02 || 1;
    pMin -= pad; pMax += pad;
    function X(k) { return d === 1 ? (P.l + (W - P.l - P.r) / 2) : P.l + k / (d - 1) * (W - P.l - P.r); }
    function YN(v) { return P.t + (nMax - v) / (nMax - nMin) * (H - P.t - P.b); }
    function YP(v) { return P.t + (pMax - v) / (pMax - pMin) * (H - P.t - P.b); }
    var col = R.dist ? 'var(--red)' : 'var(--green)', y0 = YN(0);
    var ln = nets.map(function (v, k) { return (k ? 'L' : 'M') + X(k).toFixed(1) + ' ' + YN(v).toFixed(1); }).join(' ');
    var area = ln + ' L' + X(d - 1).toFixed(1) + ' ' + y0.toFixed(1) + ' L' + X(0).toFixed(1) + ' ' + y0.toFixed(1) + ' Z';
    var pl = pr.map(function (v, k) { return (k ? 'L' : 'M') + X(k).toFixed(1) + ' ' + YP(v).toFixed(1); }).join(' ');
    var grid = '';
    for (i = 0; i <= 3; i++) { var gy = P.t + i / 3 * (H - P.t - P.b); grid += '<line class="gl" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) + '"/>'; }
    var xl = '', dots = '';
    for (i = 0; i < d; i++) {
      xl += '<text x="' + X(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' + rdLbl(i, d) + '</text>';
      dots += '<circle cx="' + X(i).toFixed(1) + '" cy="' + YN(nets[i]).toFixed(1) + '" r="3.2" fill="' + col + '"/>';
    }
    return '<svg class="sx-rd-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Net asing dan harga ' + esc(m.code) + '">' + grid +
      '<path d="' + area + '" fill="' + col + '" fill-opacity=".14"/><line class="gl" style="stroke-dasharray:none" x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y0.toFixed(1) + '" y2="' + y0.toFixed(1) + '"/>' +
      '<path d="' + pl + '" fill="none" stroke="#6366f1" stroke-width="1.6" stroke-dasharray="4 3"/>' +
      '<path d="' + ln + '" fill="none" stroke="' + col + '" stroke-width="2"/>' + dots +
      '<text x="' + (P.l - 6) + '" y="' + (P.t + 4) + '" text-anchor="end">' + fv(nMax) + '</text>' +
      '<text x="' + (P.l - 6) + '" y="' + (H - P.b) + '" text-anchor="end">' + fv(nMin) + '</text>' +
      '<text x="' + (W - P.r + 6) + '" y="' + (P.t + 4) + '">' + px(pMax) + '</text>' +
      '<text x="' + (W - P.r + 6) + '" y="' + (H - P.b) + '">' + px(pMin) + '</text>' + xl + '</svg>';
  }
  function rdDetail(o, R) {
    var m = o.m, a = R.a, d = R.d, i, trs = '';
    for (i = d - 1; i >= 0; i--) {
      var rk = o.rk[i], nv = m.fn[a + i];
      trs += '<tr><td>' + rdLbl(i, d) + ' <small>(' + esc(dDM(a + i)) + ')</small></td>' +
        '<td>' + (rk ? '<span class="sx-rd-bd ' + rdK(rk) + '">#' + rk + '</span>' : '<span class="sx-mute">-</span>') + '</td>' +
        '<td class="' + sc(nv) + '">' + (nv > 0 ? '+' : '') + fv(nv) + '</td><td>' + px(m.c[a + i]) + '</td></tr>';
    }
    return '<div class="sx-rd-box"><h5>' + ic('bar') + 'Net Foreign Flow<span class="sx-rd-lg"><span><i style="background:' + (R.dist ? 'var(--red)' : 'var(--green)') + '"></i>Net Foreign</span><span><i style="background:#6366f1"></i>Harga</span></span></h5>' + rdChart(o, R) + '</div>' +
      '<div class="sx-rd-box"><h5>' + ic('cal') + 'Detail Harian<button class="sx-rd-go" data-sx="open" data-v="' + esc(m.code) + '">Buka saham ' + ic('ext') + '</button></h5>' +
      '<table class="sx-rd-tb"><thead><tr><th>Tanggal</th><th>Rank</th><th>Net Foreign</th><th>Harga</th></tr></thead><tbody>' + trs + '</tbody></table></div>';
  }
  function bodyRadar() {
    var st = V.foreign, R = rdData(), all = R.rows, d = R.d, dist = R.dist;
    var head = '<div class="sx-found">' + ic('globe') + '<b>' + nf(all.length) + '</b> saham · ' + esc(dShort(U.axis[R.a])) + ' s/d ' + esc(dShort(U.axis[R.n - 1])) + '</div>';
    if (!all.length) return head + empty('Belum ada saham yang masuk Top ' + RD_TOP + ' asing minimal ' + Math.min(RD_MIN, d) + ' hari pada periode ini.');
    var cons = all.slice().sort(function (x, y) { return y.cnt - x.cnt || x.avg - y.avg; })[0];
    var stk = all.slice().sort(function (x, y) { return y.run - x.run || y.cnt - x.cnt || x.avg - y.avg; })[0];
    var kpis = '<div class="sx-rdk">' +
      '<div><span class="sx-cap">Hari trading</span><b>' + d + '</b></div>' +
      '<div><span class="sx-cap">Saham terdeteksi</span><b>' + nf(all.length) + '</b></div>' +
      '<div><span class="sx-cap">Paling konsisten</span><button class="b" data-sx="open" data-v="' + esc(cons.m.code) + '">' + esc(cons.m.code) + '</button></div>' +
      '<div><span class="sx-cap">Streak tertinggi</span><b class="' + (dist ? 'sx-dn' : 'sx-up') + '">' + stk.run + '/' + d + '</b><small>' + esc(stk.m.code) + '</small></div></div>';
    var key = st.rsort, dir = st.rdir;
    function val(x) {
      switch (key) {
        case 'avg': return -x.avg;
        case 'net': return dist ? -x.net : x.net;
        case 'ret': return x.ret;
        default: return x.cnt * 1000 - x.avg;
      }
    }
    var rows = all.filter(function (x) { return matchQ(x.m, st.q); }).sort(function (x, y) { return (val(x) - val(y)) * dir || (y.cnt - x.cnt) || (x.avg - y.avg); }).slice(0, 50);
    if (!rows.length) return head + kpis + empty('Tidak ada saham yang cocok.');
    var open = st.rexp === undefined ? rows[0].m.code : st.rexp;
    function sh(k, label, cls) {
      var on = key === k;
      return '<button class="s' + (cls ? ' ' + cls : '') + (on ? ' on' : '') + '" data-sx="rsort" data-v="' + k + '">' + label + ' <i>' + (on ? (dir < 0 ? '↓' : '↑') : '↕') + '</i></button>';
    }
    var hd = '<div class="sx-rd-head"><span class="ns no">#</span><span class="ns">Saham</span><span class="ns">D-' + (d - 1) + ' → D0</span>' +
      sh('days', 'Hari') + sh('net', 'Net Foreign', 'r') + sh('avg', 'Avg Rank', 'r') + sh('ret', 'Return', 'r') + '<span class="ns"></span></div>';
    var list = rows.map(function (x, idx) {
      var isOpen = x.m.code === open, cells = '';
      for (var k = 0; k < d; k++) {
        var rk = x.rk[k];
        cells += '<i class="' + (rk ? rdK(rk) : '') + '" title="' + esc(rdLbl(k, d) + ' (' + dDM(R.a + k) + ')' + (rk ? ' · rank #' + rk : ' · di luar Top ' + RD_TOP)) + '">' + (rk || '-') + '</i>';
      }
      return '<div class="sx-rd-row' + (isOpen ? ' open' : '') + '">' +
        '<button type="button" class="sx-rd-main" data-sx="rtog" data-v="' + esc(x.m.code) + '" aria-expanded="' + (isOpen ? 'true' : 'false') + '">' +
          '<span class="no">' + (idx + 1) + '</span>' +
          '<span class="stk"><b>' + esc(x.m.code) + (x.m.realBroker ? '<i class="sx-real" data-smm-tip="Data broker asli (R2)">●</i>' : '') + '</b><small>' + esc(x.m.name) + '</small></span>' +
          '<span class="sx-rd-heat">' + cells + '</span>' +
          '<span class="dy"><span class="sx-rd-d">' + x.cnt + '/' + d + '</span></span>' +
          '<span class="num ' + sc(x.net) + '" data-l="Net Foreign">' + (x.net > 0 ? '+' : '') + fv(x.net) + '</span>' +
          '<span class="num" data-l="Avg Rank">#' + nf(x.avg, 1) + '</span>' +
          '<span class="num ' + sc(x.ret) + '" data-l="Return">' + fp(x.ret, 2) + '</span>' +
          '<span class="chev" aria-hidden="true"></span>' +
        '</button>' +
        (isOpen ? '<div class="sx-rd-det">' + rdDetail(x, R) + '</div>' : '') +
      '</div>';
    }).join('');
    return head + kpis + '<div class="sx-rd' + (dist ? ' dist' : '') + '" style="--rd:' + d + '">' + hd + list + '</div>' +
      '<p class="sx-note">Heat = peringkat net ' + (dist ? 'jual' : 'beli') + ' asing harian (angka = rank, "-" = di luar Top ' + RD_TOP + '). Hanya saham yang masuk Top ' + RD_TOP + ' minimal ' + Math.min(RD_MIN, d) + ' hari yang ditampilkan. Return = perubahan harga selama periode. Ketuk baris untuk melihat detail harian.</p>';
  }

  // ─────────────────────────── Render & event ───────────────────────────
  // ─────────────────────────── 7. HEADLINES ───────────────────────────
  var NEWS_PER = { '24H': 1, '7D': 7, '30D': 30 };
  var _news = null, _newsLoading = false;
  function loadNews(cb) {
    if (_news) { cb(); return; }
    if (_newsLoading) return;
    _newsLoading = true;
    fetch('headlines.json?v=' + Math.floor(Date.now() / 300000), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { items: [] }; })
      .catch(function () { return { items: [] }; })
      .then(function (j) { _news = { items: (j && j.items) || [], at: j && j.generated_at }; _newsLoading = false; cb(); });
  }
  function timeAgo(ts) {
    var s = Math.max(0, Math.floor(Date.now() / 1000 - (ts || 0)));
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + ' mnt lalu';
    if (s < 86400) return Math.floor(s / 3600) + ' jam lalu';
    return Math.floor(s / 86400) + ' hari lalu';
  }
  // Kode saham = 4 huruf kapital utuh di judul yang ada di universe. Satu berita bisa menyebut beberapa kode.
  function newsByStock() {
    var st = V.news, cut = Date.now() / 1000 - NEWS_PER[st.per] * 86400, by = {};
    ((_news && _news.items) || []).forEach(function (it) {
      if (!it.ts || it.ts < cut) return;
      var seen = {}, m = String(it.title || '').match(/\b[A-Z]{4}\b/g) || [];
      m.forEach(function (c) {
        if (seen[c] || !U.by[c]) return; seen[c] = 1;
        (by[c] = by[c] || []).push(it);
      });
    });
    return by;
  }
  function viewNews() {
    var st = V.news;
    return vhead('news', _news && _news.at ? '<span class="sx-dr">' + ic('cal') + 'Update ' + esc(timeAgo(Date.parse(_news.at) / 1000)) + '</span>' : '') +
      '<div class="sx-bar">' + seg('nper', [['24H', '24 jam'], ['7D', '7 hari'], ['30D', '30 hari']], st.per, 'sm') +
        '<span class="sx-grow"></span>' + searchBox('sxNQ', st.q, 'Kode saham / nama') + '</div>' +
      '<div id="sxBody"></div>';
  }
  function bodyNews() {
    var b = host.querySelector('#sxBody');
    if (!_news) { loadNews(function () { if (V.view === 'news') renderBody(); }); return '<div class="sx-empty">' + ic('news') + '<p>Memuat berita…</p></div>'; }
    var st = V.news, by = newsByStock(), q = (st.q || '').toUpperCase();
    var rows = Object.keys(by).map(function (c) { return { m: U.by[c], list: by[c].sort(function (a, b) { return b.ts - a.ts; }) }; })
      .filter(function (x) { return matchQ(x.m, q); })
      .sort(function (a, b) { return b.list.length - a.list.length || b.list[0].ts - a.list[0].ts; });
    if (!rows.length) return empty('Belum ada berita yang menyebut kode saham pada rentang ini.');
    var shown = rows.slice(0, st.limit);
    return '<div class="sx-newslist">' + shown.map(function (x) {
      return '<div class="sx-news">' +
        '<div class="sx-news-h">' + stockCell(x.m) + '<span class="sx-news-n mono">' + x.list.length + ' berita</span>' +
          '<span class="sx-news-b"><button class="sx-lnk" data-sx="gopage" data-v="pasar">' + ic('news') + 'Pasar Live</button></span></div>' +
        '<ul>' + x.list.slice(0, 3).map(function (it) {
          return '<li><a href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title) + '</a><small>' + esc(it.source || '') + ' · ' + esc(timeAgo(it.ts)) + '</small></li>';
        }).join('') + '</ul></div>';
    }).join('') + '</div>' + more('nmore', shown.length, rows.length);
  }

  // ─────────────────────────── 8. KONSENSUS ───────────────────────────
  var CONS_V = {
    buy:  { k: 'buy',  t: 'Condong beli', c: 'g' },
    hold: { k: 'hold', t: 'Tunggu',       c: 'n' },
    warn: { k: 'warn', t: 'Waspada',      c: 'r' },
    na:   { k: 'na',   t: 'Data minim',   c: 'd' }
  };
  // Aturan sederhana: potensi = target rata-rata / harga - 1; porsi BUY/SELL dari jumlah analis.
  function consVerdict(r) {
    if (r.total < 3 || !r.px || !r.target) return CONS_V.na;
    if (r.up < 0 || r.sellPct >= 30) return CONS_V.warn;
    if (r.up >= 15 && r.buyPct >= 60) return CONS_V.buy;
    return CONS_V.hold;
  }
  function consReason(r, v) {
    if (v.k === 'na') return r.total < 3 ? 'Baru ' + r.total + ' analis, belum cukup untuk disimpulkan.' : 'Harga atau target belum tersedia.';
    if (r.up < 0) return 'Harga sudah di atas target rata-rata analis (' + fp(r.up, 1) + ').';
    if (r.sellPct >= 30) return nf(r.sellPct, 0) + '% analis merekomendasikan SELL.';
    if (v.k === 'buy') return nf(r.buyPct, 0) + '% analis BUY dan target rata-rata ' + fp(r.up, 1) + ' di atas harga.';
    return r.up < 15 ? 'Ruang naik menurut analis hanya ' + fp(r.up, 1) + '.' : 'Hanya ' + nf(r.buyPct, 0) + '% analis yang BUY, belum kompak.';
  }
  function consRows() {
    var st = V.cons, sm = (typeof DATA !== 'undefined' && DATA && DATA.consensus_summary) || {}, lv = (DATA && DATA.live) || {}, q = (st.q || '').toUpperCase(), out = [];
    Object.keys(sm).forEach(function (c) {
      var m = U.by[c], x = sm[c]; if (!m || !x) return;
      var px0 = lv[c] && +lv[c].price || (m.c && m.c[m.c.length - 1]) || 0, total = +x.total || 0;
      var r = { m: m, total: total, buy: +x.buy || 0, neu: +x.neutral || 0, sell: +x.sell || 0, hi: +x.high || 0, lo: +x.low || 0, target: +x.target || 0, px: px0 };
      r.buyPct = total ? r.buy / total * 100 : 0; r.sellPct = total ? r.sell / total * 100 : 0; r.neuPct = total ? r.neu / total * 100 : 0;
      r.up = px0 && r.target ? (r.target / px0 - 1) * 100 : 0;
      r.v = consVerdict(r);
      if (total < st.min || !matchQ(m, q)) return;
      if (st.v !== 'all' && r.v.k !== st.v) return;
      out.push(r);
    });
    out.sort(function (a, b) { return st.sort === 'n' ? b.total - a.total || b.up - a.up : b.up - a.up; });
    return out;
  }
  function viewCons() {
    var st = V.cons;
    return vhead('cons') +
      '<div class="sx-bar">' + seg('cv', [['all', 'Semua'], ['buy', 'Condong beli'], ['hold', 'Tunggu'], ['warn', 'Waspada']], st.v, 'big') + '</div>' +
      '<div class="sx-bar">' + seg('cmin', [['1', '≥1 analis'], ['3', '≥3'], ['5', '≥5'], ['10', '≥10']], st.min, 'sm') +
        seg('csort', [['up', 'Potensi'], ['n', 'Jumlah analis']], st.sort, 'sm') +
        '<span class="sx-grow"></span>' + searchBox('sxCQ', st.q, 'Kode saham / nama') + '</div>' +
      '<div id="sxBody"></div>';
  }
  function bodyCons() {
    var st = V.cons, rows = consRows();
    if (typeof DATA === 'undefined' || !DATA || !DATA.consensus_summary) return empty('Data konsensus belum dimuat.');
    if (!rows.length) return empty('Tidak ada saham yang cocok dengan filter ini.');
    var shown = rows.slice(0, st.limit);
    return '<div class="sx-conslist">' + shown.map(function (r) {
      var span = r.hi > r.lo ? r.hi - r.lo : 0, pos = span ? clamp((r.px - r.lo) / span * 100, 0, 100) : 50, tpos = span ? clamp((r.target - r.lo) / span * 100, 0, 100) : 50;
      return '<div class="sx-cons ' + r.v.c + '">' +
        '<div class="sx-cons-h">' + stockCell(r.m) + '<span class="sx-pill ' + r.v.c + '">' + esc(r.v.t) + '</span></div>' +
        '<div class="sx-cons-up mono"><b class="' + sc(r.up) + '">' + (r.up > 0 ? '+' : '') + nf(r.up, 1) + '%</b><small>potensi ke target ' + px(r.target) + ' · harga ' + px(r.px) + '</small></div>' +
        '<div class="sx-stack" role="img" aria-label="BUY ' + r.buy + ', NEUTRAL ' + r.neu + ', SELL ' + r.sell + '"><i class="b" style="width:' + r.buyPct + '%"></i><i class="n" style="width:' + r.neuPct + '%"></i><i class="s" style="width:' + r.sellPct + '%"></i></div>' +
        '<div class="sx-cons-n mono"><span class="sx-up">BUY ' + r.buy + '</span><span class="sx-mute">NETRAL ' + r.neu + '</span><span class="sx-dn">SELL ' + r.sell + '</span><span class="sx-grow"></span><span class="sx-mute">' + r.total + ' analis</span></div>' +
        (span ? '<div class="sx-rng" title="Rentang target analis ' + px(r.lo) + ' – ' + px(r.hi) + '"><i class="t" style="left:' + tpos + '%"></i><i class="p" style="left:' + pos + '%"></i></div><div class="sx-rng-l mono"><span>' + px(r.lo) + '</span><span class="sx-mute">● harga · ▮ target rata-rata</span><span>' + px(r.hi) + '</span></div>' : '') +
        '<p class="sx-why">' + esc(consReason(r, r.v)) + '</p>' +
        '<div class="sx-acts"><button class="sx-lnk" data-sx="gocons" data-v="' + esc(r.m.code) + '">' + ic('target') + 'Detail Konsensus</button><button class="sx-lnk" data-sx="open" data-v="' + esc(r.m.code) + '">' + ic('funnel') + 'Smart Money</button></div>' +
      '</div>';
    }).join('') + '</div>' + more('cmore', shown.length, rows.length);
  }

  // ─────────────────────────── 0. PER SAHAM (1 halaman) ───────────────────────────
  var _scr = null, _scrLoading = false;
  function loadScr(cb) {
    if (_scr) { cb(); return; }
    if (_scrLoading) return;
    _scrLoading = true;
    fetch('screening.json?v=' + Math.floor(Date.now() / 3600000))
      .then(function (r) { return r.ok ? r.json() : { stocks: {} }; })
      .catch(function () { return { stocks: {} }; })
      .then(function (j) { _scr = j && j.stocks ? j : { stocks: {} }; _scrLoading = false; cb(); });
  }
  // Data Tracker dimuat sendiri oleh Screener (tidak perlu membuka menu Tracker dulu).
  // Kalau halaman Tracker sudah memuatnya (window.__TR_DATA__), pakai itu.
  var _trk = null, _trkLoading = false, _trkErr = false;
  function trkData() {
    var d = window.__TR_getData && window.__TR_getData();
    return d && !d.pending ? d : _trk;
  }
  function loadTrk(cb) {
    if (trkData() || _trkLoading) { if (trkData()) cb(); return; }
    _trkLoading = true; _trkErr = false;
    fetch('tracker.json?v=' + Math.floor(Date.now() / 300000))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { _trk = j && !j.pending ? j : null; _trkErr = !_trk; })
      .catch(function () { _trkErr = true; })
      .then(function () { _trkLoading = false; cb(); });
  }
  function V_(c, t) { return { c: c, t: t }; }          // verdict: c = g|n|r|d
  function lastPx(m, code) {
    var lv = (typeof DATA !== 'undefined' && DATA && DATA.live && DATA.live[code]) || null;
    return (lv && +lv.price) || (m.c && m.c[m.n - 1]) || 0;
  }
  function kv(k, v, cls) { return '<div class="sx-kv"><span>' + k + '</span><b class="mono ' + (cls || '') + '">' + v + '</b></div>'; }
  function iso0() { return new Date().toISOString().slice(0, 10); }

  function secSwing(m, code) {
    var tr = null; try { if (typeof window.ptSigmaTriggers === 'function') tr = window.ptSigmaTriggers(code); } catch (_) {}
    var o = { t: 'Swing', ico: 'spike', acts: [['godash', 'Buka Dashboard']] };
    if (!tr || !tr.price) { o.v = V_('d', 'Data minim'); o.lines = ['<p class="sx-why">Statistik historis belum cukup untuk menghitung batas beli/jual.</p>']; return o; }
    var dB = (tr.price / tr.buyPrice - 1) * 100, dS = (tr.sellPrice / tr.price - 1) * 100;
    if (tr.price <= tr.buyPrice) { o.v = V_('g', 'Area beli'); o.why = 'Harga sudah di bawah batas beli statistik (rata-rata tahunan dikurangi 2σ).'; }
    else if (tr.price >= tr.sellPrice) { o.v = V_('r', 'Area jual'); o.why = 'Harga sudah di atas batas jual statistik. Pertimbangkan ambil untung.'; }
    else { o.v = V_('n', 'Tunggu'); o.why = 'Harga di tengah rentang. Beli saat turun ' + nf(Math.max(0, dB), 1) + '% ke batas beli, atau jual saat naik ' + nf(Math.max(0, dS), 1) + '%.'; }
    o.raw = { price: tr.price, buy: tr.buyPrice, sell: tr.sellPrice };
    o.lines = [kv('Harga', px(tr.price)), kv('Batas beli', px(tr.buyPrice), 'sx-up'), kv('Batas jual', px(tr.sellPrice), 'sx-dn')];
    return o;
  }
  function secCons(m, code) {
    var x = (typeof DATA !== 'undefined' && DATA && DATA.consensus_summary && DATA.consensus_summary[code]) || null;
    var o = { t: 'Konsensus analis', ico: 'target', acts: [['gocons', 'Detail Konsensus']] };
    if (!x) { o.v = V_('d', 'Tidak ada'); o.lines = ['<p class="sx-why">Belum ada analis yang meliput saham ini.</p>']; return o; }
    var total = +x.total || 0, r = { total: total, buy: +x.buy || 0, neu: +x.neutral || 0, sell: +x.sell || 0, target: +x.target || 0, px: lastPx(m, code) };
    r.buyPct = total ? r.buy / total * 100 : 0; r.sellPct = total ? r.sell / total * 100 : 0; r.neuPct = total ? r.neu / total * 100 : 0;
    r.up = r.px && r.target ? (r.target / r.px - 1) * 100 : 0;
    var v = consVerdict(r); o.v = V_(v.c, v.t); o.why = consReason(r, v);
    o.raw = { target: r.target, up: r.up, buy: r.buy, neu: r.neu, sell: r.sell, total: total, buyPct: r.buyPct };
    o.lines = [kv('Target rata-rata', px(r.target)), kv('Potensi', (r.up > 0 ? '+' : '') + nf(r.up, 1) + '%', sc(r.up)),
      '<div class="sx-stack"><i class="b" style="width:' + r.buyPct + '%"></i><i class="n" style="width:' + r.neuPct + '%"></i><i class="s" style="width:' + r.sellPct + '%"></i></div>',
      '<div class="sx-cons-n mono"><span class="sx-up">BUY ' + r.buy + '</span><span class="sx-mute">NETRAL ' + r.neu + '</span><span class="sx-dn">SELL ' + r.sell + '</span></div>'];
    return o;
  }
  function secInvest(m, code) {
    var o = { t: 'Investasi (valuasi)', ico: 'dollar', acts: [['goval', 'Buka Valuasi']] };
    var f = _scr && _scr.stocks && _scr.stocks[code];
    if (!_scr) { o.v = V_('d', 'Memuat…'); o.lines = []; return o; }
    if (!f || !f.data_ok) { o.v = V_('d', 'Data minim'); o.lines = ['<p class="sx-why">Data fundamental belum lengkap.</p>']; return o; }
    var pxv = lastPx(m, code), fair = +f.dcf_fair || +f.ddm_fair || 0, basis = +f.dcf_fair ? 'DCF' : 'DDM';
    var disc = fair && pxv ? (fair / pxv - 1) * 100 : null, roe = +f.roe || 0, per = pxv && +f.eps > 0 ? pxv / f.eps : 0, pbv = pxv && +f.bvps > 0 ? pxv / f.bvps : 0;
    if (disc == null) { o.v = V_('n', 'Cek manual'); o.why = 'Nilai wajar (DCF/DDM) belum tersedia. Lihat PER, PBV, dan ROE di bawah.'; }
    else if (disc >= 20 && roe >= 10) { o.v = V_('g', 'Diskon'); o.why = 'Harga ' + nf(disc, 0) + '% di bawah nilai wajar ' + basis + ' dan ROE ' + nf(roe, 1) + '%. Cocok dicicil untuk jangka panjang.'; }
    else if (disc < 0) { o.v = V_('r', 'Mahal'); o.why = 'Harga ' + nf(-disc / (1 + disc / 100), 0) + '% di atas nilai wajar ' + basis + '.'; }
    else { o.v = V_('n', 'Wajar'); o.why = disc >= 20 ? 'Murah, tapi ROE ' + nf(roe, 1) + '% belum meyakinkan.' : 'Hanya ' + nf(disc, 0) + '% di bawah nilai wajar ' + basis + '. Margin pengaman tipis.'; }
    o.raw = { items: [['Nilai wajar ' + basis, fair ? px(fair) : '-'], ['Diskon', disc == null ? '-' : (disc > 0 ? '+' : '') + nf(disc, 0) + '%', disc == null ? '' : sc(disc)], ['PER', per ? nf(per, 1) + 'x' : '-'], ['PBV', pbv ? nf(pbv, 2) + 'x' : '-'], ['ROE', nf(roe, 1) + '%'], ['DPR', nf((+f.dpr || 0) * 100, 0) + '%']] };
    o.lines = [kv('Nilai wajar ' + basis, fair ? px(fair) : '-'), kv('Diskon', disc == null ? '-' : (disc > 0 ? '+' : '') + nf(disc, 0) + '%', disc == null ? '' : sc(disc)),
      kv('PER · PBV', (per ? nf(per, 1) + 'x' : '-') + ' · ' + (pbv ? nf(pbv, 2) + 'x' : '-')), kv('ROE · DPR', nf(roe, 1) + '% · ' + nf((+f.dpr || 0) * 100, 0) + '%')];
    return o;
  }
  function secTrade(m, code) {
    var o = { t: 'Trade (stock pick)', ico: 'flow', acts: [['gotr', 'Buka Analisis Tracker']] };
    var d = trkData();
    if (!d) {
      o.v = V_('d', _trkErr ? 'Gagal memuat' : 'Memuat…');
      o.lines = ['<p class="sx-why">' + (_trkErr ? 'Data Tracker gagal dimuat. Muat ulang halaman untuk mencoba lagi.' : 'Memuat data Tracker…') + '</p>'];
      return o;
    }
    var today = iso0(), pxv = lastPx(m, code);
    var open = (d.openList || []).filter(function (r) { return r.ticker === code && r.status === 'OPEN'; });
    var pend = (d.pendingList || []).filter(function (r) { return r.ticker === code && (!r.pendingExpiresAt || r.pendingExpiresAt >= today); });
    var all = open.concat(pend), bt = d.byTicker && d.byTicker[code];
    if (!all.length) { o.v = V_('d', 'Tidak ada pick'); o.lines = ['<p class="sx-why">Tidak ada stock pick yang masih aktif untuk saham ini.' + (bt ? ' Riwayat: ' + bt.trades + ' trade, winrate ' + nf(bt.winrate, 0) + '%.' : '') + '</p>']; return o; }
    // Kalkulasi per pick (BUY: naik = untung, SELL: kebalikannya)
    var rows = all.map(function (r) {
      var sg = r.type === 'SELL' ? -1 : 1, e = +r.entry, t1 = +r.tp1, t2 = +r.tp2 || 0, sl = +r.sl;
      var gain = sg * (t1 - e) / e * 100, gain2 = t2 ? sg * (t2 - e) / e * 100 : 0, risk = sg * (e - sl) / e * 100;
      var rr = risk > 0 ? gain / risk : 0, toE = pxv && e ? (e / pxv - 1) * 100 : 0, now = pxv && e ? sg * (pxv - e) / e * 100 : 0;
      return { r: r, sg: sg, e: e, t1: t1, t2: t2, sl: sl, gain: gain, gain2: gain2, risk: risk, rr: rr, toE: toE, now: now, run: r.status === 'OPEN' };
    });
    var buy = rows.filter(function (x) { return x.sg > 0; }).length, sell = rows.length - buy;
    var good = rows.filter(function (x) { return x.rr >= 1.5; }).length;
    var avgRR = rows.reduce(function (a, x) { return a + x.rr; }, 0) / rows.length;
    o.v = buy > sell ? V_('g', buy + ' pick beli') : sell > buy ? V_('r', sell + ' pick jual') : V_('n', 'Campuran');
    o.why = rows.length + ' pick aktif (' + open.length + ' berjalan, ' + pend.length + ' menunggu entry). ' + good + ' di antaranya punya risk:reward minimal 1,5.' + (bt ? ' Riwayat saham ini: winrate ' + nf(bt.winrate, 0) + '% dari ' + bt.trades + ' trade.' : '');
    var best = rows.slice().sort(function (x, y) { return y.rr - x.rr; })[0];
    o.raw = { rows: rows, avgRR: avgRR, best: best, pxv: pxv };
    o.lines = [
      kv('Harga sekarang', px(pxv)), kv('R:R rata-rata', '1 : ' + nf(avgRR, 1), avgRR >= 1.5 ? 'sx-up' : avgRR < 1 ? 'sx-dn' : ''),
      kv('Terbaik (R:R)', '1 : ' + nf(best.rr, 1) + ' · ' + esc(best.r.firm || ''), ''),
      '<div class="sx-ptbl">' + rows.slice(0, 4).map(function (x) {
        return '<div class="sx-pt"><div class="h"><b class="' + (x.sg > 0 ? 'sx-up' : 'sx-dn') + '">' + esc(x.r.type) + '</b><span class="sx-mute">' + esc(x.r.firm || '') + '</span><em class="' + (x.run ? 'on' : '') + '">' + (x.run ? 'berjalan ' + (x.now > 0 ? '+' : '') + nf(x.now, 1) + '%' : (x.toE >= 0 ? 'tunggu naik ' : 'tunggu turun ') + nf(Math.abs(x.toE), 1) + '%') + '</em></div>' +
          '<div class="g mono"><span>Entry<b>' + px(x.e) + '</b></span><span>TP1<b class="sx-up">' + px(x.t1) + '<small>+' + nf(x.gain, 1) + '%</small></b></span><span>SL<b class="sx-dn">' + px(x.sl) + '<small>-' + nf(x.risk, 1) + '%</small></b></span><span>R:R<b class="' + (x.rr >= 1.5 ? 'sx-up' : x.rr < 1 ? 'sx-dn' : '') + '">1 : ' + nf(x.rr, 1) + '</b></span></div></div>';
      }).join('') + (rows.length > 4 ? '<small class="sx-mute">+' + (rows.length - 4) + ' pick lain di halaman Analisis</small>' : '') + '</div>'];
    return o;
  }
  // Indeks berita: kode saham (4 huruf kapital di judul) -> daftar berita terbaru dulu. Dihitung sekali.
  function newsIdx() {
    if (_news.idx) return _news.idx;
    var idx = {};
    _news.items.slice().sort(function (a, b) { return b.ts - a.ts; }).forEach(function (it) {
      var seen = {}; (String(it.title || '').match(/\b[A-Z]{4}\b/g) || []).forEach(function (c) { if (!seen[c]) { seen[c] = 1; (idx[c] = idx[c] || []).push(it); } });
    });
    return (_news.idx = idx);
  }
  var NEWS_POS = /\b(dividen|buyback|buy back|laba (naik|melonjak|tumbuh|melesat|meningkat)|cuan|melejit|melesat|melonjak|rekor laba|raih kontrak|kontrak baru|ARA|borong|upgrade)\b/i;
  var NEWS_NEG = /\b(ARB|anjlok|rontok|ambrol|merosot|rugi|merugi|suspensi|disuspensi|suspend|gagal bayar|PKPU|pailit|sanksi|delisting|UMA|laba (turun|anjlok|merosot)|downgrade|digembok|tersangka)\b/i;
  function secNews(m, code) {
    var o = { t: 'Berita', ico: 'news', acts: [['gopage', 'Buka Pasar Live', 'pasar']] };
    if (!_news) { o.v = V_('d', 'Memuat…'); o.lines = []; return o; }
    var cut = Date.now() / 1000 - 7 * 86400;
    var list = (newsIdx()[code] || []).filter(function (it) { return it.ts >= cut; });
    if (!list.length) { o.v = V_('d', 'Sepi'); o.lines = ['<p class="sx-why">Tidak ada berita yang menyebut ' + esc(code) + ' dalam 7 hari terakhir.</p>']; return o; }
    o.raw = { list: list };
    // Penilaian kasar dari kata kunci judul. Judul yang memuat kata positif dan negatif sekaligus dilewati.
    var np = 0, nn = 0;
    list.forEach(function (it) {
      var t = String(it.title || ''), p = NEWS_POS.test(t), q = NEWS_NEG.test(t);
      if (p && !q) np++; else if (q && !p) nn++;
    });
    var net = np - nn;
    o.v = net >= 2 ? V_('g', 'Cenderung positif') : net <= -2 ? V_('r', 'Cenderung negatif') : list.length >= 3 ? V_('n', 'Ramai') : V_('n', list.length + ' berita');
    o.why = list.length + ' berita dalam 7 hari: ' + np + ' berkata kunci positif, ' + nn + ' negatif. Penilaian otomatis dari kata kunci judul, baca isinya untuk memastikan.';
    o.lines = ['<ul class="sx-nl">' + list.slice(0, 3).map(function (it) {
      return '<li><a href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title) + '</a><small>' + esc(it.source || '') + ' · ' + esc(timeAgo(it.ts)) + '</small></li>';
    }).join('') + '</ul>'];
    return o;
  }
  function secBroker(m, code) {
    var o = { t: 'Broker summary', ico: 'users', acts: [['open', 'Buka Broker Activity']] };
    if (!m.realBroker) { o.v = V_('d', U.brokerReady ? 'Belum ada data' : 'Memuat…'); o.lines = U.brokerReady ? ['<p class="sx-why">Data broker untuk saham ini belum tersedia.</p>'] : []; return o; }
    var n = U.n, a = n - 5, rg = regime(m, n - 1);
    var nets = m.brokers.map(function (b) { var t = 0; for (var d = a; d < n; d++) t += b.nv[d]; return { b: b, net: t }; });
    var top = nets.slice().sort(function (x, y) { return y.net - x.net; }).filter(function (x) { return x.net > 0; }).slice(0, 3);
    var bot = nets.slice().sort(function (x, y) { return x.net - y.net; }).filter(function (x) { return x.net < 0; }).slice(0, 3);
    var sm = sum(m.Psm, a, n - 1), fn = sum(m.Pfn, a, n - 1);
    o.v = rg.k === 'acc' ? V_('g', 'Akumulasi') : rg.k === 'dist' ? V_('r', 'Distribusi') : V_('n', 'Netral');
    o.why = 'Smart money 5 hari ' + (sm > 0 ? 'net beli ' : 'net jual ') + fv(Math.abs(sm)) + ', asing ' + (fn > 0 ? 'net beli ' : 'net jual ') + fv(Math.abs(fn)) + '.';
    var chip = function (x) { return '<span class="sx-bchip">' + bk(x.b.code, x.b.type, x.b.name) + '<i class="mono ' + sc(x.net) + '">' + (x.net > 0 ? '+' : '') + fv(x.net) + '</i></span>'; };
    o.raw = { sm: sm, fn: fn, rg: rg, top: top, bot: bot };
    o.lines = [kv('Rezim 20 hari', esc(rg.label), rg.k === 'acc' ? 'sx-up' : rg.k === 'dist' ? 'sx-dn' : ''),
      '<div class="sx-bcol"><small class="sx-up">Net beli 5 hari</small>' + (top.map(chip).join('') || '<small class="sx-mute">-</small>') + '</div>',
      '<div class="sx-bcol"><small class="sx-dn">Net jual 5 hari</small>' + (bot.map(chip).join('') || '<small class="sx-mute">-</small>') + '</div>'];
    return o;
  }
  function secInsider(m, code) {
    var o = { t: 'Insider', ico: 'user', acts: [['open', 'Buka Insider']] };
    if (!m.realBroker) { o.v = V_('d', U.brokerReady ? 'Belum ada data' : 'Memuat…'); o.lines = []; return o; }
    var t0 = U.n - 63, L = m.ins.filter(function (e) { return e.t >= t0; }).sort(function (a, b) { return b.t - a.t; });
    if (!L.length) { o.v = V_('d', 'Sepi'); o.lines = ['<p class="sx-why">Tidak ada transaksi insider yang dilaporkan dalam 3 bulan terakhir.</p>']; return o; }
    var b = 0, sl = 0; L.forEach(function (e) { if (e.act === 'BUY') b += e.value; else sl += e.value; });
    o.v = b > sl * 1.5 ? V_('g', 'Insider beli') : sl > b * 1.5 ? V_('r', 'Insider jual') : V_('n', 'Campuran');
    o.why = 'Dalam 3 bulan: beli ' + fv(b, true) + ', jual ' + fv(sl, true) + '.';
    o.raw = { L: L, b: b, sl: sl };
    o.lines = L.slice(0, 3).map(function (e) {
      return '<div class="sx-pick"><b class="' + (e.act === 'BUY' ? 'sx-up' : 'sx-dn') + '">' + (e.act === 'BUY' ? 'BELI' : 'JUAL') + '</b><span class="mono">' + fv(e.value, true) + '</span><small>' + esc(e.name) + ' · ' + esc(dShort(U.axis[e.t])) + '</small></div>';
    });
    return o;
  }
  function secHolder(m, code) {
    var o = { t: 'Kepemilikan >5%', ico: 'bank', acts: [['open', 'Buka Kepemilikan']] };
    if (!m.realBroker) { o.v = V_('d', U.brokerReady ? 'Belum ada data' : 'Memuat…'); o.lines = []; return o; }
    var t0 = U.n - 70, L = m.h5.filter(function (e) { return e.t >= t0; }).sort(function (a, b) { return Math.abs(b.cur - b.prev) - Math.abs(a.cur - a.prev); });
    if (!L.length) { o.v = V_('d', 'Tidak berubah'); o.lines = ['<p class="sx-why">Tidak ada perubahan pemegang saham di atas 5% dalam 3 bulan terakhir.</p>']; return o; }
    var up = 0, dn = 0; L.forEach(function (e) { if (e.cur > e.prev) up++; else dn++; });
    o.v = up > dn ? V_('g', 'Menambah') : dn > up ? V_('r', 'Mengurangi') : V_('n', 'Campuran');
    o.why = up + ' pemegang menambah, ' + dn + ' mengurangi porsi.';
    o.raw = { L: L, up: up, dn: dn };
    o.lines = L.slice(0, 3).map(function (e) {
      var d = e.cur - e.prev;
      return '<div class="sx-pick"><b class="' + sc(d) + '">' + (d > 0 ? '+' : '') + nf(d, 2) + ' pp</b><span class="mono">' + nf(e.prev, 2) + '% › ' + nf(e.cur, 2) + '%</span><small>' + esc(e.name) + '</small></div>';
    });
    return o;
  }
  // ── Per Saham v2: Radar (semua saham) + halaman detail satu saham ──
  var SEC_KEYS = ['swing', 'cons', 'invest', 'trade', 'news', 'broker', 'insider', 'holder'];
  var SEC_NAME = { swing: 'Swing', cons: 'Konsensus', invest: 'Valuasi', trade: 'Trade', news: 'Berita', broker: 'Broker', insider: 'Insider', holder: 'Kepemilikan' };
  var SEC_FN = { swing: secSwing, cons: secCons, invest: secInvest, trade: secTrade, news: secNews, broker: secBroker, insider: secInsider, holder: secHolder };
  // Bobot skor StockPro. Modul inti menentukan arah, modul pelengkap hanya menguatkan atau menahan.
  // Skor = (bobot modul hijau - bobot modul merah) / bobot modul yang berdata x 100  (rentang -100..+100).
  var SEC_W = { trade: 5, broker: 4, insider: 3, swing: 2, invest: 1, cons: 1, holder: 1, news: 1 };
  var SEC_CORE = { trade: 1, broker: 1, insider: 1, swing: 1 };
  var SC_TH = 25;        // skor >= +25 = Layak dibeli, <= -25 = Hindari
  var SC_MIN_KNOWN = 3;  // minimal modul berdata
  var SC_MIN_AVAIL = 6;  // minimal total bobot modul berdata (mencegah kesimpulan dari modul pelengkap saja)
  var _sigVer = 0;
  function sigBump() { _sigVer++; if (V.stk && V.stk.sig) { V.stk.sigStale = V.stk.sig; V.stk.sig = null; } }
  function scoreOf(m) {
    var by = {}, g = 0, r = 0, known = 0, core = 0, raw = 0, avail = 0;
    SEC_KEYS.forEach(function (k) {
      var x; try { x = SEC_FN[k](m, m.code); } catch (e) { x = { t: k, ico: 'info', v: V_('d', 'Error'), lines: [], acts: [] }; }
      x.k = k; by[k] = x;
      if (x.v.c === 'g') { g++; raw += SEC_W[k]; } else if (x.v.c === 'r') { r++; raw -= SEC_W[k]; }
      if (x.v.c !== 'd') { known++; avail += SEC_W[k]; if (SEC_CORE[k]) core++; }
    });
    return { m: m, by: by, g: g, r: r, known: known, core: core, avail: avail, score: avail ? Math.round(raw / avail * 100) : 0 };
  }
  function scoreOk(x) { return x.known >= SC_MIN_KNOWN && x.core >= 1 && x.avail >= SC_MIN_AVAIL; }
  function scoreLab(s) { return s >= SC_TH ? { c: 'g', t: 'Layak dibeli' } : s <= -SC_TH ? { c: 'r', t: 'Hindari' } : { c: 'n', t: 'Netral' }; }
  // Kolom peta sinyal: -5..+5. Skor 25 = kolom 2, jadi kolom >= 2 selalu berarti Layak dibeli.
  function scoreBucket(s) { return clamp(s < 0 ? Math.ceil(s / 12.5) : Math.floor(s / 12.5), -5, 5); }
  // Keterangan bobot untuk pengguna: deret bobot + rumus.
  function weightsHtml() {
    var chip = function (k, cls) { return '<span class="' + cls + '"><b>' + SEC_NAME[k] + '</b> ×' + SEC_W[k] + '</span>'; };
    return '<div class="sp-wt"><div><em>Inti</em>' + ['trade', 'broker', 'insider', 'swing'].map(function (k) { return chip(k, 'c'); }).join('') + '</div>' +
      '<div><em>Pelengkap</em>' + ['invest', 'cons', 'holder', 'news'].map(function (k) { return chip(k, 'p'); }).join('') + '</div></div>';
  }
  function howHtml(calc) {
    return '<details class="sp-how"><summary>Cara menghitung skor dan arti bobot</summary>' +
      '<p>Tiap modul bernilai hijau (positif), kuning (netral), merah (waspada), atau tanpa data. Hijau menambah sebesar bobotnya, merah mengurangi, kuning dan tanpa data bernilai 0.</p>' +
      '<p><b>Skor = (bobot hijau − bobot merah) ÷ bobot modul berdata × 100</b>, rentang −100 sampai +100. <b>Layak dibeli</b> bila skor ≥ +' + SC_TH + ', <b>Hindari</b> bila ≤ −' + SC_TH + ', selain itu Netral.</p>' +
      '<p>Modul inti (Trade, Broker, Insider, Swing) dibobot lebih besar karena paling dekat ke pergerakan harga. Modul pelengkap (Valuasi, Konsensus, Kepemilikan, Berita) hanya menguatkan atau menahan.</p>' +
      '<p>Saham dihitung bila minimal ' + SC_MIN_KNOWN + ' modul berdata, minimal 1 di antaranya modul inti, dan total bobot modul berdata minimal ' + SC_MIN_AVAIL + '. Urutan daftar: skor tertinggi, lalu bobot data terbanyak.</p>' +
      '<p>Berita dinilai otomatis dari kata kunci pada judul 7 hari terakhir, jadi paling kasar. Kesimpulan per gaya (Trading, Swing, Investasi) memakai bobot sendiri yang tertera saat kartunya disentuh.</p>' +
      (calc ? '<p class="sp-calc">' + calc + '</p>' : '') + '</details>';
  }
  function sigReady() { return !!(_news && _scr && (trkData() || _trkErr)); }
  // Cache hasil hitung sinyal (localStorage). Disegarkan tiap 3 jam; harga tetap live dari ohlc.json.
  // Naikkan nomor di SIG_KEY bila logika scoreOf / SEC_FN berubah, supaya cache lama dibuang.
  var SIG_KEY = 'es_sm_sig_v2', SIG_TTL = 3 * 60 * 60 * 1000;
  function sigFresh() { var s0 = V.stk.sig; return s0 && s0.ver === _sigVer && Date.now() - (s0.t || 0) < SIG_TTL ? s0 : null; }
  function sigCacheWrite(map) {
    try {
      var out = {};
      Object.keys(map).forEach(function (c) {
        var x = map[c], by = {};
        SEC_KEYS.forEach(function (k) { by[k] = [x.by[k].v.c, x.by[k].v.t]; });
        out[c] = [x.g, x.r, x.known, x.score, x.liq, by, x.core, x.avail];
      });
      localStorage.setItem(SIG_KEY, JSON.stringify({ t: Date.now(), brk: !!U.brokerReady, map: out }));
    } catch (_) { try { localStorage.removeItem(SIG_KEY); } catch (__) {} }
  }
  function sigFromCache() {
    var j = null;
    try { j = JSON.parse(localStorage.getItem(SIG_KEY) || 'null'); } catch (_) { j = null; }
    if (!j || !j.map || !j.t || !U) return null;
    var map = {};
    Object.keys(j.map).forEach(function (c) {
      var m = U.by[c], a = j.map[c]; if (!m || !a) return;
      var by = {};
      SEC_KEYS.forEach(function (k) { var p = a[5][k] || ['d', '']; by[k] = { k: k, v: { c: p[0], t: p[1] } }; });
      map[c] = { m: m, by: by, g: a[0], r: a[1], known: a[2], score: a[3], liq: a[4], core: a[6] || 0, avail: a[7] || 0 };
    });
    return Object.keys(map).length ? { t: j.t, brk: !!j.brk, map: map } : null;
  }
  var _webT = [], _webStat = '';
  var WEB_MODS = ['Teknikal', 'Fundamental', 'Arus dana', 'Berita', 'Valuasi', 'Broksum', 'Insider', 'Kepemilikan'];
  function setStat(t) { _webStat = t; var el = host && host.querySelector('#spStat'); if (el) el.textContent = t; }
  // Teks progres saat hitung sinyal. Hanya mengubah teks, tidak merender ulang peta (animasi tetap jalan).
  function stkProgress(i) { if (U) setStat('Mengumpulkan data · ' + nf(i) + ' / ' + nf(U.list.length) + ' saham'); }
  var _webSvg = null, _webStatEl = null, _webMiss = 0;
  function spWebStop() { _webT.forEach(clearTimeout); _webT = []; _webSvg = null; _webStatEl = null; }
  // Animasi "benang" dari referensi: garis tumbuh dari pusat ke tiap saham, nama modul berjalan di sepanjang garis.
  function spWebStart() {
    var box = host && host.querySelector('#spWeb'); if (!box || box.querySelector('svg')) return;
    if (_webSvg) { box.appendChild(_webSvg); box.appendChild(_webStatEl); _webStatEl.textContent = _webStat; return; }
    spWebStop();
    var NSV = 'http://www.w3.org/2000/svg';
    var W = box.clientWidth || 800, H = box.clientHeight || 260;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function mk(tag, a) { var e = document.createElementNS(NSV, tag); for (var k in a) e.setAttribute(k, a[k]); return e; }
    var svg = mk('svg', { class: 'sp-web-svg', viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet' });
    var hx = W / 2, hy = 22, N = 28, th = [];
    for (var i = 0; i < N; i++) {
      var tx = W * (0.05 + ((i * 37) % 100) / 100 * 0.9), ty = H * (0.22 + ((i * 53) % 100) / 100 * 0.6);
      var b = (i % 2 ? 1 : -1) * (40 + (i % 3) * 40);
      var c1 = [hx + b, hy + (ty - hy) * 0.6], c2 = [tx - (tx - hx) * 0.3 + b * 0.4, ty];
      var d = 'M' + hx + ',' + hy + ' C' + c1.join(',') + ' ' + c2.join(',') + ' ' + tx + ',' + ty;
      var dr = 'M' + tx + ',' + ty + ' C' + c2.join(',') + ' ' + c1.join(',') + ' ' + hx + ',' + hy;
      var base = mk('path', { d: d, class: 'th', pathLength: 1, 'stroke-dasharray': '1 1' });
      var pulse = mk('path', { d: dr, class: 'pl', pathLength: 1, 'stroke-dasharray': '0.05 2' });
      var node = mk('circle', { cx: tx, cy: ty, r: 3.5, class: 'nd' });
      var tp = mk('path', { id: 'spTp' + i, d: tx < hx ? dr : d, fill: 'none', stroke: 'none' });
      var txt = mk('text', { class: 'tx', dy: -4 }), tpath = mk('textPath', { startOffset: '3%' });
      tpath.setAttribute('href', '#spTp' + i);
      WEB_MODS.forEach(function (m, j) {
        if (j) { var sp = mk('tspan', { class: 'spc' }); sp.textContent = '\u00A0·\u00A0'; tpath.appendChild(sp); }
        var w = mk('tspan', { 'data-m': j }); w.textContent = m; tpath.appendChild(w);
      });
      txt.appendChild(tpath);
      svg.appendChild(tp); svg.appendChild(base); svg.appendChild(pulse); svg.appendChild(txt); svg.appendChild(node);
      th.push({ base: base, pulse: pulse, node: node, txt: txt });
    }
    svg.appendChild(mk('circle', { cx: hx, cy: hy, r: 4.5, class: 'hub' }));
    box.appendChild(svg);
    var stat = document.createElement('div'); stat.className = 'sp-stat'; stat.id = 'spStat'; stat.textContent = _webStat; box.appendChild(stat);
    _webSvg = svg; _webStatEl = stat; _webMiss = 0;
    function later(ms, f) {
      _webT.push(setTimeout(function run() {
        if (!svg.isConnected) { if (++_webMiss > 4) { spWebStop(); return; } _webT.push(setTimeout(run, 300)); return; }
        _webMiss = 0; f();
      }, ms));
    }
    if (reduce) { th.forEach(function (t) { t.base.style.strokeDashoffset = 0; t.node.style.opacity = .45; t.txt.style.opacity = 1; }); return; }
    th.forEach(function (t, k) {
      var dl = k * 24;
      if (t.base.animate) t.base.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 900, delay: dl, easing: 'ease-out', fill: 'forwards' });
      else t.base.style.strokeDashoffset = 0;
      later(dl + 800, function () { t.node.style.opacity = .45; t.txt.style.opacity = 1; });
    });
    function pulses() {
      th.forEach(function (t) {
        if (t.pulse.animate) t.pulse.animate([{ strokeDashoffset: .07, opacity: 0 }, { opacity: .9, offset: .2 }, { opacity: .9, offset: .8 }, { strokeDashoffset: -1, opacity: 0 }], { duration: 800, delay: Math.random() * 250, easing: 'ease-in-out' });
      });
      later(2400, pulses);
    }
    var mi = 0;
    function cycle() {
      th.forEach(function (t) { t.txt.querySelectorAll('tspan[data-m]').forEach(function (e) { e.classList.toggle('on', +e.getAttribute('data-m') === mi); }); });
      mi = (mi + 1) % WEB_MODS.length;
      later(900, cycle);
    }
    later(400, pulses); cycle();
  }
  function sigCompute(cb) {
    var st = V.stk;
    if (sigFresh()) { cb(); return; }
    if (st.sigBusy) return;
    st.sigBusy = true;
    var ver = _sigVer, list = U.list.slice(), i = 0, map = {}, n = U.n;
    st.sigPartial = map;
    (function step() {
      var end = Math.min(list.length, i + 60);
      st.sigProg = i / list.length; stkProgress(i);
      for (; i < end; i++) { var sc0 = scoreOf(list[i]); sc0.liq = sum(list[i].Pval, n - 20, n - 1); map[list[i].code] = sc0; }
      if (i < list.length) { setTimeout(step, 0); return; }
      st.sigProg = i / list.length; stkProgress(i);
      st.sigBusy = false;
      if (ver !== _sigVer) { sigCompute(cb); return; }
      st.sig = { ver: ver, map: map, t: Date.now(), brk: !!U.brokerReady }; st.sigPartial = null; sigCacheWrite(map);
      cb();
    })();
  }
  function colorOf(c) { return c === 'g' ? 'var(--green)' : c === 'r' ? 'var(--red)' : c === 'n' ? 'var(--yellow)' : 'var(--text3)'; }
  function dotsOf(x) { var s = ''; for (var i = 0; i < 8; i++) s += '<i class="' + (i < x.g ? 'p' : i >= 8 - x.r ? 'w' : '') + '"></i>'; return s; }
  function reasons(x, c) {
    return SEC_KEYS.filter(function (k) { return x.by[k].v.c === c; }).slice(0, 3).map(function (k) {
      return '<span class="sp-rs ' + c + '">' + esc(SEC_NAME[k]) + ': ' + esc(x.by[k].v.t) + '</span>';
    }).join('');
  }
  function chgOf(m) { var p = m.c[m.n - 2] || 0, q = lastPx(m, m.code); return p ? (q / p - 1) * 100 : 0; }
  function spRow(x, i, c) {
    var m = x.m, ch = chgOf(m);
    return '<button class="sp-row" data-sx="pick" data-v="' + esc(m.code) + '"><span class="rk">' + (i + 1) + '</span>' +
      '<div><div class="tk">' + esc(m.code) + '<small>' + esc(m.name) + '</small></div><div class="sp-dots" title="' + x.g + ' positif, ' + x.r + ' waspada">' + dotsOf(x) + '<b class="sp-scv mono ' + (x.score >= 0 ? 'sx-up' : 'sx-dn') + '" title="Skor berbobot, −100 sampai +100">' + (x.score > 0 ? '+' : '') + x.score + '</b></div></div>' +
      '<div class="pxv mono">' + px(lastPx(m, m.code)) + '<small class="' + sc(ch) + '">' + fp(ch, 2) + '</small></div>' +
      '<div class="tz">' + reasons(x, c) + '<span class="go">Lihat analisis ›</span></div></button>';
  }
  // Zoom peta sinyal (HP): tombol +/- dan cubit dua jari. Pada zoom 100% peta pas layar tanpa geser.
  var SP_ZS = [1, 1.5, 2, 3];
  function spSetZoom(z) {
    var st = V.stk; z = clamp(z, 1, 3); st.zoom = z;
    var sc = host && host.querySelector('.sp-sc'), map = host && host.querySelector('#spMap'); if (!map || !sc) return;
    var ow = map.offsetWidth || 1, mid = sc.scrollLeft + sc.clientWidth / 2;
    map.style.setProperty('--z', z); map.classList.toggle('zc', z < 1.8);
    var nw = map.offsetWidth || 1; sc.scrollLeft = mid * (nw / ow) - sc.clientWidth / 2;
    var zv = host.querySelector('#spZv'); if (zv) zv.textContent = Math.round(z * 100) + '%';
  }
  function spZoomStep(dir) {
    var z = V.stk.zoom || 1, i = 0;
    for (var k = 0; k < SP_ZS.length; k++) if (SP_ZS[k] <= z + 0.01) i = k;
    spSetZoom(SP_ZS[clamp(i + dir, 0, SP_ZS.length - 1)]);
  }
  var _pinch = null;
  function pinchDist(t) { var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY; return Math.sqrt(dx * dx + dy * dy) || 1; }
  // Penyegaran halaman awal Per Saham tanpa memutus animasi:
  //  - masih menghitung & benang tampil → cukup ubah teks status;
  //  - hasil baru siap & benang tampil → benang memudar dulu, lalu peta + logo muncul satu per satu.
  var _fadeT = 0;
  function stkRefresh() {
    if (V.view !== 'stk' || V.stk.code || !host) return;
    var web = host.querySelector('#spWeb');
    if (web && web.querySelector('svg')) {
      if (!sigFresh()) {
        setStat(!sigReady() ? 'Memuat berita, valuasi, dan data Tracker…' : 'Mengumpulkan data · 0 / ' + nf(U.list.length) + ' saham');
        if (sigReady() && !V.stk.sigBusy) sigCompute(stkRefresh);
        return;
      }
      if (_fadeT) return;
      setStat('Menyusun peta sinyal…');
      web.classList.add('out');
      _fadeT = setTimeout(function () { _fadeT = 0; spWebStop(); renderBody(); }, 450);
      return;
    }
    renderBody();
  }
  // Logo saham diungkap satu per satu dari kiri ke kanan. Yang sudah tampil tidak dianimasikan ulang saat render ulang.
  var _revT = [];
  function spReveal() {
    _revT.forEach(clearTimeout); _revT = [];
    var map = host && host.querySelector('#spMap'); if (!map) return;
    var rev = V.stk.rev = V.stk.rev || {};
    var hid = Array.prototype.slice.call(map.querySelectorAll('.sp-bub.sp-hid'));
    if (!hid.length) return;
    V.stk.introDone = true;
    hid.sort(function (a, b) { return (parseFloat(a.style.left) - parseFloat(b.style.left)) || (parseFloat(a.style.top) - parseFloat(b.style.top)); });
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var gap = still ? 0 : Math.max(35, Math.min(90, 2400 / hid.length));
    hid.forEach(function (el, i) {
      _revT.push(setTimeout(function () {
        el.classList.remove('sp-hid'); el.classList.add(still ? 'sp-done' : 'sp-in');
        rev[el.getAttribute('data-v')] = 1;
      }, Math.round(i * gap)));
    });
  }
  function stkLanding() {
    var st = V.stk;
    var onDone = stkRefresh;
    if (!_news) loadNews(onDone);
    if (!_scr) loadScr(onDone);
    if (!trkData() && !_trkLoading && !_trkErr) loadTrk(onDone);
    var fresh = sigFresh();
    if (!fresh && !st.sigBusy && sigReady() && !st.sigCacheChecked) {
      st.sigCacheChecked = true;
      var cc = sigFromCache();
      if (cc) {
        st.sigStale = { ver: 'cache', map: cc.map, t: cc.t };
        if (Date.now() - cc.t < SIG_TTL && (cc.brk || !U.brokerReady)) { st.sig = { ver: _sigVer, map: cc.map, t: cc.t, brk: cc.brk }; fresh = st.sig; }
      }
    }
    if (st.sig && !fresh) { st.sigStale = st.sig; st.sig = null; }   // sudah lewat 3 jam / data berubah: tampilkan dulu, hitung ulang di belakang
    if (sigReady() && !fresh) sigCompute(onDone);
    // Hasil lama / hasil parsial tetap tampil selagi dihitung ulang. Tanpa data sama sekali → peta kosong + animasi.
    var cur = fresh || st.sigStale || { map: {} };
    var computing = !fresh && !st.sigStale;
    var map0 = cur.map;
    var all = Object.keys(map0).map(function (c) { return map0[c]; }).filter(scoreOk);
    var B = all.filter(function (x) { return x.score >= SC_TH; }).sort(function (a, b) { return b.score - a.score || b.avail - a.avail || b.liq - a.liq; });
    var H = all.filter(function (x) { return x.score <= -SC_TH; }).sort(function (a, b) { return a.score - b.score || b.avail - a.avail || b.liq - a.liq; });
    var N = all.filter(function (x) { return x.score > -SC_TH && x.score < SC_TH; }).sort(function (a, b) { return b.liq - a.liq; });
    // peta: tiap skor -5..5 menampilkan hingga 4 saham paling likuid
    var bucket = {}, bub = '';
    all.slice().sort(function (a, b) { return b.liq - a.liq; }).forEach(function (x) {
      var k = scoreBucket(x.score); bucket[k] = bucket[k] || [];
      if (bucket[k].length < 4) bucket[k].push(x);
    });
    var rev = st.rev = st.rev || {};
    var di = 0;
    Object.keys(bucket).forEach(function (k) {
      k = +k;
      bucket[k].forEach(function (x, j) {
        bub += '<button class="sp-bub ' + (st.introDone || rev[x.m.code] ? 'sp-done' : 'sp-hid') + '" data-sx="pick" data-v="' + esc(x.m.code) + '" title="' + esc(x.m.name) + ' · skor ' + (x.score > 0 ? '+' : '') + x.score + ' · ' + x.g + ' positif, ' + x.r + ' waspada" style="left:' + ((k + 5.5) / 11 * 100) + '%;top:' + (52 + j * 50 + (((k + 5) % 2) ? 25 : 0)) + 'px;--c:' + (k >= 2 ? 'var(--green)' : k <= -2 ? 'var(--red)' : 'var(--yellow)') + ';--d:' + (di++ * 0.05).toFixed(2) + 's"><i class="sp-lgw"><b>' + esc(x.m.code.slice(0, 2)) + '</b><img class="sp-lg" src="/logos/' + esc(x.m.code) + '.png" alt="" loading="lazy" decoding="async"></i><span>' + esc(x.m.code) + '</span></button>';
      });
    });
    var intro = computing && !st.introDone;
    var statTxt = !sigReady() ? 'Memuat berita, valuasi, dan data Tracker…' : 'Mengumpulkan data · ' + nf(Object.keys(map0).length) + ' / ' + nf(U.list.length) + ' saham';
    // Pertama kali: animasi benang. Kunjungan berikutnya saat masih menghitung: spinner + teks progres.
    var coll = intro ? '<div class="sp-web" id="spWeb"></div>' : computing ? '<div class="sx-load sp-ld"><div class="sx-spin"></div><b>' + esc(statTxt) + '</b></div>' : '';
    if (intro) { setStat(statTxt); setTimeout(spWebStart, 0); }
    var skel = function () { return computing ? '' : '<p class="sp-sub">Belum ada.</p>'; };
    if (!computing) setTimeout(spReveal, 0);
    return '<div class="sp">' +
      '<div class="sp-scw"><div class="sp-sc"><div class="sp-map' + ((st.zoom || 1) < 1.8 ? ' zc' : '') + '" id="spMap" style="--z:' + (st.zoom || 1) + '"><div class="sp-zone r"></div><div class="sp-zone g"></div><div class="sp-mid"></div><div class="sp-glow"></div>' +
        '<span class="sp-zl sx-dn" style="left:14px">Hindari</span><span class="sp-zl sx-mute" style="left:50%;transform:translateX(-50%)">Netral</span><span class="sp-zl sx-up" style="right:14px">Layak dibeli</span>' + bub + coll + '</div></div></div>' +
        '<div class="sp-zrow"><p class="sp-hint">Cubit layar atau pakai tombol + / − untuk memperbesar peta, lalu geser.</p>' +
          '<div class="sp-zoom" role="group" aria-label="Zoom peta"><button data-sx="spzoom" data-v="out" aria-label="Perkecil">−</button><span class="mono" id="spZv">' + Math.round((st.zoom || 1) * 100) + '%</span><button data-sx="spzoom" data-v="in" aria-label="Perbesar">+</button></div></div>' +
      '<section class="sp-cols"><div><div class="sp-ch" style="--c:var(--green)"><h3>Layak dibeli</h3><span>sinyal terkuat dulu</span></div>' + (B.slice(0, 10).map(function (x, i) { return spRow(x, i, 'g'); }).join('') || skel()) + '</div>' +
        '<div><div class="sp-ch" style="--c:var(--red)"><h3>Hindari atau kurangi</h3><span>peringatan terbanyak dulu</span></div>' + (H.slice(0, 10).map(function (x, i) { return spRow(x, i, 'r'); }).join('') || skel()) + '</div></section>' +
      '<div class="sp-neu"><span>Netral, belum ada sinyal jelas:</span>' + N.slice(0, 24).map(function (x) { return '<button data-sx="pick" data-v="' + esc(x.m.code) + '">' + esc(x.m.code) + '</button>'; }).join('') + '</div>' +
      '<div class="sp-how-w"><h5 class="sp-h5">Bobot tiap modul</h5>' + weightsHtml() + howHtml('') + '</div>' +
      '<p class="sx-note">Dibuat dari aturan sederhana dan bukan rekomendasi investasi.</p></div>';
  }

  // Kesimpulan per gaya (trading, swing, investasi)
  var HZ = [
    { k: 'trade', t: 'Trading', sub: 'jangka pendek', w: { trade: 2, broker: 1, swing: 1 }, lab: { g: 'Ikuti pick aktif', n: 'Belum ada setup jelas', r: 'Jangan masuk' } },
    { k: 'swing', t: 'Swing', sub: 'jangka menengah', w: { swing: 2, broker: 2, cons: 1 }, lab: { g: 'Siap beli bertahap', n: 'Tunggu momentum', r: 'Hindari / kurangi' } },
    { k: 'invest', t: 'Investasi', sub: 'jangka panjang', w: { invest: 2, cons: 1, holder: 1, insider: 1 }, lab: { g: 'Layak dicicil', n: 'Pantau dulu', r: 'Tunggu lebih murah' } }
  ];
  function horizons(by) {
    return HZ.map(function (h) {
      var s0 = 0, used = 0, pos = [], neg = [];
      Object.keys(h.w).forEach(function (k) {
        var x = by[k]; if (!x) return;
        var dir = x.v.c === 'g' ? 1 : x.v.c === 'r' ? -1 : 0;
        if (x.v.c !== 'd') used++;
        s0 += dir * h.w[k];
        if (dir > 0) pos.push(SEC_NAME[k]); else if (dir < 0) neg.push(SEC_NAME[k]);
      });
      var c = !used ? 'd' : s0 >= 2 ? 'g' : s0 <= -2 ? 'r' : 'n';
      return { h: h, c: c, label: c === 'd' ? 'Data minim' : h.lab[c], pos: pos, neg: neg };
    });
  }
  function leadHtml(x) {
    if (x.why) return '<p class="sp-lead">' + esc(x.why) + '</p>';
    var l = x.lines && x.lines[0];
    return l && l.indexOf('<p class="sx-why">') === 0 ? l.replace('sx-why', 'sp-lead') : '';
  }
  function pmPos(v, lo, hi) { return clamp((v - lo) / (hi - lo) * 100, 0, 100); }
  function priceMap(by, pxv) {
    var sw = by.swing.raw, cn = by.cons.raw, tr = by.trade.raw, picks = tr ? tr.rows.slice(0, 3) : [];
    var vals = [pxv]; if (sw) vals.push(sw.buy, sw.sell); if (cn && cn.target) vals.push(cn.target);
    picks.forEach(function (p) { vals.push(p.e, p.t1, p.sl); });
    vals = vals.filter(function (v) { return v > 0; });
    if (vals.length < 2) return '';
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.05 || hi * 0.02; lo -= pad; hi += pad;
    var P = function (v) { return pmPos(v, lo, hi); }, lanes = '';
    var seg = function (a, b, c, d) { var l = Math.min(P(a), P(b)), w = Math.abs(P(b) - P(a)); return '<div class="sp-sg" style="--l:' + l + '%;--w:' + w + '%;--c:' + c + ';--d:' + d + 's"></div>'; };
    var dot = function (v, c, d) { return '<div class="sp-dt" style="--l:' + P(v) + '%;--c:' + c + ';--d:' + d + 's"></div>'; };
    if (sw) lanes += '<div class="sp-ln"><div class="sp-lb">Rentang swing</div><div class="sp-tr">' + seg(sw.buy, sw.sell, 'linear-gradient(90deg,var(--green),var(--border2) 45%,var(--red))', 0.3) + dot(sw.buy, 'var(--green)', 0.9) + dot(sw.sell, 'var(--red)', 1) + '</div><div class="sp-vs">Batas beli <b class="mono sx-up">' + px(sw.buy) + '</b> · Batas jual <b class="mono sx-dn">' + px(sw.sell) + '</b></div></div>';
    if (cn && cn.target) lanes += '<div class="sp-ln"><div class="sp-lb">Target analis</div><div class="sp-tr">' + seg(pxv, cn.target, cn.target >= pxv ? 'var(--accent)' : 'var(--red)', 0.5) + dot(cn.target, cn.target >= pxv ? 'var(--accent)' : 'var(--red)', 1.2) + '</div><div class="sp-vs">Rata-rata <b class="mono">' + px(cn.target) + '</b> · potensi <b class="mono ' + sc(cn.up) + '">' + (cn.up > 0 ? '+' : '') + nf(cn.up, 1) + '%</b></div></div>';
    picks.forEach(function (p, i) {
      lanes += '<div class="sp-ln"><div class="sp-lb">' + esc((p.r.firm || 'Pick').replace(/ Sekuritas.*/i, '')) + '</div><div class="sp-tr">' + seg(p.sl, p.e, 'var(--red)', 0.7 + i * 0.15) + seg(p.e, p.t1, 'var(--green)', 0.9 + i * 0.15) + dot(p.e, 'var(--text)', 1 + i * 0.15) + '</div><div class="sp-vs">SL <b class="mono sx-dn">' + px(p.sl) + '</b> · Entry <b class="mono">' + px(p.e) + '</b> · TP1 <b class="mono sx-up">' + px(p.t1) + '</b></div></div>';
    });
    var ax = ''; for (var i = 0; i < 4; i++) { var v = lo + (hi - lo) * i / 3.4; ax += '<span style="left:' + P(v) + '%">' + px(v) + '</span>'; }
    return '<div class="sp-lanes"><div class="sp-now" style="left:' + P(pxv) + '%"><b class="mono">Harga ' + px(pxv) + '</b></div>' + lanes + '</div><div class="sp-ax mono">' + ax + '</div>';
  }
  function spBody(k, x, pxv) {
    var rw = x.raw, lead = leadHtml(x);
    if (!rw) return lead;
    if (k === 'cons') return '<div class="sp-big mono ' + sc(rw.up) + '">' + (rw.up > 0 ? '+' : '') + nf(rw.up, 1) + '%</div><p class="sp-cap">potensi dari harga sekarang ke target rata-rata</p>' +
      '<div class="sp-kv mono"><div><span>Target rata-rata</span><b>' + px(rw.target) + '</b></div><div><span>Beli</span><b class="sx-up">' + rw.buy + '</b></div><div><span>Netral</span><b>' + rw.neu + '</b></div><div><span>Jual</span><b class="sx-dn">' + rw.sell + '</b></div></div>' +
      '<div class="sp-track"><div class="sp-fill" style="width:' + rw.buyPct + '%"></div></div><p class="sp-cap">' + rw.total + ' analis meliput saham ini. ' + esc(x.why || '') + '</p>';
    if (k === 'trade') return lead + '<div class="sp-kv mono"><div><span>R:R rata-rata</span><b>1 : ' + nf(rw.avgRR, 1) + '</b></div><div><span>R:R terbaik</span><b class="sx-up">1 : ' + nf(rw.best.rr, 1) + '</b></div><div><span>Harga sekarang</span><b>' + px(rw.pxv) + '</b></div></div>' +
      (function () {
        var rowHtml = function (p) { return '<div class="sp-pick mono" data-sx="gotr" data-v="' + esc(p.r.ticker) + '" title="Buka di Analisis Tracker"><div><b>' + esc(p.r.firm || '') + '</b><span><i class="' + (p.sg > 0 ? 'sx-up' : 'sx-dn') + '">' + esc(p.r.type) + '</i> · ' + (p.run ? 'berjalan <i class="' + sc(p.now) + '">' + (p.now > 0 ? '+' : '') + nf(p.now, 1) + '%</i>' : (p.toE >= 0 ? 'menunggu naik ' : 'menunggu turun ') + nf(Math.abs(p.toE), 1) + '%') + '</span></div>' +
          '<div><span>Entry</span><b>' + px(p.e) + '</b></div><div><span>TP1</span><b class="sx-up">' + px(p.t1) + ' (+' + nf(p.gain, 1) + '%)</b></div><div><span>SL</span><b class="sx-dn">' + px(p.sl) + ' (−' + nf(p.risk, 1) + '%)</b></div><div><span>R:R</span><b class="' + (p.rr >= 1.5 ? 'sx-up' : p.rr < 1 ? 'sx-dn' : '') + '">1 : ' + nf(p.rr, 1) + '</b></div></div>'; };
        var first = rw.rows.slice(0, 3).map(rowHtml).join(''), more = rw.rows.length - 3;
        return first + (more > 0 ? '<button class="sp-lk sp-morebtn" data-sx="gotr" data-v="' + esc(rw.rows[0].r.ticker) + '">Lihat ' + more + ' pick lainnya di Analisis Tracker ›</button>' : '');
      })();
    if (k === 'invest') return lead + '<div class="sp-met mono">' + rw.items.map(function (it) { return '<div><span>' + esc(it[0]) + '</span><b class="' + (it[2] || '') + '">' + it[1] + '</b></div>'; }).join('') + '</div>';
    if (k === 'broker') {
      var mx = Math.max.apply(null, rw.top.concat(rw.bot).map(function (z) { return Math.abs(z.net); }).concat([1]));
      var bar = function (z, c) { return '<div class="sp-b"><span>' + bk(z.b.code, z.b.type, z.b.name) + '</span><div><i style="width:' + (Math.abs(z.net) / mx * 100) + '%;background:' + c + '"></i></div><b class="' + sc(z.net) + '">' + (z.net > 0 ? '+' : '') + fv(z.net) + '</b></div>'; };
      return lead + '<div class="sp-flow mono"><div><span>Smart money 5 hari</span><b class="' + sc(rw.sm) + '">' + (rw.sm > 0 ? '+' : '') + fv(rw.sm, true) + '</b></div><div><span>Asing 5 hari</span><b class="' + sc(rw.fn) + '">' + (rw.fn > 0 ? '+' : '') + fv(rw.fn, true) + '</b></div><div><span>Rezim 20 hari</span><b>' + esc(rw.rg.label) + '</b></div></div>' +
        '<div class="sp-bk"><div><h4>Net beli 5 hari</h4>' + (rw.top.map(function (z) { return bar(z, 'var(--green)'); }).join('') || '<p class="sp-cap">Tidak ada.</p>') + '</div><div><h4>Net jual 5 hari</h4>' + (rw.bot.map(function (z) { return bar(z, 'var(--red)'); }).join('') || '<p class="sp-cap">Tidak ada.</p>') + '</div></div>';
    }
    if (k === 'insider') return lead + '<div class="sp-tl mono">' + rw.L.slice(0, 5).map(function (e) {
      return '<div><b class="' + (e.act === 'BUY' ? 'sx-up' : 'sx-dn') + '">' + (e.act === 'BUY' ? 'Beli ' : 'Jual ') + fv(e.value, true) + '<br><small>' + esc(e.name) + (e.role ? ' · ' + esc(e.role) : '') + '</small></b><span>' + esc(dShort(U.axis[e.t])) + '</span></div>'; }).join('') + '</div>';
    return lead;
  }
  function stkDetail(code) {
    var m = U.by[code], by, pxv = lastPx(m, code), ch = chgOf(m);
    if (!_news) loadNews(function () { if (V.view === 'stk') renderBody(); });
    if (!_scr) loadScr(function () { if (V.view === 'stk') renderBody(); });
    if (!trkData() && !_trkLoading && !_trkErr) loadTrk(function () { if (V.view === 'stk') renderBody(); });
    var s0 = scoreOf(m); by = s0.by;
    var lab = scoreOk(s0) ? scoreLab(s0.score) : { c: 'd', t: 'Data minim' };
    var pos = (clamp(s0.score, -100, 100) + 100) / 200 * 100;
    var gSum = 0, rSum = 0;
    SEC_KEYS.forEach(function (k) { if (by[k].v.c === 'g') gSum += SEC_W[k]; else if (by[k].v.c === 'r') rSum += SEC_W[k]; });
    var calc = '<b>Saham ini:</b> bobot hijau ' + gSum + ', bobot merah ' + rSum + ', bobot modul berdata ' + s0.avail + ' → (' + gSum + ' − ' + rSum + ') ÷ ' + s0.avail + ' × 100 = <b>' + (s0.score > 0 ? '+' : '') + s0.score + '</b>.' +
      (scoreOk(s0) ? '' : ' Data belum cukup untuk menyimpulkan (perlu minimal ' + SC_MIN_KNOWN + ' modul berdata, 1 modul inti, bobot data ' + SC_MIN_AVAIL + ').');
    var hz = horizons(by);
    var secs = [
      ['s1', 'Peta harga', 'swing', by.swing], ['s2', 'Konsensus analis', 'cons', by.cons], ['s3', 'Trade', 'trade', by.trade], ['s4', 'Valuasi', 'invest', by.invest],
      ['s5', 'Broker summary', 'broker', by.broker], ['s6', 'Insider', 'insider', by.insider]
    ];
    var sec = function (id, title, k, x, bodyHtml) {
      return '<section class="sp-sec" id="sps-' + id + '"><div><h4>' + esc(title) + '</h4><span class="sp-tag ' + x.v.c + '">' + esc(x.v.t) + '</span>' +
        x.acts.map(function (a) { return '<button class="sp-lk" data-sx="' + a[0] + '" data-v="' + esc(a[2] || code) + '">' + esc(a[1]) + '</button>'; }).join('') + '</div><div>' + bodyHtml + '</div></section>';
    };
    var out = secs.map(function (z) {
      var body = z[0] === 's1' ? leadHtml(z[3]) + priceMap(by, pxv) : spBody(z[2], z[3], pxv);
      return sec(z[0], z[1], z[2], z[3], body);
    }).join('');
    // Lainnya: berita + kepemilikan
    var nw = by.news, hd = by.holder;
    var newsHtml = nw.raw && nw.raw.list.length ? '<ul class="sp-nl">' + nw.raw.list.slice(0, 4).map(function (it) {
      return '<li><a href="' + esc(it.link) + '" target="_blank" rel="noopener noreferrer">' + esc(it.title) + '</a><small>' + esc(it.source || '') + ' · ' + esc(timeAgo(it.ts)) + '</small></li>'; }).join('') + '</ul>' : leadHtml(nw);
    var holdHtml = hd.raw ? '<div class="sp-tl mono">' + hd.raw.L.slice(0, 4).map(function (e) { var d = e.cur - e.prev;
      return '<div><b class="' + sc(d) + '">' + (d > 0 ? '+' : '') + nf(d, 2) + ' pp<br><small>' + esc(e.name) + ' · ' + nf(e.prev, 2) + '% › ' + nf(e.cur, 2) + '%</small></b><span>' + esc(dShort(U.axis[e.t])) + '</span></div>'; }).join('') + '</div>' : leadHtml(hd);
    out += '<section class="sp-sec" id="sps-s7"><div><h4>Berita &amp; kepemilikan</h4><span class="sp-tag ' + nw.v.c + '">' + esc(nw.v.t) + '</span><button class="sp-lk" data-sx="gopage" data-v="pasar">Buka Pasar Live</button></div>' +
      '<div><h5 class="sp-h5">Berita 7 hari</h5>' + newsHtml + '<h5 class="sp-h5">Pemegang saham &gt;5%</h5>' + holdHtml + '<button class="sp-lk" data-sx="open" data-v="' + esc(code) + '">Buka Kepemilikan</button></div></section>';
    var navs = [['s0', 'Ringkasan'], ['s1', 'Peta harga'], ['s2', 'Konsensus'], ['s3', 'Trade'], ['s4', 'Valuasi'], ['s5', 'Broker'], ['s6', 'Insider'], ['s7', 'Lainnya']];
    return '<div class="sp sp-det"><nav class="sp-dnav" id="spNav"><button class="back" data-sx="spback">‹ Radar</button><i></i>' + navs.map(function (n, i) { return '<button data-sx="spgo" data-v="' + n[0] + '"' + (i === 0 ? ' class="on"' : '') + '>' + n[1] + '</button>'; }).join('') + '</nav>' +
      '<header id="sps-s0"><div class="sp-dhero"><div><div class="sp-crumb">' + esc(m.name) + ' · ' + esc(m.sector || '') + '</div><div class="sp-dtk">' + esc(code) + '</div></div>' +
        '<div class="sp-dpx"><b class="mono">' + px(pxv) + '</b><span class="mono ' + sc(ch) + '">' + fp(ch, 2) + '</span></div>' +
        '<div class="sp-radar"><div class="sc2 mono ' + (lab.c === 'g' ? 'sx-up' : lab.c === 'r' ? 'sx-dn' : 'sx-y') + '">' + (s0.score > 0 ? '+' : '') + s0.score + '<small> / 100</small></div><div class="sp-rsb"><i style="left:' + pos + '%"></i></div><span class="sp-rv ' + lab.c + '">' + lab.t + '</span>' +
          '<div class="sp-rl mono"><span>≤ −' + SC_TH + ' Hindari</span><span>Netral</span><span>≥ +' + SC_TH + ' Layak</span></div></div></div>' +
        '<div class="sp-mods">' + SEC_KEYS.map(function (k) { var x = by[k], tg = { swing: 's1', cons: 's2', invest: 's4', trade: 's3', news: 's7', broker: 's5', insider: 's6', holder: 's7' }[k];
          return '<button class="sp-mod" data-sx="spgo" data-v="' + tg + '" style="--c:' + colorOf(x.v.c) + '"><i></i><div><b>' + SEC_NAME[k] + ' <em class="sp-wx" title="' + (SEC_CORE[k] ? 'Modul inti' : 'Modul pelengkap') + ', bobot ' + SEC_W[k] + '">×' + SEC_W[k] + '</em></b><span>' + esc(x.v.t) + '</span></div></button>'; }).join('') + '</div>' +
        howHtml(calc) +
        '<div class="sp-hz">' + hz.map(function (z) {
          return '<div style="--c:' + colorOf(z.c) + '" title="' + esc('Bobot ' + z.h.t + ': ' + Object.keys(z.h.w).map(function (k) { return SEC_NAME[k] + ' ×' + z.h.w[k]; }).join(', ') + '. Layak bila ≥ +2, Hindari bila ≤ −2.') + '"><em>' + z.h.t + ' · ' + z.h.sub + '</em><strong>' + esc(z.label) + '</strong><small>' +
            (z.pos.length || z.neg.length ? (z.pos.length ? 'Didukung ' + esc(z.pos.join(', ')) : '') + (z.neg.length ? (z.pos.length ? '. ' : '') + 'Hati-hati: ' + esc(z.neg.join(', ')) : '') : 'Belum ada sinyal searah') +
            (z.pos.length && z.neg.length ? '. Sinyal bertentangan.' : '') + '</small></div>'; }).join('') + '</div></header>' +
      out + '<p class="sx-note">Kesimpulan dibuat dari aturan sederhana pada data yang tersedia dan bukan rekomendasi investasi. Cocokkan dengan profil risiko dan tujuan Anda (investasi, swing, atau trading).</p></div>';
  }
  var _spIO = null;
  function spObserve() {
    if (_spIO) { _spIO.disconnect(); _spIO = null; }
    var nav = host && host.querySelector('#spNav'); if (!nav || !('IntersectionObserver' in window)) return;
    var btns = [].slice.call(nav.querySelectorAll('[data-v]'));
    _spIO = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        var id = e.target.id.replace('sps-', '');
        btns.forEach(function (b) { var on = b.getAttribute('data-v') === id; b.classList.toggle('on', on); if (on && nav.scrollWidth > nav.clientWidth) nav.scrollTo({ left: Math.max(0, b.offsetLeft - 90), behavior: 'smooth' }); });
      });
    }, { rootMargin: '-20% 0px -65% 0px' });
    btns.forEach(function (b) { var el = host.querySelector('#sps-' + b.getAttribute('data-v')); if (el) _spIO.observe(el); });
  }
  // Peta sinyal hidup: gelembung melayang pelan dan condong ke kursor (berhenti bila reduced-motion)
  var _spRaf = false;
  function spLive() {
    if (_spRaf) return; _spRaf = true;
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion:reduce)').matches;
    function frame(ms) {
      requestAnimationFrame(frame);
      var map = host && host.querySelector('#spMap'); if (!map || still || document.hidden) return;
      var W = map.clientWidth, col = W / 11, mx = Math.min(18, col * 0.22), t = ms / 1000;
      if (!map._b) {
        map._b = [].slice.call(map.querySelectorAll('.sp-bub')).map(function (el, i) { return { el: el, hx: parseFloat(el.style.left) / 100, py: parseFloat(el.style.top) + 20, ph: i * 1.7, sp: 0.5 + (i % 5) * 0.09, cx: 0, cy: 0, s: 1, i: 1 }; });
        map.addEventListener('pointermove', function (e) { var r = map.getBoundingClientRect(); map._m = { x: e.clientX - r.left, y: e.clientY - r.top }; map.classList.add('hot'); map.style.setProperty('--gx', map._m.x + 'px'); map.style.setProperty('--gy', map._m.y + 'px'); });
        map.addEventListener('pointerleave', function () { map._m = null; map.classList.remove('hot'); });
      }
      var mp = map._m;
      map._b.forEach(function (b) {
        var tx = 0, ty = 0, hov = false;
        if (mp) { hov = b.el.matches(':hover'); var dx = mp.x - b.hx * W, dy = mp.y - b.py, d = Math.sqrt(dx * dx + dy * dy) || 1, k = Math.max(0, 1 - d / 150); if (!hov) { tx = dx / d * k * mx * 1.6; ty = dy / d * k * 9; } }
        b.cx += (tx - b.cx) * 0.12; b.cy += (ty - b.cy) * 0.12; b.s += ((hov ? 1.12 : 1) - b.s) * 0.18; b.i += ((hov ? 0 : 1) - b.i) * 0.12;
        var x = clamp(Math.sin(t * b.sp + b.ph) * Math.min(9, col * 0.16) * b.i + b.cx, -mx, mx), y = clamp(Math.cos(t * b.sp * 0.8 + b.ph) * 4 * b.i + b.cy, -6, 6);
        b.el.style.setProperty('--dx', x.toFixed(1) + 'px'); b.el.style.setProperty('--dy', y.toFixed(1) + 'px'); b.el.style.setProperty('--s', b.s.toFixed(3));
      });
    }
    requestAnimationFrame(frame);
  }
  function viewStk() {
    var st = V.stk;
    return vhead('stk').replace(/<div class="sx-gbtns"[\s\S]*?<\/div>/, '') +
      (st.code ? '<div class="sx-bar">' + searchBox('sxPQ', st.q, 'Cari kode atau nama saham, mis. BBCA') + '</div>' : '') +
      '<div id="sxBody"></div>';
  }
  function bodyStk() {
    var st = V.stk, q = (st.q || '').trim().toUpperCase();
    if (q) {
      var hits = U.list.filter(function (m) { return matchQ(m, q); }).sort(function (a, b) { return (a.code.indexOf(q) === 0 ? 0 : 1) - (b.code.indexOf(q) === 0 ? 0 : 1) || a.code.localeCompare(b.code); }).slice(0, 12);
      if (!hits.length) return empty('Saham "' + esc(q) + '" tidak ditemukan.');
      return '<div class="sx-sugg">' + hits.map(function (m) {
        return '<button class="sx-sg" data-sx="pick" data-v="' + esc(m.code) + '"><b>' + esc(m.code) + '</b><small>' + esc(m.name) + '</small></button>';
      }).join('') + '</div>';
    }
    if (st.code && U.by[st.code]) { setTimeout(spObserve, 50); return stkDetail(st.code); }
    var h = stkLanding(); setTimeout(spLive, 50); setTimeout(function () { var sc1 = host && host.querySelector('.sp-sc'); if (sc1 && sc1.scrollWidth > sc1.clientWidth) sc1.scrollLeft = (sc1.scrollWidth - sc1.clientWidth) / 2; }, 60); return h;
  }

  // Buka Valuasi untuk satu saham dari StockPro. Indeks valuasi dimuat lazy, dan vlSelectStock
  // diam-diam berhenti kalau indeks belum siap, jadi panggilannya diulang sampai berhasil.
  function goVal(code) {
    try { window.showPage('valuasi'); } catch (_) {}
    try { if (typeof window.vlEnsureCharts === 'function') window.vlEnsureCharts(); } catch (_) {}
    [0, 300, 900, 1800, 3500].forEach(function (ms) {
      setTimeout(function () {
        try { if (typeof window.vlSelectStock === 'function') window.vlSelectStock(code); } catch (_) {}
      }, ms);
    });
    window.scrollTo(0, 0);
  }
  // Buka Analisis Tracker untuk satu kode. Data Tracker bisa termuat lambat, dan
  // __TR_openAnalisis hanya mencoba sekitar 2 detik, jadi panggilannya diulang sampai ~7 detik.
  function goTr(code) {
    try { window.showPage('tracker'); } catch (_) {}
    [0, 400, 1000, 2000, 3500, 7000].forEach(function (ms) {
      setTimeout(function () {
        try { if (typeof window.__TR_openAnalisis === 'function') window.__TR_openAnalisis(code); } catch (_) {}
      }, ms);
    });
    window.scrollTo(0, 0);
  }
  var BODY = { stk: bodyStk, cons: bodyCons, news: bodyNews, gems: bodyGems, accum: bodyAccum, smart: bodySmart, bh: bodyBH, foreign: bodyForeign };
  var VIEW = { stk: viewStk, cons: viewCons, news: viewNews, today: viewToday, gems: viewGems, accum: viewAccum, smart: viewSmart, bh: viewBH, foreign: viewForeign };
  function shell() {
    return '<div class="sx">' +
      '<div class="sx-top">' +
        '<span class="sx-brand">' + ic('radar') + 'SCREENER</span>' +
        '<div class="sx-tabs-wrap">' +
          '<button class="sx-arr l" data-sx="tscroll" data-v="-1" aria-label="Geser kiri">' + ic('left') + '</button>' +
          '<div class="sx-tabs" id="sxTabs" role="tablist">' + VIEWS.map(function (v) {
            return '<button role="tab" class="sx-tab" data-sx="view" data-v="' + v.k + '">' + ic(v.ico) + '<span class="t"><b>' + esc(v.label) + '</b><small>' + esc(v.sub) + '</small></span></button>';
          }).join('') + '</div>' +
          '<button class="sx-arr r" data-sx="tscroll" data-v="1" aria-label="Geser kanan">' + ic('right') + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="sx-view" id="sxView"></div>' +
    '</div>';
  }
  function syncTabs() {
    host.querySelectorAll('.sx-tab').forEach(function (b) { var on = b.getAttribute('data-v') === V.view; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    var tabs = host.querySelector('#sxTabs'), on = tabs && tabs.querySelector('.sx-tab.on');
    if (on && tabs.scrollWidth > tabs.clientWidth) {
      var l = on.offsetLeft - tabs.offsetLeft, r = l + on.offsetWidth;
      if (l < tabs.scrollLeft || r > tabs.scrollLeft + tabs.clientWidth) tabs.scrollTo({ left: Math.max(0, l - 40), behavior: 'smooth' });
    }
    arrows();
  }
  function arrows() {
    var tabs = host && host.querySelector('#sxTabs'); if (!tabs) return;
    var w = host.querySelector('.sx-tabs-wrap');
    w.classList.toggle('can-l', tabs.scrollLeft > 4);
    w.classList.toggle('can-r', tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 4);
  }
  function renderView() {
    if (!host) return;
    syncTabs();
    var el = host.querySelector('#sxView');
    if (!U) { ensureUniverse(renderView); return; }
    if (!U.list.length) { el.innerHTML = empty('Data harga (ohlc.json) belum tersedia.'); return; }
    if (V.view === 'stk') V.guide.stk = null;
    if (V.guide[V.view] === undefined) { V.guide[V.view] = load('sx_seen_' + V.view) ? null : 'how'; store('sx_seen_' + V.view, '1'); }
    try {
      el.innerHTML = VIEW[V.view]();
      renderBody();
    } catch (e) {
      console.error('[screener]', e);
      el.innerHTML = empty('Terjadi kesalahan saat menampilkan data. ' + esc(e.message));
    }
  }
  function renderBody() {
    var f = BODY[V.view], b = host.querySelector('#sxBody');
    if (f && b) b.innerHTML = f();
  }
  function rerenderKeepScroll() { var y = window.pageYOffset; renderView(); window.scrollTo(0, y); }
  // Buka halaman Konsensus > Per Saham, sudah terfilter ke satu kode.
  function goConsensus(code) {
    try {
      if (typeof window.showPage === 'function') window.showPage('consensus');
      if (typeof window.switchConsensusView === 'function') window.switchConsensusView('stock');
      var inp = document.getElementById('consensusSearch'); if (inp) inp.value = code;
      if (typeof window.renderConsensusCards === 'function') window.renderConsensusCards();
      window.scrollTo(0, 0);
    } catch (err) { console.warn('[screener] goConsensus', err); }
  }
  function onClick(e) {
    var el = e.target.closest && e.target.closest('[data-sx]');
    if (!el || !host.contains(el)) return;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    var a = el.getAttribute('data-sx'), v = el.getAttribute('data-v');
    var G = V.gems, Ac = V.accum, Sm = V.smart, Bh = V.bh, Fx = V.foreign, C = V.cal;
    switch (a) {
      case 'view': V.view = v; store('sx_view', v); renderView(); host.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
      case 'nper': V.news.per = v; V.news.limit = 30; renderView(); return;
      case 'nmore': V.news.limit += 30; renderBody(); return;
      case 'gopage': e.stopPropagation(); if (typeof window.showPage === 'function') { window.showPage(v); window.scrollTo(0, 0); } return;
      case 'cv': V.cons.v = v; V.cons.limit = 30; renderView(); return;
      case 'cmin': V.cons.min = +v; V.cons.limit = 30; renderView(); return;
      case 'csort': V.cons.sort = v; renderView(); return;
      case 'cmore': V.cons.limit += 30; renderBody(); return;
      case 'gocons': e.stopPropagation(); goConsensus(v); return;
      case 'pick': V.stk.code = v; V.stk.q = ''; store('sx_stk', v); try { if (window.ESCode) window.ESCode.set(v); } catch (_) {} renderView(); window.scrollTo(0, 0); return;
      case 'gotr': e.stopPropagation(); goTr(v); return;
      case 'spzoom': spZoomStep(v === 'in' ? 1 : -1); return;
      case 'spback': V.stk.code = ''; V.stk.q = ''; renderView(); window.scrollTo(0, 0); return;
      case 'spgo': var tg = host.querySelector('#sps-' + v); if (tg) tg.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
      case 'godash': e.stopPropagation(); if (typeof window.selectStock === 'function') window.selectStock(v); return;
      case 'goval': e.stopPropagation(); goVal(v); return;
      case 'tscroll': var tb = host.querySelector('#sxTabs'); tb.scrollBy({ left: +v * tb.clientWidth * 0.7, behavior: 'smooth' }); return;
      case 'guide': V.guide[V.view] = V.guide[V.view] === v ? null : v; rerenderKeepScroll(); return;
      case 'open': e.stopPropagation(); if (U && U.by[v]) A.openStock(v); return;
      case 'asof': V.asOf = +v; break;
      case 'daynav': V.asOf = clamp(V.asOf - +v, 0, 9); break;
      case 'tacc': V.acc = !V.acc; break;
      case 'topen': V.view = 'gems'; G.preset = v; G.limit = 50; G.tier = 0; G.liq = 'all'; G.cap = 'all'; renderView(); host.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
      case 'gpre': G.preset = v; G.limit = 50; break;
      case 'gtier': G.tier = +v; G.limit = 50; break;
      case 'gcap': G.cap = v; G.limit = 50; break;
      case 'gliq': G.liq = v; G.limit = 50; break;
      case 'gsort': if (G.sort === v) G.dir = -G.dir; else { G.sort = v; G.dir = -1; } renderBody(); return;
      case 'gmore': G.limit += 50; renderBody(); return;
      case 'amode': Ac.mode = v; break;
      case 'apre': Ac.preset = Ac.preset === v ? '' : v; Ac.limit = 10; break;
      case 'atop': Ac.top = +v; break;
      case 'atrend': Ac.trend = v; break;
      case 'amkt': Ac.market = v; break;
      case 'areset': Ac.preset = ''; Ac.minLose = Ac.minLoss = Ac.maxDays = Ac.minNet = 0; Ac.top = 5; Ac.trend = 'acc'; Ac.market = 'reg'; break;
      case 'adir': Ac.dir = -Ac.dir; break;
      case 'amore': Ac.limit += 10; renderBody(); return;
      case 'smode': Sm.mode = v; Sm.limit = 50; break;
      case 'srng': Sm.rng = v; Sm.a = Sm.b = null; break;
      case 'spl': Sm.pl = v; break;
      case 'ssort': if (Sm.sort === v) Sm.dir = -Sm.dir; else { Sm.sort = v; Sm.dir = -1; } renderBody(); return;
      case 'smore': Sm.limit += 50; renderBody(); return;
      case 'bmode': Bh.mode = v; Bh.lim = { a: 10, d: 10 }; break;
      case 'bper': Bh.per = v; break;
      case 'bhper': Bh.hper = v; break;
      case 'bflip': Bh.flip = v === '1'; break;
      case 'bmore': Bh.lim[v] += 10; renderBody(); return;
      case 'fmode': Fx.mode = v; break;
      case 'fside': Fx.side = v; break;
      case 'fpre': Fx.preset = v; break;
      case 'fper': Fx.per = v; break;
      case 'rd': Fx.rd = +v; Fx.rexp = undefined; break;
      case 'rsort': if (Fx.rsort === v) Fx.rdir = -Fx.rdir; else { Fx.rsort = v; Fx.rdir = -1; } renderBody(); return;
      case 'rtog': Fx.rexp = (Fx.rexp === undefined ? (host.querySelector('.sx-rd-row.open .sx-rd-main') || {getAttribute: function () { return ''; }}).getAttribute('data-v') : Fx.rexp) === v ? '' : v; renderBody(); return;
      case 'fsort': if (Fx.sort === v) Fx.dir = -Fx.dir; else { Fx.sort = v; Fx.dir = -1; } renderBody(); return;
      default: return;
    }
    rerenderKeepScroll();
  }
  function onChange(e) {
    var id = e.target.id, v = e.target.value;
    var Ac = V.accum, Sm = V.smart, Fx = V.foreign;
    switch (id) {
      case 'sxGSector': V.gems.sector = v; V.gems.limit = 50; renderBody(); return;
      case 'sxASort': Ac.sort = v; renderBody(); return;
      case 'sxMinLose': Ac.minLose = Math.max(0, +v || 0); break;
      case 'sxMinLoss': Ac.minLoss = Math.max(0, +v || 0); break;
      case 'sxMaxDays': Ac.maxDays = Math.max(0, +v || 0); break;
      case 'sxMinNet': Ac.minNet = +v || 0; break;
      case 'sxFrom': if (v) { Sm.a = idxOfDate(v); if (Sm.b == null) Sm.b = U.n - 1; Sm.rng = ''; } rerenderKeepScroll(); return;
      case 'sxTo': if (v) { Sm.b = idxOfDate(v); if (Sm.a == null) Sm.a = 0; Sm.rng = ''; } rerenderKeepScroll(); return;
      case 'sxFLiq': Fx.liq = +v || 0; renderBody(); return;
      case 'sxFShow': Fx.show = +v || 50; renderBody(); return;
      default: return;
    }
    Ac.limit = 10; renderBody();
  }
  var _qt = null;
  function onInput(e) {
    var id = e.target.id, map = { sxGQ: 'gems', sxAQ: 'accum', sxSQ: 'smart', sxBQ: 'bh', sxFQ: 'foreign', sxNQ: 'news', sxCQ: 'cons', sxPQ: 'stk' };
    if (!map[id]) return;
    V[map[id]].q = e.target.value.trim();
    clearTimeout(_qt); _qt = setTimeout(renderBody, 160);
  }

  // ─────────────────────────── CSS ───────────────────────────
  var CSS = [
    '.sx{display:flex;flex-direction:column;gap:14px;min-width:0}',
    '.sx-ic{width:16px;height:16px;flex-shrink:0;vertical-align:-3px}',
    '.sx-up{color:var(--green)!important}.sx-dn{color:var(--red)!important}.sx-pu{color:#8b5cf6}[data-theme="dark"] .sx-pu{color:#c4a3ff}.sx-y{color:var(--yellow)!important}',
    '.sx-mute{color:var(--text3)}.mono{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}',
    '.sx-grow{flex:1}',
    '.sx-newslist{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:10px}',
    '.sx-news{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:12px 14px;min-width:0;display:flex;flex-direction:column;gap:8px}',
    '.sx-news-h{display:flex;align-items:center;gap:10px;min-width:0}',
    '.sx-news-n{margin-left:auto;font-size:11px;color:var(--text3);white-space:nowrap}',
    '.sx-news ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}',
    '.sx-news li{display:flex;flex-direction:column;gap:2px;min-width:0}',
    '.sx-news li a{font-size:13px;line-height:1.35;color:var(--text);text-decoration:none;font-weight:600}',
    '.sx-news li a:hover{color:var(--accent);text-decoration:underline}',
    '.sx-news li small{font-size:11px;color:var(--text3)}',
    '.sx-lnk{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11px;font-weight:700;padding:5px 10px;border-radius:9px;border:1px solid var(--border2);background:transparent;color:var(--text2);cursor:pointer}',
    '.sx-lnk:hover{color:var(--accent);border-color:var(--accent)}',
    '.sx-sh{margin-bottom:12px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:14px 16px}',
    '.sx-sh-l{display:flex;flex-direction:column;min-width:0;flex:1 1 220px}.sx-sh-c{font-size:24px;line-height:1.1;letter-spacing:.02em}.sx-sh-l span{font-size:13px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sx-sh-l small{font-size:11px;color:var(--text3)}',
    '.sx-sh-r{display:flex;flex-direction:column;align-items:flex-end}.sx-sh-r b{font-size:22px}.sx-sh-r span{font-size:12px;font-weight:700}',
    '.sx-sh-s{display:flex;gap:6px;flex-wrap:wrap;flex-basis:100%}',
    '.sx-secgrid{grid-auto-flow:dense;display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}',
    '.sx-sec{background:var(--card);border:1px solid var(--border);border-top:3px solid var(--border2);border-radius:14px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;min-width:0}',
    '.sx-sec.g{border-top-color:var(--green)}.sx-sec.r{border-top-color:var(--red)}.sx-sec.n{border-top-color:var(--yellow)}',
    '.sx-sec header{display:flex;align-items:center;gap:8px;min-width:0}.sx-sec h4{margin:0;font-size:13px;font-weight:800;flex:1;min-width:0}',
    '.sx-sec-i{display:inline-flex;color:var(--text3)}',
    '.sx-sec-b{display:flex;flex-direction:column;gap:7px;min-width:0}',
    '.sx-kv{display:flex;justify-content:space-between;gap:10px;font-size:12px;color:var(--text3)}.sx-kv b{color:var(--text);font-size:12.5px}',
    '.sx-pick{display:grid;grid-template-columns:auto 1fr;column-gap:8px;font-size:12px;align-items:baseline}.sx-pick small{grid-column:1/-1;color:var(--text3);font-size:11px}',
    '.sx-nl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}.sx-nl li{display:flex;flex-direction:column;gap:1px}.sx-nl a{font-size:12.5px;line-height:1.35;color:var(--text);font-weight:600;text-decoration:none}.sx-nl a:hover{color:var(--accent);text-decoration:underline}.sx-nl small{font-size:11px;color:var(--text3)}',
    '.sx-bcol{display:flex;flex-direction:column;gap:5px}.sx-bcol small{font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase}',
    '.sx-bchip{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}',
    '.sx-sugg{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px}',
    '.sx-sg{display:flex;flex-direction:column;align-items:flex-start;gap:1px;font:inherit;text-align:left;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text);cursor:pointer;min-width:0}.sx-sg:hover{border-color:var(--accent)}.sx-sg b{font-size:14px}.sx-sg small{font-size:11px;color:var(--text3);max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sx-bar .sx-search:only-child{flex:1;max-width:460px}.sx-bar .sx-search:only-child input{width:100%}',
    '.sx-secgrid+.sx-note{margin-top:12px}',
    '.sx-ptbl{display:flex;flex-direction:column;gap:8px}',
    '@media (min-width:900px){.sx-sec.k-trade{grid-column:span 2}.sx-sec.k-trade .sx-ptbl{display:grid;grid-template-columns:1fr 1fr}.sx-sec.k-trade .sx-ptbl>small{grid-column:1/-1}}',
    '.sx-pt{border:1px solid var(--border);border-radius:10px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.sx-pt .h{display:flex;align-items:center;gap:8px;font-size:11.5px;min-width:0}.sx-pt .h span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sx-pt .h em{font-style:normal;font-weight:700;color:var(--text3);white-space:nowrap}.sx-pt .h em.on{color:var(--accent)}',
    '.sx-pt .g{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;font-size:10px;color:var(--text3)}.sx-pt .g span{display:flex;flex-direction:column;gap:1px;min-width:0}.sx-pt .g b{font-size:12px;color:var(--text);white-space:nowrap}.sx-pt .g b small{display:block;font-size:10px;font-weight:700}',
    '.sx-dec{background:var(--card);border:1px solid var(--border2);border-radius:16px;padding:14px 16px;margin-bottom:12px;display:flex;flex-direction:column;gap:12px}',
    '.sx-dec-t{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}.sx-dec-t b{font-size:14px;letter-spacing:.04em;text-transform:uppercase}.sx-dec-t small{font-size:11.5px;color:var(--text3)}',
    '.sx-dec-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
    '.sx-dc{border:1px solid var(--border);border-left:4px solid var(--border2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:6px;min-width:0}',
    '.sx-dc.g{border-left-color:var(--green);background:var(--green-bg)}.sx-dc.r{border-left-color:var(--red);background:rgba(239,68,68,.08)}.sx-dc.n{border-left-color:var(--yellow)}',
    '.sx-dc-h{display:flex;align-items:center;gap:7px;font-size:12.5px}.sx-dc-h small{color:var(--text3);font-size:11px}',
    '.sx-dc-v{font-size:19px;font-weight:800;line-height:1.2}.sx-dc.g .sx-dc-v{color:var(--green)}.sx-dc.r .sx-dc-v{color:var(--red)}.sx-dc.n .sx-dc-v{color:var(--yellow)}.sx-dc.d .sx-dc-v{color:var(--text3)}',
    '.sx-dc-r{display:flex;flex-direction:column;gap:2px;font-size:11.5px;font-weight:600}.sx-dc-c{margin:2px 0 0;font-size:11.5px;color:var(--yellow);line-height:1.4}',
    '.sp{container-type:inline-size;display:flex;flex-direction:column;min-width:0}',
    '.sp-hero{padding:18px 0 6px;display:grid;grid-template-columns:1.25fr 1fr;gap:24px;align-items:end}',
    '.sp-h1{margin:0;font-size:clamp(22px,3.1cqw,38px);line-height:1.1;font-weight:800;letter-spacing:-.02em}',
    '.sp-sub{margin:10px 0 0;color:var(--text3);font-size:13px;max-width:54ch}',
    '.sp-cnt{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--border);border-radius:18px;overflow:hidden;background:var(--card)}',
    '.sp-cnt div{padding:14px 16px;border-right:1px solid var(--border)}.sp-cnt div:last-child{border:0}',
    '.sp-cnt b{display:block;font-size:clamp(28px,4cqw,48px);line-height:1;font-weight:800}',
    '.sp-cnt span{font-size:12px;color:var(--text3)}',
    '.sp-rh{margin:14px 0 0;font-size:17px;font-weight:800}',
    '.sp-scw{position:relative;margin-top:12px}',
    '.sp-zrow{display:none}',
    '.sp-sc{touch-action:pan-x pan-y;overflow-x:auto;scrollbar-width:none;border-radius:20px;border:1px solid var(--border);background:var(--card)}',
    '.sp-map{position:relative;min-width:1000px;height:312px}',
    '.sp-zone{position:absolute;top:0;bottom:0}',
    '.sp-zone.r{left:0;width:30%;background:linear-gradient(90deg,color-mix(in srgb,var(--red) 18%,transparent),transparent)}',
    '.sp-zone.g{right:0;width:30%;background:linear-gradient(270deg,color-mix(in srgb,var(--green) 18%,transparent),transparent)}',
    '.sp-zl{position:absolute;top:12px;font-size:12px;font-weight:700}',
    '.sp-axis{position:absolute;left:0;right:0;bottom:34px;border-top:1px solid var(--border2)}',
    '.sp-tick{position:absolute;bottom:10px;transform:translateX(-50%);font-size:11px;color:var(--text3)}',
    '.sp-mid{position:absolute;top:0;bottom:34px;left:50%;border-left:1px dashed var(--border2)}',
    '.sp-bub{position:absolute;display:inline-flex;align-items:center;gap:8px;transform:translate(calc(-50% + var(--dx,0px)),var(--dy,0px)) scale(var(--s,1));font:inherit;font-size:14px;font-weight:800;padding:5px 15px 5px 5px;border-radius:99px;border:1px solid var(--c);background:color-mix(in srgb,var(--c) 20%,var(--card));color:var(--text);cursor:pointer;white-space:nowrap;animation:sp-drop .6s var(--d) cubic-bezier(.2,.9,.3,1.3) both;transition:background .2s,color .2s;will-change:transform}',
    '.sp-bub:hover{background:var(--c);color:#06120d;z-index:3}',
    '.sp-lgw{position:relative;flex:none;width:28px;height:28px;border-radius:50%;overflow:hidden;display:grid;place-items:center;background:var(--border2);font-style:normal}',
    '.sp-lgw b{font-size:10px;font-weight:800;color:var(--text2)}',
    '.sp-lgw img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#fff}',
    '.sp-glow{position:absolute;width:240px;height:240px;margin:-120px 0 0 -120px;left:var(--gx,-999px);top:var(--gy,-999px);background:radial-gradient(closest-side,color-mix(in srgb,var(--accent) 22%,transparent),transparent);opacity:0;transition:opacity .3s;pointer-events:none}',
    '.sp-map.hot .sp-glow{opacity:1}',
    '@keyframes sp-drop{from{opacity:0;transform:translate(-50%,-26px)}}',
    '.sp-cols{display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:30px}',
    '.sp-ch{display:flex;align-items:baseline;justify-content:space-between;border-bottom:2px solid var(--c);padding-bottom:8px;margin-bottom:4px}',
    '.sp-ch h3{margin:0;font-size:20px;font-weight:800;color:var(--c)}.sp-ch span{font-size:12px;color:var(--text3)}',
    '.sp-row{display:grid;grid-template-columns:28px 1fr auto;gap:4px 14px;align-items:center;width:100%;font:inherit;color:inherit;text-align:left;background:transparent;border:0;border-bottom:1px solid var(--border);border-radius:12px;padding:14px 8px;cursor:pointer;transition:background .2s}',
    '.sp-row:hover{background:var(--card)}',
    '.sp-row .rk{font-size:14px;font-weight:700;color:var(--text3)}',
    '.sp-row .tk{font-size:21px;line-height:1;font-weight:800}.sp-row .tk small{font-size:12px;font-weight:400;color:var(--text3);margin-left:8px}',
    '.sp-row .pxv{text-align:right;font-weight:700}.sp-row .pxv small{display:block;font-size:12px}',
    '.sp-dots{display:flex;gap:3px;margin-top:8px;align-items:center}',
    '.sp-scv{margin-left:8px;font-size:11px;font-weight:800}',
    '.sp-wx{font-style:normal;font-size:11px;font-weight:700;color:var(--text3)}',
    '.sp-wt{display:grid;gap:8px}.sp-wt>div{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.sp-wt em{font-style:normal;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);min-width:74px}',
    '.sp-wt span{font-size:12px;padding:3px 10px;border-radius:99px;border:1px solid var(--border);color:var(--text2)}.sp-wt span.c{background:color-mix(in srgb,var(--accent) 14%,transparent);border-color:transparent;color:var(--text)}',
    '.sp-how{margin-top:10px;border:1px solid var(--border);border-radius:12px;padding:8px 12px;font-size:12px;line-height:1.55;color:var(--text2)}',
    '.sp-how summary{cursor:pointer;font-weight:700;color:var(--text)}.sp-how p{margin:8px 0 0}.sp-how .sp-calc{padding:8px 10px;border-radius:8px;background:var(--card)}',
    '.sp-how-w{margin-top:18px}.sp-how-w .sp-h5{margin-top:0}',
    '.sp-dots i{width:16px;height:5px;border-radius:3px;background:var(--border2)}.sp-dots i.p{background:var(--green)}.sp-dots i.w{background:var(--red)}',
    '.sp-row .tz{grid-column:2/-1;display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:2px}',
    '.sp-rs{font-size:11.5px;padding:2px 9px;border-radius:99px;background:var(--border);color:var(--text2)}',
    '.sp-rs.g{background:color-mix(in srgb,var(--green) 16%,transparent);color:var(--green)}.sp-rs.r{background:color-mix(in srgb,var(--red) 16%,transparent);color:var(--red)}',
    '.sp-row .go{margin-left:auto;font-size:12px;font-weight:700;color:var(--accent)}',
    '.sp-neu{margin-top:26px;padding:14px 16px;border:1px dashed var(--border2);border-radius:16px;display:flex;gap:8px 10px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--text3)}',
    '.sp-neu button{font:inherit;font-weight:800;font-size:13px;color:var(--text);padding:2px 10px;border-radius:99px;border:1px solid var(--border);background:transparent;cursor:pointer}',
    '.sp-neu button:hover{border-color:var(--accent)}',
    '.sp-dnav{position:sticky;top:var(--smm-top,0px);z-index:8;display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none;padding:10px 0;background:linear-gradient(var(--bg) 70%,transparent)}',
    '.sp-dnav button{flex:none;font:inherit;background:none;border:1px solid var(--border);border-radius:99px;padding:5px 14px;font-size:12px;font-weight:700;color:var(--text3);cursor:pointer}',
    '.sp-dnav button.on{background:var(--text);color:var(--bg);border-color:var(--text)}',
    '.sp-dnav .back{color:var(--accent);border-color:var(--accent);margin-right:4px}',
    '.sp-dnav i{flex:none;width:1px;height:18px;background:var(--border);margin:0 4px}',
    '.sp-dhero{display:grid;grid-template-columns:1fr auto;align-items:end;gap:8px 20px;padding:10px 0 4px}',
    '.sp-crumb{font-size:13px;color:var(--text3)}',
    '.sp-dtk{font-size:clamp(46px,11cqw,84px);line-height:.9;font-weight:800;letter-spacing:-.04em;margin-top:4px;background:linear-gradient(180deg,var(--text),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}',
    '.sp-dpx{text-align:right}.sp-dpx b{display:block;font-size:clamp(26px,4.4cqw,38px);line-height:1}.sp-dpx span{font-weight:700;font-size:16px}',
    '.sp-radar{grid-column:1/-1;margin-top:8px;display:grid;grid-template-columns:auto 1fr auto;gap:6px 14px;align-items:center;padding:10px 16px;border:1px solid var(--border);border-radius:18px;background:var(--card)}',
    '.sp-radar .sc2{font-size:28px;line-height:1;font-weight:800}.sp-radar .sc2 small{font-size:13px;font-weight:500;color:var(--text3)}',
    '.sp-rsb{position:relative;height:8px;border-radius:5px;background:linear-gradient(90deg,var(--red),var(--border2) 50%,var(--green))}',
    '.sp-rsb i{position:absolute;top:-6px;width:4px;height:20px;border-radius:2px;margin-left:-2px;background:var(--text);box-shadow:0 0 0 4px color-mix(in srgb,var(--text) 18%,transparent)}',
    '.sp-rl{grid-column:2;display:flex;justify-content:space-between;font-size:11px;color:var(--text3)}',
    '.sp-rv{font-size:12px;font-weight:800;padding:3px 12px;border-radius:99px;background:var(--border);color:var(--text2)}',
    '.sp-rv.g{background:color-mix(in srgb,var(--green) 16%,transparent);color:var(--green)}.sp-rv.r{background:color-mix(in srgb,var(--red) 16%,transparent);color:var(--red)}.sp-rv.n{background:color-mix(in srgb,var(--yellow) 16%,transparent);color:var(--yellow)}',
    '.sp-mods{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:10px}',
    '.sp-mod{display:flex;gap:10px;align-items:center;text-align:left;font:inherit;color:inherit;background:none;border:1px solid var(--border);border-radius:12px;padding:7px 10px;cursor:pointer;min-width:0}',
    '.sp-mod:hover{background:var(--card)}',
    '.sp-mod i{flex:none;width:10px;height:10px;border-radius:50%;background:var(--c)}',
    '.sp-mod b{display:block;font-size:13px}.sp-mod span{font-size:11px;color:var(--text3)}',
    '.sp-hz{position:relative;display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:30px;padding-top:20px}',
    '.sp-hz:before{content:"";position:absolute;left:0;right:0;top:6px;height:2px;background:linear-gradient(90deg,var(--green),var(--yellow),var(--green));border-radius:2px;opacity:.6}',
    '.sp-hz>div{position:relative}',
    '.sp-hz>div:before{content:"";position:absolute;left:0;top:-22px;width:14px;height:14px;border-radius:50%;background:var(--c);box-shadow:0 0 0 5px color-mix(in srgb,var(--c) 25%,transparent)}',
    '.sp-hz em{font-style:normal;font-size:12px;color:var(--text3)}',
    '.sp-hz strong{display:block;font-size:clamp(17px,2.6cqw,22px);line-height:1.1;font-weight:800;color:var(--c);margin:2px 0 4px}',
    '.sp-hz small{font-size:12px;color:var(--text3);line-height:1.4}',
    '.sp-sec{display:grid;grid-template-columns:170px minmax(0,1fr);gap:14px 36px;padding:30px 0;border-top:1px solid var(--border);scroll-margin-top:calc(var(--smm-top,0px) + 56px)}',
    '.sp-sec h4{margin:0;font-size:16px;font-weight:800;line-height:1.3}',
    '.sp-tag{display:inline-block;margin-top:10px;font-size:11px;font-weight:800;padding:2px 10px;border-radius:99px;background:var(--border);color:var(--text2)}',
    '.sp-tag.g{background:color-mix(in srgb,var(--green) 16%,transparent);color:var(--green)}.sp-tag.r{background:color-mix(in srgb,var(--red) 16%,transparent);color:var(--red)}.sp-tag.n{background:color-mix(in srgb,var(--yellow) 16%,transparent);color:var(--yellow)}',
    '.sp-lk{display:block;margin-top:14px;font:inherit;background:none;border:0;padding:0;font-size:12px;font-weight:700;color:var(--accent);text-decoration:underline;text-underline-offset:3px;cursor:pointer;text-align:left}',
    '.sp-lead{margin:0 0 18px;font-size:14.5px;line-height:1.6;color:var(--text);max-width:62ch}',
    '.sp-cap{margin:10px 0 0;line-height:1.5;font-size:12px;color:var(--text3)}',
    '.sp-h5{margin:14px 0 6px;font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text3)}.sp-h5:first-child{margin-top:0}',
    '.sp-lanes{position:relative;margin:44px 0 0 96px}',
    '.sp-ln{position:relative;height:56px}',
    '.sp-lb{position:absolute;left:-96px;width:88px;top:0;height:30px;display:flex;align-items:center;font-weight:700;font-size:12.5px;line-height:1.1}',
    '.sp-tr{position:absolute;left:0;right:0;top:0;height:30px;border-bottom:1px dashed var(--border)}',
    '.sp-sg{position:absolute;top:11px;height:8px;border-radius:4px;left:var(--l);width:var(--w);background:var(--c);transform-origin:left;animation:sp-grow 1s var(--d,.3s) cubic-bezier(.2,.8,.2,1) both}',
    '.sp-dt{position:absolute;top:8px;left:var(--l);width:14px;height:14px;margin-left:-7px;border-radius:50%;background:var(--c);border:3px solid var(--bg);animation:sp-pop .5s var(--d,.3s) both}',
    '.sp-vs{position:absolute;left:0;top:34px;font-size:12px;color:var(--text3);white-space:nowrap}.sp-vs b{color:var(--text);font-weight:700}',
    '.sp-now{position:absolute;top:-30px;bottom:12px;border-left:2px dashed var(--text);z-index:2}',
    '.sp-now b{position:absolute;top:-4px;left:50%;transform:translateX(-50%);background:var(--text);color:var(--bg);padding:1px 10px;border-radius:8px;font-size:12px;white-space:nowrap}',
    '.sp-ax{position:relative;height:18px;margin:0 0 0 96px;font-size:11px;color:var(--text3)}.sp-ax span{position:absolute;transform:translateX(-50%)}',
    '@keyframes sp-grow{from{transform:scaleX(0)}}@keyframes sp-pop{from{transform:scale(0)}}',
    '.sp-big{font-size:clamp(34px,6cqw,50px);line-height:1;font-weight:800;letter-spacing:-.03em}',
    '.sp-kv,.sp-flow{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0 6px}',
    '.sp-kv>div,.sp-flow>div{flex:1 1 140px;min-width:0;padding:12px 16px;border:1px solid var(--border);border-radius:14px;background:var(--card)}',
    '.sp-kv span,.sp-flow span{display:block;font-size:12px;color:var(--text3);margin-bottom:6px}.sp-kv b,.sp-flow b{display:block;font-size:18px;line-height:1.2;font-weight:800}',
    '.sp-track{position:relative;height:10px;border-radius:6px;background:var(--border);max-width:460px;margin-top:14px;overflow:hidden}',
    '.sp-fill{height:100%;border-radius:6px;background:linear-gradient(90deg,var(--accent),var(--green));transform-origin:left;animation:sp-grow 1.1s .3s both}',
    '.sp-pick{display:grid;grid-template-columns:1.4fr repeat(4,1fr);gap:8px;align-items:center;padding:9px 0;border-top:1px solid var(--border);font-size:13px}',
    '.sp-pick{cursor:pointer}.sp-pick:hover{background:var(--card)}.sp-pick span{display:block;font-size:11px;color:var(--text3)}.sp-pick b{font-size:14px;font-weight:800}.sp-pick i{font-style:normal;font-weight:700}',
    '.sp-met{display:grid;grid-template-columns:repeat(auto-fit,minmax(108px,1fr));gap:10px;margin-top:4px}',
    '.sp-met>div{min-width:0;padding:14px 14px;border:1px solid var(--border);border-radius:14px;background:var(--card)}',
    '.sp-met span{display:block;font-size:12px;line-height:1.3;color:var(--text3);margin-bottom:8px}.sp-met b{display:block;font-size:clamp(20px,3cqw,28px);line-height:1.1;font-weight:800}',
    '.sp-bk{display:grid;grid-template-columns:1fr 1fr;gap:20px 40px;margin-top:22px}',
    '.sp-bk h4{margin:0 0 14px;font-size:12px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text3)}',
    '.sp-b{display:grid;grid-template-columns:42px minmax(0,1fr) 88px;gap:14px;align-items:center;margin-bottom:12px;font-size:13px}',
    '.sp-b>div{height:10px;background:var(--border);border-radius:5px;overflow:hidden}.sp-b>div i{display:block;height:100%;border-radius:5px;transform-origin:left;animation:sp-grow 1s .5s both}.sp-b b{text-align:right;font-weight:700}',
    '.sp-tl{position:relative;padding-left:30px;margin-top:4px}',
    '.sp-tl:before{content:"";position:absolute;left:5px;top:6px;bottom:6px;width:2px;background:var(--border)}',
    '.sp-tl>div{position:relative;display:flex;justify-content:space-between;align-items:flex-start;gap:20px;padding:10px 0;line-height:1.4}',
    '.sp-tl>div:before{content:"";position:absolute;left:-30px;top:15px;width:12px;height:12px;border-radius:50%;background:var(--accent);border:3px solid var(--bg)}',
    '.sp-tl small{display:inline-block;margin-top:4px;font-weight:500;color:var(--text3)}.sp-tl>div>span{color:var(--text3);font-size:12px;white-space:nowrap;padding-top:3px}',
    '.sp-nl{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px}.sp-nl li{display:flex;flex-direction:column;gap:3px}',
    '.sp-nl a{font-size:13.5px;line-height:1.35;color:var(--text);font-weight:700;text-decoration:none}.sp-nl a:hover{color:var(--accent);text-decoration:underline}.sp-nl small{font-size:11px;color:var(--text3)}',
    '@container (max-width:900px){.sp-hero{grid-template-columns:1fr}.sp-cols{grid-template-columns:1fr}.sp-mods{grid-template-columns:repeat(2,1fr)}}',
    '@container (max-width:760px){.sp-sec{grid-template-columns:1fr;gap:16px;padding:24px 0}.sp-bk{grid-template-columns:1fr}.sp-pick{grid-template-columns:1fr 1fr}.sp-pick>div:first-child{grid-column:1/-1}}',
    '@container (max-width:700px){.sp-map{min-width:0;width:calc(var(--z,1) * 100%)}.sp-bub{font-size:13px;gap:6px;padding:4px 12px 4px 4px}.sp-lgw{width:24px;height:24px}.sp-map.zc .sp-bub{flex-direction:column;gap:2px;padding:3px;border-radius:12px;font-size:9px;line-height:1}.sp-map.zc .sp-bub:hover{transform:translate(calc(-50% + var(--dx,0px)),var(--dy,0px)) scale(var(--s,1))}.sp-map.zc .sp-lgw{width:24px;height:24px}.sp-zrow{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:8px}.sp-zoom{flex:none;display:flex;align-items:center;gap:2px;background:var(--card);border:1px solid var(--border2);border-radius:99px;padding:2px}.sp-zoom button{width:30px;height:30px;border-radius:50%;border:0;background:transparent;color:var(--text);font:inherit;font-size:18px;font-weight:700;cursor:pointer}.sp-zoom button:active{background:var(--border2)}.sp-zoom span{min-width:42px;text-align:center;font-size:11px;color:var(--text3)}.sp-hint{margin:0 2px;font-size:11px;line-height:1.35;color:var(--text3)}}',
    '@container (max-width:520px){.sp-row{grid-template-columns:22px 1fr auto;padding:12px 4px}.sp-row .tk small{display:block;margin:4px 0 0}.sp-dhero{grid-template-columns:1fr}.sp-dpx{text-align:left;display:flex;align-items:baseline;gap:12px}.sp-radar{grid-template-columns:1fr auto}.sp-rsb,.sp-rl{grid-column:1/-1}.sp-hz{grid-template-columns:1fr;gap:20px;padding-left:24px;margin-top:26px}.sp-hz:before{left:6px;right:auto;top:6px;bottom:6px;width:2px;height:auto;background:linear-gradient(var(--green),var(--yellow),var(--green))}.sp-hz>div:before{left:-24px;top:3px}.sp-lanes{margin-left:0}.sp-lb{position:static;height:auto;display:block;margin-bottom:2px;width:auto;font-size:12px}.sp-ln{height:84px}.sp-tr{top:22px}.sp-vs{top:58px}.sp-ax{margin-left:0}.sp-now{top:-24px}}',
    '@media (prefers-reduced-motion:reduce){.sp *{animation:none!important;transition:none!important}}',
    '.sx-hint{display:flex;align-items:center;gap:10px;padding:16px;border-radius:14px;border:1px dashed var(--border2);color:var(--text2);font-size:13px}.sx-hint p{margin:0}',
    '.sx-conslist{display:grid;grid-template-columns:repeat(auto-fill,minmax(310px,1fr));gap:10px}',
    '.sx-cons{background:var(--card);border:1px solid var(--border);border-left:3px solid var(--border2);border-radius:14px;padding:12px 14px;min-width:0;display:flex;flex-direction:column;gap:9px}',
    '.sx-cons.g{border-left-color:var(--green)}.sx-cons.r{border-left-color:var(--red)}.sx-cons.n{border-left-color:var(--yellow)}',
    '.sx-cons-h{display:flex;align-items:center;gap:10px;min-width:0}.sx-cons-h .sx-pill{margin-left:auto}',
    '.sx-pill{font-size:10px;font-weight:800;letter-spacing:.04em;padding:4px 9px;border-radius:99px;white-space:nowrap;background:var(--bg3,rgba(128,128,128,.15));color:var(--text2)}',
    '.sx-pill.g{background:rgba(34,197,94,.16);color:var(--green)}.sx-pill.r{background:rgba(239,68,68,.16);color:var(--red)}.sx-pill.n{background:rgba(234,179,8,.16);color:var(--yellow)}',
    '.sx-cons-up{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.sx-cons-up b{font-size:22px;line-height:1}.sx-cons-up small{font-size:11px;color:var(--text3)}',
    '.sx-stack{display:flex;height:7px;border-radius:99px;overflow:hidden;background:var(--border)}',
    '.sx-stack i{display:block;height:100%}.sx-stack .b{background:var(--green)}.sx-stack .n{background:var(--text3);opacity:.5}.sx-stack .s{background:var(--red)}',
    '.sx-cons-n{display:flex;gap:10px;font-size:11px;font-weight:700}',
    '.sx-rng{position:relative;height:6px;border-radius:99px;background:var(--border);margin-top:2px}',
    '.sx-rng i{position:absolute;top:50%;transform:translate(-50%,-50%);display:block}',
    '.sx-rng .p{width:10px;height:10px;border-radius:50%;background:var(--accent);border:2px solid var(--card)}',
    '.sx-rng .t{width:4px;height:14px;border-radius:2px;background:var(--green)}',
    '.sx-rng-l{display:flex;justify-content:space-between;gap:8px;font-size:10px;color:var(--text3)}',
    '.sx-why{margin:0;font-size:12px;line-height:1.4;color:var(--text2)}',
    '.sx-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto}',
    '.sx-cap{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text3)}',
    /* StockPro: tanpa bilah tab Screener */
    '.sx-only .sx-top{display:none}',
    /* top bar + tabs */
    '.sx-top{display:flex;align-items:center;gap:12px;padding:8px 10px;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-card);min-width:0}',
    '.sx-brand{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.12em;color:var(--accent);padding-right:12px;border-right:1px solid var(--border2);flex-shrink:0}',
    '.sx-tabs-wrap{position:relative;flex:1;min-width:0;display:flex;align-items:center}',
    '.sx-tabs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;scroll-snap-type:x proximity;flex:1;min-width:0;padding:2px}',
    '.sx-tabs::-webkit-scrollbar{display:none}',
    '.sx-tab{display:flex;align-items:center;gap:9px;flex-shrink:0;scroll-snap-align:start;font:inherit;padding:8px 14px;border-radius:12px;border:1px solid transparent;background:transparent;color:var(--text2);cursor:pointer;transition:all .15s;text-align:left}',
    '.sx-tab .sx-ic{width:20px;height:20px}',
    '.sx-tab .t{display:flex;flex-direction:column;line-height:1.2}.sx-tab b{font-size:13px;font-weight:800}.sx-tab small{font-size:10.5px;color:var(--text3);white-space:nowrap}',
    '.sx-tab:hover{color:var(--accent);background:var(--bg2)}',
    '.sx-tab.on{background:color-mix(in srgb,var(--accent) 12%,var(--card));border-color:color-mix(in srgb,var(--accent) 45%,transparent);color:var(--accent)}',
    '.sx-arr{position:absolute;top:50%;transform:translateY(-50%);z-index:2;width:30px;height:30px;border-radius:50%;border:1px solid var(--border);background:var(--card);color:var(--text2);display:none;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--shadow-card)}',
    '.sx-arr.l{left:-4px}.sx-arr.r{right:-4px}',
    '.sx-tabs-wrap.can-l .sx-arr.l,.sx-tabs-wrap.can-r .sx-arr.r{display:inline-flex}',
    '.sx-tabs-wrap.can-l::before,.sx-tabs-wrap.can-r::after{content:"";position:absolute;top:0;bottom:0;width:36px;pointer-events:none;z-index:1}',
    '.sx-tabs-wrap.can-l::before{left:0;background:linear-gradient(90deg,var(--card),transparent)}.sx-tabs-wrap.can-r::after{right:0;background:linear-gradient(-90deg,var(--card),transparent)}',
    '.sx-real{font-style:normal;color:var(--green);font-size:9px;margin-left:3px;vertical-align:2px}',
    '.sx-view{display:flex;flex-direction:column;gap:14px;min-width:0}',
    /* head + guide */
    '.sx-vhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
    '.sx-vtitle{display:flex;align-items:center;gap:12px;min-width:0}',
    '.sx-vico{width:42px;height:42px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);flex-shrink:0}',
    '.sx-vico .sx-ic{width:22px;height:22px}',
    '.sx-vtitle h3{font-size:18px;font-weight:800;color:var(--text);line-height:1.2}.sx-vtitle p{font-size:12px;color:var(--text2);margin-top:2px;line-height:1.45}',
    '.sx-vright{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.sx-gbtns{display:inline-flex;gap:4px;padding:3px;border-radius:12px;background:var(--bg2)}',
    '.sx-gbtn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;font-weight:800;padding:7px 12px;border:0;border-radius:9px;background:transparent;color:var(--text2);cursor:pointer}',
    '.sx-gbtn:hover{color:var(--accent)}.sx-gbtn.on{background:var(--card);color:var(--accent);box-shadow:0 2px 8px rgba(0,0,0,.08)}',
    '.sx-guide{border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border));background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 8%,var(--card)),var(--card) 70%);border-radius:14px;padding:12px 14px;animation:sxIn .2s}',
    '.sx-guide.why{border-color:color-mix(in srgb,var(--green) 40%,var(--border));background:linear-gradient(135deg,color-mix(in srgb,var(--green) 8%,var(--card)),var(--card) 70%)}',
    '@keyframes sxIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}',
    '.sx-guide-h{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text);margin-bottom:8px}.sx-guide-h .sx-x{margin-left:auto}',
    '.sx-guide-l{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px}',
    '.sx-guide-l li{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.5;color:var(--text2);background:var(--card);border:1px solid var(--border2);border-radius:10px;padding:8px 10px}',
    '.sx-guide-l .n{width:20px;height:20px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:800;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}',
    '[data-theme="dark"] .sx-guide-l .n{color:#1a0f3c}',
    '.sx-guide.why .n{background:var(--green)}.sx-guide-l .n .sx-ic{width:12px;height:12px}',
    '.sx-guide-l .gi{color:var(--accent);flex-shrink:0}.sx-guide.why .gi{color:var(--green)}',
    '.sx-x{width:28px;height:28px;border-radius:8px;border:1px solid var(--border2);background:var(--card);color:var(--text3);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}.sx-x:hover{color:var(--red)}',
    /* controls */
    '.sx-bar{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;min-width:0}',
    '.sx-seg{display:inline-flex;gap:3px;padding:3px;border-radius:11px;background:var(--bg2);max-width:100%}',
    '.sx-seg button{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;font-weight:700;padding:6px 12px;border:0;border-radius:8px;background:transparent;color:var(--text2);cursor:pointer;white-space:nowrap;flex-shrink:0;min-height:30px}',
    '.sx-seg button small{font-weight:600;color:var(--text3);font-size:10.5px}',
    '.sx-seg button:hover{color:var(--accent)}.sx-seg button.on{background:var(--card);color:var(--accent);box-shadow:0 1px 6px rgba(0,0,0,.08)}',
    '.sx-seg.big button{font-size:13px;padding:8px 14px}',
    '.sx-seg.side button.on:first-child{color:var(--green)}.sx-seg.side button.on:last-child{color:var(--red)}',
    '.sx-seg.full{display:flex;width:100%}.sx-seg.full button{flex:1;justify-content:center}',
    '.sx-hs{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch;min-width:0}.sx-hs::-webkit-scrollbar{display:none}',
    '.sx-search{display:inline-flex;align-items:center;gap:6px;padding:0 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg2);color:var(--text3);min-width:0}',
    '.sx-search:focus-within{outline:2px solid var(--accent);outline-offset:1px}',
    '.sx-search input{font:inherit;font-size:13px;font-weight:700;border:0;background:transparent;color:var(--text);padding:8px 0;width:170px;min-width:0;outline:0}',
    '.sx-sel,.sx-in{font:inherit;font-size:12px;font-weight:700;padding:7px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);min-height:34px;max-width:100%}',
    '.sx-sel.full,.sx-in{width:100%}',
    '.sx-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12px;font-weight:800;padding:7px 12px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;min-height:34px}',
    '.sx-btn:hover,.sx-btn.on{color:var(--accent);border-color:var(--accent)}.sx-btn.full{width:100%}',
    '.sx-link{display:inline-flex;align-items:center;gap:3px;font:inherit;font-size:12px;font-weight:800;border:0;background:none;color:var(--accent);cursor:pointer;padding:2px}',
    '.sx-ib{width:34px;height:34px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}',
    '.sx-ib:disabled{opacity:.3;cursor:default}.sx-ib:not(:disabled):hover{color:var(--accent);border-color:var(--accent)}',
    '.sx-lab{display:inline-flex;align-items:center;gap:6px}',
    '.sx-box{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card);padding:14px;min-width:0}',
    '.sx-bh{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px}',
    '.sx-bh h4,.sx-sub{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:800;letter-spacing:.03em;text-transform:uppercase;color:var(--text)}',
    '.sx-sub{margin:14px 0 8px;font-size:12px}.sx-sub small{text-transform:none;letter-spacing:0;font-weight:600}',
    '.sx-note{font-size:11.5px;color:var(--text3);line-height:1.55;margin:0}',
    '.sx-center{text-align:center;font-size:13px;color:var(--text);line-height:1.6;margin:4px 0 10px}',
    '.sx-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:30px 16px;color:var(--text3);font-size:13px;text-align:center}.sx-empty .sx-ic{width:26px;height:26px}',
    '.sx-more{display:flex;align-items:center;gap:6px;margin:10px auto 0;font:inherit;font-size:12px;font-weight:800;padding:8px 18px;border-radius:999px;border:1px solid var(--border);background:var(--card);color:var(--accent);cursor:pointer}',
    '.sx-more small{color:var(--text3);font-weight:600}',
    '.sx-load{display:flex;flex-direction:column;align-items:center;gap:10px;padding:46px 16px;color:var(--text2);font-size:13px;text-align:center}',
    '.sx-spin{width:30px;height:30px;border-radius:50%;border:3px solid var(--bg3);border-top-color:var(--accent);animation:sxSpin .8s linear infinite}',
    '@keyframes sxSpin{to{transform:rotate(360deg)}}',
    '.sx-pbar{width:min(320px,80%);height:6px;border-radius:3px;background:var(--bg3);overflow:hidden}.sx-pbar i{display:block;height:100%;background:var(--accent);transition:width .2s}',
    /* labels / chips */
    '.sx-ev{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.02em;padding:3px 7px;border-radius:6px;border:1px solid;white-space:nowrap}',
    '.sx-ev.g{color:var(--green);border-color:color-mix(in srgb,var(--green) 45%,transparent);background:var(--green-bg)}',
    '.sx-ev.r{color:var(--red);border-color:color-mix(in srgb,var(--red) 45%,transparent);background:var(--red-bg)}',
    '.sx-ev.b{color:#3b82f6;border-color:rgba(59,130,246,.45);background:rgba(59,130,246,.1)}[data-theme="dark"] .sx-ev.b{color:#93c5fd}',
    '.sx-ev.y{color:var(--yellow);border-color:color-mix(in srgb,var(--yellow) 45%,transparent);background:var(--yellow-bg)}',
    '.sx-ev.p{color:#8b5cf6;border-color:rgba(139,92,246,.45);background:rgba(139,92,246,.1)}[data-theme="dark"] .sx-ev.p{color:#c4a3ff}',
    '.sx-evs{display:flex;gap:4px;flex-wrap:wrap}',
    '.sx-lbl{font-size:10px;font-weight:800;letter-spacing:.04em;padding:3px 8px;border-radius:6px;white-space:nowrap;border:1px solid var(--border2);color:var(--text2);background:var(--bg2)}',
    '.sx-lbl.g,.sx-lbl.gg{color:var(--green);background:var(--green-bg);border-color:color-mix(in srgb,var(--green) 40%,transparent)}.sx-lbl.gg{box-shadow:0 0 0 2px color-mix(in srgb,var(--green) 25%,transparent)}',
    '.sx-lbl.r{color:var(--red);background:var(--red-bg);border-color:color-mix(in srgb,var(--red) 40%,transparent)}',
    '.sx-tag{font-size:10.5px;font-weight:800;letter-spacing:.08em;flex-shrink:0;min-width:64px}.sx-tag.g{color:var(--green)}.sx-tag.r{color:var(--red)}',
    '.sx-pchip{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;font:inherit;font-size:12px;font-weight:700;padding:6px 10px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;white-space:nowrap}',
    '.sx-pchip em{font-style:normal;font-family:"IBM Plex Mono",monospace;font-size:11px;padding:1px 6px;border-radius:6px;background:var(--bg2);color:var(--text2)}',
    '.sx-pchip:hover{border-color:var(--accent);color:var(--accent)}',
    '.sx-pchip.on{background:color-mix(in srgb,var(--accent) 12%,var(--card));border-color:var(--accent);color:var(--accent)}.sx-pchip.on em{background:var(--accent);color:#fff}',
    '.sx-pchip.risk{color:var(--red)}.sx-pchip.risk.on{background:var(--red-bg);border-color:var(--red)}.sx-pchip.risk.on em{background:var(--red)}',
    '.sx-presets{display:flex;flex-direction:column;gap:8px;padding:12px 14px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius)}',
    '.sx-prow{display:flex;align-items:center;gap:10px;min-width:0}',
    '.sx-pdesc{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--text2);margin:0;line-height:1.5}.sx-pdesc .sx-ic{color:var(--accent)}.sx-pdesc b{color:var(--text)}',
    '.sx-filters{display:flex;flex-wrap:wrap;gap:8px 18px}',
    '.sx-frow{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%}.sx-frow .sx-cap{min-width:62px}',
    '.sx-seg.sm button{padding:5px 10px;font-size:11.5px}',
    '.sx-days .sx-seg button{font-family:"IBM Plex Mono",monospace}',
    '.sx-res{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--text2)}.sx-res>b{display:inline-flex;gap:6px;align-items:center;color:var(--accent);letter-spacing:.06em}',
    '.sx-found{display:flex;align-items:center;gap:8px;font-size:14px;color:var(--text);padding:2px 2px 8px}.sx-found .sx-ic{color:var(--accent)}',
    /* tables */
    '.sx-tw{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:var(--radius);background:var(--card);min-width:0}',
    '.sx-tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:12.5px}',
    '.sx-tbl th{position:sticky;top:0;z-index:1;background:var(--bg2);font-size:10.5px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text3);text-align:right;padding:10px 12px;white-space:nowrap;border-bottom:1px solid var(--border2);user-select:none}',
    '.sx-tbl th .smm-tip{display:inline-flex;margin-left:4px;width:15px;height:15px;font-size:9px;vertical-align:1px}',
    '.sx-tbl th.s{cursor:pointer}.sx-tbl th.s:hover,.sx-tbl th.on{color:var(--accent)}.sx-tbl th i{font-style:normal;opacity:.7}',
    '.sx-tbl td{padding:10px 12px;text-align:right;vertical-align:middle;border-bottom:1px solid var(--border2);font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.sx-tbl tbody tr:last-child td{border-bottom:0}',
    '.sx-tbl th.l,.sx-tbl td.l{text-align:left}',
    '.sx-tbl td small{display:block;font-size:10.5px;margin-top:2px}',
    '.sx-tbl tbody tr[data-sx]{cursor:pointer}.sx-tbl tbody tr[data-sx]:hover td{background:color-mix(in srgb,var(--accent) 6%,var(--card))}',
    '.sx-stick .sx-tbl th:first-child,.sx-stick .sx-tbl td:first-child,.sx-gems th:first-child,.sx-gems td:first-child{position:sticky;left:0;z-index:2;background:var(--card);box-shadow:1px 0 0 var(--border2)}',
    '.sx-stick .sx-tbl th:first-child,.sx-gems th:first-child{background:var(--bg2);z-index:3}',
    '.sx-stk{display:flex;flex-direction:column;align-items:flex-start;gap:1px;font:inherit;border:0;background:none;padding:0;cursor:pointer;text-align:left;max-width:190px}',
    '.sx-stk b{font-family:"IBM Plex Mono",monospace;font-size:13px;font-weight:800;color:var(--accent)}.sx-stk:hover b{text-decoration:underline}',
    '.sx-stk small{font-family:Inter,system-ui,sans-serif;font-size:11px;color:var(--text3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;display:block;margin:0}',
    '.sx-liq{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:9.5px;font-weight:800;letter-spacing:.04em;margin-top:3px;color:var(--text3)}',
    '.sx-liq.high{color:var(--green)}.sx-liq.mid{color:var(--yellow)}.sx-liq.low,.sx-liq.vlow{color:var(--red)}',
    '.sx-score{display:inline-flex;align-items:center;justify-content:center;min-width:42px;padding:4px 6px;border-radius:8px;border:1.5px solid var(--border);font-size:13px;font-weight:800;color:var(--text);background:var(--bg2)}',
    '.sx-score.bronze{border-color:#d08a4a}.sx-score.silver{border-color:#b6c2d1}.sx-score.gold{border-color:#f5b301;color:#b77d00}.sx-score.diamond{border-color:#38bdf8;color:#0284c7}',
    '[data-theme="dark"] .sx-score.gold{color:#fcd34d}[data-theme="dark"] .sx-score.diamond{color:#7dd3fc}',
    '.sx-tier{font-size:9.5px!important;font-weight:800;letter-spacing:.06em;color:var(--text3)}.sx-tier.gold{color:#d49b00}.sx-tier.diamond{color:#0ea5e9}.sx-tier.bronze{color:#c07a3a}',
    '.sx-tri{display:inline-flex;gap:3px}.sx-tri i{width:16px;height:12px;border-radius:3px;display:block}',
    '.sx-mb{display:block;width:56px;height:4px;border-radius:2px;background:var(--bg3);margin:4px 0 0 auto;overflow:hidden}.sx-mb i{display:block;height:100%;background:#3b82f6;border-radius:2px}',
    '.sx-mb.b i{background:#22c55e}.sx-mb.y i{background:var(--yellow)}',
    '.sx-l-b{color:#16a34a}.sx-l-y{color:var(--yellow)}.sx-l-n{color:var(--text2)}[data-theme="dark"] .sx-l-b{color:#4ade80}',
    '.sx-reg{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:800}.sx-reg.acc{color:var(--green)}.sx-reg.dist{color:var(--red)}.sx-reg.neu{color:var(--text3)}',
    '.sx-gems td:last-child{white-space:normal;min-width:200px}',
    /* mobile cards */
    '.sx-mob{display:none}',
    '.sx-cards{flex-direction:column;gap:8px}',
    '.sx-mc{display:flex;flex-direction:column;gap:7px;padding:12px;border:1px solid var(--border);border-radius:14px;background:var(--card);box-shadow:var(--shadow-card);cursor:pointer}',
    '.sx-mc:active{transform:scale(.995)}',
    '.sx-mc .r1{display:flex;align-items:center;gap:8px;min-width:0}.sx-mc .c{font-family:"IBM Plex Mono",monospace;font-size:15px;font-weight:800;color:var(--accent)}',
    '.sx-mc .r1 .sx-score{margin-left:auto}.sx-mc .r1 .grow{flex:1;min-width:0;color:var(--text3);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.sx-mc .r2{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.sx-mc .r2 small{color:var(--text3);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sx-mc .r2 em{font-style:normal}',
    '.sx-mc .r3{display:flex;justify-content:space-between;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--text2)}.sx-mc .r3 b{font-family:"IBM Plex Mono",monospace;color:var(--text)}',
    '.sx-split{display:grid;grid-template-columns:1fr 1fr;gap:8px}.sx-split div{display:flex;flex-direction:column;gap:2px;padding:8px;border-radius:10px;background:var(--bg2);font-size:11px}',
    '.sx-split b{font-family:"IBM Plex Mono",monospace;font-size:14px}.sx-split em{font-style:normal;font-family:"IBM Plex Mono",monospace;color:var(--text2)}',
    /* today */
    '.sx-daynav{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap}',
    '.sx-dn-row{display:flex;align-items:center;gap:8px;margin:4px 0}.sx-dn-row h2{font-size:24px;font-weight:800;color:var(--text);letter-spacing:-.01em}',
    '.sx-kpis{display:grid;grid-template-columns:repeat(4,minmax(110px,1fr));gap:8px}',
    '.sx-kpis div{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:8px 12px}',
    '.sx-kpis small{display:flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.04em}.sx-kpis small .sx-ic{width:13px;height:13px}',
    '.sx-kpis b{display:block;font-family:"IBM Plex Mono",monospace;font-size:18px;margin-top:2px;color:var(--text)}',
    '.sx-align{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px}',
    '.sx-arow{display:grid;grid-template-columns:56px minmax(0,1fr);grid-template-rows:auto auto;gap:2px 8px;align-items:center;font:inherit;text-align:left;padding:8px 10px;border:1px solid var(--border2);border-radius:10px;background:var(--bg2);cursor:pointer}',
    '.sx-arow b{font-family:"IBM Plex Mono",monospace;color:var(--accent);grid-row:1/3}.sx-arow small{color:var(--text2);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sx-arow span{display:flex;gap:4px;flex-wrap:wrap}',
    '.sx-arow:hover{border-color:var(--accent)}',
    '.sx-verdict{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.55;color:var(--text2);padding:10px 12px;border-radius:12px;background:var(--bg2);margin:8px 0 12px}.sx-verdict .sx-ic{color:var(--yellow);margin-top:2px}.sx-verdict b{color:var(--text)}',
    '.sx-pgrid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}',
    '.sx-pgrid3.two{grid-template-columns:repeat(2,minmax(0,1fr))}',
    ':where(.sx,.sp) button{color:inherit}',
    '.sx-pcard .prow{color:var(--text)}.sx-pcard .prow .pr b{color:var(--text);font-weight:700}.sx-pcard .ps b{color:var(--text2);font-weight:700}',
    '.sx-pcard{display:flex;flex-direction:column;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card);overflow:hidden;min-width:0}',
    '.sx-pcard header{display:flex;align-items:center;gap:8px;padding:12px 14px 4px}.sx-pcard header b{font-size:14px;font-weight:800;color:var(--text);flex:1;min-width:0}',
    '.sx-pcard .pi{width:30px;height:30px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--accent) 14%,transparent);color:var(--accent);flex-shrink:0}',
    '.sx-pcard.risk .pi{background:var(--red-bg);color:var(--red)}',
    '.sx-pcard .ps{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:11px;color:var(--text3);padding:0 14px}',
    '.sx-pcard .pd{font-size:11.5px;color:var(--text2);line-height:1.5;padding:6px 14px 8px;margin:0}',
    '.sx-pcard .pl{border-top:1px solid var(--border2);flex:1}',
    '.sx-pcard .pl.none{display:flex;align-items:center;justify-content:center;gap:6px;color:var(--text3);font-size:12px;padding:20px 12px}',
    '.sx-pcard .prow{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;font:inherit;text-align:left;padding:8px 14px;border:0;border-bottom:1px solid var(--border2);background:none;cursor:pointer}',
    '.sx-pcard .prow:hover{background:var(--bg2)}',
    '.sx-pcard .prow .c{font-family:"IBM Plex Mono",monospace;font-weight:800;color:var(--accent);font-size:13px}',
    '.sx-pcard .prow .nm{display:flex;flex-direction:column;min-width:0}.sx-pcard .prow .nm small{font-size:11px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sx-pcard .prow .nm em{font-style:normal;font-size:10.5px;font-weight:700}',
    '.sx-pcard .prow .pr{display:flex;flex-direction:column;align-items:flex-end;font-size:12px}.sx-pcard .prow .pr small{font-size:10.5px}',
    '.sx-pcard .pf{display:flex;align-items:center;justify-content:center;gap:4px;font:inherit;font-size:12px;font-weight:800;padding:10px;border:0;background:none;color:var(--accent);cursor:pointer}',
    '.sx-pcard .pf:hover{background:var(--bg2)}',
    '.sx-acctbl td.l{display:flex;align-items:center;gap:6px;font-family:inherit;font-weight:700}',
    /* accumulation */
    '.sx-acc-grid{display:grid;grid-template-columns:minmax(0,1fr) 270px;gap:14px;align-items:start}',
    '.sx-acc-main{display:flex;flex-direction:column;gap:10px;min-width:0}',
    '.sx-side{position:sticky;top:calc(var(--smm-top,0px) + 76px);background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card);max-height:calc(100vh - var(--smm-top,0px) - 96px);overflow:auto}',
    '.sx-side summary{display:none;align-items:center;gap:8px;padding:12px 14px;font-size:13px;font-weight:800;color:var(--text);cursor:pointer;list-style:none}.sx-side summary::-webkit-details-marker{display:none}',
    '.sx-side summary em{font-style:normal;font-size:11px;padding:2px 8px;border-radius:999px;background:var(--accent);color:#fff}',
    '.sx-side-in{display:flex;flex-direction:column;gap:12px;padding:14px}',
    '.sx-sg{min-width:0}.sx-in{min-width:0;box-sizing:border-box}',
    '.sx-sg h6{display:flex;align-items:center;gap:4px;font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);margin:0 0 6px}',
    '.sx-qp{display:grid;grid-template-columns:1fr 1fr;gap:6px}',
    '.sx-qp button{font:inherit;font-size:12px;font-weight:700;padding:7px 6px;border-radius:9px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);cursor:pointer}',
    '.sx-qp button:hover{border-color:var(--accent);color:var(--accent)}.sx-qp button.on{background:color-mix(in srgb,var(--accent) 14%,var(--card));border-color:var(--accent);color:var(--accent)}',
    '.sx-sortl{display:inline-flex;align-items:center;gap:6px}',
    '.sx-acc-list{display:flex;flex-direction:column;gap:12px}',
    '.sx-acc{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card);overflow:hidden}',
    '.sx-acc header{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--border2)}',
    '.sx-acc .sx-tw{border:0;border-radius:0;box-shadow:none}',
    '.sx-acode{display:inline-flex;align-items:center;gap:5px;font-family:"IBM Plex Mono",monospace;font-size:16px;font-weight:800;color:var(--accent);border:0;background:none;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:3px}',
    '.sx-akv{display:inline-flex;align-items:baseline;gap:5px;font-size:11px;color:var(--text3)}.sx-akv b{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--text)}.sx-akv.sx-dn b,.sx-akv.sx-up b{color:inherit}.sx-akv em{font-style:normal}',
    '.sx-prof{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12px;font-weight:800;padding:7px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--green) 50%,transparent);background:var(--green-bg);color:var(--green);cursor:pointer}',
    '.sx-prof:hover{border-color:var(--green)}',
    '.sx-ud{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:700;padding:5px 9px;border-radius:8px;border:1px solid rgba(59,130,246,.45);color:#3b82f6;background:rgba(59,130,246,.08)}[data-theme="dark"] .sx-ud{color:#93c5fd}',
    '.sx-trap{font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:800;padding:5px 9px;border-radius:8px;border:1px solid var(--border2);color:var(--text2);background:var(--bg2)}',
    '.sx-trap.hot{color:var(--red);border-color:color-mix(in srgb,var(--red) 45%,transparent);background:var(--red-bg)}.sx-trap.ok{color:var(--green);border-color:color-mix(in srgb,var(--green) 45%,transparent);background:var(--green-bg)}',
    '.sx-acct td.l .bk{font-size:13px}',
    '.sx-trd{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:800;letter-spacing:.03em;padding:4px 9px;border-radius:7px;border:1px solid}',
    '.sx-trd.g{color:var(--green);border-color:color-mix(in srgb,var(--green) 45%,transparent);background:var(--green-bg)}',
    '.sx-trd.r{color:var(--red);border-color:color-mix(in srgb,var(--red) 45%,transparent);background:var(--red-bg)}',
    '.sx-trd.y{color:var(--yellow);border-color:color-mix(in srgb,var(--yellow) 45%,transparent);background:var(--yellow-bg)}',
    '.sx-flow td.hc{position:relative;font-size:11px;min-width:64px}',
    '.sx-flow td.hc[data-k="g"]{background:color-mix(in srgb,var(--green) calc(var(--a) * 55%),transparent);color:var(--text)}',
    '.sx-flow td.hc[data-k="r"]{background:color-mix(in srgb,var(--red) calc(var(--a) * 55%),transparent);color:var(--text)}',
    '.sx-flow td.hc[data-k="n"]{color:var(--text3)}',
    /* smart money */
    '.sx-smhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
    '.sx-smt h4{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:800;color:var(--text)}.sx-smt h4 .sx-ic{color:var(--accent)}.sx-smt p{font-size:12px;margin-top:3px}',
    '.sx-smc{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.sx-range{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:10px;border:1px solid color-mix(in srgb,var(--green) 55%,transparent);background:var(--green-bg);color:var(--green)}',
    '.sx-range input{font:inherit;font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:700;border:0;background:transparent;color:var(--text);padding:4px 0;min-width:0;color-scheme:light dark}',
    '.sx-ab{display:block;width:110px;height:6px;border-radius:3px;background:var(--bg3);overflow:hidden}.sx-ab i{display:block;height:100%;border-radius:3px;background:linear-gradient(90deg,var(--green),#14b8a6)}',
    '.sx-mc .sx-ab{width:100%}',
    '.sx-smt2 td small{font-size:11.5px;font-weight:700}',
    /* broker & holder */
    '.sx-dr{display:inline-flex;align-items:center;gap:6px;font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--text2);padding:6px 10px;border-radius:10px;background:var(--bg2)}',
    '.sx-cols2{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}',
    '.sx-cols2.tight{gap:14px;margin-top:10px}',
    '.sx-col{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card);overflow:hidden;padding-bottom:6px}',
    '.sx-col header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;border-bottom:1px solid var(--border2);background:var(--bg2)}',
    '.sx-col header b{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:800;letter-spacing:.08em}.sx-col header small{font-size:11px;color:var(--text3)}',
    '.sx-brow{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:6px 12px;align-items:center;width:100%;font:inherit;text-align:left;padding:10px 14px;border:0;border-bottom:1px solid var(--border2);background:none;cursor:pointer}',
    '.sx-brow:hover{background:color-mix(in srgb,var(--accent) 6%,var(--card))}',
    '.sx-brow .a{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;min-width:0}',
    '.sx-brow .c{font-family:"IBM Plex Mono",monospace;font-size:15px;font-weight:800;color:var(--accent)}',
    '.sx-brow .nm{font-size:11.5px;color:var(--text2);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
    '.sx-brow .meta{flex-basis:100%;font-size:11px;color:var(--text3);display:flex;align-items:center;gap:4px;flex-wrap:wrap}.sx-brow .meta .sx-ic{width:12px;height:12px}',
    '.sx-brow .v{display:flex;flex-direction:column;align-items:flex-end;font-size:13px}.sx-brow .v small{font-size:10.5px;color:var(--text3)}.sx-brow .v em{font-style:normal}',
    '.sx-brow .p{font-size:11.5px;min-width:52px;text-align:right}',
    '.sx-flip{font-size:9.5px;font-weight:800;letter-spacing:.04em;padding:2px 6px;border-radius:5px}.sx-flip.g{color:var(--green);background:var(--green-bg)}.sx-flip.r{color:var(--red);background:var(--red-bg)}',
    '.sx-role{font-size:10px;font-weight:700;padding:1px 6px;border-radius:5px;border:1px solid #c4b5fd;color:#7c3aed}[data-theme="dark"] .sx-role{color:#c4a3ff;border-color:#6d28d9}',
    /* foreign */
    '.sx-fpre{flex:1}',
    '.sx-fs{display:inline-flex;align-items:center;justify-content:center;min-width:38px;padding:4px 6px;border-radius:8px;font-weight:800;background:var(--bg2);color:var(--text);border:1px solid var(--border2)}',
    '.sx-fs.warm{background:color-mix(in srgb,var(--green) 12%,var(--card));color:var(--green);border-color:color-mix(in srgb,var(--green) 40%,transparent)}',
    '.sx-fs.hot{background:color-mix(in srgb,var(--green) 22%,var(--card));color:var(--green);border-color:var(--green)}',
    '.sx-ib2{display:inline-block;width:64px;height:7px;border-radius:4px;background:var(--bg3);overflow:hidden;vertical-align:middle;margin-right:8px}.sx-ib2.w{flex:1;width:auto}',
    '.sx-ib2 i{display:block;height:100%;border-radius:4px}.sx-ib2 i.g{background:linear-gradient(90deg,#34d399,var(--green))}.sx-ib2 i.r{background:linear-gradient(90deg,#fb7185,var(--red))}',
    '.sx-mc .r2 .sx-ib2{margin:0}',
    '.sx-ks .sx-ic{width:11px;height:11px;margin-right:2px;vertical-align:-1px}',
    '.sx-ks{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:800;padding:3px 8px;border-radius:7px}',
    '.sx-ks.ok{color:var(--green);background:var(--green-bg)}.sx-ks.no{color:var(--yellow);background:var(--yellow-bg)}.sx-ks.n{color:var(--text3);background:var(--bg2)}',
    '.sp-bub.sp-hid{opacity:0;animation:none!important;pointer-events:none}',
    '.sp-bub.sp-done{animation:none}',
    '.sp-bub.sp-in{animation:sp-drop .55s 0s cubic-bezier(.2,.9,.3,1.3) both}',
    '.sp-web{transition:opacity .45s ease}.sp-web.out{opacity:0}',
    '@keyframes spFade{from{opacity:0}to{opacity:1}}',
    /* loading kunjungan berikutnya: spinner di atas peta */
    '.sp-ld{position:absolute;inset:0;justify-content:center;padding:0;background:color-mix(in srgb,var(--card) 70%,transparent);z-index:5}',
    /* loading: animasi benang (referensi peta sinyal) */
    '.sp-webhost{position:relative;height:300px;margin-top:12px;border-radius:20px;border:1px solid var(--border);background:var(--card);overflow:hidden}',
    '.sp-web{position:absolute;inset:0;pointer-events:none;overflow:hidden}',
    '.sp-web-svg{position:absolute;inset:0;width:100%;height:100%;font-family:Inter,system-ui,sans-serif}',
    '.sp-web .th{fill:none;stroke:#a99bff;stroke-width:1.4;stroke-linecap:round;opacity:.2}',
    '.sp-web .pl{fill:none;stroke:#fff;stroke-width:2.6;stroke-linecap:round;opacity:0}',
    '.sp-web .nd{fill:#cbbcff;opacity:0;transition:opacity .8s ease}',
    '.sp-web .hub{fill:#e4dbff}',
    '.sp-web .tx{font-size:11px;font-weight:600;fill:#9d90e0;opacity:0;transition:opacity .9s ease;letter-spacing:.02em}',
    '.sp-web .tx tspan.spc{fill:#6f68b8}.sp-web .tx tspan.on{fill:#fff}',
    '.sp-stat{position:absolute;left:0;right:0;bottom:14px;text-align:center;color:var(--text2);font-size:12.5px;font-weight:700;pointer-events:none}',
    '@media (prefers-reduced-motion:reduce){.sp-web .nd,.sp-web .tx{transition:none}.sp-web .pl{display:none}.sp-bub.sp-in{animation:none}.sp-web{transition:none}}',
    /* radar top 20 (tabel peringkat harian) */
    '.sx-rdk{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}',
    '.sx-rdk>div{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:4px;min-width:0;box-shadow:var(--shadow-card)}',
    '.sx-rdk b,.sx-rdk button.b{font-family:"IBM Plex Mono",monospace;font-size:22px;font-weight:800;line-height:1.15;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sx-rdk button.b{background:none;border:0;padding:0;text-align:left;cursor:pointer;color:var(--accent)}.sx-rdk button.b:hover{text-decoration:underline}',
    '.sx-rdk small{font-size:11px;color:var(--text3);font-weight:700}',
    '.sx-rd{--hc:var(--green);--cw:24px;--cg:3px;background:var(--card);border:1px solid var(--border);border-radius:14px;overflow:hidden;box-shadow:var(--shadow-card)}',
    '.sx-rd.dist{--hc:var(--red)}',
    '.sx-rd-head,.sx-rd-main{display:grid;grid-template-columns:32px minmax(110px,1fr) calc(var(--rd) * var(--cw) + (var(--rd) - 1) * var(--cg)) 64px 96px 70px 80px 20px;gap:12px;align-items:center;padding:10px 14px}',
    '.sx-rd-head{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text3);background:var(--bg2);border-bottom:1px solid var(--border)}',
    '.sx-rd-head .no{text-align:center}.sx-rd-head .r{text-align:right}',
    '.sx-rd-head button.s{background:none;border:0;padding:0;font:inherit;letter-spacing:inherit;text-transform:inherit;color:inherit;cursor:pointer;text-align:left}.sx-rd-head button.s.r{text-align:right}',
    '.sx-rd-head button.s.on{color:var(--accent)}.sx-rd-head button.s i{font-style:normal;opacity:.7}',
    '.sx-rd-row{border-bottom:1px solid var(--border2)}.sx-rd-row:last-child{border-bottom:0}',
    '.sx-rd-main{width:100%;border:0;background:none;color:var(--text);font:inherit;text-align:left;cursor:pointer;transition:background .15s}',
    '.sx-rd-main:hover,.sx-rd-row.open>.sx-rd-main{background:var(--bg2)}',
    '.sx-rd-main .no{color:var(--text3);font-size:12px;text-align:center}',
    '.sx-rd-main .stk{display:flex;flex-direction:column;min-width:0}.sx-rd-main .stk b{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--accent)}',
    '.sx-rd-main .stk small{font-size:10.5px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.sx-rd-heat{display:flex;gap:var(--cg)}',
    '.sx-rd-heat i{width:var(--cw);flex:none;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-style:normal;font-size:10.5px;font-weight:800;font-family:"IBM Plex Mono",monospace;background:var(--bg3);color:var(--text3)}',
    '.sx-rd-heat i.k1,.sx-rd-bd.k1{background:color-mix(in srgb,var(--hc) 88%,var(--card));color:#fff}',
    '.sx-rd-heat i.k2,.sx-rd-bd.k2{background:color-mix(in srgb,var(--hc) 55%,var(--card));color:#fff}',
    '.sx-rd-heat i.k3,.sx-rd-bd.k3{background:color-mix(in srgb,var(--hc) 22%,var(--card));color:var(--text)}',
    '.sx-rd-main .dy{text-align:left}',
    '.sx-rd-d{display:inline-block;font-family:"IBM Plex Mono",monospace;font-size:11px;font-weight:800;padding:3px 9px;border-radius:999px;color:var(--hc);background:color-mix(in srgb,var(--hc) 14%,var(--card));border:1px solid color-mix(in srgb,var(--hc) 35%,transparent)}',
    '.sx-rd-main .num{text-align:right;font-family:"IBM Plex Mono",monospace;font-size:12.5px;font-weight:700;font-variant-numeric:tabular-nums}',
    '.sx-rd-main .chev{width:8px;height:8px;border-right:2px solid var(--text3);border-bottom:2px solid var(--text3);transform:translateY(-2px) rotate(45deg);transition:transform .18s;justify-self:center}',
    '.sx-rd-row.open .chev{transform:translateY(2px) rotate(-135deg)}',
    '.sx-rd-det{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:12px;padding:4px 14px 14px;background:var(--bg2)}',
    '.sx-rd-box{border:1px solid var(--border);border-radius:12px;padding:12px;background:var(--card);min-width:0}',
    '.sx-rd-box h5{margin:0 0 8px;font-size:12px;font-weight:800;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.sx-rd-box h5>.sx-ic{color:var(--accent)}',
    '.sx-rd-lg{margin-left:auto;font-size:10.5px;font-weight:600;color:var(--text3);display:inline-flex;gap:10px}.sx-rd-lg i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px}',
    '.sx-rd-go{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font:inherit;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);cursor:pointer}.sx-rd-go:hover{border-color:var(--accent);color:var(--accent)}.sx-rd-go .sx-ic{width:12px;height:12px}',
    '.sx-rd-svg{display:block;width:100%;height:auto;font-family:"IBM Plex Mono",monospace}.sx-rd-svg text{font-size:10px;fill:var(--text3)}.sx-rd-svg .gl{stroke:var(--border2);stroke-dasharray:3 4}',
    '.sx-rd-tb{width:100%;border-collapse:collapse;font-size:12px}',
    '.sx-rd-tb th{font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);padding:4px;text-align:right}',
    '.sx-rd-tb td{padding:6px 4px;border-top:1px dashed var(--border2);text-align:right;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}',
    '.sx-rd-tb th:first-child,.sx-rd-tb td:first-child{text-align:left}.sx-rd-tb td:first-child small{color:var(--text3)}',
    '.sx-rd-bd{display:inline-block;min-width:28px;padding:1px 7px;border-radius:6px;font-weight:800;font-size:11px;text-align:center}',
    /* calendar */
    /* ── Tablet ── */
    '@media (max-width:1099px){',
      '.sx-rd{--cw:20px;--cg:2px}.sx-rd-head,.sx-rd-main{gap:8px;padding:10px 12px;grid-template-columns:24px minmax(84px,1fr) calc(var(--rd) * var(--cw) + (var(--rd) - 1) * var(--cg)) 54px 80px 58px 68px 16px}',
      '.sx-rd-det{grid-template-columns:1fr}',
      '.sx-acc-grid{grid-template-columns:1fr}',
      '.sx-side{position:static;max-height:none;order:-1}',
      '.sx-side summary{display:flex}',
      '.sx-side-in{padding-top:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '.sx-side-in .sx-sg:first-child,.sx-side-in>.sx-btn{grid-column:1/-1}',
      '.sx-qp{grid-template-columns:repeat(3,1fr)}',
      '.sx-pgrid3{grid-template-columns:repeat(2,minmax(0,1fr))}',
      '.sx-kpis{grid-template-columns:repeat(2,minmax(110px,1fr))}',
      '.sx-tab small{display:none}.sx-tab{padding:8px 12px}',
    '}',
    /* ── HP ── */
    '@media (max-width:640px){',
      '.sx{gap:10px}.sx-view{gap:10px}',
      '.sx-top{padding:6px;border-radius:14px;gap:6px}',
      '.sx-brand{display:none}',
      '.sx-tab{flex-direction:column;gap:3px;padding:7px 10px;min-width:66px}.sx-tab b{font-size:11px}.sx-tab .t{align-items:center}',
      '.sx-arr{display:none!important}',
      '.sx-vico{width:36px;height:36px}.sx-vtitle h3{font-size:16px}.sx-vtitle p{font-size:11.5px}',
      '.sx-vright{width:100%}.sx-gbtns{flex:1}.sx-gbtn{flex:1;justify-content:center}',
      '.sx-days{width:100%}.sx-days .sx-seg{display:flex}.sx-days .sx-seg button{flex:1;justify-content:center}',
      '.sx-guide-l{grid-template-columns:1fr}',
      '.sx-desk{display:none}.sx-mob{display:flex}',
      '.sx-search{flex:1 1 100%}.sx-search input{width:100%}',
      '.sx-bar>.sx-seg.big{display:flex;width:100%}.sx-bar>.sx-seg.big button{flex:1;justify-content:center;padding:8px 6px;font-size:12px}',
      '.sx-seg.big button small{display:none}',
      '.sx-res{width:100%}',
      '#sxGSector{flex:1 1 100%}',
      '.sx-frow{width:100%}.sx-frow .sx-cap{min-width:58px}',
      '.sx-prow{flex-direction:column;align-items:flex-start;gap:6px}.sx-prow .sx-hs{width:100%}',
      '.sx-dn-row h2{font-size:18px}',
      '.sx-kpis{width:100%}',
      '.sx-pgrid3,.sx-pgrid3.two{grid-template-columns:1fr}',
      '.sx-side-in{grid-template-columns:1fr 1fr}',
      '.sx-qp{grid-template-columns:1fr 1fr}',
      '.sx-acc header{gap:6px 10px;padding:10px 12px}.sx-acc header .sx-grow{flex-basis:100%;height:0}',
      '.sx-acode{font-size:15px}',
      '.sx-tbl{font-size:12px}.sx-tbl th,.sx-tbl td{padding:8px 8px}',
      '.sx-acct .hn,.sx-acct .hl{display:none}',
      '.sx-sortl{flex:1}.sx-sortl .sx-sel{flex:1}',
      '.sx-smc{width:100%}.sx-range{flex:1 1 100%;justify-content:space-between}.sx-range input{flex:1;font-size:12px}',
      '.sx-cols2{grid-template-columns:1fr}',
      '.sx-brow{grid-template-columns:minmax(0,1fr) auto;padding:10px 12px}.sx-brow .p{grid-column:2;grid-row:2;font-size:11px}',
      '.sx-fpre{flex-basis:100%}',
      '.sx-lab{flex:1 1 auto}.sx-lab .sx-sel{flex:1}',
      '.sx-rdk{grid-template-columns:repeat(2,minmax(0,1fr))}.sx-rdk b,.sx-rdk button.b{font-size:19px}',
      '.sx-rd-main{grid-template-columns:22px repeat(3,minmax(0,1fr)) 16px;grid-template-areas:"no stk stk dy chev" "heat heat heat heat heat" ". net avg ret ret";row-gap:8px;column-gap:8px;padding:10px 12px}',
      '.sx-rd-head{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px}.sx-rd-head .ns{display:none}.sx-rd-head button.s,.sx-rd-head button.s.r{text-align:center;padding:5px 10px;border:1px solid var(--border);border-radius:999px;background:var(--card);text-transform:none;letter-spacing:0;font-size:11px}.sx-rd-head button.s.on{border-color:var(--accent)}',
      '.sx-rd-main .no{grid-area:no}.sx-rd-main .stk{grid-area:stk}.sx-rd-main .sx-rd-heat{grid-area:heat}.sx-rd-main .dy{grid-area:dy;text-align:right}.sx-rd-main .chev{grid-area:chev}',
      '.sx-rd-main .num:nth-child(5){grid-area:net}.sx-rd-main .num:nth-child(6){grid-area:avg}.sx-rd-main .num:nth-child(7){grid-area:ret}',
      '.sx-rd-heat{display:grid;grid-template-columns:repeat(var(--rd),minmax(0,1fr));gap:3px}.sx-rd-heat i{width:auto;height:26px}',
      '.sx-rd-main .num{text-align:left;display:flex;flex-direction:column;gap:1px;font-size:12.5px;min-width:0}.sx-rd-main .num::before{content:attr(data-l);font-family:inherit;font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text3)}',
      '.sx-rd-det{padding:4px 10px 12px}.sx-rd-svg text{font-size:15px}',
    '}',
    '@media (max-width:380px){',
      '.sx-side-in{grid-template-columns:1fr}',
      '.sx-kpis b{font-size:15px}',
    '}'
  ].join('\n');

  // ─────────────────────────── Mount (dipanggil smartmoney.js) ───────────────────────────
  var _bound = false;
  function show(container, api) {
    A = api; host = container;
    if (!document.getElementById('sxStyle')) { var st = document.createElement('style'); st.id = 'sxStyle'; st.textContent = CSS; document.head.appendChild(st); }
    if (!_bound) {
      var sv = load('sx_view'); if (sv && VIEW[sv]) V.view = sv;
      host.innerHTML = shell();
      host.addEventListener('error', function (e) { var t = e.target; if (t && t.classList && t.classList.contains('sp-lg')) t.style.display = 'none'; }, true);
      host.addEventListener('touchstart', function (e) { if (e.touches.length === 2 && e.target.closest && e.target.closest('.sp-sc')) _pinch = { d: pinchDist(e.touches), z: V.stk.zoom || 1 }; }, { passive: true });
      host.addEventListener('touchmove', function (e) { if (_pinch && e.touches.length === 2) { e.preventDefault(); spSetZoom(_pinch.z * pinchDist(e.touches) / _pinch.d); } }, { passive: false });
      host.addEventListener('touchend', function (e) { if (e.touches.length < 2) _pinch = null; });
      host.addEventListener('click', onClick);
      host.addEventListener('change', onChange);
      host.addEventListener('input', onInput);
      host.querySelector('#sxTabs').addEventListener('scroll', arrows, { passive: true });
      var rt, wasMob = mq('(max-width:1099px)');
      window.addEventListener('resize', function () {
        clearTimeout(rt);
        rt = setTimeout(function () {
          arrows();
          var mob = mq('(max-width:1099px)');
          if (mob !== wasMob) { wasMob = mob; if (V.view === 'accum' && U && !host.hidden) renderView(); }
        }, 200);
      });
      _bound = true;
    }
    var pend = window.__smmScrPending; window.__smmScrPending = null;
    if (pend) { V.view = pend.view || (V.view === 'stk' ? 'today' : V.view); store('sx_view', V.view); }
    host.classList.toggle('sx-only', V.view === 'stk');   // StockPro: tab Screener disembunyikan
    renderView();
  }
  // Kalender pindah ke Broker Activity; Screener tidak perlu mengikuti saham aktif.
  function codeChanged() { return false; }
  window.SmartMoneyScreener = { show: show, codeChanged: codeChanged };
})();
