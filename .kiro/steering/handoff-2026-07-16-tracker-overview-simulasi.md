# Handoff — Tracker Overview redesign + Simulasi Emas Antam
**Tanggal**: 2026-07-16 · **Commit terakhir**: `6c42c92`

Rangkuman lengkap sesi 16 Jul 2026: redesign menu **Tracker → Overview** (13 commit) dan penambahan mode **Emas Antam** di menu **Simulasi**. Handoff ini menyimpan konteks penuh supaya sesi baru bisa lanjut tanpa hilang benang merah.

---

## 1. Ringkasan commit (kronologis, top = terbaru)

| # | Commit | Ringkasan |
|---|--------|-----------|
| 13 | `6c42c92` | tracker(overview): klik ticker → langsung tab Analisis (skip popup drawer) |
| 12 | `ea1b5c0` | simulasi: add Gold (Emas Antam) investment mode |
| 11 | `8012d3e` | tracker(overview): show all recs + kolom # (no urut) |
| 10 | `c044296` | tracker(overview): bar chart harian + kalender filter Top Tickers |
|  9 | `0bcdd0b` | tracker: hide top-nav "Tracker" icon di PC + hard-lock Analis loading |
|  8 | `2a5d88f` | tracker: hide inline emoji icons across all menu titles on PC |
|  7 | `0faa37b` | tracker: add change%, drop Analis loading state, hide subtab icons PC |
|  6 | `fc0ec16` | tracker(overview): add Harga column to Rekomendasi Terbaru feed |
|  5 | `db56b27` | tracker(overview): fix trend range + column headers + drop dist donut |
|  4 | `ca12d4b` | tracker(overview): merge ranking → Rekomendasi Terbaru + i18n pending→menunggu |
|  3 | `edd64a6` | tracker(overview): adopt consensus overview patterns (trend + top tickers + feed) |
|  2 | `bb2e948` | tracker(overview): remove 4 top KPI cards + fix barometer overlap |
|  1 | `b156061` | feat(tracker): add outcome donut to overview |

---

## 2. State akhir Tracker → Overview (setelah 13 commit)

Layout sekarang (top → bottom):

```
📋 Overview
   Ringkasan: "N rekomendasi aktif · M sekuritas · update ..."
📈 Chart Performa 30 Hari (analis vs IHSG)
🎴 3 Highlights (grid 3-kolom):
   - 📊 Distribusi Hasil   → stacked bar TP1/TP2/SL/Expired + count text (NO DONUT)
   - ⚡ Aktivitas 24 Jam   → 3 stat mini (baru rilis, hit TP, hit SL)
   - 🌐 Sentimen Analis    → barometer SVG + badge
📈 Grid 2-kolom:
   - Aktivitas Rekomendasi → bar chart HARIAN dari openDate (kolom L sheet)
   - Saham Paling Aktif    → h-bar top 10 + tombol 📅 kalender filter tgl
📋 Rekomendasi Terbaru (feed):
   Toggle: [Terbaru | Per Firm]
   Terbaru: SEMUA rec (bukan cap 20), kolom # · Tanggal · Kode · Sekuritas · Harga · Target · Status · P&L
   Per Firm: semua firm (min 5 trade), filter Basis (Winrate/Net) × Target (TP1/TP2)
```

**Yang DIHAPUS dari Overview:**
- 4 kartu KPI atas (WIN RATE / NET RETURN / ALPHA / RETURN IHSG) — element id2 masih ada sbg `<span>` hidden untuk backward-compat null-safe renderer
- Kartu ranking standalone "🚀 3 Teratas / 📉 3 Terbawah" — logic dipindah ke view Per Firm dalam panel Rekomendasi Terbaru
- Donut/pie chart di Distribusi Hasil (`_trOvOutcomeDonut` + CSS `.tr-ov-outcome-*`)
- Empty state "menunggu tracker.json" di tab Analis (pulsing dot dianggap loading state)

---

## 3. Fitur Baru Tracker Overview — detail teknis

### A. Aktivitas Rekomendasi chart (`updateOvTrend`)
- Selalu **daily bar chart** dari `openDate` (= kolom L Tracker sheet)
- Setiap tanggal unique dapat 1 bar. Bar 0 dirender samar (`rgba(109,40,217,.06)`)
- Sub-label dinamis: "N hari aktif · min → max" dari rentang asli data
- **BUKAN** rolling 12mo dari `updatedAt` seperti sebelumnya

