---
inclusion: always
---

# Session Handoff — Tracker Analis + Dashboard Blueprint (14 Jul 2026)

Konteks lengkap dari sesi sebelumnya. Sesi baru: baca ini dulu utk paham
state UI + data flow + persistent preferences user.

## 1. Persistent User Preferences (CRITICAL)

- **Push langsung ke `main`** — TIDAK pakai PR/feature branch kecuali user
  explicit minta. Setiap perubahan: `git commit` → `git rebase origin/main`
  → `github_push_to_remote` (via kiro_powers). Kalau push rejected → rebase
  ulang lawan `origin/main` (auto-refresh workflows sering push data.json /
  tracker.json / headlines.json → butuh re-rebase sebelum retry push).
- **Working tree dirty utility files**: pipeline auto-refresh sering modif
  `public/data.json`, `public/tracker.json`, `public/headlines.json`. Sebelum
  rebase / push, jalankan: `git checkout public/data.json public/tracker.json
  public/headlines.json` untuk discard local changes ke files itu (mereka
  auto-generated).
- **Sandbox tools**: pakai `kiro_powers` action=use serverName=github utk push,
  BUKAN raw `git push`.
- **User bicara Indonesian** — commit messages boleh mix ID/EN tapi respons
  chat ke user pakai Indonesian.
- **User visual thinker** — sering share screenshot, respons harus explain
  visual behavior dgn contoh konkret + tabel.

## 2. Repo & File Landmarks

- File utama semua UI: `public/index.html` (~22k baris, single-file SPA).
- **Firm-page IIFE (Tracker → Tab Analis)**: line ~5610-6900. Handle:
  master-detail sidebar list sekuritas + panel kanan (hero, KPI, 2 chart,
  rec list). Semua state di closure IIFE.
- **Dashboard Price Target Blueprint**: `renderPriceTarget(code)` line
  ~15095. `updatePtSigSignal(code)` line ~15304. `ptSigmaTriggers(code)`
  line ~14737. `renderChart(code)` line ~14756.
- **Global helpers exposed**:
  - `window.__TR_openFirm(id)` — buka firm profile di tab Analis.
  - `window.__TR_getLive(ticker)` — priority chain untuk live price + change
    (sinkron dgn dashboard). Return `{price, changePct}` — changePct udah
    dikonversi ke percent scale (×100).
  - `window.__TR_getModeFloating(rec, mode)` — floating% berdasar mode.
  - `window.__TR_getBaseLabelForMode(mode)` — "beli di harga entry" / "open".
  - `window.__TR_getActiveMode()` → `{entry, exit}` mode aktif.
  - `window.__TR_getData()` → `window.__TR_DATA__` (tracker.json payload).
  - `window.__TR_onData(cb)` — subscribe ke data ready event.
  - `window.__TR_showRec(rec)` — buka rec-modal popup (candlestick +
    zona entry/TP/SL).
  - `window.__TR_findRecById(id)` — lookup rec by id dari openList/
    historyList/pendingList/missedList.
  - `window.__TR_switchTab(name)` — pindah sub-tab di Tracker.

## 3. Tab Analis — Struktur Lengkap

### Master-detail layout
- Kiri: sidebar list sekuritas (searchable, sortable by trades desc)
- Kanan: firm detail panel

### Sidebar item (`.tr-mdet-item`)
- Format: avatar (initials) + nama pendek + `[trades] trd WR [x]%`
- **TANPA angka net%** (dipindah ke tab Asumsi karena bikin confuse dgn
  Net Return mode-aware di panel kanan).

### Panel kanan (`#trMdetPanel`) — SEMUA konten firm detail:

1. **Hero card** — avatar, nama, verified badge, meta (trade/analis/
   high-score), sector focus chips
