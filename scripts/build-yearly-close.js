#!/usr/bin/env node
/**
 * build-yearly-close.js — harga PENUTUP TAHUNAN per saham dari Yahoo Finance.
 *
 * KENAPA?
 *   price_history (data.json) hanya mulai Juni 2016. Untuk mengisi harga tahunan
 *   Excel yang 'Libur' di tahun <2016 (mis. 2015, 2014, ...), build-valuation.py
 *   butuh sumber lebih jauh. Script ini menarik close BULANAN dari Yahoo sejak
 *   START_YEAR, lalu menyimpan close tutup-tahun (Desember/terakhir) per tahun ke
 *   public/history-yearly.json. build-valuation memakainya sebagai FALLBACK setelah
 *   price_history.
 *
 *   Urutan sumber harga tahunan: Excel → price_history (2016+) → history-yearly (Yahoo).
 *
 * SIFAT:
 *   - Incremental & robust: gabung dengan cache lama; gagal per-ticker → cache lama
 *     dipertahankan. Data tahun lampau jarang berubah → cukup jalan mingguan.
 *   - Build-time (GitHub Actions + Yahoo) seperti build-ohlc.js — bukan Worker.
 *
 * Output public/history-yearly.json:
 *   { "generated_at": "...", "source": "yahoo", "start_year": 2005,
 *     "closes": { "TLKM": { "2015": 3105, "2014": 2865, ... }, ... } }
 *
 * Usage:
 *   node scripts/build-yearly-close.js                 # semua saham, incremental
 *   node scripts/build-yearly-close.js --only=TLKM,BBCA # batasi (debug)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const DATA_FILE = path.join(ROOT, 'public', 'data.json');
const OUT_FILE  = path.join(ROOT, 'public', 'history-yearly.json');

const START_YEAR  = 2005;
const FETCH_DELAY = 400;     // ms antar request (volume rendah, mingguan)
const MAX_RETRIES = 3;
const BACKOFF_MS  = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function toYahooSymbol(code) {
  const u = String(code || '').trim().toUpperCase();
  if (!u) return null;
  return u.includes('.') ? u : u + '.JK';
}

/** Fetch close bulanan Yahoo → {year: closeTutupTahun}. */
async function fetchYearlyClose(symbol) {
  const p1 = Math.floor(Date.UTC(START_YEAR, 0, 1) / 1000);
  const p2 = Math.floor(Date.now() / 1000);
  const qs = `?interval=1mo&period1=${p1}&period2=${p2}`;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const host = hosts[(attempt - 1) % hosts.length];
    try {
      const res = await fetch(`https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}${qs}`, {
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
      const result = json && json.chart && json.chart.result && json.chart.result[0];
      if (!result) throw new Error('no result');
      const ts = result.timestamp || [];
      const close = (result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];
      const byYear = {};   // year -> {month, close} (simpan bulan terakhir per tahun)
      for (let i = 0; i < ts.length; i++) {
        const c = close[i];
        if (c == null || !Number.isFinite(c)) continue;
        const d = new Date(ts[i] * 1000);
        const y = d.getUTCFullYear();
        const mo = d.getUTCMonth() + 1;
        if (!byYear[y] || mo > byYear[y].mo) byYear[y] = { mo, close: Math.round(c) };
      }
      const out = {};
      for (const y of Object.keys(byYear)) out[y] = byYear[y].close;
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await sleep(BACKOFF_MS * attempt);
    }
  }
  throw lastErr || new Error('fetch gagal');
}

async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const onlyset = onlyArg ? new Set(onlyArg.split('=')[1].split(',').map((s) => s.trim().toUpperCase())) : null;

  if (!fs.existsSync(DATA_FILE)) {
    console.error(`FATAL: ${DATA_FILE} tidak ada (jalankan build-data dulu).`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  let universe = (data.stock_list || [])
    .map((s) => String((s && (s.code || s.ticker || s.symbol)) || '').trim().toUpperCase())
    .filter(Boolean);
  if (universe.length === 0) universe = Object.keys(data.stats || {}).map((k) => k.toUpperCase());
  universe = Array.from(new Set(universe));
  if (onlyset) universe = universe.filter((t) => onlyset.has(t));

  let cache = { closes: {} };
  if (fs.existsSync(OUT_FILE)) {
    try { const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); if (prev && prev.closes) cache = prev; } catch (_) {}
  }
  const closes = Object.assign({}, cache.closes || {});

  console.log(`yearly-close: ${universe.length} ticker · sejak ${START_YEAR} · sumber Yahoo`);
  let ok = 0, fail = 0;
  for (const code of universe) {
    try {
      const y = await fetchYearlyClose(toYahooSymbol(code));
      if (y && Object.keys(y).length) {
        closes[code] = Object.assign({}, closes[code] || {}, y);   // merge: pertahankan lama
        ok++;
      } else { fail++; }
    } catch (e) {
      fail++;
      console.warn(`  ⚠️  ${code}: ${e.message}`);
    }
    await sleep(FETCH_DELAY);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: 'yahoo',
    start_year: START_YEAR,
    ticker_count: Object.keys(closes).length,
    closes,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload));
  const sizeKB = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
  console.log(`✓ Wrote ${OUT_FILE} (${sizeKB} KB) — OK: ${ok} · gagal: ${fail} · total ticker: ${Object.keys(closes).length}`);
  if (ok === 0 && fail > 0) { console.error('FATAL: semua fetch gagal.'); process.exit(1); }
}

main().catch((e) => { console.error('build-yearly-close failed:', e); process.exit(1); });
