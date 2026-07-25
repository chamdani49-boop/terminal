# Handoff 2026-07-25 — TP1 Lock rule, Live-status Override, Overview Filter Sync

Session tanggal 25 Juli 2026, membahas 4 rangkaian besar perubahan di menu **Tracker** (Overview + Analis + Popup). Semua sudah di-commit langsung ke `main`.

## Context singkat

User rekomendasi saham CGS International Sekuritas, saham **ENRG** — entry 1.525, TP1 1.585, TP2 1.615, SL 1.495. Live saat itu 1.450. Chart menunjukkan harga sempat naik lewat TP1 (~1.590) tanggal 22 Jul, LALU balik turun sampai kena SL. Kasus klasik **SL_TRAIL** — TP1 hit lalu balik ke area SL.

Percakapan berputar mencari treatment yg tepat untuk skenario ini + memastikan konsistensi di seluruh menu Tracker.

---

## 1. Aturan TP1 LOCK (final, jangan diutak-atik)

**Rule bisnis utama** — pertanyaan user untuk winrate & return:

> **Sekali harga menyentuh TP1, rec DIHITUNG SEBAGAI TP1 WIN**, meskipun setelah itu harga jatuh balik ke SL area (SL_TRAIL). Ini disebut "TP1 lock" — analis dianggap sukses karena TP1 tersentuh.

Universe rec closed (4 kategori):

| `closedBy` (dari backend) | Status | Winrate | Return exit |
|---|---|---|---|
| `TP1` | **TP** WIN | +1 win | at `rec.tp1` |
| `TP2` | **TP** WIN | +1 win | at `rec.tp2` |
| `SL_TRAIL` (TP1 hit lalu balik SL) | **TP** WIN | +1 win | at `rec.tp1` |
| `SL` murni (belum TP1) | **SL** LOSS | +1 loss | at `rec.sl` |
| `EXPIRED` / `EXPIRED_UNFILLED` | **NETRAL** | tidak masuk | at `rec.exitPrice` |

### PENTING: interpretasi user yg pernah salah dulu

User pernah bilang **"gak perlu ada sl trail"** — dulu aku salah tafsir sebagai "hapus WIN treatment SL_TRAIL". User klarifikasi:
- Yang dimaksud: **tidak perlu klasifikasi terpisah `SL_TRAIL`**, karena secara semantic sudah TP1 (TP1 lock)
- WIN treatment tetap berlaku — SL_TRAIL = TP1 WIN
- Label badge boleh tetap `🛡 SL Trail` untuk konteks (icon shield indicates trailed stop history), tapi CLS harus green tp (WIN), bukan merah sl

Kalau user bilang "hapus sl trail" lagi, JANGAN diubah jadi LOSS. Tanyakan dulu apakah maksudnya rename label saja.

---

## 2. Live-status Override

**Masalah**: Backend `build-tracker.js` di-rebuild periodik (via CI, biasanya harian). Antara 2 rebuild, harga **live** bisa cross ke level entry/TP/SL — tapi klasifikasi backend masih stale. Contoh: rec dirilis pagi tanggal 24 Juli dengan `didTouchEntry=false` di backend, tapi siang harga sudah kena entry — user melihat rec masih "Menunggu" padahal harusnya "Aktif".

**Solusi**: Helper `window.__TR_liveStatusOverride(rec)` yang derive status TENTATIVE dari harga live sekarang. Konsumen listing tinggal call helper ini.

### Return value

- `'ACTIVE'` — entry sudah touched (backend flag OR live-derived), belum ada level TP/SL yg di-cross
- `'TP2_LIVE'` — live sudah lewat TP2 (harga di atas TP2 utk BUY)
- `'TP1_LIVE'` — live sudah lewat TP1 (tapi bukan TP2)
- `'SL_LIVE'` — live sudah lewat SL (harga di bawah SL utk BUY)
- `null` — no override (backend sudah closed rec, atau harga live tak tersedia, atau entry belum tersentuh)

### Rule detection

| Direction | Entry touched | TP hit | SL hit |
|---|---|---|---|
| BUY  | `live ≤ entry` | `live ≥ tp1/tp2` | `live ≤ sl` |
| SELL | `live ≥ entry` | `live ≤ tp1/tp2` | `live ≥ sl` |

