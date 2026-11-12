/* ══════════════════════════════════════════════════════════════════════
 * Economstock Terminal — Menu "Smart Money" (KHUSUS ADMIN)
 *
 * Melacak ke mana uang besar bergerak:
 *   1. Ringkasan & skor Smart Money (bahasa awam)
 *   2. Radar pasar: saham yang sedang dikumpulkan / dilepas
 *   3. Broker Flow: akumulasi net per broker vs harga (candle)
 *   4. Broker Action: top buyer / seller + meter akumulasi-distribusi
 *   5. Broker Distribution: diagram aliran pembeli → penjual (sankey)
 *   6. Insider: transaksi orang dalam (IDX / KSEI) + rekam jejak beli
 *
 * Modul ini BERDIRI SENDIRI (aturan protected-areas):
 *   - Halaman #page-smartmoney, tab nav, item bottom-nav, dan grup menu
 *     avatar DISUNTIKKAN lewat JS, hanya bila window.__ES_IS_ADMIN = true.
 *   - Navigasi memakai showPage() yang sudah ada, tanpa mengubahnya.
 *   - Tidak membaca / menulis data menu inti.
 *
 * HANYA DATA ASLI dari R2 (endpoint /api/admin/smartmoney*). Tidak ada data
 * dummy: saham tanpa file di R2 menampilkan kotak kosong.
 * ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ─────────────────────────── Konstanta ───────────────────────────
  var MON = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  var BUMN = { CC: 1, NI: 1, OD: 1, DX: 1 };
  var UNIVERSE = ['AVIA','BBRI','BBCA','BMRI','TLKM','ASII','ANTM','GOTO','ADRO','BRIS','AMMN','MDKA','INCO','UNVR','ICBP','PGAS'];
  var POPULAR = ['CC','XL','YP','PD','AK','BK','ZP','KZ','NI','DX','RX','KK','DP','SQ','XC','OD','MG','DR','YB','YJ','AT','LG','GR','EP','DH','CP','AZ','KI','NI','AG'];
  var LINE_COLORS = ['#8b5cf6','#14b8a6','#db2777','#f97316','#eab308','#3b82f6','#22c55e','#ef4444','#06b6d4','#a855f7','#84cc16','#f43f5e'];
  var TYPE_META = {
    F: { label: 'Asing',    color: '#ef4444' },
    B: { label: 'BUMN',     color: '#10b981' },
    D: { label: 'Domestik', color: '#8b5cf6' }
  };
  var PERIODS = [
    { k: '1W', label: '1W', n: 5 },
    { k: '1M', label: '1M', n: 21 },
    { k: '3M', label: '3M', n: 63 },
    { k: '6M', label: '6M', n: 126 },
    { k: 'YTD', label: 'YTD', n: 0 },
    { k: '1Y', label: '1Y', n: 252 }
  ];
  var PERIOD_TEXT = { '1W': '1 minggu', '1M': '1 bulan', '3M': '3 bulan', '6M': '6 bulan', 'YTD': 'sejak awal tahun', '1Y': '1 tahun' };

  // ─────────────────────────── Util ───────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(r) {
    var u = r() || 1e-9, v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  function shuffle(arr, r) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function tickSize(p) { return p < 200 ? 1 : p < 500 ? 2 : p < 2000 ? 5 : p < 5000 ? 10 : 25; }
  function roundTick(p) { var t = tickSize(p); return Math.max(50, Math.round(p / t) * t); }

  function tradingDays(endIso, n) {
    var d = new Date(endIso + 'T00:00:00Z'), out = [];
    while (out.length < n) {
      var w = d.getUTCDay();
      if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return out.reverse();
  }

  function nf(v, dec) {
    return Number(v).toLocaleString('id-ID', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 });
  }
  // Nilai rupiah ringkas: 2,2 M · 449,7 Jt · 1,3 T
  function fmtVal(v, withRp) {
    var a = Math.abs(v), s;
    if (a >= 1e12) s = nf(a / 1e12, 2) + ' T';
    else if (a >= 1e9) s = nf(a / 1e9, a >= 1e11 ? 0 : 1) + ' M';
    else if (a >= 1e6) s = nf(a / 1e6, 1) + ' Jt';
    else if (a >= 1e3) s = nf(a / 1e3, 0) + ' Rb';
    else s = nf(a, 0);
    return (v < 0 ? '−' : '') + (withRp ? 'Rp' : '') + s;
  }
  function fmtLot(v) {
    var a = Math.abs(v), s;
    if (a >= 1e9) s = nf(a / 1e9, 1) + ' M';
    else if (a >= 1e6) s = nf(a / 1e6, 1) + ' Jt';
    else if (a >= 1e3) s = nf(a / 1e3, 1) + ' Rb';
    else s = nf(a, 0);
    return (v < 0 ? '−' : '') + s;
  }
  function fmtPct(v, dec) {
    if (!isFinite(v)) return '-';
    return (v > 0 ? '+' : v < 0 ? '−' : '') + nf(Math.abs(v), dec == null ? 1 : dec) + '%';
  }
  function fmtDate(iso, long) {
    var p = iso.split('-');
    return p[2] + ' ' + MON[+p[1] - 1] + ' ' + (long ? p[0] : p[0].slice(2));
  }
  function signCls(v) { return v > 0 ? 'smm-up' : v < 0 ? 'smm-dn' : ''; }

  function brokerList() {
    var BC = window.BrokerCodes;
    if (BC && BC.LIST && BC.LIST.length) return BC.LIST;
    return POPULAR.map(function (c) { return { code: c, name: c, foreign: false }; });
  }
  function brokerType(b) { return BUMN[b.code] ? 'B' : b.foreign ? 'F' : 'D'; }
  function titleCase(s) {
    return String(s).toLowerCase().replace(/\b([a-z])/g, function (m) { return m.toUpperCase(); })
      .replace(/\bTbk\b\.?/i, 'Tbk');
  }

  // ── Agregasi ──
  // Faktor investor: all = semua, F = porsi investor asing, D = domestik.
  function invFac(b, inv) { return b.fx ? 1 : inv === 'F' ? b.f : inv === 'D' ? 1 - b.f : 1; }
  // Array harian sesuai filter investor. Data asli: fbv.. = porsi asing, dbv.. = domestik.
  function series(b, inv, k) { return b.fx && inv !== 'all' ? b[(inv === 'F' ? 'f' : 'd') + k] : b[k]; }

  function aggregate(G, t0, t1, inv) {
    return G.brokers.map(function (b) {
      var fac = invFac(b, inv), bv = 0, sv = 0, bl = 0, sl = 0;
      var BV = series(b, inv, 'bv'), SV = series(b, inv, 'sv'), BL = series(b, inv, 'bl'), SL = series(b, inv, 'sl');
      for (var t = t0; t <= t1; t++) { bv += BV[t]; sv += SV[t]; bl += BL[t]; sl += SL[t]; }
      bv *= fac; sv *= fac; bl *= fac; sl *= fac;
      return {
        code: b.code, name: b.name, type: b.type, bv: bv, sv: sv, bl: bl, sl: sl,
        net: bv - sv, netL: bl - sl,
        bAvg: bl > 0 ? bv / (bl * 100) : 0, sAvg: sl > 0 ? sv / (sl * 100) : 0
      };
    });
  }
  // Skor akumulasi (-1..1): konsentrasi 3 net buyer teratas vs 3 net seller teratas.
  function accScore(rows) {
    var nets = rows.map(function (x) { return x.net; }).sort(function (a, b) { return b - a; });
    var A = 0, D = 0;
    for (var i = 0; i < 3 && i < nets.length; i++) { if (nets[i] > 0) A += nets[i]; }
    for (var k = nets.length - 1; k >= nets.length - 3 && k >= 0; k--) { if (nets[k] < 0) D -= nets[k]; }
    return { score: A + D > 0 ? (A - D) / (A + D) : 0, A: A, D: D };
  }
  function accLabel(s) {
    if (s <= -0.35) return { k: 'bd', label: 'Distribusi Besar', short: 'Big Dist', emoji: '🔴' };
    if (s < -0.1) return { k: 'd', label: 'Distribusi', short: 'Dist', emoji: '🟠' };
    if (s <= 0.1) return { k: 'n', label: 'Netral', short: 'Neutral', emoji: '⚪' };
    if (s < 0.35) return { k: 'a', label: 'Akumulasi', short: 'Acc', emoji: '🟢' };
    return { k: 'ba', label: 'Akumulasi Besar', short: 'Big Acc', emoji: '🟢' };
  }
  function periodStart(G, key) {
    if (key === 'YTD') {
      for (var t = 0; t < G.nF; t++) if (G.days[G.off + t] >= G.end.slice(0, 4) + '-01-01') return t;
      return 0;
    }
    var p = PERIODS.filter(function (x) { return x.k === key; })[0] || PERIODS[2];
    return Math.max(0, G.nF - p.n);
  }
  function turnover(G, t0, t1) {
    var s = 0;
    G.brokers.forEach(function (b) { for (var t = t0; t <= t1; t++) s += b.bv[t]; });
    return s;
  }
  function insiderStats(G, fromIdx) {
    var buy = 0, sell = 0, nb = 0, ns = 0;
    G.trades.forEach(function (x) {
      if (x.idx < fromIdx) return;
      if (x.action === 'BUY') { buy += x.value; nb++; } else { sell += x.value; ns++; }
    });
    return { buy: buy, sell: sell, net: buy - sell, nb: nb, ns: ns };
  }
  // Skor Smart Money 0-100 = bandar (45%) + asing (30%) + insider (25%)
  function smartScore(G, t0) {
    var t1 = G.nF - 1;
    var rows = aggregate(G, t0, t1, 'all');
    var acc = accScore(rows).score;
    var fNet = G.hasForeign ? aggregate(G, t0, t1, 'F').reduce(function (a, x) { return a + x.net; }, 0) : 0;
    var tv = turnover(G, t0, t1) || 1;
    var fComp = Math.tanh(fNet / tv * 25);
    var ins = insiderStats(G, G.nP - 126);
    var iComp = ins.buy + ins.sell > 0 ? (ins.buy - ins.sell) / (ins.buy + ins.sell) : 0;
    var score = 50 + 50 * (0.45 * acc + 0.30 * fComp + 0.25 * iComp);
    return { score: clamp(Math.round(score), 0, 100), acc: acc, fNet: fNet, fComp: fComp, ins: ins, iComp: iComp, rows: rows, turnover: tv };
  }
  function scoreLabel(s) {
    if (s >= 65) return { k: 'ba', label: 'Uang besar MASUK', desc: 'Bandar, asing, dan orang dalam kompak cenderung membeli.' };
    if (s >= 55) return { k: 'a', label: 'Cenderung masuk', desc: 'Lebih banyak tanda pembelian oleh pemain besar daripada penjualan.' };
    if (s > 45) return { k: 'n', label: 'Netral, wait and see', desc: 'Pemain besar belum menunjukkan arah yang jelas.' };
    if (s > 35) return { k: 'd', label: 'Cenderung keluar', desc: 'Lebih banyak tanda penjualan oleh pemain besar.' };
    return { k: 'bd', label: 'Uang besar KELUAR', desc: 'Bandar, asing, dan orang dalam cenderung melepas saham.' };
  }

  // ─────────────────────────── CSS ───────────────────────────
  var CSS = [
    '#page-smartmoney{padding:18px 20px 40px}',
    /* overflow:hidden bawaan .page mematikan position:sticky; clip tetap mencegah scroll samping */
    '#page-smartmoney{overflow:visible!important;overflow-x:clip!important}',
    '.smm-wrap{max-width:1400px;margin:0 auto;display:flex;flex-direction:column;gap:16px}',
    '.smm-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-card);padding:16px;min-width:0}',
    '.smm-head{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end;justify-content:space-between}',
    '.smm-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.smm-title h2{font-size:22px;font-weight:800;color:var(--text);letter-spacing:-.01em}',
    '.smm-badge{font-size:10px;font-weight:800;letter-spacing:.06em;padding:3px 8px;border-radius:999px;text-transform:uppercase}',
    '.smm-badge.adm{background:var(--grad);color:#fff}',
    '.smm-badge.none{background:var(--yellow-bg);color:var(--yellow);border:1px solid var(--yellow)}',
    '.smm-sub{color:var(--text2);font-size:13px;margin-top:4px;max-width:640px;line-height:1.5}',
    '.smm-pick{display:flex;flex-direction:column;gap:8px;align-items:flex-end}',
    '.smm-pick-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end}',
    '.smm-input{font:inherit;font-family:"IBM Plex Mono",monospace;font-weight:700;text-transform:uppercase;width:120px;padding:8px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:14px}',
    '.smm-input:focus{outline:2px solid var(--accent);outline-offset:1px}',
    '.smm-btn,.smm-seg button,.smm-sel{font:inherit;font-size:12px;font-weight:700;padding:6px 12px;border-radius:999px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;transition:all .15s}',
    '.smm-btn:hover,.smm-seg button:hover{color:var(--accent);border-color:var(--accent)}',
    '.smm-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}',
    '[data-theme="dark"] .smm-btn.primary{color:#1a0f3c}',
    '.smm-sel{padding:6px 10px;border-radius:10px;appearance:auto}',
    '.smm-seg{display:inline-flex;gap:4px;flex-wrap:wrap}',
    '.smm-seg button.on{background:var(--green-bg);color:var(--green);border-color:var(--green)}',
    '.smm-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.smm-toolbar .lbl{font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.05em}',
    '.smm-h3{display:flex;align-items:center;gap:6px;font-size:16px;font-weight:800;color:var(--text);margin-bottom:4px}',
    '.smm-h3 small{font-size:11px;font-weight:600;color:var(--text3)}',
    '.smm-desc{font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:12px}',
    '.smm-tip{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1px solid var(--border);color:var(--text3);font-size:11px;font-weight:800;cursor:pointer;background:var(--bg2);flex-shrink:0;font-style:normal}',
    '.smm-tip:hover{color:var(--accent);border-color:var(--accent)}',
    '#smmPop{position:fixed;z-index:9999;max-width:300px;background:var(--text);color:var(--card);font-size:12px;line-height:1.5;padding:10px 12px;border-radius:10px;box-shadow:var(--shadow-card-lg);pointer-events:none;opacity:0;transition:opacity .12s}',
    '#smmPop.show{opacity:1}',
    '.smm-up{color:var(--green)!important}.smm-dn{color:var(--red)!important}',
    '.mono-n{font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums}',
    /* summary */
    '.smm-sum{display:grid;grid-template-columns:minmax(280px,1.2fr) repeat(3,minmax(0,1fr));gap:12px}',
    '.smm-verdict{display:flex;gap:16px;align-items:center;position:relative;overflow:hidden}',
    '.smm-verdict::before{content:"";position:absolute;inset:0;opacity:.10;pointer-events:none}',
    '.smm-verdict.k-ba::before,.smm-verdict.k-a::before{background:var(--green)}',
    '.smm-verdict.k-bd::before,.smm-verdict.k-d::before{background:var(--red)}',
    '.smm-verdict.k-n::before{background:var(--text3)}',
    '.smm-gauge{width:150px;flex-shrink:0}',
    '.smm-verdict h4{font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.06em}',
    '.smm-verdict .big{font-size:20px;font-weight:800;margin:2px 0 4px;color:var(--text)}',
    '.smm-verdict p{font-size:12px;color:var(--text2);line-height:1.5}',
    '.smm-verdict ul{margin:8px 0 0;padding:0;list-style:none;font-size:12px;color:var(--text2);display:flex;flex-direction:column;gap:3px}',
    '.smm-kpi h4{font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:6px}',
    '.smm-kpi .v{font-size:22px;font-weight:800;margin:6px 0 2px;font-family:"IBM Plex Mono",monospace}',
    '.smm-kpi .pill{display:inline-block;font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px;margin-bottom:6px}',
    '.pill.k-ba,.pill.k-a{background:var(--green-bg);color:var(--green)}',
    '.pill.k-bd,.pill.k-d{background:var(--red-bg);color:var(--red)}',
    '.pill.k-n{background:var(--bg2);color:var(--text2)}',
    '.smm-kpi p{font-size:12px;color:var(--text2);line-height:1.5}',
    '.smm-kpi b{color:var(--text)}',
    /* radar */
    '.smm-radar-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}',
    '.smm-radar-col h5{font-size:12px;font-weight:800;margin-bottom:6px;color:var(--text2)}',
    '.smm-rrow{display:grid;grid-template-columns:56px 1fr 92px 64px;gap:8px;align-items:center;padding:6px 8px;border-radius:8px;cursor:pointer;font-size:12px}',
    '.smm-rrow:hover{background:var(--bg2)}',
    '.smm-rrow.on{background:var(--bg2);outline:1px solid var(--accent)}',
    '.smm-rrow .c{font-family:"IBM Plex Mono",monospace;font-weight:800;color:var(--accent)}',
    '.smm-rbar{height:8px;border-radius:4px;background:var(--bg3);overflow:hidden}',
    '.smm-rbar i{display:block;height:100%;border-radius:4px}',
    '.smm-rrow .n{text-align:right;font-family:"IBM Plex Mono",monospace;font-size:11px}',
    '.smm-rhead{display:grid;grid-template-columns:56px 1fr 92px 64px;gap:8px;padding:0 8px 4px;font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase}',
    '.smm-rhead span:nth-child(n+3){text-align:right}',
    /* grid */
    '.smm-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(360px,1fr);gap:16px;align-items:start}',
    '.smm-chart{position:relative;height:420px;margin-top:8px}',
    '.smm-legend{display:flex;flex-direction:column;justify-content:center;gap:2px;min-height:48px;margin-top:8px;font-size:11.5px;background:var(--bg2);border:1px solid var(--border2);border-radius:10px;padding:6px 10px}',
    '.smm-legend .d{font-weight:800;color:var(--text)}',
    '.smm-legend .row{display:flex;gap:10px;flex-wrap:wrap}',
    '.smm-legend .row span{white-space:nowrap}',
    '.smm-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;align-items:center}',
    '.smm-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 8px 5px 10px;border-radius:8px;font-size:12px;font-weight:800;cursor:pointer;border:1px solid transparent;user-select:none}',
    '.smm-chip .dot{width:8px;height:8px;border-radius:50%}',
    '.smm-chip .x{opacity:.55;font-size:14px;line-height:1;padding:0 2px}',
    '.smm-chip .x:hover{opacity:1}',
    '.smm-chip.t-F{background:var(--red-bg)}.smm-chip.t-B,.smm-chip.t-D{background:var(--green-bg)}',
    '.smm-chip.t-D{background:color-mix(in srgb,#8b5cf6 14%,transparent)}',
    '.smm-chip.price{background:var(--bg2);color:var(--text)}',
    '.smm-chip.off{opacity:.4;text-decoration:line-through}',
    '.smm-chip.flash{animation:smmFlash 1s}',
    '@keyframes smmFlash{0%,100%{box-shadow:none}30%{box-shadow:0 0 0 3px var(--accent)}}',
    '.smm-add{position:relative}',
    '.smm-add>button{width:30px;height:30px;border-radius:50%;border:1px dashed var(--border);background:var(--card);color:var(--text2);font-size:18px;cursor:pointer}',
    '.smm-addmenu{position:absolute;bottom:36px;left:0;z-index:20;background:var(--card);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-card-lg);padding:6px;width:260px;max-height:300px;overflow:auto;display:none}',
    '.smm-addmenu.open{display:block}',
    '.smm-addmenu button{display:grid;grid-template-columns:34px 1fr auto;gap:6px;width:100%;text-align:left;padding:6px;border:0;background:none;color:var(--text);font:inherit;font-size:12px;border-radius:6px;cursor:pointer}',
    '.smm-addmenu button:hover{background:var(--bg2)}',
    '.bk{font-family:"IBM Plex Mono",monospace;font-weight:800}',
    '.bk.t-F{color:#ef4444}.bk.t-B{color:#10b981}.bk.t-D{color:#8b5cf6}',
    '[data-theme="dark"] .bk.t-F{color:#fb7185}[data-theme="dark"] .bk.t-B{color:#34d399}[data-theme="dark"] .bk.t-D{color:#c4a3ff}',
    '.smm-insight{margin-top:12px;padding:10px 12px;border-radius:10px;background:var(--bg2);font-size:12px;line-height:1.6;color:var(--text2)}',
    '.smm-insight b{color:var(--text)}',
    '.smm-pricetog{margin-left:auto}',
    /* action */
    '.smm-datebar{display:flex;align-items:center;justify-content:center;gap:10px;padding:8px;border:1px solid var(--border2);border-radius:10px 10px 0 0;font-weight:800;color:var(--green)}',
    '.smm-datebar button{border:0;background:none;color:var(--green);font-size:18px;cursor:pointer;padding:0 6px}',
    '.smm-datebar button:disabled{opacity:.3;cursor:default}',
    '.smm-datebar input{font:inherit;font-size:12px;border:1px solid var(--border2);border-radius:6px;padding:2px 6px;background:var(--bg2);color:var(--text)}',
    '.smm-actsel{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--border2);border-top:0;border-radius:0 0 10px 10px;margin-bottom:14px}',
    '.smm-actsel select{font:inherit;font-size:12px;font-weight:700;border:0;background:transparent;color:var(--text);padding:8px}',
    '.smm-actsel select+select{border-left:1px solid var(--border2)}',
    '.smm-meter{position:relative;height:12px;border-radius:999px;background:linear-gradient(90deg,#ef4444 0%,#f87171 35%,#9ca3af 50%,#34d399 65%,#10b981 100%);margin:10px 0 4px}',
    '.smm-meter i{position:absolute;top:-4px;width:6px;height:20px;border-radius:3px;background:#7c3aed;box-shadow:0 0 0 2px var(--card);transform:translateX(-50%);transition:left .4s}',
    '.smm-meter-lbl{display:flex;justify-content:space-between;font-size:11px;color:var(--text3)}',
    '.smm-meter-txt{font-size:12px;color:var(--text2);margin:8px 0 12px;line-height:1.5}',
    '.smm-tbl{width:100%;border-collapse:collapse;font-size:12px}',
    '.smm-tbl th{font-size:11px;color:var(--text3);font-weight:700;text-align:right;padding:6px 4px;border-bottom:1px solid var(--border2);white-space:nowrap;user-select:none}',
    '.smm-tbl th.s{cursor:pointer}.smm-tbl th.s:hover{color:var(--accent)}',
    '.smm-tbl th.on{color:var(--accent)}',
    '.smm-tbl th:first-child,.smm-tbl th:nth-child(5){text-align:left}',
    '.smm-tbl td{padding:6px 4px;text-align:right;font-family:"IBM Plex Mono",monospace;font-variant-numeric:tabular-nums;white-space:nowrap}',
    '.smm-tbl td.bkc{text-align:left;cursor:pointer}',
    '.smm-tbl td.bkc:hover{text-decoration:underline}',
    '.smm-tbl td:nth-child(5){border-left:1px solid var(--border2);padding-left:8px}',
    '.smm-tbl .b{color:var(--green)}.smm-tbl .s{color:var(--red)}',
    '.smm-tbl tr:hover td{background:var(--bg2)}',
    '.smm-more{display:block;margin:8px auto 0}',
    '.smm-totals{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:12px}',
    '.smm-totals div{background:var(--bg2);border-radius:8px;padding:8px;font-size:11px;color:var(--text3)}',
    '.smm-totals b{display:block;font-size:13px;color:var(--text);font-family:"IBM Plex Mono",monospace;margin-top:2px}',
    /* sankey */
    '.smm-sk-wrap{position:relative;margin-top:8px}',
    '.smm-sk-wrap svg{display:block;width:100%;height:auto;overflow:visible}',
    '.smm-sk-link{transition:opacity .15s;cursor:pointer}',
    '.smm-sk-node{cursor:pointer}',
    '.smm-sk-lbl{font-size:12px;font-weight:800;font-family:"IBM Plex Mono",monospace}',
    '.smm-sk-val{font-size:11px;font-weight:700;fill:var(--text)}',
    '.smm-sk-legend{display:flex;gap:14px;justify-content:center;font-size:12px;color:var(--text2);margin-top:8px;flex-wrap:wrap}',
    '.smm-sk-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px}',
    '#smmTT{position:fixed;z-index:9999;pointer-events:none;background:var(--card);border:1px solid var(--border);border-radius:10px;box-shadow:var(--shadow-card-lg);padding:8px 10px;font-size:12px;color:var(--text);display:none;max-width:280px;line-height:1.5}',
    /* insider */
    '.smm-ins-top{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(260px,1fr);gap:16px}',
    '.smm-ins-chart{position:relative;height:320px;border-radius:12px;overflow:hidden}',
    '.smm-ins-side{display:flex;flex-direction:column;gap:12px}',
    '.smm-box{background:var(--bg2);border-radius:12px;padding:12px}',
    '.smm-box h5{font-size:11px;font-weight:800;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;display:flex;justify-content:space-between;gap:6px}',
    '.smm-box h5 small{text-transform:none;letter-spacing:0;font-weight:600}',
    '.smm-rec-big{font-size:28px;font-weight:800;font-family:"IBM Plex Mono",monospace}',
    '.smm-rec-row{display:grid;grid-template-columns:70px 1fr 70px;gap:8px;align-items:center;font-size:12px;margin-top:6px}',
    '.smm-rec-row .bar{height:8px;border-radius:4px;background:var(--bg4);overflow:hidden}',
    '.smm-rec-row .bar i{display:block;height:100%;background:#2dd4bf;border-radius:4px}',
    '.smm-rec-row span:last-child{text-align:right;color:var(--text2);font-size:11px}',
    '.smm-ana{display:grid;grid-template-columns:1fr auto;gap:4px 10px;font-size:12px}',
    '.smm-ana span:nth-child(odd){color:var(--text2)}',
    '.smm-ana span:nth-child(even){text-align:right;font-weight:800;font-family:"IBM Plex Mono",monospace}',
    '.smm-months{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;margin-top:6px}',
    '.smm-months div{height:26px;border-radius:5px;background:var(--bg4);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text3);cursor:default}',
    '.smm-months.lbl div{height:auto;background:none}',
    '.smm-ins-mid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}',
    '.smm-ins-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:16px 0 8px}',
    '.smm-ins-filter .grow{flex:1}',
    '.smm-ftag{font-size:11px;font-weight:700;background:var(--accent);color:#fff;border-radius:999px;padding:4px 10px;cursor:pointer}',
    '.smm-tbl-wrap{overflow-x:auto}',
    '.smm-itbl td,.smm-itbl th{text-align:left;padding:8px 6px}',
    '.smm-itbl td{font-family:inherit}',
    '.smm-itbl .num{font-family:"IBM Plex Mono",monospace;text-align:right}',
    '.smm-itbl th.num{text-align:right}',
    '.smm-itbl tbody tr{cursor:pointer}',
    '.smm-itbl .nm{color:#8b5cf6;font-weight:700}',
    '[data-theme="dark"] .smm-itbl .nm{color:#c4a3ff}',
    '.smm-itbl .nm:hover{text-decoration:underline}',
    '.smm-itbl .sm{display:block;font-size:11px;color:var(--text3);font-family:"IBM Plex Mono",monospace}',
    '.smm-role{display:inline-block;margin-left:6px;font-size:10px;font-weight:700;padding:1px 6px;border-radius:5px;border:1px solid #c4b5fd;background:#f5f3ff;color:#6d28d9}',
    '[data-theme="dark"] .smm-role{background:rgba(196,163,255,.15);color:#c4a3ff;border-color:#6d28d9}',
    '.smm-act{font-weight:800}.smm-act.BUY{color:var(--green)}.smm-act.SELL{color:var(--red)}',
    '.smm-src{font-size:10px;font-weight:800;padding:1px 6px;border-radius:4px;background:var(--bg2);color:var(--text2)}',
    '.smm-itbl tr.hl td{background:color-mix(in srgb,var(--accent) 12%,transparent)}',
    /* glossary */
    '.smm-gloss{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}',
    '.smm-gloss div{background:var(--bg2);border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.5;color:var(--text2)}',
    '.smm-gloss b{display:block;color:var(--text);margin-bottom:2px}',
    '.smm-nav .smm-nav-ico{margin-right:2px}',
    '@media (max-width:1279px){.smm-nav .smm-nav-lbl{display:none}.smm-nav .smm-nav-ico{margin:0}}',
    '.smm-toast{position:fixed;left:50%;bottom:80px;transform:translateX(-50%);background:var(--text);color:var(--card);padding:8px 14px;border-radius:999px;font-size:12px;font-weight:700;z-index:9999;opacity:0;transition:opacity .2s;pointer-events:none}',
    '.smm-toast.show{opacity:1}',
    /* responsive */
    /* ── Layout 2 halaman (Broker Activity / Insider) ── */
    '.smm-wrap{gap:14px}',
    '.smm-head{display:block}',
    '.smm-head .smm-sub{margin-top:2px}',
    '.smm-bar{position:sticky;top:var(--smm-top,0px);z-index:40;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;margin:0 -4px;background:color-mix(in srgb,var(--bg) 88%,transparent);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid var(--border2);border-radius:14px}',
    '.smm-bar-pick{display:flex;gap:6px;align-items:center}',
    '.smm-subtabs{display:inline-flex;gap:4px;padding:4px;background:var(--bg2);border-radius:12px}',
    '.smm-subtabs button{font:inherit;font-size:14px;font-weight:800;padding:9px 18px;border:0;border-radius:9px;background:transparent;color:var(--text2);cursor:pointer;white-space:nowrap;transition:all .15s}',
    '.smm-subtabs button:hover{color:var(--accent)}',
    '.smm-subtabs button.on{background:var(--card);color:var(--accent);box-shadow:0 2px 8px rgba(0,0,0,.08)}',
    '.smm-subtabs .s{display:none}',
    '.smm-scroll{display:flex;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;-webkit-overflow-scrolling:touch}',
    '.smm-scroll::-webkit-scrollbar{display:none}',
    '.smm-filters{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
    '.smm-filters .smm-seg{gap:4px}',
    '.smm-filters .smm-seg button{flex-shrink:0;min-width:48px}',
    '.smm-pg{display:flex;flex-direction:column;gap:16px}',
    '.smm-pg[hidden]{display:none!important}',
    '.smm-searchwrap{position:relative;display:flex;min-width:0}',
    '#smmDrop{position:absolute;top:calc(100% + 6px);left:0;width:max(100%,380px);max-width:calc(100vw - 24px);background:var(--card);border:1px solid var(--border);border-radius:var(--radius);max-height:320px;overflow-y:auto;z-index:300;display:none;box-shadow:var(--shadow-card-lg);text-align:left}',
    '#smmDrop.open{display:block}',
    '#smmDrop .search-item{padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;transition:background .15s}',
    '#smmDrop .search-item:hover{background:var(--bg2)}',
    '#smmDrop .search-item .code{font-family:"IBM Plex Mono",monospace;font-weight:700;font-size:14px;color:var(--accent);width:60px;flex-shrink:0}',
    '#smmDrop .search-item .sname{font-size:13px;color:var(--text);font-weight:500;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '#smmDrop .search-item .sector{font-size:11px;color:var(--text2);margin-left:auto;flex-shrink:0;background:var(--bg2);padding:3px 10px;border-radius:999px;font-weight:600}',
    '#smmDrop .search-item .sector:empty{display:none}',
    '.smm-drop-h{padding:8px 14px 4px;font-size:10.5px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);border-top:1px solid var(--border2)}',
    '@media (max-width:640px){#smmDrop{width:100%}#smmDrop .search-item .sector{display:none}}',
    '.smm-flowrow{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(330px,1fr);gap:16px;align-items:stretch}',
    '.smm-calcard{display:flex;flex-direction:column;gap:8px}',
    '.smm-calcard:empty{display:none}',
    '.smm-calhead{display:flex;align-items:center;justify-content:space-between;gap:8px}',
    '.smm-calm{font-size:16px;font-weight:800;color:var(--text)}',
    '.smm-calnav{width:34px;height:34px;padding:0;font-size:18px;line-height:1}.smm-calnav:disabled{opacity:.3;cursor:default}',
    '.smm-calgrp{width:100%}',
    '.smm-calkpi{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
    '.smm-calkpi>div{display:flex;flex-direction:column;gap:2px;background:var(--bg2);border:1px solid var(--border2);border-radius:12px;padding:8px 12px;min-width:0}',
    '.smm-calkpi>div.g{background:linear-gradient(135deg,var(--green-bg),var(--bg2) 75%)}.smm-calkpi>div.r{background:linear-gradient(135deg,var(--red-bg),var(--bg2) 75%)}',
    '.smm-calkpi span{font-size:11px;color:var(--text3);font-weight:600}.smm-calkpi small{font-size:10.5px;color:var(--text3);font-family:"IBM Plex Mono",monospace}',
    '.smm-calkpi b{font-family:"IBM Plex Mono",monospace;font-size:16px;color:var(--text);line-height:1.25}.smm-calkpi b em{font-style:normal;color:var(--text3)}',
    '.smm-calsplit{display:block;height:5px;border-radius:3px;background:var(--red);overflow:hidden;margin-top:5px}.smm-calsplit i{display:block;height:100%;background:var(--green)}',
    '.smm-calext{display:flex;flex-wrap:wrap;gap:6px}.smm-calext span{font-size:11px;padding:4px 10px;border-radius:999px;color:var(--text2);background:var(--bg2)}',
    '.smm-calext .g{background:var(--green-bg)}.smm-calext .r{background:var(--red-bg)}.smm-calext b{font-family:"IBM Plex Mono",monospace}.smm-calext .g b{color:var(--green)}.smm-calext .r b{color:var(--red)}',
    '.smm-cal{flex:1;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));grid-template-rows:auto;grid-auto-rows:minmax(72px,1fr);gap:6px}',
    '.smm-cc .mt small:first-child::after{content:" lot";color:var(--text3)}',
    '.smm-ch{text-align:center;font-size:10.5px;font-weight:800;color:var(--text3);letter-spacing:.08em;text-transform:uppercase;align-self:end;padding-bottom:2px}',
    '.smm-cc{position:relative;display:flex;flex-direction:column;justify-content:space-between;gap:2px;padding:7px 8px 7px;border-radius:12px;border:1px solid var(--border2);background:var(--bg2);font:inherit;text-align:left;min-width:0;overflow:hidden;color:var(--text)}',
    'button.smm-cc{cursor:pointer;transition:transform .12s,box-shadow .15s}button.smm-cc:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,.2)}',
    '.smm-cc .top{display:flex;justify-content:space-between;align-items:center}',
    '.smm-cc .dn{font-size:11px;font-weight:700;color:var(--text3);font-family:"IBM Plex Mono",monospace}',
    '.smm-cc .ar{font-style:normal;font-size:8px;width:16px;height:16px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center}',
    '.smm-cc .nv{font-family:"IBM Plex Mono",monospace;font-size:clamp(11px,1.05vw,14px);font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.02em}',
    '.smm-cc .mt{display:flex;justify-content:space-between;gap:4px;min-width:0}',
    '.smm-cc .mt small{font-family:"IBM Plex Mono",monospace;font-size:9.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.smm-cc .mt .px{color:var(--text3)}',
    '.smm-cc .bar{display:block;height:3px;border-radius:2px;background:color-mix(in srgb,var(--text3) 22%,transparent);overflow:hidden}.smm-cc .bar i{display:block;height:100%;width:var(--w);border-radius:2px}',
    '.smm-cc.g{background:color-mix(in srgb,#16a34a calc(var(--a) * 55%),var(--bg2));border-color:color-mix(in srgb,#22c55e calc(var(--a) * 90% + 10%),var(--border2))}',
    '.smm-cc.r{background:color-mix(in srgb,#dc2626 calc(var(--a) * 55%),var(--bg2));border-color:color-mix(in srgb,#ef4444 calc(var(--a) * 90% + 10%),var(--border2))}',
    '.smm-cc.g .nv{color:#15803d}.smm-cc.r .nv{color:#b91c1c}.smm-cc.g .ar{background:var(--green-bg);color:var(--green)}.smm-cc.r .ar{background:var(--red-bg);color:var(--red)}',
    '.smm-cc.g .bar i{background:var(--green)}.smm-cc.r .bar i{background:var(--red)}',
    '.smm-cc.hot.g{box-shadow:inset 0 0 0 1px color-mix(in srgb,#22c55e 60%,transparent)}.smm-cc.hot.r{box-shadow:inset 0 0 0 1px color-mix(in srgb,#ef4444 60%,transparent)}',
    '[data-theme="dark"] .smm-cc.g .nv{color:#4ade80}[data-theme="dark"] .smm-cc.r .nv{color:#fda4af}[data-theme="dark"] .smm-cc .mt small{color:#d4cdee}[data-theme="dark"] .smm-cc .mt .px{color:#a99fcf}',
    '.smm-cc .nt{font-size:9.5px;color:var(--text3);margin:auto 0;text-align:center;line-height:1.3}',
    '.smm-cc.out{opacity:.25;background:transparent;border-style:dashed}.smm-cc.fut{opacity:.4;background:transparent;border-style:dashed}',
    '.smm-cc.off,.smm-cc.zero{background:repeating-linear-gradient(135deg,transparent 0 6px,color-mix(in srgb,var(--text3) 9%,transparent) 6px 7px),var(--bg2)}',
    '.smm-cc.sel{outline:2px solid var(--accent);outline-offset:1px;box-shadow:0 0 0 4px color-mix(in srgb,var(--accent) 22%,transparent)}',
    '.smm-callg{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;font-size:10.5px;color:var(--text3)}.smm-callg>span{display:inline-flex;align-items:center;gap:2px}',
    '.smm-callg i{display:inline-block;width:14px;height:10px;border-radius:3px}.smm-callg small{margin-left:auto}',
    '.smm-callg i.r{background:#dc2626}.smm-callg i.r2{background:color-mix(in srgb,#dc2626 40%,var(--bg2))}.smm-callg i.n{background:var(--bg2);border:1px solid var(--border2)}.smm-callg i.g2{background:color-mix(in srgb,#16a34a 40%,var(--bg2))}.smm-callg i.g{background:#16a34a}',
    '#page-smartmoney[data-smm-sub="screener"] #smmActive{display:none!important}',
    '.smm-empty{display:none;text-align:center;padding:28px 16px;font-size:13px;color:var(--text2);line-height:1.7}',
    '.smm-pg.is-empty>.smm-empty{display:block}',
    '.smm-pg.is-empty>*:not(.smm-empty):not(#smmRadarCard):not(#smmBkProfile):not(#smmPersonCard){display:none!important}',
    '.smm-badge.real{background:var(--green-bg);color:var(--green);border:1px solid var(--green)}',
    '.smm-sum{grid-template-columns:minmax(300px,1.35fr) repeat(3,minmax(0,1fr))}',
    '.smm-ins-sum{display:grid;grid-template-columns:minmax(300px,1.4fr) repeat(3,minmax(0,1fr));gap:12px}',
    '.smm-ins-sum .smm-verdict .big{font-size:22px}',
    '.smm-kpi{display:flex;flex-direction:column}',
    '.smm-kpi .pill{align-self:flex-start}',
    '.smm-kpi-link{cursor:pointer;transition:transform .15s,border-color .15s}',
    '.smm-kpi-link:hover{border-color:var(--accent);transform:translateY(-2px)}',
    '.smm-go{margin-top:auto;padding-top:8px;font-size:12px;font-weight:800;color:var(--accent)}',
    '.smm-grid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}',
    '.smm-chart{height:440px}',
    '.smm-sk-hint{font-size:12px;color:var(--text3);margin:8px 0 0}',
    '.smm-ins-chart{height:270px}',
    '.smm-hocols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px;align-items:stretch}',
    '.smm-hocol{display:flex;flex-direction:column;gap:16px;min-width:0}',
    '.smm-fill{flex:1 1 auto}',
    '.smm-ins-mid>.smm-box{display:flex;flex-direction:column}',
    '.smm-ins-foot{margin-top:auto;padding-top:10px;border-top:1px dashed var(--border2)}',
    '.smm-ins-row{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:stretch}',
    '.smm-ins-sidewrap{position:relative;min-height:240px}',
    '.smm-ins-side2{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden}',
    '.smm-ins-list{flex:1 1 auto;min-height:0;overflow-y:auto;margin:0 -6px;padding:0 6px;scrollbar-width:thin}',
    '.smm-ins-mid{grid-template-columns:repeat(3,minmax(0,1fr))!important;align-items:stretch}',
    '#smmInsYear{grid-column:1/-1!important;order:4}',
    '.smm-ins-mid .smm-desc,.smm-ins-mid .smm-note{margin-top:auto}',
    '.smm-ins-legend{font-size:12px}',
    '.smm-ins-mid{grid-template-columns:repeat(3,minmax(0,1fr));margin-top:0}',
    '#smmInsYear{grid-column:span 2}',
    '.smm-box{background:var(--card);border:1px solid var(--border);box-shadow:var(--shadow-card);padding:14px}',
    '.smm-glossary summary{cursor:pointer;font-weight:800;font-size:14px;color:var(--text);list-style:none}',
    '.smm-glossary summary::-webkit-details-marker{display:none}',
    '.smm-glossary summary::after{content:"▾";float:right;color:var(--text3)}',
    '.smm-glossary[open] summary{margin-bottom:12px}',
    '.smm-glossary[open] summary::after{content:"▴"}',
    '.smm-icards{display:none;flex-direction:column;gap:8px}',
    '.smm-icard{border:1px solid var(--border2);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:5px;font-size:12px;cursor:pointer}',
    '.smm-icard.hl{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}',
    '.smm-icard .r1{display:flex;align-items:center;gap:8px}',
    '.smm-icard .r1 .d{margin-left:auto;color:var(--text3);font-size:11px}',
    '.smm-icard .r2 .nm{color:var(--accent);font-weight:700}',
    '.smm-icard .r3{display:flex;justify-content:space-between;gap:8px;color:var(--text2);font-family:"IBM Plex Mono",monospace;font-size:11px}',
    '.smm-icard .r4{display:flex;gap:4px;flex-wrap:wrap}',
    '.smm-ins-filter{margin:4px 0 10px}',
    /* ── Pencarian, filter aktif, profil ── */
    '.smm-input.smm-search{width:240px;text-transform:none;font-family:inherit;font-weight:700}',
    '.smm-input.smm-search::placeholder{font-weight:500;color:var(--text3)}',
    '.smm-active{display:flex;gap:6px;flex-wrap:wrap}',
    '.smm-active[hidden]{display:none}',
    '.smm-ftag2{display:inline-flex;align-items:center;gap:6px;padding:6px 6px 6px 12px;border-radius:999px;background:color-mix(in srgb,var(--accent) 14%,transparent);border:1px solid var(--accent);color:var(--text);font-size:12px;cursor:pointer}',
    '.smm-ftag2 .x{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--card);color:var(--text2);font-size:14px;line-height:1}',
    '.smm-ftag2 .x:hover{color:var(--red)}',
    '.smm-profile{border:1.5px solid var(--accent);background:linear-gradient(180deg,color-mix(in srgb,var(--accent) 7%,var(--card)),var(--card) 60%)}',
    '.smm-profile[hidden]{display:none}',
    '.smm-bkkpi{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:8px}',
    '.smm-bkkpi div{background:var(--bg2);border-radius:10px;padding:8px 10px;font-size:11px;color:var(--text3)}',
    '.smm-bkkpi b{display:block;font-size:14px;color:var(--text);font-family:"IBM Plex Mono",monospace;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.smm-bkkpi b small{font-size:11px;color:var(--text3)}',
    '.smm-dvhead,.smm-dvrow{display:grid;grid-template-columns:56px minmax(0,1fr) 84px 110px 56px;gap:8px;align-items:center;padding:5px 8px;font-size:12px}',
    '.smm-dvhead{font-size:10px;color:var(--text3);font-weight:700;text-transform:uppercase}',
    '.smm-dvhead span:nth-child(2){text-align:center}.smm-dvhead span:nth-child(n+3){text-align:right}',
    '.smm-dvrow{border-radius:8px;cursor:pointer}.smm-dvrow:hover{background:var(--bg2)}.smm-dvrow.on{outline:1px solid var(--accent);background:var(--bg2)}',
    '.smm-dvrow .c{font-family:"IBM Plex Mono",monospace;font-weight:800;color:var(--accent)}',
    '.smm-dvrow .n{text-align:right;font-family:"IBM Plex Mono",monospace;font-size:11px;white-space:nowrap}',
    '.smm-dvrow .dv{position:relative;height:12px;background:linear-gradient(90deg,transparent calc(50% - 1px),var(--border) calc(50% - 1px),var(--border) calc(50% + 1px),transparent calc(50% + 1px))}',
    '.smm-dvrow .dv i{position:absolute;top:1px;height:10px;border-radius:3px}',
    '.smm-dvrow .dv i.p{left:50%;background:var(--green)}.smm-dvrow .dv i.n{right:50%;background:var(--red)}',
    '.smm-pchips{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}',
    '.smm-pchip{font:inherit;font-size:11px;padding:5px 10px;border-radius:999px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer}',
    '.smm-pchip b{color:var(--accent);font-family:"IBM Plex Mono",monospace}',
    '.smm-pchip.on,.smm-pchip:hover{border-color:var(--accent)}',
    '.smm-ptbl tbody tr{cursor:pointer}.smm-ptbl tr.hl td{background:color-mix(in srgb,var(--accent) 10%,transparent)}',
    '.smm-ptbl td,.smm-ptbl th{text-align:left}',
    '.smm-name{font:inherit;font-weight:700;color:var(--accent);background:none;border:0;padding:0;cursor:pointer;text-align:left}',
    '.smm-name:hover{text-decoration:underline}',
    '.smm-plain{font-weight:600;color:var(--text2)}',
    '.smm-new{font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;background:var(--yellow-bg);color:var(--yellow);vertical-align:1px}',
    '.smm-mute{color:var(--text3)}',
    '.smm-tbl td.bkc.on{background:color-mix(in srgb,var(--accent) 18%,transparent);border-radius:4px}',
    /* ── Kepemilikan ── */
    '.smm-months-seg{gap:4px;margin:4px 0 10px}',
    '.smm-months-seg button{flex-shrink:0;min-width:54px;border-radius:8px}',
    '.smm-hobar{display:flex;height:22px;border-radius:8px;overflow:hidden;gap:2px;background:var(--bg2)}',
    '.smm-hobar i{display:block;height:100%;min-width:2px;cursor:default;transition:filter .15s}',
    '.smm-hobar i:hover{filter:brightness(1.15)}',
    '.smm-hotbl td,.smm-hotbl th{text-align:right}',
    '.smm-hotbl td:first-child,.smm-hotbl th:first-child{text-align:left}',
    '.smm-hotbl td.nmcol{white-space:normal;min-width:180px;font-family:inherit}',
    '.smm-hotbl td.tx{font-family:inherit;color:var(--text2)}',
    '.smm-hotbl tfoot td{font-weight:800;border-top:1px solid var(--border2);padding-top:8px}',
    '.smm-hotbl .sm{display:block;font-size:10px}',
    '.smm-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}',
    '.smm-spark{display:block;margin-left:auto}',
    '.smm-comp-top{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border:1px solid var(--border2);border-radius:10px 10px 0 0;font-size:12px;font-weight:700}',
    '.smm-comp-top b{font-family:"IBM Plex Mono",monospace;font-size:14px}',
    '.smm-comp-splits{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--border2);border-top:0;border-radius:0 0 10px 10px;margin-bottom:12px}',
    '.smm-split{padding:10px 12px}.smm-split+.smm-split{border-left:1px solid var(--border2)}',
    '.smm-split .hd,.smm-split .ft{display:flex;justify-content:space-between;font-size:12px;gap:6px}',
    '.smm-split .ft{font-size:11px;color:var(--text3);font-family:"IBM Plex Mono",monospace}',
    '.smm-split .br{display:flex;gap:2px;height:8px;border-radius:4px;overflow:hidden;margin:6px 0;background:var(--bg3)}',
    '.smm-split .br i{display:block;height:100%}',
    '.smm-cats{display:flex;flex-direction:column;gap:10px}',
    '.smm-cat .hd{display:flex;justify-content:space-between;gap:8px;font-size:12px;margin-bottom:4px}',
    '.smm-cat .hd i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}',
    '.smm-cat .hd small{color:var(--text3);margin-left:4px;font-family:"IBM Plex Mono",monospace}',
    '.smm-cat .br{height:6px;border-radius:3px;background:var(--bg3);overflow:hidden}',
    '.smm-cat .br i{display:block;height:100%;border-radius:3px}',
    '.smm-hokpi{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:10px 0}',
    '.smm-hokpi div{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border2);border-radius:8px;padding:6px 10px;font-size:12px}',
    '.smm-hokpi b{font-family:"IBM Plex Mono",monospace}',
    '.smm-stack{display:grid;grid-template-columns:34px minmax(0,1fr);gap:6px;height:260px}',
    '.smm-stack .ax{display:flex;flex-direction:column;justify-content:space-between;font-size:10px;color:var(--text3);padding-bottom:18px;text-align:right}',
    '.smm-stack .cols{display:flex;gap:4px;align-items:stretch}',
    '.smm-stack .col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;cursor:default}',
    '.smm-stack .stk{flex:1;width:100%;display:flex;flex-direction:column;border-radius:4px 4px 0 0;overflow:hidden;background:var(--bg3)}',
    '.smm-stack .stk i{display:block;width:100%}',
    '.smm-stack .col:hover .stk{filter:brightness(1.12)}',
    '.smm-stack .col span{font-size:9px;color:var(--text3);white-space:nowrap;overflow:hidden;max-width:100%;text-align:center}',
    '.smm-hsec+.smm-hsec{margin-top:14px;padding-top:12px;border-top:1px solid var(--border2)}',
    '.smm-hhead,.smm-hrow{display:grid;grid-template-columns:minmax(0,1fr) 80px 76px;gap:8px;align-items:center}',
    '.smm-hhead{font-size:12px;font-weight:800;color:var(--text);margin-bottom:6px}',
    '.smm-hhead span:nth-child(n+2){text-align:right;font-size:11px;color:var(--text3);font-weight:700}',
    '.smm-hrow{padding:6px 0;font-size:12px;border-bottom:1px dashed var(--border2)}',
    '.smm-hrow span:nth-child(n+2),.smm-hrow b{text-align:right}',
    '.smm-tag{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:5px;border:1px solid var(--border);color:var(--text2);margin-left:4px}',
    '.smm-tag.ctl{border-color:#60a5fa;color:#2563eb;background:rgba(96,165,250,.12)}',
    '.smm-tag.dir{border-color:#34d399;color:#059669;background:rgba(52,211,153,.12)}',
    '.smm-tag.kom{border-color:#c4b5fd;color:#7c3aed;background:rgba(196,181,253,.15)}',
    '.smm-tag.trs{border-color:#fbbf24;color:#b45309;background:rgba(251,191,36,.12)}',
    '[data-theme="dark"] .smm-tag.ctl{color:#93c5fd}[data-theme="dark"] .smm-tag.dir{color:#6ee7b7}[data-theme="dark"] .smm-tag.kom{color:#c4b5fd}[data-theme="dark"] .smm-tag.trs{color:#fcd34d}',
    '.smm-ubo{padding:6px 0;font-size:12px;border-bottom:1px dashed var(--border2)}',
    '.smm-ubo .via{display:flex;justify-content:space-between;gap:8px;color:var(--text2);margin-top:2px;padding-left:6px}',
    '.smm-ubo small{color:var(--text3)}',
    '.smm-cbig b{font-size:26px;font-family:"IBM Plex Mono",monospace}.smm-cbig small{color:var(--text3);margin-left:4px}',
    '.smm-cbars{display:flex;align-items:flex-end;gap:3px;height:110px;margin-top:10px}',
    '.smm-cbars i{flex:1;border-radius:3px 3px 0 0;min-height:4px;opacity:.85;cursor:default}',
    '.smm-cbars i:hover{opacity:1}',
    '.smm-cax{display:flex;justify-content:space-between;font-size:10px;color:var(--text3);margin-top:4px}',
    '.smm-clist{margin-top:10px;max-height:300px;overflow:auto}',
    '.smm-crow{display:flex;justify-content:space-between;padding:7px 2px;font-size:12px;border-bottom:1px solid var(--border2)}',
    '.smm-kv{display:grid;grid-template-columns:140px 1fr;gap:10px;padding:7px 0;font-size:12px;border-bottom:1px solid var(--border2)}',
    '.smm-kv span:first-child{color:var(--text2)}.smm-kv span:last-child{text-align:right;font-weight:700;line-height:1.6}',
    '.smm-kv .smm-name{text-align:right}',
    /* ── Kepemilikan v2 ── */
    '.smm-pill{display:inline-flex;align-items:center;font-family:"IBM Plex Mono",monospace;font-size:10.5px;font-weight:800;padding:2px 7px;border-radius:999px;white-space:nowrap;background:var(--bg2);color:var(--text3)}',
    '.smm-pill.u{background:var(--green-bg);color:var(--green)}.smm-pill.d{background:var(--red-bg);color:var(--red)}',
    '.smm-hov{display:flex;gap:14px;align-items:flex-start}',
    '.smm-hov-ico{font-size:30px;line-height:1;width:54px;height:54px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--card) 70%,transparent);border:1px solid var(--border2);flex-shrink:0}',
    '.smm-hov-b{min-width:0;flex:1}',
    '.smm-hof{list-style:none;margin:10px 0 6px;padding:0;display:flex;flex-direction:column;gap:5px}',
    '.smm-hof li{display:grid;grid-template-columns:20px 70px 1fr auto;gap:8px;align-items:center;font-size:12px;padding:5px 8px;border-radius:9px;background:color-mix(in srgb,var(--card) 60%,transparent)}',
    '.smm-hof li i{font-style:normal;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;background:var(--bg3);color:var(--text2)}',
    '.smm-hof li.g i{background:var(--green-bg);color:var(--green)}.smm-hof li.b i{background:var(--yellow-bg);color:var(--yellow)}',
    '.smm-hof li span{color:var(--text2)}.smm-hof li b{font-family:"IBM Plex Mono",monospace;color:var(--text)}',
    '.smm-kpi .smm-pill,.smm-hof .smm-pill{align-self:flex-start;justify-self:end}',
    '.smm-hok .sp{margin:8px 0 2px}.smm-hok .sp svg{width:100%;height:30px}',
    '.smm-hok-r{display:flex;align-items:center;gap:10px;margin-top:8px}.smm-hok-r .v{margin:0}.smm-hok-r .v.sm{font-size:17px}.smm-hok-r small{display:block;font-size:11px}',
    '.smm-ring{flex-shrink:0}',
    '.smm-hobar{height:28px;border-radius:10px}',
    '.smm-hleg{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:11.5px;color:var(--text2);margin:8px 0 4px}',
    '.smm-hleg i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:5px}.smm-hleg b{color:var(--text);font-family:"IBM Plex Mono",monospace}',
    '.smm-hchips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 4px}',
    '.smm-hchips .c{font-size:11.5px;font-weight:800;padding:4px 10px;border-radius:999px;background:var(--bg2);color:var(--text2)}',
    '.smm-hchips .c.u{background:var(--green-bg);color:var(--green)}.smm-hchips .c.d{background:var(--red-bg);color:var(--red)}.smm-hchips .c.p{background:var(--yellow-bg);color:var(--yellow)}.smm-hchips .c.x{background:var(--red-bg);color:var(--red);opacity:.8}.smm-hchips .c.n{font-weight:600}',
    '.smm-hms{display:flex;flex-direction:column;gap:6px;margin-top:6px}',
    '.smm-hm{display:grid;grid-template-columns:30px minmax(0,1fr) 120px 100px;gap:12px;align-items:center;padding:10px 12px;border-radius:12px;border:1px solid var(--border2);background:var(--bg2);border-left:4px solid var(--c)}',
    '.smm-hm.up{background:linear-gradient(90deg,var(--green-bg),var(--bg2) 55%)}.smm-hm.dn{background:linear-gradient(90deg,var(--red-bg),var(--bg2) 55%)}.smm-hm.gone{opacity:.7;border-style:dashed}',
    '.smm-hm .rk{width:26px;height:26px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;background:var(--c)}',
    '.smm-hm .t{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:13px}',
    '.smm-hm .pb{height:6px;border-radius:3px;background:var(--bg3);margin:6px 0 5px;overflow:hidden}.smm-hm .pb i{display:block;height:100%;border-radius:3px;background:var(--c)}',
    '.smm-hm .mt{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11px;color:var(--text3);font-family:"IBM Plex Mono",monospace}.smm-hm .mt em{font-style:normal}',
    '.smm-hm .pc{display:flex;flex-direction:column;align-items:flex-end;gap:3px}.smm-hm .pc b{font-family:"IBM Plex Mono",monospace;font-size:17px;color:var(--text)}.smm-hm .pc small{font-size:10.5px;color:var(--text3)}',
    '.smm-hm .sk{display:flex;flex-direction:column;align-items:flex-end;gap:2px}.smm-hm .sk small{font-size:9.5px;color:var(--text3)}',
    '.smm-htot{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;margin-top:8px;padding:10px 14px;border-radius:12px;background:color-mix(in srgb,var(--accent) 10%,var(--card));border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);font-size:12px;font-family:"IBM Plex Mono",monospace;color:var(--text2)}',
    '.smm-htot>b:first-child{font-family:inherit;color:var(--text);margin-right:auto}.smm-htot span b{color:var(--accent);font-size:14px}',
    '.smm-hcomp{display:grid;grid-template-columns:150px minmax(0,1fr);gap:16px;align-items:center;margin:4px 0 12px}',
    '.smm-donut .c1{font-size:11px;font-weight:800;fill:var(--text);font-family:"IBM Plex Mono",monospace}.smm-donut .c2{font-size:7px;fill:var(--text3)}',
    '.smm-donut circle[data-smm-tip]{cursor:default;transition:stroke-width .15s}.smm-donut circle[data-smm-tip]:hover{stroke-width:17}',
    '.smm-hcomp .lg{display:flex;flex-direction:column;gap:4px;min-width:0}',
    '.smm-hcomp .r{display:grid;grid-template-columns:10px minmax(0,1fr) auto auto;gap:8px;align-items:center;font-size:12px;padding:4px 6px;border-radius:8px}',
    '.smm-hcomp .r:hover{background:var(--bg2)}.smm-hcomp .r i{width:10px;height:10px;border-radius:3px}',
    '.smm-hcomp .r .l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}.smm-hcomp .r .l small{margin-left:6px;color:var(--text3);font-family:"IBM Plex Mono",monospace;font-size:10.5px}',
    '.smm-hcomp .r b{font-family:"IBM Plex Mono",monospace}',
    '.smm-vs{padding:10px 12px;border-radius:12px;background:var(--bg2);margin-bottom:8px}',
    '.smm-vs .hd,.smm-vs .ft{display:flex;justify-content:space-between;gap:8px;font-size:12px}.smm-vs .hd{font-weight:700;color:var(--text)}',
    '.smm-vs .ft{font-size:11px;color:var(--text3);font-family:"IBM Plex Mono",monospace}',
    '.smm-vs .br{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:6px 0;gap:2px}.smm-vs .br i{display:block;height:100%}',
    '.smm-hl{display:block;width:100%;height:auto;overflow:visible}',
    '.smm-hl .gl{stroke:var(--border2);stroke-dasharray:3 4;vector-effect:non-scaling-stroke}',
    '.smm-hl text{font-family:"IBM Plex Mono",monospace;font-size:10px;fill:var(--text3)}.smm-hl .lv{font-weight:800;font-size:11px}',
    '.smm-hct{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;margin:4px 0 6px}.smm-hct small{font-size:11px}',
    '.smm-hct2{font-size:10.5px;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:8px 0 2px}',
    '.smm-hd{display:flex;gap:3px;align-items:stretch;background:linear-gradient(transparent calc(50% - .5px),var(--border) calc(50% - .5px),var(--border) calc(50% + .5px),transparent calc(50% + .5px))}',
    '.smm-hd span{flex:1;position:relative;cursor:default}.smm-hd i{position:absolute;left:12%;right:12%;border-radius:2px}',
    '.smm-hd i.u{bottom:50%;background:var(--green)}.smm-hd i.d{top:50%;background:var(--red)}.smm-hd i.z{top:calc(50% - .5px);background:var(--text3)}',
    '.smm-hmon{display:flex;gap:3px;font-size:9.5px;color:var(--text3);margin-top:3px}.smm-hmon span{flex:1;text-align:center}',
    '.smm-hcats{display:flex;flex-direction:column;gap:4px}',
    '.smm-hcats .r{display:grid;grid-template-columns:minmax(0,1fr) 110px 62px 74px;gap:10px;align-items:center;padding:6px 8px;border-radius:9px;background:var(--bg2);font-size:12px}',
    '.smm-hcats .r .l{display:flex;align-items:center;gap:7px;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.smm-hcats .r .l i{width:10px;height:10px;border-radius:3px;flex-shrink:0}',
    '.smm-hcats .r b{text-align:right;font-family:"IBM Plex Mono",monospace}.smm-hcats .r .smm-pill{justify-self:end}.smm-hcats .r svg{width:110px}',
    '.smm-hmap{display:flex;height:34px;border-radius:10px;overflow:hidden;gap:2px;background:var(--bg2);margin-bottom:4px}.smm-hmap i{display:block;height:100%;min-width:2px}',
    '.smm-hhead2{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12.5px;font-weight:800;color:var(--text);margin-bottom:6px}.smm-hhead2 span:last-child{font-size:10.5px;color:var(--text3);font-weight:700}',
    '.smm-hh{padding:7px 0;border-bottom:1px dashed var(--border2)}',
    '.smm-hh .t{display:flex;align-items:center;gap:4px;flex-wrap:wrap;font-size:12.5px;float:left;max-width:62%}',
    '.smm-hh .v{display:flex;justify-content:flex-end;gap:14px;font-size:12px;align-items:baseline}.smm-hh .v span{color:var(--text3);font-size:11px}',
    '.smm-hh .pb{clear:both;height:5px;border-radius:3px;background:var(--bg3);margin-top:6px;overflow:hidden}.smm-hh .pb i{display:block;height:100%;background:var(--c);border-radius:3px}',
    '.smm-hp{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:10px;align-items:center;padding:7px 0;border-bottom:1px dashed var(--border2)}',
    '.smm-hp .t{display:flex;flex-direction:column;min-width:0;font-size:12.5px}.smm-hp .t small{font-size:10.5px;color:var(--text3)}',
    '.smm-hp .v{display:flex;flex-direction:column;align-items:flex-end;font-size:11px;color:var(--text3)}.smm-hp .v b{font-size:12.5px;color:var(--text)}',
    '.smm-av{width:32px;height:32px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;flex-shrink:0;background:var(--bg3);color:var(--text)}',
    '.smm-av.dir{background:rgba(52,211,153,.18);color:#059669}.smm-av.kom{background:rgba(196,181,253,.22);color:#7c3aed}',
    '[data-theme="dark"] .smm-av.dir{color:#6ee7b7}[data-theme="dark"] .smm-av.kom{color:#c4b5fd}',
    '.smm-chain{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 0;border-bottom:1px dashed var(--border2);font-size:12px}',
    '.smm-chain .nd{display:inline-flex;align-items:center;gap:6px;padding:6px 10px;border-radius:10px;background:var(--bg2);border:1px solid var(--border2);min-width:0}',
    '.smm-chain .nd i{font-style:normal}.smm-chain .nd small{display:block;font-size:10px;color:var(--text3);margin-left:4px}',
    '.smm-chain .nd.s{background:color-mix(in srgb,var(--accent) 12%,var(--card));border-color:color-mix(in srgb,var(--accent) 40%,transparent)}.smm-chain .nd.s em{font-style:normal;font-family:"IBM Plex Mono",monospace;font-weight:800;color:var(--accent)}',
    '.smm-chain .ar{color:var(--text3);font-weight:800}',
    '.smm-ckv{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.smm-ckv span{font-size:11.5px;padding:4px 10px;border-radius:999px;background:var(--bg2);color:var(--text2)}.smm-ckv b{font-family:"IBM Plex Mono",monospace}',
    '.smm-cbig{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
    '.smm-clist2{margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;max-height:none}',
    '.smm-crow2{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;font-size:11.5px;padding:6px 8px;border-radius:8px;background:var(--bg2)}.smm-crow2 span{color:var(--text2)}',
    '.smm-h3 small{font-size:11px;font-weight:600;color:var(--text3)}',
    '.smm-brole{padding:8px 0;border-bottom:1px dashed var(--border2)}.smm-brole>small{display:block;font-size:10.5px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}',
    '.smm-brole>div{display:flex;flex-wrap:wrap;gap:6px}',
    '.smm-bp{display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 4px;border-radius:999px;background:var(--bg2);border:1px solid var(--border2);font-size:12.5px}.smm-bp .smm-av{width:26px;height:26px;font-size:10px}',
    '.smm-tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:8px}',
    '.smm-tiles .tl{display:grid;grid-template-columns:auto 1fr;grid-template-rows:auto auto;column-gap:10px;align-items:center;padding:10px 12px;border-radius:12px;background:var(--bg2);border:1px solid var(--border2);min-width:0}',
    '.smm-tiles .tl>i,.smm-tiles .tl>svg{grid-row:1/3;font-style:normal;font-size:20px}',
    '.smm-tiles .tl span{font-size:10.5px;color:var(--text3);font-weight:700}.smm-tiles .tl b{font-size:13px;color:var(--text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.smm-uw{margin-top:10px}.smm-uw>small{display:block;font-size:10.5px;color:var(--text3);font-weight:700;margin-bottom:6px}',
    '.smm-uw>div{display:flex;flex-wrap:wrap;gap:6px}.smm-uw span{font-size:12px;font-weight:700;padding:5px 10px;border-radius:8px;background:var(--bg2);border:1px solid var(--border2);color:var(--text)}',
    '@media (max-width:640px){',
      '.smm-hm{grid-template-columns:26px minmax(0,1fr) auto;gap:8px;padding:9px 10px}.smm-hm .sk{display:none}.smm-hm .pc b{font-size:15px}',
      '.smm-hcomp{grid-template-columns:1fr;justify-items:center}.smm-hcomp .lg{width:100%}',
      '.smm-hcats .r{grid-template-columns:minmax(0,1fr) 54px auto}.smm-hcats .r svg{display:none}',
      '.smm-hov{flex-direction:column}.smm-hof li{grid-template-columns:20px 64px 1fr auto}',
      '.smm-clist2{grid-template-columns:1fr}.smm-tiles{grid-template-columns:1fr 1fr}.smm-hh .t{max-width:58%}',
    '}',
    /* Tablet */
    '@media (max-width:1099px){',
      '.smm-input.smm-search{width:200px}',
      '.smm-sum{grid-template-columns:repeat(3,minmax(0,1fr))}.smm-sum .smm-verdict{grid-column:1/-1}',
      '.smm-ins-sum{grid-template-columns:repeat(3,minmax(0,1fr))}.smm-ins-sum .smm-verdict{grid-column:1/-1}',
      '.smm-grid{grid-template-columns:1fr}',
      '.smm-flowrow{grid-template-columns:1fr}.smm-cal{grid-auto-rows:minmax(74px,auto)}.smm-cc .nv{font-size:14px}',
      '.smm-ins-row{grid-template-columns:minmax(0,1fr) 280px}',
      '.smm-hocols{display:flex;flex-direction:column}.smm-hocol{display:contents}',
      '#smmHoCompCard{order:1}#smmHoChartCard{order:2}#smmHoHoldersCard{order:3}#smmHoCountCard{order:4}#smmHoBoard{order:5}#smmHoCompany{order:6}',
      '.smm-ins-chart{height:250px}',
      '.smm-chart{height:400px}',
    '}',
    /* HP */
    '@media (max-width:640px){',
      '#page-smartmoney{padding:10px 10px 96px}',
      '.smm-wrap{gap:12px}',
      '.smm-title h2{font-size:19px}.smm-sub{font-size:12px}',
      '.smm-bar{padding:8px;gap:6px;margin:0;border-radius:12px}',
      '.smm-input{width:76px;padding:8px;font-size:13px}',
      '.smm-bar .smm-btn{padding:8px 10px}',
      '.smm-subtabs button{padding:8px 10px;font-size:13px}',
      '.smm-subtabs .l{display:none}.smm-subtabs .s{display:inline}',
      '.smm-filters{flex-wrap:nowrap}.smm-filters .smm-seg{flex:1;min-width:0}.smm-filters .smm-seg button{min-width:42px;padding:7px 10px}',
      '.smm-filters .smm-sel{flex-shrink:0;max-width:130px}',
      '.smm-card{padding:12px;border-radius:12px}',
      '.smm-sum,.smm-ins-sum{grid-template-columns:1fr 1fr;gap:8px}',
      '.smm-sum .smm-kpi:nth-child(2){grid-column:1/-1}',
      '.smm-ins-sum .smm-kpi:last-child{grid-column:1/-1}',
      '.smm-kpi .v{font-size:17px}.smm-kpi p{font-size:11px}',
      '.smm-verdict{flex-direction:row;align-items:center;gap:10px}.smm-gauge{width:110px}.smm-verdict .big{font-size:17px}.smm-verdict ul{font-size:11px}',
      '.smm-chart{height:320px}.smm-ins-chart{height:220px}',
      '.smm-cal{gap:4px;grid-auto-rows:minmax(60px,auto)}.smm-cc{padding:5px 5px 6px;border-radius:9px}.smm-cc .nv{font-size:11px}.smm-cc .mt .px{display:none}.smm-cc .mt small{font-size:8.5px}.smm-cc .ar{display:none}.smm-cc .nt{font-size:8.5px}.smm-callg small{display:none}',
      '.smm-legend{font-size:10.5px;min-height:44px;padding:5px 8px}',
      '.smm-radar-cols{grid-template-columns:1fr}',
      '.smm-rrow,.smm-rhead{grid-template-columns:50px 1fr 78px 56px}',
      '.smm-ins-mid{grid-template-columns:1fr!important}',
      '.smm-ins-row{grid-template-columns:1fr}.smm-ins-sidewrap{min-height:0}.smm-ins-side2{position:static;max-height:360px}',
      '.smm-ins-desk{display:none}.smm-icards{display:flex}',
      '.smm-tbl{font-size:11px}.smm-tbl td,.smm-tbl th{padding:6px 3px}',
      '.smm-totals{grid-template-columns:1fr 1fr 1fr;gap:6px}.smm-totals b{font-size:11px}',
      '.smm-seg button,.smm-btn,.smm-sel{min-height:34px}',
      '.smm-h3{font-size:15px;flex-wrap:wrap}.smm-h3 small{flex-basis:100%;order:3}',
      '.smm-bar{flex-wrap:wrap}.smm-bar-pick{flex:1 1 100%}.smm-searchwrap{flex:1}.smm-input.smm-search{flex:1;width:auto;min-width:0}',
      '.smm-subtabs{flex:1 1 100%;display:flex}.smm-subtabs button{flex:1}',
      '.smm-bkkpi{grid-template-columns:1fr 1fr}',
      '.smm-dvhead,.smm-dvrow{grid-template-columns:50px minmax(0,1fr) 78px}.smm-dvrow .hm2,.smm-dvhead .hm2{display:none}',
      '.smm-hotbl .hm,.smm-ptbl .hm{display:none}',
      '.smm-hotbl td.nmcol{min-width:140px}',
      '.smm-comp-splits{grid-template-columns:1fr}.smm-split+.smm-split{border-left:0;border-top:1px solid var(--border2)}',
      '.smm-stack{height:220px}.smm-stack .cols{gap:2px}.smm-stack .col span{font-size:8px}.smm-stack .col:nth-child(even) span{visibility:hidden}',
      '.smm-hhead,.smm-hrow{grid-template-columns:minmax(0,1fr) 64px 64px}',
      '.smm-kv{grid-template-columns:110px 1fr}',
    '}',
    '@media (min-width:641px) and (max-width:900px){.smm-ins-mid{grid-template-columns:repeat(2,minmax(0,1fr))!important}#smmInsAna1{grid-column:1/-1}}',
    '@media (max-width:480px){.smm-tbl .lot{display:none}.smm-tbl td:nth-child(5){padding-left:6px}}',
    '@media (max-width:360px){.smm-sum,.smm-ins-sum{grid-template-columns:1fr}.smm-verdict{flex-direction:column;align-items:flex-start}}'
  ].join('\n');

  // ─────────────────────────── Data asli (R2 via Worker) ───────────────────────────
  // /api/admin/smartmoney?code=KODE → { broker, insider } (lihat src/lib/smartmoney.js).
  // Format file yang diunggah upload_smartmoney.py:
  //   broker:  { code, updated, days:[iso], ohlc?:[[iso,o,h,l,c]],
  //              brokers:[{ code, bv:[], sv:[], bl:[], sl:[], fbv?:[], fsv?:[], fbl?:[], fsl?:[] }] }
  //            bv/sv = nilai beli/jual (Rp), bl/sl = lot beli/jual, f* = porsi investor asing.
  //   insider: { code, updated, sharesOut?, trades:[{ date, name, role, action:'BUY'|'SELL', shares,
  //              price, prev?, cur?, prevPct?, curPct?, value?, src, broker?, type?, tujuan? }] }
  // Saham tanpa data asli → dataset kosong (lihat emptyData), halaman menampilkan kotak kosong.
  var _real = {};          // code → dataset asli | false (tidak ada) | Promise (sedang dimuat)
  var _index = null;       // daftar kode yang punya data asli
  var _ohlcAll = null;     // cache /ohlc.json (fallback harga)

  // Saham tanpa data asli → dataset KOSONG (tidak ada data dummy). Halaman menampilkan kotak kosong.
  var _empty = {};
  function emptyData(code) {
    return _empty[code] || (_empty[code] = { code: code, days: [], ohlc: [], off: 0, brokers: [], insiders: [], trades: [], sharesOut: 1,
      nP: 0, nF: 0, end: '', real: false, none: true, hasForeign: false, hasBroker: false, hasInsider: false });
  }
  function getData(code) { return _real[code] && !_real[code].then ? _real[code] : emptyData(code); }

  function loadOhlc() {
    if (_ohlcAll) return _ohlcAll;
    _ohlcAll = fetch('/ohlc.json', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    return _ohlcAll;
  }
  function loadIndex() {
    return fetch('/api/admin/smartmoney/index', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var codes = j && j.ok && j.index && Array.isArray(j.index.codes) ? j.index.codes : [];
        _index = codes.map(function (c) { return String(c).toUpperCase(); }).filter(function (c) { return /^[A-Z0-9]{2,6}$/.test(c); });
        return _index;
      })
      .catch(function () { _index = []; return _index; });
  }
  function loadReal(code) {
    if (_real[code] !== undefined) return Promise.resolve(_real[code]);
    var p = fetch('/api/admin/smartmoney?code=' + encodeURIComponent(code), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.ok || (!j.broker && !j.insider && !j.holder)) return false;
        var needPx = !(j.broker && Array.isArray(j.broker.ohlc) && j.broker.ohlc.length);
        return (needPx ? loadOhlc() : Promise.resolve(null)).then(function (all) {
          try {
            var g = adapt(code, j.broker, j.insider, all, j.holder);
            if (g) { g.holder = adaptHolder(code, j.holder, g); g.hasHolder = !!g.holder; }
            return g;
          }
          catch (e) { console.warn('[smartmoney] data ' + code + ' tidak valid:', e); return false; }
        });
      })
      .catch(function () { return false; })
      .then(function (v) { _real[code] = v; return v; });
    _real[code] = p;
    return p;
  }

  function isoOf(x) {
    if (typeof x === 'number') return new Date((x < 1e12 ? x * 1000 : x)).toISOString().slice(0, 10);
    var s = String(x || '').trim();
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
    m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);          // dd/mm/yyyy
    if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
    return null;
  }
  function num(v) { var n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; }

  function adapt(code, B, I, ohlcAll, H) {
    // 1) harga: dari file broker, atau /ohlc.json
    var px = {};
    if (B && Array.isArray(B.ohlc)) B.ohlc.forEach(function (r) { var d = isoOf(r[0]); if (d) px[d] = { open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]) }; });
    else if (ohlcAll && ohlcAll.tickers && ohlcAll.tickers[code] && Array.isArray(ohlcAll.tickers[code].candles)) {
      ohlcAll.tickers[code].candles.forEach(function (c) { var d = isoOf(c[0]); if (d) px[d] = { open: num(c[1]), high: num(c[2]), low: num(c[3]), close: num(c[4]) }; });
    }
    var bDays = B && Array.isArray(B.days) ? B.days.map(isoOf) : [];
    var set = {};
    Object.keys(px).forEach(function (d) { set[d] = 1; });
    bDays.forEach(function (d) { if (d) set[d] = 1; });
    var days = Object.keys(set).sort();
    if (!days.length && I && Array.isArray(I.trades)) I.trades.forEach(function (t) { var d = isoOf(t.date); if (d) set[d] = 1; }), days = Object.keys(set).sort();
    if (!days.length && H) days = [isoOf(H.updated) || new Date().toISOString().slice(0, 10)];
    if (!days.length) return false;

    // 2) broker → array harian sejajar dengan days (hari tanpa data = 0)
    var dIdx = {}; days.forEach(function (d, i) { dIdx[d] = i; });
    var first = bDays.filter(Boolean).sort()[0];
    var off = first ? dIdx[first] : days.length;
    var nF = days.length - off;
    var meta = {};
    brokerList().forEach(function (b) { meta[b.code] = b; });
    var brokers = [], hasForeign = false;
    (B && Array.isArray(B.brokers) ? B.brokers : []).forEach(function (raw) {
      var cd = String(raw.code || '').toUpperCase(); if (!cd) return;
      var m = meta[cd] || { code: cd, name: raw.name || cd, foreign: !!raw.foreign };
      var b = { code: cd, name: titleCase(m.name), type: brokerType(m), f: 0, fx: false };
      var keys = ['bv', 'sv', 'bl', 'sl'], fx = ['fbv', 'fsv', 'fbl', 'fsl'].every(function (k) { return Array.isArray(raw[k]); });
      keys.forEach(function (k) {
        b[k] = new Float64Array(nF);
        if (fx) { b['f' + k] = new Float64Array(nF); b['d' + k] = new Float64Array(nF); }
      });
      bDays.forEach(function (d, i) {
        var t = dIdx[d] - off; if (!(t >= 0 && t < nF)) return;
        keys.forEach(function (k) {
          var v = num(raw[k] && raw[k][i]);
          b[k][t] += v;
          if (fx) { var f = num(raw['f' + k][i]); b['f' + k][t] += f; b['d' + k][t] += Math.max(0, v - f); }
        });
      });
      if (fx) { b.fx = true; hasForeign = true; }
      brokers.push(b);
    });

    // 3) harga yang bolong: isi dari harga kemarin, atau dari rata-rata transaksi broker
    var ohlc = [], prev = null;
    days.forEach(function (d, i) {
      var c = px[d];
      if (!c || !c.close) {
        var t = i - off, v = 0, l = 0;
        if (t >= 0) brokers.forEach(function (b) { v += b.bv[t]; l += b.bl[t]; });
        var avg = l > 0 ? v / (l * 100) : (prev ? prev.close : 0);
        c = { open: avg, high: avg, low: avg, close: avg };
      }
      c = { time: d, open: c.open || c.close, high: Math.max(c.high, c.open, c.close), low: Math.min(c.low || c.close, c.open, c.close), close: c.close };
      ohlc.push(c); prev = c;
    });

    // 4) insider
    var trades = [], people = {};
    var sharesOut = I && num(I.sharesOut) || 0;
    (I && Array.isArray(I.trades) ? I.trades : []).forEach(function (r) {
      var d = isoOf(r.date); if (!d) return;
      var act = String(r.action || '').toUpperCase().indexOf('S') === 0 || /JUAL/i.test(r.action) ? 'SELL' : 'BUY';
      var idx = -1;
      for (var k = days.length - 1; k >= 0; k--) { if (days[k] <= d) { idx = k; break; } }
      var sh = Math.abs(num(r.shares)), price = num(r.price) || (idx >= 0 ? ohlc[idx].close : 0);
      var prevS = r.prev != null ? num(r.prev) : null, curS = r.cur != null ? num(r.cur) : null;
      if (prevS == null && curS != null) prevS = act === 'BUY' ? curS - sh : curS + sh;
      if (curS == null && prevS != null) curS = act === 'BUY' ? prevS + sh : prevS - sh;
      var prevPct = r.prevPct != null ? num(r.prevPct) : (sharesOut && prevS != null ? prevS / sharesOut * 100 : 0);
      var curPct = r.curPct != null ? num(r.curPct) : (sharesOut && curS != null ? curS / sharesOut * 100 : 0);
      var t = {
        idx: idx, date: d, mdate: idx >= 0 ? days[idx] : d, name: String(r.name || '-').trim(), role: String(r.role || '').trim() || '-',
        action: act, shares: sh, prev: prevS || 0, cur: curS || 0, prevPct: prevPct, curPct: curPct,
        price: price, value: num(r.value) || sh * price,
        src: String(r.src || '').toUpperCase() === 'KSEI' ? 'KSEI' : 'IDX',
        broker: r.broker ? String(r.broker).toUpperCase() : '-',
        type: String(r.type || 'D').toUpperCase().charAt(0) === 'A' ? 'A' : 'D',
        tujuan: r.tujuan ? String(r.tujuan) : '-'
      };
      trades.push(t);
    });
    trades.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    trades.forEach(function (t) { people[t.name] = { name: t.name, role: t.role, type: t.type, hold: t.cur, pct: t.curPct }; });

    return {
      code: code, days: days, ohlc: ohlc, off: off, brokers: brokers,
      insiders: Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) { return b.pct - a.pct; }),
      trades: trades, sharesOut: sharesOut || 1,
      nP: days.length, nF: nF, end: days[days.length - 1],
      real: true, hasForeign: hasForeign, hasBroker: brokers.length > 0 && nF > 0, hasInsider: trades.length > 0,
      updated: (B && B.updated) || (I && I.updated) || days[days.length - 1]
    };
  }

  // ─────────────────────────── Data kepemilikan (holder) ───────────────────────────
  // File R2 holder/{KODE}.json (diunggah upload_smartmoney.py):
  //   { code, updated, sharesOut?,
  //     profile:{ sector, subSector, industry, subIndustry, listingDate, ipoPrice, ipoAmount, ipoShares, freeFloat, underwriters:[] },
  //     board:[{ board:'direksi'|'komisaris', role, name, shares?, pct? }],
  //     shareholders:[{ name, shares, pct, tag? }],          // daftar pemegang terkini (termasuk Masyarakat)
  //     ubo:[{ name, via, vehicle?, pct }],
  //     movement:[{ month:'YYYY-MM', name, type, shares, scripless?, scrip?, pct }],   // pemegang > 1% (KSEI)
  //     composition:[{ month, cat:'ID'|'CP'|'MF'|'IB'|'IS'|'SC'|'PF'|'FD'|'OT'|'SCRIP', local, foreign }],
  //     holders:[{ date, count }] }                            // jumlah pemegang saham
  var CATS = [
    { k: 'CP', label: 'Korporasi', color: '#10b981' },
    { k: 'MF', label: 'Reksa Dana', color: '#14b8a6' },
    { k: 'IB', label: 'Institusi Keuangan', color: '#ef4444' },
    { k: 'ID', label: 'Individu (ritel)', color: '#3b82f6' },
    { k: 'IS', label: 'Asuransi', color: '#f59e0b' },
    { k: 'PF', label: 'Dana Pensiun', color: '#a855f7' },
    { k: 'SC', label: 'Perusahaan Efek', color: '#ec4899' },
    { k: 'FD', label: 'Yayasan', color: '#84cc16' },
    { k: 'OT', label: 'Lainnya', color: '#9ca3af' }
  ];
  var CAT_BY = {}; CATS.forEach(function (c) { CAT_BY[c.k] = c; });
  function lastDay(ym) { var p = ym.split('-'); return new Date(Date.UTC(+p[0], +p[1], 0)).toISOString().slice(0, 10); }
  function monthLabel(ym, long) { var p = ym.split('-'); return MON[+p[1] - 1] + (long ? ' ' + p[0] : ' ' + p[0].slice(2)); }

  function adaptHolder(code, H, g) {
    if (!H) return null;
    var so = num(H.sharesOut) || (g && g.sharesOut > 1 ? g.sharesOut : 0);
    var mv = {}, comp = {}, mset = {};
    (H.movement || []).forEach(function (x) {
      var m = String(x.month || '').slice(0, 7); if (!/^\d{4}-\d{2}$/.test(m)) return;
      mset[m] = 1;
      var sh = num(x.shares), sl = x.scripless != null ? num(x.scripless) : sh, sc = x.scrip != null ? num(x.scrip) : Math.max(0, sh - sl);
      (mv[m] = mv[m] || []).push({ name: String(x.name || '-').trim(), type: String(x.type || '-'), shares: sh, scripless: sl, scrip: sc, pct: num(x.pct) || (so ? sh / so * 100 : 0) });
    });
    (H.composition || []).forEach(function (x) {
      var m = String(x.month || '').slice(0, 7); if (!/^\d{4}-\d{2}$/.test(m)) return;
      mset[m] = 1;
      var c = comp[m] = comp[m] || { local: {}, foreign: {}, scrip: 0 };
      var k = String(x.cat || 'OT').toUpperCase();
      if (k === 'SCRIP') c.scrip += num(x.local) + num(x.foreign);
      else { if (!CAT_BY[k]) k = 'OT'; c.local[k] = (c.local[k] || 0) + num(x.local); c.foreign[k] = (c.foreign[k] || 0) + num(x.foreign); }
    });
    var months = Object.keys(mset).sort();
    var count = (H.holders || []).map(function (x) { return { date: isoOf(x.date), count: num(x.count) }; }).filter(function (x) { return x.date && x.count; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var hs = (H.shareholders || []).map(function (x) { return { name: String(x.name || '-').trim(), shares: num(x.shares), pct: num(x.pct), tag: x.tag || '' }; })
      .sort(function (a, b) { return b.pct - a.pct; });
    if (!so) { var hs1 = hs.filter(function (x) { return x.pct > 0 && x.shares > 0; })[0]; if (hs1) so = hs1.shares / hs1.pct * 100; }
    var P = H.profile || {};
    return {
      code: code, real: true, updated: H.updated || (months.length ? lastDay(months[months.length - 1]) : ''), sharesOut: so || 1,
      price: g && g.ohlc && g.ohlc.length ? g.ohlc[g.nP - 1].close : 0,
      months: months, mv: mv, comp: comp, count: count, holders: hs,
      board: (H.board || []).map(function (x) { return { board: /komis/i.test(x.board || x.role || '') ? 'komisaris' : 'direksi', role: x.role || '', name: String(x.name || '-').trim(), shares: num(x.shares), pct: x.pct != null ? num(x.pct) : (so && x.shares ? num(x.shares) / so * 100 : 0) }; }),
      ubo: (H.ubo || []).map(function (x) { return { name: String(x.name || '-').trim(), via: x.via || '', vehicle: x.vehicle || '', pct: num(x.pct) }; }),
      profile: {
        sector: P.sector || '', subSector: P.subSector || '', industry: P.industry || '', subIndustry: P.subIndustry || '',
        listingDate: isoOf(P.listingDate) || '', ipoPrice: num(P.ipoPrice), ipoAmount: num(P.ipoAmount), ipoShares: num(P.ipoShares),
        freeFloat: P.freeFloat != null ? num(P.freeFloat) : null, underwriters: Array.isArray(P.underwriters) ? P.underwriters : []
      }
    };
  }
  function getHolder(code) {
    var g = getData(code);
    return g.real ? g.holder || null : null;
  }

  // ─────────────────────────── State ───────────────────────────
  var S = {
    code: 'AVIA', period: '3M', inv: 'all', sub: 'broker',
    metric: 'value', priceMode: 'candle', showPrice: true,
    chips: [], hidden: {}, colors: {},
    actEnd: 0, actWin: 1, actMode: 'net', actSort: { side: 'b', key: 'val' }, actAll: false,
    skMetric: 'value', skFocus: null,
    insSrc: 'ALL', insAct: 'ALL', insName: null, insRange: '2Y', insHl: null,
    cal: { grp: 'sm', ym: null, end: null },
    broker: null, person: null, personAll: false, hoMonth: null, hoSide: 'all', hoChart: 'lf'
  };
  var root = null, flowChart = null, flowSeries = {}, insChart = null, insSeries = null;
  var _built = false;

  function G() { return getData(S.code); }
  function universe() { return _index && _index.length ? _index.slice(0, 40) : UNIVERSE; }
  function colorFor(code) {
    if (!S.colors[code]) {
      var used = {}; Object.keys(S.colors).forEach(function (k) { used[S.colors[k]] = 1; });
      var c = LINE_COLORS.filter(function (x) { return !used[x]; })[0] || LINE_COLORS[Object.keys(S.colors).length % LINE_COLORS.length];
      S.colors[code] = c;
    }
    return S.colors[code];
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function bkTag(code, type, name) {
    return '<span class="bk t-' + type + '" data-smm-tip="' + esc(code + ' · ' + name + ' (' + TYPE_META[type].label + ')') + '">' + esc(code) + '</span>';
  }
  function tip(text) { return '<i class="smm-tip" data-smm-tip="' + esc(text) + '">i</i>'; }
  function toast(msg) {
    var t = document.getElementById('smmToast');
    if (!t) { t = document.createElement('div'); t.id = 'smmToast'; t.className = 'smm-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }

  function defaultChips() {
    var g = G();
    var rows = aggregate(g, periodStart(g, '3M'), g.nF - 1, 'all').sort(function (a, b) { return b.net - a.net; });
    S.chips = rows.slice(0, 3).map(function (x) { return x.code; }).concat(rows.slice(-2).reverse().map(function (x) { return x.code; }));
    S.hidden = {}; S.colors = {};
    S.chips.forEach(colorFor);
  }

  // ─────────────────────────── Skeleton ───────────────────────────
  function skeleton() {
    var codes = [];
    try { if (typeof DATA !== 'undefined' && DATA && DATA.stock_list) codes = DATA.stock_list.map(function (s) { return s.code; }); } catch (_) {}
    UNIVERSE.forEach(function (c) { if (codes.indexOf(c) < 0) codes.push(c); });
    return '' +
    '<div class="smm-wrap">' +
      '<div class="smm-head">' +
        '<div class="smm-title"><h2>💰 Smart Money</h2><span class="smm-badge adm">Admin only</span><span class="smm-badge none" id="smmSrcBadge">Memuat data…</span></div>' +
        '<p class="smm-sub">Lacak ke mana <b>uang besar</b> bergerak. <span class="smm-up">Hijau</span> = sedang dikumpulkan, <span class="smm-dn">merah</span> = sedang dilepas.</p>' +
      '</div>' +

      // Bar lengket: pilih saham + pindah halaman
      '<div class="smm-bar" id="smmBar">' +
        '<div class="smm-bar-pick">' +
          '<div class="smm-searchwrap"><input class="smm-input smm-search" id="smmCode" maxlength="80" autocomplete="off" placeholder="Saham, broker, atau nama" aria-label="Cari kode saham, kode broker, atau nama insider" enterkeyhint="search"><div class="search-drop smm-drop" id="smmDrop" role="listbox"></div></div>' +
          '<button class="smm-btn primary" data-act="load">Cari</button>' +
        '</div>' +
        '<div class="smm-subtabs" role="tablist">' +
          '<button role="tab" data-act="sub" data-v="broker">📊 <span class="l">Broker Activity</span><span class="s">Broker</span></button>' +
          '<button role="tab" data-act="sub" data-v="insider">🕵️ <span>Insider</span></button>' +
          '<button role="tab" data-act="sub" data-v="holder">🏛️ <span class="l">Kepemilikan</span><span class="s">Pemilik</span></button>' +
          '<button role="tab" data-act="sub" data-v="screener">🔎 <span class="l">Screener</span><span class="s">Screen</span></button>' +
        '</div>' +
      '</div>' +
      '<div class="smm-active" id="smmActive" hidden></div>' +

      // ═════════ HALAMAN 1: BROKER ACTIVITY ═════════
      '<div class="smm-pg" id="smmPgBroker">' +
        '<div class="smm-card smm-empty">📭 <b>Belum ada data broker untuk saham ini.</b><br>Unggah lewat <code>upload_smartmoney.py</code>, atau pilih saham lain di daftar atas.</div>' +
        '<div class="smm-filters">' +
          '<div class="smm-scroll smm-seg" id="smmPeriod">' + PERIODS.map(function (p) { return '<button data-act="period" data-v="' + p.k + '">' + p.label + '</button>'; }).join('') + '</div>' +
          '<select class="smm-sel" id="smmInv" aria-label="Jenis investor">' +
            '<option value="all">Semua Investor</option><option value="F">Investor Asing</option><option value="D">Investor Domestik</option>' +
          '</select>' +
        '</div>' +

        '<section class="smm-card smm-profile" id="smmBkProfile" hidden></section>' +
        '<section class="smm-sum" id="smmSummary"></section>' +

        // Broker Flow (lebar) + Kalender flow harian (samping)
        '<div class="smm-flowrow">' +
        '<section class="smm-card" id="smmFlowCard">' +
          '<div class="smm-h3">Broker Flow <small id="smmFlowSub"></small>' + tip('Garis = total beli dikurangi jual (net) tiap broker, dijumlah dari awal periode. Garis naik = broker terus menimbun. Garis turun = broker terus melepas. Bandingkan dengan harga (sumbu kanan).') + '</div>' +
          '<div class="smm-toolbar">' +
            '<div class="smm-seg" id="smmMetric"><button data-act="metric" data-v="value">Value</button><button data-act="metric" data-v="volume">Volume</button></div>' +
            '<div class="smm-seg smm-pricetog" id="smmPriceMode"><button data-act="pmode" data-v="candle">Candle</button><button data-act="pmode" data-v="line">Garis</button></div>' +
          '</div>' +
          '<div class="smm-legend" id="smmFlowLegend" aria-live="polite"></div>' +
          '<div class="smm-chart" id="smmFlowChart"></div>' +
          '<div class="smm-chips" id="smmChips"></div>' +
          '<div class="smm-insight" id="smmFlowInsight"></div>' +
        '</section>' +
        '<section class="smm-card smm-calcard" id="smmCalCard"></section>' +
        '</div>' +

        '<div class="smm-grid">' +
          '<section class="smm-card" id="smmActionCard">' +
            '<div class="smm-h3">Broker Action ' + tip('Siapa pembeli & penjual terbesar pada tanggal terpilih. Mode Net = beli dikurangi jual per broker. Meter menunjukkan apakah pembeli besar lebih dominan (akumulasi) atau penjual besar (distribusi).') + '</div>' +
            '<div class="smm-datebar">' +
              '<button data-act="dprev" aria-label="Hari sebelumnya">‹</button>' +
              '<span id="smmActDate"></span>' +
              '<input type="date" id="smmActPick" aria-label="Pilih tanggal">' +
              '<button data-act="dnext" aria-label="Hari berikutnya">›</button>' +
            '</div>' +
            '<div class="smm-actsel">' +
              '<select id="smmActWin" aria-label="Rentang"><option value="1">1 Hari</option><option value="5">5 Hari</option><option value="20">20 Hari</option><option value="60">60 Hari</option></select>' +
              '<select id="smmActMode" aria-label="Mode"><option value="net">Net</option><option value="gross">Gross</option></select>' +
            '</div>' +
            '<div class="smm-meter" id="smmMeter"><i></i></div>' +
            '<div class="smm-meter-lbl"><span>Big Dist</span><span>Neutral</span><span>Big Acc</span></div>' +
            '<div class="smm-meter-txt" id="smmMeterTxt"></div>' +
            '<div class="smm-tbl-wrap"><table class="smm-tbl" id="smmActTbl"></table></div>' +
            '<button class="smm-btn smm-more" data-act="actall" id="smmActMore"></button>' +
            '<div class="smm-totals" id="smmActTotals"></div>' +
          '</section>' +

          '<section class="smm-card" id="smmSankeyCard">' +
            '<div class="smm-h3">Broker Distribution <small id="smmSkSub"></small>' + tip('Aliran barang dari pembeli (kiri) ke penjual (kanan) pada tanggal yang sama dengan Broker Action. Pita makin tebal = nilai makin besar. Ketuk broker untuk fokus.') + '</div>' +
            '<div class="smm-toolbar"><div class="smm-seg" id="smmSkMetric"><button data-act="skmetric" data-v="value">Value</button><button data-act="skmetric" data-v="volume">Volume</button></div></div>' +
            '<div class="smm-sk-hint" id="smmSkHint"></div>' +
            '<div class="smm-sk-wrap" id="smmSankey"></div>' +
            '<div class="smm-sk-legend"><span><i style="background:#8b5cf6"></i>Domestik</span><span><i style="background:#10b981"></i>BUMN</span><span><i style="background:#ef4444"></i>Asing</span></div>' +
          '</section>' +
        '</div>' +

        '<section class="smm-card" id="smmRadarCard">' +
          '<div class="smm-h3">📡 Radar Smart Money <small id="smmRadarSub"></small>' + tip('Peringkat saham berdasarkan skor Smart Money pada periode terpilih. Klik baris untuk membuka saham itu.') + '</div>' +
          '<p class="smm-desc">Saham mana yang sedang <b>dikumpulkan</b> dan <b>dilepas</b> pemain besar? Batang makin panjang = sinyal makin kuat.</p>' +
          '<div class="smm-radar-cols" id="smmRadar"></div>' +
        '</section>' +

        '<details class="smm-card smm-glossary"><summary>📘 Cara membaca halaman ini</summary><div class="smm-gloss">' +
          '<div><b>Bandar / broker besar</b>Pihak dengan dana besar (institusi, dana kelola, asing) yang transaksinya bisa menggerakkan harga.</div>' +
          '<div><b>Akumulasi</b>Pemain besar mengumpulkan saham sedikit demi sedikit. Biasanya terjadi sebelum harga naik.</div>' +
          '<div><b>Distribusi</b>Pemain besar menjual bertahap ke banyak pembeli kecil. Sering terjadi sebelum harga turun.</div>' +
          '<div><b>Net buy / net sell</b>Total beli dikurangi total jual. Positif = lebih banyak membeli.</div>' +
          '<div><b>Avg (harga rata-rata)</b>Kalau harga sekarang di atas avg beli bandar, bandar sedang untung.</div>' +
          '<div><b>Warna kode broker</b><span class="bk t-F">Merah</span> = asing, <span class="bk t-B">Hijau</span> = BUMN, <span class="bk t-D">Ungu</span> = domestik swasta.</div>' +
          '<div><b>Bukan rekomendasi</b>Smart money adalah petunjuk, bukan kepastian. Gabungkan dengan analisis fundamental & teknikal.</div>' +
        '</div></details>' +
      '</div>' +

      // ═════════ HALAMAN 2: INSIDER ═════════
      '<div class="smm-pg" id="smmPgInsider" hidden>' +
        '<div class="smm-card smm-empty">📭 <b>Belum ada data transaksi orang dalam untuk saham ini.</b><br>Unggah lewat <code>upload_smartmoney.py</code> (folder <code>smartmoney/insider/</code>), atau pilih saham lain.</div>' +
        '<section class="smm-card smm-profile" id="smmPersonCard" hidden></section>' +
        '<section class="smm-ins-sum" id="smmInsSum"></section>' +

        // Baris atas: grafik (lebar) + daftar orang dalam setinggi grafik (scroll bila panjang)
        '<div class="smm-ins-row">' +
        '<section class="smm-card" id="smmInsiderCard">' +
          '<div class="smm-h3">Harga & transaksi orang dalam <small id="smmInsSub"></small>' + tip('Transaksi direksi, komisaris, dan pemegang saham pengendali yang dilaporkan ke IDX / KSEI. Orang dalam paling tahu kondisi perusahaan, jadi pembelian mereka sering dianggap sinyal keyakinan.') + '</div>' +
          '<div class="smm-toolbar" style="margin-bottom:8px"><div class="smm-seg" id="smmInsRange"><button data-act="insrange" data-v="6M">6M</button><button data-act="insrange" data-v="1Y">1Y</button><button data-act="insrange" data-v="2Y">2Y</button></div>' +
          '<span class="lbl smm-ins-legend"><b class="smm-up">▲ Beli</b> <b class="smm-dn">▼ Jual</b> · panah besar = transaksi besar</span></div>' +
          '<div class="smm-ins-chart" id="smmInsChart"></div>' +
        '</section>' +
          '<div class="smm-ins-sidewrap"><div class="smm-box smm-ins-side2" id="smmInsHolders"></div></div>' +
        '</div>' +

        '<div class="smm-ins-mid">' +
          '<div class="smm-box" id="smmInsRecord"></div>' +
          '<div class="smm-box" id="smmInsAna2"></div>' +
          '<div class="smm-box" id="smmInsYear"></div>' +
          '<div class="smm-box" id="smmInsAna1"></div>' +
        '</div>' +

        '<section class="smm-card" id="smmInsListCard">' +
          '<div class="smm-h3">Daftar transaksi</div>' +
          '<div class="smm-ins-filter">' +
            '<div class="smm-seg" id="smmInsSrc"><button data-act="inssrc" data-v="ALL">Semua</button><button data-act="inssrc" data-v="IDX">IDX</button><button data-act="inssrc" data-v="KSEI">KSEI</button></div>' +
            '<select class="smm-sel" id="smmInsAct" aria-label="Aksi"><option value="ALL">Semua Aksi</option><option value="BUY">Beli</option><option value="SELL">Jual</option></select>' +
            '<span id="smmInsTag"></span>' +
          '</div>' +
          '<div class="smm-tbl-wrap smm-ins-desk"><table class="smm-tbl smm-itbl" id="smmInsTbl"></table></div>' +
          '<div class="smm-icards" id="smmInsCards"></div>' +
          '<button class="smm-btn smm-more" data-act="insall" id="smmInsMore"></button>' +
        '</section>' +

        '<details class="smm-card smm-glossary"><summary>📘 Cara membaca halaman ini</summary><div class="smm-gloss">' +
          '<div><b>Insider</b>Direksi, komisaris, dan pengendali. Mereka wajib melapor ke IDX / KSEI saat jual-beli saham perusahaannya.</div>' +
          '<div><b>Beli oleh insider</b>Sering dianggap tanda yakin pada prospek perusahaan. Jual bisa karena butuh dana, belum tentu sinyal buruk.</div>' +
          '<div><b>Buy record</b>Persentase pembelian insider yang harganya lebih tinggi 1 minggu / 1, 3, 6, 12 bulan kemudian.</div>' +
          '<div><b>Sebelum → Sesudah</b>Persentase kepemilikan insider sebelum dan sesudah transaksi.</div>' +
          '<div><b>Bukan rekomendasi</b>Gunakan sebagai petunjuk tambahan, bukan satu-satunya dasar keputusan.</div>' +
        '</div></details>' +
      '</div>' +

      // ═════════ HALAMAN 3: KEPEMILIKAN ═════════
      '<div class="smm-pg" id="smmPgHolder" hidden>' +
        '<div class="smm-card smm-empty">📭 <b>Belum ada data kepemilikan untuk saham ini.</b><br>Unggah lewat <code>upload_smartmoney.py</code> (folder <code>smartmoney/holder/</code>), atau pilih saham lain.</div>' +
        '<section class="smm-ins-sum" id="smmHoSum"></section>' +
        '<section class="smm-card" id="smmHoMoveCard">' +
          '<div class="smm-h3">Pergerakan pemegang &gt; 1% <small id="smmHoMoveSub"></small>' + tip('Daftar pemegang saham di atas 1% per akhir bulan (data KSEI). Δ MoM = perubahan porsi dibanding bulan sebelumnya, dalam poin persen (pp). Klik nama untuk melihat jejaknya di saham lain.') + '</div>' +
          '<div class="smm-scroll smm-seg smm-months-seg" id="smmHoMoveMonths"></div>' +
          '<div class="smm-hobar" id="smmHoBar"></div>' +
          '<div id="smmHoMoveTxt"></div>' +
          '<div id="smmHoMoveTbl"></div>' +
        '</section>' +
        // Dua kolom yang tingginya disamakan; kartu terakhir tiap kolom mengisi sisa ruang (tanpa bolong)
        '<div class="smm-hocols">' +
         '<div class="smm-hocol">' +
          '<section class="smm-card" id="smmHoCompCard">' +
            '<div class="smm-h3">Komposisi pemegang ' + tip('Pembagian saham berdasarkan jenis investor KSEI: korporasi, reksa dana, institusi keuangan, individu, dan lainnya. Ritel = individu, institusi = selain individu.') + '</div>' +
            '<div class="smm-scroll smm-seg smm-months-seg" id="smmHoCompMonths"></div>' +
            '<div class="smm-seg" id="smmHoSide" style="margin:8px 0"><button data-act="hoside" data-v="all">Semua</button><button data-act="hoside" data-v="local">Lokal</button><button data-act="hoside" data-v="foreign">Asing</button></div>' +
            '<div id="smmHoComp"></div>' +
          '</section>' +
          '<section class="smm-card" id="smmHoHoldersCard"><div class="smm-h3">Pemegang saham terkini</div><div id="smmHoHolders"></div></section>' +
          '<section class="smm-card smm-fill" id="smmHoBoard"></section>' +
         '</div>' +
         '<div class="smm-hocol">' +
          '<section class="smm-card" id="smmHoChartCard">' +
            '<div class="smm-h3">Tren kepemilikan 12 bulan ' + tip('Porsi kepemilikan scripless per akhir bulan. Mode Per kategori memperlihatkan siapa yang menambah atau mengurangi porsi dari bulan ke bulan.') + '</div>' +
            '<div class="smm-toolbar"><div class="smm-seg" id="smmHoChartMode"><button data-act="hochart" data-v="lf">Lokal vs Asing</button><button data-act="hochart" data-v="cat">Per kategori</button></div></div>' +
            '<div class="smm-hokpi" id="smmHoChartKpi"></div>' +
            '<div id="smmHoChart"></div>' +
          '</section>' +
          '<section class="smm-card" id="smmHoCountCard"><div class="smm-h3">Jumlah pemegang saham ' + tip('Jumlah investor per akhir bulan. Hijau = bertambah dari bulan sebelumnya, merah = berkurang.') + '</div><div id="smmHoCount"></div></section>' +
          '<section class="smm-card smm-fill" id="smmHoCompany"></section>' +
         '</div>' +
        '</div>' +
        '<details class="smm-card smm-glossary"><summary>📘 Cara membaca halaman ini</summary><div class="smm-gloss">' +
          '<div><b>Scrip vs scripless</b>Scrip = saham warkat (kertas). Scripless = saham elektronik di KSEI. Data komposisi hanya mencakup scripless.</div>' +
          '<div><b>pp (poin persen)</b>Selisih langsung dua persentase. Dari 2,31% ke 2,33% = naik 0,02 pp.</div>' +
          '<div><b>Jumlah pemegang turun</b>Saham terkumpul di lebih sedikit tangan. Sering menyertai akumulasi oleh pemain besar.</div>' +
          '<div><b>Jumlah pemegang naik</b>Saham menyebar ke banyak investor kecil. Waspada kalau terjadi bersamaan dengan distribusi bandar.</div>' +
          '<div><b>Pengendali & UBO</b>Pengendali = pemegang yang menguasai perusahaan. UBO = orang di balik perusahaan pengendali.</div>' +
          '<div><b>Free float</b>Porsi saham yang beredar bebas di publik. Free float kecil membuat harga lebih mudah digerakkan.</div>' +
        '</div></details>' +
      '</div>' +

      // ═════════ HALAMAN 4: SCREENER (modul terpisah: smartmoney-screener.js) ═════════
      '<div class="smm-pg" id="smmPgScreener" hidden></div>' +
    '</div>';
  }

  // ─────────────────────────── Ringkasan ───────────────────────────
  function gaugeSvg(score) {
    var cx = 75, cy = 75, R = 60, segs = ['#ef4444', '#f97316', '#9ca3af', '#34d399', '#10b981'];
    var parts = '';
    for (var i = 0; i < 5; i++) {
      var a0 = Math.PI * (1 - i / 5), a1 = Math.PI * (1 - (i + 1) / 5);
      var x0 = cx + R * Math.cos(a0), y0 = cy - R * Math.sin(a0), x1 = cx + R * Math.cos(a1), y1 = cy - R * Math.sin(a1);
      parts += '<path d="M' + x0.toFixed(1) + ' ' + y0.toFixed(1) + ' A' + R + ' ' + R + ' 0 0 1 ' + x1.toFixed(1) + ' ' + y1.toFixed(1) + '" stroke="' + segs[i] + '" stroke-width="14" fill="none"/>';
    }
    var ang = Math.PI * (1 - score / 100);
    var nx = cx + (R - 18) * Math.cos(ang), ny = cy - (R - 18) * Math.sin(ang);
    return '<svg class="smm-gauge" viewBox="0 0 150 92" role="img" aria-label="Skor ' + score + '">' + parts +
      '<line x1="' + cx + '" y1="' + cy + '" x2="' + nx.toFixed(1) + '" y2="' + ny.toFixed(1) + '" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>' +
      '<circle cx="' + cx + '" cy="' + cy + '" r="5" fill="var(--text)"/>' +
      '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" font-size="16" font-weight="800" fill="var(--text)" font-family="IBM Plex Mono,monospace">' + score + '</text></svg>';
  }

  function renderSummary() {
    if (!G().hasBroker) return;
    var g = G(), t0 = periodStart(g, S.period), t1 = g.nF - 1;
    var sc = smartScore(g, t0), lab = scoreLabel(sc.score), al = accLabel(sc.acc);
    var pTxt = PERIOD_TEXT[S.period];
    var c0 = g.ohlc[g.off + t0].open, c1 = g.ohlc[g.nP - 1].close, chg = (c1 / c0 - 1) * 100;
    var rows = sc.rows.slice().sort(function (a, b) { return b.net - a.net; });
    var top = rows[0], bot = rows[rows.length - 1];
    var gain = top.bAvg ? (c1 / top.bAvg - 1) * 100 : 0;
    var fl = sc.fNet;
    var ins = sc.ins;
    var insLab = ins.nb + ins.ns === 0 ? { k: 'n', t: 'Tidak ada transaksi' } : ins.net > 0 ? { k: 'a', t: 'Orang dalam MEMBELI' } : { k: 'd', t: 'Orang dalam MENJUAL' };
    var bullets = [
      (sc.acc > 0.1 ? '✅' : sc.acc < -0.1 ? '⚠️' : '➖') + ' Bandar: <b>' + al.label + '</b>',
      (!g.hasForeign ? '➖ Asing: belum ada data' : (fl > 0 ? '✅' : '⚠️') + ' Asing: net ' + (fl > 0 ? 'beli' : 'jual') + ' <b>' + fmtVal(Math.abs(fl), true) + '</b>'),
      (ins.net > 0 ? '✅' : ins.net < 0 ? '⚠️' : '➖') + ' Insider 6 bln: ' + (ins.nb + ins.ns ? (ins.nb + 'x beli, ' + ins.ns + 'x jual') : 'tidak ada transaksi')
    ];
    document.getElementById('smmSummary').innerHTML =
      '<div class="smm-card smm-verdict k-' + lab.k + '">' + gaugeSvg(sc.score) +
        '<div><h4>Skor Smart Money · ' + esc(S.code) + ' · ' + esc(pTxt) + '</h4>' +
        '<div class="big">' + esc(lab.label) + '</div><p>' + esc(lab.desc) + '</p><ul>' + bullets.map(function (b) { return '<li>' + b + '</li>'; }).join('') + '</ul></div>' +
        '<span style="position:absolute;top:10px;right:10px">' + tip('Skor 0-100 gabungan: 45% pola bandar (Broker Action), 30% arus dana asing, 25% transaksi insider 6 bulan terakhir. Di atas 55 = cenderung masuk, di bawah 45 = cenderung keluar.') + '</span>' +
      '</div>' +
      '<div class="smm-card smm-kpi"><h4>🏦 Bandar ' + tip('Broker dengan net buy terbesar pada periode ini dan harga rata-rata belinya.') + '</h4>' +
        '<div class="v">' + bkTag(top.code, top.type, top.name) + ' <span class="smm-up" style="font-size:16px">' + fmtVal(top.net) + '</span></div>' +
        '<span class="pill k-' + al.k + '">' + al.emoji + ' ' + al.label + '</span>' +
        '<p>Penimbun terbesar: <b>' + esc(top.name) + '</b>, rata-rata beli <b>' + nf(top.bAvg) + '</b>. Harga sekarang ' + nf(c1) + ' → bandar ' + (gain >= 0 ? '<b class="smm-up">untung ' + fmtPct(gain) + '</b>' : '<b class="smm-dn">rugi ' + fmtPct(gain) + '</b>') + '.</p>' +
        '<p style="margin-top:4px">Pelepas terbesar: ' + bkTag(bot.code, bot.type, bot.name) + ' <span class="smm-dn">' + fmtVal(bot.net) + '</span></p>' +
      '</div>' +
      '<div class="smm-card smm-kpi"><h4>🌏 Investor Asing ' + tip('Perkiraan porsi transaksi investor asing (net beli − jual) pada periode terpilih.') + '</h4>' +
        (g.hasForeign ?
        '<div class="v ' + signCls(fl) + '">' + fmtVal(fl, true) + '</div>' +
        '<span class="pill k-' + (fl > 0 ? 'a' : 'd') + '">' + (fl > 0 ? '⬆ Net Buy' : '⬇ Net Sell') + '</span>' +
        '<p>Dalam ' + esc(pTxt) + ', asing ' + (fl > 0 ? '<b>memasukkan</b>' : '<b>menarik</b>') + ' dana ' + fmtVal(Math.abs(fl), true) + ' atau ' + nf(Math.abs(fl) / sc.turnover * 100, 1) + '% dari total transaksi ' + fmtVal(sc.turnover, true) + '.</p>'
        : '<div class="v">-</div><span class="pill k-n">Belum ada data</span><p>File data saham ini belum berisi porsi investor asing (kolom fbv/fsv/fbl/fsl).</p>') +
      '</div>' +
      '<div class="smm-card smm-kpi smm-kpi-link" data-act="sub" data-v="insider" role="button" tabindex="0"><h4>🕵️ Orang Dalam ' + tip('Total nilai beli dikurangi jual oleh direksi / komisaris / pengendali dalam 6 bulan terakhir.') + '</h4>' +
        '<div class="v ' + signCls(ins.net) + '">' + fmtVal(ins.net, true) + '</div>' +
        '<span class="pill k-' + insLab.k + '">' + insLab.t + '</span>' +
        '<p>6 bulan: beli <b class="smm-up">' + ins.nb + 'x</b>, jual <b class="smm-dn">' + ins.ns + 'x</b>. Harga ' + esc(pTxt) + ': <b class="' + signCls(chg) + '">' + fmtPct(chg) + '</b>.</p>' +
        '<span class="smm-go">Lihat halaman Insider →</span>' +
      '</div>';
  }

  function renderRadar() {
    var key = S.period;
    var list = universe().slice();
    if (list.indexOf(S.code) < 0) list.push(S.code);
    list = list.filter(function (c) { var d = getData(c); return d.hasBroker; });
    var data = list.map(function (c) {
      var g = getData(c), t0 = periodStart(g, key);
      var sc = smartScore(g, t0);
      var chg = (g.ohlc[g.nP - 1].close / g.ohlc[g.off + t0].open - 1) * 100;
      return { code: c, score: sc.score, acc: sc.acc, fNet: g.hasForeign ? sc.fNet : null, chg: chg };
    });
    var acc = data.filter(function (x) { return x.score >= 50; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 6);
    var dis = data.filter(function (x) { return x.score < 50; }).sort(function (a, b) { return a.score - b.score; }).slice(0, 6);
    function rowsHtml(arr, good) {
      if (!arr.length) return '<div class="smm-desc">Tidak ada saham di kategori ini.</div>';
      return '<div class="smm-rhead"><span>Kode</span><span>Skor</span><span>Net asing</span><span>Harga</span></div>' + arr.map(function (x) {
        var w = Math.abs(x.score - 50) * 2;
        return '<div class="smm-rrow' + (x.code === S.code ? ' on' : '') + '" data-act="quick" data-v="' + x.code + '">' +
          '<span class="c">' + x.code + '</span>' +
          '<span style="display:flex;align-items:center;gap:6px"><span class="smm-rbar" style="flex:1"><i style="width:' + w.toFixed(0) + '%;background:' + (good ? 'var(--green)' : 'var(--red)') + '"></i></span><b class="mono-n" style="font-size:11px;width:22px;text-align:right">' + x.score + '</b></span>' +
          '<span class="n ' + signCls(x.fNet) + '">' + (x.fNet == null ? '-' : fmtVal(x.fNet)) + '</span>' +
          '<span class="n ' + signCls(x.chg) + '">' + fmtPct(x.chg) + '</span></div>';
      }).join('');
    }
    document.getElementById('smmRadarSub').textContent = '· ' + PERIOD_TEXT[key] + ' · ' + list.length + ' saham pantauan';
    document.getElementById('smmRadar').innerHTML =
      '<div class="smm-radar-col"><h5>🟢 Sedang dikumpulkan</h5>' + rowsHtml(acc, true) + '</div>' +
      '<div class="smm-radar-col"><h5>🔴 Sedang dilepas</h5>' + rowsHtml(dis, false) + '</div>';
  }

  // ─────────────────────────── Broker Flow ───────────────────────────
  function chartTheme() {
    var d = isDark();
    return {
      text: cssVar('--text2') || (d ? '#c4b8e8' : '#6e6490'),
      grid: d ? 'rgba(255,255,255,.06)' : 'rgba(26,15,60,.06)',
      up: d ? '#4ade80' : '#059669', down: d ? '#fb7185' : '#e11d48',
      line: cssVar('--text') || (d ? '#f4f2ff' : '#1a0f3c')
    };
  }
  function timeKey(t) {
    if (t == null) return null;
    if (typeof t === 'string') return t;
    if (typeof t === 'object' && 'year' in t) return t.year + '-' + String(t.month).padStart(2, '0') + '-' + String(t.day).padStart(2, '0');
    if (typeof t === 'number') return new Date(t * 1000).toISOString().slice(0, 10);
    return null;
  }
  function tickFmt(t) {
    var k = timeKey(t); if (!k) return '';
    var p = k.split('-');
    return (+p[2]) + ' ' + MON[+p[1] - 1];
  }
  function baseChartOpts(th, extra) {
    var o = {
      autoSize: true,
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: th.text, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: th.grid }, horzLines: { color: th.grid } },
      rightPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderVisible: false, tickMarkFormatter: tickFmt, rightOffset: 4 },
      crosshair: { mode: 0 },
      handleScroll: true, handleScale: true
    };
    for (var k in extra) o[k] = extra[k];
    return o;
  }

  var _flowCum = {}, _flowIdx = {};
  function cumSeries(g, code, t0) {
    var b = g.brokers.filter(function (x) { return x.code === code; })[0];
    if (!b) return [];
    var fac = invFac(b, S.inv), acc = 0, out = [], map = {};
    var BV = series(b, S.inv, 'bv'), SV = series(b, S.inv, 'sv'), BL = series(b, S.inv, 'bl'), SL = series(b, S.inv, 'sl');
    for (var t = t0; t < g.nF; t++) {
      acc += (S.metric === 'value' ? (BV[t] - SV[t]) : (BL[t] - SL[t])) * fac;
      var d = g.days[g.off + t];
      out.push({ time: d, value: acc });
      map[d] = acc;
    }
    _flowCum[code] = map;
    return out;
  }

  function buildFlow() {
    if (!G().hasBroker) return;
    var el = document.getElementById('smmFlowChart');
    if (!el) return;
    if (!window.LightweightCharts) { setTimeout(buildFlow, 300); return; }
    if (flowChart) { try { flowChart.remove(); } catch (_) {} flowChart = null; }
    flowSeries = {}; _flowCum = {}; _flowIdx = {};
    var g = G(), t0 = periodStart(g, S.period), th = chartTheme();
    flowChart = LightweightCharts.createChart(el, baseChartOpts(th, {
      leftPriceScale: { visible: true, borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } }
    }));
    var px = g.ohlc.slice(g.off + t0);
    px.forEach(function (c, i) { _flowIdx[c.time] = c; });
    var ps;
    if (S.priceMode === 'candle') {
      ps = flowChart.addCandlestickSeries({
        priceScaleId: 'right', upColor: th.up, downColor: th.down, borderUpColor: th.up, borderDownColor: th.down,
        wickUpColor: th.up, wickDownColor: th.down, priceFormat: { type: 'price', precision: 0, minMove: 1 }, visible: S.showPrice
      });
      ps.setData(px);
    } else {
      ps = flowChart.addLineSeries({ priceScaleId: 'right', color: th.line, lineWidth: 2, priceFormat: { type: 'price', precision: 0, minMove: 1 }, visible: S.showPrice, priceLineVisible: false });
      ps.setData(px.map(function (c) { return { time: c.time, value: c.close }; }));
    }
    flowSeries.__price = ps;
    var fmt = S.metric === 'value' ? function (v) { return fmtVal(v); } : function (v) { return fmtLot(v); };
    S.chips.forEach(function (code) {
      var s = flowChart.addLineSeries({
        priceScaleId: 'left', color: colorFor(code), lineWidth: 2, title: code,
        priceFormat: { type: 'custom', formatter: fmt, minMove: 1 },
        priceLineVisible: false, lastValueVisible: true, visible: !S.hidden[code],
        crosshairMarkerRadius: 3
      });
      s.setData(cumSeries(g, code, t0));
      flowSeries[code] = s;
    });
    // garis nol (acuan beli = jual)
    if (S.chips.length && flowSeries[S.chips[0]]) {
      flowSeries[S.chips[0]].createPriceLine({ price: 0, color: th.text, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
    }
    flowChart.timeScale().fitContent();
    flowChart.subscribeCrosshairMove(function (param) { flowLegend(timeKey(param && param.time)); });
    flowLegend(null);
    document.getElementById('smmFlowSub').textContent = '· ' + S.code + ' · ' + fmtDate(g.days[g.off + t0]) + ' – ' + fmtDate(g.end) + ' · ' + (S.metric === 'value' ? 'nilai (Rp)' : 'volume (lot)') + (S.inv === 'F' ? ' · investor asing' : S.inv === 'D' ? ' · investor domestik' : '');
  }

  function flowLegend(key) {
    var el = document.getElementById('smmFlowLegend');
    if (!el) return;
    if (!key || !_flowIdx[key]) key = G().end;
    var c = _flowIdx[key];
    if (!c) { el.innerHTML = ''; return; }
    var fmt = S.metric === 'value' ? fmtVal : fmtLot;
    var html = '<div class="d">' + fmtDate(key, true) + '</div>';
    if (S.showPrice) html += '<div class="row"><span>O ' + nf(c.open) + '</span><span>H ' + nf(c.high) + '</span><span>L ' + nf(c.low) + '</span><span>C <b class="' + (c.close >= c.open ? 'smm-up' : 'smm-dn') + '">' + nf(c.close) + '</b></span></div>';
    var row = S.chips.filter(function (k) { return !S.hidden[k]; }).map(function (k) {
      var v = _flowCum[k] ? _flowCum[k][key] : null;
      return '<span><b style="color:' + colorFor(k) + '">' + k + '</b> <span class="' + signCls(v) + '">' + (v == null ? '-' : fmt(v)) + '</span></span>';
    }).join('');
    if (row) html += '<div class="row">' + row + '</div>';
    el.innerHTML = html;
  }

  function renderChips() {
    if (!G().hasBroker) return;
    var g = G(), byCode = {};
    g.brokers.forEach(function (b) { byCode[b.code] = b; });
    var html = '<span class="smm-chip price' + (S.showPrice ? '' : ' off') + '" data-act="chipprice" data-smm-tip="Tampilkan / sembunyikan harga">' + (S.priceMode === 'candle' ? '🕯' : '〰') + ' Harga</span>';
    S.chips.forEach(function (code) {
      var b = byCode[code]; if (!b) return;
      html += '<span class="smm-chip t-' + b.type + (S.hidden[code] ? ' off' : '') + '" data-act="chip" data-v="' + code + '" data-smm-tip="' + esc(b.name + ' (' + TYPE_META[b.type].label + '). Klik untuk sembunyikan / tampilkan.') + '">' +
        '<span class="dot" style="background:' + colorFor(code) + '"></span>' + code +
        '<span class="x" data-act="chipx" data-v="' + code + '" aria-label="Hapus ' + code + '">×</span></span>';
    });
    var t0 = periodStart(g, S.period);
    var rows = aggregate(g, t0, g.nF - 1, S.inv).filter(function (x) { return S.chips.indexOf(x.code) < 0; })
      .sort(function (a, b) { return Math.abs(b.net) - Math.abs(a.net); });
    html += '<span class="smm-add"><button data-act="addopen" aria-label="Tambah broker" data-smm-tip="Tambah broker ke grafik">+</button><div class="smm-addmenu" id="smmAddMenu">' +
      (rows.length ? rows.map(function (x) {
        return '<button data-act="chipadd" data-v="' + x.code + '"><span class="bk t-' + x.type + '">' + x.code + '</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(x.name) + '</span><span class="mono-n ' + signCls(x.net) + '">' + fmtVal(x.net) + '</span></button>';
      }).join('') : '<div class="smm-desc" style="padding:6px">Semua broker sudah ditampilkan.</div>') +
      '</div></span>';
    document.getElementById('smmChips').innerHTML = html;
  }

  function renderFlowInsight() {
    if (!G().hasBroker) return;
    var g = G(), t0 = periodStart(g, S.period);
    var rows = aggregate(g, t0, g.nF - 1, S.inv).sort(function (a, b) { return b.net - a.net; });
    var top = rows[0], bot = rows[rows.length - 1];
    var acc = accScore(rows).score;
    var c0 = g.ohlc[g.off + t0].open, c1 = g.ohlc[g.nP - 1].close, chg = (c1 / c0 - 1) * 100;
    var pattern;
    if (acc > 0.1 && chg < 0) pattern = '🧲 <b>Bandar menampung saat harga turun.</b> Ini pola akumulasi klasik: barang dikumpulkan di harga murah.';
    else if (acc > 0.1) pattern = '🚀 <b>Kenaikan harga ditopang pembelian bandar.</b> Tren lebih sehat karena didukung uang besar.';
    else if (acc < -0.1 && chg > 0) pattern = '⚠️ <b>Harga naik, tapi bandar justru jualan.</b> Waspada distribusi: barang dilepas ke pembeli ritel.';
    else if (acc < -0.1) pattern = '🔻 <b>Bandar keluar dan harga turun.</b> Tekanan jual dari pemain besar masih dominan.';
    else pattern = '⚖️ <b>Belum ada arah jelas.</b> Beli dan jual pemain besar relatif seimbang.';
    var lbl = S.metric === 'value' ? function (x) { return fmtVal(x, true); } : function (x) { return fmtLot(x) + ' lot'; };
    var vTop = S.metric === 'value' ? top.net : top.netL, vBot = S.metric === 'value' ? bot.net : bot.netL;
    document.getElementById('smmFlowInsight').innerHTML =
      '💡 Dalam ' + PERIOD_TEXT[S.period] + ', ' + bkTag(top.code, top.type, top.name) + ' <b>' + esc(top.name) + '</b> (' + TYPE_META[top.type].label + ') paling banyak menimbun: net beli <b class="smm-up">' + lbl(vTop) + '</b> di rata-rata <b>' + nf(top.bAvg) + '</b>. ' +
      bkTag(bot.code, bot.type, bot.name) + ' <b>' + esc(bot.name) + '</b> paling banyak melepas: net jual <b class="smm-dn">' + lbl(Math.abs(vBot)) + '</b>. Harga bergerak <b class="' + signCls(chg) + '">' + fmtPct(chg) + '</b>.<br>' + pattern;
  }

  // ─────────────────────────── Broker Action ───────────────────────────
  function actRange() { return [Math.max(0, S.actEnd - S.actWin + 1), S.actEnd]; }
  function rangeText(g, r) {
    var a = g.days[g.off + r[0]], b = g.days[g.off + r[1]];
    return r[0] === r[1] ? fmtDate(b) : fmtDate(a) + ' – ' + fmtDate(b);
  }

  function renderAction() {
    if (!G().hasBroker) return;
    var g = G(), r = actRange(), rows = aggregate(g, r[0], r[1], S.inv);
    var day = g.days[g.off + S.actEnd];
    document.getElementById('smmActDate').textContent = rangeText(g, r);
    var pick = document.getElementById('smmActPick');
    pick.min = g.days[g.off]; pick.max = g.end; pick.value = day;
    root.querySelector('[data-act="dprev"]').disabled = S.actEnd <= 0;
    root.querySelector('[data-act="dnext"]').disabled = S.actEnd >= g.nF - 1;
    document.getElementById('smmActWin').value = String(S.actWin);
    document.getElementById('smmActMode').value = S.actMode;

    var buyers, sellers;
    function mk(x, side) {
      if (S.actMode === 'net') {
        return side === 'b' ? { x: x, val: x.net, lot: x.netL, avg: x.bAvg } : { x: x, val: -x.net, lot: -x.netL, avg: x.sAvg };
      }
      return side === 'b' ? { x: x, val: x.bv, lot: x.bl, avg: x.bAvg } : { x: x, val: x.sv, lot: x.sl, avg: x.sAvg };
    }
    if (S.actMode === 'net') {
      buyers = rows.filter(function (x) { return x.net > 0; }).map(function (x) { return mk(x, 'b'); });
      sellers = rows.filter(function (x) { return x.net < 0; }).map(function (x) { return mk(x, 's'); });
    } else {
      buyers = rows.map(function (x) { return mk(x, 'b'); });
      sellers = rows.map(function (x) { return mk(x, 's'); });
    }
    var bk = S.actSort.side === 'b' ? S.actSort.key : 'val', sk = S.actSort.side === 's' ? S.actSort.key : 'val';
    buyers.sort(function (a, b) { return b[bk] - a[bk]; });
    sellers.sort(function (a, b) { return b[sk] - a[sk]; });
    var n = S.actAll ? Math.max(buyers.length, sellers.length) : Math.min(10, Math.max(buyers.length, sellers.length));
    function th(side, key, label) {
      var on = S.actSort.side === side && S.actSort.key === key;
      return '<th class="s' + (key === 'lot' ? ' lot' : '') + (on ? ' on' : '') + '" data-act="actsort" data-side="' + side + '" data-key="' + key + '">' + label + (on ? ' ▾' : '') + '</th>';
    }
    var html = '<thead><tr><th>BY</th>' + th('b', 'val', 'B.val') + th('b', 'lot', 'B.lot') + th('b', 'avg', 'B.avg') +
      '<th>SL</th>' + th('s', 'val', 'S.val') + th('s', 'lot', 'S.lot') + th('s', 'avg', 'S.avg') + '</tr></thead><tbody>';
    for (var i = 0; i < n; i++) {
      var b = buyers[i], s = sellers[i];
      html += '<tr>' +
        (b ? '<td class="bkc' + (b.x.code === S.broker ? ' on' : '') + '" data-act="bkpick" data-v="' + b.x.code + '">' + bkTag(b.x.code, b.x.type, b.x.name) + '</td><td class="b">' + fmtVal(b.val) + '</td><td class="b lot">' + fmtLot(b.lot) + '</td><td class="b">' + nf(b.avg) + '</td>' : '<td></td><td></td><td class="lot"></td><td></td>') +
        (s ? '<td class="bkc' + (s.x.code === S.broker ? ' on' : '') + '" data-act="bkpick" data-v="' + s.x.code + '">' + bkTag(s.x.code, s.x.type, s.x.name) + '</td><td class="s">' + fmtVal(s.val) + '</td><td class="s lot">' + fmtLot(s.lot) + '</td><td class="s">' + nf(s.avg) + '</td>' : '<td></td><td></td><td class="lot"></td><td></td>') +
        '</tr>';
    }
    html += '</tbody>';
    document.getElementById('smmActTbl').innerHTML = html;
    var more = document.getElementById('smmActMore');
    var total = Math.max(buyers.length, sellers.length);
    more.style.display = total > 10 ? '' : 'none';
    more.textContent = S.actAll ? 'Tampilkan 10 teratas' : 'Lihat semua (' + total + ' broker)';

    var a = accScore(rows), lab = accLabel(a.score);
    document.querySelector('#smmMeter i').style.left = ((a.score + 1) / 2 * 100).toFixed(1) + '%';
    var expl = {
      ba: 'Segelintir broker besar menyerap barang dari banyak penjual. Sinyal kuat ada yang sedang <b>mengumpulkan</b>.',
      a: 'Pembeli besar sedikit lebih dominan dari penjual besar.',
      n: 'Kekuatan pembeli besar dan penjual besar seimbang.',
      d: 'Penjual besar sedikit lebih dominan dari pembeli besar.',
      bd: 'Segelintir broker besar melepas barang ke banyak pembeli. Sinyal kuat ada yang sedang <b>membuang</b> saham.'
    };
    document.getElementById('smmMeterTxt').innerHTML = lab.emoji + ' <b>' + lab.label + '</b> (skor ' + fmtPct(a.score * 100, 0).replace('%', '') + '). 3 net buyer teratas menyerap <b class="smm-up">' + fmtVal(a.A, true) + '</b>, 3 net seller teratas melepas <b class="smm-dn">' + fmtVal(a.D, true) + '</b>. ' + expl[lab.k];

    var tv = rows.reduce(function (s, x) { return s + x.bv; }, 0);
    var fNet = g.hasForeign ? aggregate(g, r[0], r[1], 'F').reduce(function (s, x) { return s + x.net; }, 0) : null;
    var c = g.ohlc[g.off + S.actEnd], pc = g.ohlc[g.off + r[0] - 1] || g.ohlc[g.off + r[0]];
    var chg = (c.close / pc.close - 1) * 100;
    document.getElementById('smmActTotals').innerHTML =
      '<div>Total transaksi<b>' + fmtVal(tv, true) + '</b></div>' +
      '<div>Net asing<b class="' + signCls(fNet) + '">' + (fNet == null ? '-' : fmtVal(fNet, true)) + '</b></div>' +
      '<div>Harga<b class="' + signCls(chg) + '">' + nf(c.close) + ' (' + fmtPct(chg) + ')</b></div>';
    renderCal();
  }

  // ─────────────────────────── Sankey ───────────────────────────
  var _skLinks = [];
  // ─────────────────────────── Kalender flow harian ───────────────────────────
  // Heatmap net per hari bursa dalam 1 bulan. Kelompok: smart money (non-ritel), ritel, asing, atau 1 broker.
  // Ketuk tanggal → Broker Action & Distribution pindah ke hari itu (S.actEnd).
  var RETAIL = { YP: 1, XL: 1, PD: 1, XC: 1, KK: 1, CP: 1, EP: 1 };
  var CAL_MON = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  function calDay(g, grp, t) {
    var B = 0, Sv = 0, BL = 0, SL = 0;
    g.brokers.forEach(function (b) {
      var inv = grp === 'F' ? 'F' : S.inv;
      if (grp === 'sm' && RETAIL[b.code]) return;
      if (grp === 'rt' && !RETAIL[b.code]) return;
      if (grp.indexOf('b:') === 0 && 'b:' + b.code !== grp) return;
      if (grp === 'F' && !g.hasForeign && b.type !== 'F') return;
      var fac = grp === 'F' && !g.hasForeign ? 1 : invFac(b, inv);
      B += series(b, inv, 'bv')[t] * fac; Sv += series(b, inv, 'sv')[t] * fac;
      BL += series(b, inv, 'bl')[t] * fac; SL += series(b, inv, 'sl')[t] * fac;
    });
    var v = B - Sv;
    return { v: v, l: BL - SL, avg: v >= 0 ? (BL ? B / (BL * 100) : 0) : (SL ? Sv / (SL * 100) : 0) };
  }
  function renderCal() {
    var box = document.getElementById('smmCalCard'); if (!box) return;
    var g = G(); if (!g.hasBroker || !g.nF) { box.innerHTML = ''; return; }
    var C = S.cal, dIdx = {}, months = [];
    for (var t = 0; t < g.nF; t++) { var d = g.days[g.off + t]; dIdx[d] = t; var ym = d.slice(0, 7); if (months.indexOf(ym) < 0) months.push(ym); }
    var endYm = g.days[g.off + S.actEnd].slice(0, 7);
    if (C.end !== S.actEnd) { C.ym = endYm; C.end = S.actEnd; }      // ikut tanggal Broker Action
    if (!C.ym || months.indexOf(C.ym) < 0) C.ym = months[months.length - 1];
    var groups = [['sm', 'Smart money (non-ritel)'], ['rt', 'Ritel']];
    if (g.hasForeign) groups.push(['F', 'Investor asing']);
    g.brokers.slice().sort(function (a, b) { var ga = 0, gb = 0; for (var k = 0; k < g.nF; k++) { ga += a.bv[k] + a.sv[k]; gb += b.bv[k] + b.sv[k]; } return gb - ga; })
      .slice(0, 30).forEach(function (b) { groups.push(['b:' + b.code, b.code + ' · ' + b.name]); });
    if (!groups.some(function (x) { return x[0] === C.grp; })) C.grp = 'sm';
    var p = C.ym.split('-'), Y = +p[0], M = +p[1] - 1, mi = months.indexOf(C.ym);
    var rows = [], mx = 0, tot = 0, nb = 0, ns = 0;
    Object.keys(dIdx).forEach(function (d) { if (d.slice(0, 7) !== C.ym) return; var x = calDay(g, C.grp, dIdx[d]); x.d = d; x.t = dIdx[d]; rows.push(x); mx = Math.max(mx, Math.abs(x.v)); tot += x.v; if (x.v > 0) nb++; else if (x.v < 0) ns++; });
    var by = {}; rows.forEach(function (x) { by[x.d] = x; });
    var first = new Date(Date.UTC(Y, M, 1)), last = new Date(Date.UTC(Y, M + 1, 0));
    var dd = new Date(first); while (dd.getUTCDay() !== 1) dd.setUTCDate(dd.getUTCDate() - 1);
    var end = new Date(last); while (end.getUTCDay() !== 5) end.setUTCDate(end.getUTCDate() + (end.getUTCDay() === 6 ? -1 : end.getUTCDay() === 0 ? -2 : 1));
    var lastData = g.days[g.off + g.nF - 1], r = actRange(), cells = '';
    var weeks = [], wk = [];
    for (; dd <= end; dd.setUTCDate(dd.getUTCDate() + 1)) {
      var w = dd.getUTCDay(); if (w === 0 || w === 6) continue;
      var iso = dd.toISOString().slice(0, 10), x = by[iso], dn = '<span class="dn">' + dd.getUTCDate() + '</span>', c, inM = dd.getUTCMonth() === M;
      if (!inM) c = '<div class="smm-cc out">' + dn + '</div>';
      else if (!x) c = iso > lastData ? '<div class="smm-cc fut">' + dn + '</div>' : '<div class="smm-cc off">' + dn + '<span class="nt">Libur</span></div>';
      else if (!x.v && !x.l) c = '<div class="smm-cc zero' + (x.t >= r[0] && x.t <= r[1] ? ' sel' : '') + '">' + dn + '<span class="nt">Tidak ada transaksi</span></div>';
      else {
        var a = mx ? Math.abs(x.v) / mx : 0, sel = x.t >= r[0] && x.t <= r[1], k = x.v > 0 ? 'g' : 'r';
        c = '<button class="smm-cc ' + k + (sel ? ' sel' : '') + (a >= 0.66 ? ' hot' : '') + '" style="--a:' + (0.1 + a * 0.6).toFixed(2) + ';--w:' + Math.max(8, a * 100).toFixed(0) + '%" data-act="calday" data-v="' + x.t + '" ' +
          'data-smm-tip="' + esc(fmtDate(iso, true) + ' · net ' + fmtVal(x.v, true) + ' · ' + fmtLot(x.l) + ' lot · rata-rata ' + nf(x.avg) + ' · ketuk untuk lihat di Broker Action') + '">' +
          '<span class="top">' + dn + '<i class="ar"><svg viewBox="0 0 10 10" width="8" height="8"><path d="' + (k === 'g' ? 'M5 1.5 9 8.5H1z' : 'M5 8.5 1 1.5h8z') + '" fill="currentColor"/></svg></i></span>' +
          '<b class="nv">' + fmtVal(Math.abs(x.v)) + '</b>' +
          '<span class="mt"><small>' + fmtLot(Math.abs(x.l)) + '</small><small class="px">@' + nf(x.avg) + '</small></span>' +
          '<span class="bar"><i></i></span></button>';
      }
      wk.push({ c: c, live: inM });
      if (w === 5) { weeks.push(wk); wk = []; }
    }
    // minggu yang seluruhnya di luar bulan tidak ditampilkan
    cells = weeks.filter(function (z) { return z.some(function (q) { return q.live; }); }).map(function (z) { return z.map(function (q) { return q.c; }).join(''); }).join('');
    var nTot = nb + ns, totL = rows.reduce(function (s2, x) { return s2 + x.l; }, 0), bp = nTot ? nb / nTot * 100 : 0;
    var bestB = rows.filter(function (x) { return x.v > 0; }).sort(function (a2, b2) { return b2.v - a2.v; })[0];
    var bestS = rows.filter(function (x) { return x.v < 0; }).sort(function (a2, b2) { return a2.v - b2.v; })[0];
    box.innerHTML =
      '<div class="smm-h3">📅 Kalender flow ' + tip('Net beli dikurangi jual per hari bursa untuk kelompok terpilih. Hijau = net beli, merah = net jual, makin pekat makin besar. Ketuk tanggal untuk melihat pembeli & penjual hari itu di Broker Action dan Distribution.') + '</div>' +
      '<div class="smm-calhead">' +
        '<button class="smm-btn smm-calnav" data-act="calmon" data-v="-1" ' + (mi <= 0 ? 'disabled' : '') + ' aria-label="Bulan sebelumnya">‹</button>' +
        '<b class="smm-calm">' + CAL_MON[M] + ' ' + Y + '</b>' +
        '<button class="smm-btn smm-calnav" data-act="calmon" data-v="1" ' + (mi >= months.length - 1 ? 'disabled' : '') + ' aria-label="Bulan berikutnya">›</button>' +
      '</div>' +
      '<select class="smm-sel smm-calgrp" id="smmCalGrp" aria-label="Kelompok broker">' + groups.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (x[0] === C.grp ? ' selected' : '') + '>' + esc(x[1]) + '</option>'; }).join('') + '</select>' +
      '<div class="smm-calkpi">' +
        '<div class="' + (tot > 0 ? 'g' : tot < 0 ? 'r' : '') + '"><span>Net bulan ini</span><b class="' + signCls(tot) + '">' + fmtVal(tot, true) + '</b><small>' + fmtLot(totL) + ' lot</small></div>' +
        '<div><span>Hari beli / jual</span><b><span class="smm-up">' + nb + '</span> <em>/</em> <span class="smm-dn">' + ns + '</span></b><span class="smm-calsplit" data-smm-tip="' + esc(nb + ' hari net beli, ' + ns + ' hari net jual') + '"><i style="width:' + bp.toFixed(1) + '%"></i></span></div>' +
      '</div>' +
      (bestB || bestS ? '<div class="smm-calext">' +
        (bestB ? '<span class="g">Beli terbesar <b>' + fmtVal(bestB.v) + '</b> · ' + fmtDate(bestB.d) + '</span>' : '') +
        (bestS ? '<span class="r">Jual terbesar <b>' + fmtVal(Math.abs(bestS.v)) + '</b> · ' + fmtDate(bestS.d) + '</span>' : '') + '</div>' : '') +
      '<div class="smm-cal">' + ['Sen', 'Sel', 'Rab', 'Kam', 'Jum'].map(function (x) { return '<div class="smm-ch">' + x + '</div>'; }).join('') + cells + '</div>' +
      '<div class="smm-callg"><span>Jual</span><span class="sc"><i class="r"></i><i class="r2"></i><i class="n"></i><i class="g2"></i><i class="g"></i></span><span>Beli</span><small>makin pekat = makin besar · garis bawah = kekuatan hari itu</small></div>';
  }
  function renderSankey() {
    if (!G().hasBroker) return;
    var box = document.getElementById('smmSankey');
    var g = G(), r = actRange(), rows = aggregate(g, r[0], r[1], S.inv);
    var bKey = S.skMetric === 'value' ? 'bv' : 'bl', sKey = S.skMetric === 'value' ? 'sv' : 'sl';
    var fmt = S.skMetric === 'value' ? fmtVal : function (v) { return fmtLot(v) + ' lot'; };
    var TOP = (box.clientWidth || 800) < 560 ? 5 : 7;
    function side(key) {
      var arr = rows.slice().sort(function (a, b) { return b[key] - a[key]; });
      var top = arr.slice(0, TOP).map(function (x) { return { code: x.code, name: x.name, type: x.type, v: x[key] }; });
      var rest = arr.slice(TOP).reduce(function (s, x) { return s + x[key]; }, 0);
      if (rest > 0) top.push({ code: 'Lain', name: (arr.length - TOP) + ' broker lainnya', type: 'O', v: rest });
      return top;
    }
    var B = side(bKey), Sl = side(sKey);
    var rr = rng(hashStr(S.code + '|' + r[0] + '|' + r[1] + '|' + S.inv));
    var flows = [];
    B.forEach(function (b, i) {
      var w = Sl.map(function (s) { return s.v * (0.5 + rr()) * (s.code === b.code ? 0.25 : 1); });
      var ws = w.reduce(function (a, x) { return a + x; }, 0) || 1;
      Sl.forEach(function (s, j) { flows.push({ i: i, j: j, v: b.v * w[j] / ws }); });
    });
    B.forEach(function (b, i) { b.tot = flows.filter(function (f) { return f.i === i; }).reduce(function (a, f) { return a + f.v; }, 0); });
    Sl.forEach(function (s, j) { s.tot = flows.filter(function (f) { return f.j === j; }).reduce(function (a, f) { return a + f.v; }, 0); });
    var total = B.reduce(function (a, b) { return a + b.tot; }, 0) || 1;

    var W = Math.max(320, box.clientWidth || 800), H = W < 560 ? 380 : 460, nodeW = 12, pad = 8;
    var x0 = 4, x1 = W - 4 - nodeW;
    function layout(arr) {
      var k = (H - pad * (arr.length - 1)) / total, y = 0;
      arr.forEach(function (n) { n.y = y; n.h = Math.max(2, n.tot * k); n.off = 0; y += n.h + pad; });
      return k;
    }
    var k = layout(B); layout(Sl);
    var col = function (t) { return t === 'O' ? '#9ca3af' : TYPE_META[t].color; };

    // fokus default = pembeli terbesar
    var focus = S.skFocus;
    if (focus == null && B.length) focus = 'b:' + B[0].code;
    var fb = focus && focus.indexOf('b:') === 0 ? focus.slice(2) : null;
    var fs = focus && focus.indexOf('s:') === 0 ? focus.slice(2) : null;

    var defs = '', links = '';
    _skLinks = [];
    // urutan: pita fokus digambar terakhir supaya di atas
    flows.forEach(function (f, idx) {
      var b = B[f.i], s = Sl[f.j], h = f.v * k;
      if (h < 0.3) { f.skip = true; return; }
      f.ya = b.y + b.off; b.off += h;
      f.yb = s.y + s.off; s.off += h;
      f.h = h;
    });
    var order = flows.map(function (f, i) { return i; }).filter(function (i) { return !flows[i].skip; });
    function isOn(f) { return focus === '*' || (fb && B[f.i].code === fb) || (fs && Sl[f.j].code === fs); }
    order.sort(function (a, b) { return (isOn(flows[a]) ? 1 : 0) - (isOn(flows[b]) ? 1 : 0); });
    var xm0 = x0 + nodeW, xm1 = x1, xc = (xm0 + xm1) / 2;
    order.forEach(function (i) {
      var f = flows[i], b = B[f.i], s = Sl[f.j];
      var gid = 'smmG' + f.i + '_' + f.j;
      defs += '<linearGradient id="' + gid + '" gradientUnits="userSpaceOnUse" x1="' + xm0 + '" x2="' + xm1 + '"><stop offset="0" stop-color="' + col(b.type) + '"/><stop offset="1" stop-color="' + col(s.type) + '"/></linearGradient>';
      var d = 'M' + xm0 + ' ' + f.ya.toFixed(1) + ' C' + xc + ' ' + f.ya.toFixed(1) + ' ' + xc + ' ' + f.yb.toFixed(1) + ' ' + xm1 + ' ' + f.yb.toFixed(1) +
        ' L' + xm1 + ' ' + (f.yb + f.h).toFixed(1) + ' C' + xc + ' ' + (f.yb + f.h).toFixed(1) + ' ' + xc + ' ' + (f.ya + f.h).toFixed(1) + ' ' + xm0 + ' ' + (f.ya + f.h).toFixed(1) + ' Z';
      var on = isOn(f);
      var li = _skLinks.length;
      _skLinks.push({ b: b, s: s, v: f.v });
      links += '<path class="smm-sk-link" data-l="' + li + '" data-b="' + esc(b.code) + '" data-s="' + esc(s.code) + '" d="' + d + '" fill="' + (on ? 'url(#' + gid + ')' : (isDark() ? '#ffffff' : '#1a0f3c')) + '" opacity="' + (on ? 0.72 : 0.06) + '"/>';
    });

    function flowOf(bc, sc) {
      var bi = B.findIndex(function (x) { return x.code === bc; }), sj = Sl.findIndex(function (x) { return x.code === sc; });
      var f = flows.filter(function (q) { return q.i === bi && q.j === sj; })[0];
      return f ? f.v : 0;
    }
    var nodes = '';
    B.forEach(function (b) {
      var on = !fs || flowOf(b.code, fs) > 0;
      var shown = fs ? flowOf(b.code, fs) : b.tot;
      nodes += '<g class="smm-sk-node" data-node="b:' + esc(b.code) + '" opacity="' + (on ? 1 : 0.35) + '">' +
        '<rect x="' + x0 + '" y="' + b.y.toFixed(1) + '" width="' + nodeW + '" height="' + b.h.toFixed(1) + '" rx="3" fill="' + col(b.type) + '"/>';
      if (b.h >= 13 || fb === b.code) {
        var ty = b.y + Math.min(b.h / 2, 60) + 4;
        var lbl = b.code + '  ' + fmt(shown);
        nodes += '<rect x="' + (x0 + nodeW + 6) + '" y="' + (ty - 12) + '" width="' + (lbl.length * 7.2 + 10) + '" height="17" rx="5" fill="var(--card)" opacity=".88"/>' +
          '<text class="smm-sk-lbl" x="' + (x0 + nodeW + 11) + '" y="' + ty + '" fill="' + col(b.type) + '">' + esc(b.code) + '<tspan class="smm-sk-val" dx="6">' + esc(fmt(shown)) + '</tspan></text>';
      }
      nodes += '</g>';
    });
    Sl.forEach(function (s) {
      var on = !fb || flowOf(fb, s.code) > 0;
      var shown = fb ? flowOf(fb, s.code) : s.tot;
      nodes += '<g class="smm-sk-node" data-node="s:' + esc(s.code) + '" opacity="' + (on ? 1 : 0.35) + '">' +
        '<rect x="' + x1 + '" y="' + s.y.toFixed(1) + '" width="' + nodeW + '" height="' + s.h.toFixed(1) + '" rx="3" fill="' + col(s.type) + '"/>';
      if (s.h >= 13 || fs === s.code) {
        var ty = s.y + Math.min(s.h / 2, 60) + 4;
        var lbl = fmt(shown) + '  ' + s.code;
        nodes += '<rect x="' + (x1 - 6 - (lbl.length * 7.2 + 10)) + '" y="' + (ty - 12) + '" width="' + (lbl.length * 7.2 + 10) + '" height="17" rx="5" fill="var(--card)" opacity=".88"/>' +
          '<text class="smm-sk-lbl" x="' + (x1 - 11) + '" y="' + ty + '" text-anchor="end" fill="' + col(s.type) + '"><tspan class="smm-sk-val" dx="0">' + esc(fmt(shown)) + '</tspan> ' + esc(s.code) + '</text>';
      }
      nodes += '</g>';
    });
    box.innerHTML = '<div style="display:flex;justify-content:space-between;font-weight:800;font-size:13px;margin-bottom:6px"><span class="smm-up">Pembeli</span><span class="smm-dn">Penjual</span></div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:' + H + 'px"><defs>' + defs + '</defs>' + links + nodes + '</svg>';
    document.getElementById('smmSkSub').textContent = '· ' + S.code + ' · ' + rangeText(g, r);
    var hint = fb ? 'Fokus pembeli ' + fb + ': ke mana barangnya berasal. Ketuk lagi untuk lihat semua.' :
      fs ? 'Fokus penjual ' + fs + ': siapa yang menampung. Ketuk lagi untuk lihat semua.' : 'Semua aliran. Ketuk broker untuk fokus.';
    document.getElementById('smmSkHint').textContent = hint;
  }

  // ─────────────────────────── Insider ───────────────────────────
  var HORIZ = [[5, '1W later'], [21, '1M later'], [63, '3M later'], [126, '6M later'], [252, '1Y later']];
  function insFiltered(g, ignoreAct) {
    return g.trades.filter(function (t) {
      if (S.insSrc !== 'ALL' && t.src !== S.insSrc) return false;
      if (!ignoreAct && S.insAct !== 'ALL' && t.action !== S.insAct) return false;
      if (S.insName && t.name !== S.insName) return false;
      return true;
    });
  }
  function retAfter(g, t, h) {
    if (t.idx < 0 || t.idx + h >= g.nP) return null;
    return (g.ohlc[t.idx + h].close / t.price - 1) * 100;
  }

  function buildInsChart() {
    if (!G().hasInsider || !G().nP) return;
    var el = document.getElementById('smmInsChart');
    if (!el) return;
    if (!window.LightweightCharts) { setTimeout(buildInsChart, 300); return; }
    if (insChart) { try { insChart.remove(); } catch (_) {} insChart = null; }
    var g = G(), th = chartTheme();
    insChart = LightweightCharts.createChart(el, baseChartOpts(th, {}));
    insSeries = insChart.addAreaSeries({
      lineColor: '#2dd4bf', topColor: 'rgba(45,212,191,.35)', bottomColor: 'rgba(45,212,191,0)', lineWidth: 2,
      priceFormat: { type: 'price', precision: 0, minMove: 1 }, priceLineVisible: false
    });
    insSeries.setData(g.ohlc.map(function (c) { return { time: c.time, value: c.close }; }));
    var list = insFiltered(g).filter(function (t) { return t.idx >= 0; }).sort(function (a, b) { return a.idx - b.idx; });
    var maxV = list.reduce(function (m, t) { return Math.max(m, t.value); }, 1);
    insSeries.setMarkers(list.map(function (t) {
      var buy = t.action === 'BUY';
      return {
        time: t.mdate, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown',
        color: buy ? (isDark() ? '#4ade80' : '#10b981') : (isDark() ? '#fb7185' : '#e11d48'),
        size: 0.8 + 2.2 * Math.sqrt(t.value / maxV)
      };
    }));
    insRange();
    insChart.subscribeClick(function (param) {
      var k = timeKey(param && param.time); if (!k) return;
      var hit = insFiltered(g).filter(function (t) { return t.mdate === k; })[0];
      if (hit) { S.insHl = hit.date + '|' + hit.name; renderInsTable(); var row = root.querySelector('#smmInsTbl tr.hl'); if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    });
  }
  function insRange(centerIdx) {
    if (!insChart) return;
    if (!insChart) return;
    var g = G();
    if (centerIdx != null) {
      var a = Math.max(0, centerIdx - 40), b = Math.min(g.nP - 1, centerIdx + 40);
      insChart.timeScale().setVisibleRange({ from: g.days[a], to: g.days[b] });
      return;
    }
    var n = { '6M': 126, '1Y': 252, '2Y': g.nP }[S.insRange] || g.nP;
    insChart.timeScale().setVisibleRange({ from: g.days[Math.max(0, g.nP - n)], to: g.end });
  }

  function renderInsSide() {
    if (!G().hasInsider || !G().nP) return;
    var g = G(), all = insFiltered(g, true), buys = all.filter(function (t) { return t.action === 'BUY'; }), sells = all.filter(function (t) { return t.action === 'SELL'; });
    // Buy record
    var rec = HORIZ.map(function (h) {
      var ok = 0, n = 0;
      buys.forEach(function (t) { var r = retAfter(g, t, h[0]); if (r != null) { n++; if (r > 0) ok++; } });
      return { label: h[1], ok: ok, n: n, pct: n ? ok / n * 100 : null };
    });
    var r3 = rec[2];
    document.getElementById('smmInsRecord').innerHTML =
      '<h5>Buy record <small>porsi pembelian yang kemudian naik</small></h5>' +
      '<div class="smm-rec-big ' + (r3.pct == null ? '' : r3.pct >= 50 ? 'smm-up' : 'smm-dn') + '">' + (r3.pct == null ? '-' : nf(r3.pct) + '%') + '</div>' +
      '<div style="font-size:11px;color:var(--text3)">naik 3 bulan kemudian · ' + r3.n + ' transaksi beli</div>' +
      rec.map(function (x) {
        return '<div class="smm-rec-row"><span>' + x.label + '</span><span class="bar"><i style="width:' + (x.pct || 0).toFixed(0) + '%"></i></span><span>' + (x.n ? nf(x.pct) + '% dari ' + x.n : '-') + '</span></div>';
      }).join('') + (function () {
        var ok = rec.filter(function (x) { return x.n; }), bestH = ok.slice().sort(function (a2, b2) { return b2.pct - a2.pct; })[0];
        return '<div class="smm-ana smm-ins-foot"><span>Horizon terbaik</span><span>' + (bestH ? esc(bestH.label) + ' · ' + nf(bestH.pct) + '%' : '-') + '</span>' +
          '<span>Rata-rata semua horizon</span><span>' + (ok.length ? nf(ok.reduce(function (a2, x) { return a2 + x.pct; }, 0) / ok.length) + '%' : '-') + '</span></div>';
      })();

    // Per bulan (12 bulan terakhir) + per tahun
    var end = new Date(g.end + 'T00:00:00Z'), months = [];
    for (var m = 11; m >= 0; m--) {
      var d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - m, 1));
      months.push(d.toISOString().slice(0, 7));
    }
    var mNet = {}; all.forEach(function (t) { var k = t.date.slice(0, 7); mNet[k] = (mNet[k] || 0) + (t.action === 'BUY' ? t.value : -t.value); });
    var maxM = months.reduce(function (a, k) { return Math.max(a, Math.abs(mNet[k] || 0)); }, 1);
    var years = {};
    all.forEach(function (t) { var y = t.date.slice(0, 4); years[y] = years[y] || { b: 0, s: 0 }; years[y][t.action === 'BUY' ? 'b' : 's'] += t.value; });
    var maxY = Object.keys(years).reduce(function (a, y) { return Math.max(a, years[y].b, years[y].s); }, 1);
    document.getElementById('smmInsYear').innerHTML =
      '<h5>Per bulan <small>12 bulan terakhir</small></h5>' +
      '<div class="smm-months lbl">' + months.map(function (k) { return '<div>' + MON[+k.slice(5) - 1].charAt(0) + '</div>'; }).join('') + '</div>' +
      '<div class="smm-months">' + months.map(function (k) {
        var v = mNet[k] || 0, a = Math.abs(v) / maxM;
        var bg = v > 0 ? 'rgba(16,185,129,' + (0.25 + 0.75 * a).toFixed(2) + ')' : v < 0 ? 'rgba(239,68,68,' + (0.25 + 0.75 * a).toFixed(2) + ')' : '';
        return '<div data-smm-tip="' + esc(MON[+k.slice(5) - 1] + ' ' + k.slice(0, 4) + ': ' + (v ? (v > 0 ? 'net beli ' : 'net jual ') + fmtVal(Math.abs(v), true) : 'tidak ada transaksi')) + '"' + (bg ? ' style="background:' + bg + '"' : '') + '></div>';
      }).join('') + '</div>' +
      '<div style="display:flex;gap:12px;font-size:11px;color:var(--text3);margin:6px 0 10px"><span>🟩 Bulan net beli</span><span>🟥 Bulan net jual</span></div>' +
      '<h5>Per tahun <small>nilai beli vs jual</small></h5>' +
      Object.keys(years).sort().reverse().map(function (y) {
        var o = years[y];
        return '<div style="display:grid;grid-template-columns:38px 1fr;gap:6px;align-items:center;font-size:11px;margin-top:4px"><b>' + y + '</b><div>' +
          '<div style="display:flex;align-items:center;gap:6px"><span style="height:10px;border-radius:3px;background:#10b981;width:' + Math.max(1, o.b / maxY * 70).toFixed(0) + '%"></span><span class="mono-n">' + (o.b ? fmtVal(o.b, true) : '-') + '</span></div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-top:2px"><span style="height:10px;border-radius:3px;background:#ef4444;width:' + Math.max(1, o.s / maxY * 70).toFixed(0) + '%"></span><span class="mono-n">' + (o.s ? fmtVal(o.s, true) : '-') + '</span></div></div></div>';
      }).join('');

    // Analisis
    var first = all[0], last = all[all.length - 1];
    var daysAgo = last ? Math.round((new Date(g.end + 'T00:00:00Z') - new Date(last.date + 'T00:00:00Z')) / 864e5) + 1 : null;
    var bDays = {}, sDays = {}; buys.forEach(function (t) { bDays[t.date] = 1; }); sells.forEach(function (t) { sDays[t.date] = 1; });
    var r3s = buys.map(function (t) { return retAfter(g, t, 63); }).filter(function (x) { return x != null; });
    var avg3 = r3s.length ? r3s.reduce(function (a, x) { return a + x; }, 0) / r3s.length : null;
    var lastPx = g.ohlc[g.nP - 1].close;
    var best = null, worst = null;
    buys.forEach(function (t) {
      var toDate = (lastPx / t.price - 1) * 100;
      if (!best || toDate > best.r) best = { t: t, r: toDate };
      var r3x = retAfter(g, t, 63);
      if (r3x != null && (!worst || r3x < worst.r)) worst = { t: t, r: r3x };
    });
    var sFall = sells.map(function (t) { return retAfter(g, t, 21); }).filter(function (x) { return x != null; });
    var sFallPct = sFall.length ? sFall.filter(function (x) { return x < 0; }).length / sFall.length * 100 : null;
    document.getElementById('smmInsAna1').innerHTML = '<h5>Analisis</h5><div class="smm-ana">' +
      '<span>Transaksi pertama</span><span>' + (first ? fmtDate(first.date, true) : '-') + '</span>' +
      '<span>Transaksi terakhir</span><span>' + (last ? fmtDate(last.date, true) + ' · ' + daysAgo + 'h lalu' : '-') + '</span>' +
      '<span>Hari dengan beli</span><span>' + Object.keys(bDays).length + '</span>' +
      '<span>Hari dengan jual</span><span>' + Object.keys(sDays).length + '</span>' +
      '<span>Laporan tercatat</span><span>' + all.length + '</span>' +
      '<span>Orang dalam aktif</span><span>' + (S.insName ? 1 : g.insiders.filter(function (p) { return all.some(function (t) { return t.name === p.name; }); }).length) + '</span>' +
      (function () {
        var tb = 0, ts = 0; all.forEach(function (t) { if (t.action === 'BUY') tb += t.value; else ts += t.value; });
        return '<span>Total nilai beli</span><span class="smm-up">' + fmtVal(tb, true) + '</span>' +
          '<span>Total nilai jual</span><span class="smm-dn">' + fmtVal(ts, true) + '</span>' +
          '<span>Rata-rata per transaksi</span><span>' + (all.length ? fmtVal((tb + ts) / all.length, true) : '-') + '</span>' +
          '</div><div class="smm-ana smm-ins-foot"><span>Rasio nilai beli : jual</span><span class="' + (tb >= ts ? 'smm-up' : 'smm-dn') + '">' + (ts ? nf(tb / ts, 1) + 'x' : tb ? 'hanya beli' : '-') + '</span>' +
          '<span>Net beli − jual</span><span class="' + signCls(tb - ts) + '">' + fmtVal(tb - ts, true) + '</span>';
      })() +
      '</div>';
    function avgAfter(arr, n) { var v = arr.map(function (t) { return retAfter(g, t, n); }).filter(function (x) { return x != null; }); return v.length ? v.reduce(function (a2, x) { return a2 + x; }, 0) / v.length : null; }
    var avg1 = avgAfter(buys, 21), avg6 = avgAfter(buys, 126), sAvg1 = avgAfter(sells, 21);
    var bSh = 0, bVal = 0; buys.forEach(function (t) { bSh += t.shares; bVal += t.shares * t.price; });
    var bAvgPx = bSh ? bVal / bSh : 0, vsAvg = bAvgPx ? (lastPx / bAvgPx - 1) * 100 : null;
    document.getElementById('smmInsAna2').innerHTML = '<h5>Kualitas timing</h5><div class="smm-ana">' +
      '<span>Rata-rata 1 bln setelah beli</span><span class="' + signCls(avg1) + '">' + (avg1 == null ? '-' : fmtPct(avg1)) + '</span>' +
      '<span>Rata-rata 3 bln setelah beli</span><span class="' + signCls(avg3) + '">' + (avg3 == null ? '-' : fmtPct(avg3)) + '</span>' +
      '<span>Rata-rata 6 bln setelah beli</span><span class="' + signCls(avg6) + '">' + (avg6 == null ? '-' : fmtPct(avg6)) + '</span>' +
      '<span>Rata-rata 1 bln setelah jual</span><span class="' + signCls(sAvg1 == null ? 0 : -sAvg1) + '">' + (sAvg1 == null ? '-' : fmtPct(sAvg1)) + '</span>' +
      '<span>Harga rata-rata beli</span><span>' + (bAvgPx ? nf(bAvgPx) + ' <small class="' + signCls(vsAvg) + '">(' + fmtPct(vsAvg) + ')</small>' : '-') + '</span>' +
      '<span>Beli naik 1 bln kemudian</span><span>' + (rec[1].pct == null ? '-' : nf(rec[1].pct) + '%') + '</span>' +
      '<span>Jual sebelum harga turun</span><span>' + (sFallPct == null ? '-' : nf(sFallPct) + '%') + '</span>' +
      '<span>Beli terbaik</span><span class="' + (best ? signCls(best.r) : '') + '">' + (best ? fmtDate(best.t.date) + ' · ' + fmtPct(best.r) : '-') + '</span>' +
      '<span>Beli terburuk (3 bln)</span><span class="' + (worst ? signCls(worst.r) : '') + '">' + (worst ? fmtDate(worst.t.date) + ' · ' + fmtPct(worst.r) : '-') + '</span>' +
      '</div><div class="smm-ins-foot" style="font-size:11px;color:var(--text3);line-height:1.5">Return dihitung dari harga transaksi sampai harga penutupan 1 minggu / 1, 3, 6, 12 bulan kemudian. Setelah jual: negatif = harga turun (jual tepat waktu). Harga rata-rata beli dibanding harga terakhir.</div>';

    // Pemegang (orang dalam)
    var y1 = g.nP - 252;
    document.getElementById('smmInsHolders').innerHTML = '<h5>Orang dalam <small>' + g.insiders.length + ' orang · klik untuk filter</small></h5>' + '<div class="smm-ins-list">' +
      g.insiders.map(function (p) {
        var net = g.trades.filter(function (t) { return t.name === p.name && t.idx >= y1; }).reduce(function (a, t) { return a + (t.action === 'BUY' ? t.value : -t.value); }, 0);
        return '<div class="smm-rrow' + (S.insName === p.name ? ' on' : '') + '" style="grid-template-columns:1fr auto;padding:6px" data-act="insname" data-v="' + esc(p.name) + '">' +
          '<span><span class="nm" style="color:var(--accent);font-weight:700">' + esc(p.name) + '</span><span class="smm-role">' + esc(p.role) + '</span><span class="sm" style="display:block;font-size:11px;color:var(--text3)">Kepemilikan ' + nf(p.pct != null ? p.pct : p.hold / g.sharesOut * 100, 2) + '%</span></span>' +
          '<span class="n ' + signCls(net) + '" data-smm-tip="Net beli − jual 12 bulan terakhir">' + (net ? fmtVal(net, true) : '-') + '</span></div>';
      }).join('') + '</div>';
    var insPct = g.insiders.reduce(function (a2, p) { return a2 + (p.pct != null ? p.pct : p.hold / g.sharesOut * 100); }, 0);
    document.getElementById('smmInsHolders').innerHTML += '<div class="smm-ana smm-ins-foot">' +
      '<span>Total kepemilikan orang dalam</span><span>' + nf(insPct, 2) + '%</span>' +
      '<span>Jumlah orang dalam</span><span>' + g.insiders.length + '</span></div>';

    // Ringkasan atas halaman Insider
    var ins = insiderStats(g, g.nP - 126);
    var allT = g.trades, lastT = allT[allT.length - 1];
    var k = ins.nb + ins.ns === 0 ? 'n' : ins.net > 0 ? 'a' : 'd';
    var head = k === 'n' ? 'Belum ada transaksi' : k === 'a' ? 'Orang dalam MEMBELI' : 'Orang dalam MENJUAL';
    var v = k === 'n' ? 'Dalam 6 bulan terakhir tidak ada transaksi orang dalam yang dilaporkan.' :
      'Dalam 6 bulan terakhir: beli <b class="smm-up">' + ins.nb + 'x (' + fmtVal(ins.buy, true) + ')</b>, jual <b class="smm-dn">' + ins.ns + 'x (' + fmtVal(ins.sell, true) + ')</b>.';
    var r1 = rec[1];
    document.getElementById('smmInsSum').innerHTML =
      '<div class="smm-card smm-verdict k-' + (k === 'a' ? 'a' : k === 'd' ? 'd' : 'n') + '"><div>' +
        '<h4>Sinyal orang dalam · ' + esc(S.code) + ' · 6 bulan</h4>' +
        '<div class="big ' + signCls(ins.net) + '">' + head + '</div>' +
        '<p>' + v + '</p></div></div>' +
      '<div class="smm-card smm-kpi"><h4>Net 6 bulan</h4><div class="v ' + signCls(ins.net) + '">' + fmtVal(ins.net, true) + '</div><p>Nilai beli dikurangi jual.</p></div>' +
      '<div class="smm-card smm-kpi"><h4>Ketepatan beli</h4><div class="v ' + (r1.pct == null ? '' : r1.pct >= 50 ? 'smm-up' : 'smm-dn') + '">' + (r1.pct == null ? '-' : nf(r1.pct) + '%') + '</div><p>Pembelian yang naik 1 bulan kemudian' + (r1.n ? ' (' + r1.ok + ' dari ' + r1.n + ')' : '') + '.</p></div>' +
      '<div class="smm-card smm-kpi"><h4>Transaksi terakhir</h4><div class="v" style="font-size:18px">' + (lastT ? fmtDate(lastT.date) : '-') + '</div>' +
        (lastT ? '<p><span class="smm-act ' + lastT.action + '">' + (lastT.action === 'BUY' ? 'BELI' : 'JUAL') + '</span> ' + fmtVal(lastT.value, true) + ' oleh <b>' + esc(lastT.name) + '</b></p>' : '') + '</div>';
    document.getElementById('smmInsSub').textContent = '· ' + S.code + ' · ' + g.trades.length + ' laporan';
    document.getElementById('smmInsTag').innerHTML = S.insName ? '<span class="smm-ftag" data-act="insclear">' + esc(S.insName) + ' ×</span>' : '';
  }

  function renderInsTable() {
    if (!G().hasInsider || !G().nP) return;
    var g = G(), full = insFiltered(g).slice().sort(function (a, b) { return b.idx - a.idx; });
    var list = S.insAll ? full : full.slice(0, 10);
    var more = document.getElementById('smmInsMore');
    if (more) { more.style.display = full.length > 10 ? '' : 'none'; more.textContent = S.insAll ? 'Tampilkan 10 terbaru' : 'Lihat semua (' + full.length + ' transaksi)'; }
    var html = '<thead><tr><th>Tanggal</th><th>Nama</th><th>Aksi<span class="sm" style="font-family:inherit">Est. nilai</span></th><th class="num">Perubahan<span class="sm">Lembar</span></th><th class="num">Sebelum<span class="sm">Lembar</span></th><th></th><th class="num">Sesudah<span class="sm">Lembar</span></th><th class="num">Harga</th><th>Broker</th><th>Tipe</th><th>Tujuan</th><th>Sumber</th></tr></thead><tbody>';
    if (!list.length) html += '<tr><td colspan="12" style="text-align:center;color:var(--text3);padding:20px">Tidak ada transaksi untuk filter ini.</td></tr>';
    list.forEach(function (t) {
      var key = t.date + '|' + t.name;
      var dPct = t.curPct - t.prevPct;
      html += '<tr data-act="insrow" data-v="' + t.idx + '" data-k="' + esc(key) + '"' + (S.insHl === key ? ' class="hl"' : '') + '>' +
        '<td>' + fmtDate(t.date) + '</td>' +
        '<td><span class="nm" data-act="insname" data-v="' + esc(t.name) + '">' + esc(t.name) + '</span><span class="smm-role">' + esc(t.role) + '</span></td>' +
        '<td><span class="smm-act ' + t.action + '">' + (t.action === 'BUY' ? 'BELI' : 'JUAL') + '</span><span class="sm ' + (t.action === 'BUY' ? 'smm-up' : 'smm-dn') + '">' + fmtVal(t.value, true) + '</span></td>' +
        '<td class="num ' + (t.action === 'BUY' ? 'smm-up' : 'smm-dn') + '">' + (dPct >= 0 ? '↗ ' : '↘ ') + nf(Math.abs(dPct), 4) + '%<span class="sm">' + nf(t.shares) + '</span></td>' +
        '<td class="num">' + nf(t.prevPct, 2) + '%<span class="sm">' + nf(t.prev) + '</span></td>' +
        '<td style="color:var(--text3)">→</td>' +
        '<td class="num ' + (t.action === 'BUY' ? 'smm-up' : 'smm-dn') + '">' + nf(t.curPct, 2) + '%<span class="sm">' + nf(t.cur) + '</span></td>' +
        '<td class="num">' + nf(t.price) + '</td>' +
        '<td>' + (t.broker === '-' ? '-' : '<span class="bk">' + esc(t.broker) + '</span>') + '</td>' +
        '<td><span style="color:var(--accent);font-weight:700" data-smm-tip="' + (t.type === 'D' ? 'Domestik' : 'Asing') + '">' + t.type + '</span></td>' +
        '<td>' + esc(t.tujuan) + '</td>' +
        '<td><span class="smm-src">' + t.src + '</span></td></tr>';
    });
    html += '</tbody>';
    document.getElementById('smmInsTbl').innerHTML = html;

    // Versi kartu untuk HP (tabel 12 kolom terlalu lebar)
    var cards = list.length ? '' : '<div class="smm-desc" style="text-align:center;padding:16px">Tidak ada transaksi untuk filter ini.</div>';
    list.forEach(function (t) {
      var key = t.date + '|' + t.name, buy = t.action === 'BUY';
      cards += '<div class="smm-icard' + (S.insHl === key ? ' hl' : '') + '" data-act="insrow" data-v="' + t.idx + '" data-k="' + esc(key) + '">' +
        '<div class="r1"><span class="smm-act ' + t.action + '">' + (buy ? '▲ BELI' : '▼ JUAL') + '</span><b class="' + (buy ? 'smm-up' : 'smm-dn') + '">' + fmtVal(t.value, true) + '</b><span class="d">' + fmtDate(t.date) + '</span></div>' +
        '<div class="r2"><span class="nm" data-act="insname" data-v="' + esc(t.name) + '">' + esc(t.name) + '</span><span class="smm-role">' + esc(t.role) + '</span></div>' +
        '<div class="r3"><span>' + nf(t.shares) + ' lembar @ ' + nf(t.price) + '</span><span>' + nf(t.prevPct, 2) + '% → <b class="' + (buy ? 'smm-up' : 'smm-dn') + '">' + nf(t.curPct, 2) + '%</b></span></div>' +
        '<div class="r4"><span class="smm-src">' + t.src + '</span>' + (t.broker !== '-' ? '<span class="smm-src">Broker ' + esc(t.broker) + '</span>' : '') + (t.tujuan !== '-' ? '<span class="smm-src">' + esc(t.tujuan) + '</span>' : '') + '</div>' +
      '</div>';
    });
    document.getElementById('smmInsCards').innerHTML = cards;
  }

  function renderInsider() {
    if (S.sub !== 'insider') { _dirty.insider = true; return; }
    _dirty.insider = false;
    renderPersonProfile();
    var g = G(), empty = !g.hasInsider || !g.nP;
    document.getElementById('smmPgInsider').classList.toggle('is-empty', empty);
    if (empty) { if (insChart) { try { insChart.remove(); } catch (_) {} insChart = null; } return; }
    renderInsSide(); renderInsTable(); buildInsChart();
  }

  // ─────────────────────────── Kepemilikan (halaman 3) ───────────────────────────
  var HO_COLORS = ['#7c3aed', '#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#14b8a6', '#ef4444', '#84cc16', '#06b6d4', '#a855f7', '#f97316', '#22c55e'];
  function compStats(c) {
    var L = 0, F = 0;
    CATS.forEach(function (k) { L += c.local[k.k] || 0; F += c.foreign[k.k] || 0; });
    var ret = (c.local.ID || 0) + (c.foreign.ID || 0), sl = L + F;
    return { local: L, foreign: F, scripless: sl, scrip: c.scrip || 0, fPct: sl ? F / sl * 100 : 0, lPct: sl ? L / sl * 100 : 0, retail: ret, retPct: sl ? ret / sl * 100 : 0 };
  }
  function sideCats(c, side) {
    var out = {}, tot = 0;
    CATS.forEach(function (k) {
      var v = (side !== 'foreign' ? (c.local[k.k] || 0) : 0) + (side !== 'local' ? (c.foreign[k.k] || 0) : 0);
      out[k.k] = v; tot += v;
    });
    return { cats: out, total: tot };
  }
  function ppTxt(v, dec) {
    if (!isFinite(v) || Math.abs(v) < Math.pow(10, -(dec == null ? 2 : dec)) / 2) return '<span class="smm-mute">0</span>';
    return '<span class="' + signCls(v) + '">' + (v > 0 ? '▲ ' : '▼ ') + nf(Math.abs(v), dec == null ? 2 : dec) + ' pp</span>';
  }
  function pctTxt(v) { return v > 0 && v < 0.0001 ? '<0,0001%' : nf(v, v < 0.01 && v > 0 ? 4 : 2) + '%'; }
  function personBtn(name, extra) { return '<button class="smm-name" data-act="person" data-v="' + esc(name) + '">' + esc(name) + '</button>' + (extra || ''); }
  function spark(vals, w, h) {
    if (!vals.length) return '';
    var mn = Math.min.apply(null, vals), mx = Math.max.apply(null, vals), rg = mx - mn || 1;
    var pts = vals.map(function (v, i) { return (vals.length === 1 ? w / 2 : i / (vals.length - 1) * w).toFixed(1) + ',' + (h - 2 - (v - mn) / rg * (h - 4)).toFixed(1); }).join(' ');
    var up = vals[vals.length - 1] >= vals[0];
    return '<svg class="smm-spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '"><polyline points="' + pts + '" fill="none" stroke="' + (mx === mn ? 'var(--text3)' : up ? 'var(--green)' : 'var(--red)') + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  }

  function renderHolder() {
    if (S.sub !== 'holder') { _dirty.holder = true; return; }
    _dirty.holder = false;
    var H = getHolder(S.code), pg = document.getElementById('smmPgHolder');
    var empty = !H || (!H.months.length && !H.holders.length && !H.count.length);
    pg.classList.toggle('is-empty', empty);
    if (empty) return;
    if (!S.hoMonth || H.months.indexOf(S.hoMonth) < 0) S.hoMonth = H.months[H.months.length - 1] || null;
    renderHoSum(H); renderHoMove(H); renderHoComp(H); renderHoChart(H); renderHoHolders(H); renderHoCount(H); renderHoProfile(H);
  }

  // ─────────────────────────── Kepemilikan: helper visual ───────────────────────────
  // Grafik garis/area kecil (SVG). pts = [{ l: label, v: nilai, tip: teks }]. Skala diperbesar ke
  // rentang data (bukan 0-100) supaya perubahan kecil terlihat.
  function hoLine(pts, o) {
    o = o || {};
    var W = o.w || 520, Hh = o.h || 150, P = { l: 8, r: o.yw || 54, t: 12, b: o.xl === false ? 6 : 20 };
    if (!pts.length) return '';
    var vs = pts.map(function (p) { return p.v; }), mn = Math.min.apply(null, vs), mx = Math.max.apply(null, vs);
    var pad = (mx - mn) * 0.18 || Math.abs(mx) * 0.02 || 1; mn -= pad; mx += pad;
    var iw = W - P.l - P.r, ih = Hh - P.t - P.b, n = pts.length;
    function X(i) { return P.l + (n === 1 ? iw / 2 : i / (n - 1) * iw); }
    function Y(v) { return P.t + (1 - (v - mn) / (mx - mn)) * ih; }
    var col = o.color || 'var(--accent)', id = 'g' + Math.random().toString(36).slice(2, 8);
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1); }).join(' ');
    var area = line + ' L' + X(n - 1).toFixed(1) + ' ' + (P.t + ih) + ' L' + X(0).toFixed(1) + ' ' + (P.t + ih) + ' Z';
    var grid = '', fmt = o.fmt || function (v) { return nf(v, 2); };
    var ly = Y(pts[pts.length - 1].v);
    for (var g = 0; g <= 2; g++) { var gv = mn + (mx - mn) * (g / 2), gy = Y(gv); if (Math.abs(gy - (ly - 7)) < 13) { grid += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) + '" class="gl"/>'; continue; } grid += '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) + '" class="gl"/><text x="' + (W - P.r + 6) + '" y="' + (gy + 3.5).toFixed(1) + '" class="yl">' + esc(fmt(gv)) + '</text>'; }
    var xl = '';
    if (o.xl !== false) [0, Math.floor((n - 1) / 2), n - 1].filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (i) {
      xl += '<text x="' + X(i).toFixed(1) + '" y="' + (Hh - 4) + '" class="xl" text-anchor="' + (i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle') + '">' + esc(pts[i].l) + '</text>';
    });
    var hit = pts.map(function (p, i) {
      var x0 = i ? (X(i - 1) + X(i)) / 2 : P.l, x1 = i < n - 1 ? (X(i) + X(i + 1)) / 2 : W - P.r;
      return '<rect x="' + x0.toFixed(1) + '" y="' + P.t + '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + ih + '" fill="transparent" data-smm-tip="' + esc(p.tip || (p.l + ': ' + fmt(p.v))) + '"/>';
    }).join('');
    var lp = pts[n - 1];
    return '<svg class="smm-hl" viewBox="0 0 ' + W + ' ' + Hh + '" role="img">' +
      '<defs><linearGradient id="' + id + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + col + '" stop-opacity=".35"/><stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' +
      grid + '<path d="' + area + '" fill="url(#' + id + ')"/><path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="2.2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      pts.map(function (p, i) { return '<circle cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="' + (i === n - 1 ? 4 : 2.4) + '" fill="' + (i === n - 1 ? col : 'var(--card)') + '" stroke="' + col + '" stroke-width="1.6" vector-effect="non-scaling-stroke"/>'; }).join('') +
      '<text x="' + (W - P.r + 6) + '" y="' + (Y(lp.v) - 7).toFixed(1) + '" class="lv" style="fill:' + col + '">' + esc(fmt(lp.v)) + '</text>' +
      xl + hit + '</svg>';
  }
  // Batang perubahan (positif ke atas hijau, negatif ke bawah merah) di sekitar garis nol.
  function hoDeltas(ds, tips, h) {
    var mx = Math.max.apply(null, ds.map(function (d) { return Math.abs(d); })) || 1;
    return '<div class="smm-hd" style="height:' + (h || 54) + 'px">' + ds.map(function (d, i) {
      var p = Math.abs(d) / mx * 50;
      return '<span data-smm-tip="' + esc(tips[i]) + '"><i class="' + (d > 0 ? 'u' : d < 0 ? 'd' : 'z') + '" style="height:' + Math.max(d ? 3 : 1, p).toFixed(1) + '%"></i></span>';
    }).join('') + '</div>';
  }
  function hoDonut(segs, size, center, sub) {
    var R = 42, C = 2 * Math.PI * R, tot = segs.reduce(function (a, s) { return a + s.v; }, 0) || 1, off = 0;
    var arcs = segs.map(function (s) {
      var len = s.v / tot * C, a = '<circle r="' + R + '" cx="50" cy="50" fill="none" stroke="' + s.c + '" stroke-width="14" stroke-dasharray="' + Math.max(0, len - 0.6).toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '" data-smm-tip="' + esc(s.l + ': ' + nf(s.v / tot * 100, 2) + '%') + '"/>';
      off += len; return a;
    }).join('');
    return '<svg class="smm-donut" viewBox="0 0 100 100" width="' + size + '" height="' + size + '"><g transform="rotate(-90 50 50)"><circle r="' + R + '" cx="50" cy="50" fill="none" stroke="var(--bg3)" stroke-width="14"/>' + arcs + '</g>' +
      '<text x="50" y="48" text-anchor="middle" class="c1">' + esc(center) + '</text><text x="50" y="62" text-anchor="middle" class="c2">' + esc(sub || '') + '</text></svg>';
  }
  function hoRing(pct, col) {
    var R = 15, C = 2 * Math.PI * R, v = clamp(pct, 0, 100) / 100 * C;
    return '<svg class="smm-ring" viewBox="0 0 40 40" width="40" height="40"><circle r="' + R + '" cx="20" cy="20" fill="none" stroke="var(--bg3)" stroke-width="5"/>' +
      '<circle r="' + R + '" cx="20" cy="20" fill="none" stroke="' + (col || 'var(--accent)') + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + v.toFixed(2) + ' ' + C.toFixed(2) + '" transform="rotate(-90 20 20)"/></svg>';
  }
  function hoPill(d, dec, unit) {
    dec = dec == null ? 2 : dec;
    if (d == null || !isFinite(d)) return '<span class="smm-pill n">baru</span>';
    if (Math.abs(d) < Math.pow(10, -dec) / 2) return '<span class="smm-pill n">tetap</span>';
    return '<span class="smm-pill ' + (d > 0 ? 'u' : 'd') + '">' + (d > 0 ? '▲ ' : '▼ ') + nf(Math.abs(d), dec) + (unit == null ? ' pp' : unit) + '</span>';
  }
  function initials(n) { var w = String(n || '').replace(/^(PT|BAPAK|IBU)\s+/i, '').split(/\s+/).filter(Boolean); return ((w[0] || '?').charAt(0) + (w[1] ? w[1].charAt(0) : '')).toUpperCase(); }
  function hoIsPublic(n) { return /^MASYARAKAT|^SAHAM TREASURY|^TREASURY/i.test(n); }

  function renderHoSum(H) {
    var m = H.months, last = m[m.length - 1], m3 = m[Math.max(0, m.length - 4)];
    var c1 = last && H.comp[last] ? compStats(H.comp[last]) : null, c3 = m3 && H.comp[m3] ? compStats(H.comp[m3]) : null;
    var cn = H.count, cl = cn[cn.length - 1], cp = cn[cn.length - 2], c3n = cn[Math.max(0, cn.length - 4)];
    var cChg3 = cl && c3n ? (cl.count / c3n.count - 1) * 100 : 0;
    var retD = c1 && c3 ? c1.retPct - c3.retPct : 0, fD = c1 && c3 ? c1.fPct - c3.fPct : 0;
    var big = last && H.mv[last] ? H.mv[last].reduce(function (a, x) { return a + x.pct; }, 0) : 0;
    var ff = H.profile && H.profile.freeFloat != null ? H.profile.freeFloat : Math.max(0, 100 - big);
    var k, head, desc, ico;
    if (cChg3 < -2 && retD <= 0.05) { k = 'a'; ico = '🧲'; head = 'Saham sedang dikumpulkan'; desc = 'Jumlah pemegang turun ' + nf(Math.abs(cChg3), 1) + '% dalam 3 bulan dan porsi ritel tidak naik. Barang berpindah dari banyak tangan kecil ke lebih sedikit pemain besar.'; }
    else if (cChg3 > 2 && retD >= -0.05) { k = 'd'; ico = '📤'; head = 'Saham menyebar ke ritel'; desc = 'Jumlah pemegang naik ' + nf(cChg3, 1) + '% dalam 3 bulan dan porsi ritel ikut naik. Waspada distribusi dari pemain besar ke ritel.'; }
    else { k = 'n'; ico = '⚖️'; head = 'Kepemilikan relatif stabil'; desc = 'Belum ada perpindahan besar antara ritel dan pemain besar dalam 3 bulan terakhir.'; }
    function chk(v, good) { return v === 0 || Math.abs(v) < 0.05 ? ['n', '➖'] : (good ? ['g', '✓'] : ['b', '!']); }
    var facts = [];
    if (c1) { var a1 = chk(fD, fD > 0); facts.push('<li class="' + a1[0] + '"><i>' + a1[1] + '</i><span>Asing</span><b>' + nf(c1.fPct, 2) + '%</b>' + hoPill(fD) + '</li>'); }
    if (c1) { var a2 = chk(retD, retD < 0); facts.push('<li class="' + a2[0] + '"><i>' + a2[1] + '</i><span>Ritel</span><b>' + nf(c1.retPct, 2) + '%</b>' + hoPill(retD) + '</li>'); }
    if (cl) { var a3 = chk(cChg3, cChg3 < 0); facts.push('<li class="' + a3[0] + '"><i>' + a3[1] + '</i><span>Pemegang</span><b>' + nf(cl.count) + '</b>' + hoPill(cChg3, 1, '%') + '</li>'); }
    var fSeries = m.slice(-12).filter(function (x) { return H.comp[x]; }).map(function (x) { return compStats(H.comp[x]).fPct; });
    var cSeries = cn.slice(-12).map(function (x) { return x.count; });
    document.getElementById('smmHoSum').innerHTML =
      '<div class="smm-card smm-verdict smm-hov k-' + k + '"><div class="smm-hov-ico">' + ico + '</div><div class="smm-hov-b"><h4>Sinyal kepemilikan · ' + esc(S.code) + (last ? ' · ' + monthLabel(last, true) : '') + '</h4>' +
        '<div class="big">' + head + '</div><p>' + desc + '</p><ul class="smm-hof">' + facts.join('') + '</ul><small class="smm-mute">Perubahan dibanding 3 bulan lalu.</small></div>' +
        '<span style="position:absolute;top:10px;right:10px">' + tip('Logika sederhana: jumlah pemegang turun + porsi ritel turun = barang dikumpulkan (akumulasi). Jumlah pemegang naik + ritel naik = barang dibagikan ke ritel (distribusi). Sumber data: KSEI bulanan.') + '</span></div>' +
      '<div class="smm-card smm-kpi smm-hok"><h4>🌏 Kepemilikan asing ' + tip('Porsi saham scripless yang dipegang investor asing (data KSEI akhir bulan).') + '</h4>' +
        '<div class="v">' + (c1 ? nf(c1.fPct, 2) + '%' : '-') + '</div>' + (c1 ? hoPill(fD) + ' <small class="smm-mute">3 bln</small>' : '') +
        '<div class="sp">' + spark(fSeries, 140, 30) + '</div><p>' + (c1 ? 'Lokal ' + nf(c1.lPct, 2) + '%. Garis = tren 12 bulan.' : 'Belum ada data komposisi.') + '</p></div>' +
      '<div class="smm-card smm-kpi smm-hok"><h4>👥 Jumlah pemegang ' + tip('Jumlah investor yang memegang saham ini per akhir bulan. Turun = saham terkumpul di lebih sedikit tangan.') + '</h4>' +
        '<div class="v">' + (cl ? nf(cl.count) : '-') + '</div>' + (cl && cp ? hoPill(cl.count - cp.count, 0, '') + ' <small class="smm-mute">dari bulan lalu</small>' : '') +
        '<div class="sp">' + spark(cSeries, 140, 30) + '</div><p>' + (cl ? fmtPct(cChg3) + ' dalam 3 bulan.' : '') + '</p></div>' +
      '<div class="smm-card smm-kpi smm-hok"><h4>🎯 Konsentrasi ' + tip('Total porsi pemegang di atas 1%. Free float = porsi yang beredar di publik. Konsentrasi tinggi + free float kecil = harga lebih mudah digerakkan.') + '</h4>' +
        '<div class="smm-hok-r">' + hoRing(big, '#7c3aed') + '<div><div class="v">' + nf(big, 2) + '%</div><small class="smm-mute">dipegang pemegang &gt;1%</small></div></div>' +
        '<div class="smm-hok-r">' + hoRing(ff, '#10b981') + '<div><div class="v sm">' + nf(ff, 2) + '%</div><small class="smm-mute">free float (publik)</small></div></div></div>';
  }

  function monthChips(H, act) {
    return H.months.slice(-12).map(function (m) {
      return '<button data-act="' + act + '" data-v="' + m + '" class="' + (m === S.hoMonth ? 'on' : '') + '">' + monthLabel(m) + '</button>';
    }).join('');
  }

  function renderHoMove(H) {
    var m = S.hoMonth, i = H.months.indexOf(m), pm = i > 0 ? H.months[i - 1] : null;
    var cur = (H.mv[m] || []).slice().sort(function (a, b) { return b.pct - a.pct; });
    var prev = {}; (pm ? H.mv[pm] || [] : []).forEach(function (x) { prev[x.name] = x; });
    var curNames = {}; cur.forEach(function (x) { curNames[x.name] = 1; });
    var gone = pm ? (H.mv[pm] || []).filter(function (x) { return !curNames[x.name]; }) : [];
    var px = H.price || 0, up = 0, dn = 0, nw = 0, tot = { pct: 0, val: 0, sh: 0, sl: 0, sc: 0 };
    var maxP = cur.length ? cur[0].pct : 1;
    var bar = '', left = 100, legend = '';
    cur.forEach(function (x, k) {
      var c = HO_COLORS[k % HO_COLORS.length]; left -= x.pct;
      bar += '<i style="width:' + x.pct.toFixed(3) + '%;background:' + c + '" data-smm-tip="' + esc(x.name + ': ' + nf(x.pct, 2) + '%') + '"></i>';
      if (k < 6) legend += '<span><i style="background:' + c + '"></i>' + esc(x.name.length > 26 ? x.name.slice(0, 24) + '…' : x.name) + ' <b>' + nf(x.pct, 1) + '%</b></span>';
    });
    if (left > 0) { bar += '<i style="width:' + left.toFixed(3) + '%;background:var(--bg4)" data-smm-tip="' + esc('Publik & pemegang < 1%: ' + nf(left, 2) + '%') + '"></i>'; legend += '<span><i style="background:var(--bg4)"></i>Publik &amp; &lt;1% <b>' + nf(left, 1) + '%</b></span>'; }
    var rows = cur.map(function (x, k) {
      var p = prev[x.name], d = p ? x.pct - p.pct : null, dSl = p ? x.scripless - p.scripless : 0, c = HO_COLORS[k % HO_COLORS.length];
      if (!p && pm) nw++; else if (d > 0.0005) up++; else if (d < -0.0005) dn++;
      var hist = H.months.slice(-12).map(function (mm) { var r = (H.mv[mm] || []).filter(function (y) { return y.name === x.name; })[0]; return r ? r.pct : 0; });
      var val = x.shares * px;
      tot.pct += x.pct; tot.val += val; tot.sh += x.shares; tot.sl += x.scripless; tot.sc += x.scrip;
      return '<div class="smm-hm' + (d != null && d > 0.0005 ? ' up' : d != null && d < -0.0005 ? ' dn' : '') + '" style="--c:' + c + '">' +
        '<span class="rk">' + (k + 1) + '</span>' +
        '<div class="mn"><div class="t">' + personBtn(x.name) + (!p && pm ? ' <span class="smm-new">BARU</span>' : '') + ' <span class="smm-tag">' + esc(x.type) + '</span></div>' +
          '<div class="pb"><i style="width:' + (x.pct / maxP * 100).toFixed(2) + '%"></i></div>' +
          '<div class="mt"><span>' + nf(x.shares) + ' lembar</span>' + (px ? '<span>≈ ' + fmtVal(val, true) + '</span>' : '') +
            '<span>Scripless ' + nf(x.scripless) + (p && dSl ? ' <em class="' + signCls(dSl) + '">' + (dSl > 0 ? '+' : '−') + nf(Math.abs(dSl)) + '</em>' : '') + '</span><span>Scrip ' + nf(x.scrip) + '</span></div></div>' +
        '<div class="pc"><b>' + nf(x.pct, 2) + '%</b>' + (pm ? hoPill(d) : '') + (p && Math.abs(d) > 0.0005 ? '<small>dari ' + nf(p.pct, 2) + '%</small>' : '') + '</div>' +
        '<div class="sk">' + spark(hist, 92, 30) + '<small>12 bln</small></div></div>';
    }).join('');
    var goneRows = gone.map(function (x) {
      return '<div class="smm-hm gone" style="--c:var(--text3)"><span class="rk">×</span><div class="mn"><div class="t">' + personBtn(x.name) + ' <span class="smm-tag">' + esc(x.type) + '</span></div><div class="mt"><span>Bulan lalu ' + nf(x.shares) + ' lembar</span></div></div>' +
        '<div class="pc"><b>&lt;1%</b><span class="smm-pill d">keluar daftar</span><small>dari ' + nf(x.pct, 2) + '%</small></div><div class="sk"></div></div>';
    }).join('');
    var chips = m ? '<div class="smm-hchips">' +
      '<span class="c u">▲ ' + up + ' menambah</span><span class="c d">▼ ' + dn + ' mengurangi</span>' +
      (nw ? '<span class="c p">＋ ' + nw + ' masuk daftar</span>' : '') + (gone.length ? '<span class="c x">× ' + gone.length + ' keluar daftar</span>' : '') +
      '<span class="c n">Bulan ' + monthLabel(m, true) + (pm ? ' vs ' + monthLabel(pm, true) : '') + '</span></div>' : '';
    document.getElementById('smmHoMoveMonths').innerHTML = monthChips(H, 'homonth');
    document.getElementById('smmHoMoveSub').textContent = '· ' + S.code + ' · update ' + fmtDate(H.updated || lastDay(m || H.months[0]));
    document.getElementById('smmHoBar').innerHTML = bar;
    document.getElementById('smmHoMoveTxt').innerHTML = (legend ? '<div class="smm-hleg">' + legend + '</div>' : '') + chips;
    document.getElementById('smmHoMoveTbl').innerHTML = cur.length ?
      '<div class="smm-hms">' + rows + goneRows + '</div>' +
      '<div class="smm-htot"><b>TOTAL pemegang &gt;1%</b><span><b>' + nf(tot.pct, 2) + '%</b></span>' + (px ? '<span>≈ ' + fmtVal(tot.val, true) + '</span>' : '') +
        '<span>' + fmtLot(tot.sh) + ' lembar</span><span>Scripless ' + fmtLot(tot.sl) + '</span><span>Scrip ' + fmtLot(tot.sc) + '</span></div>'
      : '<div class="smm-desc" style="text-align:center;padding:16px">Belum ada data pemegang &gt;1% bulan ini.</div>';
  }

  function renderHoComp(H) {
    var m = S.hoMonth, i = H.months.indexOf(m), pm = i > 0 ? H.months[i - 1] : null;
    var box = document.getElementById('smmHoComp');
    document.getElementById('smmHoCompMonths').innerHTML = monthChips(H, 'homonth');
    syncSeg('smmHoSide', S.hoSide);
    var c = H.comp[m];
    if (!c) { box.innerHTML = '<div class="smm-desc" style="padding:12px">Belum ada data komposisi bulan ini.</div>'; return; }
    var st = compStats(c), sc = sideCats(c, S.hoSide), pc = pm && H.comp[pm] ? sideCats(H.comp[pm], S.hoSide) : null;
    var tot = sc.total, ret = sc.cats.ID || 0, inst = tot - ret;
    var cats = CATS.map(function (k) { return { k: k, v: sc.cats[k.k] || 0, p: tot ? (sc.cats[k.k] || 0) / tot * 100 : 0, pp: pc && pc.total ? (pc.cats[k.k] || 0) / pc.total * 100 : null }; })
      .filter(function (x) { return x.v > 0; }).sort(function (a, b) { return b.v - a.v; });
    function vs(ia, la, a, ca, ib, lb, b, cb) {
      var s = a + b || 1, pa = a / s * 100;
      return '<div class="smm-vs"><div class="hd"><span>' + ia + ' ' + la + '</span><span>' + lb + ' ' + ib + '</span></div>' +
        '<div class="br"><i style="width:' + pa.toFixed(2) + '%;background:' + ca + '"></i><i style="width:' + (100 - pa).toFixed(2) + '%;background:' + cb + '"></i></div>' +
        '<div class="ft"><span><b style="color:' + ca + '">' + nf(pa, 2) + '%</b> · ' + fmtLot(a) + '</span><span>' + fmtLot(b) + ' · <b style="color:' + cb + '">' + nf(100 - pa, 2) + '%</b></span></div></div>';
    }
    var sideLbl = S.hoSide === 'local' ? 'lokal' : S.hoSide === 'foreign' ? 'asing' : 'scripless';
    var first = S.hoSide === 'all' ? vs('📄', 'Scrip', st.scrip, '#60a5fa', '💾', 'Scripless', st.scripless, '#8b5cf6')
      : vs(S.hoSide === 'local' ? '🇮🇩' : '🌏', S.hoSide === 'local' ? 'Lokal' : 'Asing', S.hoSide === 'local' ? st.local : st.foreign, S.hoSide === 'local' ? '#7c3aed' : '#ef4444',
        S.hoSide === 'local' ? '🌏' : '🇮🇩', S.hoSide === 'local' ? 'Asing' : 'Lokal', S.hoSide === 'local' ? st.foreign : st.local, S.hoSide === 'local' ? '#ef4444' : '#7c3aed');
    var rp = ret / (tot || 1) * 100;
    box.innerHTML =
      '<div class="smm-hcomp">' +
        '<div class="dn">' + hoDonut(cats.map(function (x) { return { v: x.v, c: x.k.color, l: x.k.label }; }), 150, fmtLot(tot), 'saham ' + sideLbl) + '</div>' +
        '<div class="lg">' + cats.map(function (x) {
          var d = x.pp == null ? null : x.p - x.pp;
          return '<div class="r" data-smm-tip="' + esc(x.k.label + ': ' + nf(x.v) + ' lembar (' + nf(x.p, 2) + '%)' + (x.pp != null ? ' · bulan lalu ' + nf(x.pp, 2) + '%' : '')) + '">' +
            '<i style="background:' + x.k.color + '"></i><span class="l">' + x.k.label + '<small>' + fmtLot(x.v) + '</small></span><b>' + nf(x.p, 2) + '%</b>' + (pc ? hoPill(d) : '') + '</div>';
        }).join('') + '</div>' +
      '</div>' +
      first + vs('👤', 'Ritel', ret, '#84cc16', '🏦', 'Institusi', inst, '#10b981') +
      '<div class="smm-insight">💡 ' + (rp < 10 ? 'Saham ini didominasi <b>institusi</b> (' + nf(100 - rp, 1) + '%). Pergerakan harga lebih ditentukan pemain besar.' : 'Porsi <b>ritel</b> cukup besar (' + nf(rp, 1) + '%). Harga lebih mudah bergejolak karena banyak investor kecil.') + '</div>';
  }

  function renderHoChart(H) {
    var ms = H.months.slice(-12).filter(function (m) { return H.comp[m]; }), box = document.getElementById('smmHoChart');
    syncSeg('smmHoChartMode', S.hoChart);
    var kpi = document.getElementById('smmHoChartKpi');
    if (!ms.length) { kpi.innerHTML = ''; box.innerHTML = '<div class="smm-desc">Belum ada data.</div>'; return; }
    var stats = ms.map(function (m) { return compStats(H.comp[m]); }), last = stats[stats.length - 1], first = stats[0];
    var fD = last.fPct - first.fPct;
    kpi.innerHTML = '<div><span>🇮🇩 Lokal</span><b style="color:#7c3aed">' + nf(last.lPct, 2) + '%</b></div><div><span>🌏 Asing</span><b style="color:#ef4444">' + nf(last.fPct, 2) + '%</b></div>';
    if (S.hoChart === 'lf') {
      var pts = ms.map(function (m, k) { return { l: monthLabel(m), v: stats[k].fPct, tip: monthLabel(m, true) + ' · Asing ' + nf(stats[k].fPct, 2) + '% · Lokal ' + nf(stats[k].lPct, 2) + '%' }; });
      var ds = stats.map(function (s, k) { return k ? s.fPct - stats[k - 1].fPct : 0; });
      box.innerHTML = '<div class="smm-hct"><b>Porsi asing</b> ' + hoPill(fD) + ' <small class="smm-mute">dalam ' + ms.length + ' bulan · skala diperbesar agar perubahan kecil terlihat</small></div>' +
        hoLine(pts, { color: '#ef4444', fmt: function (v) { return nf(v, 2) + '%'; }, h: 160 }) +
        '<div class="smm-hct2">Perubahan asing per bulan (pp)</div>' +
        hoDeltas(ds, ms.map(function (m, k) { return monthLabel(m, true) + ': ' + (ds[k] >= 0 ? '+' : '−') + nf(Math.abs(ds[k]), 3) + ' pp'; }), 46) +
        '<div class="smm-hmon">' + ms.map(function (m) { return '<span>' + monthLabel(m).split(' ')[0] + '</span>'; }).join('') + '</div>';
    } else {
      var rows = CATS.map(function (k) {
        var vals = ms.map(function (m) { var sc = sideCats(H.comp[m], 'all'); return sc.total ? (sc.cats[k.k] || 0) / sc.total * 100 : 0; });
        return { k: k, vals: vals, cur: vals[vals.length - 1], d: vals[vals.length - 1] - vals[0] };
      }).filter(function (x) { return x.vals.some(function (v) { return v > 0; }); }).sort(function (a, b) { return b.cur - a.cur; });
      box.innerHTML = '<div class="smm-hct"><b>Tiap kategori</b> <small class="smm-mute">porsi kini, tren ' + ms.length + ' bulan, dan perubahan sejak ' + monthLabel(ms[0], true) + '</small></div>' +
        '<div class="smm-hcats">' + rows.map(function (x) {
          return '<div class="r" data-smm-tip="' + esc(x.k.label + ': ' + ms.map(function (m, j) { return monthLabel(m) + ' ' + nf(x.vals[j], 2) + '%'; }).join(' · ')) + '">' +
            '<span class="l"><i style="background:' + x.k.color + '"></i>' + x.k.label + '</span>' + spark(x.vals, 110, 26) + '<b>' + nf(x.cur, 2) + '%</b>' + hoPill(x.d) + '</div>';
        }).join('') + '</div>';
    }
  }

  function renderHoHolders(H) {
    var tagCls = function (t) { return /Pengendali/i.test(t) ? 'ctl' : /Treasury/i.test(t) ? 'trs' : ''; };
    var maxP = H.holders.reduce(function (a, x) { return Math.max(a, x.pct); }, 0) || 1;
    var map = '', ci = 0, rest = 100;
    var hs = H.holders.map(function (x) {
      var pub = hoIsPublic(x.name), c = pub ? 'var(--text3)' : HO_COLORS[ci++ % HO_COLORS.length];
      rest -= x.pct;
      map += '<i style="width:' + Math.max(0, x.pct).toFixed(3) + '%;background:' + c + (pub ? ';opacity:.45' : '') + '" data-smm-tip="' + esc(x.name + ': ' + pctTxt(x.pct)) + '"></i>';
      return '<div class="smm-hh" style="--c:' + c + '"><div class="t">' + (pub ? '<span class="smm-plain">' + esc(x.name) + '</span>' : personBtn(x.name)) + (x.tag ? ' <span class="smm-tag ' + tagCls(x.tag) + '">' + esc(x.tag) + '</span>' : '') + '</div>' +
        '<div class="v"><span class="mono-n">' + fmtLot(x.shares) + '</span><b class="mono-n">' + pctTxt(x.pct) + '</b></div>' +
        '<div class="pb"><i style="width:' + (x.pct / maxP * 100).toFixed(2) + '%"></i></div></div>';
    }).join('');
    if (rest > 0.05 && H.holders.length) map += '<i style="width:' + rest.toFixed(3) + '%;background:var(--bg4)" data-smm-tip="' + esc('Lainnya: ' + nf(rest, 2) + '%') + '"></i>';
    var bd = H.board.slice().sort(function (a, b) { return b.shares - a.shares; }).map(function (x) {
      var kom = x.board === 'komisaris';
      return '<div class="smm-hp"><span class="smm-av ' + (kom ? 'kom' : 'dir') + '">' + esc(initials(x.name)) + '</span><div class="t">' + personBtn(x.name) + '<small>' + esc(x.role || (kom ? 'Komisaris' : 'Direksi')) + '</small></div>' +
        '<div class="v"><span class="mono-n">' + (x.shares ? fmtLot(x.shares) + ' lbr' : 'tidak memegang') + '</span><b class="mono-n">' + (x.shares ? pctTxt(x.pct) : '-') + '</b></div></div>';
    }).join('');
    var ub = H.ubo.map(function (x) {
      return '<div class="smm-chain"><span class="nd p"><i>👤</i>' + personBtn(x.name) + '</span><span class="ar">→</span><span class="nd v"><i>🏢</i>' + esc(x.via || '-') + (x.vehicle ? '<small>' + esc(x.vehicle) + '</small>' : '') + '</span><span class="ar">→</span><span class="nd s"><b>' + esc(S.code) + '</b><em>' + nf(x.pct, 2) + '%</em></span></div>';
    }).join('');
    document.getElementById('smmHoHolders').innerHTML =
      (map ? '<div class="smm-hmap">' + map + '</div><small class="smm-mute">Peta kepemilikan: lebar warna = porsi saham. Abu-abu = publik.</small>' : '') +
      '<div class="smm-hsec"><div class="smm-hhead2"><span>🏛️ Pemegang saham</span><span>Lembar · Porsi</span></div>' + (hs || '<div class="smm-desc">-</div>') + '</div>' +
      '<div class="smm-hsec"><div class="smm-hhead2"><span>👔 Direksi &amp; Komisaris</span><span>Lembar · Porsi</span></div>' + (bd || '<div class="smm-desc">-</div>') + '</div>' +
      '<div class="smm-hsec"><div class="smm-hhead2"><span>🔗 Pemilik Manfaat Akhir (UBO) ' + tip('Ultimate Beneficial Owner: orang yang pada akhirnya menguasai saham lewat perusahaan perantara.') + '</span><span>Porsi</span></div>' + (ub || '<div class="smm-desc">Belum ada data UBO.</div>') + '</div>';
  }

  function renderHoCount(H) {
    var cn = H.count.slice(-24), box = document.getElementById('smmHoCount');
    if (!cn.length) { box.innerHTML = '<div class="smm-desc">Belum ada data jumlah pemegang.</div>'; return; }
    var last = cn[cn.length - 1], prev = cn[cn.length - 2], d1 = prev ? last.count - prev.count : 0;
    var y1 = cn[Math.max(0, cn.length - 13)], dy = last.count - y1.count;
    var ds = cn.map(function (x, i) { return i ? x.count - cn[i - 1].count : 0; });
    var ups = ds.slice(1).filter(function (d) { return d > 0; }).length, dns = ds.slice(1).filter(function (d) { return d < 0; }).length;
    var pts = cn.map(function (x, i) { return { l: fmtDate(x.date), v: x.count, tip: fmtDate(x.date, true) + ': ' + nf(x.count) + ' pemegang (' + (ds[i] >= 0 ? '+' : '−') + nf(Math.abs(ds[i])) + ')' }; });
    var list = cn.slice().reverse().slice(0, 12).map(function (x, i) {
      var p = cn[cn.length - 2 - i], d = p ? x.count - p.count : 0;
      return '<div class="smm-crow2"><span>' + fmtDate(x.date, true) + '</span><b class="mono-n">' + nf(x.count) + '</b>' + hoPill(p ? d : 0, 0, '') + '</div>';
    }).join('');
    box.innerHTML =
      '<div class="smm-cbig"><b>' + nf(last.count) + '</b> ' + hoPill(d1, 0, '') + ' <small>' + fmtDate(last.date, true) + '</small></div>' +
      '<div class="smm-ckv"><span>1 tahun <b class="' + signCls(dy) + '">' + (dy >= 0 ? '+' : '−') + nf(Math.abs(dy)) + '</b></span><span>Bulan naik <b class="smm-up">' + ups + '</b></span><span>Bulan turun <b class="smm-dn">' + dns + '</b></span></div>' +
      hoLine(pts, { color: '#3b82f6', fmt: function (v) { return fmtLot(v); }, h: 140 }) +
      '<div class="smm-hct2">Perubahan per bulan</div>' + hoDeltas(ds, pts.map(function (p) { return p.tip; }), 44) +
      '<div class="smm-insight" style="margin-top:8px">💡 Pemegang <b>bertambah</b> biasanya berarti saham menyebar ke ritel. Pemegang <b>berkurang</b> berarti saham terkumpul di lebih sedikit tangan.</div>' +
      '<div class="smm-clist2">' + list + '</div>';
  }

  function renderHoProfile(H) {
    var P = H.profile || {};
    function group(arr, cls) {
      var by = {}, order = [];
      arr.forEach(function (x) { var k = x.role || '-'; if (!by[k]) { by[k] = []; order.push(k); } by[k].push(x.name); });
      return order.map(function (k) {
        return '<div class="smm-brole"><small>' + esc(k) + '</small><div>' + by[k].map(function (n) { return '<span class="smm-bp"><span class="smm-av ' + cls + '">' + esc(initials(n)) + '</span>' + personBtn(n) + '</span>'; }).join('') + '</div></div>';
      }).join('') || '<div class="smm-desc">-</div>';
    }
    var dir = H.board.filter(function (x) { return x.board === 'direksi'; }), kom = H.board.filter(function (x) { return x.board === 'komisaris'; });
    var tiles = [['🏷️', 'Sektor', P.sector], ['🧩', 'Sub sektor', P.subSector], ['🏭', 'Industri', P.industry], ['🔧', 'Sub industri', P.subIndustry],
      ['📅', 'Tanggal listing', P.listingDate ? fmtDate(P.listingDate, true) : ''], ['💵', 'Harga IPO', P.ipoPrice ? nf(P.ipoPrice) : ''],
      ['💰', 'Dana IPO', P.ipoAmount ? fmtVal(P.ipoAmount, true) : ''], ['📦', 'Saham IPO', P.ipoShares ? nf(P.ipoShares) : '']].filter(function (x) { return x[2]; });
    var px = H.price || 0, ipoRet = P.ipoPrice && px ? (px / P.ipoPrice - 1) * 100 : null;
    document.getElementById('smmHoBoard').innerHTML =
      '<div class="smm-h3">👔 Dewan Direksi <small>' + dir.length + ' orang</small></div>' + group(dir, 'dir') +
      '<div class="smm-h3" style="margin-top:14px">🛡️ Dewan Komisaris <small>' + kom.length + ' orang</small></div>' + group(kom, 'kom');
    document.getElementById('smmHoCompany').innerHTML =
      '<div class="smm-h3">🏢 Profil perusahaan</div>' +
      (tiles.length ? '<div class="smm-tiles">' + tiles.map(function (x) { return '<div class="tl"><i>' + x[0] + '</i><span>' + x[1] + '</span><b>' + esc(x[2]) + '</b></div>'; }).join('') + '</div>' : '') +
      (P.freeFloat != null || ipoRet != null ? '<div class="smm-tiles">' +
        (P.freeFloat != null ? '<div class="tl wide">' + hoRing(P.freeFloat, '#10b981') + '<span>Free float</span><b>' + nf(P.freeFloat, 2) + '%</b></div>' : '') +
        (ipoRet != null ? '<div class="tl wide"><i>📈</i><span>Harga kini vs IPO</span><b class="' + signCls(ipoRet) + '">' + nf(px) + ' (' + fmtPct(ipoRet) + ')</b></div>' : '') + '</div>' : '') +
      (P.underwriters && P.underwriters.length ? '<div class="smm-uw"><small>🤝 Penjamin emisi</small><div>' + P.underwriters.map(function (u) { return '<span>' + esc(u) + '</span>'; }).join('') + '</div></div>' : '') +
      (tiles.length || (P.underwriters && P.underwriters.length) ? '' : '<div class="smm-desc">Profil perusahaan belum tersedia.</div>');
  }

  // ─────────────────────────── Pencarian: saham / broker / nama ───────────────────────────
  function normName(n) { return String(n || '').toUpperCase().replace(/^(BAPAK|BPK\.?|IBU|SDR\.?|SDRI\.?)\s+/, '').replace(/\s+/g, ' ').trim(); }
  function allCodes() {
    var list = universe().slice();
    if (list.indexOf(S.code) < 0) list.push(S.code);
    return list;
  }
  function knownNames() {
    var set = {};
    allCodes().forEach(function (c) {
      var g = getData(c);
      g.trades.forEach(function (t) { set[normName(t.name)] = t.name; });
      var H = getHolder(c);
      if (H) {
        H.board.forEach(function (b) { set[normName(b.name)] = b.name; });
        H.ubo.forEach(function (u) { set[normName(u.name)] = normName(u.name); });
        var lm = H.months[H.months.length - 1];
        (H.mv[lm] || []).forEach(function (x) { if (!/^MASYARAKAT|TREASURY/.test(x.name)) set[normName(x.name)] = x.name; });
      }
    });
    return Object.keys(set).sort();
  }
  function rebuildSuggest() {}   // saran dibuat langsung saat mengetik (lihat suggestSearch)
  // Saran pencarian: sama seperti kolom cari di Dashboard (kode/nama saham, maks 12,
  // kode · nama · sektor), ditambah kode broker dan nama orang dalam yang cocok.
  function stockList() {
    var list = [];
    try { if (typeof DATA !== 'undefined' && DATA && DATA.stock_list) list = DATA.stock_list; } catch (_) {}
    if (!list.length) list = allCodes().map(function (c) { return { code: c, name: c, sector: '' }; });
    return list;
  }
  function suggestSearch(raw) {
    var drop = document.getElementById('smmDrop'); if (!drop) return;
    var q = String(raw || '').trim().toUpperCase();
    if (!q) { drop.classList.remove('open'); drop.innerHTML = ''; return; }
    var st = stockList().filter(function (x) { return x.code.indexOf(q) >= 0 || String(x.name || '').toUpperCase().indexOf(q) >= 0; })
      .sort(function (a, b) { return (a.code.indexOf(q) === 0 ? 0 : 1) - (b.code.indexOf(q) === 0 ? 0 : 1); }).slice(0, 12);
    var bks = q.length >= 2 ? brokerList().filter(function (b) { return b.code === q || (q.length >= 3 && String(b.name).toUpperCase().indexOf(q) >= 0); }).slice(0, 4) : [];
    var N = normName(q), ppl = q.length >= 3 ? knownNames().filter(function (n) { return n.indexOf(N) >= 0; }).slice(0, 4) : [];
    var html = st.map(function (x) {
      return '<div class="search-item" role="option" data-sk="s" data-v="' + esc(x.code) + '"><span class="code">' + esc(x.code) + '</span><span class="sname">' + esc(x.name || '') + '</span><span class="sector">' + esc(x.sector || '') + '</span></div>';
    }).join('');
    if (bks.length) html += '<div class="smm-drop-h">Broker</div>' + bks.map(function (b) {
      return '<div class="search-item" role="option" data-sk="b" data-v="' + esc(b.code) + '"><span class="code">' + esc(b.code) + '</span><span class="sname">' + esc(titleCase(b.name)) + '</span><span class="sector">' + (b.foreign ? 'Asing' : 'Lokal') + '</span></div>';
    }).join('');
    if (ppl.length) html += '<div class="smm-drop-h">Orang dalam / pemegang</div>' + ppl.map(function (n) {
      return '<div class="search-item" role="option" data-sk="p" data-v="' + esc(n) + '"><span class="sname">👤 ' + esc(n) + '</span></div>';
    }).join('');
    drop.innerHTML = html;
    drop.classList.toggle('open', !!html);
  }
  function closeSuggest() { var d = document.getElementById('smmDrop'); if (d) d.classList.remove('open'); }

  function doSearch(q) {
    q = String(q || '').trim();
    if (!q) return;
    var head = q.split(' · ')[0].trim(), up = head.toUpperCase();
    var bk = brokerList().filter(function (b) { return b.code === up; })[0];
    if (/^[A-Z]{2}$/.test(up) && bk) { setBroker(up); return; }
    // kode saham yang dikenal (daftar saham situs + saham pantauan) → langsung buka
    var known = allCodes().slice();
    try { if (typeof DATA !== 'undefined' && DATA && DATA.stock_list) DATA.stock_list.forEach(function (s) { known.push(s.code); }); } catch (_) {}
    if (/^[A-Z0-9]{4,6}$/.test(up) && known.indexOf(up) >= 0) { openCodeFromSearch(up); return; }
    var N = normName(q), names2 = knownNames();
    var hit = names2.filter(function (n) { return n === N; })[0] || names2.filter(function (n) { return n.indexOf(N) >= 0; })[0];
    var exactName = names2.filter(function (n) { return n === N; })[0];
    if (exactName) { setPerson(exactName); return; }
    // seperti Dashboard: kode/nama saham yang mengandung teks yang diketik → saham pertama
    var sm = stockList().filter(function (x) { return x.code.indexOf(up) >= 0 || String(x.name || '').toUpperCase().indexOf(up) >= 0; })[0];
    if (sm) { openCodeFromSearch(sm.code); return; }
    if (hit) { setPerson(hit); return; }
    if (/^[A-Z0-9]{2,6}$/.test(up)) { openCodeFromSearch(up); return; }
    toast('Tidak ditemukan: ' + q);
  }
  // Dari Screener: kalender ikut saham baru; tampilan lain pindah ke Broker Activity.
  function openCodeFromSearch(code) {
    if (S.sub === 'screener') {
      var sx = window.SmartMoneyScreener;
      setCode(code);
      if (!(sx && sx.codeChanged && sx.codeChanged(code))) setSub('broker');
      return;
    }
    setCode(code);
  }
  function setBroker(code) {
    S.broker = code;
    var g = G();
    if (g.brokers.some(function (b) { return b.code === code; }) && S.chips.indexOf(code) < 0) { S.chips.push(code); colorFor(code); }
    S.hidden[code] = false;
    renderFilters();
    _dirty.broker = true;
    setSub('broker', true);
    if (!_dirty.broker) renderBroker();
    var card = document.getElementById('smmBkProfile');
    if (card) window.scrollTo({ top: Math.max(0, card.getBoundingClientRect().top + window.pageYOffset - stickyTop() - 80), behavior: 'smooth' });
  }
  function setPerson(name) {
    S.person = name;
    var N = normName(name);
    var own = G().trades.filter(function (t) { return normName(t.name) === N; })[0];
    S.insName = own ? own.name : null;
    renderFilters();
    _dirty.insider = true;
    setSub('insider', true);
    var card = document.getElementById('smmPersonCard');
    if (card) window.scrollTo({ top: Math.max(0, card.getBoundingClientRect().top + window.pageYOffset - stickyTop() - 80), behavior: 'smooth' });
  }
  function renderFilters() {
    var el = document.getElementById('smmActive'); if (!el) return;
    var html = '';
    if (S.broker) {
      var b = brokerList().filter(function (x) { return x.code === S.broker; })[0];
      html += '<span class="smm-ftag2" data-act="gobroker">🏦 Broker <b>' + esc(S.broker) + '</b>' + (b ? ' · ' + esc(titleCase(b.name)) : '') + '<span class="x" data-act="clrbroker" aria-label="Hapus filter broker">×</span></span>';
    }
    if (S.person) html += '<span class="smm-ftag2" data-act="goperson">👤 <b>' + esc(S.person) + '</b><span class="x" data-act="clrperson" aria-label="Hapus filter nama">×</span></span>';
    el.innerHTML = html;
    el.hidden = !html;
  }

  // Profil broker lintas saham (di halaman Broker Activity)
  function renderBrokerProfile() {
    var card = document.getElementById('smmBkProfile'); if (!card) return;
    if (!S.broker) { card.hidden = true; return; }
    card.hidden = false;
    var code = S.broker, meta = brokerList().filter(function (b) { return b.code === code; })[0] || { code: code, name: code, foreign: false };
    var type = brokerType(meta);
    var rows = [];
    allCodes().forEach(function (c) {
      var g = getData(c); if (!g.hasBroker) return;
      var t0 = periodStart(g, S.period), agg = aggregate(g, t0, g.nF - 1, g.hasForeign ? S.inv : 'all');
      var x = agg.filter(function (y) { return y.code === code; })[0]; if (!x || (!x.bv && !x.sv)) return;
      var tv = turnover(g, t0, g.nF - 1) || 1;
      var rank = agg.slice().sort(function (a, b) { return b.net - a.net; }).findIndex(function (y) { return y.code === code; }) + 1;
      var chg = (g.ohlc[g.nP - 1].close / g.ohlc[g.off + t0].open - 1) * 100;
      rows.push({ c: c, net: x.net, bv: x.bv, sv: x.sv, bAvg: x.bAvg, sAvg: x.sAvg, share: (x.bv + x.sv) / (2 * tv) * 100, rank: rank, n: agg.length, chg: chg, real: g.real, px: g.ohlc[g.nP - 1].close });
    });
    rows.sort(function (a, b) { return b.net - a.net; });
    var tot = rows.reduce(function (a, x) { return a + x.net; }, 0), nAcc = rows.filter(function (x) { return x.net > 0; }).length, nDis = rows.filter(function (x) { return x.net < 0; }).length;
    var mx = rows.reduce(function (a, x) { return Math.max(a, Math.abs(x.net)); }, 1);
    var best = rows[0], worst = rows[rows.length - 1];
    var lines = rows.map(function (x) {
      var w = Math.abs(x.net) / mx * 50, gain = x.bAvg ? (x.px / x.bAvg - 1) * 100 : 0;
      return '<div class="smm-dvrow' + (x.c === S.code ? ' on' : '') + '" data-act="quick" data-v="' + x.c + '">' +
        '<span class="c">' + x.c + '</span>' +
        '<span class="dv"><i class="' + (x.net >= 0 ? 'p' : 'n') + '" style="width:' + w.toFixed(1) + '%"></i></span>' +
        '<span class="n ' + signCls(x.net) + '">' + fmtVal(x.net) + '</span>' +
        '<span class="n hm2" data-smm-tip="Rata-rata beli ' + esc(code) + ' vs harga sekarang">' + (x.bAvg ? nf(x.bAvg) + ' <small class="' + signCls(gain) + '">' + fmtPct(gain) + '</small>' : '-') + '</span>' +
        '<span class="n hm2" data-smm-tip="Porsi broker ini dari total transaksi saham tsb">' + nf(x.share, 1) + '%</span></div>';
    }).join('');
    card.innerHTML =
      '<div class="smm-h3">🏦 Profil broker ' + bkTag(code, type, titleCase(meta.name)) + ' <small>' + esc(titleCase(meta.name)) + ' · ' + TYPE_META[type].label + ' · ' + PERIOD_TEXT[S.period] + ' · ' + rows.length + ' saham</small>' + tip('Aktivitas broker ini di semua saham pantauan pada periode terpilih. Klik baris untuk membuka saham itu.') + '</div>' +
      (rows.length ? '<div class="smm-bkkpi">' +
        '<div><span>Total net</span><b class="' + signCls(tot) + '">' + fmtVal(tot, true) + '</b></div>' +
        '<div><span>Dikumpulkan</span><b class="smm-up">' + nAcc + ' saham</b></div>' +
        '<div><span>Dilepas</span><b class="smm-dn">' + nDis + ' saham</b></div>' +
        '<div><span>Terbesar</span><b>' + (best && best.net > 0 ? best.c + ' ' + fmtVal(best.net) : '-') + '</b></div></div>' +
        '<p class="smm-desc" style="margin:10px 0">💡 Dalam ' + PERIOD_TEXT[S.period] + ', ' + esc(code) + ' paling banyak <b class="smm-up">mengumpulkan ' + (best && best.net > 0 ? best.c : '-') + '</b>' +
          (worst && worst.net < 0 ? ' dan paling banyak <b class="smm-dn">melepas ' + worst.c + '</b>' : '') + '.</p>' +
        '<div class="smm-dvhead"><span>Saham</span><span>Jual ◀ net ▶ Beli</span><span>Net</span><span class="hm2">Avg beli</span><span class="hm2">Porsi</span></div>' + lines
        : '<div class="smm-desc">Broker ' + esc(code) + ' tidak bertransaksi di saham pantauan pada periode ini.</div>');
  }

  // Profil orang lintas saham (di halaman Insider)
  function renderPersonProfile() {
    var card = document.getElementById('smmPersonCard'); if (!card) return;
    if (!S.person) { card.hidden = true; return; }
    card.hidden = false;
    var N = normName(S.person), tx = [], hold = [];
    allCodes().forEach(function (c) {
      var g = getData(c);
      g.trades.forEach(function (t) { if (normName(t.name) === N) tx.push({ c: c, t: t }); });
      var H = getHolder(c); if (!H) return;
      var lm = H.months[H.months.length - 1];
      (H.mv[lm] || []).forEach(function (x) { if (normName(x.name) === N) hold.push({ c: c, role: x.type, pct: x.pct, shares: x.shares }); });
      H.board.forEach(function (b) { if (normName(b.name) === N) hold.push({ c: c, role: b.role || (b.board === 'komisaris' ? 'Komisaris' : 'Direksi'), pct: b.pct, shares: b.shares }); });
      H.ubo.forEach(function (u) { if (normName(u.name) === N) hold.push({ c: c, role: 'UBO via ' + u.via, pct: u.pct, shares: 0 }); });
    });
    var seen = {}; hold = hold.filter(function (h) { var k = h.c + '|' + h.role; if (seen[k]) return false; seen[k] = 1; return true; });
    tx.sort(function (a, b) { return a.t.date < b.t.date ? 1 : -1; });
    var buy = 0, sell = 0, nb = 0, ns = 0;
    tx.forEach(function (x) { if (x.t.action === 'BUY') { buy += x.t.value; nb++; } else { sell += x.t.value; ns++; } });
    var stocks = {}; tx.forEach(function (x) { stocks[x.c] = 1; }); hold.forEach(function (h) { stocks[h.c] = 1; });
    var shown = S.personAll ? tx : tx.slice(0, 8);
    card.innerHTML =
      '<div class="smm-h3">👤 ' + esc(S.person) + ' <small>' + Object.keys(stocks).length + ' saham terkait · ' + tx.length + ' transaksi</small>' + tip('Semua jejak nama ini di saham pantauan: transaksi insider, kepemilikan >1%, jabatan direksi/komisaris, dan UBO.') + '</div>' +
      '<div class="smm-bkkpi">' +
        '<div><span>Total beli</span><b class="smm-up">' + fmtVal(buy, true) + ' <small>(' + nb + 'x)</small></b></div>' +
        '<div><span>Total jual</span><b class="smm-dn">' + fmtVal(sell, true) + ' <small>(' + ns + 'x)</small></b></div>' +
        '<div><span>Net</span><b class="' + signCls(buy - sell) + '">' + fmtVal(buy - sell, true) + '</b></div>' +
        '<div><span>Terakhir</span><b>' + (tx[0] ? fmtDate(tx[0].t.date) + ' · ' + tx[0].c : '-') + '</b></div></div>' +
      (hold.length ? '<div class="smm-pchips">' + hold.map(function (h) {
        return '<button class="smm-pchip' + (h.c === S.code ? ' on' : '') + '" data-act="quick" data-v="' + h.c + '"><b>' + h.c + '</b> ' + esc(h.role) + (h.pct ? ' · ' + pctTxt(h.pct) : '') + '</button>';
      }).join('') + '</div>' : '') +
      (tx.length ? '<div class="smm-tbl-wrap"><table class="smm-tbl smm-ptbl"><thead><tr><th>Tanggal</th><th>Saham</th><th>Aksi</th><th>Nilai</th><th class="hm">Lembar</th><th class="hm">Harga</th><th>Sesudah</th></tr></thead><tbody>' +
        shown.map(function (x) {
          var t = x.t, b = t.action === 'BUY';
          return '<tr data-act="quick" data-v="' + x.c + '"' + (x.c === S.code ? ' class="hl"' : '') + '><td>' + fmtDate(t.date) + '</td><td><b class="mono-n" style="color:var(--accent)">' + x.c + '</b></td>' +
            '<td><span class="smm-act ' + t.action + '">' + (b ? 'BELI' : 'JUAL') + '</span></td><td class="' + (b ? 'smm-up' : 'smm-dn') + '">' + fmtVal(t.value, true) + '</td>' +
            '<td class="hm">' + nf(t.shares) + '</td><td class="hm">' + nf(t.price) + '</td><td>' + (t.curPct ? nf(t.curPct, 2) + '%' : '-') + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        (tx.length > 8 ? '<button class="smm-btn smm-more" data-act="personall">' + (S.personAll ? 'Tampilkan 8 terbaru' : 'Lihat semua (' + tx.length + ')') + '</button>' : '')
        : '<div class="smm-desc" style="margin-top:8px">Tidak ada transaksi insider atas nama ini di saham pantauan.</div>');
  }

  // ─────────────────────────── Render & event ───────────────────────────
  function syncSeg(id, val) {
    var el = document.getElementById(id); if (!el) return;
    el.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === val); });
  }
  function syncControls() {
    syncSeg('smmPeriod', S.period); syncSeg('smmMetric', S.metric); syncSeg('smmPriceMode', S.priceMode);
    syncSeg('smmSkMetric', S.skMetric); syncSeg('smmInsSrc', S.insSrc); syncSeg('smmInsRange', S.insRange);
    root.querySelectorAll('.smm-subtabs button').forEach(function (b) { var on = b.getAttribute('data-v') === S.sub; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
    document.getElementById('smmCode').value = S.code;
    document.getElementById('smmInv').value = S.inv;
    document.getElementById('smmInsAct').value = S.insAct;
    var g = G(), bd = document.getElementById('smmSrcBadge');
    if (bd) {
      bd.textContent = g.real ? 'Data asli · ' + fmtDate(g.updated || g.end) : (_real[S.code] === undefined || (_real[S.code] && _real[S.code].then) ? 'Memuat data…' : 'Belum ada data');
      bd.className = 'smm-badge ' + (g.real ? 'real' : 'none');
    }
    var inv = document.getElementById('smmInv');
    inv.disabled = !g.hasForeign;
    inv.title = g.hasForeign ? '' : 'Data porsi asing belum tersedia untuk saham ini';
  }
  function renderFlowAll() { renderChips(); buildFlow(); renderFlowInsight(); }
  // Halaman yang tersembunyi ditandai "kotor" dan baru dirender saat dibuka,
  // supaya grafik dibangun dengan ukuran container yang benar.
  var _dirty = { broker: true, insider: true, holder: true };
  function renderBroker() {
    if (S.sub !== 'broker') { _dirty.broker = true; return; }
    _dirty.broker = false;
    var g = G(), pg = document.getElementById('smmPgBroker');
    pg.classList.toggle('is-empty', !g.hasBroker);
    renderBrokerProfile();
    if (!g.hasBroker) { renderRadar(); return; }
    if (S.actEnd > g.nF - 1 || S.actEnd < 0) S.actEnd = g.nF - 1;
    renderSummary(); renderFlowAll(); renderAction(); renderSankey(); renderRadar();
  }
  function renderAll() {
    syncControls();
    _dirty.broker = _dirty.insider = _dirty.holder = true;
    renderFilters(); rebuildSuggest();
    renderBroker(); renderInsider(); renderHolder();
  }
  // ── Screener (sub-tab 4) dimuat dinamis supaya file ini tidak membengkak.
  // Naikkan SCR_V setiap kali smartmoney-screener.js diubah (cache-busting).
  var SCR_V = '20261110e', _scrP = null;
  function ensureScreener() {
    if (window.SmartMoneyScreener) return Promise.resolve();
    if (_scrP) return _scrP;
    _scrP = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = '/smartmoney-screener.js?v=' + SCR_V;
      s.onload = res; s.onerror = function () { _scrP = null; rej(new Error('gagal memuat screener')); };
      document.head.appendChild(s);
    });
    return _scrP;
  }
  var screenerApi = {
    esc: esc, nf: nf, fmtVal: fmtVal, fmtLot: fmtLot, fmtPct: fmtPct, hashStr: hashStr, rng: rng, gauss: gauss, shuffle: shuffle,
    tip: tip, toast: toast, bkTag: bkTag, brokerList: brokerList, brokerType: brokerType, titleCase: titleCase,
    loadOhlc: function () { return loadOhlc(); }, loadReal: loadReal,
    index: function () { return _index; },
    code: function () { return S.code; },
    openStock: function (code) { setCode(code); setSub('broker'); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  };
  function showScreener() {
    var pg = document.getElementById('smmPgScreener');
    if (!window.SmartMoneyScreener) pg.innerHTML = '<div class="smm-card" style="text-align:center;padding:40px 16px;color:var(--text2)">Memuat Screener…</div>';
    ensureScreener().then(function () { if (S.sub === 'screener') window.SmartMoneyScreener.show(pg, screenerApi); })
      .catch(function () { pg.innerHTML = '<div class="smm-card" style="text-align:center;padding:40px 16px;color:var(--red)">Screener gagal dimuat. Periksa koneksi lalu buka lagi tab ini.</div>'; });
  }
  function setSub(v, noScroll) {
    if (v !== 'broker' && v !== 'insider' && v !== 'holder' && v !== 'screener') v = 'broker';
    S.sub = v;
    try { localStorage.setItem('smm_sub', v); } catch (_) {}
    document.getElementById('smmPgBroker').hidden = v !== 'broker';
    document.getElementById('smmPgInsider').hidden = v !== 'insider';
    document.getElementById('smmPgHolder').hidden = v !== 'holder';
    document.getElementById('smmPgScreener').hidden = v !== 'screener';
    root.setAttribute('data-smm-sub', v);
    syncControls();
    if (v === 'screener') showScreener();
    if (v === 'broker' && _dirty.broker) renderBroker();
    else if (v === 'broker') renderSankey();
    if (v === 'insider' && _dirty.insider) renderInsider();
    if (v === 'holder' && _dirty.holder) renderHolder();
    if (!noScroll) {
      var bar = document.getElementById('smmBar');
      var y = root.getBoundingClientRect().top + window.pageYOffset - stickyTop();
      if (window.pageYOffset > y) window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }
  }
  // Tinggi header + running ticker → posisi bar lengket
  function stickyTop() {
    var off = 0;
    var tb = document.querySelector('.top-bar');
    if (tb && getComputedStyle(tb).position !== 'static') off = Math.max(off, tb.getBoundingClientRect().bottom);
    var tk = document.getElementById('stockTicker');
    if (tk && getComputedStyle(tk).display !== 'none' && getComputedStyle(tk).position !== 'static') off = Math.max(off, tk.getBoundingClientRect().bottom);
    return Math.max(0, Math.round(off));
  }
  function updateSticky() { if (root) root.style.setProperty('--smm-top', stickyTop() + 'px'); }
  function setCode(code) {
    code = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(code)) { toast('Kode saham tidak valid'); return; }
    S.code = code; S.skFocus = null; S.insName = null; S.insHl = null; S.actAll = false; S.insAll = false; S.hoMonth = null;
    var pending = _real[code] === undefined;
    if (pending) toast('Memuat data ' + code + '…');
    loadReal(code).then(function () {
      if (S.code !== code) return;              // user sudah pindah saham lain
      var g = G();
      S.actEnd = g.nF - 1;
      if (!g.hasForeign) S.inv = 'all';
      defaultChips();
      if (S.broker && g.brokers.some(function (b) { return b.code === S.broker; }) && S.chips.indexOf(S.broker) < 0) { S.chips.push(S.broker); colorFor(S.broker); }
      if (S.person) { var own = g.trades.filter(function (t) { return normName(t.name) === normName(S.person); })[0]; S.insName = own ? own.name : null; }
      renderAll();
    });
  }
  function addChip(code) {
    if (S.chips.indexOf(code) < 0) { S.chips.push(code); colorFor(code); toast(code + ' ditambahkan ke Broker Flow'); }
    delete S.hidden[code];
    renderFlowAll();
    var c = root.querySelector('.smm-chip[data-v="' + code + '"]');
    if (c) c.classList.add('flash');
  }

  function onClick(e) {
    var node = e.target.closest && e.target.closest('[data-node]');
    if (node && root.contains(node)) {
      var id = node.getAttribute('data-node');
      var g = G(), r = actRange();
      var cur = S.skFocus;
      if (cur == null) { var rows = aggregate(g, r[0], r[1], S.inv).sort(function (a, b) { return b.bv - a.bv; }); cur = rows.length ? 'b:' + rows[0].code : null; }
      S.skFocus = cur === id ? '*' : id;
      renderSankey(); return;
    }
    var el = e.target.closest && e.target.closest('[data-act]');
    if (!el || !root.contains(el)) {
      var m = document.getElementById('smmAddMenu'); if (m) m.classList.remove('open');
      return;
    }
    var act = el.getAttribute('data-act'), v = el.getAttribute('data-v');
    switch (act) {
      case 'sub': setSub(v); break;
      case 'load': closeSuggest(); doSearch(document.getElementById('smmCode').value); break;
      case 'person': e.stopPropagation(); setPerson(v); break;
      case 'gobroker': if (S.broker) setBroker(S.broker); break;
      case 'goperson': if (S.person) setPerson(S.person); break;
      case 'clrbroker': e.stopPropagation(); S.broker = null; renderFilters(); renderBrokerProfile(); renderAction(); break;
      case 'clrperson': e.stopPropagation(); S.person = null; S.insName = null; S.personAll = false; renderFilters(); _dirty.insider = true; if (S.sub === 'insider') renderInsider(); break;
      case 'personall': S.personAll = !S.personAll; renderPersonProfile(); break;
      case 'homonth': S.hoMonth = v; renderHolder(); break;
      case 'hoside': S.hoSide = v; renderHoComp(getHolder(S.code)); break;
      case 'hochart': S.hochart = v; S.hoChart = v; renderHoChart(getHolder(S.code)); break;
      case 'period': S.period = v; syncControls(); renderBrokerProfile(); if (G().hasBroker) { renderSummary(); renderFlowAll(); } renderRadar(); break;
      case 'metric': S.metric = v; syncControls(); buildFlow(); renderFlowInsight(); break;
      case 'pmode': S.priceMode = v; syncControls(); renderChips(); buildFlow(); break;
      case 'chipprice': S.showPrice = !S.showPrice; renderChips(); if (flowSeries.__price) flowSeries.__price.applyOptions({ visible: S.showPrice }); flowLegend(null); break;
      case 'chip': S.hidden[v] = !S.hidden[v]; renderChips(); if (flowSeries[v]) flowSeries[v].applyOptions({ visible: !S.hidden[v] }); flowLegend(null); break;
      case 'chipx': e.stopPropagation(); S.chips = S.chips.filter(function (c) { return c !== v; }); delete S.colors[v]; renderFlowAll(); break;
      case 'addopen': e.stopPropagation(); document.getElementById('smmAddMenu').classList.toggle('open'); break;
      case 'chipadd': addChip(v); break;
      case 'dprev': if (S.actEnd > 0) { S.actEnd--; S.skFocus = null; renderAction(); renderSankey(); } break;
      case 'calday': S.actEnd = +v; S.skFocus = null; renderAction(); renderSankey(); { var ab = document.getElementById('smmActionCard'); if (ab && window.innerWidth < 1100) ab.scrollIntoView({ block: 'start', behavior: 'smooth' }); } break;
      case 'calmon': { var cp = S.cal.ym.split('-'), cd = new Date(Date.UTC(+cp[0], +cp[1] - 1 + +v, 1)); S.cal.ym = cd.toISOString().slice(0, 7); renderCal(); } break;
      case 'dnext': if (S.actEnd < G().nF - 1) { S.actEnd++; S.skFocus = null; renderAction(); renderSankey(); } break;
      case 'actsort':
        var side = el.getAttribute('data-side'), key = el.getAttribute('data-key');
        S.actSort = { side: side, key: key }; renderAction(); break;
      case 'actall': S.actAll = !S.actAll; renderAction(); break;
      case 'bkpick': addChip(v); S.skFocus = null; break;
      case 'skmetric': S.skMetric = v; syncControls(); renderSankey(); break;
      case 'insrange': S.insRange = v; syncControls(); insRange(); break;
      case 'inssrc': S.insSrc = v; syncControls(); renderInsider(); break;
      case 'insname': e.stopPropagation(); S.insName = S.insName === v ? null : v; renderInsider(); break;
      case 'insall': S.insAll = !S.insAll; renderInsTable(); break;
      case 'insclear': S.insName = null; renderInsider(); break;
      case 'insrow':
        S.insHl = el.getAttribute('data-k');
        root.querySelectorAll('#smmInsTbl tr.hl, .smm-icard.hl').forEach(function (r) { r.classList.remove('hl'); });
        el.classList.add('hl');
        insRange(+v);
        document.getElementById('smmInsChart').scrollIntoView({ block: 'center', behavior: 'smooth' });
        break;
    }
  }
  function onChange(e) {
    var id = e.target.id;
    if (id === 'smmInv') { S.inv = e.target.value; S.skFocus = null; renderAll(); }
    else if (id === 'smmActWin') { S.actWin = +e.target.value; S.skFocus = null; renderAction(); renderSankey(); }
    else if (id === 'smmActMode') { S.actMode = e.target.value; renderAction(); }
    else if (id === 'smmActPick') {
      var g = G(), val = e.target.value, idx = -1;
      for (var t = g.nF - 1; t >= 0; t--) { if (g.days[g.off + t] <= val) { idx = t; break; } }
      if (idx < 0) idx = 0;
      S.actEnd = idx; S.skFocus = null; renderAction(); renderSankey();
    }
    else if (id === 'smmCalGrp') { S.cal.grp = e.target.value; renderCal(); }
    else if (id === 'smmInsAct') { S.insAct = e.target.value; renderInsider(); }
  }

  // Tooltip (info "i", kode broker, sel heatmap) + tooltip sankey
  function popEl() {
    var p = document.getElementById('smmPop');
    if (!p) { p = document.createElement('div'); p.id = 'smmPop'; document.body.appendChild(p); }
    return p;
  }
  function ttEl() {
    var p = document.getElementById('smmTT');
    if (!p) { p = document.createElement('div'); p.id = 'smmTT'; document.body.appendChild(p); }
    return p;
  }
  function showPop(target) {
    var p = popEl();
    p.textContent = target.getAttribute('data-smm-tip');
    p.classList.add('show');
    var r = target.getBoundingClientRect();
    var w = p.offsetWidth, h = p.offsetHeight;
    var x = clamp(r.left + r.width / 2 - w / 2, 8, window.innerWidth - w - 8);
    var y = r.top - h - 8; if (y < 8) y = r.bottom + 8;
    p.style.left = x + 'px'; p.style.top = y + 'px';
  }
  function hidePop() { var p = document.getElementById('smmPop'); if (p) p.classList.remove('show'); }
  function onOver(e) {
    var t = e.target.closest && e.target.closest('[data-smm-tip]');
    if (t && root.contains(t)) showPop(t); else hidePop();
    var link = e.target.closest && e.target.closest('.smm-sk-link');
    var nodeG = e.target.closest && e.target.closest('.smm-sk-node');
    var tt = ttEl();
    var fmt = S.skMetric === 'value' ? function (v) { return fmtVal(v, true); } : function (v) { return fmtLot(v) + ' lot'; };
    if (link) {
      var L = _skLinks[+link.getAttribute('data-l')];
      if (L) {
        tt.innerHTML = '<b class="bk t-' + (L.b.type === 'O' ? 'D' : L.b.type) + '">' + esc(L.b.code) + '</b> → <b class="bk t-' + (L.s.type === 'O' ? 'D' : L.s.type) + '">' + esc(L.s.code) + '</b><br>' + fmt(L.v) +
          '<br><span style="color:var(--text3)">' + nf(L.v / (L.b.tot || 1) * 100, 1) + '% dari pembelian ' + esc(L.b.code) + ' · ' + nf(L.v / (L.s.tot || 1) * 100, 1) + '% dari penjualan ' + esc(L.s.code) + '</span>';
        tt.style.display = 'block';
        link.setAttribute('opacity', '0.9');
        link._smmHover = true;
      }
    } else if (nodeG) {
      var id = nodeG.getAttribute('data-node'), isB = id.indexOf('b:') === 0, code = id.slice(2);
      var tot = 0, name = code;
      _skLinks.forEach(function (l) { var n = isB ? l.b : l.s; if (n.code === code) { tot = n.tot; name = n.name; } });
      tt.innerHTML = '<b>' + esc(code) + '</b> · ' + esc(name) + '<br>' + (isB ? 'Total beli ' : 'Total jual ') + fmt(tot) + '<br><span style="color:var(--text3)">Ketuk untuk fokus</span>';
      tt.style.display = 'block';
    } else {
      tt.style.display = 'none';
    }
  }
  function onOut(e) {
    var link = e.target.closest && e.target.closest('.smm-sk-link');
    if (link && link._smmHover) { link._smmHover = false; renderSankeyOpacityReset(link); }
  }
  function renderSankeyOpacityReset(link) {
    var fill = link.getAttribute('fill') || '';
    link.setAttribute('opacity', fill.indexOf('url(') === 0 ? '0.72' : '0.06');
  }
  function onMove(e) {
    var tt = document.getElementById('smmTT');
    if (tt && tt.style.display === 'block') {
      var x = e.clientX + 14, y = e.clientY + 14;
      if (x + tt.offsetWidth > window.innerWidth - 8) x = e.clientX - tt.offsetWidth - 14;
      if (y + tt.offsetHeight > window.innerHeight - 8) y = e.clientY - tt.offsetHeight - 14;
      tt.style.left = x + 'px'; tt.style.top = y + 'px';
    }
  }

  function bind() {
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    root.addEventListener('mousemove', onMove);
    root.addEventListener('mouseleave', function () { hidePop(); var tt = document.getElementById('smmTT'); if (tt) tt.style.display = 'none'; });
    document.addEventListener('click', function (e) {
      if (!root.contains(e.target)) { var m = document.getElementById('smmAddMenu'); if (m) m.classList.remove('open'); }
    });
    var codeIn = document.getElementById('smmCode'), drop = document.getElementById('smmDrop');
    codeIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); closeSuggest(); doSearch(e.target.value); codeIn.blur(); }
      else if (e.key === 'Escape') closeSuggest();
    });
    codeIn.addEventListener('input', function (e) { suggestSearch(e.target.value); });
    drop.addEventListener('mousedown', function (e) { e.preventDefault(); });   // jaga fokus input sampai klik selesai
    drop.addEventListener('click', function (e) {
      var it = e.target.closest('.search-item[data-sk]'); if (!it) return;
      e.stopPropagation();
      var k = it.getAttribute('data-sk'), v = it.getAttribute('data-v');
      closeSuggest(); codeIn.blur();
      if (k === 's') openCodeFromSearch(v); else if (k === 'b') setBroker(v); else setPerson(v);
    });
    document.addEventListener('click', function (e) { if (!e.target.closest('.smm-searchwrap')) closeSuggest(); });
    document.getElementById('smmCode').addEventListener('focus', function (e) { e.target.select(); });
    // Ganti tema → bangun ulang grafik dengan warna baru
    new MutationObserver(function () { if (!_built) return; if (S.sub === 'broker') { buildFlow(); renderSankey(); } else if (S.sub !== 'screener') buildInsChart(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { if (_built && root.classList.contains('active')) { updateSticky(); if (S.sub === 'broker') renderSankey(); } }, 200);
    });
  }

  function open() {
    root = document.getElementById('page-smartmoney');
    if (!root) return;
    if (!_built) {
      root.innerHTML = skeleton();
      bind();
      defaultChips();
      _built = true;
      try { var sv = localStorage.getItem('smm_sub'); S.sub = sv === 'insider' || sv === 'holder' || sv === 'screener' ? sv : 'broker'; } catch (_) {}
      renderAll();
      setSub(S.sub, true);
      // Data asli: index dulu → saham pertama yang punya data → muat radar di belakang
      loadIndex().then(function (codes) {
        if (codes.length && codes.indexOf(S.code) < 0) S.code = codes[0];
        return Promise.all(universe().map(loadReal));
      }).then(function () { setCode(S.code); });
    } else if (S.sub === 'broker') {
      renderSankey(); // lebar container bisa berubah saat halaman tersembunyi
    }
    updateSticky();
  }

  // ─────────────────────────── Injeksi (hanya admin) ───────────────────────────
  function inject() {
    if (document.getElementById('page-smartmoney')) return;
    var st = document.createElement('style'); st.id = 'smmStyle'; st.textContent = CSS; document.head.appendChild(st);

    var pages = document.querySelectorAll('.page');
    var page = document.createElement('div');
    page.className = 'page'; page.id = 'page-smartmoney';
    // Sisipkan setelah halaman Tracker (sebelum footer) supaya urutan tampilan rapi.
    var anchor = document.getElementById('page-tracker') || pages[pages.length - 1];
    if (anchor) anchor.parentNode.insertBefore(page, anchor.nextSibling); else document.body.appendChild(page);

    var tabs = document.querySelector('.nav-tabs');
    if (tabs) {
      var tab = document.createElement('div');
      tab.className = 'nav-tab smm-nav';
      tab.setAttribute('onclick', "showPage('smartmoney');SmartMoney.open()");
      tab.innerHTML = '<span class="smm-nav-ico" aria-hidden="true">💰</span><span class="smm-nav-lbl"> Smart Money</span>';
      tab.title = 'Smart Money (admin)';
      var tr = document.getElementById('tabTracker');
      if (tr && tr.parentNode === tabs) tabs.insertBefore(tab, tr.nextSibling); else tabs.appendChild(tab);
    }
    var bn = document.getElementById('bottomNav');
    if (bn) {
      var b = document.createElement('button');
      b.className = 'bottom-nav-item'; b.id = 'bn-smartmoney'; b.type = 'button';
      b.setAttribute('onclick', "showPageMobile('smartmoney',this);SmartMoney.open()");
      b.innerHTML = '<span class="bn-icon">💰</span>Smart $';
      bn.appendChild(b);
    }
    var an = document.getElementById('acctNav');
    if (an) {
      var subs = [['Broker Activity', 'broker', ''], ['Broker Flow', 'broker', '#smmFlowCard'], ['Broker Action', 'broker', '#smmActionCard'], ['Distribusi', 'broker', '#smmSankeyCard'], ['Radar', 'broker', '#smmRadarCard'], ['Insider', 'insider', ''], ['Daftar Transaksi Insider', 'insider', '#smmInsListCard'], ['Kepemilikan', 'holder', ''], ['Pemegang > 1%', 'holder', '#smmHoMoveCard'], ['Jumlah Pemegang', 'holder', '#smmHoCountCard'], ['Screener', 'screener', '']];
      var grp = document.createElement('div');
      grp.className = 'acct-nav-group'; grp.setAttribute('data-page', 'smartmoney');
      grp.innerHTML = '<button type="button" class="acct-nav-page" data-smm-go=""><span class="acct-nav-ico" aria-hidden="true">💰</span>Smart Money</button><div class="acct-nav-subs">' +
        subs.map(function (s) { return '<button type="button" class="acct-nav-sub" data-smm-sub="' + s[1] + '" data-smm-go="' + s[2] + '">' + s[0] + '</button>'; }).join('') + '</div>';
      an.appendChild(grp);
      grp.addEventListener('click', function (e) {
        var btn = e.target.closest('button[data-smm-go]'); if (!btn) return;
        e.preventDefault(); e.stopPropagation();
        var menu = document.getElementById('acctMenu'), wrap = document.getElementById('acctWrap');
        if (menu) menu.classList.remove('open'); if (wrap) wrap.classList.remove('menu-open');
        if (typeof window.showPage === 'function') window.showPage('smartmoney');
        open();
        var sub = btn.getAttribute('data-smm-sub');
        if (sub) setSub(sub, true);
        var sel = btn.getAttribute('data-smm-go');
        setTimeout(function () {
          var t = sel && document.querySelector(sel);
          if (!t) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
          window.scrollTo({ top: Math.max(0, t.getBoundingClientRect().top + window.pageYOffset - stickyTop() - 70), behavior: 'smooth' });
        }, 80);
      });
    }
    if (location.hash === '#smartmoney' && typeof window.showPage === 'function') { window.showPage('smartmoney'); open(); }
  }

  window.SmartMoney = { open: open };

  // Tunggu hasil /api/me (window.__ES_IS_ADMIN di-set oleh _ensureAccess).
  var tries = 0;
  function waitAdmin() {
    if (window.__ES_IS_ADMIN === true) { inject(); return; }
    if (++tries < 300) setTimeout(waitAdmin, 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitAdmin);
  else waitAdmin();
})();
