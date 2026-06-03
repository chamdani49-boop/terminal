/**
 * terminal-live — Cloudflare Worker
 * ──────────────────────────────────────────────────────────────────────────
 * Endpoint live data real-time untuk dashboard `terminal`.
 *
 * Kenapa ada Worker ini?
 *   GitHub Actions cron `*​/5` TIDAK reliable (sering di-throttle/delay
 *   30–60 menit) + model "commit data.json → CDN" nambah latensi. Jadi
 *   walaupun Google Sheet update tiap 5 menit, harga di UI bisa nyangkut
 *   berjam-jam.
 *
 *   Worker ini jalan PER-REQUEST (bukan cron) → fetch Live Sheet langsung
 *   dari Google, parse pakai logika yang SAMA dengan `scripts/build-data.js`,
 *   lalu balikin JSON ringan. Frontend poll endpoint ini tiap beberapa menit
 *   dan overlay ke data.json yang sudah ke-load. data.json (history/consensus/
 *   stats baseline) tetap di-build GitHub Actions seperti biasa.
 *
 * Route:
 *   GET /live.json        → { ok, generated_at, count, live: { CODE: {...} } }
 *   GET /live.json?nocache=1  → bypass edge cache (debug)
 *   GET /                 → info singkat (health check)
 *
 * Env (set saat deploy — lihat worker/README.md):
 *   LIVE_SHEET_ID  (required)  ID Google Sheet Live
 *   LIVE_GID       (required)  GID tab Live
 *   ALLOW_ORIGIN   (optional)  default "*". Bisa di-set ke origin spesifik,
 *                              mis. "https://terminal.chamdani49.workers.dev"
 *   CACHE_SECONDS  (optional)  default "60". Lama cache di edge (detik).
 *
 * Logika parsing di bawah adalah PORT dari scripts/build-data.js — dijaga
 * tetap sinkron supaya hasil live overlay identik dengan backend.
 */

// ─────────────────────────────────────────────
// CSV utilities (port dari build-data.js)
// ─────────────────────────────────────────────
function gvizCsvUrl(sheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
}

/** RFC-4180-ish CSV parser supporting quoted fields with commas/newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
      else if (c === '\r') { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(v => v && v.trim() !== ''));
}

const toNum = (v) => {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  if (!s || s === '-' || /^n\/?a$/i.test(s)) return null;
  s = s.replace(/[Rp$€£¥\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(/,/g, '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Parse berbagai format tanggal jadi Date (UTC). */
function parseDate(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;

  const lower = s.toLowerCase();
  if (lower === 'sekarang' || lower === 'now' || lower === 'today' ||
      lower === 'current' || lower === 'live' || lower === 'realtime') {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  if (!/\d/.test(s)) return null;

  let d = new Date(s);
  if (!isNaN(d) && /\d{4}/.test(s)) return d;

  let m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    if (parseInt(a, 10) > 12) {
      d = new Date(`${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}T00:00:00Z`);
    } else {
      d = new Date(`${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}T00:00:00Z`);
    }
    if (!isNaN(d)) return d;
  }

  m = s.match(/^(\d{4})[\-\/](\d{1,2})$/);
  if (m) {
    d = new Date(`${m[1]}-${m[2].padStart(2, '0')}-01T00:00:00Z`);
    if (!isNaN(d)) return d;
  }

  const monthNames = {
    jan:0,feb:1,mar:2,apr:3,may:4,mei:4,jun:5,jul:6,aug:7,agu:7,ags:7,sep:8,oct:9,okt:9,nov:10,dec:11,des:11,
  };
  m = s.match(/^([A-Za-z]{3,9})[\s\-\/]+(\d{2,4})$/);
  if (m) {
    const mm = monthNames[m[1].slice(0,3).toLowerCase()];
    if (mm != null) {
      let y = m[2];
      if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
      d = new Date(Date.UTC(parseInt(y,10), mm, 1));
      if (!isNaN(d)) return d;
    }
  }

  return null;
}

const norm = (s) => String(s||'').trim().toLowerCase().replace(/[\s_./\-\\(){}\[\]]+/g, '');

const TICKER_RX = /^[A-Z]{2,5}\d?$/;

