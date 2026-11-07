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

## Revisi: dipecah jadi 2 halaman
- Bar lengket (`#smmBar`, kode saham + sub-tab) → **Broker Activity** (`#smmPgBroker`) dan
  **Insider** (`#smmPgInsider`). Pilihan terakhir disimpan di `localStorage.smm_sub`.
- Halaman tersembunyi ditandai `_dirty` dan baru dirender saat dibuka (grafik butuh ukuran nyata).
- `#page-smartmoney` memakai `overflow-x:clip` karena `overflow:hidden` bawaan `.page` mematikan sticky.
- HP: tabel insider diganti kartu (`.smm-icards`), kolom lot Broker Action disembunyikan ≤480px,
  sankey 5 broker per sisi. Tab nav jadi ikon saja di layar <1280px.
- Header situs (nav-tabs) sudah overflow di tablet ±820px sejak sebelum menu ini; belum disentuh (area inti).

## Data
Semua dummy deterministik dari `generate(code)` (seed = kode saham, tanggal akhir `END_DATE`).
Saat data asli siap: ganti `generate()` dengan fetch ke endpoint `/api/admin/...` (gating di server),
pertahankan bentuk objek `{days, ohlc, value, off, brokers[{bv,sv,bl,sl,f,type}], insiders, trades, sharesOut}`.

## Revisi: data asli dari R2 (bucket `smartmoney`)
- `wrangler.toml` binding `SMARTMONEY` → bucket `smartmoney` (deploy sukses 0342f84fe).
- Endpoint admin: `GET /api/admin/smartmoney?code=KODE` → `{broker, insider}`,
  `GET /api/admin/smartmoney/index` → `{index:{codes}}` (`src/lib/smartmoney.js`, dipanggil dari `admin.js`).
- Isi bucket diunggah dari laptop oleh `upload_smartmoney.py` (repo private `wraping-target-price`);
  kunci R2 ada di `.env` laptop, TIDAK di repo. Format file dijelaskan di docstring script dan
  di komentar `adapt()` pada `public/smartmoney.js`.
- Frontend: `getData(code)` = data asli kalau ada, selain itu `generate()` dummy (badge "Data dummy").
  Panjang data per saham dinamis (`g.nP`, `g.nF`, `g.end`). Tanpa kolom asing → filter investor dimatikan.
  Saham tanpa data broker → halaman Broker menampilkan kotak kosong.
