/**
 * scripts/build-macro.js — build-time pipeline untuk menu "Global".
 *
 * Menghasilkan public/macro.json yang berisi:
 *   1. chart  — seri indeks TERNORMALISASI dalam USD (base = 100 pada BASE_DATE),
 *               untuk grafik "Robohnya Bursa Kami": IHSG vs SPX vs MXAPJ.
 *   2. table  — "Asset Class Return & Volatility": Last + return/volatilitas
 *               teranualisasi untuk jendela 1 tahun & 5 tahun, plus rasio
 *               Avg/Std (mirip Sharpe tanpa risk-free).
 *
 * SUMBER DATA: Yahoo Finance v8 chart API (interval bulanan).
 *   - Gratis, tanpa API key. Sudah terbukti andal di repo ini (build-ohlc.js).
 *   - "Anti-blokir": di-fetch dari GitHub Actions runner (internet bebas),
 *     hasilnya disajikan sebagai JSON statis via jsDelivr/Cloudflare. Browser
 *     pengguna TIDAK pernah menyentuh Yahoo → tidak terpengaruh blokir lokal.
 *
 * STRATEGI MERGE (robust, mirip build-ohlc.js):
 *   - Baris tabel yang punya symbol Yahoo → dihitung ulang (live).
 *   - Baris tabel tanpa symbol (mis. JAKISL, COAL, CPO, SBN) → nilainya
 *     DIPERTAHANKAN dari macro.json sebelumnya (snapshot statis). Ini biar
 *     tabel tetap selengkap gambar acuan tanpa sumber data berbayar.
 *   - Kalau fetch satu symbol gagal → pakai nilai lama (tidak hilang).
 *
 * Usage:
 *   node scripts/build-macro.js
 *
 * Env (opsional):
 *   MACRO_BASE_DATE  — base normalisasi chart, format "YYYY-MM" (default 2016-10)
 */

const fs = require('fs');
const path = require('path');

const OUT_PATH  = path.join(__dirname, '..', 'public', 'macro.json');
const BASE_DATE = (process.env.MACRO_BASE_DATE || '2016-10').trim(); // "YYYY-MM"
const MAX_RETRIES      = 3;
const RETRY_BACKOFF_MS = 1500;
const FETCH_DELAY_MS   = 600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
// Definisi aset.
//   key    : kode tampil di tabel (cocok dengan gambar acuan)
//   label  : nama panjang untuk tooltip
//   yahoo  : symbol Yahoo Finance (null = tidak di-fetch, pakai snapshot statis)
//   group  : pengelompokan visual
//   invert : true → "return" dihitung dari pelemahan harga (tidak dipakai saat ini)
// ─────────────────────────────────────────────────────────────────────────
const ASSETS = [
  { key: 'IDR',     label: 'Rupiah (USD/IDR)',                 yahoo: 'IDR=X',      group: 'currency' },
  { key: 'DXY',     label: 'US Dollar Index',                  yahoo: 'DX-Y.NYB',   group: 'currency' },
  { key: 'JCI',     label: 'IHSG / Jakarta Composite',         yahoo: '^JKSE',      group: 'indonesia' },
  { key: 'LQ45',    label: 'LQ45 Index',                       yahoo: '^JKLQ45',    group: 'indonesia' },
  { key: 'JAKISL',  label: 'Jakarta Islamic Index',            yahoo: null,         group: 'indonesia' },
  { key: 'IDL',     label: 'IDX Large Cap (IDXL)',             yahoo: null,         group: 'indonesia' },
  { key: 'SPX',     label: 'S&P 500',                          yahoo: '^GSPC',      group: 'global' },
  { key: 'MXAPJ',   label: 'MSCI AC Asia Pacific ex-Japan (proxy AAXJ)', yahoo: 'AAXJ', group: 'global' },
  { key: 'SX5E',    label: 'Euro Stoxx 50',                    yahoo: '^STOXX50E',  group: 'global' },
  { key: 'TWSE',    label: 'Taiwan Weighted Index',            yahoo: '^TWII',      group: 'global' },
  { key: 'SENSEX',  label: 'BSE Sensex (India)',               yahoo: '^BSESN',     group: 'global' },
  { key: 'BCOM',    label: 'Bloomberg Commodity Index',        yahoo: null,         group: 'commodity' },
  { key: 'COAL',    label: 'Coal (Newcastle)',                 yahoo: null,         group: 'commodity' },
  { key: 'CPO',     label: 'Crude Palm Oil',                   yahoo: null,         group: 'commodity' },
  { key: 'Rubber',  label: 'Rubber',                           yahoo: null,         group: 'commodity' },
  { key: 'Oil',     label: 'Crude Oil (WTI)',                  yahoo: 'CL=F',       group: 'commodity' },
  { key: 'Gold',    label: 'Gold (XAU/USD)',                   yahoo: 'GC=F',       group: 'commodity' },
  { key: 'SBN',     label: 'Surat Berharga Negara (proxy)',    yahoo: null,         group: 'bond' },
  { key: 'BITCOIN', label: 'Bitcoin (BTC/USD)',                yahoo: 'BTC-USD',    group: 'crypto' },
];