2. **KPI row (6 cards, compact)** — grid `auto-fit minmax(122px,1fr)`:
   - WIN RATE (dari `st.wr` di computeModeStats)
   - NET RETURN (kumulatif realized, mode-aware combo)
   - **FLOATING BERJALAN** — akumulasi (SUM) floating rec aktif via
     `computeActiveFloatingSum(firm, entryMode)`. Realtime dari DATA.live.
   - PROFIT TERTINGGI (best trade, sub: 🏆 ticker · tgl)
   - CUTLOSS TERENDAH (worst trade, sub: ⚠ ticker · tgl)
   - TOTAL REKOMENDASI (count breakdown di sub)
3. **Mode selector row** (`.tr-pf-seg-wrap`) — 2-dimensional:
   - Header: label "🎛 Mode Eksekusi [combo aktif]" + kalender trigger
     "📅 [date range]" di kanan
   - Grup **Metode Entry** (kiri): [📍 Beli di Entry] [⚡ Beli HAKA (Open)]
   - Grup **Target Exit** (kanan): [🎯 TP1] [🏆 TP2]
   - Divider vertikal antara grup (stack di <700px)
   - Tiap tombol punya ikon **ⓘ** kecil di kanan label — klik → popup
     keterangan MODE SPESIFIK itu (bukan mode aktif)
   - Stats bar di bawah: WR · Net · Rata² · Trade tercatat (dari
     `computeModeStats`, MODE-AWARE, respects date filter)
   - Rule: klik Metode Entry → reset Target Exit ke TP1. Klik Target Exit
     → keep Metode Entry
4. **2 chart cards** (`.tr-pf-charts-row`) sejajar di ≥1100px:
   - **Grafik Performa Konsensus 30 Hari** — vanilla canvas
     (`renderDayChart`), agregasi `pnlPure` per exitDate, MODE-AWARE via
     `computeFirmDailyEquity(firm, entry, exit)`. Filter by _dateFilter.
   - **Return Kumulatif · Simulator Eksekusi** — Chart.js line
     (`renderCumChart`), firm vs IHSG. Kurva dari `computeCumSeries(firm,
     entry, exit)`. Filter by _dateFilter.
5. **Rekomendasi Sekuritas section**:
   - 5 tabs: Semua / Aktif / Menunggu / TP1 / TP2 (dgn counter angka)
   - Tab counters ikut `_dateFilter` range
   - Rec cards (`.tr-rec.tr-rec--slim`):
     - Top row: `[N]` nomor urut list + ticker + `Rp[price] [±X.XX%]` live
       + `· nama-analis` + big pct kanan + BUY/SELL badge
     - Big pct di top-right (15px monospace bold):
       - active/missed → floating mode-aware, green/red
       - closed → realized `getRecPnl(rec, entry, exit)`, green/red
       - pending → **NO number** (kosong di top-right; per user rule
         "menunggu jangan kasih angka floating")
     - Small label di bawah big pct: "beli di harga entry" / "beli di
       harga open"
     - Chip row inline: `[ENTRY 6.100] [TP1 6.350 +4.1%] [TP2 6.475 +6.1%]
       [STOPLOSS 5.975 -2.0%]` — pct suffix mikro di chip TP/SL,
       label ALL-CAPS, value monospace 12px bold
     - Footer: `📅 [date long] · sector` + state label kanan
       (🎯 Kena TP1 / ⏳ Menunggu / 🚀 Harga Lari / dll)
   - Klik row → `window.__TR_showRec(rec)` → candlestick popup (via
     capture-phase handler pada data-recid)

### Calendar range picker (di header Mode Eksekusi)
- Trigger: tombol "📅 Semua Tanggal ▾" di kanan header seg-wrap
- Popup: grid 7×6 kalender + navigasi bulan ‹ › + footer
- **Range picker interaction** (baru — commit a4278de):
  - Klik tgl A → set start, highlight A sbg 'selected'
  - Klik tgl B → set end (auto-swap kalau B<A), highlight A/B sbg
    range-start/range-end + days in-between sbg in-range
  - Klik tgl ke-3 → reset ke new start
  - Klik tgl start lagi → cancel end (kembali single-day)
  - **Klik OK** → commit `_dateFilter = {start, end}` + closepopup +
    rerenderAll
  - Klik **🌐 All** → reset ke null + tab kembali ke Semua
