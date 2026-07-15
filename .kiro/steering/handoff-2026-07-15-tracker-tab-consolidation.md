---
inclusion: manual
---

# Handoff 2026-07-15 (sesi kedua) — Tracker tab consolidation

Meneruskan `handoff-2026-07-15-tracker-refinement.md`. Sesi ini fokus
**konsolidasi tab menu Tracker** (7 → 5 tab), cleanup dead code, dan
integrasi field baru ke popup rekomendasi. Backend `build-tracker.js`
**TIDAK diubah** — user konfirmasi logic entry-touch saat ini sudah benar.

## Ringkasan singkat

Menu Tracker sebelumnya punya 7 sub-tab (Ringkasan · Analisis · Live ·
Performa · Analis · Asumsi · Simulasi) dgn overlap besar antar-tab.
Konsolidasi bertahap: (1) hapus Asumsi karena isinya (ranking 50/50 staged)
duplikat visual dgn Performa & Simulasi, (2) lebur Simulasi ke Performa
karena "kepala"-nya sama (ranking firm) beda hanya sudut angka (% vs Rp).

Selain itu: dead code `#trScoreModal` (popup Skor Validitas yg sudah tidak
dipakai) dibersihkan, kata "konsensus" di seluruh menu Tracker di-rename
jadi "analis" (biar tidak clash dgn halaman Consensus terpisah yg arti
"konsensus target harga"), dan field `horizon` + `catatan` dari kolom
Sheet (yg sudah ter-export di tracker.json tapi belum di-render) sekarang
tampil di popup detail rekomendasi.

## PRs (semua sudah merged ke main)

- **#353** [merged] — `tracker/remove-asumsi-tab`
  - Hapus tab Asumsi (nav + panel + JS renderer IIFE + CSS)
  - **CATATAN**: PR ini ter-merge dgn commit `6018a48` yg keliru (aku salah
    tangkap perintah: "lebur Asumsi ke Performa Ranking Detail"). Commit
    correction `e35ae59` (lebur Simulasi ke Performa) belum ter-push saat
    merge terjadi → correction dibuat di PR #354.

- **#354** [merged] — `tracker/cleanup-scoremodal-saldo-polish`
  - 4 commit: (a) hapus dead code `#trScoreModal`, (b) revert
    Ranking Detail dari PR #353 (undo mis-merge), (c) lebur Simulasi ke
    Performa (reapply dari e35ae59), (d) polish 'SALDO SIMULASI' block
    (font 23px→20px, label pendek, sub separator `·`).
  - Net: `-681 baris` (`+192/-874`).

- **#355** [merged] — `tracker/rm-rata2-rename-konsensus`
  - Hapus stat "RATA² TRADE" di kartu firm Papan Peringkat (redundant
    dgn Net Return; kartu tinggal 2-col: WR + Net).
  - Rename "Konsensus" → "Analis" di 8 lokasi visible text + 2 chart
    dataset labels + code comments di Tracker context.
  - Net: `+22/-25 baris`.

- **#356** [merged?] — `tracker/recmodal-horizon-catatan`
  - Tampilkan **Horizon** (foot-item) + **Catatan Analis** (block terpisah)
    di popup `#trRecModal`. Data sudah ter-export di tracker.json (via
    `build-tracker.js` line 1502 & 1551), tinggal di-render.
  - Skip/hidden kalau field kosong (biar layout ringkas).
  - Net: `+26 baris`.

## State akhir menu Tracker

### 5 tab (dari 7)

```
📋 Ringkasan · 📈 Analisis · 🚀 Live · 📊 Performa · 👤 Analis
```

Yang dihapus: **Asumsi** (dilebur ke tidak dibuat lagi), **Simulasi**
(dilebur ke Performa).

### Struktur tab Performa (gabungan, 6 section berurutan)

1. **Config Rp modal + slot** (input global, persist localStorage)
2. **🏆 Papan Peringkat Sekuritas** — kartu firm existing (2 stat: WR +
   Net Return) + block **"SALDO SIMULASI"** yang di-inject via DOM
   setelah main renderer selesai
3. **🎯 Distribusi Hasil** (TP1/TP2/SL/EXPIRED)
4. **📈 Grafik Performa Analis 30 Hari** (canvas bar+line)
5. **📅 Rekap Bulanan Analis** — bulan × trade × W/L × WR × Net% ×
   best × worst × saldo Rp end-of-month
6. **🛡️ Safety Net RR** — expectancy per level

### DOM injection pattern (saldo block)

Renderer utama Performa (IIFE lama) render kartu firm _tanpa_ saldo block.
Renderer terpisah **"TAB PERFORMA · SIM EXTENSION"** (IIFE baru) subscribe
`__TR_onData(applyAll)` dan panggil `setTimeout(() => injectSaldoBlocks(),
0)` supaya jalan **setelah** main renderer selesai render kartu. Ini
menjaga separation of concerns:

- Main renderer: tanggung jawab render struktur kartu, stats, progress bar,
  foot info