/** Bersihkan nama kolom ticker: strip prefix IDX:, JK:, alias index → IHSG. */
function cleanTickerName(raw) {
  let s = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/^(IDX:|JK:|XIDX:|BEI:|JKSE:)/, '')
    .replace(/\s+CLOSE$/i, '')
    .replace(/\s+PRICE$/i, '')
    .trim();
  if (s === 'COMPOSITE' || s === 'JKSE' || s === 'JCI') s = 'IHSG';
  return s;
}

function isoDate(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ─────────────────────────────────────────────
// Live sheet parser (port dari build-data.js)
// ─────────────────────────────────────────────
function parseLive(csvText, debug = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) {
    debug.live_warning = 'Live sheet empty';
    return {};
  }

  // ── Headerless: row 0 langsung ticker + harga ──
  {
    const r0 = rows[0] || [];
    const t0 = cleanTickerName(r0[0]);
    const p0 = toNum(r0[1]);
    if (t0 && (TICKER_RX.test(t0) || t0 === 'IHSG') && Number.isFinite(p0) && p0 > 0) {
      const iPctHl = r0.length > 2 ? 2 : -1;
      debug.live_headerless = true;
      debug.live_cols = { iTicker: 0, iPrice: 1, iPct: iPctHl, iMaxPrice: -1, iMaxDate: -1, iLowPrice: -1, iLowDate: -1 };
      return _parseLiveBody(rows, 0, 0, 1, iPctHl, -1, -1, -1, -1, 'percent');
    }
  }

  if (rows.length < 2) {
    debug.live_warning = 'Live sheet has < 2 rows';
    return {};
  }

  // ── Cari header row ──
  let headerIdx = -1;
  const limit = Math.min(rows.length, 10);
  for (let i = 0; i < limit; i++) {
    const r = rows[i].map(c => norm(c));
    const hasTicker = r.some(x =>
      x === 'ticker' || x === 'symbol' || x === 'kode' || x === 'saham' || x === 'code' ||
      x.includes('ticker') || x.includes('symbol') || x.includes('kodesaham')
    );
    const hasPrice = r.some(x =>
      x === 'live' || x === 'price' || x === 'harga' || x === 'last' ||
      x.includes('hargalive') || x.includes('pricelive') || x.includes('lastprice') ||
      x.includes('hargaterakhir') || x.includes('hargasaat')
    );
    if (hasTicker && hasPrice) { headerIdx = i; break; }
  }
  if (headerIdx < 0) headerIdx = 0;

  const rawHeader = rows[headerIdx];
  const header = rawHeader.map(c => norm(c));
  debug.live_header_idx = headerIdx;
  debug.live_header_sample = rawHeader;

  const findFz = (...names) => {
    for (const n of names) {
      const nn = norm(n);
      if (!nn) continue;
      const i = header.indexOf(nn);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const nn = norm(n);
      if (!nn) continue;
      const i = header.findIndex(h => h && h.includes(nn));
      if (i >= 0) return i;
    }
    return -1;
  };

  const iTicker = findFz('ticker', 'symbol', 'kode', 'kodesaham', 'saham', 'code');
  const iPrice  = findFz('hargalive', 'pricelive', 'lastprice', 'hargaterakhir', 'harga', 'price', 'last', 'live');
  let iPct      = findFz('pctlive', 'percentlive', 'persenlive', 'changepct', 'pctchange', 'pct', 'percent', 'persen', 'change', 'persentase');

  if (iPct < 0) {
    for (let i = 0; i < rawHeader.length; i++) {
      if (i === iTicker || i === iPrice) continue;
      const v = String(rawHeader[i] || '').trim();
      if (v.includes('%')) { iPct = i; break; }
    }
  }

  const iMaxPrice = findFz('max1tahun','max1y','high1y','highest','tertinggi','highs','max','high');
  const iMaxDate  = findFz('whenmax','tanggalmax','tglmax','datemax','datehigh','wmax','tanggaltertinggi');
  const iLowPrice = findFz('low1tahun','low1y','lowest','terendah','lows','low');
  const iLowDate  = findFz('whenlow','tanggallow','tgllow','datelow','datelowest','wlow','tanggalterendah');

  debug.live_cols = { iTicker, iPrice, iPct, iMaxPrice, iMaxDate, iLowPrice, iLowDate };

  if (iTicker < 0 || iPrice < 0) {
    debug.live_warning = 'Could not locate ticker or price column in live sheet';
    return {};
  }

  let pctMode = 'auto';
  if (iPct >= 0) {
    const pctHeaderRaw = String(rawHeader[iPct] || '');
    if (pctHeaderRaw.includes('%')) {
      pctMode = 'percent';
      debug.live_pct_mode_inferred = 'percent (header contains %)';
    }
  }
  return _parseLiveBody(rows, headerIdx + 1, iTicker, iPrice, iPct,
    iMaxPrice, iMaxDate, iLowPrice, iLowDate, pctMode);
}

