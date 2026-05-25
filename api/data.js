/**
 * /api/data — Vercel Serverless Function
 * Fetches 2 published Google Sheets (price history + analyst consensus),
 * computes derived statistics, returns JSON in the same shape as the legacy
 * data.json so the existing frontend works without modification.
 *
 * Required env vars:
 *   HISTORY_SHEET_ID, HISTORY_GID
 *   CONSENSUS_SHEET_ID, CONSENSUS_GID
 * Optional:
 *   CACHE_SECONDS (default 300)
 */

const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────
// CSV utilities
// ─────────────────────────────────────────────
function gvizCsvUrl(sheetId, gid) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
}

async function fetchCsv(sheetId, gid) {
  const url = gvizCsvUrl(sheetId, gid);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Failed to fetch sheet ${sheetId}/${gid}: ${res.status}`);
  return await res.text();
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
  const s = String(v).trim().replace(/,/g, '');
  if (s === '' || s === '-' || s.toLowerCase() === 'n/a') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Parse "5/31/2016", "31/5/2016", "2016-05-31", "May-16", … into a Date. */
function parseDate(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;

  // Native parser handles ISO and many formatted strings.
  let d = new Date(s);
  if (!isNaN(d)) return d;

  // M/D/YYYY or D/M/YYYY (slashes or dashes), with 2- or 4-digit year.
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, a, b, y] = m;
    if (y.length === 2) y = (parseInt(y, 10) > 50 ? '19' : '20') + y;
    // Heuristic: if 'a' > 12 it must be the day → D/M/Y;
    // otherwise prefer M/D/Y (matches US-style locale that Sheets typically emits).
    if (parseInt(a, 10) > 12) {
      d = new Date(`${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}T00:00:00Z`);
    } else {
      d = new Date(`${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}T00:00:00Z`);
    }
    if (!isNaN(d)) return d;
  }
  return null;
}

// ─────────────────────────────────────────────
// Sheet → Domain transforms
// ─────────────────────────────────────────────

/**
 * HISTORY sheet — handles the "Bulanz" GoogleFinance layout:
 *   Row 1: IDX:Bulanz | (blank) | IDX:COMPOSITE | IDX:AALI | …      (formula refs)
 *   Row 2: (blank)    | (blank) | COMPOSITE     | 1        | …      (metadata)
 *   Row 3: Bulanz     | Bulanz  | IHSG          | AALI     | …      ← HEADER
 *   Row 4: 5/31/2016  | May-16  | 4797          | 13483    | …      ← DATA
 *
 * Auto-detects the header row by looking for "IHSG"; falls back to row 3.
 * Col 0 is treated as full date, col 1 as label (auto-fills if missing).
 */
function parseHistory(csv) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return [];

  // Find header row: contains a cell exactly equal to "IHSG".
  let headerIdx = rows.findIndex(r =>
    r.some(c => (c || '').trim().toUpperCase() === 'IHSG')
  );
  if (headerIdx < 0) headerIdx = Math.min(2, rows.length - 1); // Bulanz default

  const header = rows[headerIdx].map(h => (h || '').trim());
  const lc = header.map(h => h.toLowerCase());

  // Prefer explicit "date"/"label" headers if present.
  let idxDate  = lc.findIndex(h => h === 'date' || h === 'tanggal');
  let idxLabel = lc.findIndex(h => h === 'label');

  // Otherwise auto-detect from the first data row.
  if (idxDate < 0 || idxLabel < 0) {
    const first = rows[headerIdx + 1] || [];
    if (idxDate < 0) {
      for (let i = 0; i < first.length; i++) {
        if (parseDate((first[i] || '').trim())) { idxDate = i; break; }
      }
    }
    if (idxLabel < 0) {
      for (let i = 0; i < first.length; i++) {
        if (i === idxDate) continue;
        if (/^[A-Za-z]{3}[\-\s]\d{2,4}$/.test((first[i] || '').trim())) { idxLabel = i; break; }
      }
    }
    // Final fallback: A=date, B=label.
    if (idxDate < 0)  idxDate  = 0;
    if (idxLabel < 0) idxLabel = idxDate === 0 ? 1 : 0;
  }

  // Anything else with a non-empty header is a ticker.
  const tickerCols = header
    .map((h, i) => ({ name: h.toUpperCase(), i }))
    .filter(c => c.i !== idxDate && c.i !== idxLabel && c.name !== '');

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
      }
    }
    rec.label = (label || '').trim() || `Row ${r}`;
    rec.date  = dateStr || null;

    let hasNum = false;
    for (const c of tickerCols) {
      const v = toNum(row[c.i]);
      rec[c.name] = v;
      if (Number.isFinite(v)) hasNum = true;
    }
    if (hasNum) out.push(rec);
  }
  out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return out;
}

/**
 * CONSENSUS sheet — handles the layout shown in screenshot:
 *   Row 1: "Pesan di dashboard" banner (merged)
 *   Row 2: 1 | 2 | _ | 3 | header
 *   Row 3: Symbol | By | _ | Lynk.id/economstock | Hitung Nilai Wajar | _ | _ | _ | 0
 *   Row 4: Symbol | # | DATE | FIRM NAME | [] | T.PRICE | DISC | %D | T.PRICE   ← HEADER
 *   Row 5+: LPPF | 1 | 2026-02-18 | Sinarmas Sekuritas | B | 2,050 | 2,050 | 0 | 2,050
 *
 * Suggestion is encoded as 1-letter code (B/N/S). pct_d in the sheet is unreliable
 * (DISC == T.PRICE in many rows) so we always recompute from latest price.
 * Only the FIRST T.PRICE column is used; the duplicate is ignored.
 */
function parseConsensus(csv, latestPrices) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return {};

  // Find header row: looks for "Symbol" + ("DATE" or "FIRM NAME").
  let headerIdx = rows.findIndex(r => {
    const u = r.map(c => (c || '').trim().toUpperCase());
    return u.includes('SYMBOL') && (u.includes('DATE') || u.some(c => c.includes('FIRM')));
  });
  if (headerIdx < 0) headerIdx = Math.min(3, rows.length - 1); // Bulanz default

  const header = rows[headerIdx].map(h => (h || '').trim().toLowerCase());

  const find = (...names) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iTicker = find('symbol', 'ticker', 'code', 'kode', 'saham');
  const iDate   = find('date', 'tanggal');
  const iFirm   = find('firm name', 'firm', 'analyst', 'sekuritas', 'broker', 'firm_name');
  const iSugg   = find('[]', 'suggestion', 'rec', 'recommendation', 'rating', 'b/n/s', 'rekomendasi');
  const iTgt    = find('t.price', 't price', 'target_price', 'target', 'tp', 'price_target', 'target harga');
  const iPct    = find('%d', 'pct_d', 'pct', 'upside', '%delta');

  if (iTicker < 0) throw new Error('Consensus sheet must have a "Symbol"/"ticker" column.');

  const decodeSuggestion = (raw) => {
    const s = (raw || '').trim().toUpperCase();
    if (!s) return '';
    if (s === 'B' || s.includes('BUY') || s.includes('OVERWEIGHT') || s.includes('OUTPERFORM') || s === 'ADD') return 'BUY';
    if (s === 'S' || s.includes('SELL') || s.includes('UNDERWEIGHT') || s.includes('UNDERPERFORM') || s === 'REDUCE') return 'SELL';
    if (s === 'N' || s.includes('NEUTRAL') || s.includes('HOLD')) return 'NEUTRAL';
    return s;
  };

  const grouped = {};
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const t = (row[iTicker] || '').trim().toUpperCase();
    if (!t) continue;

    const target = iTgt >= 0 ? toNum(row[iTgt]) : null;
    const last = latestPrices[t];
    let pct = iPct >= 0 ? toNum(row[iPct]) : null;
    // The user's sheet has DISC == T.PRICE so %D ends up 0 — recompute when that happens.
    if ((pct == null || pct === 0) && target != null && last) {
      pct = ((target - last) / last) * 100;
    }

    let dateRaw = iDate >= 0 ? (row[iDate] || '').trim() : '';
    const dParsed = parseDate(dateRaw);
    if (dParsed) {
      // Normalise display to YYYY-MM-DD.
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

// ─────────────────────────────────────────────
// Derived metrics
// ─────────────────────────────────────────────
function lastFinite(arr) { for (let i = arr.length - 1; i >= 0; i--) if (Number.isFinite(arr[i])) return { v: arr[i], i }; return { v: null, i: -1 }; }

function pctChange(a, b) { return (Number.isFinite(a) && Number.isFinite(b) && b !== 0) ? (a - b) / b : null; }

function computeStats(history) {
  if (!history.length) return {};
  const tickers = Object.keys(history[0]).filter(k => k !== 'label' && k !== 'date');
  const stats = {};

  for (const t of tickers) {
    const series = history.map(h => h[t]);
    const dates  = history.map(h => h.date);
    const { v: cur, i: iCur } = lastFinite(series);
    if (cur == null) continue;

    const prev = iCur > 0 ? series[iCur - 1] : null;          // mom
    const ytdStart = (() => {
      const yr = (history[iCur].date || '').slice(0, 4);
      for (let i = 0; i <= iCur; i++) if ((history[i].date || '').startsWith(yr)) return series[i];
      return null;
    })();
    const yoyPrev = iCur >= 12 ? series[iCur - 12] : null;

    let max = -Infinity, min = Infinity, maxDate = null, minDate = null;
    const monthlyReturns = [];
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (!Number.isFinite(v)) continue;
      if (v > max) { max = v; maxDate = dates[i]; }
      if (v < min) { min = v; minDate = dates[i]; }
      if (i > 0 && Number.isFinite(series[i - 1]) && series[i - 1] !== 0) {
        monthlyReturns.push((v - series[i - 1]) / series[i - 1]);
      }
    }
    const mean = monthlyReturns.length ? monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length : 0;
    const variance = monthlyReturns.length ? monthlyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / monthlyReturns.length : 0;

    // Top YoY swings (largest 5 absolute)
    const yoy_large = [];
    for (let i = 12; i < series.length; i++) {
      const r = pctChange(series[i], series[i - 12]);
      if (r != null) yoy_large.push([r, dates[i]]);
    }
    yoy_large.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));

    stats[t] = {
      current: cur,
      mom: pctChange(cur, prev),
      ytd: pctChange(cur, ytdStart),
      yoy: pctChange(cur, yoyPrev),
      max, max_date: maxDate,
      min, min_date: minDate,
      avg_monthly: mean,
      std_monthly: Math.sqrt(variance),
      yoy_large: yoy_large.slice(0, 5),
    };
  }
  return stats;
}

function computeCorrelations(history) {
  if (!history.length) return {};
  const tickers = Object.keys(history[0]).filter(k => k !== 'label' && k !== 'date');
  if (!tickers.includes('IHSG')) return {};

  function returns(t) {
    const out = [];
    for (let i = 1; i < history.length; i++) {
      const a = history[i][t], b = history[i - 1][t];
      out.push(Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? (a - b) / b : null);
    }
    return out;
  }
  function pearson(x, y) {
    let n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
      if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) continue;
      n++; sx += x[i]; sy += y[i]; sxy += x[i] * y[i]; sxx += x[i] ** 2; syy += y[i] ** 2;
    }
    if (n < 2) return null;
    const num = sxy - (sx * sy) / n;
    const den = Math.sqrt((sxx - (sx * sx) / n) * (syy - (sy * sy) / n));
    return den === 0 ? null : num / den;
  }

  const ihsgRet = returns('IHSG');
  const out = {};
  for (const t of tickers) {
    if (t === 'IHSG') continue;
    const r = pearson(ihsgRet, returns(t));
    if (r != null) out[t] = Math.round(r * 10000) / 10000;
  }
  return out;
}

function computeZcores(stats) {
  const out = {};
  for (const t of Object.keys(stats)) {
    const s = stats[t];
    if (s.std_monthly && s.std_monthly !== 0 && s.mom != null) {
      out[t] = Math.round(((s.mom - s.avg_monthly) / s.std_monthly) * 100) / 100;
    }
  }
  return out;
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
// Handler
// ─────────────────────────────────────────────
let STATIC = null;
function loadStatic() {
  if (STATIC) return STATIC;
  const p = path.join(process.cwd(), 'lib', 'static.json');
  STATIC = JSON.parse(fs.readFileSync(p, 'utf8'));
  return STATIC;
}

module.exports = async (req, res) => {
  try {
    const {
      HISTORY_SHEET_ID, HISTORY_GID = '0',
      CONSENSUS_SHEET_ID, CONSENSUS_GID = '0',
      CACHE_SECONDS = '300',
    } = process.env;

    if (!HISTORY_SHEET_ID || !CONSENSUS_SHEET_ID) {
      return res.status(500).json({
        error: 'Missing env vars',
        detail: 'HISTORY_SHEET_ID and CONSENSUS_SHEET_ID must be set.',
      });
    }

    const [historyCsv, consensusCsv] = await Promise.all([
      fetchCsv(HISTORY_SHEET_ID, HISTORY_GID),
      fetchCsv(CONSENSUS_SHEET_ID, CONSENSUS_GID),
    ]);

    const price_history = parseHistory(historyCsv);
    const stats = computeStats(price_history);
    const correlations = computeCorrelations(price_history);
    const zcores = computeZcores(stats);

    // build latest-price map for consensus % computation
    const latest = {};
    for (const t of Object.keys(stats)) latest[t] = stats[t].current;

    const consensus_slim = parseConsensus(consensusCsv, latest);
    const consensus_summary = computeConsensusSummary(consensus_slim);

    const stat = loadStatic();

    const payload = {
      price_history,
      consensus_slim,
      consensus_summary,
      stats,
      correlations,
      zcores,
      stock_info: stat.stock_info,
      stock_list: stat.stock_list,
      watchlist:  stat.watchlist,
      _meta: {
        generated_at: new Date().toISOString(),
        history_rows: price_history.length,
        consensus_tickers: Object.keys(consensus_slim).length,
      },
    };

    const cache = parseInt(CACHE_SECONDS, 10) || 300;
    res.setHeader('Cache-Control', `public, s-maxage=${cache}, stale-while-revalidate=${cache * 2}`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(JSON.stringify(payload));
  } catch (err) {
    res.status(500).json({ error: 'data_pipeline_failed', message: err.message });
  }
};
