# Rumus Valuasi Basis TAHUNAN — Halaman Valuasi → Ringkasan (TERKUNCI)

> Status: **FINAL / TERKUNCI**. Divalidasi 100% dengan template Excel pemilik
> (ANTM, basis 2025, Last 3.150). Berlaku untuk **SEMUA saham**. Mesin: blok
> `five_year_valuation` di `scripts/build-valuation.py` + `computeModel`/`vlUjiCalc`
> di `public/index.html`.

## 1. Sumber data
- Data tahunan penuh = **kolom I–Z** (I = tahun terbaru, mis. 2025). Dibaca ke
  `stock['annual']`.
- Kolom **H ("Thn Berjalan")** → `annualized`, **TIDAK** dipakai untuk model tahunan.

## 2. Rata-rata multiple (mesin yang hitung — tidak ada di Excel)
- **PBV / PER / PSR** = rata-rata aritmetika **N tahun terakhir** dari kolom I–Z,
  untuk window **3 / 5 / 7 / 10** (inklusif tahun terbaru).
  - Validasi ANTM (window 5 = 2021–2025): PBV **1,85** · PER **15,08** · PSR **0,97**.
- **DPR = TIDAK dirata-rata** → pakai **DPR tahun terbaru** (ANTM 2025 = **70%**).

## 3. Per-share (EPS/SPS/BVPS)
- **EPS = nilai kolom EPS sumber laporan** (ANTM 2025 = **299,98**), dipakai untuk
  **proyeksi PER DAN dividen** (keputusan terkunci: 1 EPS untuk semua).
  - JANGAN pakai Profit÷Shares (311,58) — itu bikin DPR & EPS tidak sepasang.
- SPS, BVPS = nilai kolom (3.522,37 / 1.468,88).

## 4. Growth
- 5 Tahun: `roe_5y`, `eps_growth_5y`, `sps_growth_5y` dari kolom (ANTM: 31,95% /
  44,37% / 25,33%).
- Annual: `(nilai_terbaru − sebelumnya) / sebelumnya` (ANTM EPS 97,65% · SPS 22,33% ·
  ROE annual 20,46%).
- **Blend: g = 0,8 × (5 Tahun) + 0,2 × (Annual)**
  → g_bv 29,65% · g_eps 55,03% · g_sps 24,73%.

## 5. Sub-model PBV / PER / PSR
- value(t) = base × (1 + g)^t ; price_target(t) = value(t) × rata-rata multiple
- base: PBV←BVPS, PER←EPS, PSR←SPS ; t = 1..5
- Bobot blend: **PBV 50% / PER 40% / PSR 10%** (dinormalisasi ke sub-model valid)

## 6. Combine, dividen & target
- `blend_annual` = Σ bobot × (gl_5y ÷ 5)
- `CAGR` = Σ bobot × cagr sub-model  (ANTM 30,28%)
- `Dividen Yield` = **DPR(terbaru) × EPS ÷ Harga_Basis**  (ANTM 0,70 × 299,98 ÷ 3.150 = **6,67%** → DPS 209,99 = dividen riil)
- `FutureValue` = blend_annual + Dividen Yield  (ANTM ≈ 127,6%)
- **Combine = (FutureValue + CAGR) ÷ 2**  (ANTM ≈ **78,9%**)
- **Target(n) = Harga_Basis × (1 + (Combine + Dividen Yield) × n)**, n=1..5
  → ramp ANTM ≈ 85,6%/th ; Target ≈ **5.847 / 8.524 / 11.201 / 13.878 / 16.632**
- `Margin of Safety` = Σ bobot × mos sub-model (ANTM ≈ 78%)

## 7. Override
- `data/valuation/overrides.json` dikosongkan. Tidak ada override; semua saham
  dihitung seragam dengan rumus di atas.

## 8. Validasi acuan (ANTM, Last 3.150)
Combine 78,9% · CAGR 30,28% · MoS ~78% · Target Th-1 ≈ 5.847 … Th-5 ≈ 16.632.
(Catatan: nilai tersimpan di JSON memakai harga LIVE sebagai basis "saat ini";
tab "2025" memakai harga 3.150 → hasil di atas.)
