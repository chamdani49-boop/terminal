-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0010 — penanda status PWA install per EMAIL/AKUN.
--
-- Tujuan: menampilkan popup "Pasang Terminal" dengan frekuensi wajar,
-- yaitu MAKSIMAL sekali per minggu per email untuk user yang belum
-- memasang PWA. User yang sudah membuka Terminal sebagai standalone
-- webapp (mode PWA/display-mode:standalone) TIDAK PERLU melihat popup
-- ini lagi — client akan otomatis nge-POST /api/pwa-installed saat
-- terdeteksi berjalan di standalone mode.
--
-- Kolom:
--   pwa_last_prompt_at — unix seconds ketika popup terakhir kali
--     ditampilkan. 0 = belum pernah. Server hanya menghitung
--     should_prompt=true kalau (now - pwa_last_prompt_at) >= 7 hari.
--   pwa_installed_at   — unix seconds ketika akun ini pertama kali
--     terdeteksi menjalankan Terminal sebagai PWA (standalone). > 0
--     berarti "sudah pasang" → server tidak akan pernah kirim
--     should_prompt=true lagi untuk akun ini.
--
-- FAIL-SAFE: semua kode backend membungkus akses dua kolom ini dengan
-- try/catch — kalau migration ini belum dijalankan, fitur PWA popup
-- diam-diam non-aktif tapi login/dashboard tetap normal.
--
-- Jalankan:
--   wrangler d1 execute terminal-db --remote --file=migrations/0010_pwa_install.sql
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN pwa_last_prompt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN pwa_installed_at   INTEGER NOT NULL DEFAULT 0;
