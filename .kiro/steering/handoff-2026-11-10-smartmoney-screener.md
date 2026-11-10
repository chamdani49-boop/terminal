---
inclusion: manual
---

# Handoff 10 Nov 2026: Smart Money › Screener (7 tampilan)

Permintaan user: tambah screener di menu Smart Money mengikuti 7 gambar referensi, visual
dirapikan, ikon "Cara pakai" & "Manfaat", responsif HP/tablet/PC, langsung di `main`.

## File
- `public/smartmoney-screener.js` (baru, mandiri, ±1.900 baris). Dimuat DINAMIS oleh
  `smartmoney.js` (`ensureScreener()`) saat sub-tab Screener dibuka, dengan `?v=SCR_V`.
  **Naikkan `SCR_V` di smartmoney.js setiap kali file screener diubah** (cache-busting,
  karena file ini tidak punya entri no-cache di `_headers`, yang termasuk area terkunci).
- `public/smartmoney.js`: sub-tab ke-4 `screener`, kontainer `#smmPgScreener`, `setSub()`
  menerima `screener`, objek `screenerApi` (util + `getData`-terkait + `openStock`),
  `openCodeFromSearch()` (cari kode di Screener: kalender ikut saham, tampilan lain pindah ke
  Broker Activity), entri menu avatar "Screener". Tidak ada perubahan di index.html / _headers.

## Tampilan (tab di dalam Screener)
1. Today: tanggal ‹ ›, KPI, Associate broker & holder searah, kartu Setup Preset + akurasi
   (backtest 10 hari vs rata-rata semua saham, ±3 bulan).
2. Gems: skor 0-100 + tier, 3D trend, harga, RSI-14, Stoch %K, regime, evidence, 8 preset.
3. Accumulation: Positioning 6 bln (floor, PnL, net lot/val, trend, days, TRAPPED) + panel
   filter/quick preset; Daily Flow 10 hari (heatmap).
4. Smart Money: Nampung Retail (SM net beli & ritel net jual) dan Smart Money P&L, rentang tanggal.
5. Broker & Holder: Associate broker (balik arah), holder >5%, insider lintas saham.
6. Foreign: Flow Intensity (skor, intensitas, float%, konsisten, akselerasi, KSEI) + Radar Top 20.
7. Kalender: heatmap net harian per bulan per saham / kelompok / broker, detail per hari.
Setiap tampilan punya tombol Cara pakai & Manfaat (terbuka otomatis pada kunjungan pertama,
`localStorage.sx_seen_*`). HP ≤640px: tabel diganti kartu; Accumulation filter jadi lipatan.

## Data
- Harga & teknikal ASLI dari `/ohlc.json` (±140 hari bursa), nama/sektor/mcap dari `DATA`.
- Arus broker/asing/ritel/insider/holder = dummy deterministik (`simulate()`), kecuali saham di
  index R2 → `applyReal()` dari `/api/admin/smartmoney` (maks 150 saham, 4 paralel), ditandai ●.
- Ritel = `RETAIL` (YP, XL, PD, XC, KK, CP, EP); smart money = broker lain.
- Dummy sengaja TIDAK melihat return masa depan, supaya akurasi preset di Today tidak menipu.

## Revisi: tata letak Insider & Kepemilikan (tanpa ruang kosong)
- Kepemilikan: baris `.smm-grid` diganti `.smm-hocols` (2 kolom flex, tinggi disamakan).
  Kiri: Komposisi → Pemegang terkini → Dewan (`#smmHoBoard`, `.smm-fill`).
  Kanan: Tren 12 bln → Jumlah pemegang → Profil (`#smmHoCompany`, `.smm-fill`).
  Kartu terakhir tiap kolom mengisi sisa tinggi. ≤1099px: satu kolom, urutan via `order`.
  `renderHoProfile()` sekarang mengisi `#smmHoBoard` dan `#smmHoCompany` (bukan `#smmHoProfile`).
