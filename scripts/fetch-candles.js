/**
 * scripts/fetch-candles.js — Fetch daily OHLC candle data dari Yahoo Finance.
 *
 * Strategy:
 *   1. Baca public/data.json → ambil consensus_slim → extract unique tickers
 *      dan tanggal rekomendasi paling awal per ticker.
 *   2. Baca cache (public/candles.json) jika ada.
 *   3. Per ticker: hitung tanggal terakhir di cache → fetch hanya data baru
 *      (dari last cached date + 1 hari sampai kemarin).
 *   4. Merge data baru ke cache, tulis ulang public/candles.json.
 *
 * Caching:
 *   - candles.json format: { "TLKM": [{d:"2026-01-02",o:3000,h:3050,l:2980,c:3020,v:12345}, ...], ... }
 *   - Setiap run hanya fetch hari-hari yang belum ada di cache.
 *   - Kalau ticker baru muncul di consensus → fetch dari tanggal rec paling awal.
 *
 * API: Yahoo Finance v8 chart endpoint (free, no key needed)
 *   URL: https://query2.finance.yahoo.com/v8/finance/chart/{TICKER}.JK
 *   Params: period1, period2 (unix timestamp), interval=1d
 *
 * Usage:
 *   node scripts/fetch-candles.js
 *
 * Environment (optional):
 *   CANDLE_LOOKBACK_DAYS — extra days before earliest rec date (default: 5)
 *   CANDLE_BATCH_DELAY   — ms delay between API calls (default: 600)
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────
const DATA_PATH = path.join(__dirname, '..', 'public', 'data.json');
const CANDLES_PATH = path.join(__dirname, '..', 'public', 'candles.json');
const LOOKBACK_DAYS = parseInt(process.env.CANDLE_LOOKBACK_DAYS || '5', 10);
const BATCH_DELAY = parseInt(process.env.CANDLE_BATCH_DELAY || '600', 10);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function toUnix(dateStr) {
  return Math.floor(new Date(dateStr + 'T00:00:00Z').getTime() / 1000);
}

function fromUnix(ts) {
  const d = new Date(ts * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return fromUnix(Math.floor(d.getTime() / 1000));
}

function yesterdayStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return fromUnix(Math.floor(d.getTime() / 1000));
}

function todayStr() {
  return fromUnix(Math.floor(Date.now() / 1000));
}

// ─────────────────────────────────────────────
// Yahoo Finance fetcher
// ─────────────────────────────────────────────
async function fetchYahooCandles(ticker, fromDate, toDate) {
  const symbol = `${ticker}.JK`;
  const period1 = toUnix(fromDate);
  const period2 = toUnix(toDate) + 86400; // inclusive end-of-day

  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&events=history`;

  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/json',
        },
      });
      if (res.status === 429) {
        // Rate limited — wait and retry
        console.warn(`  ⚠ Rate limited on ${ticker}, waiting 5s…`);
        await sleep(5000);
        continue;
      }
      break;
    } catch (e) {
      if (attempt < 2) {
        await sleep(2000);
        continue;
      }
      throw e;
    }
  }

  if (!res || !res.ok) {
    console.warn(`  ✗ ${ticker}: HTTP ${res ? res.status : 'no response'}`);
    return null;
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    console.warn(`  ✗ ${ticker}: no chart result`);
    return null;
  }

  const timestamps = result.timestamp;
  const quote = result.indicators?.quote?.[0];
  if (!timestamps || !quote) {
    console.warn(`  ✗ ${ticker}: no timestamp/quote data`);
    return null;
  }

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];

    // Skip null entries (market holidays/gaps)
    if (o == null || h == null || l == null || c == null) continue;

    candles.push({
      d: fromUnix(timestamps[i]),
      o: Math.round(o),
      h: Math.round(h),
      l: Math.round(l),
      c: Math.round(c),
      v: v || 0,
    });
  }

  return candles;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  FETCH CANDLES — Daily OHLC from YF  ║');
  console.log('╚═══════════════════════════════════════╝');

  // 1. Load data.json → get ticker list + earliest rec dates
  if (!fs.existsSync(DATA_PATH)) {
    console.error('FATAL: public/data.json not found. Run build-data.js first.');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const consensus = data.consensus_slim || {};

  // Build map: ticker → earliest recommendation date
  const tickerDates = {};
  for (const [ticker, recs] of Object.entries(consensus)) {
    if (!recs || !recs.length) continue;
    // recs sorted desc by date, so last element = earliest
    let earliest = null;
    for (const r of recs) {
      if (!r.date) continue;
      if (!earliest || r.date < earliest) earliest = r.date;
    }
    if (earliest) {
      tickerDates[ticker] = earliest;
    }
  }

  const tickers = Object.keys(tickerDates).sort();
  console.log(`\n📊 ${tickers.length} tickers with recommendations found.`);

  // 2. Load existing cache
  let cache = {};
  if (fs.existsSync(CANDLES_PATH)) {
    try {
      cache = JSON.parse(fs.readFileSync(CANDLES_PATH, 'utf8'));
      console.log(`📂 Cache loaded: ${Object.keys(cache).length} tickers cached.`);
    } catch (e) {
      console.warn('⚠ Cache corrupt, starting fresh.');
      cache = {};
    }
  } else {
    console.log('📂 No cache found, starting fresh.');
  }

  // 3. Remove tickers no longer in consensus
  const removedTickers = Object.keys(cache).filter(t => !tickerDates[t]);
  if (removedTickers.length > 0) {
    console.log(`🗑  Removing ${removedTickers.length} tickers no longer in consensus.`);
    for (const t of removedTickers) delete cache[t];
  }

  // 4. Fetch per ticker — smart caching
  const endDate = todayStr(); // fetch up to today (API returns yesterday if market closed)
  let fetched = 0, skipped = 0, errors = 0;

  for (const ticker of tickers) {
    const earliestRec = tickerDates[ticker];
    const fetchStart = addDays(earliestRec, -LOOKBACK_DAYS); // extra lookback

    // Check cache: last date cached
    const cached = cache[ticker] || [];
    let lastCachedDate = null;
    if (cached.length > 0) {
      lastCachedDate = cached[cached.length - 1].d;
    }

    // Determine fetch range
    let fromDate;
    if (lastCachedDate) {
      // Only fetch from day after last cached
      fromDate = addDays(lastCachedDate, 1);
    } else {
      // New ticker — fetch from (earliest rec - lookback)
      fromDate = fetchStart;
    }

    // Skip if already up-to-date (last cached = yesterday or today)
    const yesterday = yesterdayStr();
    if (lastCachedDate && lastCachedDate >= yesterday) {
      skipped++;
      continue;
    }

    // Skip if fromDate > endDate (shouldn't happen but safety)
    if (fromDate > endDate) {
      skipped++;
      continue;
    }

    // Fetch
    process.stdout.write(`  ${ticker} [${fromDate} → ${endDate}]… `);
    const candles = await fetchYahooCandles(ticker, fromDate, endDate);

    if (candles && candles.length > 0) {
      // Merge: append new candles (dedup by date)
      const existingDates = new Set(cached.map(c => c.d));
      const newCandles = candles.filter(c => !existingDates.has(c.d));
      cache[ticker] = [...cached, ...newCandles].sort((a, b) => a.d.localeCompare(b.d));
      console.log(`✓ ${newCandles.length} new candles (total: ${cache[ticker].length})`);
      fetched++;
    } else if (candles && candles.length === 0) {
      // No new data (weekend/holiday)
      console.log('— no new data');
      if (!cache[ticker]) cache[ticker] = [];
      skipped++;
    } else {
      console.log('✗ error');
      errors++;
    }

    // Rate limiting
    await sleep(BATCH_DELAY);
  }

  // 5. Write cache
  console.log(`\n═══════════════════════════════════════`);
  console.log(`✓ Fetched: ${fetched} | Skipped: ${skipped} | Errors: ${errors}`);

  const outDir = path.dirname(CANDLES_PATH);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(CANDLES_PATH, JSON.stringify(cache));
  const sizeKB = (fs.statSync(CANDLES_PATH).size / 1024).toFixed(1);
  console.log(`✓ Saved candles.json (${sizeKB} KB) — ${Object.keys(cache).length} tickers`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