function _parseLiveBody(rows, dataStart, iTicker, iPrice, iPct,
    iMaxPrice, iMaxDate, iLowPrice, iLowDate, pctMode) {
  const out = {};
  for (let r = dataStart; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;

    const t = cleanTickerName(row[iTicker]);
    if (!t || /^[\d.,\s]+$/.test(t)) continue;
    if (t.length > 6 || /\s/.test(t)) continue;
    if (!TICKER_RX.test(t) && t !== 'IHSG') continue;

    const price = toNum(row[iPrice]);
    if (!Number.isFinite(price) || price <= 0) continue;

    let pct = null;
    if (iPct >= 0) {
      let pctStr = String(row[iPct] || '').trim();
      const hasPctSign = pctStr.endsWith('%');
      if (hasPctSign) pctStr = pctStr.slice(0, -1).trim();
      pctStr = pctStr.replace(/\s/g, '').replace(',', '.');
      const n = pctStr ? Number(pctStr) : NaN;
      if (Number.isFinite(n)) {
        if (pctMode === 'percent' || hasPctSign || Math.abs(n) > 1) pct = n / 100;
        else pct = n;
      }
    }

    const maxPrice = iMaxPrice >= 0 ? toNum(row[iMaxPrice]) : null;
    const lowPrice = iLowPrice >= 0 ? toNum(row[iLowPrice]) : null;

    let maxDate = null;
    if (iMaxDate >= 0) {
      const d = parseDate(String(row[iMaxDate] || '').trim());
      if (d) maxDate = isoDate(d);
    }
    let lowDate = null;
    if (iLowDate >= 0) {
      const d = parseDate(String(row[iLowDate] || '').trim());
      if (d) lowDate = isoDate(d);
    }

    out[t] = {
      price,
      change_pct: pct,
      max_price: (Number.isFinite(maxPrice) && maxPrice > 0) ? maxPrice : null,
      max_date:  maxDate,
      low_price: (Number.isFinite(lowPrice) && lowPrice > 0) ? lowPrice : null,
      low_date:  lowDate,
    };
  }
  return out;
}

// ─────────────────────────────────────────────
// OHLC — Yahoo Finance v8 chart API
// ─────────────────────────────────────────────

/**
 * Konversi kode saham IDX → Yahoo Finance symbol (suffix .JK).
 * Contoh: "TLKM" → "TLKM.JK"
 */
function toYahooSymbol(code) {
  const upper = String(code || '').trim().toUpperCase();
  if (!upper) return null;
  if (upper.includes('.')) return upper;   // sudah ada suffix
  return upper + '.JK';
}

/**
 * Ambil OHLC harian dari Yahoo Finance v8 chart API.
 * Mengembalikan array of { date, open, high, low, close, volume } diurutkan asc.
 * date format "YYYY-MM-DD" (UTC).
 *
 * @param {string} symbol   - Yahoo symbol, mis. "TLKM.JK"
 * @param {string} fromDate - ISO date "YYYY-MM-DD", titik mulai fetch
 */
