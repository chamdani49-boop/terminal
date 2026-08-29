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
 *   - Google Sheet "Tracker" via GViz JSON endpoint (public read).
 *     URL: https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?
 *          tqx=out:json&sheet=Tracker
 *     Syarat: sheet di-set "Share → Anyone with the link → Viewer".
 *     Tidak butuh token / OAuth / Apps Script — endpoint publik Google.
 *   - Harga saham daily: public/ohlc.json (auto-refresh cron 17:00 WIB)
 *   - Sector per ticker: public/screening.json
 *   - IHSG daily: Yahoo Finance ^JKSE (fallback: public/macro.json bulanan)
 *
 * GRACEFUL DEGRADATION:
 *   - Bila env TRACKER_SHEET_ID tidak di-set → tulis tracker.json dgn pending:true.
 *   - Bila fetch gviz gagal → pertahankan file lama (jangan overwrite dgn kosong).
 *   - Bila IHSG fetch gagal → skip series30d, kolom lain tetap terisi.
 *
 * USAGE:
 *   node scripts/build-tracker.js
 *
 * ENV (opsional):
 *   TRACKER_SHEET_ID      — Google Sheet ID (potong dari URL sheet, bagian
 *                            antara /d/ dan /edit). Contoh:
 *                            https://docs.google.com/spreadsheets/d/1AbC…xyZ/edit
 *                                                               └────┬────┘
 *                                                               SHEET_ID
 *   TRACKER_SHEET_TAB     — nama tab dalam sheet (default: "Tracker")
 *   TRACKER_FIXTURE_PATH  — path ke fixture JSON (untuk uji offline)
 *   TRACKER_MAX_HISTORY   — batas history yg disimpan (default 500)
 */

const fs = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const OUT_PATH     = path.join(ROOT, 'public', 'tracker.json');
const OHLC_PATH    = path.join(ROOT, 'public', 'ohlc.json');
const SCREEN_PATH  = path.join(ROOT, 'public', 'screening.json');
const MACRO_PATH   = path.join(ROOT, 'public', 'macro.json');
const HISTORY_PATH = path.join(ROOT, 'public', 'tracker-history.json');
// data.json ditulis oleh scripts/build-data.js dgn field `live[ticker].
// intraday_{high,low,date}` yg terakumulasi lintas build (setiap 5 mnt saat
// market jalan). Kita baca sebagai supplemental source utk virtual candle
// build biar range high/low real intraday — bukan span palsu dari
// close-kemarin ke harga-sekarang.
const DATA_PATH    = path.join(ROOT, 'public', 'data.json');

