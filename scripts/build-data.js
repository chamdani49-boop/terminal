/**
 * scripts/build-data.js — build-time data pipeline.
 *
 * Fetches Google Sheets (history harga + konsensus analis + live realtime),
 * parses & enriches, tulis hasilnya ke public/data.json. Frontend serve
 * sebagai static asset.
 *
 * Required env (GitHub Secrets atau .env lokal):
 *   HISTORY_SHEET_ID, HISTORY_GID
 *   CONSENSUS_SHEET_ID, CONSENSUS_GID
 *
 * Optional env (live overlay):
 *   LIVE_SHEET_ID, LIVE_GID
 *   - Sheet dengan 3 kolom: Ticker | Harga Live | % Live
 *   - Kalau di-set, baris terakhir price_history & stats[*].current/mom
 *     di-overwrite pakai data live ini. Otomatis nyambung ke chart, hero,
 *     watchlist, price target blueprint, z-core, dan analyst upside %.
 *
 * Usage:
 *   node scripts/build-data.js
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────
// CSV utilities
// ─────────────────────────────────────────────
function gvizCsvUrl(sheetId, gid) {
  // Cache-bust: endpoint gviz/tq Google Sheets bisa menyajikan respons cache
  // beberapa menit setelah sheet diedit. Tanpa pembeda, workflow refresh bisa
  // membaca snapshot LAMA (mis. user menambah baris konsensus, tapi build masih
  // dapat versi sebelum edit). Query param unik membuat URL berbeda tiap fetch
  // → cache miss di edge Google → data selalu fresh.
  const cb = Date.now();
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}&_cb=${cb}`;
}

async function fetchCsv(sheetId, gid) {
  const url = gvizCsvUrl(sheetId, gid);
  // `cache: 'no-store'` mencegah cache HTTP sisi-klien (undici/Node) ikut menahan
  // respons lama; dikombinasikan dengan cache-buster URL di atas.
  const res = await fetch(url, { redirect: 'follow', cache: 'no-store' });
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
  let s = String(v).trim();
  if (!s || s === '-' || /^n\/?a$/i.test(s)) return null;
  // Buang simbol mata uang & spasi
  s = s.replace(/[Rp$€£¥\s]/g, '');
  // Indo style "1.234,56" → "1234.56"
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  // Banker style "1,234.56" → "1234.56"
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  // Plain "1,234" tanpa decimal: anggap thousand sep
  else if (/^-?\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, '');
  // Otherwise koma sebagai decimal
  else s = s.replace(/,/g, '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Parse berbagai format tanggal jadi Date (UTC). */
function parseDate(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;

  // Special live keywords: di sheet, baris paling bawah pakai "sekarang"
  // sebagai marker realtime (formula GoogleFinance harga-bulan-berjalan).
  // Anggap itu = awal bulan ini.
  const lower = s.toLowerCase();
  if (lower === 'sekarang' || lower === 'now' || lower === 'today' ||
      lower === 'current' || lower === 'live' || lower === 'realtime') {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  // Tolak string yang bukan kandidat tanggal sama sekali (cuma huruf, dll)
  if (!/\d/.test(s)) return null;

  // ISO langsung
  let d = new Date(s);
  if (!isNaN(d) && /\d{4}/.test(s)) return d;

  // dd/mm/yyyy atau mm/dd/yyyy atau dd-mm-yyyy
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

  // yyyy-mm
  m = s.match(/^(\d{4})[\-\/](\d{1,2})$/);
  if (m) {
    d = new Date(`${m[1]}-${m[2].padStart(2, '0')}-01T00:00:00Z`);
    if (!isNaN(d)) return d;
  }

  // "May 26", "Mei-26", "May-2026"
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

// ─────────────────────────────────────────────
// History sheet parser — robust ke berbagai layout
// ─────────────────────────────────────────────

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
  // Alias: COMPOSITE / JKSE / JCI semuanya = IHSG (Indonesia Composite Index).
  // Frontend pakai "IHSG" sebagai konvensi → unify di sini biar konsisten.
  if (s === 'COMPOSITE' || s === 'JKSE' || s === 'JCI') s = 'IHSG';
  return s;
}

/** Cari row yang paling mungkin header — punya banyak ticker-shaped string. */
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
    // Bonus kalau row punya IHSG/JKSE/COMPOSITE
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
  debug.history_header_idx = headerIdx;
  debug.history_header_sample = rawHeader.slice(0, 10);

  // Cari kolom date & label
  let idxDate = -1, idxLabel = -1;
  for (let i = 0; i < header.length; i++) {
    const h = header[i].toLowerCase();
    if (idxDate < 0 && (h === 'date' || h === 'tanggal' || h === 'tgl')) idxDate = i;
    if (idxLabel < 0 && (h === 'label' || h === 'period' || h === 'periode' || h === 'bulanz' || h === 'month')) idxLabel = i;
  }

  // Content-based fallback: scan baris data pertama
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

  // Special-case Bulanz layout: kolom A pakai header "Bulanz" tapi isinya
  // PERSIS sama-sama tanggal (bukan label "Mmm-YY"). Setelah heuristik di atas,
  // idxDate dan idxLabel bisa kolaps ke kolom yg sama. Kalau iya, cari kolom
  // label terpisah berdasarkan isi baris pertama (pola "Mmm-YY" atau "yyyy-mm").
  if (idxLabel >= 0 && idxLabel === idxDate && firstDataRow) {
    let altLabel = -1;
    for (let i = 0; i < firstDataRow.length; i++) {
      if (i === idxDate) continue;
      const v = (firstDataRow[i] || '').trim();
      if (/^[A-Za-z]{3,9}[-\s\/]\d{2,4}$/.test(v) || /^\d{4}[-\/]\d{1,2}$/.test(v)) {
        altLabel = i; break;
      }
    }
    idxLabel = altLabel; // kalau gak ketemu, biarin -1 (label dibangun dari date)
  }

  if (idxDate < 0) idxDate = 0;
  // idxLabel TIDAK di-fallback — kalau gak ketemu, biarkan -1.
  // Kalau dipaksa ke posisi 0/1, bisa "menelan" kolom ticker (mis. JKSE).

  debug.history_idx_date = idxDate;
  debug.history_idx_label = idxLabel;

  // Bangun ticker columns dengan denylist (lebih permissive, lebih robust).
  // Apapun yang non-empty + non-numeric + bukan kolom metadata → ticker.
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

  // Dedupe (kasus ada kolom identik akibat formula GoogleFinance)
  const seen = new Set();
  const dedupedCols = tickerCols.filter(c => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });

  debug.history_ticker_count = dedupedCols.length;
  debug.history_ticker_sample = dedupedCols.slice(0, 10).map(c => c.name);

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

    // Kalau date masih null tapi label parseable, pakai label-nya
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
// Consensus sheet parser — robust
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