Prioritas: **TP2 > TP1 > SL** (kalau breach multiple, ambil yg paling extreme).

### TP1 LOCK dalam liveStatusOverride

**PENTING**: fungsi ini cek `tpHits` di rec DULU:
```js
if (tpHits.indexOf('TP2') >= 0) return 'TP2_LIVE';
if (tpHits.indexOf('TP1') >= 0) return 'TP1_LIVE';
```

Kalau backend sudah rekam tpHits mengandung TP1/TP2, rec dianggap sudah kena TP1/TP2 — **tidak peduli** live sekarang di bawah SL. Ini implementasi TP1 lock di sisi live override.

### Lokasi

Definisi ada di **tracker IIFE** di `public/index.html` sekitar baris **7724** (dekat `getLive`), expose via `window.__TR_liveStatusOverride`.

---

## 3. Distribusi ke semua rec listing di menu Tracker

Semua fungsi status/badge terpusat, konsumen listing dapat konsistensi otomatis:

| Fungsi | Lokasi | Dipakai di |
|---|---|---|
| `stInfo` | ~7546 | Tracker section list (drawer sidebar) |
| `stateInfo` | ~8465 | Analis firm listing (renderRecList) |
| `stateBadge` | ~11101 | Dashboard/tab Live cards (renderCard) |
| `statusOfRow` | ~13697 | **Rekomendasi Terbaru Overview** (renderLatestRecent) |
| `statusOf` | ~14392 | Analis-per-ticker widget (Posisi Sekarang, KPI, table) |
| `statusOfRec` | ~15407 | Popup rec modal |

Semua sekarang **check `window.__TR_liveStatusOverride(rec)` sebelum fall back ke backend state**.

Backend `closedBy` selalu **menang** — kalau rec sudah diclose backend, live override return null.

### Rec live-promoted rendering di renderRecList

Di `renderRecList` (Analis firm listing), rec dgn live override dibuatkan copy dgn:
- `_bucket = 'active'` (untuk ACTIVE) atau `'history'` (untuk TP1/TP2/SL live)
- `_liveOverride = 'ACTIVE' | 'TP1' | 'TP2' | 'SL'`
- `didTouchEntry: true` (supaya getModeFloating bisa hitung floating)

Tab counters (`allN`, `actN`, `tp1N`, dst) sudah include live-promoted. Tab **Semua** wajib concat `liveTp1F + liveTp2F + liveSlF` juga — pernah ada bug ENRG tidak muncul di Semua karena missed concat. Sudah di-fix commit 6b56869.

Label badge **TIDAK** pakai suffix `(live)` — user request bersihkan text, mesin tetap jalan.

---

## 4. P&L display TP1 LOCK aware

Backend `pnlPct` di `tracker.json` untuk rec SL_TRAIL berisi **partial 50%** (strategi realisasi bertahap: 50% jual di TP1, 50% trailed di SL). Frontend override ke **full TP1 exit** (100% return) sesuai TP1 lock rule user.

### Shared helper baru

Di tracker IIFE (dekat `getLive`):

```js
window.__TR_pnlLockedTP1(rec)   // Return TP1/TP2 locked pnl (%) atau null
window.__TR_pnlEffective(rec)   // Priority: TP1 lock > backend pnlPct > floatingPct
```

### Semua tempat P&L display sudah TP1 lock aware

| Panel | Fungsi | Bagaimana caranya |
|---|---|---|
| Analis firm listing | `renderRecList` topPct | Cek `_tp1LockedTgt` sebelum branch isHistory/isActive |
| Analis firm KPI | `computeFirmStats` → `TrackerStats.compute` | Auto via `_hitTP1` include SL_TRAIL |
| Analis-per-ticker table + KPI | `renderRecTable` + `computeKpi` + `pnlOf` | pnlOf pakai TP1 lock priority |
| Overview Rekomendasi Terbaru | `renderLatestRecent` + `pnlOfRow` | pnlOfRow pakai TP1 lock priority |
| Overview firm ranking | `computeFirmStats` → `TrackerStats` | Auto |
| Dashboard cards (tab Live) | `renderCard` floating | `_lockedTgt` override sebelum backend floatingPct |
| Popup rec modal | `pnl` var | `_pnlLocked` priority sebelum rec.pnlPct |
| Tracker section drawer | `perfHtml` + firm fallback | `pnlEffective` |
| Performa monthly table | `simulate()` | `_pnlEff` (fallback ke helper) untuk sumPnl/wins/losses |
| Cumulative equity chart | `_computeFirmDailyEquity` | `pnlEffective` fallback |

