/**
 * scripts/archive-tracker.js — arsipkan baris Sheet Tracker ke JSON di repo.
 *
 * DIPICU OLEH:
 *   - .github/workflows/archive-tracker-daily.yml    → mode --daily   (19:00 WIB)
 *   - .github/workflows/archive-tracker-monthly.yml  → mode --monthly (01:00 WIB tgl 1)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * KENAPA DIBUTUHKAN
 * ═══════════════════════════════════════════════════════════════════════
 * Google Sheet "Tracker" adalah database live rekomendasi. Kalau baris
 * menumpuk tanpa batas, fetch gviz makin lambat & tab Tracker di web
 * makin lelet. Solusi: user WIPE isi sheet setiap tgl 1 bulan, lalu
 * mulai bulan baru dgn lembar kosong.
 *
 * TAPI data historis (winrate firm, safety net, alpha vs IHSG, dsb) di
 * web WAJIB tetap tersaji dari data bulan-bulan sebelumnya. Karena itu:
 *
 *   1) SETIAP HARI jam 19:00 WIB — script ini (mode --daily) tarik seluruh
 *      isi sheet → upsert ke `public/tracker-history.json` (dedup by
 *      stableItemKey, sheet menang saat konflik). File kumulatif ini
 *      SELALU up-to-date jadi kalau user tiba-tiba wipe sheet duluan pun
 *      (misal sebelum tgl 1) tidak ada data yang hilang.
 *
 *   2) TGL 1 tiap bulan jam 01:00 WIB — script ini (mode --monthly)
 *      melakukan hal yg sama + bikin snapshot bulanan
 *      `public/tracker-history/YYYY-MM.json` (audit trail per bulan) +
 *      retention 3 tahun + notif Telegram supaya user tahu sheet AMAN
 *      di-wipe manual pada jam 06:00 WIB pagi.
 *
 * `scripts/build-tracker.js` (workflow refresh-tracker, hourly) sudah
 * di-update untuk merge (sheet.items ∪ tracker-history.json items) →
 * dedup → normalize → derive state. Efeknya:
 *   - Trade closed di bulan lampau (sudah lenyap dari sheet) tetap masuk
 *     historyList / winrate / dsb.
 *   - Trade masih aktif (TRIGGERED / PENDING) yg ter-arsip lalu sheet
 *     di-wipe → tetap dilacak, derivePosition menghitung state fresh dari
 *     OHLC terbaru → kalau TP/SL akhirnya kena, state ikut ter-update di
 *     tracker.json tanpa perlu re-input manual ke sheet.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * FORMAT FILE OUTPUT
 * ═══════════════════════════════════════════════════════════════════════
 *
 * public/tracker-history.json
 *   {
 *     version: 1,
 *     generatedAt: "2026-08-01T12:00:00.000Z",
 *     count: 47,
 *     items: [
 *       {
 *         _row: 42, _ts: 1722156000000, _cols: [...],
 *         analis: "…", firm: "…", ticker: "ANTM", tipe: "BUY",
 *         entry: 1500, tp1: 1700, tp2: null, sl: 1450,
 *         tanggal: "2026-07-28", timestamp: "2026-07-28T09:15:00Z",
 *         horizon: "1 bulan", sertifikasi: "WPPE",
 *         catatan: "...", submitted_by: "...", approved_by: "...",
 *         status: "approved",
 *         archivedAt: "2026-08-01T12:00:00.000Z"
 *       },
 *       ...
 *     ]
 *   }
 *
 * public/tracker-history/2026-07.json  (snapshot bulanan, monthly only)
 *   { version, generatedAt, snapshotMonth: "2026-07", count, items: [...] }
 *   items[] = subset dari cumulative yg date-nya (openDate atau timestamp)
 *   ada di bulan snapshot. Jadi tiap rec masuk tepat di SATU file bulanan.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * RETENTION
 * ═══════════════════════════════════════════════════════════════════════
 * Setiap monthly run: hapus entry di tracker-history.json yg openDate
 * lebih tua dari 3 tahun; hapus file public/tracker-history/YYYY-MM.json
 * yg bulannya lebih tua dari 3 tahun. Threshold RETENTION_YEARS.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * ENV VARS
 * ═══════════════════════════════════════════════════════════════════════
 *   TRACKER_SHEET_ID       (wajib) — sama dgn build-tracker.js
 *   TRACKER_SHEET_TAB      (opsional, default "Tracker")
 *   TELEGRAM_BOT_TOKEN     (opsional, monthly mode only)
 *   TELEGRAM_CHAT_ID       (opsional, monthly mode only)
 *
 * ═══════════════════════════════════════════════════════════════════════
 * USAGE
 * ═══════════════════════════════════════════════════════════════════════
 *   node scripts/archive-tracker.js --daily
 *   node scripts/archive-tracker.js --monthly
 *   node scripts/archive-tracker.js --monthly --force-month=2026-07  (manual override)
 */