function parseConsensus(csv, latestPrices, debug = {}) {
  const rows = parseCsv(csv);
  if (rows.length < 2) return {};

  let headerIdx = findConsensusHeaderRow(rows);
  if (headerIdx < 0) headerIdx = Math.min(3, rows.length - 1);

  const rawHeader = rows[headerIdx];
  const header = rawHeader.map(c => norm(c));
  debug.consensus_header_idx = headerIdx;
  debug.consensus_header_sample = rawHeader;

  // Fuzzy column finder. Coba exact, lalu substring.
  // Skip names yang norm-nya kosong (mis. '[]' → '') supaya gak match cell kosong di header.
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

  // Special-case: header literal "[]" (bracket kosong) — sering dipakai sebagai
  // marker kolom suggestion B/N/S. Cari di rawHeader sebelum di-normalize.
  if (iSugg < 0) {
    const i = rawHeader.findIndex(c => String(c || '').trim() === '[]');
    if (i >= 0) iSugg = i;
  }

  if (iTicker < 0) {
    // Fallback ekstrim: kolom 0 mungkin ticker
    debug.consensus_warning_no_symbol_col = true;
  }

  // Content-based fallback untuk SUGGESTION: cari kolom dengan mayoritas nilai
  // berbentuk B/N/S atau BUY/SELL/HOLD/NEUTRAL. Robust kalau header pakai simbol
  // aneh seperti "[]" atau "Rec." yang gak ke-detect oleh nama.
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
    if (bestCol >= 0 && bestCount >= 3) {
      debug.consensus_suggestion_inferred_col = bestCol;
      iSugg = bestCol;
    }
  }

  // Content-based fallback untuk T.PRICE: cari kolom numerik dengan median > 50
  // (harga saham IDX biasanya 4-digit, paling kecil 50)
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
    if (bestCol >= 0 && bestCount >= 2) {
      debug.consensus_target_inferred_col = bestCol;
      iTgt = bestCol;
    }
  }

  // Content-based fallback untuk DATE: cari kolom dengan paling banyak tanggal-parseable
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
    if (bestCol >= 0 && bestCount >= 2) {
      debug.consensus_date_inferred_col = bestCol;
      iDate = bestCol;
    }
  }

  debug.consensus_cols = { iTicker, iDate, iFirm, iSugg, iTgt, iPct };

  const grouped = {};
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const t = (row[iTicker] || '').trim().toUpperCase();
    if (!t || /^[\d.,\s]+$/.test(t)) continue;
    // Buang baris yang isinya banner atau komentar (mengandung spasi banyak)
    if (t.length > 10 || /\s/.test(t)) continue;
    // Buang marker pembatas / non-ticker (mis. "X" sebagai garis batas di sheet).
    // Ticker IDX valid = 2–5 huruf + opsional 1 digit. "X" (1 huruf) ditolak.
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

  // ── Diagnostik konsensus ───────────────────────────────────────────────
  // Bantu deteksi "baris hilang": kalau jumlah baris mentah yang dibaca gviz
  // (consensus_data_rows) lebih kecil dari yang ada di sheet, atau max_date
  // tertinggal dari tanggal edit terbaru, berarti masalahnya di FETCH/SHEET
  // (mis. gviz memotong baris di gap kosong, atau tab konsensus pakai
  // QUERY/IMPORTRANGE yang cache-nya basi di sisi Google Sheets) — bukan di
  // parser. Disimpan ke _meta.consensus_diag (bukan _debug) supaya tetap ada
  // setelah refresh live menimpa data.json.
  let _totalRecs = 0, _maxDate = '';
  for (const t of Object.keys(grouped)) {
    _totalRecs += grouped[t].length;
    for (const rec of grouped[t]) {
      if (rec.date && rec.date > _maxDate) _maxDate = rec.date;
    }
  }
  debug.consensus_data_rows  = rows.length - (headerIdx + 1);
  debug.consensus_total_recs = _totalRecs;
  debug.consensus_ticker_cnt = Object.keys(grouped).length;
  debug.consensus_max_date   = _maxDate;

  return grouped;
}

