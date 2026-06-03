/**
 * scripts/build-ohlc.js — build-time OHLC pipeline.
 *
 * Fetch data candle HARIAN (open/high/low/close) untuk SEMUA ticker yang punya
 * rekomendasi analis (consensus_slim di data.json), lalu tulis ke
 * public/ohlc.json. Frontend serve sebagai static asset via CDN jsDelivr dan
 * render candlestick di popup detail rekomendasi.
 *
 * SUMBER DATA (otomatis):
 *   - Twelve Data (UTAMA) — kalau env TWELVEDATA_API_KEY di-set. Cakupan resmi
 *     bursa IDX (exchange XIDX), free tier 800 call/hari & 8 call/menit.
 *   - Yahoo Finance (FALLBACK) — kalau API key tidak ada. Sering kena 401/429
 *     dari IP datacenter, jadi hanya cadangan untuk dev lokal.
 *
 * KENAPA build-time (bukan Cloudflare Worker)?
 *   IP datacenter (Cloudflare Workers) sering diblokir provider data. GitHub
 *   Actions runner + API key resmi jauh lebih andal, dan jadwal cron-nya pas
 *   dengan kebutuhan "tarik data tiap jam 6 sore WIB". API key disimpan di
 *   GitHub Secrets → tidak pernah bocor ke browser (cuma ohlc.json statis).
 *
 * STRATEGI CACHE (sesuai permintaan):
 *   - Per ticker, fetch dari tanggal rekomendasi PALING LAMA (rec_ohlc_meta
 *     atau dihitung dari consensus_slim), di-clamp maksimal 18 bulan ke belakang.
 *   - Incremental: kalau public/ohlc.json sudah ada untuk ticker itu, hanya
 *     re-fetch ~12 hari terakhir lalu di-merge → hemat kuota API.
 *   - Robust: kalau fetch satu ticker gagal, data lama TETAP dipertahankan
 *     (tidak hilang). Retry 3x dengan backoff saat kena 429.
 *   - Data hari ini (berjalan) TIDAK disimpan di sini — frontend overlay
 *     sendiri dari sheet Live (bersifat sementara, intraday).
 *
 * FORMAT OUTPUT (public/ohlc.json) — compact untuk hemat ukuran:
 *   {
 *     "generated_at": "2026-06-03T11:00:00.000Z",
 *     "source": "twelvedata",
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
 *
 * Env:
 *   TWELVEDATA_API_KEY  (opsional) API key Twelve Data. Kalau ada → jadi sumber utama.
 *   TWELVEDATA_EXCHANGE (opsional) override kode bursa. Default "XIDX".
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// Konfigurasi
// ─────────────────────────────────────────────
const DATA_PATH = path.join(__dirname, '..', 'public', 'data.json');
const OUT_PATH  = path.join(__dirname, '..', 'public', 'ohlc.json');
const REC_STATUS_PATH = path.join(__dirname, '..', 'public', 'rec-status.json');

const MAX_BACK_MONTHS    = 18;     // batas paling jauh fetch ke belakang
const INCREMENTAL_DAYS   = 12;     // berapa hari terakhir di-refetch saat incremental
const MAX_RETRIES        = 3;      // retry saat 429 / network error
const RETRY_BACKOFF_MS   = 1500;   // backoff awal (naik linear tiap retry)

// ── Sumber data ──
const TWELVEDATA_API_KEY  = (process.env.TWELVEDATA_API_KEY || '').trim();
// Identifikasi bursa IDX di Twelve Data. PENTING:
//   - mic_code = "XIDX"  (Market Identifier Code — INI yang benar untuk IDX)
//   - exchange = "IDX"   (nama bursa — alternatif)
// JANGAN pakai exchange="XIDX" (campur MIC ke param nama → "symbol invalid").
// Bisa di-override via env kalau ternyata akun butuh format lain.
const TWELVEDATA_MIC      = (process.env.TWELVEDATA_MIC || 'XIDX').trim();
const TWELVEDATA_EXCHANGE = (process.env.TWELVEDATA_EXCHANGE || '').trim();
const TWELVEDATA_COUNTRY  = (process.env.TWELVEDATA_COUNTRY || '').trim();

// Pilih sumber data:
//   - OHLC_SOURCE env eksplisit ('yahoo' | 'twelvedata') menang.
//   - Default 'yahoo'. CATATAN: Twelve Data FREE tier meng-gate saham IDX ke
//     plan Pro/Venture (berbayar) → JANGAN auto-pilih twelvedata walau key ada.
//     Set OHLC_SOURCE=twelvedata HANYA kalau akun Twelve Data sudah upgrade.
const SOURCE = (process.env.OHLC_SOURCE || 'yahoo').trim().toLowerCase();

// Jeda antar request — beda per sumber:
//   - Twelve Data: 8 call/menit → 8 dtk/call (7.5/menit, aman di bawah limit)
//   - Yahoo: 400 ms (volume rendah, sekali sehari)
const FETCH_DELAY_MS = SOURCE === 'twelvedata' ? 8000 : 400;

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
  const qs = `?interval=1d&period1=${period1}&period2=${period2}&events=div,split`;
  // Coba 2 host Yahoo (query1 & query2) — kalau satu diblokir, coba yang lain.
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const host = hosts[(attempt - 1) % hosts.length];
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}${qs}`;
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
 * Fetch OHLC harian dari Twelve Data time_series API.
 * Free tier: 800 call/hari, 8 call/menit. Cakupan bursa IDX = XIDX.
 *
 * Catatan kuota: 1 ticker = 1 credit. 111 ticker << 800/hari → aman.
 * Rate-limit per-menit ditangani via FETCH_DELAY_MS (8 dtk) di main loop,
 * plus retry kalau tetap kena 429.
 *
 * @param {string} ticker      - kode IDX murni, mis. "TLKM" (tanpa suffix)
 * @param {string} fromIsoDate - "YYYY-MM-DD"
 * @returns {Array<[number,number,number,number,number]>} [[unixDaySec,o,h,l,c],...] asc
 */
