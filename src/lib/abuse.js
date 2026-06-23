// ─────────────────────────────────────────────────────────────────────────
// abuse.js — lapisan anti-scraping / anti-abuse (Step 1)
//
// Berisi:
//   - rateLimit()   : fixed-window rate limiter per-user (disimpan di D1).
//   - recordFlag()  : catat aktivitas mencurigakan ke D1 (untuk review admin).
//   - recentFlags() : ambil flag terbaru (dipakai panel admin).
//   - flagSummary() : agregasi per-user 24 jam terakhir.
//
// PRINSIP PENTING:
//   - FAIL-OPEN: kalau D1 error / belum siap, JANGAN pernah blokir user.
//     Proteksi tidak boleh malah menjegal pelanggan yang sah.
//   - Admin & request tanpa identitas tidak dihitung (di-handle pemanggil).
//   - Tabel dibuat otomatis (CREATE TABLE IF NOT EXISTS) → tidak wajib migrasi
//     manual. Migration 0003 tetap disediakan untuk kebersihan.
// ─────────────────────────────────────────────────────────────────────────
import { now } from './util.js';

const DEFAULT_WINDOW_SEC = 60;

// Cache per-isolate supaya CREATE TABLE tidak jalan tiap request.
let _tablesReady = false;

async function ensureTables(env) {
  if (_tablesReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS rate_counters ('
    + 'key TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS abuse_flags ('
    + 'id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, email TEXT, ip TEXT, '
    + 'country TEXT, type TEXT, detail TEXT, created_at INTEGER)'
  ).run();
  _tablesReady = true;
}

/**
 * Fixed-window rate limit per identitas (user_id). 1 read + 1 write D1.
 * @returns {Promise<{ok:boolean, count?:number, retryAfter?:number}>}
 */
export async function rateLimit(env, { identity, limit, windowSec = DEFAULT_WINDOW_SEC }) {
  if (!env.DB || !identity || !limit) return { ok: true };
  const t = now();
  const key = 'u:' + identity;
  try {
    await ensureTables(env);
    const row = await env.DB.prepare('SELECT count, window_start FROM rate_counters WHERE key = ?')
      .bind(key).first();

    // Window baru / habis → reset ke 1
    if (!row || (t - row.window_start) >= windowSec) {
      await env.DB.prepare(
        'INSERT INTO rate_counters (key, count, window_start) VALUES (?, 1, ?) '
        + 'ON CONFLICT(key) DO UPDATE SET count = 1, window_start = ?'
      ).bind(key, t, t).run();
      return { ok: true, count: 1 };
    }

    const newCount = (row.count || 0) + 1;
    await env.DB.prepare('UPDATE rate_counters SET count = ? WHERE key = ?').bind(newCount, key).run();

    if (newCount > limit) {
      return { ok: false, count: newCount, retryAfter: Math.max(1, windowSec - (t - row.window_start)) };
    }
    return { ok: true, count: newCount };
  } catch (_) {
    return { ok: true };   // FAIL-OPEN
  }
}

/** Catat satu flag aktivitas mencurigakan. Aman dipanggil via ctx.waitUntil(). */
export async function recordFlag(env, { userId, email, ip, country, type, detail }) {
  if (!env.DB) return;
  try {
    await ensureTables(env);
    await env.DB.prepare(
      'INSERT INTO abuse_flags (user_id, email, ip, country, type, detail, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId || null, email || null, ip || null, country || null, type || '', detail || '', now()).run();
  } catch (_) { /* abaikan */ }
}

/** Flag terbaru (default 100) untuk panel admin. */
export async function recentFlags(env, { limit = 100 } = {}) {
  if (!env.DB) return [];
  try {
    await ensureTables(env);
    const res = await env.DB.prepare(
      'SELECT user_id, email, ip, country, type, detail, created_at '
      + 'FROM abuse_flags ORDER BY created_at DESC LIMIT ?'
    ).bind(Math.min(500, Math.max(1, limit))).all();
    return (res && res.results) || [];
  } catch (_) { return []; }
}

/** Agregasi per email 24 jam terakhir (top offender). */
export async function flagSummary(env, { hours = 24, limit = 20 } = {}) {
  if (!env.DB) return [];
  try {
    await ensureTables(env);
    const since = now() - hours * 3600;
    const res = await env.DB.prepare(
      'SELECT COALESCE(email, user_id) AS who, COUNT(*) AS flags, '
      + 'COUNT(DISTINCT ip) AS ips, MAX(created_at) AS last_at '
      + 'FROM abuse_flags WHERE created_at >= ? GROUP BY who ORDER BY flags DESC LIMIT ?'
    ).bind(since, Math.min(100, Math.max(1, limit))).all();
    return (res && res.results) || [];
  } catch (_) { return []; }
}