**Efek**: rec SL_TRAIL sekarang menyumbang FULL TP1 return ke semua winrate & return calculation. Winrate firm otomatis naik untuk analis yang punya banyak rec SL_TRAIL.

### Backend TIDAK diubah

`build-tracker.js` `pnlPct` tetap 50% partial (strategi realisasi bertahap). Frontend override saat display. Kalau nanti mau backend juga full TP1, edit `build-tracker.js` line ~855 area (`result.pnlPure = realizedPct;`) + tunggu CI rebuild. Untuk sekarang skip.

---

## 5. Trail info text kecil (informasi TP1 lock context)

Di `renderRecList` firm listing, tambah text inline kecil di date row:

```
📅 24 Juli 2026 · 🛡 Sempat TP1, turun ke area SL
```

Muncul saat:
- `closedBy === 'SL_TRAIL'` (backend confirmed): text = *"Sempat TP1, balik ke SL"*
- Rec TP1-locked tapi live sekarang di/lewat SL area: text = *"Sempat TP1, turun ke area SL"*

CSS: `.tr-rec-trail` — font-size .9em, color text3, opacity .9, font-weight 600, white-space nowrap.

Layout:
- Inline di date row (tidak bikin row baru)
- Parent `.tr-rec-d` punya `flex-wrap:wrap` → di HP auto wrap
- Tooltip lengkap di `title` attribute

Popup rec modal juga sudah TP1 lock aware:
- `isTP1Hit` include `_liveOv === 'TP1_LIVE' || 'TP2_LIVE'`
- `isSLHit` include `_liveOv === 'SL_LIVE'` (SL murni saja)
- Badge di level card sekarang konsisten dgn header

---

## 6. Overview Tracker — filter sinkron + status tabs

Panel **"Rekomendasi Terbaru"** di halaman Overview Tracker sekarang:

### Filter tanggal sinkron dgn "Saham Paling Aktif"

- Single source: `_tovTickDateFilter` (variable di tracker IIFE)
- Default: **30 hari terakhir** (via `_tovInit30dFilter()`)
- Kalender di header "Saham Paling Aktif" jadi kontrol tunggal untuk kedua panel
- Reset "All" → keduanya tampil semua tanggal
- Button label pakai shorthand **"N hari terakhir"** untuk preset yang end=today (misal `30 hari terakhir`), fallback ke range format `24 Jun '26 → 24 Jul '26` untuk custom range

### Status filter tabs

Di bawah toggle `Terbaru | Per Firm`, ada baris tab baru:

```
[Semua (N)] [Aktif (N)] [Menunggu (N)] [TP (N)] [SL (N)] [Expired (N)]
```

- Counter angka post-date-filter
- Klasifikasi via `statusOfRow` (TP1 lock aware)
- Tab hanya muncul saat view='recent', auto-hidden di view 'firms'
- CSS: `.tr-ov-latest-tabs` / `.tr-ov-latest-tab` (compact, flex-wrap)
- State var: `_trOvLatestStatusTab = 'all'` (default)

Subtitle format:
```
127 rekomendasi · 30 hari terakhir · status: Aktif
```

---

## Commit history session ini (di main)

