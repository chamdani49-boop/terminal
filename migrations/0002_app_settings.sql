-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0002 — tabel pengaturan aplikasi (key-value JSON)
-- Dipakai untuk menyimpan konfigurasi billing (harga, teks card, link Mayar).
-- Jalankan: wrangler d1 execute terminal-db --remote --file=migrations/0002_app_settings.sql
--
-- Catatan: Worker juga membuat tabel ini otomatis (CREATE TABLE IF NOT EXISTS)
-- saat pertama kali baca/simpan billing, jadi migrasi manual ini opsional.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);
