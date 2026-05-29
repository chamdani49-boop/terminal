# terminal-live — Worker feed harga live real-time

Worker kecil yang mengambil **Live Sheet** langsung dari Google **setiap ada
request** (bukan cron), mem-parse-nya dengan logika yang sama persis dengan
`scripts/build-data.js`, lalu mengembalikan JSON ringan. Frontend (`public/index.html`)
memanggil endpoint ini tiap 2 menit dan menempelkan (overlay) hasilnya ke data
yang sudah ke-load — sehingga **harga live + semua kalkulasi turunannya**
(MoM, YTD, YoY, upside, target beli/jual, z-score) ikut segar tanpa menunggu
GitHub Actions me-rebuild `data.json`.

```
Browser ──(poll 2 mnt)──► /live.json (Worker) ──► fetch+parse Live Sheet ──► JSON
                                   (cache 60 dtk di edge)
```

> Pipeline lama tetap jalan: GitHub Actions tetap membangun `data.json`
> (history, consensus, stats baseline). Worker ini hanya menambah lapisan
> live yang real-time.

---

## Endpoint

| Method | Path | Keterangan |
|--------|------|-----------|
| GET | `/live.json` | `{ ok, generated_at, count, live: { CODE: {price, change_pct, max_price, max_date, low_price, low_date} } }` |
| GET | `/live.json?nocache=1` | bypass cache edge (debug) |
| GET | `/` | health check |

---

## Cara deploy (sekali setup, ±10 menit)

### 0. Yang dibutuhkan
- Node.js 18+ dan npm (cek: `node -v`)
- Akun Cloudflare (yang sama dengan yang dipakai deploy site sekarang)
- Dua nilai dari Google Sheet kamu: **LIVE_SHEET_ID** dan **LIVE_GID**

#### Cara dapat LIVE_SHEET_ID & LIVE_GID
Buka Live Sheet kamu di browser, lihat URL-nya:
```
https://docs.google.com/spreadsheets/d/1AbC...XYZ/edit#gid=123456789
                                        └──── ID ────┘        └─ GID ─┘
```
- `LIVE_SHEET_ID` = bagian setelah `/d/` (string panjang)
- `LIVE_GID` = angka setelah `#gid=` saat tab **Live** sedang aktif

> Ini nilai yang sama dengan GitHub Secrets `LIVE_SHEET_ID` / `LIVE_GID`.
> Pastikan sheet di-set **"Anyone with the link → Viewer"** atau **Publish to
> web** (sudah, karena backend GitHub Actions kamu juga fetch tanpa login).

### 1. Masuk ke folder worker & install
```bash
cd worker
npm install
```

### 2. Login Cloudflare
```bash
npx wrangler login
```
Akan buka browser untuk otorisasi. (Alternatif tanpa browser: set
`CLOUDFLARE_API_TOKEN` — lihat bagian Troubleshooting.)

### 3. Set rahasia (sheet ID & GID)
```bash
npx wrangler secret put LIVE_SHEET_ID
# tempel nilai LIVE_SHEET_ID, Enter

npx wrangler secret put LIVE_GID
# tempel nilai LIVE_GID, Enter
```

### 4. Deploy
```bash
npm run deploy        # = npx wrangler deploy
```
Output akan menampilkan URL, kira-kira:
```
https://terminal-live.<subdomain-akun-kamu>.workers.dev
```
Untuk akun `chamdani49` biasanya:
`https://terminal-live.chamdani49.workers.dev`

### 5. Verifikasi
Buka di browser:
```
https://terminal-live.chamdani49.workers.dev/live.json
```
Harus muncul JSON `{"ok":true,"count":900-an,"live":{...}}`.

### 6. Cek URL di frontend sudah cocok
Di `public/index.html` ada konstanta:
```js
const LIVE_FEED_URL = 'https://terminal-live.chamdani49.workers.dev/live.json';
```
- Kalau URL hasil deploy **sama** → tidak perlu ubah apa-apa.
- Kalau **beda** (nama worker / subdomain lain) → ganti baris itu dengan URL
  kamu, lalu deploy ulang site statis seperti biasa.

Selesai. Buka `https://terminal.chamdani49.workers.dev/`, harga akan ke-refresh
otomatis tiap 2 menit. Buka **Console** (F12) → harusnya ada log:
`[live-feed] aktif — NNN ticker ter-overlay ...`