- Sim extension: DOM-manipulate untuk inject saldo Rp per kartu (Konsensus
  baseline & firm tanpa trade selesai di-skip) + render tabel Rekap Bulanan

Config change → `reApply()` → re-inject saldo & re-render Rekap Bulanan
(tanpa reload kartu).

## Popup detail rekomendasi Tracker (`#trRecModal`)

Layout final:

```
[Header: ticker, name, firm, badge BUY/SELL, status, Rilis: tanggal]
[Chart candlestick + price zones TP/SL]
[Levels: ENTRY · TP1 · TP2 · STOP-LOSS] (dgn return %)
[Foot: Harga Sekarang · P&L · Horizon · Exit · Kadaluarsa]  ← Horizon BARU
┌────────────────────────────────────┐
│ 📝 CATATAN ANALIS                  │  ← Block BARU (hidden kalau kosong)
│ [multi-line text dari Sheet]       │
└────────────────────────────────────┘
```

**IDs & selectors:**
- Foot container: `#trRecModalFoot` (di-render inline JS di `fillInfo()`)
- Catatan block: `#trRecModalNote` (fresh div hidden by default; unhide
  kalau `rec.note` non-empty)
- CSS: `.tr-recmodal-note`, `.tr-recmodal-note-lbl`, `.tr-recmodal-note-body`

**Renderer**: `fillInfo(rec)` di IIFE popup rekomendasi Tracker (line
~10970-11515). Fields dari `rec.horizon` & `rec.note` (already exported
in tracker.json by `build-tracker.js` line 1502 & 1551).

## Keputusan penting (backend behavior)

### Bar tanggal publish TETAP diikutkan (user confirmed OK)

`scripts/build-tracker.js` line 616-620:
```js
// Note: bar tanggal publish DIIKUTKAN — kita anggap harga di sesi itu bisa
// menyentuh entry. Kalau OPEN sudah di bawah entry (BUY), berarti gap-down
// masuk zona entry → tetap dianggap triggered pada OPEN
```

**Skenario**: Rekomendasi upload jam 11:00, harga sentuh entry jam 10:00
hari yang sama → **tetap dianggap triggered** (posisi aktif dgn
`entryTouchPrice = entry`).

**Ini technically look-ahead bias** (pembeli riil tidak bisa eksekusi
jam 10 karena rekomendasi belum ada). Tapi user memilih tetap dgn logic
ini karena:
- Data OHLC harian (bukan intraday) — tidak mungkin bedakan pre/post publish
- Kebanyakan rekomendasi rilis pre-market atau early morning → wajar
  dianggap tersentuh saat sesi berjalan
- Alternatif konservatif (skip bar publish) akan defer semua rekomendasi
  pre-market ke T+1 → over-koreksi

**Data siap kalau nanti mau ditighten**: field `_ts` (millisecond Unix
timestamp jam publish) SUDAH ter-capture di `normalizeRow()` (line 179-182)
dari kolom `timestamp` di Sheet, tapi belum dipakai untuk logic entry-touch.
Kalau di masa depan mau apply "skip bar publish kalau publish >= 09:00 WIB",
tinggal tambah cek `_ts` di loop iterasi bar.

## Rename convention

### "Konsensus" → "Analis" di menu Tracker

Karena kata "konsensus" clash dgn halaman lain yg arti berbeda:
- Halaman `#page-consensus`: 'Konsensus Terbaru' (target harga analis)
- Halaman Valuasi: 'Konsensus Nilai Wajar' (median metode valuasi)
- Screening: kolom 'ConsVal (Konsensus Analis)'

Di menu Tracker, agregasi trade lintas firm lebih akurat disebut "analis":

| Sebelum | Sesudah | Lokasi |
|---|---|---|
| `RETURN KONSENSUS` | `RETURN ANALIS` | Ringkasan KPI hero |
| `Konsensus analis (blended, ...)` | `Analis (blended semua firm, ...)` | Return Kumulatif desc |
| Legend `Konsensus Analis` | `Analis` | Chart legend |
| `Sentimen Konsensus` | `Sentimen Analis` | Live Signal Terminal |
| `Grafik Performa Konsensus 30 Hari` | `Grafik Performa Analis 30 Hari` | Performa + Analis firm (2×) |
| `Rekap Bulanan Konsensus` | `Rekap Bulanan Analis` | Performa |
| Chart dataset `'Konsensus'` | `'Analis'` | 2 chart Chart.js |

**TIDAK di-rename**: halaman Consensus, Valuasi, Screening, WebSocket
feed konsensus (di luar menu Tracker), historical code comments yg
mendokumentasikan penghapusan feature lama.

## CSS & LS migration

### CSS `.tr-sim-*` — retained subset

Pada PR #354, ~55 CSS rules unused dihapus. Yang tersisa (di-reuse di
context Performa):

