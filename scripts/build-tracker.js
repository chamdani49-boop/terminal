/**
 * scripts/build-tracker.js — pipeline data untuk menu "Tracker".
 *
 * Menghasilkan public/tracker.json yang berisi:
 *   1. Ringkasan agregat (winrate, netReturn, profitFactor, tpCounts, dst).
 *   2. Rekomendasi aktif (openList[]) dgn harga live + floating% + status.
 *   3. Rekomendasi selesai (historyList[]) dgn exit + pnl%.
 *   4. Agregasi per firm (byFirm), per analis (byAnalyst), per ticker (byTicker).
 *   5. Top 5 / Bottom 5 firm & ticker.
 *   6. Daily equity 30 hari (untuk chart Performa).
 *   7. Safety Net RR (per TP level: hit/miss/expectancy).
 *   8. Market Bias (bullish/bearish dari trade recent 48 jam).
 *   9. Score bracket (WEAK / MODERATE / STRONG performance).
 *  10. IHSG daily last + %chgToday + series30d.
 *
 * SUMBER DATA:
 *   - GAS Web App (Sheet Tracker): GAS ?action=list&token=X
 *     → env TRACKER_GAS_URL + TRACKER_GAS_TOKEN
 *   - Harga saham daily: public/ohlc.json (auto-refresh cron 17:00 WIB)
 *   - Sector per ticker: public/screening.json
 *   - IHSG daily: Yahoo Finance ^JKSE (fallback: public/macro.json bulanan)
 *
 * GRACEFUL DEGRADATION:
 *   - Bila env GAS tidak di-set → tulis tracker.json dgn pending:true.
 *   - Bila GAS error → pertahankan file lama (jangan overwrite dgn kosong).
 *   - Bila IHSG fetch gagal → skip series30d, kolom lain tetap terisi.
 *
 * USAGE:
 *   node scripts/build-tracker.js
 *
 * ENV (opsional):
 *   TRACKER_GAS_URL       — URL /exec Web App (sama dgn worker GAS_URL)
 *   TRACKER_GAS_TOKEN     — token GAS (sama dgn worker GAS_TOKEN)
 *   TRACKER_FIXTURE_PATH  — path ke fixture JSON (untuk uji offline)
 *   TRACKER_MAX_HISTORY   — batas history yg disimpan (default 500)
 */

const fs = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const OUT_PATH   = path.join(ROOT, 'public', 'tracker.json');
const OHLC_PATH  = path.join(ROOT, 'public', 'ohlc.json');
const SCREEN_PATH= path.join(ROOT, 'public', 'screening.json');
const MACRO_PATH = path.join(ROOT, 'public', 'macro.json');

