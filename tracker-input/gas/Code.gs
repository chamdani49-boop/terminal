/**
 * Code.gs — Google Apps Script Web App untuk menerima submission rekomendasi
 * Tracker dari Worker `tracker-input`, lalu menambahkannya sebagai 1 baris ke
 * Google Sheet (tab "Tracker") dengan status "pending".
 *
 * ══════════════════════════════════════════════════════════════════════
 * CARA PASANG (sekali saja):
 *   1. Buat Google Sheet BARU khusus tracker (mis. "Tracker DB").
 *   2. Di Sheet itu: menu Extensions ▸ Apps Script.
 *   3. Hapus isi default, tempel SELURUH file ini, lalu SIMPAN (💾 / Ctrl+S).
 *   4. Ganti nilai TOKEN di bawah dgn token rahasia (bebas, panjang).
 *      → token yang SAMA di-set di Worker: `wrangler secret put GAS_TOKEN`.
 *   5. KEMBALI ke tab Google Sheet, lalu MUAT ULANG halaman (refresh browser).
 *      → akan muncul menu baru "🎯 Tracker" di bar menu Sheet.
 *   6. Klik menu 🎯 Tracker ▸ "1) Setup / Buat Tabel".
 *      → pertama kali akan minta izin (Authorize): Review permissions ▸
 *        pilih akun ▸ Advanced ▸ Go to project (unsafe) ▸ Allow.
 *      → tab "Tracker" + header otomatis dibuat.
 *   7. Deploy ▸ New deployment ▸ tipe "Web app":
 *        - Execute as     : Me
 *        - Who has access : Anyone
 *      → salin URL yang berakhiran `/exec`.
 *   8. Set URL itu di Worker: `wrangler secret put GAS_URL`.
 *
 * CATATAN: Worker memanggil GAS server-side, jadi tidak ada isu CORS.
 * ══════════════════════════════════════════════════════════════════════
 */

// ⚠️ GANTI dengan token rahasia yang sama dengan Worker GAS_TOKEN.
var TOKEN = 'GANTI_DENGAN_TOKEN_RAHASIA';

// Nama tab tempat baris disimpan.
var SHEET_NAME = 'Tracker';

// Urutan kolom di Sheet. JANGAN ubah urutan setelah ada data.
var HEADERS = [
  'timestamp',     // waktu submit (otomatis)
  'status',        // pending | approved | rejected  (default: pending)
  'analis',
  'firm',
  'sertifikasi',
  'ticker',
  'tipe',          // BUY | SELL
  'entry',
  'tp1',           // target price 1
  'tp2',           // target price 2 (opsional)
  'sl',            // stop loss
  'tanggal',       // tanggal rilis (YYYY-MM-DD)
  'horizon',       // 1H | 1M | 1Bln | 3Bln | 6Bln | 1Th  (opsional)
  'catatan',
  'submitted_by',  // nama pengupload (opsional)
  'approved_by'    // diisi otomatis saat approve lewat menu
];

/**
 * Simple trigger: dijalankan otomatis tiap Sheet dibuka.
 * → menambahkan menu "🎯 Tracker" + memastikan tab/header ada.
 * Inilah "efek" yang terlihat setelah paste kode & refresh Sheet.
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('🎯 Tracker')
      .addItem('1) Setup / Buat Tabel', 'setup')
      .addSeparator()
      .addItem('✅ Tandai baris terpilih → APPROVED', 'approveSelected')
      .addItem('🚫 Tandai baris terpilih → REJECTED', 'rejectSelected')
      .addSeparator()
      .addItem('🔧 Perbaiki Header (tp1/tp2)', 'fixHeader')
      .addItem('ℹ️ Cek koneksi', 'showInfo')
      .addToUi();
  } catch (e) { /* abaikan */ }

  // Coba buat tab+header otomatis (kalau izin cukup). Kalau gagal, tinggal
  // klik menu "1) Setup / Buat Tabel" yang akan minta izin.
  try { _sheet(); } catch (e) { /* akan dibuat via menu Setup */ }
}