async function fetchYahooOhlc(symbol, fromDate) {
  // Hitung period1 (unix) dari fromDate, mundur 7 hari buat buffer
  const fromMs  = new Date(fromDate + 'T00:00:00Z').getTime() - 7 * 86400 * 1000;
  const period1 = Math.floor(fromMs / 1000);
  const period2 = Math.floor(Date.now() / 1000);

  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?interval=1d&period1=${period1}&period2=${period2}&events=div,split`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; terminal-worker/1.0)',
      'Accept': 'application/json',
    },
    cf: { cacheTtl: 600, cacheEverything: true },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance HTTP ${res.status} for ${symbol}`);
  }

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const errMsg = json?.chart?.error?.description || 'No result in Yahoo response';
    throw new Error(`Yahoo Finance: ${errMsg} (${symbol})`);
  }

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const opens   = q.open   || [];
  const highs   = q.high   || [];
  const lows    = q.low    || [];
  const closes  = q.close  || [];
  const volumes = q.volume || [];

  const rows = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = opens[i];
    const h = highs[i];
    const l = lows[i];
    const c = closes[i];
    if (o == null || h == null || l == null || c == null) continue;
    if (!Number.isFinite(o) || !Number.isFinite(c)) continue;
    const d = new Date(timestamps[i] * 1000);
    const dateStr = isoDate(d);
    rows.push({
      date:   dateStr,
      open:   Math.round(o),
      high:   Math.round(h),
      low:    Math.round(l),
      close:  Math.round(c),
      volume: Number.isFinite(volumes[i]) ? volumes[i] : null,
    });
  }

  // Sort ascending (biasanya sudah, tapi jaga-jaga)
  rows.sort((a, b) => a.date.localeCompare(b.date));

  // Potong dari fromDate
  const cutoff = fromDate;
  const filtered = rows.filter(r => r.date >= cutoff);
  return filtered.length > 0 ? filtered : rows;  // fallback ke semua kalau terlalu sedikit
}

/**
 * Cek apakah cache OHLC perlu di-refresh.
 * Refresh rule: setiap hari jam 11:00 UTC = 18:00 WIB (jam tutup bursa IDX + buffer).
 * Jika cache sudah ada dan masih "hari ini sebelum jam 11 UTC" → skip refresh.
 *
 * @param {string|null} cachedAt - ISO string waktu terakhir cache ditulis
 * @returns {boolean} true = perlu refresh
 */
function needsOhlcRefresh(cachedAt) {
  if (!cachedAt) return true;

  const now = new Date();
  const cached = new Date(cachedAt);

  // Hitung "refresh boundary" terakhir = hari ini jam 11:00 UTC
  // Kalau sekarang belum jam 11 UTC → boundary = kemarin jam 11:00 UTC
  const todayBoundary = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    11, 0, 0, 0
  ));
  const boundary = now < todayBoundary
    ? new Date(todayBoundary.getTime() - 86400000)  // kemarin 11:00 UTC
    : todayBoundary;                                 // hari ini 11:00 UTC

  return cached < boundary;
}

/**
 * Handler GET /ohlc.json?ticker=TLKM[&from=YYYY-MM-DD][&nocache=1]
 *
 * Cache strategy:
 *   - KV OHLC_CACHE key "ohlc:{ticker}" menyimpan payload lengkap.
 *   - Refresh satu kali sehari jam 11:00 UTC (18:00 WIB).
 *   - KV TTL di-set ke 25 jam sebagai safety net.
 *   - Kalau KV belum ada (binding tidak diset/belum dikonfigurasi) → langsung
 *     fetch Yahoo dan kembalikan hasilnya (degradasi graceful).
 *   - Kalau Yahoo gagal tapi KV punya stale → kembalikan stale + flag stale:true.
 *
 * Response: {
 *   ok, ticker, symbol, from, cached_at, stale?, count,
 *   candles: [{ date, open, high, low, close, volume }]
 * }
 */
