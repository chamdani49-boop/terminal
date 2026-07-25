---
title: Handoff sesi 2026-07-25 — Tracker Overview Chart + Unified Winrate Engine + Zone Popup Rules
inclusion: manual
---

# Sesi 25 Jul 2026 — Ringkasan lengkap

Sesi yang sangat produktif, mencakup **32+ perubahan** di seluruh menu Tracker. Dibagi ke 4 area:

1. **Fixes minor UX** (chart auto-refresh, search reset, rank numbers).
2. **Broker codes IDX** — sumber tunggal + red untuk broker asing.
3. **Mesin utama winrate** — `tracker-stats.js`, apply ke semua UI.
4. **Chart Overview Performa 30 Hari** — full overhaul (multi-line + sidebar Peringkat + period selector + IHSG chip).

Fokus utama sesi ini adalah **Overview chart** di Tracker — mengadopsi design pattern dari `chamdani49-boop/rupiah-monitor` (AllCurrenciesChart).

## Repository state akhir

- **Branch:** `main`
- **Last commit:** `6966507` — "tracker/overview: tooltip filter — cuma tampil di line highlighted"
- **File utama:** `public/index.html` (banyak edit)
- **File baru created:**
  - `public/broker-codes.js` — sumber tunggal 92 broker IDX + helpers
  - `public/tracker-stats.js` — mesin utama winrate/net (TP1 lock)
  - `.kiro/steering/broker-codes.md` — dokumentasi broker codes system

---

## AREA 1: Fixes minor UX

### 1. TradingView chart auto-refresh
- **Problem**: chart di halaman Analisis (sub-tab Tracker) refresh sendiri tiap kali data pipeline poll `tracker.json` → `renderAnalisis` → `switchTicker(same ticker)` → `renderTvChart` rebuild iframe TradingView dari nol (TLS + fetch config + render candle). User complain halaman lemot.
- **Fix**: state var `_lastTvTicker`, guard di `switchTicker()` — hanya rebuild TV widget kalau ticker berubah. Theme toggle tetap force rebuild via `renderTvChart(_current)` langsung.
- **Commit**: `740b5a9`.

### 2. Sidebar Sekuritas search reset on click
- **Problem**: ketik "bn" → klik BNI Sekuritas → search box tetap terisi "bn", list tetap ke-filter.
- **Fix**: click handler `.tr-mdet-item` clear `#trMdetSearch.value` + panggil `renderSidebar()` sebelum `__TR_openFirm(fid)`.
- **Commit**: `7373896`.

### 3. Rank numbers di sidebar Sekuritas
- Tambah nomor peringkat (`01, 02, ..., 30`) di depan avatar tiap item, zero-padded, mono font.
- Rank berbasis **full-list** (`firmList('')`), BUKAN hasil filter — konsisten saat search.
- **Commit**: `8dfb86e`.

### 4. Removed chip angka di sub-tab
- User request: hapus badge angka di sub-tab Live/Analisis/Analis (mis. "Live 433", "Analisis 153").
- HTML: hapus 3 `<span class="tr-subtab-chip">`. JS updater sudah punya guard `if(!el) return`, silent no-op.
- **Commit**: `cc7e7ff`.

---

## AREA 2: Broker codes IDX

### File: `public/broker-codes.js`
- Data: 92 broker IDX (kode 2 huruf + nama resmi + foreign flag).
- Helpers:
  - `BrokerCodes.get(firmName)` → `{code, name, foreign}` atau null.
  - `BrokerCodes.getByCode('DR')` → same.
  - `BrokerCodes.avatar(firmName)` → `{text, foreign, matched}` untuk UI.
- Matching robust: normalize strip `PT/TBK/INDONESIA/ASIA/punctuation` + prefix-match fallback.
- Loaded blocking di head `<script src="/broker-codes.js"></script>` sebelum inline scripts.
- **Steering doc**: `.kiro/steering/broker-codes.md` (cara nambah broker baru).

### Kotak avatar firm — 3 render sites
- **Sidebar Sekuritas** (`.tr-mdet-item .av`)
- **Header detail firm panel Analis** (`#trPfAv`)
- **Papan Peringkat view Per Firm** (`.tr-lb-av`)

