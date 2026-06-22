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
// History sheet parser (port dari build-data.js)
// ─────────────────────────────────────────────
function findHistoryHeaderRow(rows) {
  let best = { idx: -1, count: 0 };
  const limit = Math.min(rows.length, 25);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    let count = 0;
    let hasIhsg = false;
    for (const c of row) {
      const cleaned = cleanTickerName(c);
      if (TICKER_RX.test(cleaned)) count++;
      if (/^(IHSG|JKSE|COMPOSITE)$/i.test(cleaned)) hasIhsg = true;
    }
    const score = count + (hasIhsg ? 5 : 0);
    if (score > best.count) best = { idx: i, count: score };
  }
  return best.idx;
}

function parseHistory(csv, debug = {}) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];

  let headerIdx = findHistoryHeaderRow(rows);
  if (headerIdx < 0) headerIdx = Math.min(2, rows.length - 1);

  const rawHeader = rows[headerIdx];
  const header = rawHeader.map(cleanTickerName);

  let idxDate = -1, idxLabel = -1;
  for (let i = 0; i < header.length; i++) {
    const h = header[i].toLowerCase();
    if (idxDate < 0 && (h === 'date' || h === 'tanggal' || h === 'tgl')) idxDate = i;
    if (idxLabel < 0 && (h === 'label' || h === 'period' || h === 'periode' || h === 'bulanz' || h === 'month')) idxLabel = i;
  }

  let firstDataRow = null;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    if (rows[r].some(c => c && c.trim())) { firstDataRow = rows[r]; break; }
  }

  if (idxDate < 0 && firstDataRow) {
    for (let i = 0; i < firstDataRow.length; i++) {
      if (parseDate((firstDataRow[i] || '').trim())) { idxDate = i; break; }
    }
  }
  if (idxLabel < 0 && firstDataRow) {
    for (let i = 0; i < firstDataRow.length; i++) {
      if (i === idxDate) continue;
      const v = (firstDataRow[i] || '').trim();
      if (/^[A-Za-z]{3,9}[-\s\/]\d{2,4}$/.test(v) || /^\d{4}[-\/]\d{1,2}$/.test(v)) {
        idxLabel = i; break;
      }
    }
  }

  if (idxLabel >= 0 && idxLabel === idxDate && firstDataRow) {
    let altLabel = -1;
    for (let i = 0; i < firstDataRow.length; i++) {
      if (i === idxDate) continue;
      const v = (firstDataRow[i] || '').trim();
      if (/^[A-Za-z]{3,9}[-\s\/]\d{2,4}$/.test(v) || /^\d{4}[-\/]\d{1,2}$/.test(v)) {
        altLabel = i; break;
      }
    }
    idxLabel = altLabel;
  }

  if (idxDate < 0) idxDate = 0;

  const META_NAMES = new Set([
    'DATE','TANGGAL','TGL','LABEL','PERIOD','PERIODE',
    'BULANZ','MONTH','BULAN','NO','#',
  ]);
  const tickerCols = [];
  for (let i = 0; i < header.length; i++) {
    if (i === idxDate || i === idxLabel) continue;
    const name = header[i];
    if (!name || /^\d+$/.test(name)) continue;
    if (META_NAMES.has(name)) continue;
    tickerCols.push({ name, i });
  }

  const seen = new Set();
  const dedupedCols = tickerCols.filter(c => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });

  const monthShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const out = [];

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => !c || !String(c).trim())) continue;

    const rec = {};
    let dateStr = idxDate >= 0 ? row[idxDate] : '';
    let label   = idxLabel >= 0 ? row[idxLabel] : '';

    if (dateStr) {
      const d = parseDate(dateStr);
      if (d) {
        const yyyy = d.getUTCFullYear();
        const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
        dateStr = `${yyyy}-${mm}-01`;
        if (!label) label = `${monthShort[d.getUTCMonth()]}-${String(yyyy).slice(2)}`;
      } else {
        dateStr = null;
      }
    } else {
      dateStr = null;
    }

    if (!dateStr && label) {
      const d2 = parseDate(label);
      if (d2) {
        const yyyy = d2.getUTCFullYear();
        const mm = String(d2.getUTCMonth() + 1).padStart(2, '0');
        dateStr = `${yyyy}-${mm}-01`;
      }
    }

    rec.label = (label || '').trim() || (dateStr ? dateStr.slice(0, 7) : `Row ${r}`);
    rec.date  = dateStr;

    let hasNum = false;
    for (const c of dedupedCols) {
      const v = toNum(row[c.i]);
      rec[c.name] = v;
      if (Number.isFinite(v) && v !== 0) hasNum = true;
    }
    if (hasNum && rec.date) out.push(rec);
  }
  out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return out;
}