const MAX_HISTORY = parseInt(process.env.TRACKER_MAX_HISTORY || '500', 10);
const DAILY_EQUITY_DAYS = 30;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────
// 1) FETCH RAW ROWS DARI GOOGLE SHEET VIA GVIZ (PUBLIC READ, ZERO AUTH)
// ─────────────────────────────────────────────────────────────────────────
// Endpoint gviz mengembalikan response dgn wrapper JSONP:
//   /*O_o*/ google.visualization.Query.setResponse({...JSON...});
// Kita strip wrapper-nya lalu parse. Format table:
//   { cols:[{id,label,type},...], rows:[{c:[{v,f?}, ...]}, ...] }
// - "type: datetime" → v = "Date(YYYY,M,D,h,m,s)" (M zero-indexed!)
// - "type: number"   → v = number
// - "type: string"   → v = string
// ─────────────────────────────────────────────────────────────────────────
async function fetchSheetRows() {
  const sheetId = process.env.TRACKER_SHEET_ID;
  const sheetTab = process.env.TRACKER_SHEET_TAB || 'Tracker';
  const fixture = process.env.TRACKER_FIXTURE_PATH;

  if (fixture) {
    console.log(`  ℹ Using fixture: ${fixture}`);
    const raw = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    const all = raw.items || raw;
    const statusCounts = tallyStatus(all);
    const approved = all.filter(x => isApprovedStatus(x.status));
    // Fixture tanpa kolom status → pakai semua baris (mode uji offline).
    const items = approved.length ? approved : all;
    return { ok: true, source: 'fixture', items, allCount: all.length, statusCounts };
  }
  if (!sheetId) {
    console.warn('  ⚠ TRACKER_SHEET_ID tidak di-set. Tulis pending:true.');
    return { ok: false, source: 'gviz', reason: 'no-credentials', items: [] };
  }

  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq`
    + `?tqx=out:json&sheet=${encodeURIComponent(sheetTab)}`;

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'text/plain,application/json,*/*',
          'User-Agent': 'Mozilla/5.0 (compatible; TrackerBuild/1.0)',
        },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // Strip wrapper /*O_o*/ google.visualization.Query.setResponse(...);
      const m = text.match(/setResponse\(([\s\S]*)\);?\s*$/);
      if (!m) throw new Error('gviz wrapper tidak ditemukan (sheet mungkin belum di-share public?)');
      const payload = JSON.parse(m[1]);
      if (!payload || !payload.table) throw new Error('gviz payload tidak valid');
      if (payload.status === 'error' || (payload.errors && payload.errors.length)) {
        const errMsg = (payload.errors && payload.errors[0] && payload.errors[0].detailed_message) || 'gviz error';
        throw new Error(errMsg);
      }

      const items = gvizTableToItems(payload.table);
      const statusCounts = tallyStatus(items);
      const approved = items.filter(x => isApprovedStatus(x.status));
      console.log(`  ✓ Sheet: ${items.length} total rows, ${approved.length} approved`);
      console.log('    status breakdown:', JSON.stringify(statusCounts));
      return { ok: true, source: 'gviz', items: approved, allCount: items.length, statusCounts };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  console.warn('  ⚠ Sheet fetch gagal:', lastErr && lastErr.message);
  return { ok: false, source: 'gviz', reason: 'fetch-failed', error: String(lastErr), items: [] };
}

// Konversi table gviz → array of objects (key = header dari row 1 sheet).
// Handle tipe kolom: datetime (Date(...) string) → ISO; number/string → as-is.
function gvizTableToItems(table) {
  const cols = table.cols || [];
  const rows = table.rows || [];
  // Ambil header: prefer cols[i].label (nama kolom dari row 1). Kalau kosong,
  // fallback ke cols[i].id (A, B, C, ...).
  const headers = cols.map((c, i) => {
    const lbl = String(c.label || '').trim();
    return lbl || `col${i}`;
  });

  const items = [];
  rows.forEach((r, ri) => {
    if (!r || !Array.isArray(r.c)) return;
    const obj = { _row: ri + 2 }; // +2 karena row 1 = header
    // Preservasi nilai kolom per-index (0-based) → aksesnya independen dari
    // label header. Berguna utk fallback "kolom Q" (index 16) ketika label
    // sheet bisa berubah tanpa pemberitahuan.
    obj._cols = [];
    r.c.forEach((cell, ci) => {
      const key = headers[ci];
      // Raw value (untuk _cols), tetap disimpan meski key tak dipakai
      var rawV = (cell && cell.v != null) ? cell.v : '';
      obj._cols[ci] = rawV;
      if (!key) return;
      if (!cell) { obj[key] = ''; return; }
      let v = cell.v;
      // Kolom datetime dari gviz: "Date(YYYY,M,D,h,m,s)" — M 0-indexed
      if (typeof v === 'string' && /^Date\(\d{4},\d+,\d+/.test(v)) {
        const parts = v.match(/Date\((\d{4}),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/);
        if (parts) {
          const yy = +parts[1], mo = +parts[2], da = +parts[3];
          const hh = parts[4] ? +parts[4] : 0;
          const mm = parts[5] ? +parts[5] : 0;
          const ss = parts[6] ? +parts[6] : 0;
          // Simpan sbg ISO datetime (untuk timestamp) atau ISO date (untuk tanggal).
          // Kalau formatted 'f' ada, gviz kadang kasih string 'YYYY-MM-DD' — pakai itu.
          if (cell.f && /^\d{4}-\d{2}-\d{2}$/.test(String(cell.f).trim())) {
            v = String(cell.f).trim();
          } else if (hh === 0 && mm === 0 && ss === 0) {
            v = `${yy}-${String(mo + 1).padStart(2, '0')}-${String(da).padStart(2, '0')}`;
          } else {
            v = new Date(Date.UTC(yy, mo, da, hh, mm, ss)).toISOString();
          }
        }
      }
      obj[key] = v == null ? '' : v;
    });
    // Timestamp field khusus: kalau ada 'timestamp' kolom & itu Date-parsed ISO, catat _ts.
    if (obj.timestamp) {
      const d = new Date(obj.timestamp);
      if (!isNaN(d.getTime())) obj._ts = d.getTime();
    }
    items.push(obj);
  });
  return items;
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
// 2c) LOAD TRACKER HISTORY (public/tracker-history.json) — ARSIP KUMULATIF
// ─────────────────────────────────────────────────────────────────────────
// Sheet Google Tracker akan di-WIPE user tiap tgl 1 tiap bulan (mulai bulan
// berjalan Agustus 2026 dst.) supaya sheet tidak menumpuk & lambat. Supaya
// visual di web TIDAK KEHILANGAN data historis, workflow terpisah
// (`archive-tracker.yml`) melakukan upsert isi sheet ke file JSON kumulatif
// `public/tracker-history.json` setiap hari jam 19:00 WIB, plus snapshot
// bulanan `public/tracker-history/YYYY-MM.json` setiap tgl 1 jam 01 WIB.
//
// KENAPA di-load DI SINI: `build-tracker.js` merge (sheet items ∪ history
// items) → dedup by stableItemKey → normalize → derive state. Efeknya:
//   - Trade closed di bulan lampau (sudah lenyap dari sheet) tetap masuk
//     historyList / winrate / dsb.
//   - Trade masih aktif (TRIGGERED / PENDING) yang ter-arsip lalu sheet
//     di-wipe → tetap dilacak, `derivePosition` menghitung state fresh dari
//     OHLC terbaru → kalau TP/SL akhirnya kena, state ikut ter-update di
//     tracker.json (tanpa perlu re-input manual ke sheet).
//   - Sheet menang saat identity conflict → user tetap bisa koreksi
//     rekomendasi dgn edit langsung di sheet (arsip di-abaikan utk key ybs).
//
// FORMAT FILE: { version, generatedAt, count, items: [...] } dgn items[]
// berbentuk RAW sheet rows (persis output gvizTableToItems, bukan hasil
// normalize). Memudahkan re-normalize kalau schema normalizeRow berubah.
// ─────────────────────────────────────────────────────────────────────────
function loadTrackerHistory() {
  if (!fs.existsSync(HISTORY_PATH)) return { items: [], version: 1 };
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    const items = Array.isArray(raw && raw.items) ? raw.items : [];
    return {
      items,
      version: (raw && raw.version) || 1,
      generatedAt: raw && raw.generatedAt,
      count: items.length,
    };
  } catch (e) {
    console.warn('  ⚠ tracker-history.json rusak:', e.message);
    return { items: [], version: 1 };
  }
}

// Identity stable untuk dedup arsip vs sheet. Tidak pakai `_row` karena
// row-number sheet berubah setiap kali baris atas di-hapus. Prioritas:
//   1) `_ts` (submission timestamp dari kolom `timestamp` di sheet)
//   2) content fingerprint (ticker + tanggal + firm + entry) sebagai fallback
// Fingerprint content dipilih dari field yg tidak lazim di-edit user
// (nilai numerik / ID posisi) supaya minor edit note/horizon tidak
// mengubah identity.
function stableItemKey(raw) {
  if (!raw) return '';
  const ts = raw._ts || 0;
  const ticker = String(raw.ticker || '').trim().toUpperCase();
  const tanggal = String(raw.tanggal || '').trim();
  const firm = String(raw.firm || '').trim().toLowerCase();
  const entry = String(raw.entry != null ? raw.entry : '').trim();
  return `${ts}|${ticker}|${tanggal}|${firm}|${entry}`;
}

// ─────────────────────────────────────────────────────────────────────────
// 2b) LIVE OVERLAY — inject virtual today candle ke ohlc.json in-memory
// ─────────────────────────────────────────────────────────────────────────
// KENAPA: ohlc.json di-refresh EOD (~17:00 WIB). Rec yg rilis hari ini →
// filter derivePosition `c[0] >= openTs` menghasilkan array kosong → state
// stays PENDING padahal harga sudah bergerak (dan mungkin sudah kena entry/
// SL/TP intraday).
//
// SOLUSI: fetch harga live dari SUMBER YG SAMA dgn UI Tracker & Dashboard
// yaitu Worker `terminal-live` endpoint `/live.json`. Konsistensi absolut:
// frontend & backend see snapshot yg persis identik dari Worker (yg internal
// fetch dari Sheet Live via gviz + cache 60s + backup stale 12 jam).
//
// GUARD (mirror _ohlcMergeToday di frontend):
//   - Hari kerja WIB (Sen–Jum)
//   - Sudah lewat jam buka bursa (≥09:00 WIB) — sebelum itu, harga live masih
//     closing kemarin → candle "hari ini" akan salah (harga = closing).
//   - Live entry ada untuk ticker + price valid
//   - Belum ada candle >= today di ohlc.json (avoid duplicate)
//
// FORMAT candle: [ts_unix_sec, open, high, low, close] — sama dgn ohlc.json.
//
// AUTH: Worker `/live.json` butuh HMAC token (LIVE_TOKEN_SECRET, sama dgn
// yg dipakai main Worker /api/live-token). Token digenerate di sini pakai
// algo yg identik — b64url payload {scope:'live', exp} + '.' + b64url HMAC.

const crypto = require('crypto');

// URL Worker terminal-live. Bisa di-override via env var untuk staging.
const DEFAULT_LIVE_WORKER_URL = 'https://terminal-live.chamdani49.workers.dev/live.json';

function _b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Generate token yg valid untuk Worker terminal-live (~15 menit expiry).
// Algo persis dgn src/index.js /api/live-token (hmacSign + b64urlEncode).
function _generateLiveToken(secret) {
  const exp = Math.floor(Date.now() / 1000) + 900; // 15 menit
  const payloadB64 = _b64url(JSON.stringify({ scope: 'live', exp }));
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest();
  const sigB64 = _b64url(sig);
  return `${payloadB64}.${sigB64}`;
}

// Baca `public/data.json` dan return field .live (per-ticker snapshot yg
// diperkaya intraday_high/intraday_low/intraday_date oleh build-data.js).
// Return {} kalau file tidak ada / parse error / field kosong. Non-fatal.
function _readIntradayFromDataJson() {
  try {
    if (!fs.existsSync(DATA_PATH)) return {};
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    return (raw && raw.live && typeof raw.live === 'object') ? raw.live : {};
  } catch (e) {
    console.warn('  ⚠ Baca intraday dari data.json gagal (non-fatal):', e.message);
    return {};
  }
}

// Merge intraday_high/intraday_low/intraday_date dari data.json.live ke
// live map dari Worker /live.json. Worker map hanya kasih price+change_pct
// (stateless per invocation), sedangkan data.json.live punya state ter-
// akumulasi lintas 5-min build. Setelah merge, `buildTodayCandleFromLive`
// bisa pakai intraday range real utk high/low virtual candle.
function _enrichLiveWithIntraday(liveMap, intradayFromData) {
  if (!liveMap || typeof liveMap !== 'object') return 0;
  if (!intradayFromData || typeof intradayFromData !== 'object') return 0;
  let n = 0;
  for (const t of Object.keys(liveMap)) {
    const src = intradayFromData[t];
    if (!src) continue;
    if (!Number.isFinite(+src.intraday_high) || !Number.isFinite(+src.intraday_low)) continue;
    if (!src.intraday_date) continue;
    liveMap[t].intraday_high = +src.intraday_high;
    liveMap[t].intraday_low  = +src.intraday_low;
    liveMap[t].intraday_date = src.intraday_date;
    n++;
  }
  return n;
}

async function fetchLiveMap() {
  const secret = process.env.LIVE_TOKEN_SECRET;
  const workerUrl = process.env.LIVE_WORKER_URL || DEFAULT_LIVE_WORKER_URL;
  if (!secret) {
    console.log('  ℹ LIVE_TOKEN_SECRET tidak di-set — skip live overlay.');
    return {};
  }
  let token;
  try {
    token = _generateLiveToken(secret);
  } catch (e) {
    console.warn('  ⚠ Generate token gagal:', e.message);
    return {};
  }
  // Cache-buster jendela 60 detik: URL berubah tiap menit → browser/CDN gak
  // menyajikan salinan lama, TAPI dalam 1 jendela URL identik → Cloudflare
  // edge cache tetap melayani dari cache (s-maxage 60).
  const cb = Math.floor(Date.now() / 60000);
  const url = workerUrl + '?token=' + encodeURIComponent(token) + '&_cb=' + cb;
  try {
    const res = await fetch(url, { redirect: 'follow', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json || json.ok !== true || !json.live) {
      throw new Error('payload tidak valid: ' + JSON.stringify(json).slice(0, 200));
    }
    const staleTag = json.stale ? ' [STALE — pakai backup terakhir Worker]' : '';
    console.log(`  ✓ Live feed (Worker): ${json.count || 0} ticker · generated_at=${json.generated_at || '?'}${staleTag}`);
    return json.live;
  } catch (e) {
    console.warn('  ⚠ Live feed fetch gagal:', e.message);
    return {};
  }
}

// Bangun 1 virtual candle "hari ini" dari live entry.
// Format: [ts_unix_sec, open, high, low, close] — konsisten dgn ohlc.json.
// Return null kalau data tidak valid.
//
// PRIORITAS high/low:
//   1. `liveEntry.intraday_high/low` (kalau intraday_date === today WIB) —
//      diakumulasi lintas build oleh build-data.js._mergeIntradayState.
//      Ini range intraday sesungguhnya (max/min semua snapshot yg pernah
//      dilihat hari ini), merged lagi dgn `price` sekarang biar ikut fresh.
//   2. Fallback single-point: high = low = price. Aman utk trigger
//      detection (nggak span palsu). Cocok utk kondisi pertama kali
//      state belum ke-init (mis. build pertama pagi hari).
//
// CATATAN: `open` tetap pakai `openEst = price / (1+change_pct)` = close
// kemarin. Ini semantic-nya adalah "baseline reference sebelum sesi mulai"
// dan dipakai `derivePosition` utk direction inference (LIMIT vs STOP).
// BUKAN benar-benar open hari ini — nggak apa-apa karena tidak dipakai
// utk trigger detection lagi (yg pakai high/low real dari intraday).
function buildTodayCandleFromLive(liveEntry, todayIso) {
  if (!liveEntry) return null;
  const price = +liveEntry.price;
  if (!Number.isFinite(price) || price <= 0) return null;
  const chg = Number.isFinite(liveEntry.change_pct) ? liveEntry.change_pct : 0;
  const openEst = chg !== 0 ? Math.round(price / (1 + chg)) : price;
  const ts = Math.floor(Date.parse(todayIso + 'T00:00:00Z') / 1000);

  // Virtual candle high/low = intraday observation SAJA (tidak include
  // openEst). Alasan: `openEst = yesterday's close` sering GAP dari
  // today's actual open, jadi tidak reliable sbg titik dalam today's
  // price path. Kalau kita paksa include openEst dalam range → false
  // positive touch (mis. yesterday close di seberang entry dari today's
  // price path).
  const idHi = +liveEntry.intraday_high;
  const idLo = +liveEntry.intraday_low;
  const idDate = liveEntry.intraday_date;
  const hasIntraday = idDate === todayIso
                      && Number.isFinite(idHi) && idHi > 0
                      && Number.isFinite(idLo) && idLo > 0;
  const high = hasIntraday ? Math.max(idHi, price) : price;
  const low  = hasIntraday ? Math.min(idLo, price) : price;

  return [
    ts,
    openEst,
    Math.round(high),
    Math.round(low),
    Math.round(price),
  ];
}

// Return "today (WIB) ISO date" + guard flag apakah bursa sudah buka.
// Bursa IDX Sen–Jum ≥09:00 WIB. Sebelum jam buka: virtual candle tidak sah
// (harga live masih closing hari sebelumnya).
function nowWibInfo() {
  const nowWib = new Date(Date.now() + 7 * 3600 * 1000);
  const todayIso = nowWib.toISOString().slice(0, 10);
  const dow = nowWib.getUTCDay();       // 0=Min .. 6=Sab
  const hour = nowWib.getUTCHours();
  const sessionStarted = dow >= 1 && dow <= 5 && hour >= 9;
  return { todayIsoWib: todayIso, sessionStarted };
}

