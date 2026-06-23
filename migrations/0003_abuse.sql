-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0003 — tabel anti-abuse (rate limit + flag aktivitas mencurigakan)
-- Jalankan: wrangler d1 execute terminal-db --remote --file=migrations/0003_abuse.sql
--
-- Catatan: Worker juga membuat tabel ini otomatis (CREATE TABLE IF NOT EXISTS)
-- saat pertama dipakai, jadi migrasi manual ini opsional.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rate_counters (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS abuse_flags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT,
  email      TEXT,
  ip         TEXT,
  country    TEXT,
  type       TEXT,
  detail     TEXT,
  created_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_abuse_flags_created ON abuse_flags (created_at);
