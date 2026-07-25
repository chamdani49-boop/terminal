/* ═══════════════════════════════════════════════════════════════════
   Kode Broker IDX — sumber tunggal (canonical source).

   Dipakai oleh:
   - public/index.html (menu Tracker: sub-tab Analis sidebar Sekuritas,
     heading detail firm, leaderboard view Per Firm).
   - Halaman lain yg menampilkan kotak avatar samping nama sekuritas.

   Cara nambah broker baru:
   - Tambah 1 entry ke array LIST di bawah.
   - Field:
     * code    : 2 huruf kode broker IDX (uppercase). Contoh: 'NI', 'DR'.
     * name    : Nama resmi broker (uppercase, apa adanya sesuai daftar
                 IDX). Boleh sertakan 'TBK.', 'INDONESIA', 'ASIA' — helper
                 normalisasi akan strip token generik saat matching.
     * foreign : true = broker asing (huruf kode akan berwarna merah di
                 UI). false = broker lokal.
   - Simpan → refresh halaman. Otomatis terdistribusi ke semua tempat
     yg render firm avatar.

   Convention:
   - LIST diurutkan alfabetis by code (mudah scan visual).
   - Tidak pakai depedensi eksternal.
   ═══════════════════════════════════════════════════════════════════ */
(function (window) {
  'use strict';

  // Daftar 92 broker (sumber: IDX + input user 25 Jul 2026).
  // Broker yg tidak ditandai "Asing" secara eksplisit → default lokal.
  var LIST = [
    { code: 'AD', name: 'OSO SEKURITAS INDONESIA', foreign: false },
    { code: 'AF', name: 'HARITA KENCANA SEKURITAS', foreign: false },
    { code: 'AG', name: 'KIWOOM SEKURITAS INDONESIA', foreign: true },
    { code: 'AH', name: 'SHINHAN SEKURITAS INDONESIA', foreign: true },
    { code: 'AI', name: 'UOB KAY HIAN SEKURITAS', foreign: true },
    { code: 'AK', name: 'UBS SEKURITAS INDONESIA', foreign: true },
    { code: 'AN', name: 'WANTEG SEKURITAS', foreign: false },
    { code: 'AO', name: 'ERDIKHA ELIT SEKURITAS', foreign: false },
    { code: 'AP', name: 'PACIFIC SEKURITAS INDONESIA', foreign: false },
    { code: 'AR', name: 'BINAARTHA SEKURITAS', foreign: false },
    { code: 'AT', name: 'PHINTRACO SEKURITAS', foreign: false },
    { code: 'AZ', name: 'SUCOR SEKURITAS', foreign: false },
    { code: 'BB', name: 'VERDHANA SEKURITAS INDONESIA', foreign: false },
    { code: 'BF', name: 'INTI FIKASA SEKURITAS', foreign: false },
    { code: 'BK', name: 'J.P. MORGAN SEKURITAS INDONESIA', foreign: true },
    { code: 'BQ', name: 'KOREA INVESTMENT AND SEKURITAS INDONESIA', foreign: true },
    { code: 'BR', name: 'TRUST SEKURITAS', foreign: false },
    { code: 'BS', name: 'EQUITY SEKURITAS INDONESIA', foreign: false },
    { code: 'CC', name: 'MANDIRI SEKURITAS', foreign: false },
    { code: 'CD', name: 'MEGA CAPITAL SEKURITAS', foreign: false },
    { code: 'CP', name: 'KB VALBURY SEKURITAS', foreign: true },
    { code: 'DD', name: 'MAKINDO SEKURITAS', foreign: false },
    { code: 'DH', name: 'SINARMAS SEKURITAS', foreign: false },
    { code: 'DP', name: 'DBS VICKERS SEKURITAS INDONESIA', foreign: true },
    { code: 'DR', name: 'RHB SEKURITAS INDONESIA', foreign: true },
    { code: 'DU', name: 'KAF SEKURITAS INDONESIA', foreign: true },
    { code: 'DX', name: 'BAHANA SEKURITAS', foreign: false },
    { code: 'EL', name: 'EVERGREEN SEKURITAS INDONESIA', foreign: false },
    { code: 'EP', name: 'MNC SEKURITAS', foreign: false },
    { code: 'ES', name: 'EKOKAPITAL SEKURITAS', foreign: false },
    { code: 'FO', name: 'FORTE GLOBAL SEKURITAS', foreign: false },
    { code: 'FS', name: 'YUANTA SEKURITAS INDONESIA', foreign: true },
    { code: 'FZ', name: 'WATERFRONT SEKURITAS INDONESIA', foreign: false },
    { code: 'GA', name: 'BNC SEKURITAS INDONESIA', foreign: false },
    { code: 'GI', name: 'WEBULL SEKURITAS INDONESIA', foreign: true },
    { code: 'GR', name: 'PANIN SEKURITAS TBK.', foreign: false },
    { code: 'GW', name: 'HSBC SEKURITAS INDONESIA', foreign: true },
    { code: 'HD', name: 'KGI SEKURITAS INDONESIA', foreign: true },
    { code: 'HP', name: 'HENAN PUTIHRAI SEKURITAS', foreign: false },
    { code: 'IC', name: 'INTEGRITY CAPITAL SEKURITAS', foreign: false },
    { code: 'ID', name: 'ANUGERAH SEKURITAS INDONESIA', foreign: false },
    { code: 'IF', name: 'SAMUEL SEKURITAS INDONESIA', foreign: false },
    { code: 'IH', name: 'INDO HARVEST SEKURITAS', foreign: false },
    { code: 'II', name: 'DANATAMA MAKMUR SEKURITAS', foreign: false },
    { code: 'IN', name: 'INVESTINDO NUSANTARA SEKURITAS', foreign: false },
    { code: 'IP', name: 'YUGEN BERTUMBUH SEKURITAS', foreign: false },
    { code: 'IT', name: 'INTI TELADAN SEKURITAS', foreign: false },
    { code: 'IU', name: 'INDO CAPITAL SEKURITAS', foreign: false },
    { code: 'KI', name: 'CIPTADANA SEKURITAS ASIA', foreign: true },
    { code: 'KK', name: 'PHILLIP SEKURITAS INDONESIA', foreign: true },
    { code: 'KZ', name: 'CLSA SEKURITAS INDONESIA', foreign: true },
    { code: 'LG', name: 'TRIMEGAH SEKURITAS INDONESIA TBK.', foreign: false },
    { code: 'LS', name: 'RELIANCE SEKURITAS INDONESIA TBK.', foreign: false },
    { code: 'MG', name: 'SEMESTA INDOVEST SEKURITAS', foreign: false },
    { code: 'MI', name: 'VICTORIA SEKURITAS INDONESIA', foreign: false },
    { code: 'MU', name: 'MINNA PADI INVESTAMA SEKURITAS TBK', foreign: false },
    { code: 'NI', name: 'BNI SEKURITAS', foreign: false },
    { code: 'OD', name: 'BRI DANAREKSA SEKURITAS', foreign: false },
    { code: 'OK', name: 'NET SEKURITAS', foreign: false },
    { code: 'PC', name: 'FAC SEKURITAS INDONESIA', foreign: false },
    { code: 'PD', name: 'INDO PREMIER SEKURITAS', foreign: false },
    { code: 'PF', name: 'DANASAKTI SEKURITAS INDONESIA', foreign: false },
    { code: 'PG', name: 'PANCA GLOBAL SEKURITAS', foreign: false },
    { code: 'PI', name: 'MAGENTA KAPITAL SEKURITAS INDONESIA', foreign: false },
    { code: 'PO', name: 'PILARMAS INVESTINDO SEKURITAS', foreign: false },
    { code: 'PP', name: 'ALDIRACITA SEKURITAS INDONESIA', foreign: false },
    { code: 'PS', name: 'PARAMITRA ALFA SEKURITAS', foreign: false },
    { code: 'QA', name: 'TUNTUN SEKURITAS INDONESIA', foreign: true },
    { code: 'RB', name: 'INA SEKURITAS INDONESIA', foreign: false },
    { code: 'RF', name: 'BUANA CAPITAL SEKURITAS', foreign: false },
    { code: 'RG', name: 'PROFINDO SEKURITAS INDONESIA', foreign: false },
    { code: 'RO', name: 'PLUANG MAJU SEKURITAS', foreign: false },
    { code: 'RS', name: 'YULIE SEKURITAS INDONESIA TBK.', foreign: false },
    { code: 'RX', name: 'MACQUARIE SEKURITAS INDONESIA', foreign: true },
    { code: 'SA', name: 'ELIT SUKSES SEKURITAS', foreign: false },
    { code: 'SF', name: 'SURYA FAJAR SEKURITAS', foreign: false },
    { code: 'SH', name: 'ARTHA SEKURITAS INDONESIA', foreign: false },
    { code: 'SQ', name: 'BCA SEKURITAS', foreign: false },
    { code: 'SS', name: 'SUPRA SEKURITAS INDONESIA', foreign: false },
    { code: 'TF', name: 'UNIVERSAL BROKER INDONESIA SEKURITAS', foreign: false },
    { code: 'TP', name: 'OCBC SEKURITAS INDONESIA', foreign: true },
    { code: 'TS', name: 'DWIDANA SAKTI SEKURITAS', foreign: false },
    { code: 'XA', name: 'NH KORINDO SEKURITAS INDONESIA', foreign: true },
    { code: 'XC', name: 'AJAIB SEKURITAS ASIA', foreign: false },
    { code: 'XL', name: 'STOCKBIT SEKURITAS DIGITAL', foreign: false },
    { code: 'YB', name: 'YAKIN BERTUMBUH SEKURITAS', foreign: false },
    { code: 'YJ', name: 'LOTUS ANDALAN SEKURITAS', foreign: false },
    { code: 'YO', name: 'AMANTARA SEKURITAS INDONESIA', foreign: false },
    { code: 'YP', name: 'MIRAE ASSET SEKURITAS INDONESIA', foreign: true },
    { code: 'YU', name: 'CGS INTERNATIONAL SEKURITAS INDONESIA', foreign: true },
    { code: 'ZP', name: 'MAYBANK SEKURITAS INDONESIA', foreign: true },
    { code: 'ZR', name: 'BUMIPUTERA SEKURITAS', foreign: false }
  ];

  // Normalisasi utk matching. Strip:
  // - 'PT' prefix, 'TBK' suffix, 'INDONESIA', 'ASIA' (token generik).
  // - Punctuation (titik, koma, kutip, kurung, ampersand).
  // - Collapse whitespace.
  // Contoh: 'PT RHB Sekuritas Indonesia' → 'RHB SEKURITAS'.
  function _norm(s) {
    return String(s || '')
      .toUpperCase()
      .replace(/[.,'"()&/-]/g, ' ')
      .replace(/\bPT\b/g, ' ')
      .replace(/\bTBK\b/g, ' ')
      .replace(/\bINDONESIA\b/g, ' ')
      .replace(/\bASIA\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Build lookup tables sekali di module load.
  var _byNorm = {};
  var _byCode = {};
  for (var i = 0; i < LIST.length; i++) {
    var b = LIST[i];
    _byCode[b.code] = b;
    var k = _norm(b.name);
    if (k) _byNorm[k] = b;
  }

  // Fallback initials generator (dipakai kalau firm tidak match ke broker
  // manapun — mis. firm custom / bukan anggota IDX). Selaras dgn helper
  // initials() existing di public/index.html.
  function _initials(s) {
    if (!s) return '?';
    var parts = String(s).replace(/[,®]/g, '').replace(/PT\s+/i, '').trim().split(/\s+/).filter(Boolean);
    var a = (parts[0] || '')[0] || '';
    var b = (parts[1] || '')[0] || '';
    return (a + b).toUpperCase() || '?';
  }

  // Cari entry broker dari nama firm. Return {code, name, foreign} atau
  // null kalau tidak ada padanan.
  function getByFirmName(firmName) {
    if (!firmName) return null;
    var n = _norm(firmName);
    if (_byNorm[n]) return _byNorm[n];
    // Second pass: prefix-match. Kalau normalized firm ATAU normalized
    // broker satu sama lain diawali (StartsWith), anggap match. Menangani
    // varian nama pendek: 'RHB Sekuritas' (firm) vs 'RHB Sekuritas
    // Indonesia' (LIST). Perlu >= 6 char utk menghindari false positive
    // pendek (mis. 'MEGA' vs 'MEGA CAPITAL').
    if (n.length >= 6) {
      for (var i = 0; i < LIST.length; i++) {
        var bn = _norm(LIST[i].name);
        if (!bn) continue;
        if (bn.indexOf(n) === 0 || n.indexOf(bn) === 0) return LIST[i];
      }
    }
    return null;
  }

  // Cari entry dari kode broker. Return {code, name, foreign} atau null.
  function getByCode(code) {
    if (!code) return null;
    return _byCode[String(code).toUpperCase()] || null;
  }

  // Helper utama utk UI: return { text, foreign } untuk rendering kotak
  // avatar samping nama sekuritas.
  // - text    : kode broker 2 huruf kalau ketemu; fallback ke initials.
  // - foreign : true kalau broker asing → UI harus render huruf merah.
  function avatar(firmName) {
    var b = getByFirmName(firmName);
    if (b) return { text: b.code, foreign: !!b.foreign, matched: true };
    return { text: _initials(firmName), foreign: false, matched: false };
  }

  window.BrokerCodes = {
    LIST: LIST,
    get: getByFirmName,
    getByCode: getByCode,
    avatar: avatar,
    _norm: _norm  // exposed utk debugging
  };
})(window);