// ─────────────────────────────────────────────
// Live realtime sheet parser
// Layout fleksibel:
//   (a) Berheader   → "Ticker | Harga Live | % Live | Max 1 Tahun | when max | LOW 1 Tahun | when low"
//                     (atau alias-nya). Kolom E-H opsional.
//   (b) Headerless  → langsung data dari row 1: kolom A = ticker code,
//                     kolom B = harga, kolom C = %change. Di-detect kalau
//                     row 0 isinya cocok dengan TICKER_RX + numeric > 0.
//                     Default konvensi %change: percent (0,77 = 0,77%).
// ─────────────────────────────────────────────
function parseLive(csv, debug = {}) {
  const rows = parseCsv(csv);
  if (rows.length < 1) {
    debug.live_warning = 'Live sheet kosong';
    return {};
  }

  // ─ Headerless layout detection ─
  // Kalau row 0 sudah berbentuk data (kolom A ticker-shaped, kolom B numerik
  // > 0), treat seluruh sheet sebagai positional 3-kolom dari row 0.
  // Reasoning: user banyak yang bikin sheet LIVE pake formula GoogleFinance
  // tanpa header (langsung baris pertama = ticker pertama). Kalau ada header,
  // row 0 isinya kata-kata (gak match TICKER_RX) → fallthrough ke logic
  // berheader di bawah.
  {
    const r0 = rows[0] || [];
    const t0 = cleanTickerName(r0[0]);
    const p0 = toNum(r0[1]);
    if (t0 && (TICKER_RX.test(t0) || t0 === 'IHSG') && Number.isFinite(p0) && p0 > 0) {
      const iPctHl = r0.length > 2 ? 2 : -1;
      debug.live_headerless = true;
      debug.live_header_idx = -1;
      debug.live_header_sample = r0;
      debug.live_cols = { iTicker: 0, iPrice: 1, iPct: iPctHl, iMaxPrice: -1, iMaxDate: -1, iLowPrice: -1, iLowDate: -1 };
      // Default mode 'percent': nilai di kolom %change adalah angka percent
      // (0,77 → 0,77%). Range realistis IDX bikin ini default yang aman.
      return _parseLiveBody(rows, /*dataStart=*/0, /*iTicker=*/0, /*iPrice=*/1, iPctHl,
        /*iMaxPrice=*/-1, /*iMaxDate=*/-1, /*iLowPrice=*/-1, /*iLowDate=*/-1, 'percent');
    }
  }

  if (rows.length < 2) {
    debug.live_warning = 'Live sheet has < 2 rows';
    return {};
  }

  // Cari header row: harus punya kolom yang nyerempet ticker/symbol DAN
  // kolom yang nyerempet price/harga/live.
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
  // "live" alone bisa nyamain header "% Live"; taro paling akhir.
  const iPrice  = findFz('hargalive', 'pricelive', 'lastprice', 'hargaterakhir', 'harga', 'price', 'last', 'live');
  let iPct      = findFz('pctlive', 'percentlive', 'persenlive', 'changepct', 'pctchange', 'pct', 'percent', 'persen', 'change', 'persentase');

  // Special-case: header yang dimulai/berisi karakter "%" (mis. "% Live",
  // "%Change") — `norm()` gak strip "%", jadi findFz biasa gak nyamperin.
  // Cari di rawHeader langsung sebagai fallback.
  if (iPct < 0) {
    for (let i = 0; i < rawHeader.length; i++) {
      if (i === iTicker || i === iPrice) continue;
      const v = String(rawHeader[i] || '').trim();
      if (v.includes('%')) { iPct = i; break; }
    }
  }

  // ── Kolom High/Low 1 Tahun (opsional, kolom E–H di sheet) ──
  // Nama header yang diterima (case-insensitive, spasi/tanda baca di-strip oleh norm()):
  //   Max 1 Tahun / max1tahun / high1y / max1y / highest / tertinggi / highs
  //   when max / whenmax / tanggalmax / tglmax / datemax / datehigh
  //   LOW 1 Tahun / low1tahun / low1y / terendah / lows / lowest
  //   when low / whenlow / tanggallow / tgllow / datelow / datelowest
  const iMaxPrice = findFz('max1tahun','max1y','high1y','highest','tertinggi','highs','max','high');
  const iMaxDate  = findFz('whenmax','tanggalmax','tglmax','datemax','datehigh','wmax','tanggaltertinggi');
  const iLowPrice = findFz('low1tahun','low1y','lowest','terendah','lows','low');
  const iLowDate  = findFz('whenlow','tanggallow','tgllow','datelow','datelowest','wlow','tanggalterendah');

  debug.live_cols = { iTicker, iPrice, iPct, iMaxPrice, iMaxDate, iLowPrice, iLowDate };

  if (iTicker < 0 || iPrice < 0) {
    debug.live_warning = 'Could not locate ticker or price column in live sheet';
    return {};
  }

  // Headerful: pct mode default `auto` — preserve heuristic lama (per-row):
  // kalau ada tanda % atau |n| > 1, treat percent (bagi 100); kalau kecil &
  // tanpa %, treat fractional. Kompatibel dengan sheet versi sebelumnya.
  //
  // KECUALI: kalau nama header-nya literal mengandung karakter "%" (mis.
  // "% Live", "%Change", "% Δ"), itu sinyal eksplisit dari user bahwa
  // SEMUA nilai di kolom ini sudah dalam unit persen. Pakai mode 'percent'
  // (selalu bagi 100) untuk konsistensi — hindari kasus "0.77" disangka
  // 77% padahal yg dimaksud 0.77%.
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

/**
 * Loop body untuk parseLive. Dipake oleh kedua jalur (headerless & headerful)
 * supaya filter row + parsing %change konsisten.
 *
 * @param {string} pctMode - 'percent' (selalu bagi 100) atau 'auto' (per-row
 *   heuristic: % atau |n|>1 → bagi 100; selain itu fractional).
 * @param {number} iMaxPrice - kolom indeks "Max 1 Tahun" (-1 jika tidak ada)
 * @param {number} iMaxDate  - kolom indeks "when max"   (-1 jika tidak ada)
 * @param {number} iLowPrice - kolom indeks "LOW 1 Tahun" (-1 jika tidak ada)
 * @param {number} iLowDate  - kolom indeks "when low"   (-1 jika tidak ada)
 */
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

    // %change: input bisa "-3.35%" / "-3.35" / "-0.0335".
    // Pakai parser inline (bukan toNum) supaya gak kena Indo-thousand-sep
    // (toNum("0.012") = 12; di sini kita mau 0.012).
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

    // ── High/Low 1 Tahun ──
    // Parse harga & tanggal. Tanggal di-normalize ke ISO "YYYY-MM-DD".
    // Kalau parse gagal → null (frontend akan fallback ke price_history).
    const maxPrice = iMaxPrice >= 0 ? toNum(row[iMaxPrice]) : null;
    const lowPrice = iLowPrice >= 0 ? toNum(row[iLowPrice]) : null;

    let maxDate = null;
    if (iMaxDate >= 0) {
      const d = parseDate(String(row[iMaxDate] || '').trim());
      if (d) maxDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
    }
    let lowDate = null;
    if (iLowDate >= 0) {
      const d = parseDate(String(row[iLowDate] || '').trim());
      if (d) lowDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
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

/**
 * Overlay live data ke price_history (baris terakhir) + stats.
 * Frontend baca `price_history[last][ticker]` & `stats[ticker].current` —
 * cukup overwrite di sini, semua kartu (hero, chart, watchlist, price target,
 * blueprint, analyst table) otomatis ikut update.
 *
 * Kalau row terakhir di history BUKAN bulan berjalan, function ini akan
 * APPEND row baru untuk bulan berjalan dulu (label "Mmm-YY", date "YYYY-MM-01"),
 * lalu overlay live ke situ. Ini handle kasus user yang gak masukkan baris
 * "sekarang" di history sheet — live sheet jadi sumber tunggal untuk bulan
 * berjalan.
 */
// ─────────────────────────────────────────────
// Auto meta: stock_info / stock_list / watchlist dari universe sheet
// ─────────────────────────────────────────────
// Universe ticker = semua kolom di price_history (History Sheet) + key di live.
// Nama/sektor/papan prioritas: kolom opsional di Live Sheet > lib/static.json
// > kode (fallback). Efek: saham baru yang ditambah ke History Sheet otomatis
// muncul, bisa dicari, punya chart/stats/live — tanpa edit lib/static.json.
function collectUniverse(price_history, live) {
  const set = new Set();
  for (const row of (price_history || [])) {
    for (const k of Object.keys(row)) {
      if (k === 'date' || k === 'label') continue;
      set.add(k);
    }
  }
  if (live) for (const k of Object.keys(live)) set.add(k);
  set.delete('IHSG'); // index, bukan emiten yang masuk daftar saham
  return set;
}

// Ekstrak {code:{name,sector,board}} dari Live Sheet KALAU ada kolom opsional
// Nama/Sektor/Papan. Return {} kalau kolom-kolom itu tidak ada (graceful).
function parseLiveMeta(csv) {
  try {
    const rows = parseCsv(csv);
    if (rows.length < 2) return {};
    let headerIdx = -1;
    const limit = Math.min(rows.length, 10);
    for (let i = 0; i < limit; i++) {
      const r = rows[i].map(c => norm(c));
      if (r.some(x => x === 'ticker' || x === 'symbol' || x === 'kode' ||
                      x === 'saham' || x === 'code' || x.includes('ticker'))) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return {};
    const header = rows[headerIdx].map(c => norm(c));
    const find = (...names) => {
      for (const n of names) { const i = header.indexOf(norm(n)); if (i >= 0) return i; }
      for (const n of names) { const nn = norm(n); const i = header.findIndex(h => h && h.includes(nn)); if (i >= 0) return i; }
      return -1;
    };
    const iTicker = find('ticker', 'symbol', 'kode', 'kodesaham', 'saham', 'code');
    const iName   = find('nama', 'name', 'namaperusahaan', 'namaemiten', 'company', 'emiten', 'namasaham');
    const iSector = find('sektor', 'sector', 'industri', 'industry');
    const iBoard  = find('papan', 'board', 'papanpencatatan');
    if (iTicker < 0 || (iName < 0 && iSector < 0 && iBoard < 0)) return {};
    const out = {};
    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row) continue;
      const t = cleanTickerName(row[iTicker]);
      if (!t || (!TICKER_RX.test(t) && t !== 'IHSG')) continue;
      const meta = {};
      if (iName   >= 0 && row[iName]   && String(row[iName]).trim())   meta.name   = String(row[iName]).trim();
      if (iSector >= 0 && row[iSector] && String(row[iSector]).trim()) meta.sector = String(row[iSector]).trim();
      if (iBoard  >= 0 && row[iBoard]  && String(row[iBoard]).trim())  meta.board  = String(row[iBoard]).trim();
      if (Object.keys(meta).length) out[t] = meta;
    }
    return out;
  } catch (_) { return {}; }
}

// Bentuk { stock_info, stock_list, watchlist } otomatis dari universe.
// staticData = isi lib/static.json (atau base data lama). liveMeta = hasil
// parseLiveMeta (boleh kosong).
function buildAutoMeta(price_history, live, staticData, liveMeta) {
  const universe   = collectUniverse(price_history, live);
  const staticInfo = (staticData && staticData.stock_info) || {};
  liveMeta = liveMeta || {};

  const stock_info = {};
  for (const code of universe) {
    const s = staticInfo[code] || {};
    const m = liveMeta[code] || {};
    stock_info[code] = {
      name:   (m.name   && m.name.trim())   || s.name   || code,
      sector: (m.sector && m.sector.trim()) || s.sector || 'Lainnya',
      board:  (m.board  && m.board.trim())  || s.board  || '-',
    };
  }

  const stock_list = Array.from(universe).sort().map(code => ({
    code,
    name:   stock_info[code].name,
    sector: stock_info[code].sector,
    board:  stock_info[code].board,
  }));

  // Watchlist tetap kurasi dari static, tapi buang ticker yang sudah tidak ada
  // di universe (delisting otomatis hilang dari sidebar).
  const baseWl = (staticData && staticData.watchlist) || [];
  const seen = new Set();
  const watchlist = baseWl.filter(c => {
    if (seen.has(c) || !universe.has(c)) return false;
    seen.add(c);
    return true;
  });

  return { stock_info, stock_list, watchlist };
}

/**
 * Append/update row "bulan berjalan" di price_history dari data live.
 *
 * IMPORTANT: function ini SEKARANG cuma modify price_history. Stats di-compute
 * fresh oleh caller (computeStats) SETELAH overlay applied. Dulu function ini
 * juga mutate stats secara tumpang-tindih → bug: `mom` di-tumpuk dengan
 * `change_pct` dari sheet (yg biasanya DAILY change) padahal `std_monthly`
 * di-bandingkan asumsi monthly. Z-score jadi apple-vs-orange. Sekarang
 * pipeline: parse history → overlay → computeStats(history+overlay) → all
 * metrics konsisten monthly basis.
 *
 * Live's daily %change disimpan terpisah di stats[t].change_pct_live oleh
 * main() setelah computeStats jalan.
 */
function applyLiveOverlay(price_history, live, debug = {}) {
  if (!price_history.length || !live || !Object.keys(live).length) return;

  // Anchor "bulan berjalan" — UTC start-of-month sebagai key di price_history.
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = now.getUTCMonth();
  const curMonthIso = `${yyyy}-${String(mm + 1).padStart(2,'0')}-01`;
  // Label format harus MATCH history sheet (mis. "5/31/2026" — end-of-month
  // M/D/YYYY). Kalau pakai format lain (mis. "May-26"), x-axis chart jadi
  // mismatch & user kira datanya hilang. Hitung end-of-month UTC.
  const lastDayUtc = new Date(Date.UTC(yyyy, mm + 1, 0)).getUTCDate();
  const curLabel = `${mm + 1}/${lastDayUtc}/${yyyy}`;

  let lastRow = price_history[price_history.length - 1];

  // Kalau history terakhir bukan bulan berjalan, append row baru. Skenario:
  //   1) User gak punya baris "sekarang" di sheet histori (live sheet handle).
  //   2) Pertama kali workflow jalan setelah ganti bulan (mis. 1 Juni jam 0:01).
  if (lastRow.date !== curMonthIso) {
    lastRow = { date: curMonthIso, label: curLabel };
    price_history.push(lastRow);
    debug.live_appended_current_month = true;
  } else {
    debug.live_appended_current_month = false;
  }

  let touched = 0;
  for (const t of Object.keys(live)) {
    const lv = live[t];
    if (!Number.isFinite(lv.price) || lv.price <= 0) continue;
    lastRow[t] = lv.price;
    touched++;
  }

  debug.live_tickers_overlaid = touched;
  debug.live_tickers_total = Object.keys(live).length;
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

    const prev = iCur > 0 ? series[iCur - 1] : null;
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
    const stdMonthly = Math.sqrt(variance);

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
      std_monthly: stdMonthly,
      // Annualized — simple scaling (avg*12, std*sqrt(12)) asumsi i.i.d.
      // monthly returns. Berguna untuk hero card / risk display tanpa
      // user perlu hitung manual di sheet.
      avg_annual: mean * 12,
      std_annual: stdMonthly * Math.sqrt(12),
      // Live %change (raw dari sheet kolom "% Live", biasanya DAILY change
      // dari GoogleFinance — beda dengan `mom` yang monthly). Di-attach
      // post-overlay oleh main() supaya frontend punya source-of-truth
      // untuk display "live tick" terpisah dari MoM.
      change_pct_live: null,
      yoy_large: yoy_large.slice(0, 5),
    };
  }
  return stats;
}

