---
inclusion: manual
---

# Handoff — Sesi 25 Juli 2026 (siang-malam) — Analis Page Charts & Period Preset

## Konteks

Sesi ini fokus di **halaman Analis (firm profile)** — 2 tema besar:

1. **Period preset di kolom tanggal Mode Eksekusi** — copy pattern dari Overview (Performa 30 Hari) supaya konsisten
2. **Chart "Return Kumulatif" evolution** — banyak eksperimen konsep (baseline normalize, indexed price, NAV Reksadana Virtual), akhirnya **dihapus** dan return IHSG di-merge ke chart "Grafik Performa Analis 30 Hari"

Kondisi akhir: **working tree clean, main up-to-date**.

## Yang selesai & di-deploy ke main (commit HEAD `260c198`)

### 1. Period preset di header Mode Eksekusi (`c6a89ad`, `3eddd81`)

Header Mode Eksekusi punya kolom tanggal `📅 Semua Tanggal ▾`. Tambahin **period preset**:

```
[30D] [Bulan Ini] [Bulan ▾] [Tahun ▾]
```

**Iterasi 1** (`c6a89ad`): preset di row terpisah di samping kalender button — user komplain crowded.

**Iterasi 2** (`3eddd81`) — **FINAL LAYOUT**: preset dipindah **KE DALAM popup kalender** (di atas grid kalender). Header ringkas kembali: cuma `[📅 30 Hari Terakhir ▾]`.

**Behavior**:
- **Default firm-open**: preset `30D` aktif (bukan lagi "Semua Tanggal") → semua KPI card + chart + rec list default filter 30 hari terakhir.
- **Preset & custom range di kalender MUTUALLY EXCLUSIVE** — pilih preset auto-clear pilihan kalender custom, pilih kalender OK matikan preset.
- **Reset "🌐 All"** di kalender → kembali ke "Semua Tanggal" (tanpa preset).
- **Label tombol kalender** ikut preset: "30 Hari Terakhir", "Bulan Ini (Juli)", "Juli 2026", "Tahun 2026", atau range dates untuk custom.
- **Dropdown Tahun** di-populate dari `openDate` rec firm aktif + current year.
- **Klik preset TIDAK menutup popup** (biar user bisa eksplorasi cepat).
- **Snap kalender** ke bulan awal range preset saat preset di-klik.
- **Auto-refresh calendar highlight** saat preset berubah (via `renderCalendar()`).

**Semua panel Analis re-trigger** oleh perubahan period:
- KPI card (winrate, net, floating, best, worst, TOTAL REKOMENDASI dgn breakdown)
- Chart Grafik Performa Analis 30 Hari
- List Rekomendasi Sekuritas (semua tab)

**File**: `public/index.html` — HTML di `.tr-pf-seg-head`, state `_pfPeriod` di Analis IIFE (line ~7797), helper `_pfComputePeriodRange` / `_pfPeriodLabel` / `_pfPopulateYearDropdown` / `_pfSyncPeriodUI` / `_pfApplyPeriod`, click/change handlers via delegation.

**CSS**: `.tr-chart-period.tr-pf-cp-inpopup` — grid 2-kolom kompak di dalam popup 290px width. Background `--bg2` untuk framing.

### 2. Chart evolution — dari "Return Kumulatif %" → "NAV Reksadana Virtual" → **dihapus** (`bc90e15`, `2aa49d8`)

Awalnya chart card "Return Kumulatif · Simulator Eksekusi" pakai formula ARITHMETIC SUM `%`:
```
cum[t] = Σ pnl_i untuk semua rec dgn exitDate ≤ t
```

**Iterasi eksplorasi (semua akhirnya reverted):**

- (a) **Baseline normalize ke periode start** (`d65b4fb` → revert `bc90e15`): fix IHSG normalize ke tgl awal periode (bukan lagi series30d[0]) + Y=0 baseline emphasized + format `+X% / -X%`. User tidak suka.

- (b) **Indexed price mode** (`4fff926` → revert `f94023a`): IHSG raw price + firm indexed dari base IHSG. Style "$100 invested". User tidak suka (formula tidak intuitif).

