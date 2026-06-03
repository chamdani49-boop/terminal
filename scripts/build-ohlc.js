/**
 * scripts/build-ohlc.js — build-time OHLC pipeline.
 *
 * Fetch data candle HARIAN (open/high/low/close) dari Yahoo Finance untuk
 * SEMUA ticker yang punya rekomendasi analis (consensus_slim di data.json),
 * lalu tulis ke public/ohlc.json. Frontend serve sebagai static asset via
 * CDN jsDelivr dan render candlestick di popup detail rekomendasi.
 *
 * KENAPA build-time (bukan Cloudflare Worker)?
 *   Yahoo Finance agresif memblokir IP datacenter (Cloudflare Workers sering
 *   kena 401/429). GitHub Actions runner pakai IP ephemeral yang jauh lebih
 *   jarang diblokir, dan jadwal cron-nya pas dengan kebutuhan "tarik data tiap
 *   jam 6 sore WIB".
 *
 * STRATEGI CACHE (sesuai permintaan):
 *   - Per ticker, fetch dari tanggal rekomendasi PALING LAMA (rec_ohlc_meta
 *     atau dihitung dari consensus_slim), di-clamp maksimal 18 bulan ke belakang.
 *   - Incremental: kalau public/ohlc.json sudah ada untuk ticker itu, hanya
 *     re-fetch ~10 hari terakhir lalu di-merge → hemat request ke Yahoo.
 *   - Robust: kalau fetch satu ticker gagal, data lama TETAP dipertahankan
 *     (tidak hilang). Retry 3x dengan backoff saat kena 429.
 *   - Data hari ini (berjalan) TIDAK disimpan di sini — frontend overlay
 *     sendiri dari sheet Live (bersifat sementara, intraday).
 *
 * FORMAT OUTPUT (public/ohlc.json) — compact untuk hemat ukuran:
 *   {
 *     "generated_at": "2026-06-03T11:00:00.000Z",
 *     "source": "yahoo",
 *     "tickers": {
 *       "TLKM": {
 *         "from": "2025-11-27",
 *         "candles": [[unixDaySec, open, high, low, close], ...]   // urut asc
 *       },
 *       ...
 *     }
 *   }
 *
 * Usage:
 *   node scripts/build-ohlc.js                 # incremental (default)
 *   node scripts/build-ohlc.js --full          # abaikan cache, fetch ulang penuh
 *   node scripts/build-ohlc.js --only=TLKM,BBCA # batasi ke ticker tertentu (debug)
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// Konfigurasi
// ─────────────────────────────────────────────
const DATA_PATH = path.join(__dirname, '..', 'public', 'data.json');
const OUT_PATH  = path.join(__dirname, '..', 'public', 'ohlc.json');

const MAX_BACK_MONTHS    = 18;     // batas paling jauh fetch ke belakang
const INCREMENTAL_DAYS   = 12;     // berapa hari terakhir di-refetch saat incremental
const FETCH_DELAY_MS     = 350;    // jeda antar request (sopan ke Yahoo)
const MAX_RETRIES        = 3;      // retry saat 429 / network error
const RETRY_BACKOFF_MS   = 1500;   // backoff awal (naik linear tiap retry)

// ─────────────────────────────────────────────
// Util
// ─────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoDay(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Kode IDX → simbol Yahoo (suffix .JK). "TLKM" → "TLKM.JK" */
function toYahooSymbol(code) {
  const upper = String(code || '').trim().toUpperCase();
  if (!upper) return null;
  if (upper.includes('.')) return upper;
  return upper + '.JK';
}

/** Unix detik (UTC midnight) dari ISO "YYYY-MM-DD". */
function dayToUnix(isoDateStr) {
  return Math.floor(new Date(isoDateStr + 'T00:00:00Z').getTime() / 1000);
}

/**
 * Fetch OHLC harian dari Yahoo Finance v8 chart API.
 * @returns {Array<[number,number,number,number,number]>} [[unixDaySec,o,h,l,c],...] asc
 */