const MAX_HISTORY = parseInt(process.env.TRACKER_MAX_HISTORY || '500', 10);
const DAILY_EQUITY_DAYS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
// 1) FETCH RAW ROWS DARI GAS
// ─────────────────────────────────────────────────────────────────────────
async function fetchGasRows() {
  const url = process.env.TRACKER_GAS_URL;
  const token = process.env.TRACKER_GAS_TOKEN;
  const fixture = process.env.TRACKER_FIXTURE_PATH;

  if (fixture) {
    console.log(`  ℹ Using fixture: ${fixture}`);
    const raw = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    return { ok: true, source: 'fixture', items: raw.items || raw };
  }
  if (!url || !token) {
    console.warn('  ⚠ TRACKER_GAS_URL / TRACKER_GAS_TOKEN tidak di-set. Tulis pending:true.');
    return { ok: false, source: 'gas', reason: 'no-credentials', items: [] };
  }

  const full = url + (url.includes('?') ? '&' : '?') + 'action=list&token=' + encodeURIComponent(token);
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(full, {
        headers: { 'Accept': 'application/json' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !json.ok) throw new Error(json && json.error ? json.error : 'gas returned not-ok');
      console.log(`  ✓ GAS: ${json.count || 0} approved rows`);
      return { ok: true, source: 'gas', items: json.items || [] };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  console.warn('  ⚠ GAS fetch gagal:', lastErr && lastErr.message);
  return { ok: false, source: 'gas', reason: 'fetch-failed', error: String(lastErr), items: [] };
}

// ─────────────────────────────────────────────────────────────────────────
// 2) LOAD OHLC & SCREENING (LOCAL)
// ─────────────────────────────────────────────────────────────────────────
function loadOhlc() {
  if (!fs.existsSync(OHLC_PATH)) {
    console.warn('  ⚠ public/ohlc.json tidak ada.');
    return { tickers: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(OHLC_PATH, 'utf8'));
    return raw && raw.tickers ? raw : { tickers: raw };
  } catch (e) {
    console.warn('  ⚠ ohlc.json rusak:', e.message);
    return { tickers: {} };
  }
}

function loadScreening() {
  if (!fs.existsSync(SCREEN_PATH)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(SCREEN_PATH, 'utf8'));
    const out = {};
    const stocks = raw && raw.stocks ? raw.stocks : {};
    for (const t of Object.keys(stocks)) {
      out[t] = { name: stocks[t].name || null, sector: stocks[t].sector || null };
    }
    return out;
  } catch (e) {
    console.warn('  ⚠ screening.json rusak:', e.message);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 3) FETCH IHSG DAILY (Yahoo ^JKSE)
// ─────────────────────────────────────────────────────────────────────────
async function fetchIhsgDaily() {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  const qs = '?interval=1d&range=3mo';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const host = hosts[(attempt - 1) % hosts.length];
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent('^JKSE')}${qs}`;
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; TrackerBuild/1.0)',
          'Accept': 'application/json',
        },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const result = json && json.chart && json.chart.result && json.chart.result[0];
      if (!result) throw new Error('no result');
      const ts = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const opens = result.indicators?.quote?.[0]?.open || [];
      const series = [];
      for (let i = 0; i < ts.length; i++) {
        if (closes[i] == null || !Number.isFinite(closes[i])) continue;
        const d = new Date(ts[i] * 1000);
        const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
        series.push({ date, open: +opens[i], close: +closes[i] });
      }
      if (!series.length) throw new Error('empty series');
      return series;
    } catch (e) {
      if (attempt === 3) {
        console.warn('  ⚠ IHSG fetch gagal setelah 3x:', e.message);
        return null;
      }
      await sleep(1200 * attempt);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// 4) NORMALISASI ROW SHEET → REKOMENDASI
// ─────────────────────────────────────────────────────────────────────────
function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[^\d.\-]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // ISO
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  // DD/MM/YYYY atau DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (dmy) {
    const d = String(dmy[1]).padStart(2, '0');
    const m = String(dmy[2]).padStart(2, '0');
    return `${dmy[3]}-${m}-${d}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// Konversi horizon teks bebas → jumlah hari.
function parseHorizonDays(v) {
  if (!v) return 30; // default 1 bulan
  const s = String(v).toLowerCase().trim();
  const n = parseInt(s.match(/\d+/) ? s.match(/\d+/)[0] : '1', 10) || 1;
  if (/(tahun|th|year|yr)\b/.test(s))      return n * 365;
  if (/(bulan|bln|mo|month)\b/.test(s))     return n * 30;
  if (/(minggu|mgg|week|wk|w)\b/.test(s))   return n * 7;
  if (/(hari|h|day|d)\b/.test(s))           return n;
  // Angka polos → asumsi hari
  if (/^\d+$/.test(s)) return n;
  return 30;
}

function normalizeRow(row) {
  if (!row || typeof row !== 'object') return null;
  const analyst = String(row.analis || '').trim();
  const firm    = String(row.firm || '').trim();
  const ticker  = String(row.ticker || '').trim().toUpperCase().replace(/\.JK$/i, '').replace(/^\$/, '');
  const tipe    = String(row.tipe || 'BUY').trim().toUpperCase();
  const entry   = toNumber(row.entry);
  const tp1     = toNumber(row.tp1);
  const tp2     = toNumber(row.tp2);
  const sl      = toNumber(row.sl);
  const openDate = parseDate(row.tanggal) || parseDate(row.timestamp) || null;
  const horizon  = String(row.horizon || '').trim();
  const horizonDays = parseHorizonDays(horizon);
  const cert     = String(row.sertifikasi || '').trim();
  const note     = String(row.catatan || '').trim();
  const submittedBy = String(row.submitted_by || '').trim();
  const approvedBy  = String(row.approved_by || '').trim();

  // Validasi minimal: analis, ticker, entry, tp1, sl, openDate WAJIB.
  if (!analyst || !ticker || !openDate || entry == null || tp1 == null || sl == null) return null;
  // Tolak BUY dgn TP <= entry atau SL >= entry (data invalid).
  if (tipe === 'BUY' && (tp1 <= entry || sl >= entry)) return null;
  if (tipe === 'SELL' && (tp1 >= entry || sl <= entry)) return null;

  return {
    id: `${ticker}-${openDate}-${row._row || row._ts || Math.random().toString(36).slice(2,8)}`,
    _row: row._row || null,
    _ts: row._ts || 0,
    analyst, firm, ticker, type: tipe,
    entry, tp1, tp2, sl, openDate, horizon, horizonDays,
    cert, note, submittedBy, approvedBy,
    verified: !!(cert && !/^-+$/.test(cert)),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 5) DERIVASI STATUS (OPEN / TP_HIT / SL_HIT / EXPIRED) DARI CANDLES
// ─────────────────────────────────────────────────────────────────────────
// Candle format di ohlc.json: [ts(unix sec), open, high, low, close]
/**
 * Derivasi status posisi dari candles harian.
 *
 * Aturan (konservatif, tanpa data intraday):
 *   - Loop candles setelah openDate, cek batas TP/SL setiap bar (high/low).
 *   - Phase 1 (belum TP1): kalau bar sama slHit && !tp1Hit → SL_HIT (LOSS).
 *   - Single TP (tp2 null): tp1Hit → TP_HIT (WIN, close di tp1).
 *   - Staged (tp2 ada, mengikuti pola robot):
 *       TP1 kena → close 50% at tp1, trail SL ke entry (breakeven), lanjut cari TP2.
 *       Phase 2: TP2 kena → close sisa 50% at tp2 (total pnl = (tp1%+tp2%)/2, WIN).
 *                SL trailing (entry) kena → sisa 50% close at entry (pnl = tp1%/2, WIN).
 *   - Bila 1 bar mengandung TP1 + TP2 sekaligus → asumsi TP2 (max profit).
 *   - EXPIRED (horizon lewat tanpa exit): pnl = close × sisaPosisi (+ realized).
 *   - OPEN: pnl = floating dari lastPrice × sisaPosisi (+ realized).
 */
function derivePosition(rec, ohlcEntry, todayIso) {
  const result = {
    status: 'OPEN',
    tpHits: [],
    closedBy: null,
    exitDate: null,
    exitPrice: null,
    lastPrice: null,
    lastPriceTime: null,
    barsHeld: 0,
    pnlPct: null,
    result: null, // WIN | LOSS | NEUTRAL
  };
  if (!ohlcEntry || !Array.isArray(ohlcEntry.candles) || !ohlcEntry.candles.length) {
    return result;
  }
  const openTs = Date.parse(rec.openDate + 'T00:00:00Z') / 1000;
  const horizonEndTs = openTs + rec.horizonDays * 86400;
  const isBuy = rec.type === 'BUY';
  const dirSign = isBuy ? 1 : -1;
  const hasT2 = rec.tp2 != null && rec.tp2 !== rec.tp1;

  const relevant = ohlcEntry.candles.filter(c => c[0] >= openTs);
  const lastCandle = ohlcEntry.candles[ohlcEntry.candles.length - 1];
  if (!lastCandle) return result;
  result.lastPrice = lastCandle[4];
  result.lastPriceTime = new Date(lastCandle[0] * 1000).toISOString();

  const pctAt = (px) => ((px - rec.entry) / rec.entry * 100) * dirSign;

  let phase = 'phase1';
  let effectiveSl = rec.sl;
  let realizedPct = 0; // dari partial TP1

  for (const c of relevant) {
    if (c[0] > horizonEndTs) break;
    result.barsHeld++;
    const high = c[2], low = c[3], ts = c[0];
    const slHit = isBuy ? low <= effectiveSl : high >= effectiveSl;
    const tp1Hit = isBuy ? high >= rec.tp1 : low <= rec.tp1;
    const tp2Hit = hasT2 && (isBuy ? high >= rec.tp2 : low <= rec.tp2);

    if (phase === 'phase1') {
      // Full SL (belum TP1 kena)
      if (slHit && !tp1Hit) {
        result.status = 'SL_HIT';
        result.closedBy = 'SL';
        result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.exitPrice = effectiveSl;
        result.pnlPct = pctAt(effectiveSl);
        result.result = 'LOSS';
        break;
      }
      // Single TP mode
      if (tp1Hit && !hasT2) {
        result.status = 'TP_HIT';
        result.tpHits = ['TP1'];
        result.closedBy = 'TP1';
        result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.exitPrice = rec.tp1;
        result.pnlPct = pctAt(rec.tp1);
        result.result = 'WIN';
        break;
      }
      // Staged: TP1 kena → partial 50% + trail SL ke entry
      if (tp1Hit && hasT2) {
        // Kalau bar yang sama TP2 juga kena → langsung close full (best case)
        if (tp2Hit) {
          realizedPct = pctAt(rec.tp1) * 0.5 + pctAt(rec.tp2) * 0.5;
          result.tpHits = ['TP1', 'TP2'];
          result.status = 'TP_HIT';
          result.closedBy = 'TP2';
          result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
          result.exitPrice = rec.tp2;
          result.pnlPct = realizedPct;
          result.result = 'WIN';
          break;
        }
        // Hanya TP1 kena di bar ini → partial + lanjut ke phase2
        realizedPct += pctAt(rec.tp1) * 0.5;
        result.tpHits.push('TP1');
        effectiveSl = rec.entry; // trail ke breakeven
        phase = 'phase2';
        continue;
      }
    } else {
      // phase2: sisa 50%, cari TP2 atau SL trailing (entry)
      if (tp2Hit) {
        realizedPct += pctAt(rec.tp2) * 0.5;
        result.tpHits.push('TP2');
        result.status = 'TP_HIT';
        result.closedBy = 'TP2';
        result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.exitPrice = rec.tp2;
        result.pnlPct = realizedPct;
        result.result = 'WIN';
        break;
      }
      if (slHit) {
        // SL trailing (entry) kena → sisa 50% close at entry (0%).
        // Overall pnl = realizedPct dari TP1 partial saja (positif → WIN).
        result.status = 'TP_HIT';
        result.closedBy = 'SL_TRAIL';
        result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.exitPrice = rec.entry;
        result.pnlPct = realizedPct;
        result.result = realizedPct > 0.1 ? 'WIN' : 'NEUTRAL';
        break;
      }
    }
  }

  // Belum ada exit → EXPIRED atau OPEN
  if (!result.exitDate) {
    const nowTs = new Date(todayIso + 'T00:00:00Z').getTime() / 1000;
    if (nowTs > horizonEndTs) {
      const inHorizon = relevant.filter(c => c[0] <= horizonEndTs);
      const exitCandle = inHorizon.length ? inHorizon[inHorizon.length - 1] : relevant[relevant.length - 1] || lastCandle;
      const exitClose = exitCandle[4];
      result.status = 'EXPIRED';
      result.closedBy = 'EXPIRED';
      result.exitDate = new Date(exitCandle[0] * 1000).toISOString().slice(0, 10);
      result.exitPrice = exitClose;
      const closePct = pctAt(exitClose);
      // Kalau sudah phase2 (TP1 partial), sisa 50% pakai exitClose.
      result.pnlPct = phase === 'phase2' ? (realizedPct + closePct * 0.5) : closePct;
      result.result = result.pnlPct > 0.1 ? 'WIN' : (result.pnlPct < -0.1 ? 'LOSS' : 'NEUTRAL');
    } else {
      // OPEN — floating dari lastPrice
      const floatPct = pctAt(result.lastPrice);
      result.pnlPct = phase === 'phase2' ? (realizedPct + floatPct * 0.5) : floatPct;
    }
  }

  if (result.pnlPct != null) result.pnlPct = +result.pnlPct.toFixed(2);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// 6) SCORE VALIDITY — rule-based 0..100
// ─────────────────────────────────────────────────────────────────────────
function scoreValidity(rec, analystStats) {
  let score = 20; // baseline
  const reasons = [];
  if (rec.verified) { score += 25; reasons.push('Sertifikasi ' + rec.cert); }
  else reasons.push('Belum verifikasi');
  if (rec.horizon)   { score += 5;  reasons.push('Horizon: ' + rec.horizon); }
  if (rec.tp2 != null){ score += 10; reasons.push('TP2 tersedia'); }
  if (rec.note && rec.note.length >= 20) { score += 10; reasons.push('Catatan lengkap'); }
  // RR ratio: kalau RR (TP1-Entry) : (Entry-SL) >= 2 → +10
  const rrPot = Math.abs(rec.tp1 - rec.entry);
  const rrRisk = Math.abs(rec.entry - rec.sl);
  const rr = rrRisk > 0 ? rrPot / rrRisk : 0;
  if (rr >= 2) { score += 10; reasons.push(`RR ${rr.toFixed(1)}:1`); }
  else if (rr >= 1) reasons.push(`RR ${rr.toFixed(1)}:1`);
  // Analyst track record
  if (analystStats && analystStats.totalClosed >= 5) {
    if (analystStats.winrate >= 60) { score += 20; reasons.push(`WR analis ${analystStats.winrate.toFixed(0)}%`); }
    else if (analystStats.winrate >= 45) { score += 10; reasons.push(`WR analis ${analystStats.winrate.toFixed(0)}%`); }
    else reasons.push(`WR analis ${analystStats.winrate.toFixed(0)}%`);
  }
  score = Math.max(0, Math.min(100, score));
  let validity = 'WEAK';
  if (score >= 70) validity = 'STRONG';
  else if (score >= 45) validity = 'MODERATE';
  return { score, validity, reasons };
}

// ─────────────────────────────────────────────────────────────────────────
// 7) AGREGASI: per FIRM / per ANALYST / per TICKER
// ─────────────────────────────────────────────────────────────────────────
function idOf(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '') || 'unknown';
}

function initAgg() {
  return { trades: 0, wins: 0, losses: 0, neutral: 0, sumPnl: 0, bestPct: -Infinity, worstPct: Infinity };
}
function acc(agg, rec) {
  agg.trades++;
  if (rec.result === 'WIN') agg.wins++;
  else if (rec.result === 'LOSS') agg.losses++;
  else agg.neutral++;
  agg.sumPnl += rec.pnlPct || 0;
  if ((rec.pnlPct || 0) > agg.bestPct) agg.bestPct = rec.pnlPct || 0;
  if ((rec.pnlPct || 0) < agg.worstPct) agg.worstPct = rec.pnlPct || 0;
}
function summary(agg) {
  const totalNonNeutral = agg.wins + agg.losses;
  const wr = totalNonNeutral ? +(agg.wins / totalNonNeutral * 100).toFixed(1) : 0;
  return {
    trades: agg.trades, wins: agg.wins, losses: agg.losses, neutral: agg.neutral,
    winrate: wr,
    net: +agg.sumPnl.toFixed(2),
    avg: agg.trades ? +(agg.sumPnl / agg.trades).toFixed(2) : 0,
    best: agg.bestPct === -Infinity ? 0 : +agg.bestPct.toFixed(2),
    worst: agg.worstPct === Infinity ? 0 : +agg.worstPct.toFixed(2),
  };
}

function buildAggregations(closed) {
  const byFirm = new Map();
  const byAnalyst = new Map();
  const byTicker = new Map();
  for (const rec of closed) {
    const fId = idOf(rec.firm);
    const aId = idOf(rec.analyst);
    if (!byFirm.has(fId))     byFirm.set(fId, { id: fId, name: rec.firm, analystSet: new Set(), verified: false, agg: initAgg() });
    if (!byAnalyst.has(aId))  byAnalyst.set(aId, { id: aId, name: rec.analyst, firm: rec.firm, firmId: fId, cert: rec.cert, verified: rec.verified, agg: initAgg() });
    if (!byTicker.has(rec.ticker)) byTicker.set(rec.ticker, { ticker: rec.ticker, agg: initAgg() });

    acc(byFirm.get(fId).agg, rec);
    byFirm.get(fId).analystSet.add(aId);
    if (rec.verified) byFirm.get(fId).verified = true;
    acc(byAnalyst.get(aId).agg, rec);
    acc(byTicker.get(rec.ticker).agg, rec);
  }
  return { byFirm, byAnalyst, byTicker };
}

// ─────────────────────────────────────────────────────────────────────────
// 8) DAILY EQUITY 30 HARI (dari closed recs)
// ─────────────────────────────────────────────────────────────────────────
function buildDailyEquity(closed, days) {
  const byDate = new Map();
  for (const rec of closed) {
    if (!rec.exitDate) continue;
    if (!byDate.has(rec.exitDate)) byDate.set(rec.exitDate, { date: rec.exitDate, trades: 0, wins: 0, losses: 0, sumPnl: 0 });
    const d = byDate.get(rec.exitDate);
    d.trades++;
    if (rec.result === 'WIN') d.wins++;
    else if (rec.result === 'LOSS') d.losses++;
    d.sumPnl += rec.pnlPct || 0;
  }
  // Ambil `days` hari terakhir (dari tanggal exit terbaru mundur).
  const sortedDates = [...byDate.keys()].sort();
  if (!sortedDates.length) return [];
  const lastDate = new Date(sortedDates[sortedDates.length - 1] + 'T00:00:00Z');
  const cutoff = new Date(lastDate.getTime() - (days - 1) * 86400000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let cum = 0;
  const out = [];
  for (const date of sortedDates) {
    if (date < cutoffStr) continue;
    const d = byDate.get(date);
    cum += d.sumPnl;
    out.push({
      date, trades: d.trades, wins: d.wins, losses: d.losses,
      dayPnl: +d.sumPnl.toFixed(2),
      cumulative: +cum.toFixed(2),
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// 9) SAFETY NET: TP1 / TP2 / SL — hit/miss/expectancy R
// ─────────────────────────────────────────────────────────────────────────
function buildSafetyNet(closed) {
  const buckets = { TP1: { hit: 0, miss: 0, sumR: 0 }, TP2: { hit: 0, miss: 0, sumR: 0 } };
  let totalTrades = 0;
  for (const rec of closed) {
    totalTrades++;
    const r = Math.abs(rec.entry - rec.sl);
    if (r <= 0) continue;
    const tpHits = rec.tpHits || [];
    // TP1
    if (tpHits.includes('TP1') || rec.closedBy === 'TP2') buckets.TP1.hit++;
    else buckets.TP1.miss++;
    // TP2 (hanya kalau rec.tp2 ada)
    if (rec.tp2 != null) {
      if (tpHits.includes('TP2')) buckets.TP2.hit++;
      else buckets.TP2.miss++;
    }
    // R multiple (pnlPct dalam satuan R)
    const pnl = rec.pnlPct || 0;
    const rMultiple = pnl / ((r / rec.entry) * 100);
    if (tpHits.includes('TP1') || rec.closedBy === 'TP2') buckets.TP1.sumR += rMultiple;
    if (rec.tp2 != null && tpHits.includes('TP2')) buckets.TP2.sumR += rMultiple;
  }
  const rows = [];
  for (const [level, bkt] of Object.entries(buckets)) {
    const total = bkt.hit + bkt.miss;
    if (total === 0) continue;
    const sr = +(bkt.hit / total * 100).toFixed(1);
    const exp = bkt.hit > 0 ? +(bkt.sumR / total).toFixed(3) : 0;
    // RR rata-rata dari sample yg hit: pakai default 1:1 (TP1) atau 1:2 (TP2) approximation.
    const rr = level === 'TP1' ? 1.0 : 2.0;
    rows.push({ level, rr, hit: bkt.hit, miss: bkt.miss, safetyRatio: sr, expectancy: exp });
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────
// 10) MARKET BIAS: bullish vs bearish dari trade recent 48h
// ─────────────────────────────────────────────────────────────────────────
function buildMarketBias(closed, todayIso) {
  const nowTs = new Date(todayIso).getTime();
  const win48h = closed.filter(r => r.exitDate && (nowTs - new Date(r.exitDate).getTime()) <= 48 * 3600 * 1000);
  if (!win48h.length) {
    // Fallback: pakai semua closed 30 hari terakhir.
    const win30d = closed.filter(r => r.exitDate && (nowTs - new Date(r.exitDate).getTime()) <= 30 * 86400 * 1000);
    if (!win30d.length) return { bullish: 50, bearish: 50, sample: 'recent_48h', count: 0 };
    const wins = win30d.filter(r => (r.pnlPct || 0) > 0).length;
    const pct = Math.round(wins / win30d.length * 100);
    return { bullish: pct, bearish: 100 - pct, sample: 'recent_30d', count: win30d.length };
  }
  const wins = win48h.filter(r => (r.pnlPct || 0) > 0).length;
  const pct = Math.round(wins / win48h.length * 100);
  return { bullish: pct, bearish: 100 - pct, sample: 'recent_48h', count: win48h.length };
}

// ─────────────────────────────────────────────────────────────────────────
// 11) SCORE BRACKETS: WEAK / MODERATE / STRONG
// ─────────────────────────────────────────────────────────────────────────
function buildScoreBrackets(closed) {
  const brackets = {
    STRONG:   { name: 'STRONG (70-100)',   min: 70,  max: 101, agg: initAgg(), tp1: 0, tp2: 0, sl: 0 },
    MODERATE: { name: 'MODERATE (45-69)',  min: 45,  max: 70,  agg: initAgg(), tp1: 0, tp2: 0, sl: 0 },
    WEAK:     { name: 'WEAK (0-44)',       min: 0,   max: 45,  agg: initAgg(), tp1: 0, tp2: 0, sl: 0 },
  };
  for (const rec of closed) {
    const s = rec.score || 0;
    let key = 'WEAK';
    if (s >= 70) key = 'STRONG';
    else if (s >= 45) key = 'MODERATE';
    const b = brackets[key];
    acc(b.agg, rec);
    if ((rec.tpHits || []).includes('TP2')) b.tp2++;
    else if ((rec.tpHits || []).includes('TP1')) b.tp1++;
    if (rec.closedBy === 'SL') b.sl++;
  }
  return Object.values(brackets).map(b => {
    const s = summary(b.agg);
    return { name: b.name, trades: s.trades, tp1: b.tp1, tp2: b.tp2, sl: b.sl, winrate: s.winrate, net: s.net };
  });
}

// ─────────────────────────────────────────────────────────────────────────
// 12) MAIN
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('build-tracker: start', new Date().toISOString());
  const todayIso = new Date().toISOString().slice(0, 10);

  // Load previous (fallback merge)
  let prev = null;
  if (fs.existsSync(OUT_PATH)) {
    try { prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch (_) {}
  }

  // Fetch data
  const gas = await fetchGasRows();
  const ohlc = loadOhlc();
  const screening = loadScreening();
  let ihsgSeries = null;
  try { ihsgSeries = await fetchIhsgDaily(); }
  catch (e) { console.warn('  ⚠ ihsg fetch throw:', e.message); }

  // Kalau GAS gagal & sebelumnya belum ada file → tulis pending saja.
  if (!gas.ok && gas.reason === 'no-credentials') {
    const payload = pendingPayload(todayIso, 'no-credentials',
      'TRACKER_GAS_URL / TRACKER_GAS_TOKEN belum di-set di GitHub Secrets. Set dulu lalu re-run workflow.',
      ihsgSeries);
    writeOut(payload);
    return;
  }
  if (!gas.ok) {
    // Fetch gagal tapi ada file lama → PRESERVE
    if (prev && !prev.pending) {
      console.warn('  ⚠ GAS fetch gagal, PERTAHANKAN tracker.json lama.');
      // Refresh saja updatedAt-nya, tapi tandai stale.
      prev.staleAt = new Date().toISOString();
      prev.gasError = gas.error || gas.reason;
      writeOut(prev);
      return;
    }
    const payload = pendingPayload(todayIso, gas.reason, 'GAS fetch gagal & belum ada snapshot lama.', ihsgSeries);
    writeOut(payload);
    return;
  }

  // Normalisasi rows
  const recsRaw = (gas.items || []).map(normalizeRow).filter(Boolean);
  console.log(`  normalized ${recsRaw.length}/${(gas.items||[]).length} rows`);

  // Pass 1: derive position untuk tiap rec.
  const recs = [];
  for (const rec of recsRaw) {
    const ohlcEntry = ohlc.tickers[rec.ticker];
    const pos = derivePosition(rec, ohlcEntry, todayIso);
    const enriched = Object.assign({}, rec, pos);
    // Tambah sector dari screening (kalau ada).
    const scr = screening[rec.ticker];
    enriched.sector = scr ? scr.sector : null;
    enriched.tickerName = scr ? scr.name : null;
    recs.push(enriched);
  }

  // Split active vs closed
  const active = recs.filter(r => r.status === 'OPEN');
  const closed = recs.filter(r => r.status !== 'OPEN');
  console.log(`  ${active.length} active + ${closed.length} closed`);

  // Pass 2: hitung analystStats untuk scoring (dari closed).
  const { byFirm, byAnalyst, byTicker } = buildAggregations(closed);
  const analystStatsMap = new Map();
  for (const [aid, a] of byAnalyst) {
    const s = summary(a.agg);
    analystStatsMap.set(aid, { totalClosed: s.trades, winrate: s.winrate, avg: s.avg });
  }

  // Pass 3: score untuk semua rec (active + closed).
  for (const rec of recs) {
    const aStats = analystStatsMap.get(idOf(rec.analyst));
    const sc = scoreValidity(rec, aStats);
    rec.score = sc.score;
    rec.validity = sc.validity;
    rec.reasons = sc.reasons;
  }

  // Recompute high score across all
  const highScore = recs.length ? Math.max(...recs.map(r => r.score || 0)) : 0;

  // Statistik global
  const closedAgg = closed.reduce((a, r) => (acc(a, r), a), initAgg());
  const globalSummary = summary(closedAgg);
  const grossProfit = closed.filter(r => (r.pnlPct||0) > 0).reduce((s, r) => s + r.pnlPct, 0);
  const grossLoss = Math.abs(closed.filter(r => (r.pnlPct||0) < 0).reduce((s, r) => s + r.pnlPct, 0));
  const pf = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : (grossProfit > 0 ? 999 : 0);

  const tpCounts = { TP1: 0, TP2: 0 };
  let slCount = 0;
  const closedByCounts = { TP: 0, SL: 0, EXPIRED: 0 };
  for (const r of closed) {
    if ((r.tpHits || []).includes('TP1')) tpCounts.TP1++;
    if ((r.tpHits || []).includes('TP2')) tpCounts.TP2++;
    if (r.closedBy === 'SL') { slCount++; closedByCounts.SL++; }
    else if (r.closedBy === 'TP1' || r.closedBy === 'TP2') closedByCounts.TP++;
    else if (r.closedBy === 'EXPIRED') closedByCounts.EXPIRED++;
  }

  // Open floating %
  let openFloating = 0;
  for (const r of active) openFloating += (r.pnlPct || 0);
  openFloating = active.length ? +(openFloating / active.length).toFixed(2) : 0;

  // byFirm sekarang dilengkapi list rekomendasi + analyst names
  const firmMap = new Map(); // fId -> obj
  for (const [fId, f] of byFirm) {
    const summ = summary(f.agg);
    firmMap.set(fId, {
      id: fId, name: f.name, verified: f.verified,
      trades: summ.trades, wins: summ.wins, losses: summ.losses, neutral: summ.neutral,
      winrate: summ.winrate, net: summ.net, avg: summ.avg, best: summ.best, worst: summ.worst,
      analysts: [], recsActive: [], recsHistory: [], watchlist: [], sectorFocus: [], highScore: 0,
    });
  }
  // Tambah firm dari active (yg belum punya trade closed)
  for (const rec of active) {
    const fId = idOf(rec.firm);
    if (!firmMap.has(fId)) {
      firmMap.set(fId, {
        id: fId, name: rec.firm, verified: rec.verified,
        trades: 0, wins: 0, losses: 0, neutral: 0,
        winrate: 0, net: 0, avg: 0, best: 0, worst: 0,
        analysts: [], recsActive: [], recsHistory: [], watchlist: [], sectorFocus: [], highScore: 0,
      });
    }
    if (rec.verified) firmMap.get(fId).verified = true;
  }

  // Populate analysts, recsActive/History, watchlist, sectorFocus per firm
  const analystObjMap = new Map();
  for (const [aid, a] of byAnalyst) {
    const s = summary(a.agg);
    analystObjMap.set(aid, {
      id: aid, name: a.name, firm: a.firm, firmId: a.firmId, cert: a.cert, verified: a.verified,
      trades: s.trades, winrate: s.winrate, net: s.net, avg: s.avg,
    });
  }
  // Analis dari active yang belum ada di analystObjMap
  for (const rec of active) {
    const aid = idOf(rec.analyst);
    if (!analystObjMap.has(aid)) {
      analystObjMap.set(aid, {
        id: aid, name: rec.analyst, firm: rec.firm, firmId: idOf(rec.firm),
        cert: rec.cert, verified: rec.verified,
        trades: 0, winrate: 0, net: 0, avg: 0,
      });
    }
  }

  for (const rec of active) {
    const fId = idOf(rec.firm);
    const f = firmMap.get(fId);
    if (f) {
      f.recsActive.push(makeRecActiveObj(rec));
      if (!f.watchlist.includes(rec.ticker)) f.watchlist.push(rec.ticker);
      if (rec.sector && !f.sectorFocus.includes(rec.sector)) f.sectorFocus.push(rec.sector);
      if ((rec.score || 0) > f.highScore) f.highScore = rec.score;
    }
  }
  for (const rec of closed) {
    const fId = idOf(rec.firm);
    const f = firmMap.get(fId);
    if (f) {
      f.recsHistory.push(makeRecHistoryObj(rec));
      if (rec.sector && !f.sectorFocus.includes(rec.sector)) f.sectorFocus.push(rec.sector);
      if ((rec.score || 0) > f.highScore) f.highScore = rec.score;
    }
  }
  for (const f of firmMap.values()) {
    // Analis list per firm (dari analystObjMap)
    for (const a of analystObjMap.values()) {
      if (a.firmId === f.id) f.analysts.push({
        id: a.id, name: a.name, cert: a.cert, verified: a.verified,
        trades: a.trades, winrate: a.winrate, net: a.net, avg: a.avg,
      });
    }
    // Batasi history per firm ke terbaru (max 50) + reverse-sort by exitDate desc
    f.recsHistory.sort((x, y) => (y.exitDate || '').localeCompare(x.exitDate || '')).splice(50);
    f.recsActive.sort((x, y) => (y.openDate || '').localeCompare(x.openDate || ''));
  }

  // Top / Bottom firms & tickers
  const firmsArr = [...firmMap.values()].filter(f => f.trades > 0);
  const topFirms = firmsArr.slice().sort((a, b) => b.net - a.net).slice(0, 5)
    .map(f => ({ id: f.id, name: f.name, trades: f.trades, winrate: f.winrate, net: f.net }));
  const bottomFirms = firmsArr.slice().sort((a, b) => a.net - b.net).slice(0, 5)
    .map(f => ({ id: f.id, name: f.name, trades: f.trades, winrate: f.winrate, net: f.net }));

  const tickerRows = [];
  for (const [ticker, t] of byTicker) {
    const s = summary(t.agg);
    tickerRows.push({ ticker, trades: s.trades, winrate: s.winrate, net: s.net });
  }
  const topTickers = tickerRows.slice().sort((a, b) => b.net - a.net).slice(0, 5);
  const bottomTickers = tickerRows.slice().sort((a, b) => a.net - b.net).slice(0, 5);

  // Union watchlist (semua ticker aktif)
  const watchlistUnion = [...new Set(active.map(r => r.ticker))].sort();

  // Daily equity 30d
  const dailyEquity = buildDailyEquity(closed, DAILY_EQUITY_DAYS);

  // Safety net
  const safetyNet = buildSafetyNet(closed);

  // Market bias
  const marketBias = buildMarketBias(closed, todayIso);

  // Score brackets
  const scoreBrackets = buildScoreBrackets(closed);

  // IHSG snapshot
  let ihsgObj = null;
  if (ihsgSeries && ihsgSeries.length) {
    const last = ihsgSeries[ihsgSeries.length - 1];
    const prevDay = ihsgSeries.length > 1 ? ihsgSeries[ihsgSeries.length - 2].close : last.open;
    const chgPct = prevDay ? +(((last.close - prevDay) / prevDay) * 100).toFixed(2) : 0;
    ihsgObj = {
      last: +last.close.toFixed(2),
      chgPct,
      date: last.date,
      series30d: ihsgSeries.slice(-30).map(d => ({ date: d.date, close: +d.close.toFixed(2) })),
    };
  } else if (prev && prev.ihsg) {
    ihsgObj = prev.ihsg; // pertahankan
  }

  // ── Build final payload ──
  const payload = {
    updatedAt: new Date().toISOString(),
    generatedBy: 'scripts/build-tracker.js',
    pending: false,
    source: gas.source,
    since: closed.length ? closed.map(r => r.openDate).sort()[0] : todayIso,
    totalClosed: closed.length,
    open: active.length,
    wins: globalSummary.wins,
    losses: globalSummary.losses,
    winrate: globalSummary.winrate,
    netReturn: globalSummary.net,
    profitFactor: pf,
    avgReturn: globalSummary.avg,
    bestPct: globalSummary.best,
    worstPct: globalSummary.worst,
    tpCounts,
    slCount,
    closedByCounts,
    openFloatingPct: openFloating,
    highScore,
    ihsg: ihsgObj,
    marketBias,
    safetyNet,
    dailyEquity,
    scoreBrackets,
    byFirm: mapToObj(firmMap, f => f),
    topFirms, bottomFirms,
    byAnalyst: mapToObj(analystObjMap, a => a),
    byTicker: tickerRows.reduce((o, r) => (o[r.ticker] = r, o), {}),
    topTickers, bottomTickers,
    watchlist: watchlistUnion,
    openList: active.sort((a, b) => (b.openDate || '').localeCompare(a.openDate || '')).map(makeOpenListObj),
    historyList: closed.sort((a, b) => (b.exitDate || '').localeCompare(a.exitDate || '')).slice(0, MAX_HISTORY).map(makeHistoryListObj),
  };

  writeOut(payload);
}

function makeRecActiveObj(rec) {
  return {
    id: rec.id, ticker: rec.ticker, name: rec.tickerName, sector: rec.sector,
    type: rec.type, entry: rec.entry, tp1: rec.tp1, tp2: rec.tp2, sl: rec.sl,
    openDate: rec.openDate, horizon: rec.horizon, horizonDays: rec.horizonDays,
    lastPrice: rec.lastPrice, floatingPct: rec.pnlPct,
    score: rec.score, validity: rec.validity,
    analyst: rec.analyst, cert: rec.cert, verified: rec.verified,
  };
}
function makeRecHistoryObj(rec) {
  return {
    id: rec.id, ticker: rec.ticker, sector: rec.sector,
    type: rec.type, entry: rec.entry, tp1: rec.tp1, tp2: rec.tp2, sl: rec.sl,
    openDate: rec.openDate, exitDate: rec.exitDate, exitPrice: rec.exitPrice,
    closedBy: rec.closedBy, tpHits: rec.tpHits, pnlPct: rec.pnlPct, result: rec.result,
    score: rec.score, validity: rec.validity,
    analyst: rec.analyst, cert: rec.cert, verified: rec.verified,
  };
}
function makeOpenListObj(rec) {
  return {
    id: rec.id, firm: rec.firm, firmId: idOf(rec.firm),
    analyst: rec.analyst, analystId: idOf(rec.analyst), cert: rec.cert, verified: rec.verified,
    ticker: rec.ticker, tickerName: rec.tickerName, sector: rec.sector,
    type: rec.type,
    entry: rec.entry, tp1: rec.tp1, tp2: rec.tp2, sl: rec.sl,
    openDate: rec.openDate, horizon: rec.horizon, horizonDays: rec.horizonDays,
    lastPrice: rec.lastPrice, lastPriceTime: rec.lastPriceTime,
    floatingPct: rec.pnlPct,
    tpHits: rec.tpHits || [],
    status: rec.status,
    score: rec.score, validity: rec.validity,
    intel: { score: rec.score, validity: rec.validity, reasons: rec.reasons || [] },
    note: rec.note,
  };
}
function makeHistoryListObj(rec) {
  return {
    id: rec.id, firm: rec.firm, firmId: idOf(rec.firm),
    analyst: rec.analyst, analystId: idOf(rec.analyst), cert: rec.cert, verified: rec.verified,
    ticker: rec.ticker, tickerName: rec.tickerName, sector: rec.sector,
    type: rec.type,
    entry: rec.entry, tp1: rec.tp1, tp2: rec.tp2, sl: rec.sl,
    openDate: rec.openDate, exitDate: rec.exitDate, exitPrice: rec.exitPrice,
    closedBy: rec.closedBy, tpHits: rec.tpHits || [],
    pnlPct: rec.pnlPct, result: rec.result,
    score: rec.score, validity: rec.validity,
    note: rec.note,
  };
}

function mapToObj(map, fn) {
  const out = {};
  for (const [k, v] of map) out[k] = fn(v);
  return out;
}

function pendingPayload(todayIso, reason, message, ihsgSeries) {
  return {
    updatedAt: new Date().toISOString(),
    generatedBy: 'scripts/build-tracker.js',
    pending: true,
    pendingReason: reason,
    pendingMessage: message,
    since: todayIso,
    totalClosed: 0, open: 0, wins: 0, losses: 0,
    winrate: 0, netReturn: 0, profitFactor: 0, avgReturn: 0,
    bestPct: 0, worstPct: 0,
    tpCounts: { TP1: 0, TP2: 0 }, slCount: 0,
    closedByCounts: { TP: 0, SL: 0, EXPIRED: 0 },
    openFloatingPct: 0, highScore: 0,
    ihsg: ihsgSeries && ihsgSeries.length ? {
      last: +ihsgSeries[ihsgSeries.length - 1].close.toFixed(2),
      chgPct: 0,
      date: ihsgSeries[ihsgSeries.length - 1].date,
      series30d: ihsgSeries.slice(-30).map(d => ({ date: d.date, close: +d.close.toFixed(2) })),
    } : null,
    marketBias: { bullish: 50, bearish: 50, sample: 'recent_48h', count: 0 },
    safetyNet: [], dailyEquity: [], scoreBrackets: [],
    byFirm: {}, topFirms: [], bottomFirms: [],
    byAnalyst: {}, byTicker: {}, topTickers: [], bottomTickers: [],
    watchlist: [], openList: [], historyList: [],
  };
}

function writeOut(payload) {
  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
  const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
  const flag = payload.pending ? ' (PENDING)' : '';
  console.log(`✓ Wrote ${OUT_PATH} (${sizeKB} KB)${flag}`);
  console.log(`  open=${payload.open}, closed=${payload.totalClosed}, wr=${payload.winrate}%, net=${payload.netReturn}%`);
}

// ── Entrypoint ─────────────────────────────────────────────────────────────
if (require.main === module) {
  main().catch(err => { console.error('build-tracker failed:', err); process.exit(1); });
} else {
  module.exports = {
    parseHorizonDays, parseDate, toNumber, normalizeRow,
    derivePosition, scoreValidity, buildAggregations,
    buildDailyEquity, buildSafetyNet, buildMarketBias, buildScoreBrackets,
    idOf,
  };
}
