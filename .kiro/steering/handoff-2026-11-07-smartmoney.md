---
inclusion: manual
---

# Handoff 7 Nov 2026: menu Smart Money (admin only, data dummy)

Permintaan user: menu baru "Smart Money" (pergerakan uang besar, insider, broker activity),
khusus admin, data dummy dulu, langsung di `main`. Commit `1a11559e5`.

## File
- `public/smartmoney.js` (baru, mandiri). Satu baris `<script src="/smartmoney.js" defer>` di `index.html`
  dan entri no-cache di `public/_headers`. Kode menu inti tidak diubah.
- Halaman `#page-smartmoney`, tab nav `.smm-nav`, `#bn-smartmoney`, dan grup menu avatar disuntikkan JS
  HANYA jika `window.__ES_IS_ADMIN === true` (polling setelah `/api/me`). Navigasi pakai `showPage()`.

## Isi halaman
Skor Smart Money 0-100 (45% bandar, 30% asing, 25% insider 6 bln), Radar 16 saham, Broker Flow
(lightweight-charts: candle + kumulatif net per broker, chip tambah/hapus), Broker Action (meter
Big Dist–Big Acc, tabel net/gross, tanggal & rentang), Broker Distribution (sankey SVG), Insider
(grafik + marker beli/jual, buy record, per bulan/tahun, tabel IDX/KSEI), glosarium.

## Data
Semua dummy deterministik dari `generate(code)` (seed = kode saham, tanggal akhir `END_DATE`).
Saat data asli siap: ganti `generate()` dengan fetch ke endpoint `/api/admin/...` (gating di server),
pertahankan bentuk objek `{days, ohlc, value, off, brokers[{bv,sv,bl,sl,f,type}], insiders, trades, sharesOut}`.