// Symbol yang dipakai grafik ternormalisasi (USD).
const CHART_SYMBOLS = {
  IHSG:  '^JKSE',
  SPX:   '^GSPC',
  MXAPJ: 'AAXJ',
};
const USDIDR_SYMBOL = 'IDR=X'; // untuk konversi IHSG (Rp) → USD

// ─────────────────────────────────────────────────────────────────────────
// Fetch Yahoo bulanan. Return Map<"YYYY-MM", number> (close, prefer adjclose).
// ─────────────────────────────────────────────────────────────────────────
async function fetchYahooMonthly(symbol) {
  const qs = `?interval=1mo&range=10y&events=div,split`;
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
      if (!result) throw new Error(json?.chart?.error?.description || 'no result');

      const ts = result.timestamp || [];
      const closeArr = result.indicators?.quote?.[0]?.close || [];
      const adjArr = result.indicators?.adjclose?.[0]?.adjclose || [];

      const map = new Map();
      for (let i = 0; i < ts.length; i++) {
        const v = (adjArr[i] != null && Number.isFinite(adjArr[i])) ? adjArr[i] : closeArr[i];
        if (v == null || !Number.isFinite(v)) continue;
        const d = new Date(ts[i] * 1000);
        const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        map.set(ym, v); // bulan terakhir menang (close akhir bulan)
      }
      if (map.size === 0) throw new Error('kosong setelah parse');
      return map;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw lastErr || new Error('fetch gagal');
}