function computeCorrelations(history) {
  // Rumus Excel: =CORREL(IHSG, saham) — Pearson dari HARGA LEVEL,
  // bukan dari return bulanan. Hasil identik dengan Excel.
  if (!history.length) return {};
  const tickers = Object.keys(history[0]).filter(k => k !== 'label' && k !== 'date');
  if (!tickers.includes('IHSG')) return {};

  function prices(t) {
    return history.map(row => {
      const v = row[t];
      return Number.isFinite(v) && v > 0 ? v : null;
    });
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

  const ihsgPrices = prices('IHSG');
  const out = {};
  for (const t of tickers) {
    if (t === 'IHSG') continue;
    const r = pearson(ihsgPrices, prices(t));
    if (r != null) out[t] = Math.round(r * 10000) / 10000;
  }
  return out;
}

function computeZcores(stats) {
  // Rumus Excel: Z Core = (YTD - Avg/th) / Std/th
  // Avg/th = avg_annual = avg_monthly * 12
  // Std/th = std_annual  = std_monthly * sqrt(12)
  const out = {};
  for (const t of Object.keys(stats)) {
    const s = stats[t];
    if (s.std_annual && s.std_annual !== 0 && s.ytd != null) {
      out[t] = Math.round(((s.ytd - s.avg_annual) / s.std_annual) * 100) / 100;
    }
  }
  return out;
}

/**
 * Compute beta dan relative volatility per-ticker vs IHSG.
 * - beta = cov(stock, IHSG) / var(IHSG)            (sensitivity terhadap market)
 * - rel_vol = std(stock) / std(IHSG)               (rasio risiko absolute)
 *
 * Mutates stats: tambah stats[t].beta dan stats[t].rel_vol untuk semua ticker
 * (kecuali IHSG sendiri). Dipanggil setelah computeStats.
 *
 * Catatan: rel_vol untuk TLKM ≈ 1.57 cocok dengan angka yang user sebut
 * "korelasi 1.57". Sebenernya itu rasio std (TLKM_std / IHSG_std), bukan
 * Pearson correlation. Karena annualization × √12 sama buat kedua-duanya,
 * rel_vol monthly === rel_vol annualized.
 */
function computeBetaAndRelVol(history, stats) {
  if (!history.length || !stats.IHSG) return;

  function returns(t) {
    const out = [];
    for (let i = 1; i < history.length; i++) {
      const a = history[i][t], b = history[i - 1][t];
      if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) out.push((a - b) / b);
      else out.push(null);
    }
    return out;
  }

  const ihsgRet = returns('IHSG');
  const ihsgStd = stats.IHSG.std_monthly;

  // var(IHSG) over valid entries (matches Pearson denominator method).
  const validI = ihsgRet.filter(x => Number.isFinite(x));
  const meanI = validI.reduce((a, b) => a + b, 0) / validI.length;
  const varI = validI.reduce((a, b) => a + (b - meanI) ** 2, 0) / validI.length;

  for (const t of Object.keys(stats)) {
    if (t === 'IHSG') continue;
    const ret = returns(t);
    let n = 0, sumS = 0, sumI = 0;
    for (let i = 0; i < ret.length; i++) {
      if (Number.isFinite(ret[i]) && Number.isFinite(ihsgRet[i])) {
        n++; sumS += ret[i]; sumI += ihsgRet[i];
      }
    }
    if (n < 2 || varI === 0) continue;
    const mS = sumS / n, mI = sumI / n;
    let cov = 0;
    for (let i = 0; i < ret.length; i++) {
      if (Number.isFinite(ret[i]) && Number.isFinite(ihsgRet[i])) {
        cov += (ret[i] - mS) * (ihsgRet[i] - mI);
      }
    }
    cov /= n;
    stats[t].beta = Math.round((cov / varI) * 100) / 100;
    if (ihsgStd && stats[t].std_monthly) {
      stats[t].rel_vol = Math.round((stats[t].std_monthly / ihsgStd) * 100) / 100;
    }
  }
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
// Main
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// safeLoadBase — baca data.json existing sebagai fallback.
// ─────────────────────────────────────────────
function safeLoadBase(outPath) {
  try {
    const raw = fs.readFileSync(outPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.price_history && parsed.stats) {
      console.log(`  📦 Base data loaded (${(raw.length/1024).toFixed(1)} KB, ` +
        `generated_at=${(parsed._meta||{}).generated_at || '?'})`);
      return parsed;
    }
  } catch (_) {}
  return null;
}

// ─────────────────────────────────────────────
// safeFetch — wrapper fetchCsv yang tidak pernah throw.
// Kalau gagal → log warn → return null → caller pakai base data.
// ─────────────────────────────────────────────
async function safeFetch(sheetId, gid, label) {
  if (!sheetId) return null;
  try {
    const csv = await fetchCsv(sheetId, gid);
    if (!csv || csv.trim().length < 10) throw new Error('CSV kosong / terlalu pendek');
    console.log(`  ✓ Fetched ${label}`);
    return csv;
  } catch (err) {
    console.warn(`  ⚠️  ${label} gagal: ${err.message || err}`);
    console.warn(`     → Pakai cache terakhir untuk ${label}.`);
    return null;
  }
}

// ─────────────────────────────────────────────
// Rolling window — buang baris terlama agar history selalu 121 bulan.
// Dipanggil setelah parseHistory + applyLiveOverlay.
// 121 = 10 tahun × 12 bulan + 1 (termasuk bulan berjalan).
// Saat Juni 2026 masuk, baris Mei 2016 otomatis terpotong.
// ─────────────────────────────────────────────
const HISTORY_MAX_MONTHS = 121;

function applyRollingWindow(price_history) {
  if (price_history.length <= HISTORY_MAX_MONTHS) return 0;
  const removed = price_history.length - HISTORY_MAX_MONTHS;
  price_history.splice(0, removed);
  console.log(`  🗑  Rolling window: removed ${removed} oldest row(s), kept ${price_history.length} months`);
  return removed;
}

// ─────────────────────────────────────────────
// Cache check — bandingkan harga live di data.json lama vs baru.
// Kalau identik (market tutup / libur / closing sama) → return true = skip.
// ─────────────────────────────────────────────
function isLiveCacheHit(outPath, newLive) {
  try {
    const old = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const oldLive = old.live || {};
    const tickers = Object.keys(newLive);
    if (!tickers.length) return false;
    // Cek apakah SEMUA harga live identik dengan sebelumnya
    let matched = 0;
    for (const t of tickers) {
      const nv = newLive[t] && newLive[t].price;
      const ov = oldLive[t] && oldLive[t].price;
      if (Number.isFinite(nv) && nv === ov) matched++;
    }
    const hitRatio = matched / tickers.length;
    const isHit = hitRatio >= 0.98; // 98% ticker sama → anggap cache hit
    if (isHit) {
      console.log(`  ✓  Cache hit: ${matched}/${tickers.length} harga live identik → skip commit`);
    }
    return isHit;
  } catch (_) {
    return false; // file belum ada / corrupt → selalu update
  }
}

async function main() {
  // ── Parse mode dari CLI arg atau env ──────────────────────────────────
  // Prioritas: --mode=xxx arg > REFRESH_MODE env > default 'full'
  const modeArg = process.argv.find(a => a.startsWith('--mode='));
  const mode = (modeArg ? modeArg.split('=')[1] : null)
    || process.env.REFRESH_MODE
    || 'full';
  console.log(`\n🔧 build-data.js — mode: ${mode.toUpperCase()}`);
  console.log(`   ${new Date().toISOString()}\n`);

  const {
    HISTORY_SHEET_ID, HISTORY_GID = '0',
    CONSENSUS_SHEET_ID, CONSENSUS_GID = '0',
    LIVE_SHEET_ID, LIVE_GID = '0',
  } = process.env;

  if (!HISTORY_SHEET_ID || !CONSENSUS_SHEET_ID) {
    console.error('FATAL: HISTORY_SHEET_ID and CONSENSUS_SHEET_ID must be set.');
    console.error('Set them as GitHub Secrets, or in a local .env file.');
    process.exit(1);
  }

  const outDir  = path.join(__dirname, '..', 'public');
  const outPath = path.join(outDir, 'data.json');

  // ── MODE: live — hanya fetch Live Sheet, overlay ke data.json existing ──
  // Tujuan: super cepat, tidak fetch History & Consensus (besar & lambat).
  // Kalau harga tidak berubah (cache hit) → exit tanpa tulis file.
  if (mode === 'live') {
    if (!LIVE_SHEET_ID) {
      console.log('  LIVE_SHEET_ID not set — nothing to do in live mode.');
      process.exit(0);
    }

    // Baca data.json existing sebagai base
    let baseData;
    try {
      baseData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch (e) {
      console.warn('  ⚠️  data.json belum ada, fallback ke mode full.');
      // Fallback ke full kalau belum ada base
    }

    if (!baseData) {
      // Tidak ada base → jalankan full mode sekali
      console.log('  ↪ No existing data.json, switching to full mode...');
      process.env.REFRESH_MODE = 'full';
      process.argv = process.argv.map(a => a.startsWith('--mode=') ? '--mode=full' : a);
      // Re-run sebagai full — simple approach: ganti mode dan lanjut ke blok full di bawah
    } else {
      console.log('Fetching Live Sheet only…');
      const debug = {};
      const liveCsv = await safeFetch(LIVE_SHEET_ID, LIVE_GID, 'Live Sheet');

      // Kalau live fetch gagal → pakai live data dari base (harga terakhir)
      if (!liveCsv) {
        console.warn('  ↪ Live fetch gagal — menulis ulang dengan data cache terakhir.');
        const payload = {
          ...baseData,
          _meta: {
            ...baseData._meta,
            generated_at: new Date().toISOString(),
            refresh_mode: 'live',
            fallback_reason: 'Live Sheet tidak bisa diakses — pakai harga cache terakhir',
          },
        };
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(payload));
        console.log('✓ Cache fallback written (live data unchanged)');
        return;
      }

      const newLive = parseLive(liveCsv, debug);

      // Cache check — harga identik? Skip.
      if (isLiveCacheHit(outPath, newLive)) {
        process.exit(0);
      }

      // Overlay ke price_history existing
      const price_history = baseData.price_history;
      applyLiveOverlay(price_history, newLive, debug);

      // Recompute stats yang terpengaruh live
      const stats = computeStats(price_history);
      for (const t of Object.keys(newLive)) {
        if (stats[t]) {
          stats[t].change_pct_live = Number.isFinite(newLive[t].change_pct)
            ? newLive[t].change_pct : null;
        }
      }
      const correlations = computeCorrelations(price_history);
      computeBetaAndRelVol(price_history, stats);
      const zcores = computeZcores(stats);

      const payload = {
        ...baseData,          // pertahankan consensus, stock_info, dll
        price_history,
        stats,
        correlations,
        zcores,
        live: newLive,
        _meta: {
          ...baseData._meta,
          generated_at: new Date().toISOString(),
          refresh_mode: 'live',
          live_tickers: Object.keys(newLive).length,
          live_fetch_error: null,
          _debug: debug,
        },
      };

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(payload));
      const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
      console.log(`✓ Live update done (${sizeKB} KB) — ${Object.keys(newLive).length} tickers overlaid`);
      return;
    }
  }

  // ── MODE: consensus — fetch Consensus Sheet + Live, tidak fetch History ─
  // Tujuan: update rekomendasi analis tiap 3 hari tanpa re-fetch history
  // bulanan yang besar. History diambil dari data.json existing (base).
  if (mode === 'consensus') {
    if (!CONSENSUS_SHEET_ID) {
      console.error('FATAL: CONSENSUS_SHEET_ID must be set.');
      process.exit(1);
    }

    let baseData;
    try {
      baseData = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch (e) {
      console.warn('  ⚠️  data.json belum ada, fallback ke mode full.');
    }

    if (!baseData) {
      console.log('  ↪ No existing data.json, switching to full mode...');
      // Fallthrough ke mode full di bawah
    } else {
      console.log('Fetching Consensus + Live sheets…');
      const debug = {};
      const [consensusCsv, liveCsvResult] = await Promise.all([
        safeFetch(CONSENSUS_SHEET_ID, CONSENSUS_GID, 'Consensus Sheet'),
        LIVE_SHEET_ID ? safeFetch(LIVE_SHEET_ID, LIVE_GID, 'Live Sheet') : Promise.resolve(null),
      ]);
      const liveCsv = liveCsvResult;

      // Pakai price_history dari base
      const price_history = baseData.price_history;

      // Live: pakai fresh kalau ada, fallback ke base.live
      const newLive = liveCsv ? parseLive(liveCsv, debug) : (baseData.live || {});
      if (liveCsv) applyLiveOverlay(price_history, newLive, debug);

      // Consensus: pakai fresh kalau ada, fallback ke base consensus
      let consensus_slim, consensus_summary;
      if (consensusCsv) {
        const stats_tmp = computeStats(price_history);
        const latest = {};
        for (const t of Object.keys(stats_tmp)) latest[t] = stats_tmp[t].current;
        consensus_slim    = parseConsensus(consensusCsv, latest, debug);
        consensus_summary = computeConsensusSummary(consensus_slim);
        console.log(`  ✓ Consensus parsed: ${Object.keys(consensus_slim).length} tickers`);
      } else {
        console.warn('  ↪ Consensus gagal — pakai data consensus cache terakhir.');
        consensus_slim    = baseData.consensus_slim    || {};
        consensus_summary = baseData.consensus_summary || {};
      }

      const stats = computeStats(price_history);
      for (const t of Object.keys(newLive)) {
        if (stats[t]) {
          stats[t].change_pct_live = Number.isFinite(newLive[t].change_pct)
            ? newLive[t].change_pct : null;
        }
      }
      const correlations = computeCorrelations(price_history);
      computeBetaAndRelVol(price_history, stats);
      const zcores = computeZcores(stats);

      // Rebuild rec_ohlc_meta dari consensus_slim yang baru
      const rec_ohlc_meta_new = {};
      for (const [ticker, recs] of Object.entries(consensus_slim)) {
        const dates = recs.map(r => r.date).filter(Boolean).sort();
        if (dates.length > 0) {
          const maxBack = new Date();
          maxBack.setUTCMonth(maxBack.getUTCMonth() - 18);
          const maxBackStr = maxBack.toISOString().slice(0, 10);
          rec_ohlc_meta_new[ticker] = dates[0] > maxBackStr ? dates[0] : maxBackStr;
        }
      }

      const payload = {
        ...baseData,
        price_history,
        stats,
        correlations,
        zcores,
        live: liveCsv ? newLive : baseData.live,
        consensus_slim,
        consensus_summary,
        rec_ohlc_meta: rec_ohlc_meta_new,
        _meta: {
          ...baseData._meta,
          generated_at: new Date().toISOString(),
          refresh_mode: 'consensus',
          consensus_tickers: Object.keys(consensus_slim).length,
          live_tickers: Object.keys(newLive).length,
          fallback_used: !consensusCsv || !liveCsv
            ? `${!consensusCsv?'consensus ':''} ${!liveCsv?'live':''}`.trim()
            : null,
          // Diagnostik konsensus persisten (bertahan setelah refresh live).
          consensus_diag: consensusCsv ? {
            data_rows:  debug.consensus_data_rows  ?? null,
            total_recs: debug.consensus_total_recs ?? null,
            tickers:    debug.consensus_ticker_cnt ?? null,
            max_date:   debug.consensus_max_date   ?? null,
            header_idx: debug.consensus_header_idx ?? null,
            cols:       debug.consensus_cols       ?? null,
            fetched_at: new Date().toISOString(),
          } : (baseData._meta && baseData._meta.consensus_diag) || null,
          _debug: debug,
        },
      };

      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(payload));
      const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
      console.log(`✓ Consensus update done (${sizeKB} KB) — ${Object.keys(consensus_slim).length} tickers`);
      return;
    }
  }

  // ── MODE: history — full fetch semua sheet, rolling window aktif ──────
  // ── MODE: full    — full fetch semua sheet (default) ──────────────────
  console.log(`Fetching all sheets (mode: ${mode})…`);

  // Load base data sebagai fallback kalau salah satu sheet gagal
  const baseData = safeLoadBase(outPath);

  // Fetch semua 3 sheet secara paralel, masing-masing non-fatal
  const [historyCsv, consensusCsv, liveCsv] = await Promise.all([
    safeFetch(HISTORY_SHEET_ID, HISTORY_GID,   'History Sheet'),
    safeFetch(CONSENSUS_SHEET_ID, CONSENSUS_GID, 'Consensus Sheet'),
    LIVE_SHEET_ID
      ? safeFetch(LIVE_SHEET_ID, LIVE_GID, 'Live Sheet')
      : Promise.resolve(null),
  ]);

  // Kalau History gagal → FATAL kalau belum ada base, fallback ke base kalau ada
  let price_history;
  let historyFallback = false;
  if (historyCsv) {
    const debug2 = {};
    price_history = parseHistory(historyCsv, debug2);
    Object.assign(debug, debug2);
  } else if (baseData && baseData.price_history && baseData.price_history.length > 0) {
    console.warn('  ↪ History gagal — pakai price_history cache terakhir.');
    price_history = baseData.price_history;
    historyFallback = true;
  } else {
    console.error('FATAL: History Sheet gagal dan tidak ada cache data.json.');
    process.exit(1);
  }

  console.log('Parsing & computing…');

  console.log('Parsing & computing…');
  const debug = {};

  // Live overlay
  const live = liveCsv ? parseLive(liveCsv, debug) : (baseData ? baseData.live || {} : {});
  applyLiveOverlay(price_history, live, debug);
  applyRollingWindow(price_history);

  const stats = computeStats(price_history);
  for (const t of Object.keys(live)) {
    if (stats[t]) {
      stats[t].change_pct_live = Number.isFinite(live[t].change_pct)
        ? live[t].change_pct : null;
    }
  }

  const correlations = computeCorrelations(price_history);
  computeBetaAndRelVol(price_history, stats);
  const zcores = computeZcores(stats);

  const latest = {};
  for (const t of Object.keys(stats)) latest[t] = stats[t].current;

  // Consensus: pakai fresh kalau ada, fallback ke base kalau gagal
  let consensus_slim, consensus_summary;
  let consensusFallback = false;
  if (consensusCsv) {
    consensus_slim    = parseConsensus(consensusCsv, latest, debug);
    consensus_summary = computeConsensusSummary(consensus_slim);
  } else if (baseData && baseData.consensus_slim) {
    console.warn('  ↪ Consensus gagal — pakai data consensus cache terakhir.');
    consensus_slim    = baseData.consensus_slim;
    consensus_summary = baseData.consensus_summary || computeConsensusSummary(consensus_slim);
    consensusFallback = true;
  } else {
    consensus_slim    = {};
    consensus_summary = {};
  }

  const staticPath = path.join(__dirname, '..', 'lib', 'static.json');
  const stat = JSON.parse(fs.readFileSync(staticPath, 'utf8'));

  // Auto-meta: stock_info/stock_list/watchlist dari universe sheet (History +
  // Live), bukan murni dari static.json. Saham baru di History Sheet otomatis
  // ikut; nama/sektor opsional dari kolom Live Sheet, fallback ke static → kode.
  const liveMeta = liveCsv ? parseLiveMeta(liveCsv) : {};
  const autoMeta = buildAutoMeta(price_history, live, stat, liveMeta);

  // Diagnostics: berapa target_price yang berhasil terbaca, tanggal, dll
  let consensus_with_target = 0, consensus_with_date = 0, consensus_total_rows = 0;
  for (const recs of Object.values(consensus_slim)) {
    for (const r of recs) {
      consensus_total_rows++;
      if (Number.isFinite(r.target_price)) consensus_with_target++;
      if (r.date) consensus_with_date++;
    }
  }

  // ── rec_ohlc_meta: daftar ticker unik dari consensus + tanggal rilis paling lama.
  // Dipakai frontend sebagai seed untuk fetch OHLC harian ke Worker.
  // Format: { "TLKM": "2025-11-27", "BBCA": "2025-11-28", ... }
  const rec_ohlc_meta = {};
  for (const [ticker, recs] of Object.entries(consensus_slim)) {
    const dates = recs.map(r => r.date).filter(Boolean).sort();
    if (dates.length > 0) {
      // Ambil 18 bulan ke belakang dari today sebagai batas maksimum,
      // supaya tidak fetch terlalu jauh ke belakang kalau ada rec sangat lama.
      const maxBack = new Date();
      maxBack.setUTCMonth(maxBack.getUTCMonth() - 18);
      const maxBackStr = maxBack.toISOString().slice(0, 10);
      rec_ohlc_meta[ticker] = dates[0] > maxBackStr ? dates[0] : maxBackStr;
    }
  }

  const payload = {
    price_history,
    consensus_slim,
    consensus_summary,
    stats,
    correlations,
    zcores,
    live,                 // ← raw live overlay map (juga di-overlay ke price_history & stats)
    rec_ohlc_meta,        // ← seed: {TICKER: "oldest-rec-date"} untuk fetch OHLC per ticker
    stock_info: autoMeta.stock_info,
    stock_list: autoMeta.stock_list,
    watchlist:  autoMeta.watchlist,
    _meta: {
      generated_at: new Date().toISOString(),
      refresh_mode: mode,
      history_rows: price_history.length,
      fallback_used: [
        historyFallback   ? 'history'   : null,
        consensusFallback ? 'consensus' : null,
        !liveCsv && LIVE_SHEET_ID ? 'live' : null,
      ].filter(Boolean).join(', ') || null,
      consensus_tickers: Object.keys(consensus_slim).length,
      consensus_total_rows,
      consensus_with_target,
      consensus_with_date,
      tickers_in_history: Object.keys(price_history[0] || {}).filter(k => k !== 'label' && k !== 'date').length,
      live_tickers: Object.keys(live).length,
      live_enabled: !!LIVE_SHEET_ID,
      live_fetch_error: liveFetchError,
      _debug: debug,
    },
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload));

  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`✓ Wrote ${outPath} (${sizeKB} KB)`);
  console.log(`  History: ${payload._meta.history_rows} months · ${payload._meta.tickers_in_history} tickers`);
  console.log(`  Consensus: ${payload._meta.consensus_tickers} tickers · ${consensus_total_rows} rows · ${consensus_with_target} with target · ${consensus_with_date} with date`);
  if (LIVE_SHEET_ID) {
    console.log(`  Live: ${Object.keys(live).length} tickers parsed · ${debug.live_tickers_overlaid || 0} overlaid into stats`);
  }
  if (price_history.length < 12) {
    console.warn('  ⚠️  History rows < 12. Cek HISTORY_SHEET_ID/GID dan layout sheet.');
    console.warn('     Header sample:', JSON.stringify(debug.history_header_sample));
  }
  if (consensus_with_target === 0 && consensus_total_rows > 0) {
    console.warn('  ⚠️  Tidak ada target_price terbaca. Cek nama kolom T.PRICE / TARGET di sheet konsensus.');
    console.warn('     Header sample:', JSON.stringify(debug.consensus_header_sample));
  }
  if (LIVE_SHEET_ID && Object.keys(live).length === 0) {
    console.warn('  ⚠️  LIVE_SHEET_ID di-set tapi gak ada ticker terbaca dari sheet live.');
    console.warn('     Header sample:', JSON.stringify(debug.live_header_sample));
    console.warn('     Cek nama kolom: butuh "Ticker" + "Harga Live"/"Price"/"Last".');
  }
}

// Export untuk testing
if (require.main === module) {
  main().catch((err) => {
    console.error('Build failed:', err);
    process.exit(1);
  });
} else {
  module.exports = { parseHistory, parseConsensus, parseLive, applyLiveOverlay, parseCsv, parseDate, toNum, decodeSuggestion, cleanTickerName, collectUniverse, parseLiveMeta, buildAutoMeta };
}