async function fetchYahooOhlc(symbol, fromIsoDate) {
  const period1 = dayToUnix(fromIsoDate);
  const period2 = Math.floor(Date.now() / 1000);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${period1}&period2=${period2}&events=div,split`;

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
        },
        redirect: 'follow',
      });

      if (res.status === 429 || res.status === 401 || res.status === 403) {
        throw new Error(`HTTP ${res.status} (rate-limit/blocked)`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) {
        const errDesc = json?.chart?.error?.description || 'no result';
        throw new Error(`Yahoo: ${errDesc}`);
      }

      const ts = result.timestamp || [];
      const q  = result.indicators?.quote?.[0] || {};
      const o = q.open || [], h = q.high || [], l = q.low || [], c = q.close || [];

      const candles = [];
      for (let i = 0; i < ts.length; i++) {
        if (o[i] == null || h[i] == null || l[i] == null || c[i] == null) continue;
        if (!Number.isFinite(o[i]) || !Number.isFinite(c[i])) continue;
        // Normalisasi ke UTC midnight (Yahoo timestamp = jam buka bursa lokal)
        const d = new Date(ts[i] * 1000);
        const dayUnix = dayToUnix(isoDay(d));
        candles.push([dayUnix, Math.round(o[i]), Math.round(h[i]), Math.round(l[i]), Math.round(c[i])]);
      }
      candles.sort((a, b) => a[0] - b[0]);
      return candles;

    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastErr || new Error('fetch gagal (unknown)');
}

/**
 * Merge candle lama + baru berdasarkan unix-day (kolom 0).
 * Candle baru menimpa yang lama untuk hari yang sama (koreksi/adjustment).
 */
function mergeCandles(oldCandles, newCandles) {
  const map = new Map();
  for (const c of (oldCandles || [])) map.set(c[0], c);
  for (const c of (newCandles || [])) map.set(c[0], c);
  return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
}

// ─────────────────────────────────────────────
// Tentukan daftar ticker + tanggal "from" per ticker
// ─────────────────────────────────────────────
function buildTickerTargets(data) {
  const maxBack = new Date();
  maxBack.setUTCMonth(maxBack.getUTCMonth() - MAX_BACK_MONTHS);
  const maxBackStr = isoDay(maxBack);

  // Prioritas 1: rec_ohlc_meta (sudah dihitung build-data.js)
  const meta = data.rec_ohlc_meta;
  if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
    const out = {};
    for (const [t, from] of Object.entries(meta)) {
      out[t] = (from && from > maxBackStr) ? from : maxBackStr;
    }
    return out;
  }

  // Prioritas 2: hitung dari consensus_slim
  const cs = data.consensus_slim || {};
  const out = {};
  for (const [t, recs] of Object.entries(cs)) {
    const dates = (recs || []).map((r) => r.date).filter(Boolean).sort();
    if (dates.length === 0) continue;
    const oldest = dates[0].slice(0, 10);
    out[t] = (oldest > maxBackStr) ? oldest : maxBackStr;
  }
  return out;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const fullMode = args.includes('--full');
  const onlyArg  = args.find((a) => a.startsWith('--only='));
  const onlyset  = onlyArg ? new Set(onlyArg.split('=')[1].split(',').map((s) => s.trim().toUpperCase())) : null;

  // Load data.json (sumber daftar ticker)
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`FATAL: ${DATA_PATH} tidak ada. Jalankan build-data.js dulu.`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));

  let targets = buildTickerTargets(data);
  if (onlyset) {
    targets = Object.fromEntries(Object.entries(targets).filter(([t]) => onlyset.has(t)));
  }
  const tickers = Object.keys(targets).sort();
  if (tickers.length === 0) {
    console.error('FATAL: tidak ada ticker consensus di data.json.');
    process.exit(1);
  }
  console.log(`OHLC build: ${tickers.length} ticker · mode=${fullMode ? 'full' : 'incremental'}`);

  // Load cache lama (kalau ada)
  let cache = { generated_at: null, source: 'yahoo', tickers: {} };
  if (!fullMode && fs.existsSync(OUT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
      if (prev && prev.tickers) cache = prev;
    } catch (_) { /* corrupt cache → mulai fresh */ }
  }

  const outTickers = { ...cache.tickers };
  let okCount = 0, failCount = 0, skipCount = 0, totalCandles = 0;

  for (const t of tickers) {
    const symbol      = toYahooSymbol(t);
    const desiredFrom = targets[t];
    const existing    = (!fullMode && cache.tickers[t]) ? cache.tickers[t] : null;

    // Tentukan titik mulai fetch
    let fetchFrom = desiredFrom;
    let incremental = false;
    if (existing && Array.isArray(existing.candles) && existing.candles.length > 0
        && existing.from && existing.from <= desiredFrom) {
      // Cache valid → fetch hanya beberapa hari terakhir
      const lastUnix = existing.candles[existing.candles.length - 1][0];
      const lastDate = new Date(lastUnix * 1000);
      lastDate.setUTCDate(lastDate.getUTCDate() - INCREMENTAL_DAYS);
      fetchFrom = isoDay(lastDate);
      incremental = true;
    }

    try {
      const fresh = await fetchYahooOhlc(symbol, fetchFrom);

      if (fresh.length === 0) {
        // Tidak ada candle baru → pertahankan cache lama kalau ada
        if (existing) { outTickers[t] = existing; skipCount++; }
        else { failCount++; console.warn(`  ⚠️  ${t}: 0 candle & tidak ada cache`); }
      } else {
        const merged = incremental && existing
          ? mergeCandles(existing.candles, fresh)
          : fresh;
        // Potong agar tidak menyimpan data sebelum desiredFrom (hemat ukuran)
        const fromUnix = dayToUnix(desiredFrom);
        const trimmed  = merged.filter((c) => c[0] >= fromUnix);
        outTickers[t] = { from: desiredFrom, candles: trimmed };
        okCount++;
        totalCandles += trimmed.length;
      }
    } catch (e) {
      // Fetch gagal → pertahankan cache lama supaya data tidak hilang
      if (existing) { outTickers[t] = existing; skipCount++; }
      else failCount++;
      console.warn(`  ⚠️  ${t} (${symbol}): ${e.message}${existing ? ' → pakai cache lama' : ''}`);
    }

    await sleep(FETCH_DELAY_MS);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: 'yahoo',
    max_back_months: MAX_BACK_MONTHS,
    ticker_count: Object.keys(outTickers).length,
    tickers: outTickers,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
  const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);

  console.log(`✓ Wrote ${OUT_PATH} (${sizeKB} KB)`);
  console.log(`  OK: ${okCount} · cache-kept: ${skipCount} · gagal: ${failCount} · total candle: ${totalCandles}`);
  if (failCount > 0 && okCount === 0) {
    console.error('FATAL: semua fetch gagal (kemungkinan Yahoo memblokir IP runner). Cek log di atas.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('build-ohlc failed:', err);
    process.exit(1);
  });
} else {
  module.exports = { toYahooSymbol, fetchYahooOhlc, mergeCandles, buildTickerTargets };
}
