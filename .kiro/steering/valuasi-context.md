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
3. **Konvensi unit (KOREKSI dari user, sesi terbaru):** **share outstanding TETAP
   angka penuh** (tidak dibagi 1.000.000). Yang dibagi 1.000.000 (→ disajikan dalam
   **juta**) adalah **pendapatan, laba bersih, dan ekuitas**. Catatan: mesin
   **membaca eps/sps/bvps langsung dari sheet** (baris 25/27/32), bukan menghitung
   manual via pembagian, sehingga `valuation.json` TIDAK terpengaruh konvensi ini
   (nilai per-lembar sudah cocok 100% dgn sumber). Implikasi hanya pada TAMPILAN
   (chart pendapatan/laba/ekuitas pakai satuan juta; market cap pakai shares penuh).
4. **Rumus growth tahunan (DIKONFIRMASI benar):** `eps_growth_annual` &
   `sps_growth_annual` = `(nilai annual th terakhir − th sebelumnya) / th sebelumnya`.
   Sudah diimplementasikan persis di `five_year_valuation` (BBRI: EPS −5,49%, SPS +4,27%).
5. Boleh menambahkan popup/info modal di UI bila informasinya penting.

## PR terkait
- **PR #166** — mesin valuasi (build-valuation.py) + valuation.json + UI valuasi
  data-driven. Branch `feat/valuation-fase-1`.
- **PR #167** — workflow `.github/workflows/refresh-valuation.yml` (auto-rebuild
  valuation.json saat Excel di `data/valuation/` di-push; + manual dispatch).
  Branch `feat/valuation-workflow`. **Merge #166 dulu, baru #167.**

## Sub-menu UJI DATA — SELESAI (PR #169)
Sub-tab **🧪 Uji Data** sudah dibuat di dalam `#page-valuasi` (tab ke-6, setelah
Multiples). Mereplikasi 2 screenshot Excel BBRI jadi 1 halaman; semua angka =
output mesin kita untuk dibandingkan langsung dengan Excel.
- **Branch:** `feat/valuation-uji-data` · **PR #169** (target `main`).
- Blok yang dibuat: tabel periode, GROWTH & CAPITAL GAIN, ESTIMASI DIVIDEN YIELD,
  ACTUAL + Margin of Safety, COMBINE RETURN, baris harga (Price Now/High),
  tabel TTM multi-basis + mini "Sekarang", 3 chart (Pendapatan/Laba, Laba%/ROE,
  PBV/PER/PSR+BookValue).
- **Basis fleksibel:** toggle **Kuartal (Q1–Q4)** / **Tahunan** (4 th terakhir) —
  `window.vlUjiSetMode('quarter'|'year')`, default kuartal.
- **Sumber data (semua backend yang ada):**
  - Harga kuartalan dari `data.json.price_history` by label tanggal — cocok 100%
    dgn Excel: 4/30→3.850 (Q1), 7/31→3.710 (Q2), 10/31→3.980 (Q3), 3/31→3.330 (Annual).
  - Harga sekarang / %perubahan / harga tertinggi dari `data.json.live`.
  - Model 5-th, avg multiples, EPS/BVPS/SPS/DPR dari `valuation.json`.
- **Implementasi:** `vlUjiCalc(stock,win,basis)` = cermin `computeModel` yang
  di-parameter harga basis (untuk mengisi kolom per-kuartal/per-tahun). `renderUji()`
  + `buildUjiCharts()` dipanggil di dalam `renderAll()`. `init()` kini juga menyimpan
  `state.priceHist`. Tidak menyentuh area terkunci.

### TEMUAN UJI (untuk disetel berikutnya)
Mesin kita ≠ Excel pada sebagian sel (inilah gunanya halaman ini). Contoh BBRI
basis Q3 (3.980): **combine mesin 17,30% vs Excel 22,83%**; potensi 2025 mesin
~4.669 vs Excel 4.885. Indikasi: Excel tampak **PBV-dominan** (combine ≈ sub-model
PBV ~22,7%), sedangkan mesin membaur PBV 50%/PER 40%/PSR 10% (ter-dilusi). CAGR
relatif dekat (~9,7% vs 9,43%). Kandidat penyetelan: bobot model per sektor
(bank/finansial → PBV-dominan) di `build-valuation.py` + `computeModel`. Belum
diubah, menunggu keputusan user.

## Cara update data bulanan (untuk user)
Upload Excel ke `data/valuation/` via:
https://github.com/chamdani49-boop/terminal/upload/main/data/valuation
→ workflow refresh-valuation auto-rebuild valuation.json.
