# Economstock Terminal

Dashboard saham IDX dengan data dari **2-3 Google Sheets**, di-build setiap 15 menit oleh GitHub Actions, di-host gratis & global di **Cloudflare Pages**.

UI lanjutan dari [`dashboardeconomstock`](https://github.com/chamdani49-boop/dashboardeconomstock). Tema selaras [`rupiah-monitor`](https://github.com/chamdani49-boop/rupiah-monitor).

---

## Arsitektur (Static-Rebuild Pattern)

```
┌─────────────────────────┐
│  Google Sheet HISTORI   │
│  (Bulanz/GoogleFinance) │ ──┐
└─────────────────────────┘   │
                              │
┌─────────────────────────┐   │
│  Google Sheet KONSENSUS │ ──┼─►┌──────────────────┐  push  ┌────────────────┐
└─────────────────────────┘   │  │  GitHub Actions  │ ──────►│ Cloudflare     │
                              │  │  cron */15 menit │        │ Pages (CDN)    │──► User
┌─────────────────────────┐   │  │                  │        │  /index.html   │
│  Google Sheet LIVE      │ ──┘  │  scripts/        │        │  /data.json    │
│  (3 kolom: ticker,      │      │  build-data.js   │        └────────────────┘
│   harga live, % live)   │      └──────────────────┘                ▲
└─────────────────────────┘                                          │
                                                              CDN edge: Jakarta
                                                              cache: 2 menit
                                                              user request: 30-80ms
                                                              concurrent users: ∞
```

**Karakteristik:**
- ✅ **Zero serverless CPU** — file statis, di-cache di edge global
- ✅ **Tahan 100k+ user concurrent** tanpa beda performa
- ✅ **$0 selamanya** — semua di free tier
- ✅ **Edit lewat Sheet** seperti biasa, dashboard auto-refresh tiap ~15 menit
- ✅ **Data versioned** di git history (bisa rollback ke jam berapa pun)

---

## Direktori

```
terminal/
├── .github/workflows/
│   └── refresh-data.yml      ← GitHub Actions cron (*/15 menit)
├── scripts/
│   └── build-data.js         ← Builder: fetch sheets → compute → tulis data.json
├── lib/
│   └── static.json           ← stock_info / stock_list / watchlist (957 emiten IDX)
├── public/                   ← Folder yang di-deploy ke Cloudflare Pages
│   ├── index.html            ← UI single-page
│   ├── data.json             ← Auto-updated tiap 15 menit oleh workflow
│   └── _headers              ← Cloudflare Pages caching rules
├── package.json
├── .env.example
└── README.md
```

---

## Setup Step-by-Step

> **Yang sudah selesai:** Repo `terminal` sudah dibuat, kode sudah di-push.
> **Yang tinggal kamu lakukan:** publish 2-3 sheet (5-7 menit), connect ke Cloudflare (5 menit), set secrets di GitHub (3-5 menit). Total **~13-15 menit**.

### Fase 1 — Publish Google Sheet (Histori & Konsensus)

Untuk **masing-masing** sheet (Histori Harga & Konsensus):

1. Buka sheet di [Google Drive](https://drive.google.com/)
2. Menu: **File → Share → Publish to web** ([panduan resmi Google](https://support.google.com/docs/answer/183965))
3. Tab "Link":
   - Pilih tab/sheet yang benar
   - Format: **Comma-separated values (.csv)**
   - Klik **Publish** → **OK** untuk konfirmasi
4. Tutup dialog. **Tidak perlu copy URL hasil publish** — kita pakai cara lain yang lebih reliable.
5. Catat **Spreadsheet ID** dan **gid** dari URL editor biasa:
   ```
   https://docs.google.com/spreadsheets/d/[INI_SPREADSHEET_ID]/edit#gid=[INI_GID]
                                          └────────────────┘            └────┘
   ```
   - Sheet histori → catat `HISTORY_SHEET_ID` & `HISTORY_GID`
   - Sheet konsensus → catat `CONSENSUS_SHEET_ID` & `CONSENSUS_GID`

> **Tidak perlu edit isi sheet** — parser sudah handle layout Bulanz + banner "Pesan di dashboard" + kode B/N/S.

### Fase 1B — Publish Sheet LIVE (Realtime, Recommended untuk Bulan Berjalan)

Sheet ke-3 ini yang bikin angka harga di hero card / watchlist / price target / chart-titik-terakhir jadi **realtime**, dan **menggantikan kebutuhan baris `sekarang` di sheet histori**. Layout-nya jauh lebih sederhana — cukup 3 kolom:

| Ticker | Harga Live | % Live |
|---|---:|---:|
| TLKM | 5775 | -3.35% |
| BBCA | 9500 | 1.20% |
| AALI | 7000 | -0.50% |

**Aturan kolom:**
- **Ticker** — kode saham (boleh `TLKM` atau `IDX:TLKM`; prefix `IDX:`/`JK:` di-strip otomatis). Untuk indeks, pakai `IHSG`, `JKSE`, atau `COMPOSITE` — semua di-alias jadi `IHSG`.
- **Harga Live** — angka, biasanya formula `=GOOGLEFINANCE("IDX:TLKM","price")`.
- **% Live** — perubahan persentase. Format apa pun jalan: `-3.35%`, `-3.35`, atau `-0.0335`. Parser otomatis deteksi.

**Header alternatif yang juga ke-detect:** `Symbol`/`Kode`/`Saham`/`Code` (ticker), `Price`/`Last`/`Last Price`/`Harga Terakhir` (harga), `Change`/`Pct`/`% Change`/`Persen` (persentase).

**Cara publish:**

1. Bikin tab baru di Google Sheet (boleh di sheet yang sama dengan histori, atau sheet terpisah)
2. Isi 3 kolom di atas. Untuk auto-update, pakai formula GoogleFinance:
   ```
   A1: Ticker            B1: Harga Live                              C1: % Live
   A2: TLKM              B2: =GOOGLEFINANCE("IDX:TLKM","price")      C2: =GOOGLEFINANCE("IDX:TLKM","changepct")
   A3: BBCA              B3: =GOOGLEFINANCE("IDX:BBCA","price")      C3: =GOOGLEFINANCE("IDX:BBCA","changepct")
   ...
   ```
3. **File → Share → Publish to web** → format **CSV** → **Publish**
4. Catat `LIVE_SHEET_ID` & `LIVE_GID` dari URL editor

> **Catatan tentang "% Live":**
> - Kalau pakai `GOOGLEFINANCE(...,"changepct")`, hasilnya = persentase intra-day (vs harga close kemarin), bukan vs awal bulan. Itu yang akan ditampilkan di label "% MoM" di dashboard.
> - Kalau mau pakai MoM proper, isi formula sendiri: `=B2/INDEX(HistoriSheet!B:B, ROW_BULAN_LALU) - 1`. Format apa pun (`%` / desimal / fraksi) akan di-handle parser.
> - Kalau kolom **% Live** dikosongin, builder otomatis hitung MoM = `(harga_live − harga_bulan_sebelumnya) / harga_bulan_sebelumnya` dari sheet histori.

### Fase 2 — Set GitHub Repository Secrets

1. Buka [github.com/chamdani49-boop/terminal/settings/secrets/actions](https://github.com/chamdani49-boop/terminal/settings/secrets/actions)
2. Klik **New repository secret** → tambah satu per satu:

   | Name | Value | Wajib? |
   |---|---|---|
   | `HISTORY_SHEET_ID` | (dari Fase 1) | ✅ |
   | `HISTORY_GID` | (dari Fase 1, biasanya `0`) | ✅ |
   | `CONSENSUS_SHEET_ID` | (dari Fase 1) | ✅ |
   | `CONSENSUS_GID` | (dari Fase 1) | ✅ |
   | `LIVE_SHEET_ID` | (dari Fase 1B) | Opsional |
   | `LIVE_GID` | (dari Fase 1B) | Opsional |

   Kalau `LIVE_SHEET_ID` dikosongin, dashboard tetap jalan — angka harga diambil dari row terakhir sheet histori. Tambah sheet live kalau mau angka realtime.

3. Tes manual: buka [Actions → Refresh data from Google Sheets](https://github.com/chamdani49-boop/terminal/actions/workflows/refresh-data.yml) → **Run workflow** → **Run workflow** (warna hijau).
4. Tunggu ~30 detik. Workflow harus selesai dengan tanda ✓ hijau.
5. Cek [public/data.json](https://github.com/chamdani49-boop/terminal/blob/main/public/data.json) — harusnya ada commit baru dari `data-refresh[bot]`. Cari field `"live": {...}` & `"_meta.live_tickers"` untuk verifikasi sheet live ke-baca.

### Fase 3 — Daftar & Connect Cloudflare Pages

1. **Daftar Cloudflare** (gratis, 30 detik):
   - Buka [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
   - Pakai email / Google login
   - Verify email
2. **Buat Pages project**:
   - Di dashboard, sidebar → **Workers & Pages** ([direct link](https://dash.cloudflare.com/?to=/:account/workers-and-pages))
   - Klik tab **Pages** → **Create application** → **Connect to Git**
   - Connect ke GitHub:
     - Pilih akun `chamdani49-boop`
     - Klik **Only select repositories** → centang **`terminal`** → **Install & Authorize**
3. **Pilih repo** `chamdani49-boop/terminal` → **Begin setup**
4. **Build settings:**
   - **Project name:** `terminal` (akan jadi `terminal.pages.dev`)
   - **Production branch:** `main`
   - **Framework preset:** **None**
   - **Build command:** *(kosongkan)*
   - **Build output directory:** `public`
   - **Root directory:** *(kosongkan)*
   - Environment variables: *(kosongkan — tidak butuh, semua secrets ada di GitHub)*
5. Klik **Save and Deploy**
6. Tunggu ~30-60 detik → dapat URL `https://terminal.pages.dev`

### Fase 4 — Verifikasi

Buka URL Cloudflare Pages kamu (`https://terminal.pages.dev` atau `https://terminal-xxx.pages.dev`). Dashboard harusnya tampil normal dengan data dari Sheet kamu.

Test latency dari terminal:
```bash
curl -w "HTTP %{http_code} | Total: %{time_total}s\n" -o /dev/null -s https://terminal.pages.dev/data.json
```
Harusnya di bawah **200ms** dari Indonesia.

### Fase 5 — Custom Domain (Opsional)

Kalau punya domain (mis. `economstock.com`):

1. Cloudflare Pages → projectmu → **Custom domains** → **Set up a custom domain**
2. Ketik subdomain: `terminal.economstock.com`
3. Cloudflare otomatis kasih instruksi DNS:
   - Kalau domain sudah di Cloudflare → klik **Activate domain**, selesai
   - Kalau domain di registrar lain → ikuti instruksi CNAME yang dikasih ([panduan resmi](https://developers.cloudflare.com/pages/configuration/custom-domains/))
4. SSL/HTTPS aktif otomatis dalam ~1 menit.

---

## Update Cadence

Default: **15 menit**. Edit baris ini di [`.github/workflows/refresh-data.yml`](.github/workflows/refresh-data.yml) untuk ubah:

```yaml
schedule:
  - cron: '*/15 * * * *'   # ubah jadi '*/5 * * * *' untuk 5 menit (minimum GitHub)
```

Cron interval pilihan dengan tradeoff git history growth:

| Interval | Commits/hari | Commits/tahun | Cocok untuk |
|---|---:|---:|---|
| `*/5 * * * *`  (5 mnt) | ~288 | ~105k | data realtime kritis |
| `*/15 * * * *` (15 mnt) ⭐ | ~96 | ~35k | **default — sweet spot** |
| `*/30 * * * *` (30 mnt) | ~48 | ~17k | data harian |
| `0 * * * *` (1 jam) | 24 | ~8.7k | data konsensus saja |
| `0 */6 * * *` (6 jam) | 4 | ~1.5k | super hemat |

Workflow **skip commit kalau data tidak berubah** (mis. weekend, libur), jadi angka di atas adalah upper bound.

**Manual refresh kapanpun:** [Actions → Refresh data → Run workflow](https://github.com/chamdani49-boop/terminal/actions/workflows/refresh-data.yml)

---

## Dev Lokal

```bash
# Salin .env.example → .env, isi ID/GID dari Google Sheet
cp .env.example .env
nano .env

# Build data.json sekali
set -a && source .env && set +a
npm run refresh

# Serve folder public/ di localhost:3000
npm run dev
```

---

## Layout Sheet yang Didukung

### Histori Harga (Bulanz / GoogleFinance layout)

```
Row 1: IDX:Bulanz | _ | IDX:COMPOSITE | IDX:AALI | …      ← formula refs (di-skip)
Row 2:                | COMPOSITE     | 1        | …      ← metadata (di-skip)
Row 3: Bulanz     | Bulanz | IHSG     | AALI     | …      ← HEADER (auto-detect)
Row 4: 5/31/2016  | May-16 | 4,797    | 13,483   | …      ← data
```

Auto-detect: header row dicari dari cell "IHSG"; tanggal & label di-deteksi dari format isi cell. Angka berkoma (`"4,797"`) di-strip otomatis.

### Konsensus Analis

```
Row 1: "Pesan di dashboard" banner (skip)
Row 2: 1 | 2 | _ | 3 | header (skip)
Row 3: Symbol | By | _ | Lynk.id/economstock | … (skip)
Row 4: Symbol | # | DATE | FIRM NAME | [] | T.PRICE | DISC | %D | T.PRICE  ← HEADER
Row 5: LPPF | 1 | 2026-02-18 | Sinarmas Sekuritas | B | 2,050 | 2,050 | 0 | 2,050
```

- Kode `[]`: **B**=BUY, **N**=NEUTRAL, **S**=SELL
- `T.PRICE` pertama dipakai (yang kedua di-ignore)
- `%D` selalu di-recompute server-side dari target vs harga terakhir IHSG month

### Live Realtime (Opsional)

```
Row 1: Ticker   | Harga Live                              | % Live
Row 2: TLKM     | =GOOGLEFINANCE("IDX:TLKM","price")      | =GOOGLEFINANCE("IDX:TLKM","changepct")
Row 3: BBCA     | =GOOGLEFINANCE("IDX:BBCA","price")      | =GOOGLEFINANCE("IDX:BBCA","changepct")
```

- Cuma 3 kolom yang dibaca: ticker, harga, %change. Kolom lain di sheet di-ignore.
- Header alternatif: `Symbol`/`Kode`/`Saham`/`Code`, `Price`/`Last`/`Last Price`, `Change`/`Pct`/`% Change`/`Persen`.
- Format `% Live` fleksibel: `-3.35%`, `-3.35`, atau `-0.0335` semua jalan.
- Ticker boleh pakai prefix `IDX:` / `JK:` (di-strip otomatis).
- `IHSG` / `JKSE` / `COMPOSITE` saling di-alias ke `IHSG`.
- **(Opsional) kolom `Nama` & `Sektor` (dan `Papan`)**: kalau ditambah di Live Sheet, dipakai untuk nama/sektor saham di dashboard (search, ticker, overview). Berguna untuk saham baru yang belum ada di `lib/static.json`. Header yang dikenali: `Nama`/`Name`/`Emiten`, `Sektor`/`Sector`/`Industry`, `Papan`/`Board`.

**Apa yang di-overwrite di dashboard:**
- `price_history[bulan_berjalan][TICKER]` → harga live  
  (kalau row bulan berjalan **belum ada** di history sheet → builder otomatis **APPEND row baru** dengan label `Mmm-YY`. Row history bulan-bulan sebelumnya **tidak disentuh**.)
- `stats[TICKER].current` → harga live
- `stats[TICKER].mom` → `% Live` (kalau ada di sheet, kalau gak ada di-recompute dari harga bulan sebelumnya)
- `stats[TICKER].max` / `min` → refresh kalau live break extreme historis
- `zcores[TICKER]` → recompute pakai MoM live
- `consensus_slim[TICKER][*].pct_d` → upside % analis di-recompute pakai harga live

Hasilnya: hero card, watchlist sidebar, chart linechart (titik bulan berjalan = live), price target blueprint, donut consensus, dan tabel rekomendasi analis — **semua otomatis sinkron** ke harga live tanpa edit kode.

> **Tip:** Di sheet histori, **gak perlu** lagi maintain baris `sekarang` (atau row bulan berjalan dengan formula `=GOOGLEFINANCE`). Cukup isi sampai bulan kemarin, lalu biarkan sheet **Live** yang handle bulan berjalan. Builder akan auto-append. Kalau kamu tetap punya row `sekarang`, masih jalan juga — overlay akan overwrite row itu.

---

## Menambah / Menghapus Saham (otomatis dari Sheet)

Daftar saham (`stock_info`, `stock_list`, `watchlist`) **di-generate otomatis dari universe sheet** — bukan hardcode. Cukup edit Google Sheet, dashboard ikut menyesuaikan saat `data.json` di-rebuild (mode `full` ~15 menit / `history`).

**Menambah saham baru (mis. WBSA, SUPA):**
1. Tambahkan ke **Histori Sheet** (kolom baru ticker + harga bulanannya) → saham langsung dapat chart, stats, dan **bisa dicari**.
2. (Opsional) tambahkan juga di **Live Sheet** → harga real-time + `% Live`.
3. (Opsional) isi kolom `Nama` & `Sektor` di **Live Sheet** → nama & sektor tampil rapi. Kalau tidak diisi, fallback ke `lib/static.json`, lalu ke kode ticker.

> Saham yang **cuma** ada di Live Sheet (belum di Histori) **tidak** muncul — sengaja, supaya tidak ada ticker tanpa riwayat/stats. Masukkan ke Histori dulu.

**Menghapus saham (delisting):**
- Hapus kolomnya dari **Histori Sheet** → otomatis hilang dari chart/stats/search/watchlist saat rebuild berikutnya.
- Kalau hanya berhenti di Live Sheet (kolom histori tetap ada) → harga berhenti update, tapi saham tetap tampil dengan harga terakhir.

**Prioritas sumber nama/sektor:** kolom Live Sheet → `lib/static.json` → kode ticker (fallback). Jadi nama 956 saham lama tetap utuh, saham baru cukup diisi via sheet.

---

## Troubleshooting

| Gejala | Penyebab | Fix |
|---|---|---|
| Workflow gagal dengan `Missing env vars` | GitHub Secrets belum diset | Fase 2 |
| Workflow gagal dengan `Failed to fetch sheet … 404` | Sheet belum dipublish atau ID salah | Fase 1, cek URL |
| Workflow sukses tapi `data.json` tidak ter-commit | Data tidak berubah — itu normal | Trigger manual setelah edit sheet |
| Cloudflare Pages tidak auto-deploy | Cek di Cloudflare → projectmu → Deployments — biasanya tertunda 1-2 menit | Sabar, atau klik **Retry deployment** |
| Dashboard tampil tapi angka aneh | Header sheet kamu beda dari yang documented | Issue di repo dengan screenshot — aku adjust parser |
| Update sheet nggak nongol di dashboard | Cache edge masih hangat (max 2 menit untuk data.json) | Tunggu, atau hard-reload (Ctrl+Shift+R) |
| Sheet live di-set tapi angka di hero gak berubah | Header kolom gak ke-detect; cek log workflow | Cek `_meta._debug.live_cols` di `data.json`. iTicker/iPrice harus ≥0 |
| Angka `% Live` ke-render salah (mis. -335% padahal -3.35%) | Format kolom ambigu (heuristik salah tebak) | Tambah tanda `%` di sheet (`-3.35%` jelas), atau pakai fraksi `-0.0335` |

---

## Migrasi dari Versi Sebelumnya

Versi sebelumnya pakai Vercel Serverless (`/api/data`). Sekarang sepenuhnya statis. Yang berubah:

- ❌ `api/data.js` (dihapus)
- ❌ `vercel.json` (dihapus)
- ✅ `scripts/build-data.js` (logic yang sama, tapi run di GitHub Actions)
- ✅ `.github/workflows/refresh-data.yml` (cron */15 menit)
- ✅ `public/data.json` (auto-updated)
- ✅ `public/_headers` (Cloudflare cache config)
- 🔄 `public/index.html` — fetch path balik ke `data.json` (relative)
