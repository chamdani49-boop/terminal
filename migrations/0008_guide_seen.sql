-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0008 — penanda "panduan tur sudah dilihat" PER EMAIL/AKUN.
--
-- Supaya tur panduan hanya muncul SEKALI per email (lintas-perangkat),
-- bukan per-browser. Refresh / ganti device tidak memunculkannya lagi.
-- Ulangi tur tetap bisa via tombol "Panduan Terminal" di halaman billing.
--
-- Jalankan:
--   wrangler d1 execute terminal-db --remote --file=migrations/0008_guide_seen.sql
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN guide_seen INTEGER NOT NULL DEFAULT 0;