- Insider: grafik 380→270px (tablet 250, HP 220). Tablet: Analisis pindah sejajar "Orang dalam",
  Per bulan/tahun lebar penuh di bawah. Analisis + total nilai beli/jual/rata-rata; kotak Orang dalam
  + total kepemilikan & jumlah orang dalam (rata bawah).

## Revisi 2: Insider grafik 2 kolom
- `.smm-ins-row`: grafik (kolom lebar) + "Orang dalam" (`#smmInsHolders`, 340px; 280px di ≤1099px).
  Kotak Orang dalam dibungkus `.smm-ins-sidewrap` (position:relative) dan isinya absolute,
  jadi tingginya MENGIKUTI grafik; daftar panjang (data asli bisa puluhan orang) di-scroll di
  `.smm-ins-list`. ≤640px: ditumpuk, maks 360px.
- `.smm-ins-mid`: Buy record · Kualitas timing · Analisis (3 kolom), Per bulan/tahun lebar penuh.
  641-900px: 2 kolom, Analisis lebar penuh. Tiap kotak punya ringkasan `.smm-ins-foot` rata bawah.
- Kualitas timing + rata-rata 1/6 bln setelah beli, 1 bln setelah jual, harga rata-rata beli.

## Revisi 3: data asli seluruh pasar lewat 1 file ringkasan
- `scripts/build-smartmoney-screener.js --dir <folder smartmoney> [--upload]` merangkum
  `broker/`, `insider/`, `holder/` per saham → `screener/summary.json` (format di header skrip,
  nilai Rp dalam satuan Rp1 jt, ±9 KB per saham). `--upload` menjalankan
  `npx wrangler r2 object put smartmoney/screener/summary.json --remote`.
  Jalankan SETELAH `upload_smartmoney.py` (repo private) setiap kali data diperbarui.
- Endpoint admin `GET /api/admin/smartmoney/screener` (src/lib/smartmoney.js) mengalirkan file itu
  apa adanya; tidak ada file → `{ok:true, summary:null}` → Screener tetap dummy.
- Frontend: `loadSummary()` → `applySummary()` untuk semua saham di file; `loadRealAll()` (per saham,
  maks 150) hanya untuk kode di index.json yang TIDAK ada di ringkasan.
- Batasan ringkasan: net harian per broker hanya 21 hari terakhir (cukup untuk Daily Flow, assoc
  broker 1M, kalender per broker bulan berjalan); total 6 bulan per broker utuh. Block Absorption
  belum punya data asli (butuh data pasar nego).
- `SCR_V` = 20261110b.

## Revisi 4: Kalender + grafik Broker Flow
- `.sx-cal-split`: kiri grafik (1,6 fr: candle harga + garis kumulatif net smart money / asing /
  ritel / broker terpilih, `buildCalChart()` dengan lightweight-charts), kanan kalender (1 fr).
  ≤1099px ditumpuk. Grafik menampilkan bulan terpilih + 2 bulan sebelumnya; klik grafik memilih
  tanggal di kalender, tanggal terpilih diberi panah. `SCR_V` = 20261110c.

## Revisi 5: Kalender pindah ke Broker Activity
- Tampilan Kalender DIHAPUS dari Screener (sekarang 6 tampilan). Kalender flow ada di
  `smartmoney.js`: `.smm-flowrow` = Broker Flow (1,6 fr) + `#smmCalCard` (1 fr), ≤1099px ditumpuk.
- `renderCal()` dipanggil di akhir `renderAction()`. Data dari `getData()` (sama dengan grafik),
  ikut filter investor (`S.inv`). Kelompok: smart money (non-`RETAIL`), ritel, asing, atau 1 broker.
- Ketuk tanggal (`data-act="calday"`) → `S.actEnd` → Broker Action & Distribution pindah ke hari itu;
  bulan kalender mengikuti `S.actEnd` (‹ › untuk pindah bulan manual). `SCR_V` = 20261110d.
