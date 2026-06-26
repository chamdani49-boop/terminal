# Handoff Sesi — Economstock Terminal (Juni 2026)

Ringkasan pekerjaan & keputusan agar bisa dilanjutkan di sesi baru.

## Konteks proyek
- Cloudflare **Worker** (`src/index.js`) + static assets (`public/`). Repo: `chamdani49-boop/terminal`.
- Data valuasi dibangun `scripts/build-valuation.py` dari Excel di `data/valuation/*.xlsx` → `public/valuation/*.json` (di-rebuild via workflow `refresh-valuation.yml` saat push menyentuh `data/valuation/**` atau scriptnya).
- Auth: Google OAuth + kode email (`src/lib/auth.js`). Langganan di D1 (`src/lib/db.js`). Gating: `GATING_ENABLED="true"`.

## PR sesi ini
- **PR281 (merged):** Valuasi TTM basis kolom H — EPS dihitung di mesin, avg multiples termasuk nilai TTM, EPS growth 5th = CAGR.
- **PR282 (merged):** TTM RIIL — EPS/SPS/ROE = 12 bulan terakhir, dibaca **by-label** dari section "Key Stats" Excel. Popup keterangan TTM + label tabel fundamental.
- **PR283 (merged):** Bersih-bersih — buang outlier saat rata-rata multiple (PER>50/PBV>20/PSR>25/negatif), clamp growth ±50%, update popup (DPR tidak dirata-rata).
- **PR284 (merged):** UI — tabel proyeksi mobile, titik chart proyeksi diperkecil, pinch-zoom (`chartjs-plugin-zoom` + hammerjs), default range.
- **PR285 (merged):** Trial 30 menit. Migration `0006_trial.sql` (kolom `users.trial_used`) **sudah dijalankan ke D1**.
- **PR286 (PENDING MERGE — sudah dibuat mergeable):** admin di-skip dari trial + header tabel "Potensi/Price" 2 baris + chart default 2 tahun depan + filter judul berita "Indeks Semua Kategori" (Katadata).

## Mesin valuasi (build-valuation.py) — kondisi terkini
- Basis "tahun berjalan" = **TTM riil** dibaca **by-label** (robust thd geser baris/kolom): `EPS - TTM (Qx)`/`Current EPS (TTM)`, `Net Income - TTM (Qx)`/`Net Income (TTM)`, `Revenue - TTM (Qx)`/`Revenue (TTM)`, `Return on Equity (TTM)`. Nilai dicari di semua kolom (utamakan H/I). Cakupan ~95% EPS, ~99% ROE; sisanya fallback run-rate.
- Avg PBV/PER/PSR = nilai TTM + N tahun annual, **outlier dibuang** (`MULT_BOUNDS`).
- Growth blend `g = 0.8*5y + 0.2*annual`, lalu **clamp [-0.5, 0.5]**; growth tahunan anomali dibuang (`_sane`).
- DPR dari kolom H (tidak dirata-rata). Acuan ANTM: EPS≈353, ROE≈21,84%, potensi≈333% (pada harganya).

## Fitur Trial 30 menit
- `grantTrialIfEligible()` di `db.js`, dipanggil saat login (Google & email) di `auth.js`.
- Syarat: belum punya langganan aktif DAN `users.trial_used=0`. Klaim atomik (1× per email selamanya). **Admin di-skip** (PR286).
- Durasi: env `TRIAL_MINUTES="30"` di `wrangler.toml` (0 = matikan). Mulai **saat login** (bukan tanggal daftar).
- Migration 0006 sudah diterapkan ke D1.

## Konvensi penting (WAJIB diikuti)
- **JANGAN sertakan file auto-refresh ke PR fitur**: `public/data.json`, `public/headlines.json`, `public/insights.json`, `public/macro.json`, `public/ohlc.json`, `public/valuation/*.json`. Workflow refresh menulisnya tiap ~15 mnt → bikin **konflik merge**. Kalau branch terlanjur menyentuhnya: `merge origin/main -X theirs` lalu `git checkout origin/main -- <file data>`.
- Selalu pakai **github power tools** (`push_to_remote`, `create_pull_request`, `pull_repository`) — jangan `git push` langsung. Push ke branch, bukan main.
- Komunikasi **Bahasa Indonesia**, utamakan kecepatan.

## TODO / lanjutan
- **Merge PR286** (sudah mergeable; isinya 4 file kode saja).
- Setelah merge: berita "Indeks Semua Kategori" hilang otomatis pada refresh berikutnya (~15 mnt).
- Opsional (didiskusikan, belum dikerjakan): **guard penny-stock/distress** — ~12 saham gocap (mis. KIAS) masih tampil potensi sangat tinggi karena harga ≪ book value (sinyal inheren PBV, bukan bug).
- Opsional: SQL pembersihan baris trial admin bila admin sempat login sebelum PR286.
