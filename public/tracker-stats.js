/* ═══════════════════════════════════════════════════════════════════
   Tracker Stats — MESIN UTAMA perhitungan winrate & net return firm.

   Dipakai oleh SEMUA halaman menu Tracker yang menampilkan angka
   performa firm/sekuritas (sidebar Sekuritas, Overview Per Firm,
   panel detail Analis, dst) — supaya angkanya KONSISTEN.

   Kebijakan (per user, 25 Jul 2026 — revised):

   1. Default winrate DIHITUNG hanya untuk rec yang harganya
      benar-benar menyentuh entry (didTouchEntry). Rec yang tidak
      sempat fill (harga lompat) DI-SKIP dari sample. Ini yang jadi
      makna "Beli di Entry".

   2. HAKA / TP1 / TP2 adalah varian mode → punya winrate masing2.
      - Metode Entry: 'entry' (default) | 'haka'
      - Target Exit : 'tp1'   (default) | 'tp2'

   3. Universe rec closed (per revised rule, gak perlu SL trail):
      - TP1 (rec tanpa TP2 target)   → WIN at TP1
      - TP2 (rec dgn TP2 target)     → WIN at TP2
      - SL biasa (kena SL sebelum TP1) → LOSS at SL
      - SL_TRAIL (TP1 sempat tersentuh lalu balik ke SL area)
        → LOSS at SL (DIPERLAKUKAN SAMA SEPERTI SL BIASA — tidak lagi WIN)
      - EXPIRED (habis horizon tanpa hit) → pakai rec.exitPrice natural

   4. Tidak ada lagi konsep "TP1 lock": rec SL_TRAIL yang dulu dianggap
      WIN kecil di TP1 sekarang di-classify sebagai LOSS penuh di SL.
      _hitTP1() sengaja EXCLUDE SL_TRAIL supaya rec ini masuk cabang
      LOSS di recPnl().

   API:
      var st = window.TrackerStats.compute(firm, {
        entry: 'entry' | 'haka',     // default 'entry'
        exit : 'tp1'   | 'tp2',      // default 'tp1'
        dateFilter: null | {start,end}  // optional (dipakai Analis panel)
      });
      // st = { trades, total, wins, winrate, wr, net, avg,
      //        best, worst, bestRec, worstRec }
      //   trades = total = jumlah rec YANG MASUK sample (setelah entry filter)
      //   winrate = wr  = wins / trades * 100 (Math.round)
      //   net           = Σ pnlPct
      //   avg           = net / trades

      var pnl = window.TrackerStats.recPnl(rec, {
        entry: 'entry', exit: 'tp1'
      });
      // pnl (number) atau null kalau rec di-skip di mode itu
   ═══════════════════════════════════════════════════════════════════ */
