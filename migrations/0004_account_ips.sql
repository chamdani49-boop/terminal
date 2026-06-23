-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0004 — fingerprint device/IP per akun (deteksi akun dibagi)
-- Jalankan: wrangler d1 execute terminal-db --remote --file=migrations/0004_account_ips.sql
--
-- Catatan: Worker juga membuat tabel ini otomatis (CREATE TABLE IF NOT EXISTS)
-- saat pertama dipakai, jadi migrasi manual ini opsional.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS account_ips (
  user_id TEXT NOT NULL,
  ip      TEXT NOT NULL,
  day     INTEGER NOT NULL,
  email   TEXT,
  country TEXT,
  ua      TEXT,
  seen_at INTEGER,
  PRIMARY KEY (user_id, ip, day)
);

CREATE INDEX IF NOT EXISTS idx_account_ips_user_seen ON account_ips (user_id, seen_at);