const fs = require('fs');
const path = require('path');

const { fetchSheetRows, stableItemKey } = require('./build-tracker.js');

const ROOT          = path.join(__dirname, '..');
const HISTORY_PATH  = path.join(ROOT, 'public', 'tracker-history.json');
const SNAPSHOT_DIR  = path.join(ROOT, 'public', 'tracker-history');

const RETENTION_YEARS = 3;

// Nama bulan bahasa Indonesia (untuk pesan Telegram).
const MONTH_NAMES_ID = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli',    'Agustus',  'September', 'Oktober', 'November', 'Desember',
];

// ─────────────────────────────────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────────────────────────────────

// "Waktu WIB sekarang" sebagai Date object dgn UTC accessor. Trick: geser
// timestamp epoch +7 jam, pakai getUTCxxx() untuk baca komponen.
function nowWibDate() {
  return new Date(Date.now() + 7 * 3600 * 1000);
}

// "YYYY-MM" dari bulan SEBELUMNYA relatif jam WIB sekarang. Dipakai monthly
// mode untuk memilih file snapshot yg akan ditulis (mis. dijalankan
// 1 Ags 01:00 WIB → previousMonthWib() = "2026-07").
function previousMonthWib() {
  const wib = nowWibDate();
  const y = wib.getUTCFullYear();
  const m = wib.getUTCMonth(); // 0-indexed
  // rewind ke bulan sebelumnya (auto handle boundary Jan → Des tahun lalu)
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

// "YYYY-MM" cutoff untuk retention snapshot bulanan (3 tahun ke belakang).
function retentionMonthCutoff() {
  const wib = nowWibDate();
  const y = wib.getUTCFullYear() - RETENTION_YEARS;
  const m = wib.getUTCMonth();
  return `${y}-${String(m + 1).padStart(2, '0')}`;
}

// "YYYY-MM-DD" cutoff untuk retention entry di tracker-history.json.
function retentionDateCutoff() {
  const wib = nowWibDate();
  const y = wib.getUTCFullYear() - RETENTION_YEARS;
  const m = wib.getUTCMonth();
  const d = wib.getUTCDate();
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Ambil tanggal representatif dari raw sheet item (untuk retention +
// bucketing bulanan). Prioritas: `tanggal` (openDate) → `timestamp` →
// `_ts` (epoch ms). Return "YYYY-MM-DD" atau null kalau tak bisa parse.
function itemDateIso(item) {
  if (!item) return null;
  if (typeof item.tanggal === 'string') {
    const m = item.tanggal.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  if (item.timestamp) {
    const d = new Date(item.timestamp);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  if (item._ts) {
    const d = new Date(item._ts);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// LOAD / SAVE
// ─────────────────────────────────────────────────────────────────────────

function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) {
    console.log('  ℹ tracker-history.json belum ada — mulai fresh.');
    return { version: 1, items: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    const items = Array.isArray(raw && raw.items) ? raw.items : [];
    console.log(`  ✓ Load tracker-history.json (${items.length} items)`);
    return { version: raw.version || 1, items };
  } catch (e) {
    console.warn('  ⚠ tracker-history.json rusak, backup lalu mulai fresh:', e.message);
    // Backup file yg rusak supaya tidak hilang total
    try {
      const backupPath = HISTORY_PATH + '.corrupt.' + Date.now();
      fs.copyFileSync(HISTORY_PATH, backupPath);
      console.warn(`    → backup: ${backupPath}`);
    } catch (_) {}
    return { version: 1, items: [] };
  }
}

function saveHistory(history) {
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: history.items.length,
    items: history.items,
  };
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(payload));
  const sizeKB = (fs.statSync(HISTORY_PATH).size / 1024).toFixed(1);
  console.log(`  ✓ Wrote ${HISTORY_PATH} (${history.items.length} items, ${sizeKB} KB)`);
}

// ─────────────────────────────────────────────────────────────────────────
// UPSERT: merge sheet items INTO history (sheet wins on identity conflict)
// ─────────────────────────────────────────────────────────────────────────
// Kembalikan { addedOrUpdated, historyItems }.
function upsertSheetIntoHistory(sheetItems, history) {
  const archivedAt = new Date().toISOString();
  const map = new Map();

  // Seed dari history existing
  for (const item of history.items) {
    const k = stableItemKey(item);
    if (!k) continue;
    map.set(k, item);
  }
  const initialSize = map.size;

  // Upsert sheet items
  let addedOrUpdated = 0;
  for (const item of sheetItems) {
    const k = stableItemKey(item);
    if (!k) continue;
    // Stamp archive metadata. `archivedAt` HANYA ditulis di sisi arsip;
    // build-tracker.js abaikan field ini.
    const stamped = Object.assign({}, item, { archivedAt });
    const prev = map.get(k);
    if (!prev) {
      addedOrUpdated++;
    } else {
      // Anggap "update" kalau ada perubahan pada field utama (bukan hanya
      // archivedAt). JSON compare stringify tanpa archivedAt.
      const strip = (o) => { const { archivedAt: _a, ...rest } = o; return rest; };
      if (JSON.stringify(strip(prev)) !== JSON.stringify(strip(stamped))) {
        addedOrUpdated++;
      }
    }
    map.set(k, stamped);
  }

  history.items = Array.from(map.values());
  console.log(`  ✓ Upsert: sheet=${sheetItems.length}, history-before=${initialSize}, after=${history.items.length}, changed=${addedOrUpdated}`);
  return { addedOrUpdated };
}

// ─────────────────────────────────────────────────────────────────────────
// RETENTION (monthly only)
// ─────────────────────────────────────────────────────────────────────────

function applyRetentionToCumulative(history) {
  const cutoff = retentionDateCutoff();
  const before = history.items.length;
  history.items = history.items.filter((item) => {
    const iso = itemDateIso(item);
    // Kalau item tidak punya tanggal parseable → simpan (safer default).
    if (!iso) return true;
    return iso >= cutoff;
  });
  const removed = before - history.items.length;
  console.log(`  ✓ Retention cumulative (cutoff=${cutoff}): removed ${removed} entries`);
  return removed;
}

function purgeOldMonthlySnapshots() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return 0;
  const cutoff = retentionMonthCutoff();
  const files = fs.readdirSync(SNAPSHOT_DIR).filter((f) => /^\d{4}-\d{2}\.json$/.test(f));
  let removed = 0;
  for (const f of files) {
    const month = f.slice(0, 7);
    if (month < cutoff) {
      fs.unlinkSync(path.join(SNAPSHOT_DIR, f));
      console.log(`    → purged old snapshot: ${f}`);
      removed++;
    }
  }
  console.log(`  ✓ Retention snapshots (cutoff=${cutoff}): removed ${removed} file(s)`);
  return removed;
}

// ─────────────────────────────────────────────────────────────────────────
// SNAPSHOT BULANAN (monthly only)
// ─────────────────────────────────────────────────────────────────────────
// File: public/tracker-history/YYYY-MM.json
// Isi: subset cumulative history yg date-nya (openDate atau timestamp)
// jatuh di bulan snapshot. Deterministic — item yg sama tidak akan
// dobel di file bulan lain.
function writeMonthlySnapshot(history, month) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const monthItems = history.items.filter((item) => {
    const iso = itemDateIso(item);
    return iso && iso.slice(0, 7) === month;
  });
  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    snapshotMonth: month,
    count: monthItems.length,
    items: monthItems,
  };
  const filePath = path.join(SNAPSHOT_DIR, `${month}.json`);
  fs.writeFileSync(filePath, JSON.stringify(payload));
  const sizeKB = (fs.statSync(filePath).size / 1024).toFixed(1);
  console.log(`  ✓ Wrote snapshot ${filePath} (${monthItems.length} items, ${sizeKB} KB)`);
  return { path: filePath, count: monthItems.length };
}

// ─────────────────────────────────────────────────────────────────────────
// TELEGRAM NOTIF (monthly only)
// ─────────────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) {
    console.log('  ℹ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID kosong — skip notif.');
    return { ok: false, skipped: true };
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok !== true) {
      console.warn('  ⚠ Telegram send gagal:', res.status, JSON.stringify(json || {}).slice(0, 200));
      return { ok: false, error: json };
    }
    console.log('  ✓ Telegram notif terkirim.');
    return { ok: true };
  } catch (e) {
    console.warn('  ⚠ Telegram send throw:', e.message);
    return { ok: false, error: e.message };
  }
}

