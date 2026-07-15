# Handoff — 2026-07-15 · Tracker UI Refinement & Feature Additions

Session panjang berisi banyak perbaikan bertahap di menu **Tracker**, ditambah
disclaimer edukasi global, candle tooltip di semua chart custom, dan
konsolidasi UI Live tab. Fokus utama: tab Analisis, tab Live, popup rec, dan
konsistensi IHSG dgn dashboard.

---

## 🎯 Perubahan Besar (grouped by fitur)

### A. Pending Expiry Rule (10 hari)
- **Awalnya**: rekomendasi menunggu entry expired setelah 1 bulan kalender
  (openDate + 30 hari, same-day-next-month).
- **User req di akhir session**: diperpendek jadi **10 HARI kalender**.
- Backend: `scripts/build-tracker.js` — `PENDING_EXPIRY_DAYS = 10`,
  `computePendingExpiry()` pakai `openDate + 10 * 86400 * 1000`.
- Frontend: `getPendingExpiryDate()` sinkron dgn backend. 8 tempat text
  di HTML sudah di-update dari "1 bulan" → "10 hari".
- Zona kotak rekomendasi di popup rec chart candlestick di-cap ke tgl expiry
  10 hari (`layoutZones` xRight fallback ke `window.__TR_getPendingExpiryIso`).
- Footer popup rec ada baris "Berlaku sampai / Kadaluarsa" info.

