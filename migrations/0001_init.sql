-- ════════════════════════════════════════════════════════════════════════
-- Migrasi awal Economstock Terminal — auth + langganan
-- Jalankan: wrangler d1 execute terminal-db --remote --file=migrations/0001_init.sql
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT,
  picture    TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS subscriptions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  plan         TEXT NOT NULL,              -- '6bulan' | 'tahunan'
  status       TEXT NOT NULL DEFAULT 'active', -- 'active' | 'expired' | 'suspended'
  started_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  source       TEXT,                       -- 'mayar' | 'manual' | 'admin'
  mayar_txn_id TEXT,
  created_at   INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sub_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_sub_expires ON subscriptions(expires_at);
-- Cegah pemrosesan ganda transaksi Mayar yang sama
CREATE UNIQUE INDEX IF NOT EXISTS idx_sub_txn ON subscriptions(mayar_txn_id) WHERE mayar_txn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_codes (
  email      TEXT PRIMARY KEY,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
