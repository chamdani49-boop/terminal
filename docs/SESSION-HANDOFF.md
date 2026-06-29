# Handoff Sesi — Economstock Terminal

Dokumen ringkas agar pekerjaan bisa dilanjutkan di sesi baru.
**Detail terbaru ada di `.kiro/steering/handoff-2026-06-29.md`** (auto-dibaca tiap sesi).

## Konteks proyek
- Cloudflare **Worker** (`src/index.js`) + static assets (`public/`). Repo: `chamdani49-boop/terminal`.
- Worker live TERPISAH `worker/` (`terminal-live`) untuk harga real-time — deploy manual `wrangler deploy`.
- Auth: Google OAuth + kode email. Langganan di D1. `GATING_ENABLED="true"`.
- Pengaturan fitur (trial on/off, ajak teman on/off, durasi trial) disimpan di D1 `app_settings` key `feature_flags`, diatur dari `/admin` kartu "Pengaturan Fitur".

## Sesi 29 Jun 2026 (PR #305–#313)
- **#307** layout billing final (Paket → Ajak Teman+Panduan → Tools+Telegram).
- **#308** toggle Trial & Ajak Teman di admin.
- **#309** fix Worker: cache-buster gviz. **#310** fix UI: poll live 60 dtk + cache-bust berjendela.
- **#311** kotak diagnostik live `?livedebug=1`. **#312** sinkron angka turunan valuasi saat live.
- **#313** durasi trial 1/2/5/30 menit dari admin (testing).
- **#305 PENDING** (CSP/HSTS security headers) — belum diputuskan.

### Saga "harga live beku" → SUDAH BERES
Harga live datang dari Worker `terminal-live` `/live.json` (bukan workflow). Penyebab beku:
Worker balas **HTTP 500** karena secret **`LIVE_SHEET_ID`/`LIVE_GID` belum di-set**.
Sudah di-set ulang via Cloudflare Dashboard → live + semua turunannya jalan.
Diagnostik: buka dashboard `?livedebug=1` saat jam bursa.

## Aturan kerja penting
- Pakai github power tools; push ke branch baru + **Merge via PR** (push langsung ke `main` sering kalah balapan dgn bot auto-refresh saat jam bursa).
- JANGAN ikutkan file data auto-refresh di PR fitur (`public/data.json`, `headlines.json`, `insights.json`, `macro.json`, `ohlc.json`, `valuation/*.json`).
- Worker `terminal-live` deploy manual (`cd worker && npx wrangler deploy`); secret wajib: `LIVE_SHEET_ID`, `LIVE_GID`, `LIVE_TOKEN_SECRET`, `CONSENSUS_SHEET_ID/GID`, `HISTORY_SHEET_ID/GID`.