// ─────────────────────────────────────────────────────────────────────────
// Statistik return/volatilitas teranualisasi dari deret close bulanan.
//   windowMonths = 12 (1Y) atau 60 (5Y).
//   avg = rata-rata return bulanan × 12 (teranualisasi)
//   std = stdev return bulanan × √12 (teranualisasi)
//   ratio = avg / std
// ─────────────────────────────────────────────────────────────────────────
function computeStats(sortedVals, windowMonths) {
  // sortedVals: array nilai close terurut ASC by month.
  if (!sortedVals || sortedVals.length < 3) return null;
  const vals = sortedVals.slice(-(windowMonths + 1)); // butuh n+1 harga utk n return
  if (vals.length < 3) return null;

  const rets = [];
  for (let i = 1; i < vals.length; i++) {
    if (vals[i - 1] > 0) rets.push(vals[i] / vals[i - 1] - 1);
  }
  if (rets.length < 2) return null;

  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(variance);

  const avgAnn = mean * 12;
  const stdAnn = sd * Math.sqrt(12);
  const ratio = stdAnn > 0 ? avgAnn / stdAnn : null;

  return {
    avg: +(avgAnn * 100).toFixed(1),   // persen
    std: +(stdAnn * 100).toFixed(1),   // persen
    ratio: ratio == null ? null : +ratio.toFixed(2),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Bangun seri grafik ternormalisasi (USD), base = 100 pada BASE_DATE.
// ─────────────────────────────────────────────────────────────────────────
function buildNormalizedChart(maps) {
  const { IHSG, SPX, MXAPJ, USDIDR } = maps;

  // Kumpulkan semua bulan >= BASE_DATE yang ada di SPX (acuan utama paling lengkap).
  const months = [...SPX.keys()].filter((m) => m >= BASE_DATE).sort();
  if (months.length === 0) return null;

  // IHSG dalam USD = level IHSG / USDIDR.
  const ihsgUsd = new Map();
  for (const m of IHSG.keys()) {
    const fx = USDIDR.get(m);
    if (fx && fx > 0) ihsgUsd.set(m, IHSG.get(m) / fx);
  }

  const series = { IHSG: [], SPX: [], MXAPJ: [] };
  const sources = { IHSG: ihsgUsd, SPX, MXAPJ };

  // base value per seri = nilai pada BASE_DATE (atau bulan pertama tersedia >= BASE_DATE)
  const baseVals = {};
  for (const name of Object.keys(sources)) {
    const src = sources[name];
    let baseVal = null;
    for (const m of months) {
      if (src.has(m)) { baseVal = src.get(m); break; }
    }
    baseVals[name] = baseVal;
  }

  const labels = [];
  for (const m of months) {
    labels.push(m);
    for (const name of Object.keys(sources)) {
      const src = sources[name];
      const bv = baseVals[name];
      const v = src.get(m);
      series[name].push((bv && v != null && bv > 0) ? +((v / bv) * 100).toFixed(2) : null);
    }
  }

  return { base_date: BASE_DATE, labels, series };
}

// ─────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────
async function main() {
  // Load macro.json lama (untuk merge / preserve snapshot statis).
  let prev = null;
  if (fs.existsSync(OUT_PATH)) {
    try { prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch (_) {}
  }
  const prevTableByKey = {};
  for (const row of (prev?.table || [])) prevTableByKey[row.key] = row;

  // Symbol unik yang perlu di-fetch (tabel live + chart + fx).
  const symbols = new Set();
  for (const a of ASSETS) if (a.yahoo) symbols.add(a.yahoo);
  for (const s of Object.values(CHART_SYMBOLS)) symbols.add(s);
  symbols.add(USDIDR_SYMBOL);

  console.log(`macro build: ${symbols.size} symbol Yahoo · base=${BASE_DATE}`);

  const fetched = {}; // symbol -> Map<"YYYY-MM", close>
  let ok = 0, fail = 0;
  for (const sym of symbols) {
    try {
      fetched[sym] = await fetchYahooMonthly(sym);
      ok++;
      console.log(`  ✓ ${sym} (${fetched[sym].size} bln)`);
    } catch (e) {
      fail++;
      console.warn(`  ⚠️  ${sym}: ${e.message}`);
    }
    await sleep(FETCH_DELAY_MS);
  }

  // ── Tabel ──────────────────────────────────────────────────────────────
  const table = [];
  for (const a of ASSETS) {
    const prevRow = prevTableByKey[a.key] || {};
    const row = {
      key: a.key,
      label: a.label,
      group: a.group,
      last: prevRow.last ?? null,
      r1_avg: prevRow.r1_avg ?? null, r1_std: prevRow.r1_std ?? null, r1_ratio: prevRow.r1_ratio ?? null,
      r5_avg: prevRow.r5_avg ?? null, r5_std: prevRow.r5_std ?? null, r5_ratio: prevRow.r5_ratio ?? null,
      live: false,
      source: prevRow.source || (a.yahoo ? 'yahoo' : 'snapshot'),
    };

    const map = a.yahoo ? fetched[a.yahoo] : null;
    if (map && map.size >= 3) {
      const months = [...map.keys()].sort();
      const vals = months.map((m) => map.get(m));
      const last = vals[vals.length - 1];
      const s1 = computeStats(vals, 12);
      const s5 = computeStats(vals, 60);
      row.last = +last.toFixed(last >= 1000 ? 1 : (last >= 10 ? 1 : 2));
      if (s1) { row.r1_avg = s1.avg; row.r1_std = s1.std; row.r1_ratio = s1.ratio; }
      if (s5) { row.r5_avg = s5.avg; row.r5_std = s5.std; row.r5_ratio = s5.ratio; }
      row.live = true;
      row.source = 'yahoo';
    }
    table.push(row);
  }

  // ── Chart ────────────────────────────────────────────────────────────────
  let chart = prev?.chart || null;
  const haveChart =
    fetched[CHART_SYMBOLS.SPX] && fetched[CHART_SYMBOLS.IHSG] &&
    fetched[CHART_SYMBOLS.MXAPJ] && fetched[USDIDR_SYMBOL];
  if (haveChart) {
    const built = buildNormalizedChart({
      IHSG: fetched[CHART_SYMBOLS.IHSG],
      SPX: fetched[CHART_SYMBOLS.SPX],
      MXAPJ: fetched[CHART_SYMBOLS.MXAPJ],
      USDIDR: fetched[USDIDR_SYMBOL],
    });
    if (built) chart = built;
  } else {
    console.warn('  ⚠️  Symbol chart tidak lengkap — pertahankan chart lama.');
  }

  const payload = {
    generated_at: new Date().toISOString(),
    source: 'yahoo',
    base_date: BASE_DATE,
    as_of: prev?.as_of || null, // label snapshot manual (mis. "Mei-26")
    chart: chart || { base_date: BASE_DATE, labels: [], series: { IHSG: [], SPX: [], MXAPJ: [] }, pending: true },
    table,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(payload));
  const sizeKB = (fs.statSync(OUT_PATH).size / 1024).toFixed(1);
  console.log(`✓ Wrote ${OUT_PATH} (${sizeKB} KB) · fetch ok=${ok} fail=${fail} · live rows=${table.filter(r => r.live).length}/${table.length}`);

  if (ok === 0) {
    console.error('FATAL: semua fetch Yahoo gagal — macro.json tidak diperbarui dengan data baru.');
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('build-macro failed:', err); process.exit(1); });
} else {
  module.exports = { fetchYahooMonthly, computeStats, buildNormalizedChart, ASSETS };
}
