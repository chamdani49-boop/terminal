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