// ─────────────────────────────────────────────
// Consensus sheet parser (port dari build-data.js)
// ─────────────────────────────────────────────
const CONSENSUS_HEADER_HINTS = [
  'symbol','ticker','code','kode','saham',
  'date','tanggal','tgl',
  'firmname','firm','sekuritas','broker','analyst','analis',
  'tprice','target','tp','hargatarget','targetharga','pricetarget',
  'rating','recommendation','rekomendasi','suggestion','call',
  'pctd','pct','upside','disc',
];

function findConsensusHeaderRow(rows) {
  let best = { idx: -1, score: 0 };
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const r = rows[i].map(c => norm(c));
    if (!r.some(x => x)) continue;
    let score = 0;
    for (const cand of CONSENSUS_HEADER_HINTS) {
      if (r.some(x => x === cand)) score += 2;
      else if (r.some(x => x && x.includes(cand))) score += 1;
    }
    if (score > best.score) best = { idx: i, score };
  }
  return best.idx;
}

/** Decode rekomendasi B/N/S, BUY/SELL/HOLD, OVERWEIGHT/UNDERWEIGHT, dll. */
function decodeSuggestion(raw) {
  const s = String(raw || '').trim().toUpperCase();
  if (!s) return '';
  if (s === 'B' || /BUY|OVERWEIGHT|OUTPERFORM|^ADD$|ACCUMULATE|STRONG.?BUY/.test(s)) return 'BUY';
  if (s === 'S' || /SELL|UNDERWEIGHT|UNDERPERFORM|^REDUCE$/.test(s)) return 'SELL';
  if (s === 'N' || /NEUTRAL|HOLD|MARKETPERFORM|MARKET.?WEIGHT|EQUAL.?WEIGHT/.test(s)) return 'NEUTRAL';
  return s;
}