- State variables:
  - `_dateFilter` = null | `{start:'YYYY-MM-DD', end:'YYYY-MM-DD'}`
    (single-day: start===end)
  - `_calPending` = null | `{start, end:null}` | `{start, end}` — temp
    selection saat popup terbuka
  - `_calView` = `{y, m}` bulan yg sedang di-view di grid
  - `_calRecDates` = Set of ISO strings tgl yg ada rec (cache per firm)
- Dot ungu di tgl yg ada rec. Semua tgl klik-able (bahkan yg tak ada dot,
  karena user butuh fleksibilitas pick range boundary).
- Filter propagation via `_recInDateFilter(rec)` helper — applied di
  `computeModeStats`, `computeCumSeries`, `computeFirmDailyEquity`,
  `computeActiveFloatingSum`, dan `_byDate` di `renderRecList`.

## 4. Data Sources — Live Price Chain

**Priority mirror dashboard** (via `__TR_getLive`):
```
Price:  DATA.live[t].price → DATA.stats[t].current
Change: DATA.stats[t].change_pct_live → DATA.live[t].change_pct
```

`change_pct` di data.json = **FRACTION** (0.0199 = 1.99%). Display butuh ×100.
Helper `__TR_getLive` sudah handle konversi otomatis.

Sinkron dgn dashboard via polling:
- `_pollLiveData()` — polling data.json tiap ~60s, update DATA.live.
- `applyLiveFeed(live, fullRender)` — apply live feed dari Worker.
- Tracker Analis: 30s setInterval re-render KPI + ModeStats + RecList
  (bukan chart, expensive) → chip Floating + FLT + `Rp{price} ±X%` samping
  ticker auto-update.

## 5. Mode-Aware Compute Logic

### getRecPnl(rec, entryMode, exitMode)
Filter recsHistory + kompute P/L per rec.

**entryMode**:
- `'entry'` — beli saat harga sentuh entry. Base = rec.entry. Butuh
  `rec.didTouchEntry=true`, kalau tidak return null.
- `'haka'` — beli saat open tgl rilis. Base = rec.openPriceAtPublish.
  Skip kalau `open > TP1` (kelewatan) — kecuali harga sempat balik ke entry
  (didTouchEntry=true) → fallback masuk di entry.

**exitMode**:
- `'tp1'`:
  - hitTP1 → exit di rec.tp1 (WIN)
  - closedBy===SL → exit di rec.sl (LOSS)
  - else → exit di rec.exitPrice (EXPIRED/other)
- `'tp2'`:
  - Skip kalau rec.tp2 null (rec tak punya TP2 target)
  - hitTP2 → exit di rec.tp2 (WIN besar)
  - hitTP1 tapi tak TP2 → exit di rec.tp1 (trailed stop, per user rule
    "sebelum TP2 harga kembali ke TP1 → stop")
  - closedBy===SL → exit di rec.sl (LOSS)
  - else → exit di rec.exitPrice

Formula: `pnl = ((exit - entry)/entry) × 100 × (buy ? 1 : -1)`

### getModeFloating(rec, entryMode)
Live floating dari `DATA.live[ticker].price` vs base (entry-touch atau
haka-open). BUY-adjusted. Dipakai:
- FLT chip di rec list (active/missed cards)
- Big P&L top-right (active/missed)
- Popup rec-modal P&L untuk rec aktif
- Floating Berjalan card (SUM of active recs)

Untuk PENDING: getModeFloating returns valid number (via haka mode), tapi
UI-nya SENGAJA tidak ditampilkan (top-right kosong) per user rule.

## 6. Sub-Tab Structure di Tracker

```
📋 Ringkasan · 📈 Analisis · 🚀 Live · 📊 Performa · 👤 Analis · 🎲 Asumsi · 📊 Simulasi
```

