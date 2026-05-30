---
inclusion: always
---

# Area Terkunci (Protected Areas) — WAJIB Konfirmasi Sebelum Diubah

Repo ini punya **3 menu inti** beserta backend-nya yang sudah stabil dan
**TIDAK BOLEH diubah tanpa konfirmasi eksplisit dari user terlebih dahulu**.

## Ketiga menu inti (frontend — `public/index.html`)

| # | Menu (label UI) | id halaman      | Sumber data / backend                                   |
|---|-----------------|-----------------|---------------------------------------------------------|
| 1 | Dashboard       | `page-dashboard`| History Sheet → `data.json` (stats, chart, watchlist)   |
| 2 | Simulasi        | `page-menabung` | History Sheet + perhitungan client-side                 |
| 3 | Consensus       | `page-consensus`| Consensus Sheet → `data.json` (rekomendasi, target)     |

## Backend pendukung yang ikut terkunci

- `scripts/build-data.js`  (pipeline build data + semua mode: live/full/consensus/history)
- `scripts/test-parser.js`
- `.github/workflows/refresh-data.yml`  (cron + deteksi mode)
- `worker/`  (Cloudflare Worker live feed)
- `public/data.json`, `public/_headers`, `lib/static.json`
- Bagian markup & JS di `public/index.html` yang melayani ketiga menu di atas
  (nav-tabs, bottom-nav, fungsi `showPage`, `renderDashboard`, `buildConsensusAll`,
  `buildOverview`, `buildSavingStockList`, live-feed polling, dll).

## Aturan

1. **Sebelum mengubah** file atau bagian kode mana pun di atas, Kiro WAJIB
   menjelaskan rencana perubahan dan **minta konfirmasi user dulu**. Jangan
   langsung edit.
2. **Fitur/menu baru ditambahkan secara terpisah** (idealnya sebagai halaman
   `page-<nama>` baru + modul JS sendiri) sehingga tidak menyentuh kode ketiga
   menu inti.
3. Kalau sebuah perubahan untuk fitur baru "mau tidak mau" menyentuh area
   terkunci (misal menambah item nav atau memanggil init baru), **sebutkan
   secara eksplisit** baris/area yang tersentuh dan minta konfirmasi.
4. Aturan ini berlaku untuk SEMUA sesi pada repo `chamdani49-boop/terminal`.
