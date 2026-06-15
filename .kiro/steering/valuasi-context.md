---
inclusion: always
---

# Konteks Fitur Valuasi Saham (Handoff antar-sesi)

Dokumen ini merangkum seluruh kerja & keputusan fitur **Valuasi Saham** agar sesi
baru langsung paham konteks tanpa mengulang dari nol. Bahasa: semua respons ke
user dalam **Bahasa Indonesia**.

## Tujuan
Membangun mesin valuasi saham (DCF, DDM, dan **model 5-tahun multiples milik user**)
dari data laporan keuangan Excel, lalu menampilkannya di menu **Valuasi** pada UI.
Tahap sekarang = **testing dengan 5 saham** (AADI, AALI, ANTM, BBCA, BBRI).

## Arsitektur repo (penting)
- Situs statis HTML/JS (Chart.js) + data JSON statis. Pola: tiap fitur = pipeline
  sendiri (build script → JSON di `public/` → halaman di `public/index.html`).
- **Area TERKUNCI** (lihat `.kiro/steering/protected-areas.md`): menu Dashboard,
  Simulasi (menabung), Consensus; `scripts/build-data.js`; `public/data.json`;
  `lib/static.json`; fungsi inti (showPage, renderDashboard, buildConsensus*).
  Fitur valuasi dibuat TERPISAH dan TIDAK menyentuh area ini.
- Sandbox: `INTEGRATIONS_ONLY` (tanpa internet untuk pip/npm). Karena itu parser
  Excel ditulis **pure Python stdlib** (zip + xml), tidak butuh openpyxl.
- Git: pakai tool sandbox (github power) untuk pull/push/PR. JANGAN `git push`
  langsung. Push ke branch baru, jangan ke main, kecuali diminta.

## Data sumber
- File Excel ada di `data/valuation/` (mis. `valuation-batch-01.xlsx`).
  Rencana produksi: 1 file = 100 sheet (1 sheet = 1 kode saham), jadi 950 saham
  ≈ 10 file. Parser scan SEMUA `*.xlsx` di folder itu.
- Layout tiap sheet tetap, range A1:Z40. Kolom: C=nama metrik, D=Q1, H="tahun
  berjalan" (= **Q1×4 / run-rate, BUKAN TTM** — keputusan user: pakai apa adanya),
  I..Z = data tahunan (label "12M YYYY" di baris 18). ~27 metrik per periode.
- File rumus user: `docs/Template Alokasi(2).xlsx` (sheet "Saham" = model 5-tahun,
  sheet "Alokasi" = tracker portofolio, DI LUAR scope valuasi).

## Pipeline yang sudah dibuat
- **`scripts/build-valuation.py`** → tulis **`public/valuation.json`**.
  - Parse semua sheet → `stocks[KODE]` = { q1, annualized, annual:{YYYY:{...}} }.
  - Bersihkan `#VALUE!`, `Libur`, tanggal serial Excel.
  - Ambil **beta** dari `public/data.json` (`stats[kode].beta`) untuk WACC, dan
    **harga live** dari `data.json` `live[kode].price` (fallback ke harga Excel).
  - Hitung **WACC (CAPM)**, **DCF FCFF 2-tahap**, **DDM 2-tahap** (cross-check),
    dengan pemilihan metode per sektor (bank → DCF FCFF dimatikan).
  - Hitung **model 5-tahun milik user** (`five_year`): 3 sub-model
    BV×PBV (bobot 50%), EPS×PER (40%), SPS×PSR (10%). Growth tiap sub-model =
    `0.8×(growth 5th dari data) + 0.2×(growth tahunan)`. Combine=(FutureValue+CAGR)/2,
    + Dividend Yield (DPR×EPS/harga) + Margin of Safety. Target harga 5 th = akumulasi
    linear `harga×(combine+divyield)×n + harga`.
  - **AVG PBV/PER/PSR/DPR** dihitung untuk window **3/5/7/10 tahun** (default 5).
  - Emiten baru listing tanpa histori 5 th (mis. AADI) → `five_year.applicable=false`.