(function (window) {
  'use strict';

  function _isBuy(rec) {
    return String((rec && rec.type) || 'BUY').toUpperCase() === 'BUY';
  }

  // hitTP1: rec dihitung WIN kalau ditutup di TP1/TP2. SL_TRAIL (TP1 fisik
  // tersentuh tapi balik ke SL area) DIKECUALIKAN — per aturan "gak perlu
  // SL trail", rec ini treated as LOSS di stat, bukan WIN. Sumber signal:
  //   - tpHits punya 'TP1' atau 'TP2'
  //   - closedBy = 'TP1' atau 'TP2'
  //   - closedBy = 'SL_TRAIL' → return FALSE (short-circuit sebelum cek tpHits,
  //     karena backend juga set tpHits=['TP1'] utk rec SL_TRAIL)
  function _hitTP1(rec) {
    var cb = String((rec && rec.closedBy) || '');
    if (cb === 'SL_TRAIL') return false;
    var hits = (rec && rec.tpHits) || [];
    if (hits.indexOf('TP1') >= 0) return true;
    if (hits.indexOf('TP2') >= 0) return true;
    return cb === 'TP1' || cb === 'TP2';
  }

  function _hitTP2(rec) {
    var hits = (rec && rec.tpHits) || [];
    if (hits.indexOf('TP2') >= 0) return true;
    return String((rec && rec.closedBy) || '') === 'TP2';
  }

  // Compute pnl (%) untuk 1 rec di mode (entry, exit). Return number
  // atau null kalau rec di-skip di mode itu (mis. entry mode 'entry'
  // tapi harga tak sentuh entry).
  function recPnl(rec, opts) {
    if (!rec) return null;
    opts = opts || {};
    var entryMode = opts.entry || 'entry';
    var exitMode  = opts.exit  || 'tp1';

    var buy = _isBuy(rec);
    var hitTP1 = _hitTP1(rec);
    var hitTP2 = _hitTP2(rec);
    var closedBy = String(rec.closedBy || '');

    // ── Step 1: entry price ──
    var entryPrice = null;
    if (entryMode === 'entry') {
      // Aturan #1: default winrate → hanya rec yg sempat menyentuh entry.
      if (!rec.didTouchEntry) return null;
      entryPrice = Number.isFinite(+rec.entry) ? +rec.entry : null;
    } else if (entryMode === 'haka') {
      // HAKA: entry = open price pada tanggal rilis.
      var opn = Number.isFinite(+rec.openPriceAtPublish) ? +rec.openPriceAtPublish : null;
      if (opn == null) return null;
      var tp1v = Number.isFinite(+rec.tp1) ? +rec.tp1 : null;
      var openPastTP1 = (tp1v != null) && (buy ? opn > tp1v : opn < tp1v);
      if (!openPastTP1) {
        entryPrice = opn;
      } else if (rec.didTouchEntry) {
        // Open lompat lewat TP1 tapi harga sempat balik ke entry → fallback ke entry.
        entryPrice = +rec.entry;
      } else {
        return null;
      }
    } else {
      return null;
    }
    if (!Number.isFinite(entryPrice) || entryPrice === 0) return null;

    // ── Step 2: exit price ──
    // Rule TP1 LOCK (Aturan #3): sekali TP1 tersentuh, WIN at TP1
    // — tidak downgrade meskipun harga jatuh balik ke SL.
    // SL_TRAIL sekarang treated sbg SL biasa (LOSS) — exit di rec.sl.
    // Fallback ke rec.exitPrice kalau rec.sl tidak valid (defensive).
    var isSLLike = (closedBy === 'SL' || closedBy === 'SL_TRAIL');
    var exitPrice = null;
    if (exitMode === 'tp1') {
      if (hitTP1) {
        exitPrice = +rec.tp1;                                    // TP1/TP2 WIN
      } else if (isSLLike && Number.isFinite(+rec.sl)) {
        exitPrice = +rec.sl;                                     // SL / SL_TRAIL LOSS
      } else {
        exitPrice = Number.isFinite(+rec.exitPrice) ? +rec.exitPrice : null;   // expired
      }
    } else if (exitMode === 'tp2') {
      // rec tanpa TP2 target → skip. Note: +null === 0 (finite!) — jadi
      // check !rec.tp2 dulu untuk catch null/undefined/0 baru isFinite.
      if (!rec.tp2 || !Number.isFinite(+rec.tp2)) return null;
      if (+rec.tp2 === +rec.tp1) return null;                    // TP2 == TP1 → bukan TP2 real
      if (hitTP2) {
        exitPrice = +rec.tp2;                                    // TP2 WIN penuh
      } else if (hitTP1) {
        // TP1 hit tapi TP2 belum → trailed at TP1 (small WIN).
        // Note: _hitTP1 sudah exclude SL_TRAIL, jadi cabang ini hanya
        // ke-reach saat rec benar-benar TP1/TP2-only tanpa SL_TRAIL.
        exitPrice = +rec.tp1;
      } else if (isSLLike && Number.isFinite(+rec.sl)) {
        exitPrice = +rec.sl;                                     // SL / SL_TRAIL LOSS
      } else {
        exitPrice = Number.isFinite(+rec.exitPrice) ? +rec.exitPrice : null;
      }
    } else {
      return null;
    }
    if (!Number.isFinite(exitPrice)) return null;

    var pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    return buy ? pnlPct : -pnlPct;
  }

  // Agregasi stats seluruh firm.recsHistory. Return summary lengkap
  // dengan field name yg cover semua konsumen (Overview: trades/winrate,
  // Analis: total/wr — dua-duanya di-expose).
  function compute(firm, opts) {
    opts = opts || {};
    var entryMode = opts.entry || 'entry';
    var exitMode  = opts.exit  || 'tp1';
    var dateFilter = opts.dateFilter || null;

    var recs = (firm && firm.recsHistory) || [];
    var trades = 0, wins = 0, netSum = 0;
    var best = null, worst = null;
    var bestRec = null, worstRec = null;

    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      // Optional date filter (Analis panel: user pick range di UI).
      if (dateFilter) {
        var d = r && r.openDate;
        if (!d || d < dateFilter.start || d > dateFilter.end) continue;
      }
      var pnl = recPnl(r, { entry: entryMode, exit: exitMode });
      if (pnl == null) continue;
      trades++;
      if (+pnl > 0) wins++;
      netSum += +pnl;
      if (best == null || +pnl > best)  { best  = +pnl; bestRec  = r; }
      if (worst == null || +pnl < worst) { worst = +pnl; worstRec = r; }
    }

    var wr = trades ? Math.round(wins / trades * 100) : null;
    return {
      // Overview naming
      trades: trades,
      winrate: wr,
      // Analis naming (alias)
      total: trades,
      wr:    wr,
      // Shared
      wins:   wins,
      losses: trades - wins,
      net:    +netSum.toFixed(2),
      avg:    trades ? +(netSum / trades).toFixed(2) : 0,
      best:   best,
      worst:  worst,
      bestRec:  bestRec,
      worstRec: worstRec
    };
  }

  window.TrackerStats = {
    compute: compute,
    recPnl:  recPnl,
    // Utils di-expose utk debugging & test
    _hitTP1: _hitTP1,
    _hitTP2: _hitTP2
  };
})(window);