Semua pakai `BrokerCodes.avatar(f.name)`:
- Text = kode broker 2 huruf (mis. `DR`, `NI`, `BQ`).
- Class `.brk-foreign` → **warna merah** untuk broker asing.
- Fallback ke inisial kalau firm tidak match.

**Commit**: `0baf00d`.

---

## AREA 3: Mesin utama winrate (`tracker-stats.js`)

Sebelumnya ada **3 formula terpisah** untuk winrate/net:
1. Backend `firm.winrate` (natural, dipakai di sidebar).
2. Overview Per Firm `computeFirmStats(firm, target)` (target-aware).
3. Analis panel `computeModeStats(firm, entryMode, exitMode)` (mode-aware).

User complain angkanya beda-beda antar tempat.

### Aturan mesin utama (di `public/tracker-stats.js`):

1. **Default winrate = "Beli di Entry"** → skip rec yang `didTouchEntry=false`.
2. **Variants HAKA/TP1/TP2** punya winrate masing-masing:
   - Entry: `entry` (default) | `haka`
   - Exit: `tp1` (default) | `tp2`
3. **TP1 LOCK**: begitu TP1 tersentuh, rec DIKUNCI sebagai TP1 WIN — meskipun harga jatuh balik ke TP1/entry/SL/TP2. Sinyal: `tpHits.includes('TP1')` atau `closedBy in {TP1, TP2, SL_TRAIL}`.
4. **SL murni** (kena SL tanpa pernah TP1) → LOSS di SL.
5. **Expired** → pakai `exitPrice` natural.
6. **TP2 mode**: skip rec tanpa TP2 target. WIN penuh kalau TP2 hit. Small-WIN (trailed) kalau TP1 hit tapi TP2 tidak.

### API:
```js
window.TrackerStats.compute(firm, { entry, exit, dateFilter }) → { trades, wins, winrate, net, avg, best, worst, ... }
window.TrackerStats.recPnl(rec, { entry, exit }) → number | null
```

### 7 render site wired ke mesin utama:
1. Sidebar Sekuritas (`renderSidebar`) — mode `entry×tp1`.
2. Overview Per Firm (`computeFirmStats`) — mode `entry × selector`.
3. Analis panel KPI (`computeModeStats`) — mode `selectors + dateFilter`.
4. Drawer detail firm (`openFirm`) — `entry×tp1`.
5. Papan Peringkat Performa (`renderFirmLeaderboard`) — `entry×tp1`.
6. Papan Peringkat Overview (`updateLb`) — `entry×tp1`.
7. Header detail firm ("N trade selesai") — `entry×tp1`.

**Field backend `firm.winrate` / `firm.trades` / `firm.net` TIDAK dipakai lagi di UI** — semua di-compute ulang.

**Commit**: `6c454e5`.

### Sub-fixes terkait TP1 lock:

- **`statusOf` / `statusOfRec` fix** (baris 13115 & 14063): dulu cuma cek `closedBy === 'TP'/'SL'` (exact match), padahal backend simpan `'TP1'/'TP2'/'SL'/'SL_TRAIL'`. Rec TP1/TP2/SL_TRAIL keliru dikelompokkan sebagai 'ACTIVE'. Fix: recognize semua closed states.
- **Marker exit di chart popup**: TP1/TP2/SL_TRAIL → green arrowUp (WIN semua per TP1 lock). SL murni → red arrowDown. Expired → gray circle.
- **Badge KENA di SL card**: dulu SL_TRAIL menyalakan badge KENA di SL card (padahal SL asli tidak kena — harga cuma balik ke entry). Fix: `isSLHit = closedBy === 'SL'` only. Tambah badge `🛡 HIT · TRAIL` di TP1 card untuk SL_TRAIL supaya konteks jelas.

**Commits**: `94a5ef8`, `5209d32`.

---

## AREA 4: Fixes rekomendasi list & popup

### Tab "Expired" di panel Rekomendasi Sekuritas (Analis)
- Urutan tab: Semua / Aktif / Menunggu / TP1 / TP2 / SL / **Expired** (baru).
- Helper `_recHitExpired(r)`: cek `closedBy in {'EXPIRED', 'EXPIRED_UNFILLED'}`.
- **Commit**: `0b75b69`.