- **Ringkasan** (`tr-view-main`) — ada tabel "Direktori Analis" (byAnalyst)
  dgn kolom Analis/Sekuritas/Trade/WR/Net/Rata². Fallback rules:
  * Sekuritas kosong → pakai nama analis (di-set build script line 406)
  * Analis kosong → pakai kolom Q sheet (`analyst.sheetQ` field —
    dipropagate via `row._cols[16]` di build-tracker.js). Tag `fallback Q`
    muncul kalau nama diambil dari kolom Q.
- **Analis** (`tr-view-analis`) — master-detail firm profile (main focus
  seluruh session ini).
- **Asumsi** (`tr-view-asumsi`) — tabel semua firm dgn stats default 50/50
  staged strategy (dari `firm.netPure/avgPure/best/worst/alpha`). Klik row
  → buka detail firm di tab Analis.
- **Simulasi** (`tr-view-acc`) — skeleton empty state, blm dikembangkan.

## 7. Dashboard Price Target Blueprint

Fitur baru (commit 5dc9ae6, 77467a6, 6a7aa6f, c3fb145):

### Date picker "As-Of" (di card Price Target Blueprint)
- Dropdown `#ptDateSel` di header block Standar Deviasi Buy/Sell
- Options: semua bulan dari `DATA.price_history` (~121 bulan)
- Reset button `↺` muncul saat dated mode aktif
- Badge kuning `AS-OF` di header saat isDated

### Behavior
Saat user pilih tgl (bukan latest):
- Blueprint: harga + BELI/JUAL + %change semua recompute pakai
  `recomputeStatsUpTo(code, dateIdx)` (avg + std dari price_history[0..idx])
- **Chart** juga ikut update:
  - Price line: truncate ke as-of date via `ph.slice(0, asOfIdx+1)` di
    `renderChart(code)`
  - BELI/JUAL horizontal lines: bergeser via `ptSigmaTriggers(code)` yg
    baca localStorage date-idx → pakai dated stats

Sync via `updatePtDate(code, forceIdx?)`:
```js
localStorage.setItem/removeItem(`econ-pt-dateidx-${code}`, idx)
renderPriceTarget(code)   // blueprint + BELI/JUAL zones
renderChart(code)          // chart price line + BELI/JUAL lines
```

## 8. Commits Landed di Session Ini (kronologis, terbaru dulu)

- `a4278de` — range date picker (klik start, klik end, OK) + filter propagation ke KPI+charts
- `1301cf1` (superseded) → previous commit
- `dc94e8d` — nomor urut list (1,2,3,...) + cancel jarak ke entry
- `e23161d` (superseded)
- `d909b88` — pending rec "jarak ke entry" (rejected by user, reverted in dc94e8d)
- `f60fe10` — kecilin KPI card supaya 6 muat 1 row (opsi A)
- `eb5a098` — KPI card baru "Floating Berjalan"
- `92f8c5e` (superseded)
- `2b93c2b` → `8804281` — unified live helper + floating mode-aware + keterangan basis
- `82e1209` — pct melekat ke TP/SL chip + P&L/floating besar sebelah BUY
- `533066a` — harga live + change% today samping ticker
- `3f068e7` (superseded)
- `db5da1b` (superseded) → `d98f7e7` — samaratakan tinggi 2 chart card
- `04883ad` — 2 chart card sejajar di PC (≥1100px)
- `df97f7b`, `0bd2c58` — popup keterangan per-tombol (ⓘ di setiap seg-btn)
- `961583e` — mode selector di atas 2 chart + popup keterangan
- `b9f70c9` — Analis tab jadi master-detail (list sekuritas + halaman firm)
- `2f886fb` — RATA² card diganti Profit Tertinggi + Cutloss Terendah
- `f741b59` — date long-format + mode buttons sync rec list filter
- `d0cb1d9` → `03199df` — fix WR 100%, 5 tab filter + sort tanggal, klik rec → popup live
- `5ac2658` → `b264ee0` — mode selector 2-dimensi (Metode Entry × Target Exit)
- `7bc0d84` — chip filter tanggal + "All Rekomendasi" reset (superseded oleh calendar range picker)
- `e8e58aa` (superseded) → `38faa47` — calendar popup filter tgl + floating% chip
- `6894193` (superseded) → `3abfce6` — tab baru "Asumsi"
- `5dc9ae6` — dashboard/blueprint: chart ikut update saat date picker berubah
- `77467a6` (superseded) → `6a7aa6f`, `c3fb145` — date picker as-of di Price Target Blueprint
- (banyak lagi commit auto-refresh data yg diselipkan di antaranya)

