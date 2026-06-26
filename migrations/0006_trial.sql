-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0006 — Trial sekali-pakai per user (opsi kuat)
-- Menambah penanda `trial_used` di tabel users. Kebal dari perubahan baris
-- langganan (mis. trial → upgrade berbayar), sehingga trial dijamin 1x per email.
--
-- Jalankan (PRODUKSI):
--   wrangler d1 execute terminal-db --remote --file=migrations/0006_trial.sql
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN trial_used INTEGER NOT NULL DEFAULT 0;
