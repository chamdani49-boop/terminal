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
3. **Konvensi unit (KOREKSI terbaru dari user):** **pendapatan, laba bersih,
   ekuitas, DAN share outstanding semuanya dibagi 1.000.000** (disajikan dalam
   **juta**) di sheet Excel user. Implikasi ke mesin: eps/sps/bvps = rasio
   (mis. laba ÷ saham), sehingga faktor 1.000.000 di pembilang & penyebut
   **saling meniadakan** → nilai per-lembar identik. Selain itu mesin **membaca
   eps/sps/bvps langsung dari sheet** (baris 25/27/32), jadi `valuation.json`
   TIDAK terpengaruh konvensi ini. Yang perlu konsisten hanya TAMPILAN (chart
   pendapatan/laba/ekuitas → satuan juta). Market cap = harga × shares (absolut,
   tak terpengaruh konvensi unit selama konsisten).
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

### FORMULA MODEL 5-TAHUN — FINAL & TERVALIDASI (uji ANTM 2025, PR #170)
Dibongkar dari sheet Excel ANTM pemilik (kuning=input, sisanya rumus). Mesin kita
kini **100% cocok** bila input sama. Urutan rumus:
1. Per-share: `BV=Equity/Shares`, `EPS=Profit/Shares`, `SPS=Revenue/Shares`
   (semua nilai juta; shares juta — faktor 1.000.000 saling meniadakan).
2. Growth blend tiap sub-model: `g = 0.8×(growth 5th) + 0.2×(growth tahunan)`.
   ROE blend untuk PBV. (ANTM: gPBV 29.65%, gEPS 55.03%, gSPS 22.93%).
3. Proyeksi 5 th: `FutureValue_t = base×(1+g)^t`; `FuturePrice_t = FV_t × avgMultiple`.
   `avgMultiple` = rata-rata PBV/PER/PSR **window terpilih (default 5th)**.
4. Kesimpulan tiap sub-model:
   - `G&L Potential = (FuturePrice_5 − Last)/Last`
   - `Annual = G&L Potential / 5`
   - `Margin of Safety = 1 − Last/FuturePrice_5`
   - `CAGR = (FV_5 / FV_1)^(1/5) − 1`
5. Blend 3 sub-model bobot **PBV 0.5 / PER 0.4 / PSR 0.1** untuk Annual, CAGR, MoS.
6. **Dividen:** `DPR = rata-rata DPR 5th`; `Est Dividen = DPR×EPS`; `Dividen Yield = Est Dividen/Last`.
7. **POTENSI AKUMULASI:**
   - `Future Value = blendAnnual + Dividen Yield`  ← dividen MASUK di sini.
   - `CAGR = blendCAGR` ; `Margin of Safety = blendMoS`.
   - `Combine = (Future Value + CAGR)/2`.
   - `Potensi Price(n) = Last × (1 + (Combine + Dividen Yield) × n)`, n=1..5
     (ramp = **Combine + Dividen Yield**; dividen ikut di FutureValue DAN di ramp,
     sesuai sheet Excel ANTM terbaru). `Potensi G&L = (Potensi_5 − Last)/Last`.
Hasil uji ANTM (sheet terbaru, input: ROE5y 16.04% / EPSg5y 15.50% / SPSg5y 7.91% /
EPSgAnn 92.35% / SPSgAnn 22.33% / DPR 71.41% / avgPBV 1.76 PER 14.21 PSR 1.27 /
last 3150): FutureValue 53.57% · Combine 35.35% · CAGR 17.12% · MoS 61.48% ·
Potensi 4.486→9.829 · Potensi G&L 212.04% — semua cocok 100%.
(Catatan: screenshot ANTM versi PERTAMA pakai ramp=Combine saja & input growth beda;
versi TERBARU inilah yang dipakai: ramp = Combine + Dividen Yield.)
**Diterapkan di** `build-valuation.py`, `computeModel` & `vlUjiCalc` (index.html).

### PRINSIP: utamakan nilai dari FILE SUMBER, bukan hitung ulang
Metrik berikut SUDAH ADA di file sumber (sheet laporan) dan WAJIB dipakai apa adanya
(mesin sudah membacanya via ROW_METRICS), JANGAN dihitung ulang dari pembagian
(share outstanding di sheet dibulatkan → hasil bisa beda; nilai konkret ada di sumber):
ROE, ROE 5th, EPS (Annual), EPS Growth 5th, SPS, SPS Growth 5th,
Book Value/Share (Annual), PBV (Annual), PER (Annual), PSR (Annual),
Net Income–Payout Ratio (DPR), Dividen/EPS-Div (TTM).
Yang BOLEH dihitung mesin (tidak ada di sumber): EPS Growth (Annual) & SPS Growth
(Annual) = `(thn terakhir − thn sblm)/thn sblm`; serta rata-rata multiple
(PBV/PER/PSR/DPR) per window = rata-rata nilai tahunan sumber.

### Catatan data sumber
- Data ANTM di `valuation.json` saat ini masih dari batch lama (eps 299.98 vs 311.6
  Excel, bvps 1468.88 vs 1523, dpr 0.74 vs 0.7141) → menunggu upload Excel **2025
  ANTM** dari user agar angka konvergen penuh. Saat upload, perhatikan apakah baris
  EPS/BVPS di sheet = Profit/Shares & Equity/Shares (Excel menghitung begitu);
  bila baris sheet beda, pertimbangkan **menghitung** eps/sps/bvps dari
  ni/rev/equity ÷ shares ketimbang membaca baris per-share.

## Sub-menu UJI DATA — SELESAI (PR #169, merged)
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



