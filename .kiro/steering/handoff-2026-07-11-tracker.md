---
inclusion: always
---

# Handoff 2026-07-11 — Menu Tracker (rekomendasi trading)

Konteks kerja **menu Tracker baru** (dashboard performa rekomendasi trading vs
IHSG). Meneruskan `handoff-2026-06-27.md`. **Fokus fitur ini masih PREVIEW —
belum live untuk user biasa.**

## Ringkasan singkat

Menu **Tracker** menampilkan performa rekomendasi trading (Entry / TP1 · TP2 /
SL) dari analis Indonesia, dibandingkan IHSG. Ada dua pintu:
1. **Halaman utama tracker** — dashboard performa + simulator eksekusi + papan
   peringkat + skenario per saham. Diletakkan di `#page-tracker` di
   `public/index.html`, di-skin tema terminal (ungu).
2. **Halaman input kontributor** (`tracker-input/`) — worker Cloudflare
   terpisah. Kontributor submit rekomendasi → GAS → **Google Sheet baru**
   (bukan Sheet konsensus terminal). Approve manual oleh owner. Foto bukti
   (maks 5) dikirim ke Telegram admin (tidak disimpan).

## Yang sudah SELESAI (di `main`)

- **#328–#336** — worker `tracker-input/` (halaman upload):
  - Login password → form → GAS Web App → Sheet "Tracker" (status `pending`).
  - Menu Sheet: 🎯 Tracker (Setup, Approve/Reject, Perbaiki Header).
  - **TP1 + TP2** (TP2 opsional). Validasi arah BUY/SELL. Header self-heal.
  - **Tempel & Parse**: paste teks sinyal → auto-isi Tipe/Saham/Entry/TP/SL.
  - **Tombol Gemini/ChatGPT** (pakai akun inputer, tanpa API key):
    prompt siap-pakai di textarea + tombol Salin + link buka situs.
  - **Upload foto → Telegram** (`sendMediaGroup`), foto tidak disimpan Sheet.
  - **Parse menyeluruh** (#337): mengisi analis, firm, tanggal, catatan juga.
  - Deploy tracker-input **manual** (workingDirectory `tracker-input`,
    `npx wrangler deploy` atau paste kode di Cloudflare dashboard). Halaman
    ini jarang berubah — auto-deploy tidak perlu.
  - Secret worker: `APP_PASSWORD`, `GAS_URL`, `GAS_TOKEN`,
    `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (2 terakhir opsional,
    nilai sama dgn worker `terminal`).

- **#346** — UI menu Tracker (preview admin-only):
  - `#page-tracker` di `public/index.html`: KPI (Return Konsensus / IHSG /
    Alpha / Win Rate), chart Chart.js return kumulatif, **simulator gaya
    eksekusi** 3 mode (Entry Murni / Average 1:1 / Beli di Open), papan
    peringkat analis (badge ✓ VERIF), skenario per saham (pending/trig/missed).
  - Nav-tab desktop + bottom-nav mobile "Tracker" **hidden** default via
    `.tr-menu { display:none }`. Aktif hanya bila `body.tr-admin` — di-set
    oleh `_ensureAccess()` bila `is_admin === true`.
  - **Data masih DUMMY** (generator series + list statis). Menunggu
    pipeline Sheet → `tracker.json`.
  - Semua CSS pakai prefix `.tr-*`, JS di IIFE, hook `showPage` defensif.
  - Auto-deploy via Cloudflare Git (bagian dari worker `terminal`).

## Yang BELUM (langkah berikutnya, per PR terpisah)

Prioritas dari pengguna, satu per satu jangan berbarengan:

1. **Halaman detail profil analis** — klik dari papan peringkat / skenario
   buka detail. Referensi desain: `winrate_backtest/halaman-profil-analis.html`
   (badge terverifikasi, sertifikasi, chart 90 hari, daftar rekomendasi
   Entry/TP/SL Aktif/Riwayat).
2. **Pipeline data**: build script `scripts/build-tracker.js` yang membaca
   Sheet "Tracker" (baris `status=approved`), gabung dengan **OHLC harian +
   IHSG existing** untuk hitung otomatis: return per gaya eksekusi, hit
   TP/SL, alpha vs IHSG, win rate. Output: `public/tracker.json`.
   Workflow GitHub Actions harian (mirip `refresh-ohlc.yml`).
3. **Gating scope & billing**:
   - Tambah kolom `scope` di `subscriptions` (migration baru), default
     `'full'` supaya user lama tidak terpengaruh.
   - Paket **Tracker 1 Bulan Rp199rb** (`scope=tracker`) via Mayar link.
   - Worker gate: `/tracker` + `tracker.json` butuh `scope in ('tracker','full')`;
     menu lain butuh `full`. Sudah didesain di diskusi awal.
   - Admin control: extend `adminSetDays()` dgn parameter `scope`.
   - Semua di balik **feature flag `tracker_enabled`** di `app_settings`
     (default `false`), yg baru aktif setelah semua siap.