### B. Saham Paling Aktif + Kalender Filter (`updateOvTopTickers` + kalender)
- H-bar chart top 10 ticker berdasar rec count
- **Klik bar** → `window.__TR_openAnalisis(ticker)` (bukan `__TR_openStock` drawer)
- Tombol `📅 Semua Tanggal ▾` di header panel dengan popup kalender:
  - IDs: `trOvTickDateBtn`, `trOvTickCalPopup`, `trOvTickCalGrid`, `trOvTickCalPrev/Next/Reset/Ok`
  - State: `_tovTickDateFilter`, `_tovTickCalPending`, `_tovTickCalYM`, `_tovTickDaySet`, `_tovTickDayCount`
  - Reuse CSS `.tr-pf-cal-popup` + `.cal-*` (existing dari halaman Analis Performa)
  - Range picker: klik tgl awal → klik tgl akhir → OK apply · All reset
  - Dots di tanggal yg punya rec, tooltip `"N rekomendasi"`

### C. Rekomendasi Terbaru feed (`renderLatestRecent` + `renderLatestFirms`)
- **Toggle** `[Terbaru | Per Firm]` (id `trOvLatestBtns`) di header panel
- **View Terbaru**: 8 kolom grid — # · Tanggal · Kode · Sekuritas · Harga · Target · Status · P&L
  - **Semua** rec (tidak dicap 20), sorted desc by `openDate`
  - Container `.tr-ov-latest-list` scrollable `max-height:640px`, header sticky `top:0`
  - **Kolom Harga**: `lastPrice` (aktif/pending) → `exitPrice` (closed) → `entry` (fallback). Inline dgn **change %** hari ini (dari `DATA.live[ticker].change_pct * 100`) — HANYA untuk rec dgn harga live
  - **Klik ticker** → `__TR_openAnalisis(ticker)`; **klik firm** → `__TR_openFirm(firmId)`
- **View Per Firm**: ranking semua firm (min 5 trade selesai), filter Basis × Target
  - Basis: Winrate | Net Return · Target: TP1 | TP2
  - Row: rank medal (1/2/3) + firm name + trade count + secondary + primary
  - Klik → `__TR_openFirm`
  - `computeFirmStats(firm, target)` re-simulate exit path per pilihan

### D. i18n pending → menunggu (semua sub-tab Tracker)
- Badge label "PENDING" (visible) → "MENUNGGU"; "ACTIVE" → "AKTIF"; "MISSED" → "TERLEWAT"
- CSS class + internal state string `'PENDING'` **tetap** untuk backward-compat logic
- Diterapkan di:
  - `renderRecTable` (Analisis tab)
  - `updateOvLatest` (Overview feed)
  - `trRecModalStatus` (popup detail rec)
  - Initial HTML `<span>ACTIVE</span>` → `AKTIF`

### E. Icon emoji hidden di desktop
- **33 emoji** di tracker page dibungkus `<span class="tr-ico" aria-hidden="true">…</span>`
- Sub-tab bar: `<span class="tr-subtab-ico">…</span>`
- Top-nav "Tracker" tab: `<span class="tr-nav-ico">…</span>`
- Media query scoped: `@media(min-width:641px){ .tr-menu .tr-nav-ico, #page-tracker .tr-subtab-ico, #page-tracker .tr-ico { display:none } }`
- HP tetap tampilkan icon (bantu scan menu saat teks pendek)

### F. Hard-lock Analis loading state
- Element `#trAnalisPending` diubah dari `<div class="tr-empty">` menjadi hidden `<span>` dgn class `.tr-analis-hidden`
- `#trAnalisContent` dapat class `.tr-analis-shown`
- CSS `!important` guarantees:
  ```css
  #trAnalisPending.tr-analis-hidden{display:none !important}
  #trAnalisContent.tr-analis-shown{display:grid !important}
  ```
- Ini mengalahkan `style.display=''` yang di-set JS lawas ketika data belum ready

### G. Klik ticker langsung ke halaman Analisis (bukan drawer)
- **New export**: `window.__TR_openAnalisis(ticker)` di IIFE Analisis
- Flow: `__TR_switchTab('analisis')` → retry `switchTicker(ticker)` sampai 20× × 120ms
- Overview click handlers prefer `__TR_openAnalisis`, fallback `__TR_openStock` untuk defensive
- Diterapkan di: klik bar Saham Paling Aktif · klik row Rekomendasi Terbaru · klik `data-action="stock"` di feed