function parseConsensus(csv, latestPrices = {}, debug = {}) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return {};

  let headerIdx = findConsensusHeaderRow(rows);
  if (headerIdx < 0) headerIdx = Math.min(3, rows.length - 1);

  const rawHeader = rows[headerIdx];
  const header = rawHeader.map(c => norm(c));

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

  const iTicker = findFz('symbol', 'ticker', 'code', 'kode', 'saham');
  let iDate    = findFz('date', 'tanggal', 'tgl', 'tanggalriset', 'tanggalreview', 'reviewdate', 'tanggalpublikasi');
  const iFirm  = findFz('firmname', 'firm', 'analyst', 'sekuritas', 'broker', 'analis', 'penerbit', 'firmnamesekuritas');
  let iSugg    = findFz('suggestion', 'rec', 'recommendation', 'rating', 'bns', 'rekomendasi', 'call');
  let iTgt     = findFz('tprice', 'tprice1', 'targetprice', 'pricetarget', 'targetharga', 'hargatarget', 'target', 'tp');
  const iPct   = findFz('pctd', 'pct', 'upside', 'pctdelta', 'delta');

  if (iSugg < 0) {
    const i = rawHeader.findIndex(c => String(c || '').trim() === '[]');
    if (i >= 0) iSugg = i;
  }

  if (iSugg < 0) {
    const RX_SUGG = /^(B|N|S|BUY|SELL|HOLD|NEUTRAL|OVERWEIGHT|UNDERWEIGHT|OUTPERFORM|UNDERPERFORM|ADD|REDUCE|ACCUMULATE)$/i;
    const counts = {};
    for (let r = headerIdx + 1; r < Math.min(rows.length, headerIdx + 200); r++) {
      const row = rows[r];
      for (let c = 0; c < (row || []).length; c++) {
        if (c === iTicker || c === iDate || c === iFirm || c === iTgt || c === iPct) continue;
        const v = String(row[c] || '').trim();
        if (RX_SUGG.test(v)) counts[c] = (counts[c] || 0) + 1;
      }
    }
    let bestCol = -1, bestCount = 0;
    for (const [c, n] of Object.entries(counts)) {
      if (n > bestCount) { bestCount = n; bestCol = parseInt(c, 10); }
    }
    if (bestCol >= 0 && bestCount >= 3) iSugg = bestCol;
  }

  if (iTgt < 0 || iTgt === iPct) {
    const candCols = {};
    for (let r = headerIdx + 1; r < Math.min(rows.length, headerIdx + 200); r++) {
      const row = rows[r];
      for (let c = 0; c < (row || []).length; c++) {
        if (c === iTicker || c === iDate || c === iFirm || c === iSugg || c === iPct) continue;
        const v = toNum(row[c]);
        if (Number.isFinite(v) && v > 50 && v < 1e7) {
          (candCols[c] ||= []).push(v);
        }
      }
    }
    let bestCol = -1, bestCount = 0;
    for (const [c, vals] of Object.entries(candCols)) {
      if (vals.length > bestCount) { bestCount = vals.length; bestCol = parseInt(c, 10); }
    }
    if (bestCol >= 0 && bestCount >= 2) iTgt = bestCol;
  }

  if (iDate < 0) {
    const dateCounts = {};
    for (let r = headerIdx + 1; r < Math.min(rows.length, headerIdx + 200); r++) {
      const row = rows[r];
      for (let c = 0; c < (row || []).length; c++) {
        if (c === iTicker || c === iFirm || c === iSugg || c === iTgt || c === iPct) continue;
        const v = (row[c] || '').trim();
        if (v && parseDate(v)) dateCounts[c] = (dateCounts[c] || 0) + 1;
      }
    }
    let bestCol = -1, bestCount = 0;
    for (const [c, count] of Object.entries(dateCounts)) {
      if (count > bestCount) { bestCount = count; bestCol = parseInt(c, 10); }
    }
    if (bestCol >= 0 && bestCount >= 2) iDate = bestCol;
  }

  const grouped = {};
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const t = (row[iTicker] || '').trim().toUpperCase();
    if (!t || /^[\d.,\s]+$/.test(t)) continue;
    if (t.length > 10 || /\s/.test(t)) continue;
    if (!TICKER_RX.test(t) && t !== 'IHSG') continue;

    const target = iTgt >= 0 ? toNum(row[iTgt]) : null;
    const last = latestPrices[t];
    let pct = iPct >= 0 ? toNum(row[iPct]) : null;
    if ((pct == null || pct === 0) && target != null && last) {
      pct = ((target - last) / last) * 100;
    }

    let dateRaw = iDate >= 0 ? (row[iDate] || '').trim() : '';
    const dParsed = parseDate(dateRaw);
    if (dParsed) {
      dateRaw = `${dParsed.getUTCFullYear()}-${String(dParsed.getUTCMonth()+1).padStart(2,'0')}-${String(dParsed.getUTCDate()).padStart(2,'0')}`;
    }

    (grouped[t] ||= []).push({
      no: '',
      date: dateRaw,
      firm: iFirm >= 0 ? (row[iFirm] || '').trim() : '',
      suggestion: iSugg >= 0 ? decodeSuggestion(row[iSugg]) : '',
      target_price: target,
      pct_d: pct == null ? 0 : pct,
    });
  }

  for (const t of Object.keys(grouped)) {
    grouped[t].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    grouped[t].forEach((rec, i) => rec.no = String(i + 1));
  }

  return grouped;
}