async function handleOhlc(request, env, ctx) {
  const url      = new URL(request.url);
  const rawCode  = (url.searchParams.get('ticker') || '').trim().toUpperCase();
  const noCache  = url.searchParams.get('nocache') === '1';

  if (!rawCode || !TICKER_RX.test(rawCode)) {
    return jsonResponse(
      { ok: false, error: 'Parameter "ticker" wajib ada dan berformat valid (contoh: TLKM).' },
      env, { status: 400 }
    );
  }

  // "from" opsional: tanggal paling awal data yang dibutuhkan.
  // Jika tidak diisi → ambil 1 tahun ke belakang sebagai default.
  let fromDate = url.searchParams.get('from') || '';
  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    const fallback = new Date();
    fallback.setUTCFullYear(fallback.getUTCFullYear() - 1);
    fromDate = isoDate(fallback);
  }

  const symbol  = toYahooSymbol(rawCode);
  const kvKey   = `ohlc:${rawCode}`;
  const hasKv   = env.OHLC_CACHE && typeof env.OHLC_CACHE.get === 'function';

  // ── Baca cache KV ──────────────────────────────────────────────────────
  let cached = null;
  if (hasKv && !noCache) {
    try {
      const raw = await env.OHLC_CACHE.get(kvKey, 'json');
      if (raw && Array.isArray(raw.candles)) cached = raw;
    } catch (_) { /* KV error — lanjut fetch */ }
  }

  // ── Putuskan apakah perlu refresh ─────────────────────────────────────
  const shouldRefresh = noCache || !cached || needsOhlcRefresh(cached.cached_at);

  if (!shouldRefresh && cached) {
    // Potong candles ke fromDate yang diminta (cache mungkin punya data lebih panjang)
    const candles = cached.candles.filter(c => c.date >= fromDate);
    return jsonResponse({
      ok: true, ticker: rawCode, symbol,
      from: fromDate, cached_at: cached.cached_at,
      count: candles.length, candles,
    }, env, { cacheSeconds: 3600 });
  }

  // ── Fetch fresh dari Yahoo Finance ────────────────────────────────────
  // Untuk cache, selalu ambil dari tanggal paling awal yang tersedia di KV
  // (atau 18 bulan ke belakang), bukan hanya fromDate yang diminta sekarang.
  // Alasannya: kalau user buka rec lama nanti, data sudah ada di cache.
  const fetchFrom = cached?.from || (() => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - 18);
    return isoDate(d);
  })();

  let freshCandles = null;
  let fetchError   = null;
  try {
    freshCandles = await fetchYahooOhlc(symbol, fetchFrom);
  } catch (e) {
    fetchError = e?.message || String(e);
  }

  // Sukses → simpan ke KV + kembalikan
  if (freshCandles && freshCandles.length > 0) {
    const now       = new Date().toISOString();
    const kvPayload = { ticker: rawCode, symbol, from: fetchFrom, cached_at: now, candles: freshCandles };

    if (hasKv) {
      // TTL 25 jam: KV akan auto-expire meski cron tidak jalan
      ctx.waitUntil(
        env.OHLC_CACHE.put(kvKey, JSON.stringify(kvPayload), { expirationTtl: 25 * 3600 })
      );
    }

    const candles = freshCandles.filter(c => c.date >= fromDate);
    return jsonResponse({
      ok: true, ticker: rawCode, symbol,
      from: fromDate, cached_at: now,
      count: candles.length, candles,
    }, env, { cacheSeconds: 3600 });
  }

  // Yahoo gagal tapi ada stale cache → kembalikan stale
  if (cached && cached.candles && cached.candles.length > 0) {
    const candles = cached.candles.filter(c => c.date >= fromDate);
    return jsonResponse({
      ok: true, ticker: rawCode, symbol,
      from: fromDate, cached_at: cached.cached_at,
      stale: true, fetch_error: fetchError,
      count: candles.length, candles,
    }, env, { cacheSeconds: 300 });
  }

  // Tidak ada data sama sekali
  return jsonResponse({
    ok: false, ticker: rawCode, symbol,
    error: 'Gagal fetch data Yahoo Finance & tidak ada cache: ' + (fetchError || 'unknown'),
  }, env, { status: 502 });
}

// ─────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────
function corsHeaders(env) {
  const origin = (env && env.ALLOW_ORIGIN) ? env.ALLOW_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function jsonResponse(obj, env, { status = 200, cacheSeconds = 0 } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...corsHeaders(env),
  };
  if (cacheSeconds > 0) {
    headers['Cache-Control'] = `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}`;
  } else {
    headers['Cache-Control'] = 'no-store';
  }
  return new Response(JSON.stringify(obj), { status, headers });
}