- (c) **NAV Reksadana Virtual** (`807d02a` → dihapus `2aa49d8`): compound daily NAV dgn equal-weight allocation, idle cash parkir IHSG, base Rp 1.000. Butuh OHLC loaded via `window.__OHLC_loadAll`. User bilang **hapus saja seluruh chart card ini**.

**Design decision NAV yang tercatat** (untuk referensi kalau nanti dibutuhkan lagi):
| Aspek | Pilihan | Alasan |
|---|---|---|
| Alokasi | Equal-weight per rec aktif | Interpretasi lugas "ikut semua panggilan sekuritas modal sama tiap posisi" |
| Idle cash | Parkir IHSG | Mirror reksadana asli always-invested; jarak vertikal firm vs IHSG = pure alpha |
| Base NAV | Rp 1.000 | Konvensi NAB Awal reksadana Indonesia |
| Compound | NAV[t] = NAV[t-1] × (1 + R[t]) | Bunga majemuk (proper reksadana) |
| IHSG norm | Normalize ke Rp 1.000 juga | Apple-to-apple visual |

### 3. **FINAL**: Grafik Performa Analis 30 Hari dengan bar IHSG + tooltip (`2aa49d8`, `260c198`)

**Layout akhir**: 1 chart card full-width (dulu 2 cards side-by-side).

Chart card "Grafik Performa Analis 30 Hari" di-enhance dengan **3 series dalam 1 canvas** (Chart.js grouped bar + line):

| Element | Warna | Sumber data |
|---|---|---|
| Bar hijau/merah | `--green`/`--red` | P/L harian firm (`computeFirmDailyEquity`, per exitDate, sesuai mode eksekusi) |
| Bar abu semi-transparan | `--text2` alpha 0.35 | Return harian IHSG (**BARU**, dihitung dari `ihsg.seriesFull` daily close) |
| Line biru | `--blue` | Kumulatif firm (Y-axis kanan) |

**Tooltip on hover** (index-mode, hover di kolom tanggal manapun):
```
07-24
RHB Sekuritas: +5.87%
IHSG: -1.88%
RHB Sekuritas Kumulatif: +17.08%
3 trades · 2 win / 1 loss
```

**Migrasi**: vanilla canvas manual → Chart.js — grouped bar native + tooltip built-in.

**Formula IHSG daily return**:
```
r_ihsg[t] = (close[t] - close[t-1]) / close[t-1] × 100
```
di-map ke exit dates firm via `ihsgReturnByDate[dt]`.

### 4. Fix "IHSG 24 Jul kosong" — frontend fallback (`260c198`)

**Root cause diagnosis** (well-documented):
- `tracker.json.ihsg.seriesFull` diambil dari **Yahoo Finance `^JKSE` API** di `scripts/build-tracker.js:fetchIhsgDaily()`
- Yahoo return `null` untuk 24 Jul 2026 saat build-tracker.js jalan (bug/delay Yahoo, umum untuk IHSG)
- Buktinya bursa buka normal: `ohlc.json` punya close 24 Jul lengkap untuk BBCA, BBRI, BMRI, TLKM, ASII (bukan libur nasional — Idul Adha 2026 di 27 Mei, bukan Juli)
- Nilai IHSG 24 Jul sebenarnya = **6196.43** — di `data.json.live.IHSG.price` (source: Google Sheet Live tab, lebih fresh)
- Verifikasi: `6315.31 × (1 + (-0.0188)) ≈ 6196` → live price = close valid 24 Jul, drop -1.88% dari Kamis 23 Jul

**Frontend fix** di `renderDayChart` — cek gap antara `ihsg.date` terakhir dgn `data.json.live.IHSG`, append live price sbg close untuk hari terakhir. Tanggal di-inferred dari `data.json._meta.generated_at` (roll-back ke Jumat kalau weekend).

**Effect**: bar IHSG untuk 24 Jul sekarang tampil (~-1.88%).

## Data source inventory (audit dilakukan sesi ini)

