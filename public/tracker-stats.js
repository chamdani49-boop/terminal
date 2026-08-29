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

   3. Kunci TP1 (TP1 LOCK):
      Sekali harga menyentuh TP1, rec DIKUNCI sebagai TP1 WIN,
      meskipun setelah itu harga jatuh balik ke TP1/entry/SL.
      Tidak downgrade ke LOSS. Backend menandai kasus ini via:
         tpHits.indexOf('TP1') >= 0
         atau closedBy in {'TP1', 'TP2', 'SL_TRAIL'}

   4. SL murni: kena SL SEBELUM TP1 pernah tersentuh → LOSS di SL.

   5. Expired tanpa hit apa2: pakai rec.exitPrice natural (logika
      waktu / horizon dari backend, tidak diubah).

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

  // hitTP1: TP1 LOCK rule — sekali TP1 tersentuh, dianggap TRUE selamanya
  // meski harga jatuh balik ke entry/SL. Rec dihitung WIN. Sumber signal
  // (mana pun terpenuhi):
  //   - tpHits punya 'TP1' atau 'TP2'  (TP2 hit implies TP1 juga hit)
  //   - closedBy = 'TP1', 'TP2', atau 'SL_TRAIL' (trailing SL setelah TP1)
  function _hitTP1(rec) {
    var hits = (rec && rec.tpHits) || [];
    if (hits.indexOf('TP1') >= 0) return true;
    if (hits.indexOf('TP2') >= 0) return true;
    var cb = String((rec && rec.closedBy) || '');
    return cb === 'TP1' || cb === 'TP2' || cb === 'SL_TRAIL';
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
    // TP1 lock rule: kalau _hitTP1 true (termasuk SL_TRAIL), exit di TP1.
    // SL murni (belum TP1) → exit di SL. Selain itu → exitPrice natural.
    var exitPrice = null;
    if (exitMode === 'tp1') {
      // TP1 MURNI (konservatif): exit di TP1 (incl SL_TRAIL / TP1-lalu-SL →
      // TP1-lock). Upside TP2 SENGAJA TIDAK ditambahkan di sini — itu tugas
      // mode TP2 — supaya toggle TP1 vs TP2 menghasilkan angka BERBEDA:
      //   TP1 = "exit di target pertama" (aman), TP2 = "ride sampai TP2".
      if (hitTP1) {
        exitPrice = +rec.tp1;                                    // TP1 WIN — LOCKED (incl SL_TRAIL / TP1-lalu-SL)
      } else if (closedBy === 'SL' && Number.isFinite(+rec.sl)) {
        exitPrice = +rec.sl;                                     // SL murni LOSS
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
        // Termasuk SL_TRAIL: TP1 sempat tersentuh → exit di TP1.
        exitPrice = +rec.tp1;
      } else if (closedBy === 'SL' && Number.isFinite(+rec.sl)) {
        exitPrice = +rec.sl;                                     // SL LOSS sebelum TP1
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