// Augment ohlcData.tickers[*].candles in-place dgn virtual today candle.
// Return jumlah ticker yg di-augment.
function augmentOhlcWithLive(ohlcData, live) {
  if (!ohlcData || !ohlcData.tickers || !live) return 0;
  const { todayIsoWib, sessionStarted } = nowWibInfo();
  if (!sessionStarted) {
    console.log('  ℹ Bursa belum buka / weekend — skip live overlay ohlc.');
    return 0;
  }
  const todayTs = Math.floor(Date.parse(todayIsoWib + 'T00:00:00Z') / 1000);
  let augmented = 0;
  for (const ticker in live) {
    const entry = ohlcData.tickers[ticker];
    if (!entry || !Array.isArray(entry.candles) || !entry.candles.length) continue;
    // Skip kalau candle hari ini (atau lebih baru) sudah ada di ohlc.json.
    const lastCandle = entry.candles[entry.candles.length - 1];
    if (lastCandle && lastCandle[0] >= todayTs) continue;
    const virtualCandle = buildTodayCandleFromLive(live[ticker], todayIsoWib);
    if (!virtualCandle) continue;
    entry.candles.push(virtualCandle);
    augmented++;
  }
  return augmented;
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

// ── Status "approved" yang robust ──────────────────────────────────────────
// Kolom status di Sheet default "pending" (dari form input), owner ubah jadi
// "approved" saat siap tayang. Beberapa hal yang sering bikin baris "hilang":
//   - Spasi tak sengaja: "approved " (trailing space) → dulu tidak match.
//   - Beda kapital: "Approved", "APPROVED" → sudah ditangani lowercase.
//   - Sinonim manual: "acc", "ok", "tayang", "setuju" dsb.
// Kita trim + lowercase + terima daftar sinonim yang jelas bermakna "setujui".
const APPROVED_STATUSES = new Set([
  'approved', 'approve', 'acc', 'ok', 'oke', 'yes', 'ya',
  'setuju', 'disetujui', 'tayang', 'live', 'publish', 'published',
]);
function isApprovedStatus(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return APPROVED_STATUSES.has(v);
}
// Hitung sebaran nilai kolom status (untuk diagnostik "kenapa data sedikit").
function tallyStatus(rows) {
  const out = {};
  for (const r of (rows || [])) {
    const raw = String(r && r.status != null ? r.status : '').trim();
    const key = raw === '' ? '(kosong)' : raw.toLowerCase();
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

// Alasan kenapa sebuah baris DITOLAK normalizeRow (untuk diagnostik).
// Mengikuti aturan validasi yang sama persis dengan normalizeRow().
function normalizeRejectReason(row) {
  if (!row || typeof row !== 'object') return 'baris-kosong';
  const analyst = String(row.analis || '').trim();
  const ticker  = String(row.ticker || '').trim();
  const tipe    = String(row.tipe || 'BUY').trim().toUpperCase();
  const entry   = toNumber(row.entry);
  const tp1     = toNumber(row.tp1);
  const sl      = toNumber(row.sl);
  const firm    = String(row.firm || '').trim();
  const openDate = parseDate(row.tanggal) || parseDate(row.timestamp) || null;
  if (!firm && !analyst) return 'sumber-kosong'; // butuh minimal firm ATAU analis
  if (!ticker)          return 'ticker-kosong';
  if (!openDate)        return 'tanggal-invalid';
  if (entry == null)    return 'entry-kosong';
  if (tp1 == null)      return 'tp1-kosong';
  if (sl == null)       return 'sl-kosong';
  if (tipe === 'BUY'  && (tp1 <= entry || sl >= entry)) return 'arah-BUY-invalid';
  if (tipe === 'SELL' && (tp1 >= entry || sl <= entry)) return 'arah-SELL-invalid';
  return null; // lolos
}

// Breakdown alasan penolakan + ticker yang tidak ada di ohlc (harga live kosong).
function diagnoseRejections(rawRows, ohlc) {
  const reasonCounts = {};
  const samples = [];
  const missingOhlc = {};
  let total = 0;
  for (const row of (rawRows || [])) {
    const reason = normalizeRejectReason(row);
    if (reason) {
      total++;
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      if (samples.length < 10) {
        samples.push({ _row: row._row || null, ticker: row.ticker || '', firm: row.firm || '', analis: row.analis || '', status: row.status || '', reason });
      }
    } else {
      const tk = String(row.ticker || '').trim().toUpperCase().replace(/\.JK$/i, '').replace(/^\$/, '');
      if (tk && ohlc && ohlc.tickers && !ohlc.tickers[tk]) {
        missingOhlc[tk] = (missingOhlc[tk] || 0) + 1;
      }
    }
  }
  return { total, reasonCounts, samples, tickersMissingOhlc: Object.keys(missingOhlc) };
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

// ─────────────────────────────────────────────────────────────────────────
// CANONICAL FIRM NAME — normalisasi nama sekuritas ke daftar resmi IDX
// ─────────────────────────────────────────────────────────────────────────
// Nama sekuritas di Sheet sering di-input tidak konsisten:
//   - "RHB Sekuritas" vs "RHB Sekuritas Indonesia" (harus jadi 1 firm)
//   - "Kay Hian Sekuritas" vs "UOB Kay Hian Sekuritas" (harus jadi 1 firm —
//     nama resmi IDX: "UOB KAY HIAN SEKURITAS")
//   - "PHINTRACO SEKURITAS" vs "Phintraco Sekuritas" (beda case → 1 firm)
//   - "PT Reliance Sekuritas Indonesia Tbk" (PT + Tbk = noise → strip)
//   - "CGS International" vs "CGS International Sekuritas Indonesia" (1 firm)
// Tapi HATI-HATI ada brand-prefix yang MEMBEDAKAN firm:
//   - "Valbury Sekuritas" ≠ "KB Valbury Sekuritas" (KB = distinct brand
//     Korea Investment). Kalau daftar resmi IDX hanya punya "KB VALBURY
//     SEKURITAS", input "Valbury Sekuritas" akan di-merge ke situ karena
//     tidak ada standalone Valbury di daftar IDX (single canonical wins).
//
// STRATEGI DUA-LAPIS:
//   LAPIS 1 (utama) — matchCanonicalFirm(): tokenize input & bandingkan
//     signature-nya dgn daftar resmi 92 sekuritas IDX di public/broker-
//     codes.js. Kalau input token subset canonical (atau vice-versa)
//     setelah drop generic tokens (PT, TBK, SEKURITAS, INDONESIA, dsb),
//     input di-normalize ke canonical name.
//   LAPIS 2 (fallback) — regex strip generic suffix/prefix untuk nama-
//     nama yg belum ada di broker-codes.js. Menjaga fitur existing
//     ("RHB Sekuritas" ≡ "RHB Sekuritas Indonesia" via fuzzy strip).
//
// KENAPA broker-codes.js jadi SoT: user maintain daftar itu secara
// eksplisit (92 broker per Jul 2026). Tiap nambah broker baru cukup edit
// public/broker-codes.js — build-tracker.js otomatis parse ulang tiap
// build via loadBrokerList().
// ─────────────────────────────────────────────────────────────────────────

// Generic tokens yg di-strip saat build signature. Semua UPPERCASE.
const _FIRM_GENERIC_TOKENS = new Set([
  'PT', 'TBK', 'SEKURITAS', 'SECURITIES',
  'INDONESIA', 'ASIA', 'INTERNATIONAL', 'INTL',
  'AND', 'OF', 'THE',
]);

function _firmSignatureTokens(name) {
  if (!name) return [];
  const raw = String(name)
    // CamelCase split: "IndoPremier" → "Indo Premier", "JPMorgan" stays
    // (semua kapital berturut-turut tetap 1 token). Regex ini insert space
    // hanya di boundary lowercase→UPPERCASE, jadi "JPMorgan" tetap utuh.
    // Efek: user yg tulis "IndoPremier Sekuritas" akan match sama dgn
    // "Indo Premier Sekuritas" di leaderboard.
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[.,()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(t => t && !_FIRM_GENERIC_TOKENS.has(t));
  // Merge consecutive single-letter tokens jadi 1 acronym string. Ini
  // menormalkan dot-abbreviation dgn versi tanpa titiknya, mis.
  //   "J.P. Morgan"  → ["J", "P", "MORGAN"] → ["JP", "MORGAN"]
  //   "JP Morgan"    → ["JP", "MORGAN"]     → ["JP", "MORGAN"]  (already merged)
  //   "H.S.B.C."     → ["H","S","B","C"]    → ["HSBC"]
  // Hasilnya matchCanonicalFirm konsisten mengabaikan format titik.
  const merged = [];
  let acc = '';
  for (const t of raw) {
    if (t.length === 1 && /^[A-Z]$/.test(t)) {
      acc += t;
    } else {
      if (acc) { merged.push(acc); acc = ''; }
      merged.push(t);
    }
  }
  if (acc) merged.push(acc);
  return merged;
}

// Kata pendek yg kebetulan proper noun (bukan singkatan) — jangan
// di-uppercase saat title-casing. Add token baru kalau nemu proper
// noun ≤3 huruf yg salah ter-uppercase.
const _PROPER_NOUN_SHORT = new Set(['KAY']);

// Display override — token yg heuristic auto-title-case menghasilkan
// output tidak natural. Format: UPPERCASE_TOKEN → desired display.
// Punctuation di token asli (mis. 'TBK.') di-preserve otomatis.
//
// Kategori:
//   - Brand acronym 4-huruf yg heuristic gagal deteksi (ada vokal):
//     OCBC, HSBC, CIMB, CLSA, BNPP.
//   - Preposition di title-style (Indonesia/Inggris): AND, OF, THE
//     → lowercase.
//   - Konvensi Indonesia: TBK → 'Tbk' (bukan 'TBK'), PT tetap 'PT'.
//
// Add token baru kalau muncul di broker-codes.js dan salah render.
const _FORCE_DISPLAY = new Map([
  // 4-letter brand acronyms (dgn vokal) — heuristic default salah
  ['OCBC', 'OCBC'],
  ['HSBC', 'HSBC'],
  ['CIMB', 'CIMB'],
  ['CLSA', 'CLSA'],
  ['BNPP', 'BNPP'],
  // Prepositions — lowercase di title style
  ['AND',  'and'],
  ['OF',   'of'],
  ['THE',  'the'],
  // Indonesian conventions
  ['PT',   'PT'],
  ['TBK',  'Tbk'],
]);

// Heuristik apakah sebuah token seharusnya UPPERCASE (acronym/brand).
//   1. Ada di _PROPER_NOUN_SHORT → title-case (KAY → Kay)
//   2. Panjang ≤2 → acronym (KB, PT, JP)
//   3. Panjang 3 → acronym (UOB, OSO, UBS, RHB, MNC, KGI, dsb.)
//      Note: length-3 tokens dgn vokal tetap dianggap acronym karena di
//      broker-codes.js semua 3-letter tokens = brand acronym (KAY
//      excluded via _PROPER_NOUN_SHORT).
//   4. Tidak ada vokal → acronym (HSBC, RHB, DBS — safety net)
//   5. Else → kata biasa
function _isAcronymToken(token) {
  if (!token) return false;
  const t = String(token).toUpperCase();
  if (_PROPER_NOUN_SHORT.has(t)) return false;
  if (t.length <= 2) return true;
  if (t.length === 3) return true;
  if (!/[AEIOUY]/.test(t)) return true;
  return false;
}

// Title-case brand-safe untuk canonical name. Rules ordered:
//   1. _FORCE_DISPLAY override (OCBC, HSBC, AND, TBK, dsb.) — WINS
//   2. Dot-abbreviation "J.P." → UPPERCASE penuh
//   3. _isAcronymToken → UPPERCASE
//   4. Default → Title-case
// Punctuation di token asli (mis. 'TBK.', 'J.P.') di-preserve.
function _titleCaseFirmName(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .split(/\s+/)
    .map(w => {
      if (!w) return '';
      const wu = w.toUpperCase();
      const wuAlpha = wu.replace(/[^A-Z]/g, '');
      // Force display override — WINS. Preserve trailing punctuation
      // (mis. "TBK." → "Tbk.").
      if (wuAlpha && _FORCE_DISPLAY.has(wuAlpha)) {
        const forced = _FORCE_DISPLAY.get(wuAlpha);
        const trailing = wu.slice(wuAlpha.length);
        return forced + trailing;
      }
      // Dot-abbreviation (J.P., H.S.B.C.) → UPPERCASE penuh
      if (/^[a-z](\.[a-z])+\.?$/i.test(w)) return wu;
      // Heuristic acronym check
      if (_isAcronymToken(wuAlpha || wu)) return wu;
      // Default: title case (preserve non-alpha as-is)
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

// Load daftar resmi broker dari public/broker-codes.js. File itu adalah
// JS browser dgn IIFE — kita extract array LIST via regex + eval sandbox
// (`new Function` — aman karena file di repo sendiri). Return array nama
// broker uppercase (persis dari LIST[].name).
//
// Dipanggil sekali per build (lazy singleton via _canonicalBrokerCache).
let _canonicalBrokerCache = null;
function _loadCanonicalBrokers() {
  if (_canonicalBrokerCache !== null) return _canonicalBrokerCache;
  const brokerCodesPath = path.join(ROOT, 'public', 'broker-codes.js');
  if (!fs.existsSync(brokerCodesPath)) {
    console.warn('  ⚠ public/broker-codes.js tidak ada — canonical firm merge disabled.');
    _canonicalBrokerCache = [];
    return _canonicalBrokerCache;
  }
  try {
    const src = fs.readFileSync(brokerCodesPath, 'utf8');
    // Match: `var LIST = [ ... ];` — greedy dot to allow multi-line array
    const m = src.match(/var\s+LIST\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) {
      console.warn('  ⚠ broker-codes.js: pattern LIST array tidak ditemukan.');
      _canonicalBrokerCache = [];
      return _canonicalBrokerCache;
    }
    // Eval sandbox: `new Function` tidak akses closure di sini, hanya
    // literal object/array. Aman utk data yang kita kontrol.
    const list = new Function('return ' + m[1])();
    if (!Array.isArray(list)) {
      _canonicalBrokerCache = [];
      return _canonicalBrokerCache;
    }
    _canonicalBrokerCache = list
      .map(b => b && b.name ? String(b.name).trim() : null)
      .filter(Boolean);
    console.log(`  ✓ Loaded ${_canonicalBrokerCache.length} canonical broker names dari broker-codes.js`);
    return _canonicalBrokerCache;
  } catch (e) {
    console.warn('  ⚠ Gagal parse broker-codes.js:', e.message);
    _canonicalBrokerCache = [];
    return _canonicalBrokerCache;
  }
}

// Cache signature per broker (Set of tokens) supaya matchCanonicalFirm
// tidak re-tokenize tiap panggil (dipanggil O(recs) kali).
let _canonicalSigCache = null;
function _getCanonicalSigs() {
  if (_canonicalSigCache) return _canonicalSigCache;
  const brokers = _loadCanonicalBrokers();
  _canonicalSigCache = brokers.map(name => ({
    name,
    sig: new Set(_firmSignatureTokens(name)),
  }));
  return _canonicalSigCache;
}

// "INDO PREMIER" ⇒ "INDOPREMIER". Dipakai fallback saat token subset
// match gagal krn input concat total tanpa capital (mis. "Indopremier"
// yg camelCase regex tidak bisa split).
function _firmSpaceless(name) {
  return _firmSignatureTokens(name).join('');
}

// Cocokkan nama firm dari sheet ke daftar resmi. Return canonical name
// (UPPERCASE dari broker-codes.js) atau null kalau tidak ada match.
//
// Algoritma 2-lapis:
//   LAPIS 1 — Token subset match:
//     Hitung inputSig (Set tokens setelah drop generic tokens). Match
//     bila input ⊆ canonical ATAU canonical ⊆ input. Multi-match
//     tie-break by listCov (spesifisitas) lalu sig.size (deskriptif).
//     Contoh: 'Kay Hian' tokens {KAY,HIAN} ⊆ {UOB,KAY,HIAN} → MATCH.
//
//   LAPIS 2 — Spaceless match (fallback):
//     Kalau LAPIS 1 tidak match, coba compare spaceless string.
//     Menangani ejaan concat tanpa capital yg tokenizer tidak bisa split.
//     Contoh: 'Indopremier' spaceless = 'INDOPREMIER',
//             'INDO PREMIER' spaceless = 'INDOPREMIER' → MATCH.
function matchCanonicalFirm(inputName) {
  const inputTokens = _firmSignatureTokens(inputName);
  if (!inputTokens.length) return null;
  const inputSig = new Set(inputTokens);

  const canonicals = _getCanonicalSigs();
  let best = null;
  let bestScore = -Infinity;

  // LAPIS 1: subset match
  for (const { name, sig } of canonicals) {
    if (!sig.size) continue;
    let overlap = 0;
    for (const t of inputSig) if (sig.has(t)) overlap++;
    if (overlap === 0) continue;
    const inputCov = overlap / inputSig.size;
    const listCov  = overlap / sig.size;
    if (inputCov < 1.0 && listCov < 1.0) continue;
    const score = listCov * 100 + inputCov * 10 + sig.size * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  if (best) return best;

  // LAPIS 2: spaceless fallback (safety net untuk concat-tanpa-capital)
  const inputSpaceless = inputTokens.join('');
  if (inputSpaceless.length < 4) return null; // hindari false-positive utk token super pendek
  for (const { name } of canonicals) {
    if (_firmSpaceless(name) === inputSpaceless) return name;
  }
  return null;
}

// Public API — sama dgn versi sebelumnya tapi sekarang canonical-aware.
function canonicalFirmKey(name) {
  if (!name) return '';
  // Prioritas: match ke daftar resmi IDX
  const canon = matchCanonicalFirm(name);
  if (canon) return canon.toUpperCase();
  // Fallback: regex strip lama (biar backward compat & handle firm yg
  // belum ada di broker-codes.js)
  let s = String(name).trim().toUpperCase();
  s = s.replace(/^PT\s+/, '');
  s = s.replace(/[.,]/g, ' ');
  s = s.replace(/\s+TBK$/, '');
  s = s.replace(/\s+SEKURITAS(\s+INDONESIA)?$/, '');
  s = s.replace(/\s+INDONESIA$/, '');
  return s.replace(/\s+/g, ' ').trim();
}
function canonicalFirmDisplay(name) {
  if (!name) return '';
  let s = String(name).trim();
  s = s.replace(/^PT\s+/i, '');
  s = s.replace(/\s+Tbk\.?$/i, '');
  return s.replace(/\s+/g, ' ').trim();
}
function pickBestDisplay(variants) {
  // Prioritas 1: kalau ada varian yg match ke canonical broker-codes.js,
  // pakai title-cased canonical name (source of truth).
  for (const v of (variants || [])) {
    const canon = matchCanonicalFirm(v);
    if (canon) return _titleCaseFirmName(canon);
  }
  // Prioritas 2: fallback lama — pilih varian terbaik dari input user
  // (non-caps, terpanjang, alphabetical).
  const cleaned = Array.from(new Set(
    (variants || []).map(canonicalFirmDisplay).filter(Boolean)
  ));
  if (!cleaned.length) return '';
  cleaned.sort((a, b) => {
    const aAllUp = a === a.toUpperCase() && /[A-Z]/.test(a);
    const bAllUp = b === b.toUpperCase() && /[A-Z]/.test(b);
    if (aAllUp !== bAllUp) return aAllUp ? 1 : -1; // non-caps first
    if (a.length !== b.length) return b.length - a.length; // longer first
    return a.localeCompare(b);
  });
  return cleaned[0];
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
  // Kolom Q sheet (0-based index = 16) → fallback nama analis kalau kosong.
  // Sengaja index-based bukan label-based, karena user bisa saja rename
  // header sheet-nya sewaktu-waktu; posisi kolom stabil.
  const sheetQ      = String((row._cols && row._cols[16] != null) ? row._cols[16] : '').trim();

  // Validasi minimal: (firm ATAU analis), ticker, entry, tp1, sl, openDate WAJIB.
  // FIRM-FIRST: riset AI sering hanya menyebut sekuritas tanpa nama analis —
  // baris seperti itu TETAP valid. Analis = pelengkap/fallback attribution,
  // bukan syarat wajib. (Dulu wajib analis → 21 baris valid ikut terbuang.)
  if ((!firm && !analyst) || !ticker || !openDate || entry == null || tp1 == null || sl == null) return null;
  // Tolak BUY dgn TP <= entry atau SL >= entry (data invalid).
  if (tipe === 'BUY' && (tp1 <= entry || sl >= entry)) return null;
  if (tipe === 'SELL' && (tp1 >= entry || sl <= entry)) return null;

  // Firm-first: kalau kolom firm kosong, pakai nama analis sbg label sumber
  // (fallback). Menjamin leaderboard sekuritas selalu punya label non-kosong.
  const firmLabel = firm || analyst || 'Lainnya';

  return {
    id: `${ticker}-${openDate}-${row._row || row._ts || Math.random().toString(36).slice(2,8)}`,
    _row: row._row || null,
    _ts: row._ts || 0,
    analyst, firm: firmLabel, ticker, type: tipe,
    entry, tp1, tp2, sl, openDate, horizon, horizonDays,
    cert, note, submittedBy, approvedBy, sheetQ,
    verified: !!(cert && !/^-+$/.test(cert)),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 5) DERIVASI STATE 6-STATUS + 3 GAYA EKSEKUSI DARI CANDLES
// ─────────────────────────────────────────────────────────────────────────
// Candle format di ohlc.json: [ts(unix sec), open, high, low, close]
//
// STATE MACHINE (6 status):
//   PENDING          — harga belum pernah sentuh entry, jarak masih wajar
//                      (|distance| <= MISSED_THRESHOLD_PCT), masih dalam horizon.
//   RUNNING_MISSED   — harga kabur >MISSED_THRESHOLD_PCT dari entry tanpa
//                      pernah menyentuhnya. User yang ikuti rekomendasi
//                      dgn limit order TIDAK PERNAH terisi.
//   TRIGGERED        — harga PERNAH menyentuh entry (low<=entry utk BUY;
//                      high>=entry utk SELL) → posisi resmi jalan.
//                      Masih running, belum kena TP/SL.
//   TP_HIT           — sudah TRIGGERED, lalu kena TP1 (single) / TP2 (staged) /
//                      SL trailing setelah TP1 partial.
//   SL_HIT           — sudah TRIGGERED, lalu kena SL sebelum TP1.
//   EXPIRED          — horizon lewat. Bisa dari TRIGGERED (posisi jalan) atau
//                      PENDING (tidak pernah terisi).
//
// 3 GAYA EKSEKUSI (pre-computed di sini, frontend tinggal pakai):
//   pnlPure  → Entry Murni. Hanya ada nilai kalau state !== PENDING &&
//              state !== RUNNING_MISSED (posisi harus pernah triggered).
//   pnlAvg   → Average 1:1. Modal split 50/50: 50% dieksekusi pas OPEN di
//              tanggal publish (openPriceAtPublish), 50% saat harga sentuh
//              entry (fills). Kalau tidak pernah sentuh (MISSED/PENDING),
//              hanya 50% terisi (yang di OPEN) → sisa 50% dianggap 0%.
//   pnlHaka  → Beli di Open (Hajar Kanan). 100% dieksekusi di
//              openPriceAtPublish. Selalu ada nilai (kecuali candle tanggal
//              publish tidak tersedia).
// ─────────────────────────────────────────────────────────────────────────

const MISSED_THRESHOLD_PCT = 5; // %

// Hitung tanggal expiry PENDING = openDate + 10 HARI kalender.
// Contoh: openDate = 2026-07-05 → pendingExpiresAt = 2026-07-15.
//         openDate = 2026-07-25 → pendingExpiresAt = 2026-08-04 (rollover).
// Digunakan untuk cap horizon rekomendasi yang MENUNGGU harga entry
// (PENDING / RUNNING_MISSED). Kalau lewat → auto EXPIRED walau horizon
// aslinya lebih panjang. TRIGGERED (posisi sudah jalan) TIDAK terpengaruh.
//
// Threshold 10 hari (per user request; sebelumnya 1 bulan kalender / ~30 hari).
// Rasional: rekomendasi yang tidak masuk zona entry dalam 10 hari umumnya
// sudah kadaluarsa secara relevansi analisa teknikal (harga sudah drift
// jauh dari kondisi saat rekomendasi dirilis).
const PENDING_EXPIRY_DAYS = 10;

function computePendingExpiry(openDateIso) {
  if (!openDateIso) return null;
  const d = new Date(openDateIso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  // openDate + 10 hari (86400 detik/hari). setUTCDate() auto-rollover ke
  // bulan berikutnya kalau overflow (mis. 25 Jul + 10 hari → 4 Agu).
  const exp = new Date(d.getTime() + PENDING_EXPIRY_DAYS * 86400 * 1000);
  return {
    iso: exp.toISOString().slice(0, 10),
    ts: exp.getTime() / 1000,
  };
}

function derivePosition(rec, ohlcEntry, todayIso) {
  const result = {
    state: 'PENDING',           // baru: state machine
    status: 'PENDING',          // legacy alias (utk backward-compat lama)
    tpHits: [],
    closedBy: null,
    exitDate: null,
    exitPrice: null,
    lastPrice: null,
    lastPriceTime: null,
    barsHeld: 0,
    pnlPct: null,               // legacy = pnlPure atau floating
    result: null,               // WIN | LOSS | NEUTRAL (setelah closed)
    // baru:
    didTouchEntry: false,
    entryTouchDate: null,
    entryTouchPrice: null,
    openPriceAtPublish: null,   // harga OPEN di candle tanggal publish
    distanceToEntryPct: null,   // jarak live vs entry (%) — untuk PENDING/MISSED
    pnlPure: null,              // Entry Murni
    pnlAvg: null,               // Average 1:1
    pnlHaka: null,              // Beli di Open (HAKA)
    // Expiry untuk rekomendasi yg MENUNGGU harga entry: tanggal yg sama
    // bulan berikutnya dari openDate. Rekomendasi yg belum triggered
    // otomatis EXPIRED bila lewat tgl ini (max ~30 hari). Berlaku HANYA
    // untuk state PENDING & RUNNING_MISSED. TRIGGERED pakai horizon asli.
    pendingExpiresAt: null,
  };
  if (!ohlcEntry || !Array.isArray(ohlcEntry.candles) || !ohlcEntry.candles.length) {
    return result;
  }
  const openTs = Date.parse(rec.openDate + 'T00:00:00Z') / 1000;
  const horizonEndTs = openTs + rec.horizonDays * 86400;
  const nowTs = new Date(todayIso + 'T00:00:00Z').getTime() / 1000;
  const isBuy = rec.type === 'BUY';
  const dirSign = isBuy ? 1 : -1;
  const hasT2 = rec.tp2 != null && rec.tp2 !== rec.tp1;

  // Hitung tanggal expiry untuk rekomendasi belum triggered (max 1 bulan).
  const pendingExp = computePendingExpiry(rec.openDate);
  result.pendingExpiresAt = pendingExp ? pendingExp.iso : null;
  // Rekomendasi belum triggered: dianggap kadaluarsa kalau nowTs >= akhir hari
  // dari pendingExpiresAt (jadi tanggal 5 masih hidup sampai akhir tgl 5).
  const pendingExpiryTs = pendingExp ? (pendingExp.ts + 86400) : Infinity;

  const relevant = ohlcEntry.candles.filter(c => c[0] >= openTs);
  const lastCandle = ohlcEntry.candles[ohlcEntry.candles.length - 1];
  if (!lastCandle) return result;
  result.lastPrice = lastCandle[4];
  result.lastPriceTime = new Date(lastCandle[0] * 1000).toISOString();

  // Cari candle tanggal publish (untuk openPriceAtPublish) — bar pertama pada/setelah openTs
  // yang tanggalnya == openDate (same day). Kalau tidak ada, ambil bar pertama >= openTs.
  const publishBar = relevant[0] || null;
  if (publishBar) result.openPriceAtPublish = +publishBar[1];

  // pctAt: P&L (%) dari price `px` vs BASE. Base = fill price kalau
  // triggered (entryTouchPrice), else rec.entry. Ini bikin realized P&L
  // reflect harga fill ASLI — gap-down BUY fill di 180 vs target 192
  // ngasih return yg lebih baik saat exit di TP1. Konsisten dgn user
  // intent: "floating G&L ikut harga open, bukan harga entry".
  const pctAt = (px) => {
    const base = (result.entryTouchPrice != null && result.entryTouchPrice > 0)
                 ? result.entryTouchPrice : rec.entry;
    return ((px - base) / base * 100) * dirSign;
  };
  const pctFromOpen = (px) => result.openPriceAtPublish
    ? ((px - result.openPriceAtPublish) / result.openPriceAtPublish * 100) * dirSign
    : null;

  // Distance live ke entry (sign-aware terhadap direction):
  //   BUY: negatif = harga di bawah entry (siap entry); positif = harga sudah lari naik.
  //   SELL: sebaliknya. Untuk konsistensi kita simpan absolute-signed thd expected direction.
  // Definisi sederhana: (lastPrice - entry) / entry * 100.
  //   BUY dgn distance > 0 = harga masih di atas entry (menunggu turun / atau kabur naik).
  //   BUY dgn distance < 0 = harga sudah di bawah entry (harusnya sudah triggered — kecuali baru saja).
  result.distanceToEntryPct = +(((result.lastPrice - rec.entry) / rec.entry) * 100).toFixed(2);

  // ── Iterasi bar untuk cari:
  //    (1) apakah entry pernah tersentuh (touchDate + touchPrice)
  //    (2) simulasi phase1/phase2 TP/SL setelah triggered
  // Note: bar tanggal publish DIIKUTKAN — kita anggap harga di sesi itu bisa
  // menyentuh entry. Kalau OPEN sudah di bawah entry (BUY), berarti gap-down
  // masuk zona entry → tetap dianggap triggered pada OPEN (touchPrice = min(open, entry)).
  let phase = 'phase1';
  let effectiveSl = rec.sl;
  let realizedPct = 0; // dari partial TP1
  let triggered = false;
  let triggeredIdx = -1;

  // ── LIMIT-only semantic (per user's mental model) ─────────────────────
  // Semua rec diperlakukan sebagai LIMIT order (BUY on dip / SELL on
  // rally), tidak lagi pakai direction inference LIMIT vs STOP.
  //
  // BUY (SL < Entry):
  //   openPx ≤ SL          → TERLEWAT (gap tembus SL, position never opened)
  //   SL < openPx ≤ Entry  → TERISI @open (gap-fill di zona antara SL & Entry)
  //   openPx > Entry, low ≤ Entry → TERISI @Entry (intraday dip fill LIMIT)
  //   openPx > Entry, low > Entry → belum touched, next bar
  //
  // SELL (Entry < SL): mirror.
  //   openPx ≥ SL          → TERLEWAT
  //   Entry ≤ openPx < SL  → TERISI @open (gap-fill)
  //   openPx < Entry, high ≥ Entry → TERISI @Entry (rally fill)
  //
  // KENAPA: analyst recs di sheet mostly LIMIT (buy on dip). Direction
  // inference dari publishOpen sering salah karena openPx ambigu (bisa
  // gap dari close-kemarin, atau intraday). User mental model lebih
  // simple: "harga masuk zona, fill di open kalau gap; nggak fill kalau
  // langsung ke SL area". BUY STOP breakout recs jarang; kalau ada,
  // trade-off (rare) di-accept.
  let missedByGapFlag = false;   // Flag: rec di-skip karena gap tembus SL
  let gapFillOpenPx = null;       // Tracked utk debug (harga open saat gap fill)

  for (let i = 0; i < relevant.length; i++) {
    const c = relevant[i];
    // OPSI B (per user): posisi yang SUDAH kena entry (triggered) TIDAK
    // dibatasi horizon waktu — scan LANJUT ke semua candle sampai kena TP
    // atau SL, berapa lama pun. Batas horizon HANYA berlaku untuk posisi
    // yang BELUM triggered (window deteksi entry = [openDate, horizon]);
    // kalau lewat tanpa pernah kena entry → jatuh ke klasifikasi unfilled
    // (PENDING / MISSED / EXPIRED_UNFILLED) di bawah.
    if (!triggered && c[0] > horizonEndTs) break;
    result.barsHeld++;
    const openPx = c[1], high = c[2], low = c[3], close = c[4], ts = c[0];

    // Cek entry-touch (hanya sekali)
    if (!triggered) {
      let fillPrice = null;
      if (isBuy) {
        if (openPx <= rec.sl) {
          // Gap-open tembus SL → TERLEWAT (permanent, break loop).
          missedByGapFlag = true;
          break;
        } else if (openPx <= rec.entry) {
          // Gap-fill di [SL, Entry] zone → fill @open (better than entry).
          fillPrice = +openPx;
          gapFillOpenPx = +openPx;
        } else if (low <= rec.entry) {
          // openPx > Entry, tapi intraday dip ke Entry → LIMIT fill @Entry.
          fillPrice = +rec.entry;
        }
      } else {
        // SELL — mirror
        if (openPx >= rec.sl) {
          missedByGapFlag = true;
          break;
        } else if (openPx >= rec.entry) {
          fillPrice = +openPx;
          gapFillOpenPx = +openPx;
        } else if (high >= rec.entry) {
          fillPrice = +rec.entry;
        }
      }

      if (fillPrice != null) {
        triggered = true;
        triggeredIdx = i;
        result.didTouchEntry = true;
        result.entryTouchDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.entryTouchPrice = fillPrice;
      }
    }

    // Kalau belum triggered → lanjut ke bar berikutnya (jangan cek TP/SL)
    if (!triggered) continue;

    // ── SL: CLOSE-based (wick tolerance) — per user preference ──
    // SL hanya trigger kalau CLOSE menembus SL. Wick intraday yg cuma
    // nyentuh SL lalu bounce balik TIDAK dianggap stop out. Alasan:
    //   1. Daily tracker: wick sering data noise (Yahoo tick) atau
    //      false-break yang bounce cepat.
    //   2. User's mental model: 'kalau close di atas SL lagi, position
    //      still valid, harga hanya wick sebentar'.
    // Contoh BUMI 24 Jul: [o=180 h=183 l=168 c=171]. low=168=SL exactly,
    // tapi close=171 > SL → position stays AKTIF (bukan SL_HIT).
    //
    // TP: TETAP intraday-inclusive (high >= tp1 utk BUY). TP = 'take
    // profit', analyst set target — kalau harga sempat nyentuh target,
    // dianggap LIMIT sell/buy sudah execute.
    const slHit = isBuy ? (close <= effectiveSl) : (close >= effectiveSl);
    const tp1Hit = isBuy ? high >= rec.tp1 : low <= rec.tp1;
    const tp2Hit = hasT2 && (isBuy ? high >= rec.tp2 : low <= rec.tp2);

    // Jangan pakai SL di bar yang sama saat baru triggered kalau OPEN sudah di luar SL
    // (fill terjadi di harga entry, langsung SL di bar yg sama = LOSS penuh — tapi
    // kita perbolehkan).

    if (phase === 'phase1') {
      if (slHit && !tp1Hit) {
        result.state = 'SL_HIT';
        result.status = 'SL_HIT';
        result.closedBy = 'SL';
        result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.exitPrice = effectiveSl;
        result.pnlPure = pctAt(effectiveSl);
        result.result = 'LOSS';
        break;
      }
      if (tp1Hit && !hasT2) {
        result.state = 'TP_HIT';
        result.status = 'TP_HIT';
        result.tpHits = ['TP1'];
        result.closedBy = 'TP1';
        result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.exitPrice = rec.tp1;
        result.pnlPure = pctAt(rec.tp1);
        result.result = 'WIN';
        break;
      }
      if (tp1Hit && hasT2) {
        if (tp2Hit) {
          realizedPct = pctAt(rec.tp1) * 0.5 + pctAt(rec.tp2) * 0.5;
          result.tpHits = ['TP1', 'TP2'];
          result.state = 'TP_HIT';
          result.status = 'TP_HIT';
          result.closedBy = 'TP2';
          result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
          result.exitPrice = rec.tp2;
          result.pnlPure = realizedPct;
          result.result = 'WIN';
          break;
        }
        realizedPct += pctAt(rec.tp1) * 0.5;
        result.tpHits.push('TP1');
        effectiveSl = rec.entry;
        phase = 'phase2';
        continue;
      }
    } else {
      // phase2 (setelah TP1 partial)
      if (tp2Hit) {
        realizedPct += pctAt(rec.tp2) * 0.5;
        result.tpHits.push('TP2');
        result.state = 'TP_HIT';
        result.status = 'TP_HIT';
        result.closedBy = 'TP2';
        result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.exitPrice = rec.tp2;
        result.pnlPure = realizedPct;
        result.result = 'WIN';
        break;
      }
      if (slHit) {
        result.state = 'TP_HIT';
        result.status = 'TP_HIT';
        result.closedBy = 'SL_TRAIL';
        result.exitDate = new Date(ts * 1000).toISOString().slice(0, 10);
        result.exitPrice = rec.entry;
        result.pnlPure = realizedPct;
        result.result = realizedPct > 0.1 ? 'WIN' : 'NEUTRAL';
        break;
      }
    }
  }

  // ── Belum exit: klasifikasikan state ──
  if (!result.exitDate) {
    if (triggered) {
      // OPSI B (per user): posisi SUDAH kena entry tapi belum kena TP/SL →
      // TETAP TRIGGERED (aktif/floating) TANPA batas waktu. Tidak pernah
      // di-EXPIRE oleh horizon — ia jalan terus sampai benar-benar kena TP
      // atau SL. (Dulu: lewat horizon → EXPIRED filled, ditutup paksa di
      // harga pasar. Perilaku itu dihapus sesuai permintaan user.)
      result.state = 'TRIGGERED';
      result.status = 'OPEN'; // legacy alias
      const floatPct = pctAt(result.lastPrice);
      result.pnlPure = phase === 'phase2' ? (realizedPct + floatPct * 0.5) : floatPct;
    } else {
      // Belum triggered — PENDING vs RUNNING_MISSED (gap/drift) vs EXPIRED_UNFILLED
      const dist = Math.abs(result.distanceToEntryPct || 0);
      // Kalau di loop tadi gap-tembus-SL terjadi (missedByGapFlag), rec
      // ini langsung TERLEWAT — nggak peduli expiry atau drift threshold.
      if (missedByGapFlag) {
        result.state = 'RUNNING_MISSED';
        result.status = 'MISSED';
        // Optional: bisa tambah result.missedReason = 'gap_through_sl' di sini
        // kalau nanti UI mau distinguish gap-missed vs drift-missed.
      } else {
      // Arah kabur (drift-missed) — LIMIT-only semantic:
      //   BUY  → kabur naik: lastPrice > entry & jauh
      //   SELL → kabur turun: lastPrice < entry & jauh
      const awayFromEntry = isBuy
        ? (result.lastPrice - rec.entry > 0)
        : (rec.entry - result.lastPrice > 0);
      const missed = awayFromEntry && dist > MISSED_THRESHOLD_PCT;
      // Cap expiry rekomendasi belum triggered: min(horizon asli, 1 bulan
      // dari openDate). Ini memaksa semua rekomendasi "menunggu entry"
      // maksimum ~30 hari (1 bulan kalender). Konsisten dgn permintaan
      // user: kalau rekom tgl 5 → expired tgl 5 bulan berikutnya.
      const effectiveExpiryTs = Math.min(horizonEndTs, pendingExpiryTs);
      if (nowTs > effectiveExpiryTs) {
        // EXPIRED tanpa pernah triggered → tidak ada posisi Pure sama sekali.
        result.state = 'EXPIRED';
        result.status = 'EXPIRED';
        result.closedBy = 'EXPIRED_UNFILLED';
        const inHorizon = relevant.filter(c => c[0] <= effectiveExpiryTs);
        const exitCandle = inHorizon.length ? inHorizon[inHorizon.length - 1] : lastCandle;
        result.exitDate = new Date(exitCandle[0] * 1000).toISOString().slice(0, 10);
        result.exitPrice = exitCandle[4];
        result.pnlPure = null; // Pure tidak triggered
        result.result = null;
      } else if (missed) {
        result.state = 'RUNNING_MISSED';
        result.status = 'MISSED';
      } else {
        result.state = 'PENDING';
        result.status = 'PENDING';
      }
      }
    }
  }

  // ── Hitung pnlAvg & pnlHaka ──
  // pnlHaka: harga sekarang / exit vs openPriceAtPublish. Selalu ada (kalau openPx ada).
  const referencePx = result.exitPrice != null ? result.exitPrice : result.lastPrice;
  if (result.openPriceAtPublish != null && referencePx != null) {
    result.pnlHaka = +(((referencePx - result.openPriceAtPublish) / result.openPriceAtPublish) * 100 * dirSign).toFixed(2);
  }

  // pnlAvg (Average 1:1): 50% at OPEN price + 50% at entry (kalau triggered) else 50% x0 (unfilled).
  //   Kalau state = TP_HIT / SL_HIT → sisa 50% exit di harga yang sama (asumsi close full di exit).
  //   Kalau state = TRIGGERED → 50% at open (floating) + 50% at entry (floating), keduanya vs lastPrice.
  //   Kalau state = PENDING / MISSED → hanya 50% at open (floating), sisa 50% belum terisi = 0.
  //   Kalau state = EXPIRED unfilled → sisa 50% belum terisi = 0. Kalau EXPIRED filled → normal.
  if (result.openPriceAtPublish != null) {
    const openPx = result.openPriceAtPublish;
    let leg1 = 0, leg2 = 0;
    if (result.state === 'TP_HIT' || result.state === 'SL_HIT') {
      // Full close di exit
      leg1 = ((result.exitPrice - openPx) / openPx) * 100 * dirSign;
      leg2 = ((result.exitPrice - rec.entry) / rec.entry) * 100 * dirSign;
      result.pnlAvg = +((leg1 + leg2) / 2).toFixed(2);
    } else if (result.state === 'EXPIRED') {
      if (result.didTouchEntry) {
        leg1 = ((result.exitPrice - openPx) / openPx) * 100 * dirSign;
        leg2 = ((result.exitPrice - rec.entry) / rec.entry) * 100 * dirSign;
        result.pnlAvg = +((leg1 + leg2) / 2).toFixed(2);
      } else {
        // Hanya leg1 terisi
        leg1 = ((result.exitPrice - openPx) / openPx) * 100 * dirSign;
        result.pnlAvg = +(leg1 / 2).toFixed(2);
      }
    } else if (result.state === 'TRIGGERED') {
      leg1 = ((result.lastPrice - openPx) / openPx) * 100 * dirSign;
      leg2 = ((result.lastPrice - rec.entry) / rec.entry) * 100 * dirSign;
      result.pnlAvg = +((leg1 + leg2) / 2).toFixed(2);
    } else {
      // PENDING / RUNNING_MISSED: hanya leg1 floating
      leg1 = ((result.lastPrice - openPx) / openPx) * 100 * dirSign;
      result.pnlAvg = +(leg1 / 2).toFixed(2);
    }
  }

  // pnlPct legacy alias: untuk PENDING/MISSED tetap null.
  if (result.pnlPure != null) result.pnlPure = +result.pnlPure.toFixed(2);
  result.pnlPct = result.pnlPure;

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
  return {
    trades: 0, wins: 0, losses: 0, neutral: 0,
    sumPnl: 0,               // = sumPure (legacy)
    sumPure: 0, cntPure: 0,  // Entry Murni (butuh triggered)
    sumAvg: 0,  cntAvg: 0,   // Average 1:1
    sumHaka: 0, cntHaka: 0,  // Beli di Open (HAKA)
    bestPct: -Infinity, worstPct: Infinity,
  };
}
function acc(agg, rec) {
  agg.trades++;
  if (rec.result === 'WIN') agg.wins++;
  else if (rec.result === 'LOSS') agg.losses++;
  else agg.neutral++;
  const pnl = rec.pnlPct || 0;
  agg.sumPnl += pnl;
  if (rec.pnlPure != null)  { agg.sumPure += rec.pnlPure;  agg.cntPure++; }
  if (rec.pnlAvg  != null)  { agg.sumAvg  += rec.pnlAvg;   agg.cntAvg++;  }
  if (rec.pnlHaka != null)  { agg.sumHaka += rec.pnlHaka;  agg.cntHaka++; }
  if (pnl > agg.bestPct) agg.bestPct = pnl;
  if (pnl < agg.worstPct) agg.worstPct = pnl;
}
function summary(agg) {
  const totalNonNeutral = agg.wins + agg.losses;
  const wr = totalNonNeutral ? +(agg.wins / totalNonNeutral * 100).toFixed(1) : 0;
  return {
    trades: agg.trades, wins: agg.wins, losses: agg.losses, neutral: agg.neutral,
    winrate: wr,
    net: +agg.sumPnl.toFixed(2),
    netPure: +agg.sumPure.toFixed(2),
    netAvg:  +agg.sumAvg.toFixed(2),
    netHaka: +agg.sumHaka.toFixed(2),
    cntPure: agg.cntPure, cntAvg: agg.cntAvg, cntHaka: agg.cntHaka,
    avg: agg.trades ? +(agg.sumPnl / agg.trades).toFixed(2) : 0,
    avgPure: agg.cntPure ? +(agg.sumPure / agg.cntPure).toFixed(2) : 0,
    avgAvg:  agg.cntAvg  ? +(agg.sumAvg  / agg.cntAvg).toFixed(2)  : 0,
    avgHaka: agg.cntHaka ? +(agg.sumHaka / agg.cntHaka).toFixed(2) : 0,
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
    if (!byAnalyst.has(aId))  byAnalyst.set(aId, { id: aId, name: rec.analyst, firm: rec.firm, firmId: fId, cert: rec.cert, verified: rec.verified, sheetQ: rec.sheetQ || '', agg: initAgg() });
    else if (!byAnalyst.get(aId).sheetQ && rec.sheetQ) byAnalyst.get(aId).sheetQ = rec.sheetQ;
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
  const sheet = await fetchSheetRows();
  const history = loadTrackerHistory();
  const ohlc = loadOhlc();
  const screening = loadScreening();

  // ── Merge tracker-history.json (arsip kumulatif) ke sheet.items ──
  // Sheet menang saat identity conflict — user tetap bisa koreksi rec
  // dgn edit langsung di sheet (arsip diabaikan utk key ybs). Baris arsip
  // yg TIDAK ada di sheet → di-append. Efek: setelah user wipe sheet tgl 1,
  // build tetap bisa render historyList lengkap + derive state fresh utk
  // rec aktif yg ter-arsip.
  if (history.items.length) {
    const sheetKeys = new Set((sheet.items || []).map(stableItemKey));
    const historyOnly = history.items.filter(item => {
      const k = stableItemKey(item);
      return k && !sheetKeys.has(k);
    });
    console.log(`  ✓ Tracker history: sheet=${(sheet.items||[]).length}, archive=${history.items.length}, appendFromArchive=${historyOnly.length}`);
    if (sheet.items) {
      sheet.items = [...sheet.items, ...historyOnly];
    } else {
      sheet.items = historyOnly;
    }
  } else {
    console.log('  ℹ tracker-history.json belum ada / kosong — build hanya dari sheet.');
  }

  // ── Live overlay: inject virtual today candle ke ohlc in-memory ──
  // Supaya rec yg rilis hari ini bisa berpindah state PENDING → TRIGGERED /
  // SL_HIT / TP_HIT langsung di tracker.json (bukan cuma overlay klien-side).
  // Sumber tercepat: sheet Live via gviz (public read, zero auth).
  try {
    const live = await fetchLiveMap();
    // Enrich Worker map dgn intraday state dari data.json (akumulasi 5-min).
    // Kalau enrich gagal / data.json belum ada → buildTodayCandleFromLive
    // fallback ke single-point (aman, tidak span palsu).
    const intradayFromData = _readIntradayFromDataJson();
    const enriched = _enrichLiveWithIntraday(live, intradayFromData);
    if (enriched > 0) {
      console.log(`  ✓ Enrich live dgn intraday state dari data.json: ${enriched} ticker`);
    }
    const n = augmentOhlcWithLive(ohlc, live);
    if (n > 0) console.log(`  ✓ Live overlay: ${n} ticker di-augment dgn virtual today candle`);
  } catch (e) {
    console.warn('  ⚠ Live overlay gagal (non-fatal):', e.message);
  }

  let ihsgSeries = null;
  try { ihsgSeries = await fetchIhsgDaily(); }
  catch (e) { console.warn('  ⚠ ihsg fetch throw:', e.message); }

  // Kalau sheet gagal & sebelumnya belum ada file → tulis pending saja.
  if (!sheet.ok && sheet.reason === 'no-credentials') {
    const payload = pendingPayload(todayIso, 'no-credentials',
      'TRACKER_SHEET_ID belum di-set di GitHub Secrets. Set SHEET_ID + share sheet ke "Anyone with the link → Viewer" lalu re-run workflow.',
      ihsgSeries);
    writeOut(payload);
    return;
  }
  if (!sheet.ok) {
    // Fetch gagal tapi ada file lama → PRESERVE
    if (prev && !prev.pending) {
      console.warn('  ⚠ Sheet fetch gagal, PERTAHANKAN tracker.json lama.');
      prev.staleAt = new Date().toISOString();
      prev.sheetError = sheet.error || sheet.reason;
      writeOut(prev);
      return;
    }
    const payload = pendingPayload(todayIso, sheet.reason,
      'Sheet fetch gagal (kemungkinan besar: sheet belum di-share public, atau SHEET_ID salah). ' + (sheet.error || ''),
      ihsgSeries);
    writeOut(payload);
    return;
  }

  // Normalisasi rows
  const recsRaw = (sheet.items || []).map(normalizeRow).filter(Boolean);
  console.log(`  normalized ${recsRaw.length}/${(sheet.items||[]).length} rows`);

  // ── Canonical firm merge: gabungkan varian nama sekuritas yg
  //    seharusnya 1 firm (mis. "RHB Sekuritas" + "RHB Sekuritas Indonesia"
  //    → 1 firm). Prefix brand (KB Valbury vs Valbury) tetap terpisah.
  //    Setelah rewrite, idOf(rec.firm) otomatis produce firmId yg sama
  //    untuk semua varian → aggregation menyatu dengan sendirinya.
  const firmVariantsByKey = new Map();
  for (const rec of recsRaw) {
    const key = canonicalFirmKey(rec.firm);
    if (!key) continue;
    if (!firmVariantsByKey.has(key)) firmVariantsByKey.set(key, new Set());
    firmVariantsByKey.get(key).add(rec.firm);
  }
  const firmDisplayByKey = new Map();
  for (const [key, variants] of firmVariantsByKey) {
    firmDisplayByKey.set(key, pickBestDisplay([...variants]));
  }
  let firmMergeLogged = false;
  const mergeSummary = [];
  for (const [key, variants] of firmVariantsByKey) {
    if (variants.size > 1) {
      const arr = [...variants];
      const chosen = firmDisplayByKey.get(key);
      mergeSummary.push(`    ${chosen}  ⇐  [${arr.join(' | ')}]`);
      firmMergeLogged = true;
    }
  }
  if (firmMergeLogged) {
    console.log('  ✓ Firm canonical merge:');
    mergeSummary.forEach(s => console.log(s));
  }
  // Rewrite rec.firm ke display kanonik
  for (const rec of recsRaw) {
    const key = canonicalFirmKey(rec.firm);
    const disp = firmDisplayByKey.get(key);
    if (disp) rec.firm = disp;
  }

  // Diagnostik: kenapa baris ditolak + ticker tanpa harga (ohlc).
  const rejectDiag = diagnoseRejections(sheet.items || [], ohlc);
  if (rejectDiag.total) {
    console.log('  ⚠ ditolak normalize:', rejectDiag.total, JSON.stringify(rejectDiag.reasonCounts));
  }
  if (rejectDiag.tickersMissingOhlc.length) {
    console.log('  ⚠ ticker tanpa harga ohlc:', rejectDiag.tickersMissingOhlc.join(', '));
  }
  const diag = {
    sheetTotalRows: sheet.allCount != null ? sheet.allCount : (sheet.items || []).length,
    approvedRows: (sheet.items || []).length,
    statusBreakdown: sheet.statusCounts || {},
    normalizedOk: recsRaw.length,
    rejectedRows: rejectDiag.total,
    rejectReasonCounts: rejectDiag.reasonCounts,
    rejectSamples: rejectDiag.samples,
    tickersMissingOhlc: rejectDiag.tickersMissingOhlc,
  };

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

  // Split berdasarkan state baru:
  //   active   = TRIGGERED (posisi jalan, floating live)
  //   pending  = PENDING (belum sentuh entry, masih menunggu)
  //   missed   = RUNNING_MISSED (harga kabur, entry tidak akan terisi)
  //   closed   = TP_HIT / SL_HIT / EXPIRED
  const active  = recs.filter(r => r.state === 'TRIGGERED');
  const pending = recs.filter(r => r.state === 'PENDING');
  const missed  = recs.filter(r => r.state === 'RUNNING_MISSED');
  const closed  = recs.filter(r => r.state === 'TP_HIT' || r.state === 'SL_HIT' || r.state === 'EXPIRED');
  const unfilled = [...pending, ...missed]; // gabungan untuk display
  console.log(`  ${active.length} triggered + ${pending.length} pending + ${missed.length} missed + ${closed.length} closed`);

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

  // byFirm sekarang dilengkapi list rekomendasi + analyst names + 3 gaya eksekusi
  const firmMap = new Map(); // fId -> obj
  for (const [fId, f] of byFirm) {
    const summ = summary(f.agg);
    firmMap.set(fId, {
      id: fId, name: f.name, verified: f.verified,
      trades: summ.trades, wins: summ.wins, losses: summ.losses, neutral: summ.neutral,
      winrate: summ.winrate,
      net: summ.net,
      netPure: summ.netPure, netAvg: summ.netAvg, netHaka: summ.netHaka,
      cntPure: summ.cntPure, cntAvg: summ.cntAvg, cntHaka: summ.cntHaka,
      avg: summ.avg, avgPure: summ.avgPure, avgAvg: summ.avgAvg, avgHaka: summ.avgHaka,
      best: summ.best, worst: summ.worst,
      alpha: 0, // diisi setelah IHSG dihitung
      analysts: [], recsActive: [], recsPending: [], recsMissed: [],
      recsHistory: [], watchlist: [], sectorFocus: [], highScore: 0,
    });
  }
  // Tambah firm dari active/pending/missed (yg belum punya trade closed)
  for (const rec of [...active, ...pending, ...missed]) {
    const fId = idOf(rec.firm);
    if (!firmMap.has(fId)) {
      firmMap.set(fId, {
        id: fId, name: rec.firm, verified: rec.verified,
        trades: 0, wins: 0, losses: 0, neutral: 0,
        winrate: 0,
        net: 0, netPure: 0, netAvg: 0, netHaka: 0,
        cntPure: 0, cntAvg: 0, cntHaka: 0,
        avg: 0, avgPure: 0, avgAvg: 0, avgHaka: 0,
        best: 0, worst: 0, alpha: 0,
        analysts: [], recsActive: [], recsPending: [], recsMissed: [],
        recsHistory: [], watchlist: [], sectorFocus: [], highScore: 0,
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
      sheetQ: a.sheetQ || '',
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
        sheetQ: rec.sheetQ || '',
        trades: 0, winrate: 0, net: 0, avg: 0,
      });
    } else if (!analystObjMap.get(aid).sheetQ && rec.sheetQ) {
      analystObjMap.get(aid).sheetQ = rec.sheetQ;
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
  for (const rec of pending) {
    const fId = idOf(rec.firm);
    const f = firmMap.get(fId);
    if (f) {
      f.recsPending.push(makeRecActiveObj(rec));
      if (!f.watchlist.includes(rec.ticker)) f.watchlist.push(rec.ticker);
      if (rec.sector && !f.sectorFocus.includes(rec.sector)) f.sectorFocus.push(rec.sector);
      if ((rec.score || 0) > f.highScore) f.highScore = rec.score;
    }
  }
  for (const rec of missed) {
    const fId = idOf(rec.firm);
    const f = firmMap.get(fId);
    if (f) {
      f.recsMissed.push(makeRecActiveObj(rec));
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

  // IHSG snapshot + kalkulasi return per periode
  let ihsgObj = null;
  let ihsgReturnByDate = null; // { openDate -> ihsg%change dari openDate ke exitDate/today }
  if (ihsgSeries && ihsgSeries.length) {
    const last = ihsgSeries[ihsgSeries.length - 1];
    const prevDay = ihsgSeries.length > 1 ? ihsgSeries[ihsgSeries.length - 2].close : last.open;
    const chgPct = prevDay ? +(((last.close - prevDay) / prevDay) * 100).toFixed(2) : 0;
    // Full series (sampai 3 bulan) — untuk lookup periode custom
    ihsgObj = {
      last: +last.close.toFixed(2),
      chgPct,
      date: last.date,
      series30d: ihsgSeries.slice(-30).map(d => ({ date: d.date, close: +d.close.toFixed(2) })),
      seriesFull: ihsgSeries.map(d => ({ date: d.date, close: +d.close.toFixed(2) })),
    };
    // Buat helper cepat: index by date untuk lookup
    ihsgReturnByDate = new Map();
    for (const d of ihsgSeries) ihsgReturnByDate.set(d.date, d.close);
  } else if (prev && prev.ihsg) {
    ihsgObj = prev.ihsg;
    if (prev.ihsg.seriesFull) {
      ihsgReturnByDate = new Map();
      for (const d of prev.ihsg.seriesFull) ihsgReturnByDate.set(d.date, d.close);
    }
  }

  // Helper: return IHSG dari openDate ke exitDate/today (%)
  //   Ambil close terdekat SEBELUM/PADA tanggal itu (kalau hari libur, pakai bar sebelumnya).
  function ihsgReturnBetween(openDate, exitDate) {
    if (!ihsgReturnByDate || !ihsgReturnByDate.size) return null;
    const sortedDates = [...ihsgReturnByDate.keys()].sort();
    const findClose = (target) => {
      if (!target) return null;
      if (ihsgReturnByDate.has(target)) return ihsgReturnByDate.get(target);
      // Cari yang <= target (paling recent sebelumnya)
      for (let i = sortedDates.length - 1; i >= 0; i--) {
        if (sortedDates[i] <= target) return ihsgReturnByDate.get(sortedDates[i]);
      }
      return null;
    };
    const startClose = findClose(openDate);
    const endClose = findClose(exitDate || todayIso);
    if (startClose == null || endClose == null || startClose === 0) return null;
    return +(((endClose - startClose) / startClose) * 100).toFixed(2);
  }

  // Hitung alpha per firm: rata-rata (netFirm - ihsgReturn) per rekomendasi closed.
  //   Cara sederhana: sum(pnlPure_i - ihsgReturn_i) untuk semua closed di firm itu.
  for (const rec of closed) {
    const ihsgRet = ihsgReturnBetween(rec.openDate, rec.exitDate);
    rec.ihsgReturn = ihsgRet;
    rec.alpha = (rec.pnlPure != null && ihsgRet != null) ? +(rec.pnlPure - ihsgRet).toFixed(2) : null;
  }
  // Total alpha per firm
  for (const f of firmMap.values()) {
    let sumAlpha = 0, cnt = 0;
    for (const rh of f.recsHistory) {
      // recsHistory belum di-populate dgn alpha; kita cari dari closed set
      // Skip di sini, kita akan compute langsung dari `closed` group.
    }
    let firmAlphaSum = 0, firmAlphaCnt = 0;
    for (const rec of closed) {
      if (idOf(rec.firm) !== f.id) continue;
      if (rec.alpha != null) { firmAlphaSum += rec.alpha; firmAlphaCnt++; }
    }
    f.alpha = firmAlphaCnt ? +firmAlphaSum.toFixed(2) : 0;
    f.alphaAvg = firmAlphaCnt ? +(firmAlphaSum / firmAlphaCnt).toFixed(2) : 0;
  }
  // IHSG return untuk periode konsensus (dari trade terlama sampai sekarang)
  let ihsgReturnPeriod = null;
  if (closed.length && ihsgReturnByDate) {
    const dates = closed.map(r => r.openDate).sort();
    ihsgReturnPeriod = ihsgReturnBetween(dates[0], todayIso);
  }

  // ── Build final payload ──
  const payload = {
    updatedAt: new Date().toISOString(),
    generatedBy: 'scripts/build-tracker.js',
    schemaVersion: 2, // v2: state machine + 3 gaya eksekusi
    pending: false,
    source: sheet.source,
    _diag: diag, // diagnostik: total baris sheet, sebaran status, alasan tolak
    since: closed.length ? closed.map(r => r.openDate).sort()[0] : todayIso,
    totalClosed: closed.length,
    // Legacy `open` = triggered saja (backward compat). `pending`/`missed` di field terpisah.
    open: active.length,
    pendingCount: pending.length,
    missedCount: missed.length,
    wins: globalSummary.wins,
    losses: globalSummary.losses,
    winrate: globalSummary.winrate,
    netReturn: globalSummary.net,
    netReturnPure: globalSummary.netPure,
    netReturnAvg: globalSummary.netAvg,
    netReturnHaka: globalSummary.netHaka,
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
    ihsgReturnPeriod, // return IHSG selama periode konsensus (dari trade terlama)
    alphaVsIhsg: (ihsgReturnPeriod != null) ? +(globalSummary.net - ihsgReturnPeriod).toFixed(2) : null,
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
    pendingList: pending.sort((a, b) => (b.openDate || '').localeCompare(a.openDate || '')).map(makeOpenListObj),
    missedList: missed.sort((a, b) => (b.openDate || '').localeCompare(a.openDate || '')).map(makeOpenListObj),
    unfilledList: unfilled.sort((a, b) => (b.openDate || '').localeCompare(a.openDate || '')).map(makeOpenListObj),
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
    state: rec.state, didTouchEntry: rec.didTouchEntry,
    entryTouchDate: rec.entryTouchDate, entryTouchPrice: rec.entryTouchPrice,
    openPriceAtPublish: rec.openPriceAtPublish,
    distanceToEntryPct: rec.distanceToEntryPct,
    pendingExpiresAt: rec.pendingExpiresAt,
    pnlPure: rec.pnlPure, pnlAvg: rec.pnlAvg, pnlHaka: rec.pnlHaka,
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
    state: rec.state, didTouchEntry: rec.didTouchEntry,
    openPriceAtPublish: rec.openPriceAtPublish,
    pnlPure: rec.pnlPure, pnlAvg: rec.pnlAvg, pnlHaka: rec.pnlHaka,
    ihsgReturn: rec.ihsgReturn, alpha: rec.alpha,
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
    // state machine + 3 gaya
    state: rec.state,
    didTouchEntry: rec.didTouchEntry,
    entryTouchDate: rec.entryTouchDate,
    entryTouchPrice: rec.entryTouchPrice,
    openPriceAtPublish: rec.openPriceAtPublish,
    distanceToEntryPct: rec.distanceToEntryPct,
    pendingExpiresAt: rec.pendingExpiresAt,
    pnlPure: rec.pnlPure, pnlAvg: rec.pnlAvg, pnlHaka: rec.pnlHaka,
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
    // state machine + 3 gaya
    state: rec.state,
    didTouchEntry: rec.didTouchEntry,
    entryTouchDate: rec.entryTouchDate,
    entryTouchPrice: rec.entryTouchPrice,
    openPriceAtPublish: rec.openPriceAtPublish,
    pnlPure: rec.pnlPure, pnlAvg: rec.pnlAvg, pnlHaka: rec.pnlHaka,
    ihsgReturn: rec.ihsgReturn, alpha: rec.alpha,
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
    schemaVersion: 2,
    pending: true,
    pendingReason: reason,
    pendingMessage: message,
    since: todayIso,
    totalClosed: 0, open: 0, pendingCount: 0, missedCount: 0,
    wins: 0, losses: 0,
    winrate: 0, netReturn: 0,
    netReturnPure: 0, netReturnAvg: 0, netReturnHaka: 0,
    profitFactor: 0, avgReturn: 0,
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
    ihsgReturnPeriod: null,
    alphaVsIhsg: null,
    marketBias: { bullish: 50, bearish: 50, sample: 'recent_48h', count: 0 },
    safetyNet: [], dailyEquity: [], scoreBrackets: [],
    byFirm: {}, topFirms: [], bottomFirms: [],
    byAnalyst: {}, byTicker: {}, topTickers: [], bottomTickers: [],
    watchlist: [], openList: [], pendingList: [], missedList: [], unfilledList: [],
    historyList: [],
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
    // Shared helpers dipakai scripts/archive-tracker.js supaya logic
    // fetch + identity dedup selalu sinkron dgn build pipeline.
    fetchSheetRows, gvizTableToItems,
    loadTrackerHistory, stableItemKey,
    HISTORY_PATH,
  };
}
