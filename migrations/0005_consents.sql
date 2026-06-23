-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0005 — pencatatan persetujuan Ketentuan & Kebijakan Privasi
-- Jalankan: wrangler d1 execute terminal-db --remote --file=migrations/0005_consents.sql
--
-- Catatan: Worker juga membuat tabel ini otomatis (CREATE TABLE IF NOT EXISTS).
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS consents (
  user_id     TEXT PRIMARY KEY,
  version     INTEGER,
  accepted_at INTEGER,
  ip          TEXT
);