```
56ff815 tracker overview: Rekomendasi Terbaru sync filter tgl + tabs status
25081a6 tracker: winrate & return TP1 LOCK konsisten di SEMUA panel menu Tracker
641166d tracker analis: P&L display TP1 LOCK + trail info text kecil
70fabd8 tracker: revert — kembalikan TP1 LOCK rule di semua tempat
b187158 tracker popup rec: level card HIT/KENA badge ikut live override
c8b587a tracker: hapus suffix '(live)' dari label status badge
6b56869 tracker analis: fix tab Semua tidak menampilkan rec live-promoted TP/SL
953a51e tracker: live-status override konsisten di SEMUA rec listing menu Tracker
eb769c9 tracker analis: live-status override — status berubah realtime
b4bd74d tracker analis: Price Ladder pakai universe PENDING(<=7 hari)+ACTIVE only
(0fd654d dulu SL_TRAIL → SL — sudah di-revert di commit 70fabd8. Jangan disenter lagi.)
```

## File yang di-modify

- `public/index.html` — mayoritas perubahan (semua badge/status/pnl fn + HTML tabs Overview)
- `public/tracker-stats.js` — `_hitTP1` include SL_TRAIL, `recPnl` full TP1 exit
- `.kiro/steering/handoff-2026-07-25-tp1-lock-live-override.md` — dokumen ini

## File yang TIDAK di-modify (tapi patut diketahui)

- `scripts/build-tracker.js` — backend, `pnlPct` SL_TRAIL masih partial 50%. Frontend override. Kalau mau ubah, edit line ~855 area + tunggu CI rebuild.

---

## Yang mungkin akan datang di session berikutnya

1. Kalau user komplain angka winrate/return **masih tidak update di semua tempat** — cek apakah ada rendering yg baca `firm.wins`/`firm.losses`/`firm.pnlPct` langsung dari `tracker.json` tanpa lewat `TrackerStats.compute` atau `pnlEffective`. Trace via grep `\.wins\b`, `\.losses\b`, `\.pnlPct\b`.

2. Kalau user mau backend juga TP1 lock (bukan cuma frontend override) — edit `scripts/build-tracker.js`:
   - Line 855 area: `result.exitPrice = rec.entry` → ubah ke `rec.tp1`
   - Line 856: `result.pnlPure = realizedPct` → `pctAt(rec.tp1)`
   - Line 858: `result.result = ...` → tetap `'WIN'`
   - Tunggu CI workflow `refresh-tracker` untuk rebuild `tracker.json`.

3. Kalau ada rec listing baru yg belum TP1 lock aware — cek pola:
   - Status badge: pakai `stateInfo`/`stInfo`/`statusOfRow`/`statusOf`/`statusOfRec`/`stateBadge` (semua sudah live-aware)
   - P&L display: pakai `window.__TR_pnlEffective(rec)` atau `TrackerStats.recPnl`
   - Filter tanggal Overview: baca `_tovTickDateFilter` state

4. Kalau user mau tambah preset button "7D / 30D / 90D / All" di kalender Overview — HTML tambah button group di `.tr-pf-cal-popup`, wire ke `_tovTickDateFilter = { start, end }` + call `updateOvTopTickers()` + `updateOvLatest()`.

5. Kalau user komplain **Price Ladder** widget di Analis-per-ticker (SL/Entry/LIVE/TP1/TP2 dgn LIVE marker kuning) — universe rec sudah pakai PENDING(≤7 hari) + ACTIVE only. Threshold `LADDER_PENDING_MAX_AGE_DAYS = 7` di `renderStatusWidget`. Beda dari `PENDING_EXPIRY_DAYS = 10` global.

---

## Tempat-tempat rawan di codebase (jangan disentuh tanpa alasan)

- **`getRecPnl`** (line ~7954) — sudah TP1 lock aware. Jangan bikin fungsi paralel yg beda semantic.
- **`TrackerStats.compute` di `tracker-stats.js`** — mesin utama winrate. Semua panel firm reference ini.
- **`_classifyLive` di `renderRecList`** — router live override. Setiap perubahan bisa affect tab counters + rendering.
- **`build-tracker.js` line 780-920** — logic OHLC scan + closedBy assignment. Kalau di-utak, hati-hati.

---

## Contact / Notes

- Style: aku (Kiro) commit langsung ke `main` per instruksi user (bukan branch + PR).
- Push flow: sering rebase manual di atas commit CI headline refresh yg divergent. Sudah biasa handle via `git rebase origin/main` sebelum push.