### Search kode saham di panel Rekomendasi Sekuritas
- Input `#trPfRecSearch` di antara heading dan tab bar.
- Filter by ticker (case-insensitive substring).
- **Bypass date filter kalau search aktif** — pencarian tidak terikat waktu.
- Tab counters ikut update sesuai hasil search.
- Reset saat pilih firm baru.
- **Commit**: `80333fb`.

### `findRecById` fallback scan `byFirm`
- **Problem**: backend cap `historyList` top-level ke 500 rec, tapi `byFirm[X].recsHistory` menyimpan semua (614 rec). 117 rec "orphan" muncul di UI panel firm tapi klik → `findRecById` miss → popup silent tidak muncul.
- **Fix**: fallback scan `byFirm[*].recs*` setelah top-level miss. Bucket → list-name mapping:
  - `recsActive → openList`, `recsPending → pendingList`, `recsMissed → missedList`, `recsHistory → historyList`.
- **Commit**: `a065e20`.

### Popup detail rec — SL/TP1/TP2 rata tengah
- Untuk rec closed (`rec.exitDate` truthy), text di kotak TP1/TP2/SL rata tengah horizontally (align-items: center).
- Kotak ENTRY biarkan default (left-align).
- Class `.is-closed` di-add ke card, CSS target `.tp.is-closed` / `.sl.is-closed`.
- **Commit**: `2030a01`.

### Zone rule popup chart (aturan final per user)
- **Rec tidak sentuh entry** (didTouchEntry=false): zona stop di `openDate + 7 hari` kalender (snap ke candle terdekat setelah target).
- **Rec sentuh entry + closed**: zona stop di `exitDate` langsung (untuk semua state: TP1/TP2/SL/SL_TRAIL/EXPIRED).
- **Rec sentuh entry, masih AKTIF**: null → fallback proyeksi 5 candle setelah candle terakhir.
- **PENTING**: BEDA dengan rumus winrate. Rumus tetap TP1 lock (SL_TRAIL = WIN). Zona visual pakai exitDate actual (SL_TRAIL stop di tgl SL_TRAIL, bukan tgl TP1).
- Var module-level: `_zoneEndDate`.
- **Commit**: `b97bb4f`.

---

## AREA 5: Chart Overview Performa 30 Hari — FULL OVERHAUL

Ini area paling banyak iterasi (30+ perubahan). Adopsi design dari `chamdani49-boop/rupiah-monitor/components/AllCurrenciesChart.tsx`.

### Fitur akhir:

**Layout**:
```
┌──────────────────────────────────────────────────────────────┐
│ [📈 Performa 30 Hari]    [IHSG chip]                          │  ← Row 1 (sejajar di mobile)
│ [deskripsi ...]                                                │
│ [30D][Bulan Ini][Bulan Lalu][2026 ▾]                          │  ← Row 2 (period selector)
├───────────────────────────────────────┬───────────────────────┤
│                                       │ PERINGKAT VS IHSG      │
│                                       │ + = outperform · − =   │
│    [chart: 31 firm lines]             │ 1 ● LS  Reliance ...  │
│    height 380px desktop, 260 mobile   │ 2 ● CP  KB Valbury    │
│                                       │ 3 ● ZP  Maybank ...   │
│                                       │  ...                   │
└───────────────────────────────────────┴───────────────────────┘
```

**Data**:
- Timeline: **union dates** dari IHSG + dailyEquity + firm recsHistory exitDates (kalau IHSG lag, chart tetap tampil sampai tgl terakhir data manapun).
- Firm daily equity: pakai **mesin utama** `TrackerStats.recPnl(rec, {entry:'entry', exit:'tp1'})` untuk konsistensi. Compound via forward-fill.
- **Semua 31 sekuritas** ditampilkan (bukan Top 8). Auto-add saat data grow — user tidak perlu edit kode.

**Palette 32 warna** distinct:
```
sky, orange, green, yellow, violet, pink, cyan, rose,
lime, cyan-vivid, amber, violet-alt, teal, red, orange-alt, lime-alt,
fuchsia, blue, green-alt, yellow-alt, purple, pink-alt, emerald, cyan-alt,
orange-soft, lime-soft, fuchsia-soft, blue-soft, green-soft, yellow-soft, red-soft, purple-soft
```
Diassign by sorted rank position → warna stabil.