function computeConsensusSummary(consensus) {
  const out = {};
  for (const t of Object.keys(consensus)) {
    const recs = consensus[t];
    let buy = 0, neutral = 0, sell = 0;
    let high = -Infinity, low = Infinity, sum = 0, n = 0;
    for (const r of recs) {
      const sg = (r.suggestion || '').toUpperCase();
      if (sg.includes('BUY') || sg.includes('OVERWEIGHT') || sg.includes('OUTPERFORM') || sg.includes('ADD')) buy++;
      else if (sg.includes('SELL') || sg.includes('UNDERWEIGHT') || sg.includes('UNDERPERFORM') || sg.includes('REDUCE')) sell++;
      else neutral++;
      if (Number.isFinite(r.target_price)) {
        if (r.target_price > high) high = r.target_price;
        if (r.target_price < low)  low  = r.target_price;
        sum += r.target_price; n++;
      }
    }
    out[t] = {
      total: recs.length,
      buy, neutral, sell,
      high: high === -Infinity ? null : high,
      low:  low  ===  Infinity ? null : low,
      target: n ? Math.round(sum / n) : null,
    };
  }
  return out;
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
// Generic sheet feed handler (dipakai /consensus.json & /history.json)
// Pola sama dgn handleLive: cache fresh + backup stale (12 jam) saat sheet error.
// ─────────────────────────────────────────────
async function fetchSheetCsv(sheetId, gid, cacheTtl) {
  const res = await fetch(gvizCsvUrl(sheetId, gid), {
    redirect: 'follow',
    cf: { cacheTtl: Math.min(cacheTtl || 60, 60), cacheEverything: true },
  });
  if (!res.ok) throw new Error(`gviz HTTP ${res.status}`);
  return await res.text();
}

async function buildConsensus(env) {
  if (!env.CONSENSUS_SHEET_ID || env.CONSENSUS_GID === undefined || env.CONSENSUS_GID === null || env.CONSENSUS_GID === '') {
    throw new Error('CONSENSUS_SHEET_ID / CONSENSUS_GID belum di-set di environment Worker.');
  }
  // latestPrices dari Live Sheet (opsional) → untuk hitung pct_d, persis seperti
  // scripts/build-data.js. Kalau Live Sheet gagal, pct_d tetap dari kolom sheet.
  let latest = {};
  if (env.LIVE_SHEET_ID && env.LIVE_GID !== undefined && env.LIVE_GID !== null && env.LIVE_GID !== '') {
    try {
      const lcsv = await fetchSheetCsv(env.LIVE_SHEET_ID, env.LIVE_GID, 60);
      const live = parseLive(lcsv, {});
      for (const c in live) latest[c] = live[c].price;
    } catch (_) { /* abaikan — pct_d fallback ke kolom sheet */ }
  }
  const csv = await fetchSheetCsv(env.CONSENSUS_SHEET_ID, env.CONSENSUS_GID, 60);
  const consensus_slim = parseConsensus(csv, latest, {});
  const consensus_summary = computeConsensusSummary(consensus_slim);
  return { count: Object.keys(consensus_slim).length, consensus_slim, consensus_summary };
}

async function buildHistory(env) {
  if (!env.HISTORY_SHEET_ID || env.HISTORY_GID === undefined || env.HISTORY_GID === null || env.HISTORY_GID === '') {
    throw new Error('HISTORY_SHEET_ID / HISTORY_GID belum di-set di environment Worker.');
  }
  const csv = await fetchSheetCsv(env.HISTORY_SHEET_ID, env.HISTORY_GID, 60);
  const price_history = parseHistory(csv, {});
  return { count: price_history.length, price_history };
}

async function handleSheetFeed(request, env, ctx, { name, cacheSeconds, build }) {
  const staleSeconds = Number(env.STALE_TTL_SECONDS) > 0 ? Number(env.STALE_TTL_SECONDS) : 12 * 3600;

  const url = new URL(request.url);
  const noCache = url.searchParams.get('nocache') === '1';
  const origin = url.origin;

  const cache = caches.default;
  const freshKey  = new Request(new URL('/' + name + '.json', origin).toString(), { method: 'GET' });
  const backupKey = new Request(new URL('/' + name + '.json?__backup=1', origin).toString(), { method: 'GET' });

  if (!noCache) {
    const cached = await cache.match(freshKey);
    if (cached) return cached;
  }

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

  let payload = null;
  let failReason = null;
  try {
    payload = await build();
  } catch (e) {
    failReason = (e && e.message) ? e.message : String(e);
  }

  if (payload && payload.count > 0) {
    const body = { ok: true, generated_at: new Date().toISOString(), ...payload };
    const fresh  = jsonResponse(body, env, { status: 200, cacheSeconds });
    const backup = jsonResponse(body, env, { status: 200, cacheSeconds: staleSeconds });
    if (!noCache) {
      ctx.waitUntil(cache.put(freshKey, fresh.clone()));
      ctx.waitUntil(cache.put(backupKey, backup.clone()));
    }
    return fresh;
  }

  const reason = failReason || `${name}: 0 baris (kemungkinan sheet error/empty).`;
  const stale = await serveStale(reason);
  if (stale) return stale;

  return jsonResponse(
    { ok: false, error: `${name} error & belum ada data cadangan: ${reason}` },
    env, { status: 502 }
  );
}

// ─────────────────────────────────────────────
// PAYWALL — verifikasi token akses (HMAC) dari Worker terminal
// Token dibuat oleh /api/live-token (terminal) memakai LIVE_TOKEN_SECRET yang
// SAMA. Worker ini hanya memverifikasi tanda tangan + masa berlaku — tidak
// perlu D1. Token dikirim via query ?token=... (bukan cookie) supaya tetap
// kompatibel dengan cache edge (cache key memakai path saja) & CORS '*'.
// ─────────────────────────────────────────────
function _b64urlEncodeBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64urlToString(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function _timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
async function verifyLiveToken(env, token) {
  const secret = env.LIVE_TOKEN_SECRET;
  if (!secret || !token || token.indexOf('.') < 0) return false;
  const [p, sig] = token.split('.');
  if (!p || !sig) return false;
  let expected;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(p));
    expected = _b64urlEncodeBytes(new Uint8Array(buf));
  } catch (_) { return false; }
  if (!_timingSafeEqual(expected, sig)) return false;
  let body;
  try { body = JSON.parse(_b64urlToString(p)); } catch (_) { return false; }
  if (!body || !body.exp || body.exp < Math.floor(Date.now() / 1000)) return false;
  return true;
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

    // ── Gate: endpoint data wajib token akses valid (langganan aktif) ──
    const isData = url.pathname === '/live.json' || url.pathname === '/consensus.json' || url.pathname === '/history.json';
    if (isData) {
      const ok = await verifyLiveToken(env, url.searchParams.get('token'));
      if (!ok) return jsonResponse({ ok: false, error: 'unauthorized' }, env, { status: 401 });
    }

    if (url.pathname === '/live.json') {
      return handleLive(request, env, ctx);
    }

    if (url.pathname === '/consensus.json') {
      const cacheSeconds = Number(env.CONSENSUS_CACHE_SECONDS) > 0 ? Number(env.CONSENSUS_CACHE_SECONDS) : 120;
      return handleSheetFeed(request, env, ctx, { name: 'consensus', cacheSeconds, build: () => buildConsensus(env) });
    }

    if (url.pathname === '/history.json') {
      const cacheSeconds = Number(env.HISTORY_CACHE_SECONDS) > 0 ? Number(env.HISTORY_CACHE_SECONDS) : 600;
      return handleSheetFeed(request, env, ctx, { name: 'history', cacheSeconds, build: () => buildHistory(env) });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return jsonResponse(
        {
          ok: true,
          service: 'terminal-live',
          endpoints: ['/live.json', '/consensus.json', '/history.json'],
          note: 'Live price + consensus + history feed untuk dashboard terminal.',
        },
        env, { status: 200 }
      );
    }

    return jsonResponse({ ok: false, error: 'Not found' }, env, { status: 404 });
  },
};


// Named exports — untuk unit test (tidak memengaruhi runtime Worker).
export { parseLive, _parseLiveBody, parseCsv, toNum, parseDate, cleanTickerName,
         parseConsensus, computeConsensusSummary, decodeSuggestion, parseHistory };