function buildTelegramSuccessMsg(ctx) {
  const [y, m] = ctx.month.split('-');
  const monthName = MONTH_NAMES_ID[parseInt(m, 10) - 1] || m;
  const lines = [
    `📦 <b>Arsip Tracker ${monthName} ${y}</b> — SELESAI`,
    ``,
    `✓ Sheet: <b>${ctx.sheetCount}</b> rec approved`,
    `✓ Kumulatif: <b>${ctx.totalItems}</b> rec (${ctx.addedOrUpdated} baru/di-update bulan ini)`,
    `✓ Snapshot: <code>public/tracker-history/${ctx.month}.json</code> (${ctx.snapshotCount} rec)`,
    `✓ Retention: purge <b>${ctx.retentionEntries}</b> entry + <b>${ctx.retentionFiles}</b> file`,
    ``,
    `🟢 <b>Sheet Tracker aman di-wipe manual sekarang.</b>`,
    `Data historis (winrate firm, safety net, alpha, dsb.) akan tetap tampil di web dari file arsip ini.`,
  ];
  return lines.join('\n');
}

function buildTelegramFailureMsg(ctx) {
  const [y, m] = ctx.month.split('-');
  const monthName = MONTH_NAMES_ID[parseInt(m, 10) - 1] || m;
  return [
    `❌ <b>Arsip Tracker ${monthName} ${y}</b> — GAGAL`,
    ``,
    `Alasan: <code>${ctx.reason}</code>`,
    `${ctx.detail ? '<pre>' + escapeHtml(ctx.detail) + '</pre>' : ''}`,
    ``,
    `⚠️ <b>JANGAN wipe sheet Tracker!</b> Data bulan ini belum ter-arsip.`,
    `Cek run workflow di GitHub Actions → coba jalankan ulang manual (Run workflow).`,
  ].filter(Boolean).join('\n');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--monthly') ? 'monthly' : 'daily';

  // Manual override snapshot month (untuk testing / re-run bulan lampau)
  let snapshotMonth = null;
  const forceArg = args.find((a) => a.startsWith('--force-month='));
  if (forceArg) {
    const m = forceArg.split('=')[1];
    if (/^\d{4}-\d{2}$/.test(m)) snapshotMonth = m;
  }

  console.log(`archive-tracker: start (mode=${mode})`, new Date().toISOString());
  console.log(`  ℹ Waktu WIB sekarang: ${nowWibDate().toISOString().replace('Z', ' WIB')}`);

  // Fetch sheet
  let sheet;
  try {
    sheet = await fetchSheetRows();
  } catch (e) {
    console.error('  ✗ Sheet fetch throw:', e.message);
    if (mode === 'monthly') {
      await sendTelegram(buildTelegramFailureMsg({
        month: snapshotMonth || previousMonthWib(),
        reason: 'fetch-exception',
        detail: e.message,
      }));
    }
    process.exit(1);
  }

  if (!sheet.ok) {
    console.error(`  ✗ Sheet fetch gagal: ${sheet.reason}`);
    if (mode === 'monthly') {
      await sendTelegram(buildTelegramFailureMsg({
        month: snapshotMonth || previousMonthWib(),
        reason: sheet.reason,
        detail: sheet.error || '',
      }));
    }
    process.exit(1);
  }

  const sheetItems = sheet.items || [];
  console.log(`  ✓ Sheet fetch OK: ${sheetItems.length} rec approved (of ${sheet.allCount || sheetItems.length} total rows)`);

  // Load history + upsert
  const history = loadHistory();
  const { addedOrUpdated } = upsertSheetIntoHistory(sheetItems, history);

  // Monthly extras
  let retentionEntries = 0;
  let retentionFiles = 0;
  let snapshotInfo = null;

  if (mode === 'monthly') {
    const month = snapshotMonth || previousMonthWib();
    console.log(`  ℹ Monthly mode: target snapshot bulan ${month}`);

    // Retention SEBELUM snapshot supaya data yg lewat 3 tahun tidak
    // ikut masuk snapshot bulan berikutnya.
    retentionEntries = applyRetentionToCumulative(history);

    // Tulis snapshot bulanan (subset cumulative untuk bulan target)
    snapshotInfo = writeMonthlySnapshot(history, month);

    // Purge file snapshot lama (>3 tahun)
    retentionFiles = purgeOldMonthlySnapshots();
  }

  // Save cumulative (SETELAH retention)
  saveHistory(history);

  // Telegram sukses (monthly)
  if (mode === 'monthly') {
    const msg = buildTelegramSuccessMsg({
      month: snapshotMonth || previousMonthWib(),
      sheetCount: sheetItems.length,
      totalItems: history.items.length,
      addedOrUpdated,
      snapshotCount: (snapshotInfo && snapshotInfo.count) || 0,
      retentionEntries,
      retentionFiles,
    });
    await sendTelegram(msg);
  }

  console.log('archive-tracker: done', new Date().toISOString());
}

if (require.main === module) {
  main().catch((err) => {
    console.error('archive-tracker failed:', err);
    process.exit(1);
  });
}

module.exports = {
  nowWibDate, previousMonthWib, retentionMonthCutoff, retentionDateCutoff,
  itemDateIso, loadHistory, saveHistory,
  upsertSheetIntoHistory, applyRetentionToCumulative,
  purgeOldMonthlySnapshots, writeMonthlySnapshot,
  buildTelegramSuccessMsg, buildTelegramFailureMsg,
};