**Interaksi**:
- **Klik row Peringkat** → toggle highlight line di chart.
- **Klik nama singkat di row** (data-action="nav") → navigate ke Analis via `__TR_openFirm(id)`.
- **Klik line di canvas chart** → toggle highlight (mirror sidebar).
- **Klik chip IHSG** → clear highlight (chart kembali cerah).

**Highlight state**:
- State module-level: `_highlightedFirmId`.
- Line highlighted: full color + `borderWidth 2.8` + `pointRadius 3` (bintik terlihat) + `order: -1` (drawn on top).
- Line lain: `color + '2a'` (~16% opacity) + `borderWidth 1.2` + `pointRadius 0`.
- Default (no highlight): semua line normal, `pointRadius 0` (chart bersih tanpa bintik).

**Tooltip** (`mode: 'nearest'`):
- 2 baris:
  ```
  Reliance Sekuritas: +127.73%       (kumulatif s.d. tgl)
  Return harian: +8.45%              (delta vs tgl sebelumnya)
  ```
- **`tooltip.filter`**: kalau ada highlight, hanya line aktif yang tampil tooltip. Line fade → tooltip suppressed.
- afterLabel callback skip baris 2 kalau `idx=0` atau `|delta| < 0.005%`.

**IHSG chip di header**:
- Label: `IHSG 30D` / `IHSG MTD` / `IHSG Bln Lalu` / `IHSG 2026` (dinamis ikut period).
- Value: `+7.29%` (return kumulatif, up/down color).
- Sub: `5.886,03 → 6.315,31` (base → current, format 2 desimal).
- **Sinkron dashboard**: current price prioritaskan `window.getStatsMerged('IHSG').current` (same source dengan row IHSG di Statistik Deskriptif).
- Fallback: `ihsgSeries[last].close` dari tracker.json.
- Refresh via `setInterval(15s)` hanya kalau period `isLive` (30D/MTD/tahun berjalan).

**Period selector** (4 pilihan):
- **30D** (default): rolling 30 hari s.d. tgl terakhir data.
- **Bulan Ini** (MTD): tgl 1 bulan berjalan → today.
- **Bulan Lalu**: 1 → akhir bulan sebelumnya (full).
- **Tahun** dropdown: pilih tahun kalender. Auto-populate berdasar tahun-tahun di data (`ihsgSeries`). Current year selalu ada. Kalau tahun berjalan, end date cap ke today.

State: `_chartPeriod = { type: '30d' | 'mtd' | 'lastMonth' | 'year', year?: number }`.

Empty state: kalau period tanpa data, sidebar tampil "Belum ada data untuk periode ini. Chart akan terisi seiring data terkumpul."

**Title chart dinamis**:
- 30D → "Performa 30 Hari"
- MTD → "Performa Bulan Berjalan (Juli)"
- LastMonth → "Performa Bulan Lalu (Juni)"
- Year → "Performa Tahun 2026"

**Mobile view**:
- Header layout: `.tr-card-headline` (flex nowrap) → title + IHSG chip tetap sejajar tidak wrap.
- Mobile font shrink: title 14→12.5px, desc 12→10.5px.
- Chart height 260px (dari 240px), sidebar 280px scrollable.
- Layout stack vertical (column) di ≤900px.

**X-axis format**:
- Sumbu X: `24 Jun` (dd bulan-singkat) bukan `2026-06-24`.
- Callback formatter: parse ISO → return `${day} ${monthID3}`.
- Tooltip title tetap ISO full (konteks tahun saat hover).

**Commits progress**:
- `fbc164b` — multi-line per firm + IHSG
- `ac27b1d` — union timeline
- `a847b2e` — IHSG dual axis (Rp + %)
- `58805f6` — single %-axis (apple-to-apple)
- `2756562` — hapus IHSG line, ganti chip header
- `eb75286` — show all 31 firms + palette 32
- `484daf5` — chart height 380px
- `cfe924c` — tooltip nearest
- `1c371bd` — pointRadius=0 default
- `6ce181d` — klik chart toggle highlight
- `e387243` — adopsi rupiah-monitor design + sidebar Peringkat
- `945ba94` — chart height match sidebar
- `4041cc3` — IHSG chip sinkron dashboard + daily delta
- `6293eed` — nav ke Analis dari sidebar + klik IHSG clear
- `6cbcaee` — period selector + rename tooltip
- `0888926` — mobile sejajar + x-axis format
- `6966507` — tooltip filter (line faded no tooltip)

