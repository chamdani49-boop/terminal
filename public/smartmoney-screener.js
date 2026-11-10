/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — Smart Money › SCREENER (KHUSUS ADMIN)
 *
 * Sub-tab ke-4 menu Smart Money. Dimuat dinamis oleh smartmoney.js
 * (lihat ensureScreener) saat sub-tab "Screener" pertama kali dibuka.
 *
 * 7 tampilan:
 *   1. Today        — sinyal terbaru + akurasi setup preset (backtest 3 bln)
 *   2. Gems         — skor gabungan harian + preset bullish / risiko
 *   3. Accumulation — posisi broker 6 bulan (floor, PnL, trapped) + flow 10 hari
 *   4. Smart Money  — smart money nampung ritel & P&L smart money
 *   5. Broker&Holder— associate broker, pemegang >5%, insider lintas saham
 *   6. Foreign      — intensitas arus asing + radar top 20
 *   7. Kalender     — heatmap net harian per bulan (per saham / broker)
 *
 * SUMBER DATA
 *   - Harga & teknikal (RSI, Stoch, 20d high) = ASLI dari /ohlc.json.
 *   - Nama, sektor, kapitalisasi = DATA (data.json) yang sudah dimuat situs.
 *   - Arus broker / asing / ritel / insider / holder = DUMMY deterministik
 *     (seed = kode saham), KECUALI saham yang punya file asli di R2
 *     (/api/admin/smartmoney) → dihitung dari data asli dan diberi tanda.
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

  var FIRST = ['Budi', 'Andreas', 'Linda', 'Hendra', 'Sari', 'Rudy', 'Wulan', 'Agus', 'Fransiska', 'Tommy', 'Lukas', 'Maria', 'Daniel', 'Grace', 'Irwan', 'Natalia', 'Steven'];
  var LAST = ['Santoso', 'Wijaya', 'Halim', 'Gunawan', 'Kusuma', 'Tanujaya', 'Hartono', 'Prasetyo', 'Setiadi', 'Susanto', 'Wibowo', 'Sutanto'];
  var CORP = ['Graha', 'Nusantara', 'Cahaya', 'Mitra', 'Prima', 'Sentosa', 'Abadi', 'Bumi', 'Samudra', 'Lestari'];
  var SUFX = ['Investama', 'Capital', 'Holdings', 'Sejahtera', 'Global'];
  var FUNDS = ['Nusa Growth Fund', 'Archipelago Value Fund', 'Equator Capital Ltd', 'Sunda Strait Partners', 'Garuda Asia Fund', 'Merapi Opportunity Fund'];
  var ROLES = ['Direktur Utama', 'Direktur', 'Komisaris', 'Komisaris Utama'];

  function newArrs(m) {
    var n = m.n;
    ['val', 'smB', 'smS', 'smBL', 'smSL', 'rtB', 'rtS', 'rtBL', 'rtSL', 'fB', 'fS', 'fBL', 'fSL', 'blk', 'kF'].forEach(function (k) { m[k] = new Float64Array(n); });
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
  function kseiFrom(m, k0) {
    var k = k0;
    for (var t = 0; t < m.n; t++) {
      if (m.shares > 0) k += (m.fBL[t] - m.fSL[t]) * 100 / m.shares * 100 * 0.85;
      k = clamp(k, 0, 100); m.kF[t] = k;
    }
  }

  function simulate(m, mEnds) {
    var r = A.rng(A.hashStr(m.code) ^ 0x7f4a7c15);
    function G() { return A.gauss(r); }
    newArrs(m);
    var n = m.n, c = m.c;
    var mcap = m.mcap || Math.exp(Math.log(1.5e11) + r() * Math.log(400));
    if (!m.shares) m.shares = mcap / (c[n - 1] || 1);
    var V0 = clamp(mcap * Math.exp(Math.log(0.0008) + 0.8 * G()), 3e7, 6e11);
    var BL = A.brokerList();
    var ret = BL.filter(function (b) { return RETAIL[b.code]; }), oth = BL.filter(function (b) { return !RETAIL[b.code]; });
    var picks = A.shuffle(ret, r).slice(0, 4).concat(A.shuffle(oth, r).slice(0, 8));
    var GS = 0, GSr = 0, KS = 0;
    picks.forEach(function (p) {
      var R = !!RETAIL[p.code], t = A.brokerType(p);
      var b = newBroker(p.code, A.titleCase(p.name), t, R ? 'R' : 'S', t === 'F' && !R, n);
      b.gs = Math.exp(G() * 0.6) * (R ? 2.2 : 1); b.k = 0.4 + r() * 1.2; b.bias = 0;
      m.brokers.push(b);
    });
    var dom = [];
    m.brokers.forEach(function (b, i) { if (b.grp === 'S' && b.type !== 'F') dom.push(i); });
    m.asc = dom.length && r() < 0.85 ? dom[Math.floor(r() * dom.length)] : -1;
    if (m.asc >= 0) m.brokers[m.asc].k *= 1.6;
    m.brokers.forEach(function (b) { GS += b.gs; if (b.grp === 'S') KS += b.gs * b.k; else GSr += b.gs; });
    var wall = m.brokers.filter(function (b) { return b.grp === 'S'; }).sort(function (a, b) { return b.k - a.k; })[0];
    m.wS = n - Math.min(WIN, n - m.first);
    m.nBk = 38 + Math.floor(r() * 50);
    var z = 0, mu = 0, left = 0, nets = new Float64Array(m.brokers.length);
    for (var t = 0; t < n; t++) {
      var p = c[t], rt = t > 0 && c[t - 1] > 0 ? c[t] / c[t - 1] - 1 : 0;
      if (left-- <= 0) { mu = G() * 0.7; left = 8 + Math.floor(r() * 35); }
      z = 0.7 * z + 0.12 * mu + 0.45 * G() - 1.5 * rt;
      var vt = m.tr[t] ? V0 * Math.exp(0.45 * G()) * (1 + 6 * Math.abs(rt)) : 0;
      if (!vt) continue;
      var intent = vt * 0.1 * Math.tanh(z), tot = 0;
      m.brokers.forEach(function (b, i) {
        var gb = vt * b.gs / GS;
        var nb = b.grp === 'S' ? intent * b.gs * b.k / KS : -intent * b.gs / GSr;
        b.bias = 0.9 * b.bias + 0.1 * G();
        nb += gb * (0.3 * G() + 0.12 * b.bias);
        nets[i] = nb; tot += nb;
      });
      for (var i = 0; i < m.brokers.length; i++) {
        var b = m.brokers[i], gb = vt * b.gs / GS, nb = nets[i] - tot * b.gs / GS;
        var bv = Math.max(gb * 0.04, gb * 0.5 + nb / 2), sv = Math.max(gb * 0.04, gb * 0.5 - nb / 2);
        var ba = clamp(p * (1 + 0.004 * G()), m.l[t], m.h[t]) || p, sa = clamp(p * (1 + 0.004 * G()), m.l[t], m.h[t]) || p;
        addFlow(m, b, t, bv, sv, bv / (ba * 100), sv / (sa * 100));
        if (i === m.asc) m.ascBv[t] = bv;
      }
      if (r() < 0.035) {
        var bsz = vt * (0.15 + r() * 0.6) * (Math.tanh(z) + 0.35 * G() >= 0 ? 1 : -1);
        m.blk[t] = bsz;
        if (t >= m.wS && wall) {
          if (bsz > 0) { wall.ng.bv += bsz; wall.ng.bl += bsz / (p * 100); }
          else { wall.ng.sv -= bsz; wall.ng.sl -= bsz / (p * 100); }
        }
      }
    }
    finishBrokers(m);
    kseiFrom(m, 5 + r() * 40);
    m.ff = 0.15 + r() * 0.45;

    // Pemegang > 5% (dummy): perubahan per akhir bulan, 3 bulan terakhir
    m.h5 = [];
    var nH = r() < 0.3 ? 1 + Math.floor(r() * 2) : 0;
    for (var h = 0; h < nH; h++) {
      var nm = r() < 0.6 ? 'PT ' + CORP[Math.floor(r() * CORP.length)] + ' ' + LAST[Math.floor(r() * LAST.length)] + ' ' + SUFX[Math.floor(r() * SUFX.length)]
        : FUNDS[Math.floor(r() * FUNDS.length)];
      var pct = 4.6 + r() * 30;
      mEnds.slice(-3).forEach(function (ti) {
        if (r() < 0.3) {
          var prev = pct; pct = Math.max(0.5, pct + G() * 0.7);
          if (Math.max(prev, pct) >= 5) m.h5.push({ name: nm, prev: prev, cur: pct, t: ti });
        }
      });
    }
    // Insider (dummy): 0-2 transaksi 40 hari terakhir
    m.ins = [];
    var nI = r() < 0.2 ? 1 + Math.floor(r() * 2) : 0;
    for (var q = 0; q < nI; q++) {
      var ti2 = n - 1 - Math.floor(r() * 40);
      var sh = Math.max(100, Math.round(m.shares * (0.00002 + Math.pow(r(), 3) * 0.002) / 100) * 100);
      m.ins.push({ name: (FIRST[Math.floor(r() * FIRST.length)] + ' ' + LAST[Math.floor(r() * LAST.length)]).toUpperCase(), role: ROLES[Math.floor(r() * ROLES.length)],
        act: r() < 0.6 ? 'BUY' : 'SELL', shares: sh, price: c[ti2], value: sh * c[ti2], t: ti2 });
    }
  }

  // Data asli R2 → struktur yang sama dengan simulate()
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
      kseiFrom(m, m.kF0 || 20);
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
    if (t < 21 || t - 20 < m.first || !m.val[t]) return false;
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
    { k: 'foreign', ico: 'globe', label: 'Foreign', sub: 'Intensitas & radar' },
    { k: 'cal', ico: 'cal', label: 'Kalender', sub: 'Flow harian per bulan' }
  ];
  var V = {
    view: 'today', asOf: 0, guide: {}, acc: null,
    gems: { preset: 'top', tier: 0, cap: 'all', liq: 'all', sector: '', q: '', sort: 'score', dir: -1, limit: 50 },
    accum: { mode: 'pos', trend: 'acc', top: 5, market: 'reg', minLose: 0, minLoss: 0, maxDays: 0, minNet: 0, preset: '', q: '', sort: 'net', dir: -1, limit: 10 },
    smart: { mode: 'retail', a: null, b: null, rng: '1W', q: '', sort: 'sm', dir: -1, pl: 'all', limit: 50 },
    bh: { mode: 'assoc', per: '1W', hper: '3M', flip: false, q: '', lim: { a: 10, d: 10 } },
    foreign: { mode: 'int', side: 'acc', preset: 'all', per: '30D', liq: 0, ksei: 'all', show: 50, q: '', sort: 'score', dir: -1 },
    cal: { code: null, grp: 'sm', metric: 'value', ym: null, sel: null }
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
          loadRealAll();
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
    simulate(m, U2.mEnds);
    m.kF0 = m.kF[0];
    derive(m);
    return m;
  }
  // Saham yang punya file asli di R2 → hitung ulang dari data asli
  var _realDone = 0;
  function loadRealAll() {
    var tries = 0;
    (function waitIdx() {
      var codes = A.index();
      if (!codes) { if (++tries < 40) setTimeout(waitIdx, 500); return; }
      codes = codes.filter(function (c) { return U.by[c]; }).slice(0, 150);
      var q = codes.slice(), busy = 0, dirty = false, timer = null;
      function flush() { timer = null; if (!dirty) return; dirty = false; U.bt = null; if (host && !host.hidden) renderView(); }
      function next() {
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
    el.innerHTML = '<div class="sx-load"><div class="sx-spin"></div><b>' + esc(txt) + '</b><div class="sx-pbar"><i style="width:' + Math.round(f * 100) + '%"></i></div>' +
      '<small>Sekali saja per sesi. Harga diambil dari ohlc.json.</small></div>';
  }

  // ─────────────────────────── Panduan (cara pakai & manfaat) ───────────────────────────
  var GUIDE = {
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
      how: [['sliders', 'Pilih Akumulasi / Distribusi, periode, lalu preset (Senyap, KSEI, Akselerasi, dll).'], ['target', 'Skor 0-100 = intensitas (40%), konsistensi (25%), akselerasi (20%), konfirmasi KSEI (15%).'], ['radar', 'Radar Top 20 memetakan saham: kanan = intensitas tinggi, atas = konsisten.'], ['ext', 'Ketuk saham untuk detail.']],
      why: [['globe', 'Asing sering menjadi penggerak utama saham big cap.'], ['moon', 'Preset Senyap menemukan akumulasi asing di saham kecil-menengah sebelum harga bergerak.'], ['shield', 'Konfirmasi KSEI menyaring arus semu (misalnya crossing) karena kepemilikan asing benar-benar naik.']]
    },
    cal: {
      title: 'Kalender Flow', ico: 'cal', desc: 'Heatmap net beli/jual harian dalam satu bulan.',
      how: [['search', 'Ketik kode saham, lalu pilih kelompok: smart money, asing, ritel, atau satu broker.'], ['cal', 'Tiap kotak = 1 hari bursa. Hijau = net beli, merah = net jual, makin pekat makin besar.'], ['left', 'Pindah bulan dengan ‹ › atau ketuk batang bulan di ringkasan 6 bulan.'], ['info', 'Ketuk kotak tanggal untuk melihat pembeli & penjual terbesar hari itu.']],
      why: [['flow', 'Konsistensi akumulasi terlihat sekilas, tanpa membaca tabel.'], ['star', 'Mengenali kebiasaan bandar, misalnya rutin beli di awal bulan.'], ['bar', 'Membandingkan kekuatan arus antarbulan dengan cepat.']]
    }
  };
  function vhead(k, right) {
    var g = GUIDE[k], open = V.guide[k];
    return '<div class="sx-vhead">' +
      '<div class="sx-vtitle"><span class="sx-vico">' + ic(g.ico) + '</span><div><h3>' + esc(g.title) + '</h3><p>' + esc(g.desc) + '</p></div></div>' +
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
      if (!m.val[t]) return;
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
      '</tbody></table></div><p class="sx-note">Backtest ' + bt.H + ' hari bursa ke depan pada setiap hari sinyal selama ±3 bulan. Data arus broker untuk saham tanpa file asli masih dummy, jadi angka ini menguji logika preset, bukan janji hasil.</p>' : '';

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
        '<div class="sx-bh"><h4>' + ic('users') + 'Associate Broker &amp; Pemegang Saham</h4><button class="sx-link" data-sx="view" data-v="bh">Buka Broker &amp; Holder ' + ic('right') + '</button></div>' +
        '<p class="sx-center"><b>' + aligned.length + ' saham dengan sinyal searah minggu ini</b><br><small class="sx-mute">Associate broker, holder &gt;5%, dan insider, minimal 2 sinyal searah.</small></p>' +
        (aligned.length ? '<div class="sx-align">' + aligned.slice(0, 8).map(function (x) {
          return '<button class="sx-arow" data-sx="open" data-v="' + esc(x.m.code) + '"><b>' + esc(x.m.code) + '</b><small>' + esc(x.m.name) + '</small><span>' + chips(x.s) + '</span></button>';
        }).join('') + '</div>' : '') +
      '</section>' +
      '<section>' +
        '<div class="sx-bh"><h4>' + ic('star') + 'Setup Preset</h4><button class="sx-btn' + (V.acc ? ' on' : '') + '" data-sx="tacc">' + ic('bar') + 'Akurasi preset</button></div>' +
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
        '<div class="sx-smt"><h4>' + ic(st.mode === 'pl' ? 'bank' : 'funnel') + (st.mode === 'pl' ? 'Smart Money P&amp;L' : 'Smart Money Nampung Retail Scanner') + '</h4>' +
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
    ['all', 'Semua', ''], ['quiet', 'Senyap (Small/Mid)', 'moon'], ['ksei', 'Terkonfirmasi KSEI', 'check'],
    ['accel', 'Akselerasi', 'zap'], ['big', 'Big Money', 'bank'], ['div', 'Divergen', 'split']
  ];
  var FX_DESC = {
    all: 'Semua saham sesuai arah dan filter.', quiet: 'Kapitalisasi < Rp20 T dan harga relatif diam (±3%) walau asing aktif.',
    ksei: 'Kepemilikan asing di KSEI ikut berubah searah dengan arus transaksi.', accel: 'Rata-rata harian paruh terakhir periode ≥ 2× paruh sebelumnya.',
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
      var kd = m.kF[n - 1] - m.kF[Math.max(0, a - 1)];
      var ff = m.shares * (m.ff || 0.3);
      var netL = 0; for (var t3 = a; t3 < n; t3++) netL += m.fBL[t3] - m.fSL[t3];
      var streak = Math.abs(m.fst[n - 1]);
      rows.push({ m: m, net: net, int: net / val * 100, ffp: ff ? netL * 100 / ff * 100 : 0, cons: days ? pos / days * 100 : 0,
        streak: (dist ? m.fst[n - 1] < 0 : m.fst[n - 1] > 0) ? streak : 0, accel: accel, ksei: kd, kOk: Math.abs(kd) >= 0.01 && (kd > 0) === !dist,
        chg: (m.c[n - 1] / m.c[Math.max(0, a - 1)] - 1) * 100, liq: avgVal(m, n - 1, 20) });
    });
    // skor: persentil intensitas & akselerasi dalam universe periode ini
    function pct(key) { var s = rows.map(function (x) { return Math.abs(x[key]); }).sort(function (x, y) { return x - y; }); return function (v) { var lo = 0, hi = s.length; while (lo < hi) { var md = (lo + hi) >> 1; if (s[md] < v) lo = md + 1; else hi = md; } return s.length ? lo / s.length : 0; }; }
    var pI = pct('int'), pA = pct('accel');
    rows.forEach(function (x) { x.score = Math.round(100 * (0.4 * pI(Math.abs(x.int)) + 0.25 * x.cons / 100 + 0.2 * pA(Math.abs(x.accel)) + 0.15 * (x.kOk ? 1 : 0))); });
    var all = rows.slice();
    rows = rows.filter(function (x) {
      if (!matchQ(x.m, st.q)) return false;
      if (st.liq && x.liq < st.liq) return false;
      if (st.ksei === 'ok' && !x.kOk) return false;
      if (st.ksei === 'no' && x.kOk) return false;
      switch (st.preset) {
        case 'quiet': return (x.m.mcap || x.m.shares * x.m.c[n - 1]) < 2e13 && Math.abs(x.chg) < 3;
        case 'ksei': return x.kOk;
        case 'accel': return x.accel >= 2;
        case 'big': return Math.abs(x.net) >= 1e10;
        case 'div': return dist ? x.chg > 0 : x.chg < 0;
      }
      return true;
    });
    var key = { score: 'score', int: 'int', ffp: 'ffp', cons: 'cons', accel: 'accel', ksei: 'ksei', net: 'net', chg: 'chg' }[st.sort] || 'score';
    var sgn = dist && (key === 'int' || key === 'ffp' || key === 'net' || key === 'ksei') ? -1 : 1;
    rows.sort(function (x, y) { return (x[key] - y[key]) * st.dir * sgn; });
    return { rows: rows, all: all, a: a };
  }
  function viewForeign() {
    var st = V.foreign;
    return vhead('foreign') +
      '<div class="sx-bar">' + seg('fmode', [['int', ic('target') + 'Flow Intensity'], ['radar', ic('radar') + 'Radar <small>Top 20</small>']], st.mode, 'big') + '</div>' +
      '<div class="sx-bar">' + seg('fside', [['acc', ic('up') + 'Akumulasi'], ['dist', ic('down') + 'Distribusi']], st.side, 'side') +
        '<div class="sx-hs sx-fpre">' + FX_PRE.map(function (p) { return '<button class="sx-pchip' + (st.preset === p[0] ? ' on' : '') + '" data-sx="fpre" data-v="' + p[0] + '" data-smm-tip="' + esc(FX_DESC[p[0]]) + '">' + (p[2] ? ic(p[2]) : '') + esc(p[1]) + '</button>'; }).join('') + '</div>' +
      '</div>' +
      '<div class="sx-bar">' + searchBox('sxFQ', st.q, 'Cari kode / nama…') +
        '<label class="sx-lab"><span class="sx-cap">Periode</span>' + seg('fper', [['1D', '1D'], ['7D', '7D'], ['30D', '30D'], ['60D', '60D']], st.per, 'sm') + '</label>' +
        '<label class="sx-lab"><span class="sx-cap">Likuid ≥</span><select class="sx-sel" id="sxFLiq">' + [[0, 'Semua'], [1e9, 'Rp1 M'], [5e9, 'Rp5 M'], [1e10, 'Rp10 M'], [5e10, 'Rp50 M']].map(function (x) { return '<option value="' + x[0] + '"' + (+x[0] === st.liq ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label>' +
        '<label class="sx-lab"><span class="sx-cap">KSEI</span><select class="sx-sel" id="sxFKsei">' + [['all', 'Semua'], ['ok', 'Terkonfirmasi'], ['no', 'Belum']].map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === st.ksei ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></label>' +
        (st.mode === 'int' ? '<label class="sx-lab"><span class="sx-cap">Tampil</span><select class="sx-sel" id="sxFShow">' + [20, 50, 100, 200].map(function (x) { return '<option' + (x === st.show ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select></label>' : '') +
      '</div>' +
      '<div id="sxBody"></div>';
  }
  function bodyForeign() {
    var st = V.foreign, R = fxRows(), rows = R.rows, n = U.n, dist = st.side === 'dist';
    var head = '<div class="sx-found">' + ic('globe') + '<b>' + nf(rows.length) + '</b> saham · ' + esc(dShort(U.axis[R.a])) + ' s/d ' + esc(dShort(U.axis[n - 1])) + '</div>';
    if (!rows.length) return head + empty('Tidak ada saham yang cocok.');
    if (st.mode === 'radar') return head + radar(rows.slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 20), dist);
    var show = rows.slice(0, st.show), mxI = 0;
    show.forEach(function (x) { mxI = Math.max(mxI, Math.abs(x.int)); });
    function th(k, label, tp, cls) { var on = st.sort === k; return '<th class="s' + (cls ? ' ' + cls : '') + (on ? ' on' : '') + '" data-sx="fsort" data-v="' + k + '">' + label + ' <i>' + (on ? (st.dir < 0 ? '↓' : '↑') : '↕') + '</i>' + (tp ? tip(tp) : '') + '</th>'; }
    function kseiCell(x) { return Math.abs(x.ksei) < 0.01 ? '<span class="sx-ks n">≈0,00</span>' : '<span class="sx-ks ' + (x.kOk ? 'ok' : 'no') + '">' + ic(x.kOk ? 'check' : 'x') + (x.ksei > 0 ? '+' : '') + nf(x.ksei, 2) + '</span>'; }
    var tbl = '<div class="sx-tw sx-desk sx-stick"><table class="sx-tbl sx-fx"><thead><tr><th class="l">Saham</th>' +
      th('score', 'Skor', 'Skor 0-100: intensitas 40%, konsistensi 25%, akselerasi 20%, konfirmasi KSEI 15%.') +
      th('int', 'Intensitas', 'Net asing dibanding total nilai transaksi saham itu pada periode ini.', 'l') +
      th('ffp', 'Float%', 'Net lot asing dibanding jumlah saham free float.') +
      th('cons', 'Konsisten', 'Persentase hari bursa dengan arah yang sama (net beli untuk akumulasi).') +
      th('accel', 'Akselerasi', 'Rata-rata harian paruh akhir periode dibanding paruh awal. ▲ 2,0 = dua kali lebih kencang.') +
      th('ksei', 'KSEI', 'Perubahan porsi kepemilikan asing di KSEI (poin persen). ✓ = searah dengan arus transaksi.') +
      th('net', 'Net') + th('chg', 'Harga%') + '</tr></thead><tbody>' +
      show.map(function (x) {
        return '<tr data-sx="open" data-v="' + esc(x.m.code) + '"><td class="l">' + stockCell(x.m) + '</td>' +
          '<td><span class="sx-fs' + (x.score >= 85 ? ' hot' : x.score >= 70 ? ' warm' : '') + '">' + x.score + '</span></td>' +
          '<td class="l"><span class="sx-ib2"><i class="' + (dist ? 'r' : 'g') + '" style="width:' + clamp(Math.abs(x.int) / (mxI || 1) * 100, 4, 100) + '%"></i></span><b class="' + sc(x.int) + '">' + fp(x.int) + '</b></td>' +
          '<td class="sx-pu">' + fp(x.ffp, 2) + '</td>' +
          '<td><b>' + nf(x.cons, 0) + '%</b>' + (x.streak >= 5 ? '<small class="sx-y">' + x.streak + ' hari beruntun</small>' : '') + '</td>' +
          '<td class="' + (x.accel >= 1 ? 'sx-up' : 'sx-dn') + '">' + (x.accel >= 1 ? '▲ ' : '▼ ') + (x.accel >= 99 ? 'baru' : nf(x.accel, 1)) + '</td>' +
          '<td>' + kseiCell(x) + '</td><td class="' + sc(x.net) + '"><b>' + (x.net > 0 ? '+' : '') + fv(x.net) + '</b></td><td class="' + sc(x.chg) + '">' + fp(x.chg) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    var cards = '<div class="sx-cards sx-mob">' + show.map(function (x) {
      return '<div class="sx-mc" data-sx="open" data-v="' + esc(x.m.code) + '"><div class="r1"><b class="c">' + esc(x.m.code) + '</b><small class="grow">' + esc(x.m.name) + '</small><span class="sx-fs' + (x.score >= 85 ? ' hot' : x.score >= 70 ? ' warm' : '') + '">' + x.score + '</span></div>' +
        '<div class="r2"><span class="sx-ib2 w"><i class="' + (dist ? 'r' : 'g') + '" style="width:' + clamp(Math.abs(x.int) / (mxI || 1) * 100, 4, 100) + '%"></i></span><b class="' + sc(x.int) + ' mono">' + fp(x.int) + '</b></div>' +
        '<div class="r3"><span>Net <b class="' + sc(x.net) + '">' + fv(x.net) + '</b></span><span>Konsisten <b>' + nf(x.cons, 0) + '%</b></span><span>Akselerasi <b class="' + (x.accel >= 1 ? 'sx-up' : 'sx-dn') + '">' + (x.accel >= 99 ? 'baru' : nf(x.accel, 1)) + '</b></span></div>' +
        '<div class="r3"><span>KSEI ' + kseiCell(x) + '</span><span>Float <b class="sx-pu">' + fp(x.ffp, 2) + '</b></span><span>Harga <b class="' + sc(x.chg) + '">' + fp(x.chg) + '</b></span></div></div>';
    }).join('') + '</div>';
    return head + tbl + cards;
  }
  function radar(top, dist) {
    var W = 640, H = 420, P = { l: 46, r: 22, t: 34, b: 42 };
    var mxX = 0, mxN = 0;
    top.forEach(function (x) { mxX = Math.max(mxX, Math.abs(x.int)); mxN = Math.max(mxN, Math.abs(x.net)); });
    mxX = mxX * 1.12 || 1;
    function X(v) { return P.l + Math.sqrt(Math.min(1, Math.abs(v) / mxX)) * (W - P.l - P.r); }
    function Y(v) { return H - P.b - v / 100 * (H - P.t - P.b); }
    var mx = X(mxX / 4), my = Y(50), col = dist ? 'var(--red)' : 'var(--green)';
    var grid = '';
    for (var i = 0; i <= 4; i++) { var yy = Y(i * 25), xx = P.l + i / 4 * (W - P.l - P.r); grid += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + yy + '" y2="' + yy + '" class="g"/><text x="' + (P.l - 6) + '" y="' + (yy + 4) + '" text-anchor="end">' + (i * 25) + '%</text>' + '<text x="' + xx + '" y="' + (H - P.b + 16) + '" text-anchor="middle">' + nf(i * i / 16 * mxX, 1) + '%</text>'; }
    var placed = [];
    var dots = top.slice().reverse().map(function (x) {
      var r = 5 + Math.sqrt(Math.abs(x.net) / (mxN || 1)) * 15, cx = X(x.int), cy = Y(x.cons), hot = x.accel >= 2;
      x._r = r; x._cx = cx; x._cy = cy;
      return x;
    }).map(function (x) { return x; });
    // label: urut skor tertinggi dulu, lewati kalau bertabrakan dengan label lain
    top.forEach(function (x) {
      var lx = x._cx, ly = x._cy - x._r - 4, wd = x.m.code.length * 6.6 + 4;
      x._lbl = !placed.some(function (p) { return Math.abs(p.x - lx) < (p.w + wd) / 2 && Math.abs(p.y - ly) < 12; });
      if (x._lbl) placed.push({ x: lx, y: ly, w: wd });
    });
    dots = dots.map(function (x) {
      var r = x._r, cx = x._cx, cy = x._cy, hot = x.accel >= 2;
      return '<g class="dot" data-sx="open" data-v="' + esc(x.m.code) + '" data-smm-tip="' + esc(x.m.code + ' · skor ' + x.score + ' · intensitas ' + fp(x.int) + ' · konsisten ' + nf(x.cons, 0) + '% · net ' + fv(x.net, true) + (hot ? ' · akselerasi ' + (x.accel >= 99 ? 'baru' : nf(x.accel, 1) + '×') : '')) + '">' +
        '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + col + '" fill-opacity="' + (0.25 + x.score / 200).toFixed(2) + '" stroke="' + (hot ? 'var(--yellow)' : col) + '" stroke-width="' + (hot ? 2.5 : 1.2) + '"/>' +
        (x._lbl ? '<text x="' + cx.toFixed(1) + '" y="' + (cy - r - 4).toFixed(1) + '" text-anchor="middle" class="lb">' + esc(x.m.code) + '</text>' : '') + '</g>';
    }).join('');
    var svg = '<svg class="sx-radar" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Radar asing top 20">' +
      '<rect x="' + mx + '" y="' + P.t + '" width="' + (W - P.r - mx) + '" height="' + (my - P.t) + '" class="q1"/>' + grid +
      '<line x1="' + mx + '" x2="' + mx + '" y1="' + P.t + '" y2="' + (H - P.b) + '" class="mid"/><line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + my + '" y2="' + my + '" class="mid"/>' +
      '<text x="' + (W - P.r - 6) + '" y="' + (P.t + 14) + '" text-anchor="end" class="ql">KUAT &amp; KONSISTEN</text><text x="' + (P.l + 6) + '" y="' + (P.t + 14) + '" class="ql">SENYAP KONSISTEN</text>' +
      '<text x="' + (W - P.r - 6) + '" y="' + (H - P.b - 6) + '" text-anchor="end" class="ql">KUAT SESAAT</text><text x="' + (P.l + 6) + '" y="' + (H - P.b - 6) + '" class="ql">LEMAH</text>' +
      '<text x="' + (W / 2) + '" y="' + (H - 4) + '" text-anchor="middle" class="ax">Intensitas (net asing / transaksi) →</text>' +
      '<text transform="translate(12 ' + (H / 2) + ') rotate(-90)" text-anchor="middle" class="ax">Konsistensi →</text>' + dots + '</svg>';
    var list = '<ol class="sx-rlist">' + top.map(function (x, i) {
      return '<li><button data-sx="open" data-v="' + esc(x.m.code) + '"><span class="i">' + (i + 1) + '</span><b>' + esc(x.m.code) + '</b><span class="sx-fs' + (x.score >= 85 ? ' hot' : x.score >= 70 ? ' warm' : '') + '">' + x.score + '</span><span class="mono ' + sc(x.net) + '">' + fv(x.net) + '</span></button></li>';
    }).join('') + '</ol>';
    return '<div class="sx-radar-wrap"><div class="sx-box">' + svg + '<p class="sx-note">Ukuran lingkaran = besar net asing. Garis kuning = akselerasi ≥ 2×. Ketuk lingkaran untuk membuka saham.</p></div><div class="sx-box">' + '<h5 class="sx-sub">' + ic('radar') + 'Peringkat skor</h5>' + list + '</div></div>';
  }

  // ─────────────────────────── 7. KALENDER ───────────────────────────
  function calGroups(m) {
    var g = [['sm', 'Smart money (non-ritel)'], ['f', 'Investor asing'], ['rt', 'Ritel']];
    m.brokers.slice().sort(function (a, b) { return Math.abs(b.w.bv - b.w.sv) - Math.abs(a.w.bv - a.w.sv); }).forEach(function (b) { g.push(['b:' + b.code, 'Broker ' + b.code + ' · ' + b.name]); });
    return g;
  }
  function calDay(m, grp, t) {
    var c = m.c[t];
    if (grp.indexOf('b:') === 0) {
      var b = m.brokers.filter(function (x) { return x.code === grp.slice(2); })[0];
      var v = b ? b.nv[t] : 0;
      return { v: v, l: c ? v / (c * 100) : 0, avg: c, avgLbl: 'Close' };
    }
    var K = grp === 'f' ? 'f' : grp === 'rt' ? 'rt' : 'sm';
    var B = m[K + 'B'][t], S = m[K + 'S'][t], BL = m[K + 'BL'][t], SL = m[K + 'SL'][t], net = B - S;
    return { v: net, l: BL - SL, avg: net >= 0 ? (BL ? B / (BL * 100) : 0) : (SL ? S / (SL * 100) : 0), avgLbl: 'Avg' };
  }
  function viewCal() {
    var st = V.cal;
    if (!st.code || !U.by[st.code]) st.code = U.by[A.code()] ? A.code() : (U.by.BBCA ? 'BBCA' : U.list[0].code);
    var m = U.by[st.code], ax = U.axis, months = [];
    ax.forEach(function (d, i) { if (i >= m.first) { var ym = d.slice(0, 7); if (months.indexOf(ym) < 0) months.push(ym); } });
    if (!st.ym || months.indexOf(st.ym) < 0) st.ym = months[months.length - 1];
    var groups = calGroups(m);
    if (!groups.some(function (g) { return g[0] === st.grp; })) st.grp = 'sm';
    var mi = months.indexOf(st.ym), p = st.ym.split('-'), Y = +p[0], M = +p[1] - 1;
    var dayIdx = {}; ax.forEach(function (d, i) { if (d.slice(0, 7) === st.ym) dayIdx[d] = i; });
    var cells = [], mx = 0, tot = 0, totL = 0, nb = 0, ns = 0, best = null, worst = null;
    Object.keys(dayIdx).forEach(function (d) {
      var x = calDay(m, st.grp, dayIdx[d]); var v = st.metric === 'lot' ? x.l : x.v;
      if (Math.abs(v) > mx) mx = Math.abs(v); tot += x.v; totL += x.l; if (x.v > 0) nb++; else if (x.v < 0) ns++;
      if (!best || x.v > best.v) best = { v: x.v, d: d }; if (!worst || x.v < worst.v) worst = { v: x.v, d: d };
    });
    var first = new Date(Date.UTC(Y, M, 1)), last = new Date(Date.UTC(Y, M + 1, 0));
    var start = new Date(first); while (start.getUTCDay() !== 1) start.setUTCDate(start.getUTCDate() - 1);
    var end = new Date(last); while (end.getUTCDay() !== 5) { end.setUTCDate(end.getUTCDate() + (end.getUTCDay() === 6 ? -1 : end.getUTCDay() === 0 ? -2 : 1)); }
    for (var dd = new Date(start); dd <= end; dd.setUTCDate(dd.getUTCDate() + 1)) {
      var w = dd.getUTCDay(); if (w === 0 || w === 6) continue;
      var di = dd.toISOString().slice(0, 10), inM = dd.getUTCMonth() === M, ti = dayIdx[di];
      if (!inM) { cells.push('<div class="sx-cc out"><span class="dn">' + dd.getUTCDate() + '</span></div>'); continue; }
      if (ti === undefined || !m.val[ti]) { cells.push('<div class="sx-cc off' + (ti === undefined && di > ax[ax.length - 1] ? ' fut' : '') + '"><span class="dn">' + dd.getUTCDate() + '</span><small>' + (ti === undefined ? (di > ax[ax.length - 1] ? '' : 'Libur') : 'No trade') + '</small></div>'); continue; }
      var x = calDay(m, st.grp, ti), vv = st.metric === 'lot' ? x.l : x.v, a = mx ? Math.abs(vv) / mx : 0;
      cells.push('<button class="sx-cc ' + (x.v > 0 ? 'g' : x.v < 0 ? 'r' : '') + (st.sel === ti ? ' sel' : '') + '" style="--a:' + (0.12 + a * 0.7).toFixed(2) + '" data-sx="ccell" data-v="' + ti + '">' +
        '<span class="dn">' + dd.getUTCDate() + '</span>' +
        '<b class="nv">' + (x.v > 0 ? '↗' : x.v < 0 ? '↘' : '') + (st.metric === 'lot' ? fl(Math.abs(x.l)) : fv(Math.abs(x.v))) + '</b>' +
        '<small class="lt">' + (st.metric === 'lot' ? fv(Math.abs(x.v)) : fl(Math.abs(x.l)) + ' Lot') + '</small>' +
        '<small class="av">' + x.avgLbl + ' ' + px(x.avg) + '</small></button>');
    }
    // ringkasan 6 bulan
    var strip = months.slice(-6).map(function (ym) {
      var s = 0; ax.forEach(function (d, i) { if (d.slice(0, 7) === ym) s += calDay(m, st.grp, i).v; });
      return { ym: ym, s: s };
    });
    var smx = 0; strip.forEach(function (x) { smx = Math.max(smx, Math.abs(x.s)); });
    var detail = '';
    if (st.sel != null && ax[st.sel] && ax[st.sel].slice(0, 7) === st.ym) {
      var t = st.sel, nets = m.brokers.map(function (b) { return { b: b, v: b.nv[t] }; }).sort(function (a, b) { return b.v - a.v; });
      var xb = calDay(m, st.grp, t), chg = t > 0 ? (m.c[t] / m.c[t - 1] - 1) * 100 : 0;
      detail = '<div class="sx-box sx-cdet"><div class="sx-bh"><h4>' + ic('cal') + esc(dLong(ax[t])) + '</h4><button class="sx-x" data-sx="ccell" data-v="' + t + '" aria-label="Tutup">' + ic('x') + '</button></div>' +
        '<div class="sx-ckpi"><div><small>Net</small><b class="' + sc(xb.v) + '">' + fv(xb.v, true) + '</b></div><div><small>Net lot</small><b class="' + sc(xb.l) + '">' + fl(xb.l) + '</b></div><div><small>' + xb.avgLbl + '</small><b>' + px(xb.avg) + '</b></div><div><small>Close</small><b>' + px(m.c[t]) + ' <em class="' + sc(chg) + '">' + fp(chg) + '</em></b></div></div>' +
        '<div class="sx-cols2 tight"><div><h6 class="sx-up">' + ic('up') + 'Pembeli terbesar</h6>' + nets.filter(function (x) { return x.v > 0; }).slice(0, 5).map(function (x) { return '<div class="sx-kvr">' + bk(x.b.code, x.b.type, x.b.name) + '<span class="sx-up mono">' + fv(x.v) + '</span></div>'; }).join('') + '</div>' +
        '<div><h6 class="sx-dn">' + ic('down') + 'Penjual terbesar</h6>' + nets.filter(function (x) { return x.v < 0; }).reverse().slice(0, 5).map(function (x) { return '<div class="sx-kvr">' + bk(x.b.code, x.b.type, x.b.name) + '<span class="sx-dn mono">' + fv(x.v) + '</span></div>'; }).join('') + '</div></div></div>';
    }
    var codes = U.list.map(function (x) { return x.code; });
    return vhead('cal') +
      '<div class="sx-bar">' +
        '<label class="sx-search">' + ic('search') + '<input id="sxCalCode" list="sxCalList" value="' + esc(st.code) + '" maxlength="6" autocomplete="off" enterkeyhint="go" aria-label="Kode saham"></label>' +
        '<datalist id="sxCalList">' + codes.map(function (c) { return '<option value="' + c + '">'; }).join('') + '</datalist>' +
        '<select class="sx-sel" id="sxCalGrp" aria-label="Kelompok broker">' + groups.map(function (g) { return '<option value="' + esc(g[0]) + '"' + (g[0] === st.grp ? ' selected' : '') + '>' + esc(g[1]) + '</option>'; }).join('') + '</select>' +
        seg('cmetric', [['value', 'Value'], ['lot', 'Lot']], st.metric, 'sm') +
        '<span class="sx-grow"></span><button class="sx-prof" data-sx="open" data-v="' + esc(m.code) + '">' + ic('bar') + 'Broker Activity</button>' +
      '</div>' +
      '<div class="sx-cal-top">' +
        '<div class="sx-mnav"><button class="sx-ib" data-sx="cmon" data-v="-1" ' + (mi <= 0 ? 'disabled' : '') + ' aria-label="Bulan sebelumnya">' + ic('left') + '</button>' +
          '<h3>' + MONTHS[M] + ' ' + Y + ' <small>' + esc(m.code) + '</small></h3>' +
          '<button class="sx-ib" data-sx="cmon" data-v="1" ' + (mi >= months.length - 1 ? 'disabled' : '') + ' aria-label="Bulan berikutnya">' + ic('right') + '</button></div>' +
        '<div class="sx-ckpi">' +
          '<div><small>Net bulan ini</small><b class="' + sc(tot) + '">' + fv(tot, true) + '</b></div>' +
          '<div><small>Net lot</small><b class="' + sc(totL) + '">' + fl(totL) + '</b></div>' +
          '<div><small>Hari beli / jual</small><b><span class="sx-up">' + nb + '</span> / <span class="sx-dn">' + ns + '</span></b></div>' +
          '<div><small>Beli terbesar</small><b class="sx-up">' + (best && best.v > 0 ? fv(best.v) + ' <em>' + dObj(best.d).getUTCDate() + ' ' + MON[M] + '</em>' : '-') + '</b></div>' +
        '</div>' +
      '</div>' +
      '<div class="sx-calwrap"><div class="sx-cal">' + ['MON', 'TUE', 'WED', 'THU', 'FRI'].map(function (x, i) { return '<div class="sx-ch"><span class="l">' + x + '</span><span class="s">' + ['Sen', 'Sel', 'Rab', 'Kam', 'Jum'][i] + '</span></div>'; }).join('') + cells.join('') + '</div></div>' +
      detail +
      '<div class="sx-box"><h5 class="sx-sub">' + ic('bar') + 'Ringkasan 6 bulan <small class="sx-mute">ketuk untuk pindah bulan</small></h5><div class="sx-mstrip">' +
        strip.map(function (x) { var hpx = smx ? Math.abs(x.s) / smx * 100 : 0, p2 = x.ym.split('-'); return '<button class="' + (x.ym === st.ym ? 'on' : '') + '" data-sx="cym" data-v="' + x.ym + '"><span class="bw"><i class="' + (x.s >= 0 ? 'g' : 'r') + '" style="height:' + Math.max(4, hpx) + '%"></i></span><b class="' + sc(x.s) + '">' + fv(x.s) + '</b><small>' + MON[+p2[1] - 1] + ' ' + p2[0].slice(2) + '</small></button>'; }).join('') +
      '</div></div>' +
      '<p class="sx-note">' + (m.realBroker ? 'Data broker asli (R2).' : 'Arus broker saham ini masih dummy; harga asli dari ohlc.json.') + ' Avg = harga rata-rata beli (hari net beli) atau jual (hari net jual) kelompok terpilih.</p>';
  }

  // ─────────────────────────── Render & event ───────────────────────────
  var BODY = { gems: bodyGems, accum: bodyAccum, smart: bodySmart, bh: bodyBH, foreign: bodyForeign };
  var VIEW = { today: viewToday, gems: viewGems, accum: viewAccum, smart: viewSmart, bh: viewBH, foreign: viewForeign, cal: viewCal };
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
      '<div class="sx-src" id="sxSrc"></div>' +
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
  function srcNote() {
    var el = host.querySelector('#sxSrc'); if (!el || !U) return;
    var nReal = U.list.filter(function (m) { return m.realBroker; }).length;
    el.innerHTML = '<span class="sx-sb ok">' + ic('check') + 'Harga &amp; teknikal asli · ' + nf(U.list.length) + ' saham</span>' +
      '<span class="sx-sb ' + (nReal ? 'ok' : 'dm') + '">' + ic(nReal ? 'check' : 'info') + (nReal ? nReal + ' saham dengan data broker asli <i class="sx-real">●</i>, sisanya dummy' : 'Arus broker / asing / insider: data dummy') + '</span>' +
      '<span class="sx-sb">' + ic('cal') + 'Update ' + esc(dShort(U.axis[U.n - 1])) + '</span>';
  }
  function renderView() {
    if (!host) return;
    syncTabs();
    var el = host.querySelector('#sxView');
    if (!U) { ensureUniverse(renderView); return; }
    if (!U.list.length) { el.innerHTML = empty('Data harga (ohlc.json) belum tersedia.'); return; }
    if (V.guide[V.view] === undefined) { V.guide[V.view] = load('sx_seen_' + V.view) ? null : 'how'; store('sx_seen_' + V.view, '1'); }
    srcNote();
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
  function onClick(e) {
    var el = e.target.closest && e.target.closest('[data-sx]');
    if (!el || !host.contains(el)) return;
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
    var a = el.getAttribute('data-sx'), v = el.getAttribute('data-v');
    var G = V.gems, Ac = V.accum, Sm = V.smart, Bh = V.bh, Fx = V.foreign, C = V.cal;
    switch (a) {
      case 'view': V.view = v; store('sx_view', v); renderView(); host.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
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
      case 'fsort': if (Fx.sort === v) Fx.dir = -Fx.dir; else { Fx.sort = v; Fx.dir = -1; } renderBody(); return;
      case 'cmetric': C.metric = v; break;
      case 'cmon': var p = C.ym.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1 + +v, 1)); C.ym = d.toISOString().slice(0, 7); C.sel = null; break;
      case 'cym': C.ym = v; C.sel = null; break;
      case 'ccell': C.sel = C.sel === +v ? null : +v; rerenderKeepScroll(); if (C.sel != null) { var dt = host.querySelector('.sx-cdet'); if (dt && mq('(max-width:640px)')) dt.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } return;
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
      case 'sxFKsei': Fx.ksei = v; renderBody(); return;
      case 'sxFShow': Fx.show = +v || 50; renderBody(); return;
      case 'sxCalCode': setCalCode(v); return;
      case 'sxCalGrp': V.cal.grp = v; rerenderKeepScroll(); return;
      default: return;
    }
    Ac.limit = 10; renderBody();
  }
  function setCalCode(v) {
    v = String(v || '').trim().toUpperCase();
    if (!U.by[v]) { A.toast('Kode tidak ditemukan: ' + v); return; }
    V.cal.code = v; V.cal.ym = null; V.cal.sel = null; V.cal.grp = 'sm'; rerenderKeepScroll();
  }
  var _qt = null;
  function onInput(e) {
    var id = e.target.id, map = { sxGQ: 'gems', sxAQ: 'accum', sxSQ: 'smart', sxBQ: 'bh', sxFQ: 'foreign' };
    if (!map[id]) return;
    V[map[id]].q = e.target.value.trim();
    clearTimeout(_qt); _qt = setTimeout(renderBody, 160);
  }
  function onKey(e) { if (e.key === 'Enter' && e.target.id === 'sxCalCode') { e.preventDefault(); setCalCode(e.target.value); } }

  // ─────────────────────────── CSS ───────────────────────────
  var CSS = [
    '.sx{display:flex;flex-direction:column;gap:14px;min-width:0}',
    '.sx-ic{width:16px;height:16px;flex-shrink:0;vertical-align:-3px}',
    '.sx-up{color:var(--green)!important}.sx-dn{color:var(--red)!important}.sx-pu{color:#8b5cf6}[data-theme="dark"] .sx-pu{color:#c4a3ff}.sx-y{color:var(--yellow)!important}',
    '.sx-mute{color:var(--text3)}.mono{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}',
    '.sx-grow{flex:1}',
    '.sx-cap{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--text3)}',
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
    '.sx-src{display:flex;gap:6px;flex-wrap:wrap}',
    '.sx-sb{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;background:var(--bg2);color:var(--text2)}',
    '.sx-sb .sx-ic{width:13px;height:13px}.sx-sb.ok{color:var(--green);background:var(--green-bg)}.sx-sb.dm{color:var(--yellow);background:var(--yellow-bg)}',
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
    '.sx-radar-wrap{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:12px;align-items:start}',
    '.sx-radar{display:block;width:100%;height:auto;font-family:"IBM Plex Mono",monospace}',
    '.sx-radar text{font-size:10px;fill:var(--text3)}.sx-radar .g{stroke:var(--border2);stroke-dasharray:3 4}.sx-radar .mid{stroke:var(--border);stroke-width:1.2}',
    '.sx-radar .q1{fill:color-mix(in srgb,var(--green) 6%,transparent)}.sx-radar .ql{font-size:9.5px;font-weight:800;letter-spacing:.06em;fill:var(--text3);opacity:.8}.sx-radar .ax{font-size:10.5px;font-weight:700}',
    '.sx-radar .dot{cursor:pointer}.sx-radar .dot:hover circle{fill-opacity:.85}.sx-radar .lb{font-size:10.5px;font-weight:800;fill:var(--text)}',
    '.sx-rlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}',
    '.sx-rlist button{display:grid;grid-template-columns:22px 1fr auto 74px;gap:8px;align-items:center;width:100%;font:inherit;font-size:12px;padding:6px 4px;border:0;border-bottom:1px dashed var(--border2);background:none;cursor:pointer;text-align:left}',
    '.sx-rlist button:hover{background:var(--bg2)}.sx-rlist .i{color:var(--text3);font-size:11px}.sx-rlist b{font-family:"IBM Plex Mono",monospace;color:var(--accent)}.sx-rlist .mono{text-align:right}',
    /* calendar */
    '.sx-cal-top{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
    '.sx-mnav{display:flex;align-items:center;gap:10px}.sx-mnav h3{font-size:20px;font-weight:800;color:var(--text);min-width:170px;text-align:center}.sx-mnav h3 small{font-family:"IBM Plex Mono",monospace;font-size:12px;color:var(--accent);margin-left:4px}',
    '.sx-ckpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;flex:1;max-width:640px}',
    '.sx-ckpi div{background:var(--bg2);border-radius:10px;padding:7px 10px;min-width:0}.sx-ckpi small{display:block;font-size:10.5px;color:var(--text3);font-weight:700}',
    '.sx-ckpi b{display:block;font-family:"IBM Plex Mono",monospace;font-size:13.5px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--text)}.sx-ckpi b em{font-style:normal;font-size:11px;color:var(--text3)}',
    '.sx-calwrap{background:var(--card);border-radius:var(--radius);padding:10px;border:1px solid var(--border);box-shadow:var(--shadow-card)}',
    '.sx-cal{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px}',
    '.sx-ch{text-align:center;font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--text3);padding:4px 0 6px}.sx-ch .s{display:none}',
    '.sx-cc{position:relative;display:flex;flex-direction:column;align-items:flex-end;gap:2px;min-height:86px;padding:8px;border-radius:8px;border:1px solid var(--border2);background:var(--bg2);font:inherit;text-align:right;min-width:0;overflow:hidden}',
    'button.sx-cc{cursor:pointer;transition:transform .1s,box-shadow .15s}button.sx-cc:hover{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.18)}',
    '.sx-cc .dn{position:absolute;left:8px;top:6px;font-size:11px;color:var(--text3);font-family:"IBM Plex Mono",monospace}',
    '.sx-cc .nv{margin-top:14px;font-family:"IBM Plex Mono",monospace;font-size:14px;font-weight:800;white-space:nowrap}',
    '.sx-cc .lt,.sx-cc .av{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}',
    '.sx-cc.g{background:color-mix(in srgb,#16a34a calc(var(--a) * 70%),var(--bg2));border-color:color-mix(in srgb,#22c55e calc(var(--a) * 80%),var(--border2))}.sx-cc.g .nv{color:#22c55e}',
    '.sx-cc.r{background:color-mix(in srgb,#dc2626 calc(var(--a) * 70%),var(--bg2));border-color:color-mix(in srgb,#ef4444 calc(var(--a) * 80%),var(--border2))}.sx-cc.r .nv{color:#f87171}',
    '[data-theme="dark"] .sx-cc.g .nv{color:#4ade80}[data-theme="dark"] .sx-cc .lt,[data-theme="dark"] .sx-cc .av{color:#cbd5e1}',
    ':root:not([data-theme="dark"]) .sx-cc.g .nv{color:#15803d}:root:not([data-theme="dark"]) .sx-cc.r .nv{color:#b91c1c}',
    '.sx-cc.out{opacity:.35;background:transparent}.sx-cc.off{opacity:.6;justify-content:center;align-items:center}.sx-cc.off small{font-size:10.5px;color:var(--text3)}.sx-cc.fut{opacity:.3;border-style:dashed}',
    '.sx-cc.sel{outline:2px solid var(--accent);outline-offset:1px}',
    '.sx-cdet .sx-ckpi{max-width:none}',
    '.sx-cols2 h6{display:flex;align-items:center;gap:5px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;margin:0 0 6px}',
    '.sx-kvr{display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px dashed var(--border2);font-size:12px}',
    '.sx-mstrip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}',
    '.sx-mstrip button{display:flex;flex-direction:column;align-items:center;gap:3px;font:inherit;padding:8px 4px;border-radius:10px;border:1px solid var(--border2);background:var(--bg2);cursor:pointer;min-width:0}',
    '.sx-mstrip button.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,var(--card))}',
    '.sx-mstrip .bw{display:flex;align-items:flex-end;height:44px;width:18px}.sx-mstrip .bw i{display:block;width:100%;border-radius:3px}.sx-mstrip .bw i.g{background:var(--green)}.sx-mstrip .bw i.r{background:var(--red)}',
    '.sx-mstrip b{font-family:"IBM Plex Mono",monospace;font-size:11px;white-space:nowrap}.sx-mstrip small{font-size:10.5px;color:var(--text3)}',
    /* ── Tablet ── */
    '@media (max-width:1099px){',
      '.sx-acc-grid{grid-template-columns:1fr}',
      '.sx-side{position:static;max-height:none;order:-1}',
      '.sx-side summary{display:flex}',
      '.sx-side-in{padding-top:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
      '.sx-side-in .sx-sg:first-child,.sx-side-in>.sx-btn{grid-column:1/-1}',
      '.sx-qp{grid-template-columns:repeat(3,1fr)}',
      '.sx-pgrid3{grid-template-columns:repeat(2,minmax(0,1fr))}',
      '.sx-radar-wrap{grid-template-columns:1fr}',
      '.sx-rlist{display:grid;grid-template-columns:1fr 1fr;column-gap:16px}',
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
      '.sx-rlist{grid-template-columns:1fr}',
      '.sx-radar text{font-size:17px}.sx-radar .lb{font-size:19px}.sx-radar .ql{font-size:14px}.sx-radar .ax{font-size:16px}',
      '.sx-mnav{width:100%;justify-content:space-between}.sx-mnav h3{font-size:17px;min-width:0}',
      '.sx-ckpi{grid-template-columns:1fr 1fr;max-width:none;width:100%}',
      '#sxCalGrp{flex:1 1 60%}',
      '.sx-calwrap{padding:6px}.sx-cal{gap:4px}',
      '.sx-ch .l{display:none}.sx-ch .s{display:inline}',
      '.sx-cc{min-height:64px;padding:5px 4px 5px;border-radius:7px}',
      '.sx-cc .dn{left:5px;top:3px;font-size:10px}',
      '.sx-cc .nv{margin-top:12px;font-size:11px}',
      '.sx-cc .lt{font-size:9px}.sx-cc .av{display:none}',
      '.sx-mstrip{grid-template-columns:repeat(3,minmax(0,1fr))}',
    '}',
    '@media (max-width:380px){',
      '.sx-cc .nv{font-size:10px;letter-spacing:-.02em}.sx-cc .lt{display:none}.sx-cc{min-height:52px}',
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
      host.addEventListener('click', onClick);
      host.addEventListener('change', onChange);
      host.addEventListener('input', onInput);
      host.addEventListener('keydown', onKey);
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
    renderView();
  }
  // Saham aktif di bar atas berubah → kalender ikut (true = tetap di Screener)
  function codeChanged(code) {
    if (V.view !== 'cal' || !U || !U.by[code]) return false;
    V.cal.code = code; V.cal.ym = null; V.cal.sel = null; V.cal.grp = 'sm';
    if (host && !host.hidden) renderView();
    return true;
  }
  window.SmartMoneyScreener = { show: show, codeChanged: codeChanged };
})();