### B. Firm Name Deduplication (Client-Side Canonical Merge)
Sheet Tracker punya inkonsistensi nama firm (mis. "RHB Sekuritas" vs "RHB
Sekuritas Indonesia", "PHINTRACO" vs "Phintraco", "PT Reliance ... Tbk").
Kedua tempat harus deduplicate:

**Tracker** (`window.__TR_normalizeFirms`):
- Helper module-level di HTML: `_canonicalFirmKey`, `_canonicalFirmDisplay`,
  `_pickBestDisplay`, `_idOfFirm`, `normalizeFirmsInData(json)`.
- Auto-jalankan di `loadTrackerData` dan refresh button hook.
- Rewrite firm/firmId di `openList`/`pendingList`/`missedList`/`historyList`,
  merge `byFirm` (sum stats, concat lists, dedupe watchlist).
- Rebuild `topFirms`/`bottomFirms` dgn aggregated stats.

**Consensus** (`_normalizeConsensusFirms`):
- Helper dedicated dgn prefix `_cons*` (`_consCanonFirmKey`, dst).
- Hook di `_sanitizeData()` (initial data.json load) + `_applyConsensusInto()`
  (live feed refresh per menit).

**Canonicalization rules**:
- UPPERCASE, strip 'PT ', ' Tbk', trailing ' Sekuritas Indonesia' /
  ' Sekuritas', ' Indonesia'.
- **Prefix brand PRESERVED**: `KB Valbury` ≠ `Valbury` tetap distinct.
- Display picker: non-ALL-CAPS diutamakan, lalu paling panjang,
  alphabetical.

### C. Firm Name Display (No More "Sek." Abbreviation)
- 9 total copy `firmShort()` di frontend di-samakan: hanya strip `^PT ` +
  ` Tbk` suffix, NAMA SEKURITAS LENGKAP.
- 2 copy yg sebelumnya missed (line ~10180 di analysis tab + line ~10737
  di popup rec modal) sudah di-fix.
- CSS `.tr-recmodal-name` & `.tr-recmodal-firm` pakai `-webkit-line-clamp: 2`
  + `word-break: break-word` + `font-size: clamp()` supaya nama panjang bisa
  wrap 2 baris tanpa terpotong ellipsis.

### D. Tab Analisis — Widget "Status Rekomendasi" Redesign
Iterasi berulang berdasarkan feedback user. Final layout (dari atas):

**1. Opportunity Score (spedometer)**
- Composite score 0-100 dari 4 faktor terbobot:
  - 40% Sentimen Analis (buy% dari total rec)
  - 30% Proximity ke Entry (dekat entry = tinggi; lewat TP1 = 30; di bawah SL = 0)
  - 20% Hit Rate Historis (kena TP / (TP + SL))
  - 10% Risk-Reward Ratio (TP1-Entry)/(Entry-SL) normalisasi
- Level bracket: 🟢 70+ SANGAT MENARIK · 🟡 50+ BOLEH MASUK · 🟠 25+ HATI-HATI · 🔴 <25 NUNGGU DULU
- Visual: SVG semi-circle gauge dgn gradient merah→hijau + needle rotate
- **Layout side-by-side**: gauge kiri, val+level+durasi kanan (bukan center overlay → tidak menumpuk dgn needle)
- Klik ⓘ → popup breakdown detail per faktor (reuse `window.showInfoModal`)
- Function: `computeOpportunityScore()`, cached ke `_lastOppScore`

**2. Price Ladder (tanpa title)**
- 5 marker: SL · Entry · LIVE · TP1 · TP2
- **LIVE special**: badge kompak DI ATAS garis, label+price+pct digabung
  dalam 1 badge kuning (tidak menumpuk dgn label/val marker lain karena
  region berbeda vertikal)
- Non-LIVE: label ATAS garis, val BAWAH garis (dual row)
- **Stagger logic**:
  - LIVE tidak pernah stag (badge selalu row 1)
  - Non-LIVE dekat LIVE (< 22%) → forced stag
  - Non-LIVE dekat non-LIVE (< 18%) → alternate stag (zigzag)
- Note kontekstual: '📍 Di sekitar Entry / ⬇ X% di bawah / ⬆ +X% di atas / 🎯 Lewat TP1'

**3. Posisi Sekarang (4 kotak)**
- Aktif · Menunggu · Kena TP · Kena SL
- Color-coded: ungu / oranye / hijau / merah

**REMOVED sections** (per user req):
- ❌ Sentimen Analis section (redundan dgn Opp Score's sentiment factor)
- ❌ Track Record (Win Rate + Avg Return) — dianggap misleading

**HIDDEN legacy elements** (backward-compat, `display:none`):
- `#trAnlSentHead`, `#trAnlSentBreak`, `#trAnlSentBarBuy`, `#trAnlSentBarSell`
- `#trAnlTrackSub`, `#trAnlTrackDur`, `#trAnlTrackWr`, `#trAnlTrackAvg`
- `#trAnlKpiStrip` (5 KPI cards Total Rec / Win Rate / dll)

### E. Tab Live — Redesign Top Section
- Status bar (AKTIF / Update / Sumber / Refresh) → DIHILANGKAN
- Card `WIN RATE KONSENSUS` → DIHILANGKAN
- Card `TOTAL SIGNAL` → DILEBUR ke dalam "LIVE SIGNAL TERMINAL":
  - Summary bar atas: `372 TOTAL SIGNAL` + breakdown per state
  - 4 metric cell: Posisi Profit / Loss / Akurasi Live / Rata² Floating
- Bottom strip text `X posisi terbuka · Y profit · Z loss` → DIHAPUS (duplikat)

### F. IHSG di Tab Live (Sync dgn Dashboard)
- Awalnya beda dgn dashboard karena tracker pakai `data.ihsg.last` (Yahoo).
- Sekarang panggil **`window.getStatsMerged('IHSG')`** langsung → nilai IDENTIK
  dgn row IHSG di kolom Statistik Deskriptif dashboard.
- **BUG root cause**: `let DATA` di dashboard TIDAK attach ke `window`.
  Kondisi `if (D && ...)` selalu false → fallback ke tracker.json.
- Fix: hilangkan `D && ` guard. Function declaration di classic script DO
  attach ke window, jadi call langsung `window.getStatsMerged('IHSG')` works
  (function punya closure ke DATA di scope asalnya).
- Chg% pakai `s.change_pct_live ?? DATA.live.IHSG.change_pct` (× 100 karena
  disimpan sbg fraction 0.0025 = 0.25%).
- **Widget di header Live Signal Terminal** (bukan card terpisah):
  - Label "IHSG" (bukan ticker "JKSE")
  - Pulse dot animation (green/red) untuk sinyal feed live
  - `window.__TR_refreshIhsgLive` di-trigger di 3 tempat DATA populate +
    polling 5s + hook di `applyLiveFeed`
- **Sekuritas dropdown flexible**: `buildFirmChips` pakai `trCombined` langsung
  (SEMUA rec aktif), bukan dateScoped (default "Terbaru" = 1 tgl saja).

### G. Popup Score Validitas — DIHAPUS di Semua Halaman
User awalnya mau popup Skor Validitas untuk trigger dari "Skor tertinggi N".
Tapi setelah demo (BNI 100% WR tapi skor 40 WEAK), user sadar konsep skor
membingungkan (winrate ≠ skor).

**Solution**: hapus tampilan skor validitas di semua halaman:
- Live Signal Terminal: `Skor tertinggi N ⓘ` → dihapus (span hidden)
- Firm profile hero: badge STRONG/MODERATE/WEAK → dihapus
- Tab Performa: "Performa per Skor Validitas" section → `display:none`
- Kartu "SKOR TINGGI" di leaderboard → dihapus

Modal `#trScoreModal` tetap ada di DOM sbg **dead code** — tidak ada trigger.
Kalau kelak scoring diperbaiki, tinggal un-hide.

### H. Mode HAKA — Popup Edukasi
User req: "Beli di Open (HAKA)" harus jelas OPSIONAL, bukan default.

Update `MODE_NOTE.haka` dgn text edukasi:
- Warning header: mode opsional & edukasi
- Kenapa akurasi bukan 100%: gap-up/gap-down + intraday tidak terduga
- Highlight default: 📍 Beli di Entry
- HAKA cocok utk yg sengaja mau kejar momentum awal

Ditrigger dari existing ⓘ button di seg-btn HAKA (data-mode-info="haka").
Inline text HAKA di tab Asumsi juga di-update konsisten.

### I. Sub-Tab Tracker
- Kolom sektor (Energy / Basic Material / dll) — dihilangkan di SEMUA halaman
  tracker via CSS: `.tr-p-sectors`, `.tr-p-sector`, `#trAnlSearchDrop .search-item .sector` display:none.
- Baris "Sektor: XX" di hero Analisis juga di-hide.
- Badge "✓ VERIF" / "✓ TERVERIFIKASI" dihilangkan di semua tempat via CSS:
  `.tr-p-vbadge`, `.tr-lb-ver`, `.tr-live-card-verif`, `.tr-perf-firm-verified`,
  `.tr-sim-card-verified`.

### J. Tab Rekomendasi Analisis Table
- Kolom `#` nomor urut baris (1, 2, 3, ...) di paling kiri
- Nama sekuritas jadi **clickable link** (ungu, dashed underline hover):
  klik → bypass modal-rec, langsung buka firm profile di tab Analis via
  `window.__TR_openFirm(firmId)`
- Modal click handler intercept `[data-firm-open]` DULU sebelum `[data-recid]`
- Fallback firmId: pakai `idOf(r.firm)` client-side kalau `r.firmId` belum ada

### K. Firm Profile (Analis Tab) — Tab SL
Tambah tab **SL** setelah TP2 di rec list. Filter rec dgn `closedBy === 'SL'`
(SL murni, exclude `SL_TRAIL` yg sebenarnya WIN).

### L. Disclaimer Edukasi
Text disclaimer terpasang di 4 halaman utama + 3 popup penting:

**Halaman** (versi normal dgn ikon ⓘ, card muted):
- `#page-dashboard`, `#page-consensus`, `#page-valuasi`, `#page-tracker`

**Popup** (versi mini kompak):
- `#infoModalOverlay`, `#recDetailModal`, `#trRecModal`

CSS shared: `.dm-disclaimer` (halaman), `.dm-disclaimer-mini` (popup).
Text: "Konten ini sebagai informasi edukasi dan bukan merupakan ajakan
atau rekomendasi untuk membeli maupun menjual saham tertentu. Selalu
lakukan riset secara mandiri dan pastikan kamu memahami resikonya
sebelum mengambil keputusan investasi."

### M. Candle Tooltip di Semua Chart Custom
Helper global `window._attachCandleTooltip(chart, series, container, candles)`.
Applied ke **4 chart candlestick custom** (lightweight-charts):

1. Popup rec modal Tracker (`#trRecModalChart`)
2. Popup rec Consensus Bareksa-style (`renderRecChart`)
3. Chart Pasar Live windows (`plWinChartA/B/dll`)
4. Chart Valuasi harian (`_harianChart`)

Tooltip menampilkan:
- Tanggal candle
- OHLC (Open, High, Low, Close)
- Δ intraday (%) — color-coded hijau/merah
- D/D (%) — vs candle sebelumnya

Chart TradingView embed **tidak diubah** (sudah punya tooltip built-in).

### N. Chart TradingView Height (Tab Analisis)
- `.tr-anl-tv-wrap` height 520px fixed → `height: 100%; min-height: 360px`
- Dengan `align-items: stretch` di grid `.tr-anl-chart-row`, chart auto-adjust
  tinggi mengikuti widget di kanan (no whitespace di bawah)
- Mobile <1024px: revert ke `380px` fixed (stack layout)

### O. Hero PETA REKOMENDASI Fix
- `.tr-anl-hero` `overflow: hidden` → `overflow: visible` (dropdown search
  tidak lagi ke-clip)
- `align-items: center` → `flex-start` (tag "PETA REKOMENDASI" tetap top-aligned)
- Padding 14px → 16px vertical (breathing room)
- ::before decoration redesigned: dari `top:-60 right:-60` (butuh clip) →
  `top:0 right:0` dgn `border-radius: 0 16px 0 0` (tidak spill)

---

## 📁 File yg Dimodifikasi

**Backend**:
- `scripts/build-tracker.js` — pending expiry logic, firm canonicalization

**Frontend**:
- `public/index.html` — 90% perubahan session ini di sini (25+ commits)

**No config/steering changes**: `.kiro/steering/` tidak diubah kecuali handoff
file ini yg baru dibuat.

---

## 🛠 Helpers Global yg Ada Sekarang

Semua di `window.*` (accessible dari script mana pun):

```js
// Tracker helpers (existing dari session sebelumnya, masih dipakai)
window.__TR_getData()                     // → __TR_DATA__
window.__TR_onData(cb)                    // subscribe data ready
window.__TR_showRec(rec)                  // open rec modal
window.__TR_hideRec()                     // close rec modal
window.__TR_findRecById(id)               // lookup rec by id
window.__TR_openFirm(firmId)              // navigate to firm profile
window.__TR_getLive(ticker)               // live price chain
window.__TR_getModeFloating(rec, mode)    // floating P&L per mode
window.__TR_getBaseLabelForMode(mode)     // 'beli di entry' / 'open'
window.__TR_getActiveMode()               // {entry, exit}

// Session INI baru:
window.__TR_getPendingExpiryIso(rec)      // ISO date openDate + 10 hari
window.__TR_isPendingExpired(rec)         // bool: sudah > 10 hari?
window.__TR_pendingDaysLeft(rec)          // int: sisa hari
window.__TR_refreshIhsgLive()             // trigger renderIhsg re-run
window.__TR_normalizeFirms(json)          // canonical merge tracker firms

// Chart candle tooltip
window._attachCandleTooltip(chart, series, container, candles)

// Info modal (global, sudah ada dari sebelumnya)
window.showInfoModal(title, html)         // universal info popup

// Dashboard utility (accessible via window karena function declaration)
window.getStatsMerged(code)               // stats + fresh recompute merge
```

---

## 🎨 Design Tokens & Warna Sekarang

Tab Analisis widget:
- Live badge kuning: `#fbbf24` + `rgba(251,191,36,.14)` bg + `.42` border
- SL merah: `var(--red)` / `#e11d48`
- Entry ungu accent: `var(--accent)` / `#6d28d9`
- TP1 hijau: `var(--green)` / `#059669`
- TP2 hijau muda: `#4ade80`

Opp Score gauge:
- Gradient: `#e11d48` → `#f97316` → `#eab308` → `#84cc16` → `#059669`
- Level bracket: strong-buy (hijau) / ok-buy (kuning) / caution (oranye) / wait (merah) / na (abu)

---

## ⚠️ Known Issues / Hal Perlu Diperhatikan

1. **`.dm-disclaimer` styling di popup**: text-align mungkin justify di beberapa
   theme. Kalau user complain kurang readable, adjust ke `left`.

2. **Backend `tracker.json` mungkin belum di-regenerate** dgn PENDING_EXPIRY_DAYS = 10.
   Frontend fallback `getPendingExpiryDate()` client-side ttp jalan, jadi UI
   tetap konsisten sampai workflow refresh-tracker berikutnya jalan.

3. **Modal `#trScoreModal`** masih ada di DOM sbg dead code. Kalau mau
   full-cleanup, hapus HTML + JS handler.

4. **`showInfoModal`** dipakai untuk Opp Score breakdown popup. Kalau kelak
   ada popup lain yg pakai `showInfoModal`, mereka akan share styling.

5. **Chart tooltip di 4 chart custom** — kalau chart di-recreate (mis. theme
   toggle), tooltip listener perlu re-attach. Sudah di-handle di semua site.

6. **Push conflicts** sering terjadi karena auto-refresh workflow (data.json,
   headlines.json, tracker.json refreshes tiap ~5-10 menit). Solusi standard:
   `git pull --rebase` (via `github_pull_repository` power tool) sebelum push.

---

## 📊 Commit History (Session Ini)

Chronological (paling atas = terbaru):

```
39fc495 tracker analisis: fix 'PETA REKOMENDASI' terpotong + dropdown search kelipat
fafa0e3 tracker analisis: chart tinggi mengikuti widget + LIVE marker badge di atas garis
ed59f0d tracker analisis: restructure widget (Opp Score atas, hapus Sentimen, fix ladder)
1c17f51 tracker analisis: tambah Opportunity Score spedometer (composite 4 faktor)
f2397111 tracker analisis: fix stagger marker + note compact + hapus WR/Avg Return
a7edd23 tracker analisis: redesign Status Rekomendasi widget (Opsi A + Price Ladder)
e52e4df tracker analisis: hide KPI strip (Total Rec, Win Rate, ...)
7bbd774 consensus: auto-merge firm names dgn canonical key
0568333 tracker analisis: redesign Status Rekomendasi widget v3
8bea179 candle tooltip: hover/tap candle → OHLC + % change di SEMUA chart custom
dd76465 disclaimer edukasi di 4 menu utama + 3 popup penting
07c21ee tracker: popup rec — zona 10 hari + info berlaku sampai kapan
7728337 tracker: pending expiry dari 30 hari → 10 hari
cbe3f3d tracker: hapus skor validitas di semua halaman + popup edukasi mode HAKA
010b8b5 tracker analis: badge validity STRONG/MODERATE/WEAK di header firm profile
54e8e83 tracker live: popup penjelasan 'Skor Validitas Rekomendasi'
d2b0613 tracker: nama sekuritas LENGKAP di popup rec (fix 'BNI' → 'BNI Sekuritas')
9622487 tracker IHSG: pakai getStatsMerged() → IDENTIK dgn row Statistik Deskriptif
27eeae4 tracker IHSG: hilangkan D-guard yg selalu fail (window.DATA=undefined utk let)
6c8557b tracker live: fix IHSG mismatch + firm dropdown flexible
9c70954 tracker live: IHSG match dashboard + lebur ke terminal + hilangkan duplikat text
852e58a tracker live: IHSG widget mirror dashboard (label IHSG + pulse dot live)
02d0f53 tracker live: IHSG ticker sync dgn feed live dashboard (lebih realtime)
608263c tracker live: card PENDING/MISSED tanpa % jarak entry, label 'Menunggu'
d45597c tracker: tambah tab SL di rec list + hilangkan badge VERIF
5081a0f tab Analisis: nomor urut baris + klik nama sekuritas buka profil firm
c2fb61f tracker: hilangkan chip sektor (Energy/Basic Material/dll) di semua halaman
c7eaff6 tracker: nama sekuritas lengkap + auto-merge duplicate firm
d2e2f9f tracker: client-side firm canonical merge (fallback tanpa nunggu workflow)
0c55dcf tracker: expiry 1 bulan untuk rekomendasi menunggu entry + tanda KADALUARSA
```

---

## 🚀 Quick Start untuk Session Berikutnya

**Buka `public/index.html`**, cari via grep:
- Tab Analisis widget: `renderStatusWidget(ticker, recs, k)` (line ~10614)
- Tab Live: `renderLive(data)` (line ~8990), `renderTerminal(data)` (line ~8632)
- Firm profile: `populateHero(firm)` (line ~6053), `renderRecList(firm, tab)` (line ~6803)
- Analisis rec table: `renderRecTable(recs)` (line ~10131)
- Popup rec modal: `showModal(rec)` (line ~10970), `layoutZones()` (line ~11015)

**Backend** `scripts/build-tracker.js`:
- `PENDING_EXPIRY_DAYS = 10` const
- `canonicalFirmKey`, `pickBestDisplay`, `computePendingExpiry` helpers
- `derivePosition(rec, ohlc, todayIso)` — state machine 6-state
- `scoreValidity(rec, analystStats)` — masih ada (backend logic, tidak dipakai UI)

**Common pattern**: setiap perubahan UI, ada 3 hal:
1. HTML (structure)
2. CSS (styling)
3. JS renderer function (data → DOM)

**Testing checklist** setelah perubahan:
1. Parse: `node -e "..."` DIV diff + script errors (must be 0)
2. Visual: refresh browser, hard-refresh (Ctrl+Shift+R) untuk skip CDN cache
3. Backend regen: kalau ubah `build-tracker.js`, cek workflow next run untuk
   verify output valid

**Push workflow**:
- `git add`, `git commit`
- `github_push_to_remote` power tool (bukan raw git push)
- Kalau conflict: `github_pull_repository` (auto-rebase) → push lagi

---

## 🎯 Ide untuk Session Berikutnya (tidak commit, hanya draft)

Hal-hal yg mungkin user angkat berikutnya berdasarkan tone diskusi:

1. **Tab Analisis mobile view**: widget kanan stack di bawah chart TradingView.
   Kalau layout stack, mungkin perlu adjust grid `.tr-anl-chart-row` di
   `@media(max-width:1024px)`.

2. **Price Ladder di popup rec modal**: sekarang tidak ada. Bisa reuse
   `renderStatusWidget` logic untuk single-rec context (SL/Entry/TP/Live
   dari 1 rec, bukan aggregate multi-rec).

3. **Opp Score animation**: needle rotation sudah smooth (cubic-bezier).
   Bisa tambah color pulse ke arc segment yg score-nya jatuh.

4. **Backend PENDING_EXPIRY_DAYS = 10 propagation**: tracker.json belum
   fresh dgn logic baru sampai workflow next run. Bisa hint user untuk
   trigger manual via GitHub Actions.

5. **Firm profile track record page**: kalau kelak scoring diperbaiki, bisa
   un-hide `#trScoreModal` + badge STRONG/MODERATE/WEAK di firm hero.

---

**Session ini highly iterative** — user memberikan feedback bertahap dgn
screenshot, dan aku commit + push per iterasi. Total ~30 commit dalam session.
Pattern serupa kemungkinan di-repeat di session berikutnya.

Aku (asisten) belajar: **selalu verify dengan node parser + DIV balance
check sebelum commit**. Ini catch banyak bug syntax + HTML structure error.

---

## Referensi Cepat Struktur DOM (Tab Analisis)

```
#tr-view-analisis
├─ .tr-anl-hero (overflow:visible, align-items:flex-start)
│  ├─ .tr-anl-hero-l (PETA REKOMENDASI + AMMN + nama + meta)
│  └─ .tr-anl-hero-r (search saham + dropdown)
├─ .tr-anl-kpi-strip (display:none)
├─ .tr-card.tr-anl-chartcard
│  └─ .tr-anl-chart-row (grid 1fr 320px stretch)
│     ├─ .tr-anl-tv-wrap (chart TV, height:100% min:360)
│     └─ .tr-anl-consensus (widget status rekomendasi)
│        ├─ .tr-anl-consensus-hd (header)
│        ├─ .trAnl-sec (Opp Score gauge)
│        ├─ .trAnl-sec (Price Ladder tanpa title)
│        └─ .trAnl-sec (Posisi Sekarang 4-grid)
└─ .tr-card (Daftar Rekomendasi table)
```