---

## 4. Fitur Baru menu **Simulasi** — Gold (Emas Antam)

### Toggle asset di form Pengaturan Portofolio
```
Jenis Investasi:
  [ 📈 Saham IDX ]  [ 🥇 Emas Antam ]
```
State: `_savingAsset = 'stock' | 'gold'`

### Perilaku saat Emas dipilih (`setSavingAsset('gold')`)
- Input "Pilih Saham" (id `savingStockGroup`) di-hide
- Chip info emas (id `savingGoldGroup`) muncul: "🥇 XAU · Emas Antam (IDR/gram) · per 2026-07"
- Kontrol Dividen (`savingChartCtrl`) auto-hidden (emas tidak bagi dividen)
- Date options di-rebuild dari `getGoldHistory()`
- Lazy fetch `macro.json` via `loadMacroForGold()` (idempotent)

### Sumber data harga emas
1. **Primer**: `macro.gold.priceHistory[]` dari `macro.json`
   - Diisi oleh `scripts/build-macro.js` (sudah di-update di sesi ini)
   - Formula: Yahoo GC=F (USD/oz) × IDR=X (USD/IDR) ÷ 31.1035 = IDR/gram bulanan
   - Struktur: `{ date, label, price }` (compatible dgn `DATA.price_history`)
   - Refresh cron: **workflow `refresh-macro` mingguan** (Senin 23:00 UTC)
2. **Fallback**: `_GOLD_FALLBACK[]` — array 118-baris hardcoded di `index.html`
   - Rentang: Oct 2016 → Jul 2026
   - Anchor Antam publik + interpolasi linear
   - Format: `{d:"YYYY-MM-DD",l:"Mmm YY",p:number}`
   - Aktif immediately tanpa nunggu workflow

`getGoldHistory()` returns `[{date, label, XAU: number}]` (XAU sebagai virtual ticker) — dipakai oleh `calculateSaving` dgn `code='XAU'`.

### Perhitungan (asset-aware)
| Aspek | Saham | Emas |
|-------|-------|------|
| Unit | lot (100 lembar), integer | gram, fraksional 2 desimal |
| Rounding | `Math.floor(monthly/price/100)*100` | `Math.floor((monthly/price)*100)/100` |
| Dividen | dari `valuation.json` per code | **skip** (emas tidak bagi dividen) |
| Kode | ticker (BBCA/TLKM/...) | `'XAU'` (virtual) |

### UI/label asset-aware
- **Judul kartu**: `Hasil Simulasi DCA · Emas Antam` (bukan `... · XAU`)
- **Header tabel**: "Beli (gram) / Total Gram" vs "Unit / Total Unit"
- **Ringkasan**: "🥇 Nilai Emas Sekarang" + note "Emas tidak bagi dividen"
- **Chart tooltip**: "Total: 45.75 gram" vs "45 lot (4500 lembar)"
- `_savingSim.isGold` flag mengalir ke semua renderer

### Files touched utk Emas
- `public/index.html`:
  - HTML: `savingStockGroup`, `savingGoldGroup`, `assetStock`/`assetGold` buttons
  - JS: `_savingAsset`, `_macroCache`, `_GOLD_FALLBACK` (constant ~4.4KB), `getGoldHistory()`, `loadMacroForGold()`, `setSavingAsset()`
  - Modified: `setSavingMode()`, `buildDateOptions()`, `calculateSaving()`, `showSavingResult()`, `renderSavingTable()`, `renderSavingSummary()`, `drawSavingChart()`
- `scripts/build-macro.js`:
  - Tambah blok emit `gold` di payload dgn `priceHistory[]`
  - Formula konversi USD/oz → IDR/gram di dalam main()
  - Fallback null bila data GC=F atau IDR=X tidak lengkap

---

## 5. Global API tracker (yang di-expose ke `window`)

Untuk cross-IIFE communication di tracker:

| API | Sumber IIFE | Fungsi |
|-----|-------------|--------|
| `window.__TR_getData()` | Main | Return `window.__TR_DATA__` (tracker.json terakhir) |
| `window.__TR_onData(cb)` | Main | Subscribe callback saat data ready |
| `window.__TR_switchTab(name)` | Main | Switch sub-tab (`ringkasan`/`analisis`/`live`/`perf`/`analis`) |
| `window.__TR_openFirm(id)` | Analis IIFE | Buka firm profile di tab Analis |
| `window.__TR_openStock(ticker)` | Drawer IIFE | Buka drawer popup (LEGACY — sekarang jarang dipakai) |
| `window.__TR_openAnalisis(ticker)` | Analisis IIFE | **BARU** — switch ke tab Analisis + load ticker |
| `window.__TR_findRecById(id)` | Modal IIFE | Cari rec by id di semua bucket |