## UI (sudah disinkronkan)
- Halaman `#page-valuasi` di `public/index.html` (TIDAK terkunci) sudah **data-driven**
  dari `valuation.json` (modul JS IIFE ber-namespace `vl*`). Fitur:
  dropdown pilih emiten, segmented window 3/5/7/10 th (hitung ulang model client-side,
  identik dgn backend saat window=5), harga live, tab Ringkasan/Fundamental/Proyeksi/
  Dividen/Multiples. Pola fetch: jsDelivr CDN → same-origin fallback.

## Keputusan kunci dari user
1. "Tahun berjalan" dipakai **apa adanya** (Q1×4), bukan TTM.
2. ROE 5th / EPS growth 5th / SPS growth 5th diambil dari **field data** (kolom
   tahunan, bukan Q1). DCF & DDM dibuat profesional oleh agent.
3. **Divisor share outstanding** di rumus Excel (B3/C3 ÷ 1.000.000) hanya untuk
   menghitung EPS/SPS/BVPS manual di Excel. **Tidak diterapkan di mesin** karena
   valuation.json sudah punya eps/sps/bvps per-lembar dari sumber (hasil cocok 100%).
4. Boleh menambahkan popup/info modal di UI bila informasinya penting.

## PR terkait
- **PR #166** — mesin valuasi (build-valuation.py) + valuation.json + UI valuasi
  data-driven. Branch `feat/valuation-fase-1`.
- **PR #167** — workflow `.github/workflows/refresh-valuation.yml` (auto-rebuild
  valuation.json saat Excel di `data/valuation/` di-push; + manual dispatch).
  Branch `feat/valuation-workflow`. **Merge #166 dulu, baru #167.**

## TUGAS BERIKUTNYA (belum selesai) — "Sub-menu UJI DATA"
User minta membuat **sub-halaman "Uji Data"** di dalam menu Valuasi untuk
memvalidasi data & mesin agar **sama persis dengan hasil Excel user**. Acuan = 2
screenshot Excel (BBRI/bbri) yang berisi (gabung jadi 1 halaman):
- Tabel kuartal (Q1–Q4: tanggal, harga, nama) + header emiten (kode, harga, %).
- Blok **GROWTH & CAPITAL GAIN** (Tahun 2025–2029: Potensi Price, %).
- Blok **ESTIMASI DIVIDEN YIELD** (DPS, yield, DPR%, "x", Th Balik Modal, Market cap).
- Blok **ACTUAL** (G&L vs Potensi Price per tahun) + **MARGIN OF SAFETY** besar.
- Blok **COMBINE RETURN** (Future Value, CAGR, Combine, Dividen Yield).
- Baris "Harga Saat analisa / Price Now / Price High".
- Tabel **TTM** (basis Q1/Q2/Q3/Annual → Potensi Price & G&L per tahun 2025–2029,
  + MARGIN OF SAFETY per basis).
- 3 chart (sudah ada di tab Ringkasan, bisa direuse): Pendapatan/Laba+LastPrice;
  Laba%/ROE+LastPrice; PBV/PER/PSR+BookValue.
Tujuan visual ini HANYA untuk uji data (nanti tidak dipakai), jadi buat **sama persis
gambar**. Backend WAJIB dari data yang sudah ada (`valuation.json` + `data.json`).
Catatan: layout Excel berbasis kuartal (Q1/Q2/Q3/Annual); data kita saat ini punya
`q1`, `annualized`, dan `annual`. Perlu klarifikasi/mapping basis kuartal Q2/Q3 bila
diperlukan (data sheet baru hanya Q1). User akan mengirim ulang 2 gambar acuan.

## Cara update data bulanan (untuk user)
Upload Excel ke `data/valuation/` via:
https://github.com/chamdani49-boop/terminal/upload/main/data/valuation
→ workflow refresh-valuation auto-rebuild valuation.json.
