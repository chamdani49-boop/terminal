# Economstock Terminal

Dashboard saham IDX dengan data realtime dari **2 Google Sheets** (histori harga + konsensus analis), deploy di **Vercel**.

UI 100% tetap (lanjutan dari [`dashboardeconomstock`](https://github.com/chamdani49-boop/dashboardeconomstock)) — yang berubah cuma sumber datanya: dari `data.json` statis → `/api/data` serverless yang baca Google Sheets kamu langsung.

---

## Arsitektur

```
┌─────────────────────────┐         ┌──────────────────────────┐
│  Google Sheet (Histori) │ ──┐     │                          │
└─────────────────────────┘   │     │  Vercel Serverless       │
                              ├───► │  /api/data               │ ──► Browser (UI)
┌─────────────────────────┐   │     │  - fetch CSV both sheets │
│  Google Sheet (Konsensus)│ ─┘     │  - compute stats/corr/Z  │
└─────────────────────────┘         │  - return unified JSON   │
                                    └──────────────────────────┘
```

**Yang dihitung otomatis di server (kamu nggak perlu bikin sheet untuk ini):**

- `stats` — current, MoM, YTD, YoY, max/min, avg & std return bulanan, top YoY swings
- `correlations` — korelasi Pearson tiap saham vs IHSG
- `zcores` — z-score return bulan terakhir
- `consensus_summary` — total/buy/neutral/sell, high/low/avg target

**Yang tetap statis (di-bundle di repo, file `lib/static.json`):**

- `stock_info` — nama lengkap, sektor, board (957 emiten IDX)
- `stock_list` — index untuk search
- `watchlist` — 41 saham unggulan

---

## Struktur Sheet yang Didukung

> Parser **auto-detect header row** — header bisa di mana saja, asal kolom kuncinya kekenal. Format yang sudah teruji adalah layout GoogleFinance "Bulanz" + sheet konsensus dengan kode B/N/S.

### 1. Sheet "Histori Harga" (layout GoogleFinance)

```
Row 1:  IDX:Bulanz   |              | IDX:COMPOSITE | IDX:AALI | IDX:ABBA | …    ← formula refs (di-skip)
Row 2:               |              | COMPOSITE     | 1        | 2        | …    ← metadata (di-skip)
Row 3:  Bulanz       | Bulanz       | IHSG          | AALI     | ABBA     | …    ← HEADER (terdeteksi otomatis)
Row 4:  5/31/2016    | May-16       | 4,797         | 13,483   | 40       | …    ← data
Row 5:  6/30/2016    | Jun-16       | 5,017         | 14,700   | 40       | …
…
```

Yang dikenali otomatis:
- **Header row** — dicari row yang ada cell "IHSG"
- **Kolom tanggal** — auto-detect kolom yang isinya format tanggal valid (`5/31/2016`, `2016-05-01`, dll)
- **Kolom label** — auto-detect kolom dengan format `Mmm-YY`
- **Kolom ticker** — semua kolom lain dengan header non-empty
- **Angka berkoma** — `"4,797"` → 4797 otomatis
- **Cell kosong** — di-treat sebagai `null` (bukan error)

### 2. Sheet "Konsensus Analis"

```
Row 1:  "Pesan di dashboard" (banner merge)                                          ← di-skip
Row 2:  1 | 2 |   | 3 | header                                                        ← di-skip
Row 3:  Symbol | By |   | Lynk.id/economstock | Hitung Nilai Wajar | … | 0           ← di-skip
Row 4:  Symbol | # | DATE | FIRM NAME | [] | T.PRICE | DISC | %D | T.PRICE           ← HEADER
Row 5:  LPPF   | 1 | 2026-02-18 | Sinarmas Sekuritas | B | 2,050 | 2,050 | 0 | 2,050  ← data
Row 6:  GGRM   | 1 | 2026-02-19 | Mandiri Sekuritas  | B | 19,100 | 19,100 | 0 | 19,100
…
```

Yang dikenali otomatis:
- **Header row** — dicari row yang ada "Symbol" + ("DATE" atau "FIRM NAME")
- **Kolom rekomendasi** `[]` — kode 1 huruf di-decode:
  - `B` → BUY (juga: BUY, OVERWEIGHT, OUTPERFORM, ADD)
  - `N` → NEUTRAL (juga: NEUTRAL, HOLD)
  - `S` → SELL (juga: SELL, UNDERWEIGHT, UNDERPERFORM, REDUCE)
- **`T.PRICE`** — diambil yang pertama (col F), duplicate (col I) diabaikan
- **`%D`** — selalu **dihitung ulang** di server: `(target − harga_terakhir) / harga_terakhir × 100`. Nilai 0 di sheet kamu (karena DISC = T.PRICE) otomatis di-overwrite.
- **`#`** — di-renumber otomatis di server, urut tanggal terbaru = 1.
- **Tanggal** apa pun format yang bisa di-parse JS `Date()`.

---

## Setup Step-by-Step

### Langkah 1 — Siapkan Google Sheets

1. Pastikan sheet histori harga & konsensus dalam **2 file terpisah** (atau 2 tab di file yang sama — sama saja, tinggal pakai `gid` yang berbeda).
2. **Publish ke web** (cara paling simpel, tidak butuh API key):
   - Buka tiap sheet → **File → Share → Publish to web** ([panduan Google](https://support.google.com/docs/answer/183965))
   - Pilih tab yang benar, format **Comma-separated values (.csv)** → klik **Publish**
   - Atau cukup **share-as-anyone-with-link can view** — endpoint `gviz/tq?tqx=out:csv` yang dipakai serverless ini bekerja selama sheet bisa diakses publik.
3. Catat **Spreadsheet ID** dan **gid** dari URL:
   ```
   https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit#gid=<GID>
                                          └─── ini ────┘            └─┘
   ```

### Langkah 2 — Bikin Repo GitHub `terminal`

Repo baru di GitHub belum bisa dibuat dari sini, jadi kamu yang klik:

1. Buka [github.com/new](https://github.com/new)
2. Owner: `chamdani49-boop` · Repository name: **`terminal`**
3. **Public** atau **Private** sama saja — Vercel handle keduanya.
4. **Jangan** centang "Add a README" / .gitignore / license (repo lokal sudah punya).
5. Klik **Create repository**.

Setelah itu balik chat ke aku, bilang "repo terminal udah dibuat" — aku push otomatis dari sandbox ini.

### Langkah 3 — Connect ke Vercel

1. Buka [vercel.com/new](https://vercel.com/new)
2. Klik **Import Git Repository** → pilih `chamdani49-boop/terminal`
3. **Framework Preset:** *Other* (ini repo statis + serverless function, bukan framework spesifik)
4. **Root Directory:** `./`
5. **Build Command:** kosongkan / `echo skip`
6. **Output Directory:** `public`
7. **Environment Variables** — isi 4 variabel ini (dari Langkah 1):
   ```
   HISTORY_SHEET_ID    = <id sheet histori>
   HISTORY_GID         = <gid tab histori, biasanya 0>
   CONSENSUS_SHEET_ID  = <id sheet konsensus>
   CONSENSUS_GID       = <gid tab konsensus>
   CACHE_SECONDS       = 300
   ```
8. Klik **Deploy**. Tunggu ~30 detik, dapat URL `https://terminal-xxx.vercel.app`.

> Kalau mau custom domain (`terminal.economstock.com` dsb.), masuk **Project → Settings → Domains** ([panduan resmi](https://vercel.com/docs/projects/domains/add-a-domain)).

### Langkah 4 — Verifikasi

- Buka `https://<your-url>.vercel.app/api/data` di browser → harus return JSON dengan key `price_history`, `consensus_slim`, `stats`, dst.
- Buka root URL → dashboard tampil persis seperti versi lama, tapi datanya udah dari sheet kamu.
- Update angka di Google Sheet → tunggu max `CACHE_SECONDS` detik (default 5 menit) atau hit `/api/data?refresh=1` (Vercel akan revalidate stale-while-revalidate).

---

## Dev Lokal

```bash
npm install -g vercel
cp .env.example .env.local
# isi env vars
vercel dev
```

Buka [http://localhost:3000](http://localhost:3000).

---

## Direktori

```
terminal/
├── api/data.js          ← Vercel serverless function (data pipeline)
├── lib/static.json      ← stock_info / stock_list / watchlist (statis)
├── public/index.html    ← UI single-page (lanjutan dashboardeconomstock)
├── vercel.json
├── package.json
├── .env.example
└── README.md
```

---

## Troubleshooting

| Gejala | Penyebab Umum | Fix |
|---|---|---|
| `/api/data` return `Missing env vars` | Env belum diset di Vercel | Project → Settings → Environment Variables → Redeploy |
| `Failed to fetch sheet … 404` | Sheet ID/gid salah, atau sheet belum dipublish/share | Re-publish sheet, cek URL |
| Data muncul tapi semua angka null | Header tidak dikenali | Cek nama kolom — bandingkan dengan tabel "Struktur Sheet" di atas; tambah alias di `api/data.js` jika perlu |
| Update sheet nggak nongol di dashboard | Cache edge masih hangat | Tunggu `CACHE_SECONDS`, atau kecilkan nilainya, atau **Deployments → Redeploy** |
| `consensus_slim` kosong tapi sheet ada isi | Kolom `ticker` typo / kosong | Pastikan kolom kode saham namanya `ticker`/`code`/`kode`/`saham` |

---

## Lisensi & Atribusi

Lanjutan dari [chamdani49-boop/dashboardeconomstock](https://github.com/chamdani49-boop/dashboardeconomstock). Tema selaras [`rupiah-monitor`](https://github.com/chamdani49-boop/rupiah-monitor) (PR #1 di repo asal).