---

## 6. Konvensi & aturan yang harus dihormati

### Push workflow
- Auto-refresh bot rutin push tiap 5-15 menit (data.json, headlines.json, macro.json)
- Setelah commit lokal: **selalu `git rebase origin/main`** sebelum push
- Pola race: `Rebasing (1/1)` → `Successfully rebased` → push OK
- Use `github_push_to_remote` tool, jangan `git push` raw

### CSS/JS scoping tracker
- Semua selector Overview scoped ke `#tr-view-main` supaya tidak bocor
- Prefix class `.tr-ov-*` (Overview), `.tr-anl-*` (Analisis), `.trAnl-*` (widget dlm chart card), `.tr-live-*`, `.tr-perf-*`
- Kalender reusable: `.tr-pf-cal-popup` + `.cal-*` (didefinisikan di Analis Performa, dipakai ulang di Overview)

### Backward compat
- Sebelum hapus element visible, cek dulu apakah ada JS lain yg reference id-nya
- Element yg mau dihapus tapi tetap perlu id → convert ke hidden `<span>` (mis. `trAnalisPending`, `trKpiWr` dll)
- Renderer yg pakai `if (el) { ... }` null-safe → aman kalau id hilang

### i18n
- User prefer bahasa Indonesia untuk visible label
- State internal (mis. `'PENDING'`, `'TRIGGERED'`) TETAP English — hanya display yang di-map ke ID

### Icon di PC
- Selector: `@media(min-width:641px){ .tr-menu .tr-nav-ico, #page-tracker .tr-subtab-ico, #page-tracker .tr-ico { display:none } }`
- Untuk emoji BARU di future work di tracker page → **bungkus dgn `<span class="tr-ico" aria-hidden="true">…</span>`** supaya konsisten

---

## 7. Known limitations / TODO next session

1. **Data emas real** — sekarang fallback statis. Workflow `refresh-macro` mingguan (Senin 23 UTC) akan populate `macro.gold.priceHistory`. Bisa trigger manual via `workflow_dispatch` untuk speed up.
2. **Chart Aktivitas skewed** — data 366 hari daily, 512 rec cluster di Jul 2026. Chart valid tapi shape ekstrem. Belum ada zoom/date-picker di chart ini (hanya di Top Tickers).
3. **`__TR_openAnalisis` retry mechanism** — kalau data belum ready dalam 2.4 detik (20×120ms), klik dari Overview akan silently gagal. Extreme edge case; belum reproduce.
4. **Mobile row layout Rekomendasi Terbaru** — kolom Target di-hide di HP. Kalau user butuh, expand ke desain 3-baris.

---

## 8. Files pada state akhir sesi

**Modified this session:**
- `public/index.html` (13 commits worth of edits — Overview redesign + Emas)
- `scripts/build-macro.js` (emit gold block)

**No test suite** — user tidak minta test; validasi via `git diff --check` + `node --check` on merged scripts + manual review structural.

**Auto-refreshed by workflows (jangan commit di PR fitur):**
- `public/data.json`, `public/headlines.json`, `public/insights.json`, `public/macro.json`, `public/ohlc.json`, `public/tracker.json`, `public/valuation/*.json`

---

## 9. Cara resume di sesi baru

1. Sesi baru mulai dengan mode Vibe atau Autonomous (sesuai kebutuhan)
2. Baca dokumen ini + `.kiro/steering/handoff-2026-07-15-tracker-refinement.md` untuk sejarah Tracker sebelum sesi ini
3. Cek `git log --oneline -30 | grep -v skip` untuk lihat state terkini
4. Kalau user minta lanjutan fitur Tracker/Simulasi:
   - Tanya spec detail (jangan asumsi)
   - Baca dulu file relevan sebelum edit (never propose changes to code you haven't seen)
   - Follow convention: rebase-then-push, i18n visible labels, icon-hide pattern, `.tr-ov-*` scope

---

_Handoff ditulis sesi 2026-07-16, HEAD `6c42c92`._