async function fetchTwelveData(ticker, fromIsoDate) {
  const params = new URLSearchParams({
    symbol:     ticker,
    interval:   '1day',
    start_date: fromIsoDate,
    order:      'ASC',
    outputsize: '5000',
    format:     'JSON',
    apikey:     TWELVEDATA_API_KEY,
  });
  // Identifikasi bursa — prioritas: mic_code > exchange > country.
  // Default mic_code=XIDX (Market Identifier Code resmi IDX).
  if (TWELVEDATA_MIC)      params.set('mic_code', TWELVEDATA_MIC);
  else if (TWELVEDATA_EXCHANGE) params.set('exchange', TWELVEDATA_EXCHANGE);
  if (TWELVEDATA_COUNTRY)  params.set('country', TWELVEDATA_COUNTRY);

  const url = `https://api.twelvedata.com/time_series?${params.toString()}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      // Twelve Data biasanya balas HTTP 200 walau error logis (cek body).
      if (res.status === 429) throw new Error('HTTP 429 (rate-limit)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const json = await res.json();

      // Error logis: { status:'error', code, message }
      if (json && json.status === 'error') {
        const code = json.code;
        const msg  = json.message || 'unknown error';
        // 429 di body → tunggu lebih lama lalu retry
        if (code === 429) throw new Error(`429 body: ${msg}`);
        // 400/404 = simbol/bursa salah / tidak ada data → jangan retry
        throw new Error(`TD ${code}: ${msg}`);
      }

      const values = (json && Array.isArray(json.values)) ? json.values : [];
      const candles = [];
      for (const v of values) {
        const o = parseFloat(v.open), h = parseFloat(v.high),
              l = parseFloat(v.low),  c = parseFloat(v.close);
        if (![o, h, l, c].every(Number.isFinite)) continue;
        const dayUnix = dayToUnix(String(v.datetime).slice(0, 10));
        candles.push([dayUnix, Math.round(o), Math.round(h), Math.round(l), Math.round(c)]);
      }
      candles.sort((a, b) => a[0] - b[0]);
      return candles;

    } catch (e) {
      lastErr = e;
      // Backoff lebih panjang untuk 429 (limit per-menit reset tiap 60 dtk)
      const is429 = /429/.test(e.message);
      if (attempt < MAX_RETRIES) {
        await sleep(is429 ? 60000 : RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastErr || new Error('fetch gagal (unknown)');
}

/**
 * Dispatcher: pilih sumber sesuai SOURCE.
 * @param {string} ticker - kode IDX murni ("TLKM")
 * @param {string} fromIsoDate
 */
async function fetchCandles(ticker, fromIsoDate) {
  if (SOURCE === 'twelvedata') return fetchTwelveData(ticker, fromIsoDate);
  return fetchYahooOhlc(toYahooSymbol(ticker), fromIsoDate);
}

// ─────────────────────────────────────────────
// REC STATUS — release price + hit-target per rekomendasi (di-cache & freeze)
// ─────────────────────────────────────────────

/** Key unik per rekomendasi. Firm tidak mengandung "|", aman dipakai delimiter. */
function recKey(ticker, r) {
  return `${ticker}|${String(r.date).slice(0, 10)}|${r.firm || ''}|${r.suggestion || ''}|${r.target_price || ''}`;
}

/**
 * Bangun rec-status.json: untuk tiap rekomendasi di consensus, hitung dari
 * data HARIAN (OHLC):
 *   - release_price : close candle di tanggal rilis (close pertama >= tgl rilis)
 *   - hit / hit_date: apakah harga pernah menyentuh target (BUY/NEUTRAL high>=tgt,
 *                     SELL low<=tgt) + tanggal pertama tersentuh
 *   - hit_return    : (target - release)/release saat hit (return ketika target tercapai)
 *   - risk_low      : low TERENDAH dalam window rilis→hit (kalau hit) atau rilis→now.
 *                     Drop harga SETELAH hit tidak dihitung sebagai risk.
 *   - highest/lowest: high/low ekstrem sejak rilis (semua, untuk display faktual)
 *
 * FREEZE: kalau entry sudah ada di cache lama dgn hit=true, pertahankan
 * hit/hit_date/hit_return/risk_low/release_price (tidak dihitung ulang).
 * PRUNE : key yang tidak ada lagi di consensus otomatis hilang (tidak disalin).
 *
 * @param {object} consensus  - DATA.consensus_slim {ticker:[recs]}
 * @param {object} ohlcTickers- outTickers {ticker:{from,candles:[[ts,o,h,l,c]]}}
 * @param {object} prev       - rec-status.json lama (untuk freeze)
 */
function buildRecStatus(consensus, ohlcTickers, prev) {
  const prevRecs = (prev && prev.recs) || {};
  const out = { generated_at: new Date().toISOString(), recs: {} };
  let total = 0, hitCount = 0, frozen = 0;

  for (const [ticker, recs] of Object.entries(consensus || {})) {
    const entry = ohlcTickers[ticker];
    const candles = (entry && Array.isArray(entry.candles)) ? entry.candles : null;

    for (const r of (recs || [])) {
      if (!r.date) continue;
      const key = recKey(ticker, r);
      const prevS = prevRecs[key];
      const target = Number(r.target_price);
      const isSell = r.suggestion === 'SELL';
      total++;

      const recUnix = dayToUnix(String(r.date).slice(0, 10));
      const since = candles ? candles.filter((c) => c[0] >= recUnix) : [];

      // Tidak ada data harian → pertahankan cache lama kalau ada
      if (since.length === 0) {
        if (prevS) { out.recs[key] = prevS; frozen++; }
        continue;
      }

      // release_price: freeze kalau sudah pernah tercatat (deterministik tapi
      // aman dari window OHLC yang bergeser)
      const releasePrice = (prevS && prevS.release_price > 0) ? prevS.release_price : since[0][4];
      const releaseDate  = (prevS && prevS.release_date) || isoDay(new Date(since[0][0] * 1000));

      // hit: freeze kalau sudah true
      let hit = false, hitDate = null;
      if (prevS && prevS.hit) {
        hit = true; hitDate = prevS.hit_date;
      } else if (Number.isFinite(target) && target > 0) {
        for (const c of since) {
          const reached = isSell ? (c[3] <= target) : (c[2] >= target); // c[2]=high, c[3]=low
          if (reached) { hit = true; hitDate = isoDay(new Date(c[0] * 1000)); break; }
        }
      }
      if (hit) hitCount++;
      const hitReturn = (hit && releasePrice > 0 && Number.isFinite(target))
        ? (isSell ? (releasePrice - target) : (target - releasePrice)) / releasePrice
        : null;

      // highest & lowest sejak rilis (semua candle, faktual untuk display)
      let hi = -Infinity, hiD = null, lo = Infinity, loD = null;
      for (const c of since) {
        if (c[2] > hi) { hi = c[2]; hiD = isoDay(new Date(c[0] * 1000)); }
        if (c[3] < lo) { lo = c[3]; loD = isoDay(new Date(c[0] * 1000)); }
      }

      // risk_low: low terendah dalam window rilis→hit (inklusif). Drop setelah
      // hit TIDAK dihitung. Freeze kalau sudah hit (window tidak bertambah lagi).
      let riskLow, riskLowD;
      if (prevS && prevS.hit && Number.isFinite(prevS.risk_low)) {
        riskLow = prevS.risk_low; riskLowD = prevS.risk_low_date; frozen++;
      } else {
        riskLow = Infinity; riskLowD = null;
        const hitUnix = (hit && hitDate) ? dayToUnix(hitDate) : Infinity;
        for (const c of since) {
          if (c[0] > hitUnix) break;             // exclude candle setelah hit
          if (c[3] < riskLow) { riskLow = c[3]; riskLowD = isoDay(new Date(c[0] * 1000)); }
        }
      }

      out.recs[key] = {
        release_price: releasePrice,
        release_date:  releaseDate,
        hit,
        hit_date:      hitDate,
        hit_return:    hitReturn,
        highest:       hi === -Infinity ? null : hi,
        highest_date:  hiD,
        lowest:        lo === Infinity ? null : lo,
        lowest_date:   loD,
        risk_low:      riskLow === Infinity ? null : riskLow,
        risk_low_date: riskLowD,
        last_date:     isoDay(new Date(since[since.length - 1][0] * 1000)),
      };
    }
  }

  return { payload: out, stats: { total, hitCount, frozen } };
}
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
  console.log(`OHLC build: ${tickers.length} ticker · mode=${fullMode ? 'full' : 'incremental'} · source=${SOURCE}${SOURCE === 'twelvedata' ? ' (XIDX)' : ''}`);
  if (SOURCE === 'twelvedata' && !TWELVEDATA_API_KEY) {
    console.error('FATAL: OHLC_SOURCE=twelvedata tapi TWELVEDATA_API_KEY kosong.');
    process.exit(1);
  }
  if (SOURCE === 'twelvedata') {
    console.warn('  ℹ️  Twelve Data free tier meng-gate saham IDX (butuh Pro/Venture). Pastikan akun sudah upgrade.');
  }

  // Load cache lama (kalau ada)
  let cache = { generated_at: null, source: SOURCE, tickers: {} };
  if (!fullMode && fs.existsSync(OUT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
      if (prev && prev.tickers) cache = prev;
    } catch (_) { /* corrupt cache → mulai fresh */ }
  }

  const outTickers = { ...cache.tickers };
  let okCount = 0, failCount = 0, skipCount = 0, totalCandles = 0;

  for (const t of tickers) {
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
      const fresh = await fetchCandles(t, fetchFrom);

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
      console.warn(`  ⚠️  ${t}: ${e.message}${existing ? ' → pakai cache lama' : ''}`);
    }

    await sleep(FETCH_DELAY_MS);
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: SOURCE,
    max_back_months: MAX_BACK_MONTHS,
    ticker_count: Object.keys(outTickers).length,
    tickers: outTickers,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
  const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);

  console.log(`✓ Wrote ${OUT_PATH} (${sizeKB} KB)`);
  console.log(`  OK: ${okCount} · cache-kept: ${skipCount} · gagal: ${failCount} · total candle: ${totalCandles}`);
  if (failCount > 0 && okCount === 0) {
    console.error(`FATAL: semua fetch gagal (source=${SOURCE}). Cek API key / cakupan bursa / log di atas.`);
    process.exit(1);
  }

  // ── rec-status.json: release price + hit-target per rekomendasi ─────────
  try {
    let prevRecStatus = null;
    if (fs.existsSync(REC_STATUS_PATH)) {
      try { prevRecStatus = JSON.parse(fs.readFileSync(REC_STATUS_PATH, 'utf8')); } catch (_) {}
    }
    const { payload: recStatus, stats: rs } = buildRecStatus(
      data.consensus_slim || {}, outTickers, prevRecStatus
    );
    fs.writeFileSync(REC_STATUS_PATH, JSON.stringify(recStatus));
    const rsKB = (fs.statSync(REC_STATUS_PATH).size / 1024).toFixed(1);
    console.log(`✓ Wrote ${REC_STATUS_PATH} (${rsKB} KB)`);
    console.log(`  Recs: ${rs.total} · hit target: ${rs.hitCount} · frozen: ${rs.frozen}`);
  } catch (e) {
    console.warn('  ⚠️  Gagal bangun rec-status.json:', e.message);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('build-ohlc failed:', err);
    process.exit(1);
  });
} else {
  module.exports = { toYahooSymbol, fetchYahooOhlc, fetchTwelveData, fetchCandles, mergeCandles, buildTickerTargets, buildRecStatus, recKey };
}