- `.tr-sim-config-*` — config bar Rp + slot input (di `#trPerfContent` top)
- `.tr-sim-input-*`, `.tr-sim-slots-*` — input elements
- `.tr-sim-saldo-*` — saldo Rp block yg di-inject ke kartu firm
- `.tr-sim-monthly-*` — tabel Rekap Bulanan
- `.tr-sim-note` — 2 definitions (line 2563 & 3679, later wins) dipakai
  di Ringkasan (`#trSimNote` — KPI note, bukan tab Simulasi)

### Dropped CSS classes (0 usage)

`.tr-sim-log-*`, `.tr-sim-pager*`, `.tr-sim-filter*`, `.tr-sim-hero-*`,
`.tr-sim-grid`, `.tr-sim-card*`, `.tr-sim-mini-stat*`, `.tr-sim-card-verified`,
seluruh `.tr-scoremodal-*`, `.tr-hiscore-*`, `.tr-pf-vbadge`.

### localStorage migration

Config Rp/slot yg sebelumnya di `tr_sim_capital` / `tr_sim_slots` di-migrate
otomatis ke `tr_perf_capital` / `tr_perf_slots` saat IIFE init:

```js
if (!localStorage.getItem(LS_CAPITAL)) {
  var _oldCap = localStorage.getItem('tr_sim_capital');
  if (_oldCap) localStorage.setItem(LS_CAPITAL, _oldCap);
}
// idem untuk slots
```

User yg sudah simpan angka lama tidak lose data. LS keys lama boleh
di-cleanup di masa depan (misal 3 bulan setelah rilis) via one-time
migration script.

## Kartu firm di Papan Peringkat (final layout)

```
┌──────────────────────────────────────────┐
│ 🥇 #1                                    │
│ [Firm Name]                              │
│ [XX rekomendasi selesai · YY aktif]      │
│                                          │
│ ┌───────────────────────────────────┐    │
│ │ SALDO SIMULASI                    │    │  ← inject via DOM
│ │ Rp 11.4 jt                        │    │     (skip kalau no trade)
│ │ +14.00% · +Rp 1.400.000           │    │
│ └───────────────────────────────────┘    │
│                                          │
│ [WIN RATE 60%]      [NET RETURN +14%]    │  ← 2-col (turun dari 3)
│ [X/Y menang]        [total gain/loss]    │
│                                          │
│ [Konsistensi WR progress bar]            │
│                                          │
│ 👥 Analis: 3     📊 Total sinyal: 24    │
└──────────────────────────────────────────┘
```

Stat ke-3 lama ("RATA² TRADE") dihapus karena redundant dgn Net Return
(keduanya ukuran cuan). Grid `.tr-perf-firm-stats` sudah `1fr 1fr` sejak
awal, tidak perlu ubah CSS.

## Follow-up items (untuk sesi berikutnya)

Belum urgent, tapi ide untuk di-eksplorasi:

1. **Backend refresh trigger** — trigger workflow `refresh-tracker.yml`
   manual biar `tracker.json` regen dgn `PENDING_EXPIRY_DAYS=10` (sudah
   di scripts, mungkin belum propagate ke public/tracker.json production)

2. **Mobile responsive check** — verify tab Performa gabungan di HP:
   config bar wrap, kartu firm dgn saldo block, tabel Rekap Bulanan
   horizontal scroll. Belum di-test manual.

3. **Feed KONSENSUS Worker** — line 12645-13080 masih pakai kata
   "konsensus" di komentar/variabel (untuk halaman Consensus terpisah).
   Ini tidak perlu diubah (arti "konsensus target harga" berbeda dari
   "analis agregat trade").

4. **`_ts` untuk tighten entry-touch logic** — kalau user berubah pikiran
   soal look-ahead bias, tinggal apply cek `_ts` di
   `scripts/build-tracker.js` loop iterasi bar (line ~625).

5. **Historical code comments** — L4836, L4894, L4998, L5063 di
   `public/index.html` masih mention "user req hilangkan text konsensus"
   / "WIN RATE KONSENSUS" untuk mendokumentasikan penghapusan feature
   lama. Sengaja dibiarkan (semantik = describe historical action).

## Pointer file untuk sesi berikut

- `public/index.html` — semua UI Tracker (24291 baris setelah cleanup)
  - Nav sub-tab: line ~4713-4726
  - Tab Performa content: line ~5217-5323 (Config, Papan Peringkat,
    Distribusi, Grafik, Rekap Bulanan, Safety Net)
  - Popup rekomendasi: line 23710-23770 (HTML) + IIFE renderer ~10970-11515
  - Performa main renderer IIFE: line ~9200-9700
  - Sim Extension IIFE (saldo inject + Rekap Bulanan): line ~9720-10000
- `scripts/build-tracker.js` — pipeline data (1636 baris)
  - `normalizeRow()` line ~440 (capture semua field termasuk `_ts`)
  - Entry-touch loop line ~625 (bar publish DIIKUTKAN)
  - Export rec objects line ~1495-1580 (openList, historyList, dll)
- `public/tracker.json` — data hasil pipeline (~4-5MB, auto-refreshed
  tiap 15 min via `.github/workflows/refresh-tracker.yml`)