---

## Mematikan / mengaktifkan live feed
Di `public/index.html`:
- Aktif → `const LIVE_FEED_URL = 'https://.../live.json';`
- Mati  → `const LIVE_FEED_URL = null;` (UI balik ke perilaku lama: poll `data.json`)

---

## Konfigurasi opsional (`wrangler.toml` → `[vars]`)
| Var | Default | Fungsi |
|-----|---------|--------|
| `CACHE_SECONDS` | `60` | Lama hasil di-cache di edge. Naikkan kalau mau hemat request ke Google; turunkan kalau mau lebih sering refresh. |
| `ALLOW_ORIGIN` | `*` | Batasi CORS. Mau aman: set ke `https://terminal.chamdani49.workers.dev`. |
| `STALE_TTL_SECONDS` | `43200` (12 jam) | Lama "data terakhir yang baik" disimpan sebagai cadangan. Saat Google Sheet error, Worker menyajikan data ini (ditandai `stale:true`) sampai sheet pulih. |

Setelah ubah, `npm run deploy` lagi.

---

## Ketahanan saat Google Sheet error (stale-on-error)
Worker menyimpan **2 salinan** di cache edge:
- **fresh** (`/live.json`, TTL `CACHE_SECONDS` = 60s) — dipakai untuk melayani request normal.
- **backup** (TTL `STALE_TTL_SECONDS` = 12 jam) — "data terakhir yang baik".

Alur saat sheet tiba-tiba error / kosong:
1. Worker coba fetch + parse sheet.
2. Kalau **gagal atau 0 ticker** → Worker menyajikan **backup** terakhir dengan flag `"stale": true` + `"stale_reason"`, dan cache pendek (30 dtk) supaya cepat coba lagi.
3. Kalau backup belum ada sama sekali → balas `502` (frontend tetap aman: pakai harga terakhir di memori + `data.json`).

Jadi situs **tetap menampilkan harga terakhir sampai sheet pulih**, tidak blank/rusak.

---

## Test parser lokal (tanpa deploy)
```bash
cd worker
npm test      # menjalankan worker/test/parse.test.mjs
```

## Dev lokal
```bash
cd worker
# buat file .dev.vars (TIDAK di-commit) berisi:
#   LIVE_SHEET_ID=...
#   LIVE_GID=...
npx wrangler dev
# lalu buka http://localhost:8787/live.json
```

---

## Troubleshooting
| Gejala | Penyebab & solusi |
|--------|-------------------|
| `/live.json` → `{"ok":false,"error":"LIVE_SHEET_ID ... belum di-set"}` | Secret belum di-set. Ulangi langkah 3, lalu deploy lagi. |
| `/live.json` → 502 "Gagal fetch Live Sheet" | Sheet tidak public, atau ID/GID salah. Pastikan sharing "Anyone with the link → Viewer". |
| `count` kecil / kosong | Layout kolom Live Sheet berubah. Cek header `Ticker / Harga Live / % Live`. Tambah `?nocache=1` saat cek. |
| UI tidak update, Console: `[live-feed] gagal: ...CORS...` | `ALLOW_ORIGIN` di worker tidak mengizinkan origin site. Set ke `*` atau ke origin site, deploy ulang. |
| UI tidak update, Console: `[live-feed] gagal: HTTP 404` | `LIVE_FEED_URL` di `index.html` salah. Samakan dengan URL hasil `wrangler deploy`. |
| Tidak bisa `wrangler login` (headless) | Buat API token di Cloudflare dashboard (template "Edit Cloudflare Workers"), lalu: `export CLOUDFLARE_API_TOKEN=xxxx` sebelum `npm run deploy`. |

---

## Catatan teknis
- Logika parsing (`parseLive`, `_parseLiveBody`, `toNum`, `parseDate`,
  `cleanTickerName`) adalah **port langsung** dari `scripts/build-data.js`.
  Kalau format Live Sheet berubah dan kamu update `build-data.js`, update juga
  `worker/src/index.js` agar tetap sinkron.
- Frontend hanya meng-overlay ticker yang **sudah ada** di `data.json`
  (punya harga di baris terakhir `price_history`). Ticker baru yang hanya ada
  di Live Sheet tidak otomatis muncul sampai masuk ke History/`data.json`.
