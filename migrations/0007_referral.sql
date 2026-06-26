-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0007 — Referral (ajak teman)
--
-- Setiap user yang berhasil mengajak USER BARU mendaftar mendapat +REFERRAL_DAYS
-- hari (default 3), berlaku KELIPATAN tanpa batas & STACKING dari masa aktif.
--
--   * users.referral_code   : kode unik per user (mis. "ES-AB12CD"), dibuat lazy.
--   * users.referred_by      : kode referrer yang mengajak user ini (audit).
--   * users.referrals_count  : jumlah user baru yang berhasil diajak.
--   * referrals              : satu baris per referee (referee_id UNIQUE) →
--                              jaminan 1 reward per orang (klaim atomik, anti-dobel).
--
-- Jalankan (PRODUKSI):
--   wrangler d1 execute terminal-db --remote --file=migrations/0007_referral.sql
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by TEXT;
ALTER TABLE users ADD COLUMN referrals_count INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);

CREATE TABLE IF NOT EXISTS referrals (
  id           TEXT PRIMARY KEY,
  referrer_id  TEXT NOT NULL,
  referee_id   TEXT NOT NULL UNIQUE,   -- 1 reward per referee (anti-dobel)
  code         TEXT,
  ip           TEXT,
  created_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
