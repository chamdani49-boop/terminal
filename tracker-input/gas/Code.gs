/**
 * Code.gs — Google Apps Script Web App untuk menerima submission rekomendasi
 * Tracker dari Worker `tracker-input`, lalu menambahkannya sebagai 1 baris
 * ke Google Sheet (tab "Tracker") dengan status "pending".
 *
 * ══════════════════════════════════════════════════════════════════════
 * CARA PASANG (sekali saja):
 *   1. Buat Google Sheet BARU khusus tracker (mis. beri nama "Tracker DB").
 *   2. Di Sheet itu: menu Extensions ▸ Apps Script.
 *   3. Hapus isi default, tempel SELURUH file ini.
 *   4. Ganti nilai TOKEN di bawah dgn token rahasia (bebas, panjang).
 *      → token yang SAMA harus di-set di Worker: `wrangler secret put GAS_TOKEN`.
 *   5. Deploy ▸ New deployment ▸ pilih tipe "Web app":
 *        - Description : tracker-input receiver
 *        - Execute as  : Me (akunmu)
 *        - Who has access : Anyone
 *      → salin URL yang berakhiran `/exec`.
 *   6. Set URL itu di Worker: `wrangler secret put GAS_URL` (tempel URL /exec).
 *   7. Jalankan sekali fungsi `setup()` dari editor (untuk membuat header tab).
 *
 * CATATAN: Worker memanggil GAS server-side, jadi tidak ada isu CORS.
 * ══════════════════════════════════════════════════════════════════════
 */

// ⚠️ GANTI dengan token rahasia yang sama dengan Worker GAS_TOKEN.
var TOKEN = 'GANTI_DENGAN_TOKEN_RAHASIA';

// Nama tab tempat baris disimpan.
var SHEET_NAME = 'Tracker';

// Urutan kolom di Sheet. JANGAN ubah urutan setelah ada data (append pakai ini).
var HEADERS = [
  'timestamp',     // waktu submit (otomatis)
  'status',        // pending | approved | rejected  (default: pending)
  'analis',
  'firm',
  'sertifikasi',
  'ticker',
  'tipe',          // BUY | SELL
  'entry',
  'tp',            // target price
  'sl',            // stop loss
  'tanggal',       // tanggal rilis (YYYY-MM-DD)
  'horizon',       // 1H | 1M | 1Bln | 3Bln | 6Bln | 1Th  (opsional)
  'catatan',
  'submitted_by',  // nama pengupload (opsional)
  'approved_by'    // diisi saat approve (manual)
];

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

/** Jalankan sekali dari editor untuk membuat tab + header. */
function setup() {
  _sheet();
}

// ── Helpers ──────────────────────────────────────────────────────────

function _sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