## 9. Verification Baseline

Setiap commit terakhir seharusnya lulus:
- **DIV balance**: `diff = 1` (baseline stable)
- **19 script blocks parse OK, 0 errors**

Cek dgn:
```bash
env -u NODE_OPTIONS node -e "
var fs=require('fs');
var html=fs.readFileSync('public/index.html','utf8');
var noScript = html.replace(/<script[\s\S]*?<\/script>/g,'');
var opens=(noScript.match(/<div\b/g)||[]).length;
var closes=(noScript.match(/<\/div>/g)||[]).length;
console.log('DIV diff:',opens-closes);
var re=/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; var m,i=0,errs=0;
while((m=re.exec(html))!==null){ try{ new Function(m[1]); }catch(e){ errs++; console.log('ERR:',e.message.slice(0,150)); } i++; }
console.log('SCRIPTS:',i,'ERRORS:',errs);
"
```

## 10. Design Decisions Log

- **Mode buttons ↔ rec list sync**: Klik Metode Entry/HAKA → rec list tab
  auto = "Semua" (broaden, karena Entry/HAKA tidak spesifik ke TP hit).
  Klik TP1/TP2 → rec list tab auto = "TP1"/"TP2" (narrow).
- **WR realistic (not 100%)**: getRecPnl untuk TP1/TP2 mode INCLUDE losses
  (SL) — supaya WR reflect realistic strategy simulation (~38-40%), bukan
  filter-only-wins yg selalu 100%.
- **Semua "harga sekarang" pakai sheet live** — never `rec.lastPrice`
  (snapshot tracker.json, bisa drift). Selalu `DATA.live` via `__TR_getLive`.
- **Realtime auto-refresh 30s** di firm profile: renderKpi + renderModeStats
  + renderRecList (bukan chart — expensive).
- **Nomor urut rec list** ikut sort direction (default desc = Terbaru dulu
  → nomor 1 = most recent). Reset per tab & per filter.
- **Sidebar sengaja simple** (nama + trades + WR only) — angka net% pindah
  ke tab Asumsi supaya tak confuse dgn Net Return mode-aware di panel.
- **Range picker**: semua tgl klik-able (bahkan yg tak ada dot rec) →
  user bisa pick range boundary fleksibel. Auto-swap kalau end < start.
  Discard pending kalau tutup popup tanpa OK.

## 11. Common Pitfalls Dihindari

- **`change_pct` di data.json = FRACTION** (0.0199). Harus ×100 untuk
  display sbg percent. `__TR_getLive` sudah handle.
- **Tracker.json sering di-refresh oleh workflow** → `git checkout
  public/tracker.json` sebelum push, kalau ada working tree modif.
- **Ternary tanpa closing paren** = silent parse failure. Selalu verify
  parse setelah edit besar dgn `node -e ... new Function ...`.
- **_dateFilter shape berubah** dari string ke `{start, end}` object.
  Kalau ada legacy code yg refer string, harus update.

## 12. Cek Cepat Setelah Buka Sesi Baru

```bash
cd /projects/sandbox/terminal
git log --oneline -5      # lihat 5 commit terakhir
git status --short         # verify clean working tree (utility files bisa dirty — checkout kalau perlu)
```

Lalu tinggal tanggapi request user berdasarkan konteks di dokumen ini.