4. Toggle "flag ON" saat sudah sempurna — menu keluar dari mode preview.

## Preferensi user (WAJIB dipatuhi)

**Aturan hasil pembelajaran hari ini — jangan diulangi:**

1. **JANGAN sentuh kode yang sudah live/jalan.** Tambahkan section/file
   baru dengan prefix isolasi. Situs utama, `terminal-live`, `uploader`,
   `tracker-input` — semua sudah jalan. Fitur baru = folder/section baru.

2. **JANGAN over-engineer.** Halaman yang jarang berubah (mis. `tracker-input`)
   **tidak perlu auto-deploy / GitHub Actions / token**. Deploy manual sekali
   sudah cukup. Situs utama `terminal` sudah auto-deploy lewat **Cloudflare
   Workers Builds (koneksi Git)** — bukan GitHub Actions/token. Jangan bikin
   pipeline baru yg tidak dibutuhkan.

3. **JANGAN banyak tanya di awal.** User ingin progres, bukan interogasi.
   Kalau perlu klarifikasi, kirim **maks 1 pertanyaan spesifik**, sisanya
   asumsi yang baik + langsung eksekusi bertahap.

4. **JANGAN push commit ke branch yang sudah di-merge.** Selalu cek dulu
   apakah PR sudah closed. Kalau iya, buat branch baru dari `main` terbaru.
   Sudah beberapa kali commit "nyangkut" — perlu cherry-pick ulang.

5. **JANGAN merender pesan panjang bertele-tele saat user marah.** Fokus:
   akui salah singkat → tunjukkan fakta (verifikasi kode) → tawarkan 1
   langkah paling menyelesaikan.

6. Jangan asumsikan user tahu detail teknis (CMD/wrangler). **Prefer cara
   dashboard Cloudflare** (paste `src/index.js` di editor UI) daripada
   CLI, kecuali user meminta.

7. **Selalu verifikasi state sebelum edit.** Baca `main` terbaru + cek PR
   status via `list_pull_requests` / `get_merged_pull_requests`. Kesalahan
   berulang di sesi ini: mengedit branch yang PR-nya sudah merged.

## Arsitektur & file kunci

- `public/index.html`
  - `#page-tracker` (~baris 3316 area) + JS IIFE — UI Tracker preview.
  - CSS `.tr-*` sebelum `</style>` utama (baris ~2502).
  - Nav-tab `#tabTracker` (baris ~2748) + bottom-nav `#bn-tracker`.
  - `_ensureAccess()` (baris ~4587): `if(admin) body.classList.add('tr-admin')`.
- `tracker-input/` — worker terpisah (halaman upload).
  - `src/index.js` — worker + form + parser + tombol AI + upload foto.
  - `gas/Code.gs` — Web App penerima; tab `Tracker`; menu 🎯 Tracker.
  - Kolom Sheet: `timestamp, status, analis, firm, sertifikasi, ticker,
    tipe, entry, tp1, tp2, sl, tanggal, horizon, catatan, submitted_by,
    approved_by`.
- Data existing yang bisa dipakai untuk hitung metrik Tracker:
  - `public/ohlc.json` + `REC_STATUS` cache (daily open/high/low/close).
  - `DATA.price_history[].IHSG` + `DATA.live.IHSG.price`.

## Cara deploy

- Situs utama (`terminal`): **auto** via Cloudflare Workers Builds saat
  merge ke `main`. Tidak perlu tindakan.
- Worker `tracker-input`: **manual sekali per perubahan**. Dua cara:
  - CMD: `cd tracker-input && npx wrangler deploy`.
  - Dashboard: Cloudflare → Workers & Pages → tracker-input → Edit code →
    paste `src/index.js` terbaru → Deploy.

## Catatan penting Google Sheet

Sheet **Tracker** terpisah dari Sheet konsensus terminal — buat baru khusus.
Menu `🎯 Tracker → Setup / Buat Tabel` bikin tab + header otomatis. Menu
`🔧 Perbaiki Header (tp1/tp2)` untuk paksa update header lama.

## Referensi desain UI

- `chamdani49-boop/tracker` (repo prototipe) — 2 file HTML:
  `dashboard-performa-vs-ihsg.html` (halaman utama) &
  `halaman-profil-analis.html` (halaman detail — belum diimplementasi).
- `chamdani49-boop/winrate_backtest` — inspirasi fitur parser sinyal
  Telegram (sudah diimplementasi sebagai "Tempel & Parse").
