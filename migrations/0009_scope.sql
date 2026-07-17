-- ════════════════════════════════════════════════════════════════════════
-- Migrasi 0009 — kolom `scope` di tabel subscriptions
--
-- Membedakan level akses langganan:
--   'full'    → akses SEMUA fitur (Dashboard, Valuasi, Consensus, Tracker,
--               data.json, valuation.json, ohlc.json, dst). DEFAULT utk
--               semua langganan lama supaya tidak lose access.
--   'tracker' → akses HANYA tab Tracker + tracker.json. User paket
--               "1 Bulan Tracker" (Rp 149rb) berada di tier ini.
--
-- Dipakai bareng kolom `plan` (durasi/label paket). Kombinasi:
--   plan='1bulan'  × scope='tracker' → paket Rp 149rb (default via checkout)
--   plan='6bulan'  × scope='full'    → paket normal 6 bulan
--   plan='tahunan' × scope='full'    → paket tahunan
--   plan='X'       × scope='full/tracker' → admin bisa grant kombinasi apapun
--
-- DEFAULT 'full' — CRITICAL:
--   Setiap baris subscriptions lama (dibuat sebelum migration ini) otomatis
--   dapat scope='full'. Ini menjamin ZERO regression untuk pelanggan aktif —
--   mereka tetap punya akses ke semua menu setelah migration jalan.
--
-- Jalankan (dua cara):
--   A. Dashboard Cloudflare: D1 → terminal-db → Console → paste query di
--      bawah → Run. Cek dgn: SELECT COUNT(*), scope FROM subscriptions
--      GROUP BY scope; → harus tampil semua row dgn scope='full'.
--   B. CLI: wrangler d1 execute terminal-db --remote --file=migrations/0009_scope.sql
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE subscriptions ADD COLUMN scope TEXT NOT NULL DEFAULT 'full';
CREATE INDEX IF NOT EXISTS idx_sub_scope ON subscriptions(scope);