## HANDOFF SESI (16 Jun 2026) — status tab "Uji Data" & 2 isu terbuka

### Status PR (sudah merge ke main): #166–#178
- Formula model 5-th sudah TERVALIDASI 100% vs Excel pemilik (uji ANTM) bila
  input dipersiskan. Rumus final (sumber: workbook `data/baru dari Template Future Value.xlsx`):
  - per sub-model (PBV/PER/PSR): `g=0.8*growth5y+0.2*growthAnnual`; `FV_n=base*(1+g)^n`;
    `FuturePrice_n=FV_n*avgMultiple`; `G&L=(FP5-Last)/Last`; `Annual=G&L/5`;
    `MoS=1-Last/FP5`; `CAGR=(FV5/FV1)^(1/5)-1`.
  - akumulasi: `FutureValue=0.5*Ann_PBV+0.4*Ann_EPS+0.1*Ann_SPS + DividenYield`;
    `CAGR=0.5/0.4/0.1 blend`; `Combine=(FV+CAGR)/2`; `MoS=0.5/0.4/0.1 blend MoS`;
    `Potensi(n)=Last*(1+Combine*n)` (ramp = COMBINE SAJA).
  - Verifikasi ANTM (input Excel): FV 176.56% · CAGR 34.54% · Combine 105.55% ·
    MoS 80.44% · Potensi 6.475/9.800/13.124/16.449/19.774. SEMUA match.

### ISU TERBUKA 1 — Layout tab Uji Data "gak beraturan"
PR #177 (tombol "Basis Data": Tahun Berjalan·Q1 + 2025/2024/…) DAN #178 (layout
gambar: GROWTH & CAPITAL GAIN + ACTUAL + COMBINE RETURN + MARGIN OF SAFETY)
**dua-duanya ter-merge** → blok bertumpuk & kolom flex (`uj-row`/`uj-col`,
flex-basis 1.2/1.7) tidak rata. PERLU: rapikan jadi grid rata. Layout target (dari
gambar terbaru user):
- Baris 1: `[kode+Dividen]` `[GROWTH & CAPITAL GAIN]` `[ACTUAL]`
- Baris 2: `[COMBINE RETURN]` `[MARGIN OF SAFETY 80.44% besar]`
- Pertahankan tombol "Basis Data" (user memakainya), tapi tata 1 baris rapi.
- ACTUAL: Sekarang(live) + Q3(closing 10/31 dari price_history); Potensi=Q3*(1+Combine*n);
  %vsSekarang & %vsQ3; footer MoS per harga. Tombol "Last Price" sudah dihapus (benar).

### ISU TERBUKA 2 — tombol "2025" ≠ Excel (PENTING)
User klik "2025" → angka beda dari Excel; klik "Preset" → sama. Penyebab
(sudah didiagnosa):
1. **Per-share STALE di valuation.json**: baris EPS/BVPS dari sheet sumber dihitung
   dgn jumlah saham beda. ANTM: EPS tersimpan 299.98 & BVPS 1468.88, padahal
   Excel = NI/shares = **311.58** & Equity/shares = **1523** (SPS 3522 sudah cocok).
   → FIX: di `build-valuation.py` & `computeModel`/`vlUjiCalc`, HITUNG per-share dari
   mentah: `eps=net_income/shares`, `bvps=total_equity/shares`, `sps=total_revenue/shares`
   (pakai field `shares` baris 21 yg = angka Excel). Ini juga membetulkan
   `eps_growth_annual` → 92.35% (cocok Excel) krn eps2024=NI/sh=161.99.
2. **Avg multiple beda**: Excel PBV 1.76 / PER 14.21 / PSR **1.27** (input manual,
   "rata-rata 5th"); mesin (recompute dari raw) 1.825 / 13.987 / **0.973**. PSR jauh.
   Metodologi rata-rata user belum diketahui (window/tahun mana, harga akhir-thn vs rata2,
   apakah termasuk tahun berjalan). PERLU klarifikasi user ATAU upload data sumber benar.
3. **`sps_growth_5y` field beda**: mesin 25.33% vs Excel 97.65% (sumber stale).
4. **AKAR**: file sumber `data/valuation/valuation-batch-01.xlsx` masih BATCH LAMA.
   Solusi tuntas: user upload Excel data keuangan ANTM 2025 terbaru ke
   `data/valuation/` → workflow refresh-valuation → regenerate → "2025" match.

### Apa itu tombol "Preset Excel ANTM"
Tombol uji yg meng-OVERRIDE semua input dgn nilai PERSIS dari sheet Excel ANTM
(eps 311.58, bvps 1523, sps 3522.37, roe5y 31.95%, epsG5y 44.37%, epsGann 92.35%,
spsGann 22.33%, spsG5y 97.65%, DPR 71.41%, avgPBV 1.76/PER 14.21/PSR 1.27, last 3150).
Gunanya: membuktikan FORMULA benar (hasil = Excel). Begitu isu #2 (per-share + avg
multiple + sumber data) beres, "2025" akan = preset dan tombol preset bisa dihapus.

### LANGKAH BERIKUTNYA (urut)
1. Rapikan layout tab Uji Data (grid rata; pertahankan tombol Basis Data).
2. `build-valuation.py`: per-share = flow/shares (regenerate valuation.json) →
   eps/bvps/eps_growth_annual ANTM jadi cocok Excel. Frontend `vlUjiCalc`/`computeModel` ikut.
3. Klarifikasi metodologi AVG multiple ke user (atau minta upload data sumber 2025).
4. Catatan: `ujBasisInputs()` di index.html sudah memetakan basis→input; saat per-share
   dihitung dari mentah, pastikan basis "2025" pakai eps=NI/sh dst.