// ─────────────────────────────────────────────
// Handler /live.json
// ─────────────────────────────────────────────
async function handleLive(request, env, ctx) {
  const sheetId = env.LIVE_SHEET_ID;
  const gid = env.LIVE_GID;
  const cacheSeconds = Number(env.CACHE_SECONDS) > 0 ? Number(env.CACHE_SECONDS) : 60;
  // Lama "data terakhir yang baik" disimpan sebagai cadangan saat sheet error.
  // Default 12 jam (cukup untuk satu sesi bursa penuh). Bisa di-override via env.
  const staleSeconds = Number(env.STALE_TTL_SECONDS) > 0 ? Number(env.STALE_TTL_SECONDS) : 12 * 3600;

  if (!sheetId || gid === undefined || gid === null || gid === '') {
    return jsonResponse(
      { ok: false, error: 'LIVE_SHEET_ID / LIVE_GID belum di-set di environment Worker.' },
      env, { status: 500 }
    );
  }

  const url = new URL(request.url);
  const noCache = url.searchParams.get('nocache') === '1';
  const origin = url.origin;

  const cache = caches.default;
  const freshKey  = new Request(new URL('/live.json', origin).toString(), { method: 'GET' });
  // Cadangan disimpan di key terpisah dengan TTL panjang → tidak ikut kebuang
  // saat cache 'fresh' (60s) expire. Tidak pernah dilayani langsung ke klien.
  const backupKey = new Request(new URL('/live.json?__backup=1', origin).toString(), { method: 'GET' });

  // Fast path: cache fresh (≤60s) → langsung balikin.
  if (!noCache) {
    const cached = await cache.match(freshKey);
    if (cached) return cached;
  }

  // Layani "data terakhir yang baik" (stale) bila sheet error. cacheSeconds
  // pendek (30s) supaya klien cepat coba lagi begitu sheet pulih.
  const serveStale = async (reason) => {
    const backup = await cache.match(backupKey);
    if (!backup) return null;
    let data;
    try { data = await backup.json(); } catch (_) { return null; }
    data.ok = true;
    data.stale = true;
    data.stale_reason = reason;
    return jsonResponse(data, env, { status: 200, cacheSeconds: 30 });
  };

  // ── Fetch + parse Live Sheet ──
  let live = null;
  let failReason = null;
  try {
    const res = await fetch(gvizCsvUrl(sheetId, gid), {
      redirect: 'follow',
      cf: { cacheTtl: Math.min(cacheSeconds, 60), cacheEverything: true },
    });
    if (!res.ok) throw new Error(`gviz HTTP ${res.status}`);
    const csv = await res.text();
    live = parseLive(csv, {});
  } catch (e) {
    failReason = (e && e.message) ? e.message : String(e);
  }

  const count = live ? Object.keys(live).length : 0;

  // Sukses & ada data → simpan fresh + backup, lalu kembalikan.
  if (live && count > 0) {
    const payload = { ok: true, generated_at: new Date().toISOString(), count, live };
    const fresh  = jsonResponse(payload, env, { status: 200, cacheSeconds });
    const backup = jsonResponse(payload, env, { status: 200, cacheSeconds: staleSeconds });
    if (!noCache) {
      ctx.waitUntil(cache.put(freshKey, fresh.clone()));
      ctx.waitUntil(cache.put(backupKey, backup.clone()));
    }
    return fresh;
  }

  // Gagal / kosong → sajikan data cadangan terakhir (kalau ada).
  const reason = failReason || 'Live Sheet mengembalikan 0 ticker (kemungkinan error/empty).';
  const stale = await serveStale(reason);
  if (stale) return stale;

  // Tidak ada cadangan sama sekali → error jujur (klien tetap aman: pakai
  // harga terakhir di memori + data.json).
  return jsonResponse(
    { ok: false, error: 'Live Sheet error & belum ada data cadangan: ' + reason },
    env, { status: 502 }
  );
}

// ─────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    if (url.pathname === '/live.json') {
      return handleLive(request, env, ctx);
    }

    if (url.pathname === '/ohlc.json') {
      return handleOhlc(request, env, ctx);
    }

    if (url.pathname === '/' || url.pathname === '') {
      return jsonResponse(
        {
          ok: true,
          service: 'terminal-live',
          endpoints: ['/live.json', '/ohlc.json?ticker=TLKM&from=YYYY-MM-DD'],
          note: 'Live price feed & OHLC harian untuk dashboard terminal.',
        },
        env, { status: 200 }
      );
    }

    return jsonResponse({ ok: false, error: 'Not found' }, env, { status: 404 });
  },
};


// Named exports — untuk unit test (tidak memengaruhi runtime Worker).
export { parseLive, _parseLiveBody, parseCsv, toNum, parseDate, cleanTickerName, toYahooSymbol, fetchYahooOhlc, needsOhlcRefresh };