/** Endpoint utama: dipanggil Worker via POST JSON. */
function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    if (!body.token || body.token !== TOKEN) {
      return _json({ ok: false, error: 'unauthorized' });
    }

    var sh = _sheet();
    var row = HEADERS.map(function (h) {
      if (h === 'timestamp') return new Date();
      if (h === 'status') return 'pending';
      if (h === 'approved_by') return '';
      return (body[h] != null) ? body[h] : '';
    });
    sh.appendRow(row);
    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

/** Cek cepat via browser (GET) bahwa Web App hidup. */
function doGet() {
  return _json({ ok: true, service: 'tracker-input receiver' });
}

/** Buat tab + header (dipanggil dari menu atau otomatis). */
function setup() {
  _sheet();
  try { SpreadsheetApp.getUi().alert('✓ Siap. Tab "' + SHEET_NAME + '" + header sudah dibuat.'); } catch (e) {}
}

/** Info singkat + status token. */
function showInfo() {
  var pesan = 'Tab: ' + SHEET_NAME + '\n' +
    'Token di-set: ' + (TOKEN && TOKEN !== 'GANTI_DENGAN_TOKEN_RAHASIA' ? 'YA' : 'BELUM (masih default!)') + '\n\n' +
    'Langkah berikutnya: Deploy ▸ New deployment ▸ Web app (Execute as: Me, Access: Anyone), salin URL /exec.';
  try { SpreadsheetApp.getUi().alert(pesan); } catch (e) {}
}

/** Tandai baris terpilih sebagai approved (siap tayang). */
function approveSelected() { _setStatusSelected('approved'); }

/** Tandai baris terpilih sebagai rejected. */
function rejectSelected() { _setStatusSelected('rejected'); }

// ── Helpers ──────────────────────────────────────────────────────────

function _setStatusSelected(status) {
  var ui = SpreadsheetApp.getUi();
  var sh = SpreadsheetApp.getActiveSheet();
  if (sh.getName() !== SHEET_NAME) {
    ui.alert('Pindah dulu ke tab "' + SHEET_NAME + '", pilih baris yang mau di-' + status + '.');
    return;
  }
  var statusCol   = HEADERS.indexOf('status') + 1;       // kolom "status"
  var approvedCol = HEADERS.indexOf('approved_by') + 1;   // kolom "approved_by"
  var email = '';
  try { email = Session.getActiveUser().getEmail() || ''; } catch (e) {}

  var ranges = sh.getActiveRangeList() ? sh.getActiveRangeList().getRanges() : [sh.getActiveRange()];
  var count = 0;
  ranges.forEach(function (rng) {
    var start = rng.getRow(), n = rng.getNumRows();
    for (var r = start; r < start + n; r++) {
      if (r === 1) continue; // lewati header
      sh.getRange(r, statusCol).setValue(status);
      if (status === 'approved') sh.getRange(r, approvedCol).setValue(email);
      count++;
    }
  });
  ui.alert(count + ' baris ditandai "' + status + '".');
}

function _sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  var lastRow = sh.getLastRow();
  if (lastRow === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  } else if (lastRow === 1) {
    // Baru ada baris header (belum ada data) → SEGARKAN agar sesuai HEADERS
    // terbaru (mis. setelah kolom 'tp' diganti 'tp1'/'tp2'). Aman: tanpa data.
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sh.setFrozenRows(1);
  }
  // Jika sudah ada data (lastRow > 1), header TIDAK diubah otomatis supaya data
  // lama tidak bergeser. Pakai menu "🔧 Perbaiki Header" bila memang perlu.
  return sh;
}

/**
 * Paksa tulis ulang baris header menjadi HEADERS terbaru (tp1/tp2).
 * ⚠️ Kalau sudah ada data dgn susunan kolom lama, nilai bisa jadi tidak
 * sejajar dgn header baru — konfirmasi dulu.
 */
function fixHeader() {
  var ui = SpreadsheetApp.getUi();
  var sh = _sheet();
  if (sh.getLastRow() > 1) {
    var r = ui.alert('Perbaiki Header',
      'Sudah ada data. Menulis ulang header ke tp1/tp2 bisa membuat kolom lama tidak sejajar. Lanjutkan?',
      ui.ButtonSet.YES_NO);
    if (r !== ui.Button.YES) return;
  }
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sh.setFrozenRows(1);
  ui.alert('✓ Header diperbarui ke: ' + HEADERS.join(', '));
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