---

## File yang diubah/created

### Modified:
- `public/index.html` (banyak block, terutama IIFE `updateChart` di sekitar baris 11550-12200)

### Created:
- `public/broker-codes.js` — 92 broker IDX + helpers
- `public/tracker-stats.js` — mesin utama winrate/net
- `.kiro/steering/broker-codes.md` — dokumentasi
- `.kiro/steering/handoff-2026-07-25-tracker-overview-chart.md` — dokumen ini

### Loaded blocking di `<head>` public/index.html:
```html
<script src="/broker-codes.js"></script>
<script src="/tracker-stats.js"></script>
```

---

## Yang belum digarap / bisa follow-up

1. **Backend data historis** — data cuma ~1 bulan (Juni-Juli 2026). Period "Tahun 2026" akan tampil sedikit. User request: "kita mulai dari data yg ada sampai kedepan dan seterusnya" — infrastruktur siap, tinggal data tumbuh via workflow `refresh-tracker.yml`.

2. **IHSG data pipeline** (`refresh-macro.yml`) lag 1-2 hari dari data lain. Fix frontend sudah via union timeline + forward-fill IHSG line/chip. Kalau mau fix di data source, audit workflow.

3. **`_chartPeriod` persistence** — state period reset setiap page reload (tidak persisted ke localStorage). Bisa tambahkan `localStorage.setItem('tr_chart_period', ...)` kalau user ingin remember pilihan.

4. **Klik line faded saat highlight** — masih toggle ke line faded (klik faded firm → jadi highlighted firm baru). Kalau user mau prevent, tambah filter di `onClick`. Currently intentional (biar user bisa cepat switch antar firm).

5. **Cache `_lastChartData`** — di-declare tapi belum dipakai untuk optimasi re-render. Highlight toggle masih call full `updateChart(data)`. Bisa optimize untuk hanya update `borderColor` + `borderWidth` datasets tanpa re-compute `_computeFirmDailyEquity`.

---

## Konvensi penting (jangan diubah tanpa alasan)

### Broker codes system
- **Sumber tunggal**: `public/broker-codes.js`. Nambah broker: edit array `LIST` di file itu. Jangan hardcode di UI.
- Foreign broker → class `.brk-foreign` → color merah. Semua kotak avatar firm di Tracker pakai pattern ini.
- Dokumentasi: `.kiro/steering/broker-codes.md`.

### Mesin utama winrate
- **Sumber tunggal**: `public/tracker-stats.js`. Aturan TP1 lock harus konsisten (SL_TRAIL = WIN).
- UI SEMUA halaman Tracker HARUS panggil `TrackerStats.compute()` untuk winrate/net firm. Jangan pakai backend `firm.winrate` langsung.
- Kalau nambah render site firm stats baru, wiring pattern:
  ```js
  var st = (window.TrackerStats && window.TrackerStats.compute)
           ? window.TrackerStats.compute(firm, {entry:'entry', exit:'tp1'})
           : { trades: firm.trades||0, net: +firm.net||0 };
  ```

### Zone popup rule (BEDA dari mesin utama)
- Zona visual di chart popup: SL_TRAIL stop di `exitDate` (BUKAN tgl TP1).
- Rumus winrate: SL_TRAIL = WIN via TP1 lock.
- Ini INTENTIONAL, jangan disamakan.

### IHSG chip Overview chart
- Sinkron dengan Dashboard Statistik Deskriptif via `window.getStatsMerged('IHSG').current`.
- Live refresh 15s interval, tapi hanya kalau period `isLive`.
- Format harga: 2 desimal `toLocaleString('id-ID')`.

---

## Verify checklist saat sesi baru

1. Buka Overview → chart Performa 30 Hari harus tampil dengan sidebar Peringkat di kanan.
2. Klik row Peringkat "LS" → line Reliance highlight, lainnya fade.
3. Klik nama "Reliance Sekuritas..." di row → navigate ke Analis tab.
4. Klik chip IHSG → clear highlight.
5. Klik period "Bulan Lalu" → chart update.
6. Chip IHSG value harus match dengan row IHSG di Dashboard Statistik Deskriptif (test saat market jam kerja).
7. Hover chart saat highlight aktif → tooltip cuma untuk line terang.
8. Mobile view: title + chip IHSG sejajar dalam satu baris.