### `public/ohlc.json` (3.3 MB)
- 957 tickers, 18 bulan back
- Format: `[timestamp_seconds, o, h, l, c]` per candle
- Source: Yahoo Finance (per ticker, individual API calls)
- **Coverage tickers rec: 100%** — 0 missing (`_diag.tickersMissingOhlc: []`)
- Access di frontend: `window.__OHLC_loadAll()` (exposed dari IIFE modal, reuse cache `_ohlcAll`)

### `public/tracker.json` (1.5 MB)
- `openList`, `historyList`, `pendingList`, `missedList`, `unfilledList` (rec detail)
- `byFirm[firm_id]` = agregat per firm + `recsActive/recsPending/recsMissed/recsHistory`
- `ihsg.seriesFull` = 58 daily close IHSG (Apr 24 - Jul 23) via Yahoo `^JKSE` — **bermasalah kadang miss latest**
- `ihsg.series30d` = 30 hari terakhir
- `dailyEquity` = 18 hari (global, semua firm)
- `since: 2025-07-15` — oldest rec date (rec 1 tahun kebelakang)

### `public/data.json` (2.9 MB)
- `live.IHSG.price` = live/latest close IHSG (biasanya lebih fresh dari tracker.json)
- `stats.IHSG.change_pct_live` = daily change %
- `price_history` = monthly close per ticker + IHSG (~10 tahun back, 121 rows)
- `_meta.generated_at` = timestamp build data.json (dari Google Sheet)

### `public/macro.json` (12 KB)
- `chart.series.IHSG` = monthly IHSG series (2016+, 118 titik)
- Untuk macro chart di Dashboard, tidak dipakai di Analis

## Existing computation (audit)

### `computeFirmDailyEquity` (Analis IIFE, line ~7797+)
- Return `[{date, trades, wins, losses, dayPnl, cumulative}]` per exitDate
- **Arithmetic sum** (bukan compound), unit percentage points
- Sliced ke 30 hari terakhir
- Filter via `_recInDateFilter` — respect `_dateFilter` range

### `_computeFirmDailyEquity` (Dashboard IIFE)
- Sama formulanya (arithmetic sum, per-exit-event)
- Aligned ke `timeline` (period-filtered dates)
- Return `[pct, pct, ...]`

### Yang **dihapus** sesi ini:
- `computeCumSeries` (arithmetic sum, per firm)
- `computeIhsgCumSeries` (IHSG % normalized to series30d[0])
- `alignSeriesToDates` (helper untuk union-align)
- `renderCumChart`, `_renderNavChart`, `_renderArithmeticChart` (chart renderers)

## Struktur file kunci

```
public/index.html
├── (line ~3196-3220)  CSS .tr-pf-daychart-wrap, .tr-pf-charts-row
├── (line ~3061-3098)  CSS .tr-chart-period (period selector reusable)
├── (line ~7460-7495)  HTML card Grafik Performa Analis (single, full-width)
├── (line ~7797)       IIFE Analis MAIN (7797 → ~9916)
│   ├── State: _entryMode, _exitMode, _currentTab, _dayChart, _pfPeriod, _dateFilter
│   ├── computeFirmDailyEquity (~line 8843)
│   ├── renderKpi, renderModeStats, renderDayChart, renderRecList
│   ├── Period preset helpers: _pfComputePeriodRange, _pfPeriodLabel, _pfSyncPeriodUI, _pfApplyPeriod
│   ├── Calendar: renderCalendar, applyCalRange, resetCalFilter, toggleCalPopup
│   └── Delegated click/change handlers (bottom of IIFE)
└── (line ~17669)      window.__OHLC_loadAll = loadOhlcAll (exposed dari top-level scope)
```

## Follow-up yang mungkin nyala di session berikutnya

### 1. Backend fix untuk Yahoo `^JKSE` delay (mediocre priority)

Sekarang kalau Yahoo delay, frontend punya fallback dari `data.json.live.IHSG`. Tapi cleaner kalau `scripts/build-tracker.js` sendiri handle:

```js
// Di fetchIhsgDaily() atau setelahnya:
// Kalau latest date di ihsgSeries < latest date di ohlc.json (any major ticker),
// baca data.json.live.IHSG (dari repo yg baru saja di-commit) sbg close latest day.
```

Butuh cross-workflow read (build-tracker read data.json build-data), atau shared source fetch.

Alternatif: try multiple Yahoo hosts (`query1`, `query2`) dengan random offset — sometimes different hosts have different sync state.

### 2. Chart candlestick per rec (mungkin future request)

User dulu suka lihat harga per rec. Kalau nanti dibutuhkan, ada infrastruktur:
- `fetchOhlcForModal(ticker, fromDate)` — already used di rec modal
- Chart.js atau LightweightCharts (both loaded via CDN)

### 3. IHSG monthly fallback untuk periode lama

Kalau user pilih preset "Semua Tanggal" (since 2025-07-15) atau bulan lama, IHSG daily missing untuk periode > 58 hari lalu. Bar IHSG untuk hari-hari lama akan `null` di chart.

Solusi: gabung `ihsg.seriesFull` daily + `data.json.price_history` monthly interpolation. Tapi resolusi turun. Untuk chart "30 Hari" default, cover cukup.

### 4. Codebase health

- Chart Analis migrated ke Chart.js — konsisten dgn Overview yg juga Chart.js
- `window.__OHLC_loadAll` expose masih dipertahankan sbg infrastruktur (fetchOhlcForModal existing, plus future re-use)
- ~324 baris net dihapus (banyak legacy chart code cleared)

## Commits sesi ini (di `main`)

```
260c198  analis Performa chart: fallback IHSG latest close dari data.json.live
2aa49d8  analis: hapus NAV Reksadana Virtual, merge return IHSG ke chart Performa
bc90e15  Revert "analis Return Kumulatif: baseline normalize ke periode start (mirror Dashboard chart)"
f94023a  Revert "analis Return Kumulatif: indexed price mode — IHSG raw, firm indexed dari baseline IHSG"
807d02a  analis: NAV Reksadana Virtual chart (compound, equal-weight, idle→IHSG)
4fff926  analis Return Kumulatif: indexed price mode — IHSG raw, firm indexed dari baseline IHSG
d65b4fb  analis Return Kumulatif: baseline normalize ke periode start (mirror Dashboard chart)
3eddd81  analis: pindahkan period preset ke DALAM popup kalender
c6a89ad  analis: period preset (30D/Bulan Ini/Bulan/Tahun) di header Mode Eksekusi
```

## Kondisi akhir (verifikasi)

- Working tree: clean, no pending changes
- Branch: `main`, sync dgn `origin/main`
- HEAD: `260c198ef19e143eda9d8c13a00cae05990e41e2`
- URL production: (auto-deploy dari main via GH Pages / Cloudflare Pages)
- Test manual: buka firm apa saja di halaman Analis → chart Performa 30 Hari tampil dgn bar firm + bar IHSG + line kumulatif, tooltip hover work, klik preset 30D/Bulan Ini/dst di popup kalender ganti filter → semua panel re-render

## Preferensi user tercatat sesi ini

- **Chat panjang bisa hilang** — kalau reply user tidak sampai (frontend bug), aku tanya ulang singkat via poin-poin bernomor supaya tidak rugi ketik ulang panjang
- **User trust engineer decisions** — dia bilang "atur aja layaknya reksadana profesional Indonesia, aku ngikut aja" — jadi kalau ada design decision technical, boleh proceed selama dokumentasi jelas
- **User praktis** — kalau tidak suka, minta revert. Tidak masalah eksperimen (banyak revert sesi ini)
- **User familiar dgn concept dasar finance** (winrate, TP/SL, IHSG, reksadana) tapi bukan quant/dev — bahasa sehari-hari, tidak perlu jargon berat
- **User prefer bahasa Indonesia campur teknis** — "kolom" untuk column, "chart" untuk chart, "popup" untuk popup, dst
- **User suka data-driven diskusi** — audit dulu sebelum coding, konfirmasi kesiapan data (mereka bilang "cek dulu kesiapan data kita, agar tidak double")
