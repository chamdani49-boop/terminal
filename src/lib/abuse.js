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
import { autoSuspendByUserId } from './db.js';

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
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS account_ips ('
    + 'user_id TEXT NOT NULL, ip TEXT NOT NULL, day INTEGER NOT NULL, '
    + 'email TEXT, country TEXT, ua TEXT, seen_at INTEGER, '
    + 'PRIMARY KEY (user_id, ip, day))'
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

// ── Notifikasi Telegram ───────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** Kirim pesan ke Telegram (HTML). Butuh secret TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID. */
export async function sendTelegram(env, text) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return { ok: false, skipped: true, reason: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID belum di-set' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); if (j && j.description) msg = j.description; } catch (_) {}
      return { ok: false, error: msg };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'fetch error' };
  }
}

/** True bila boleh kirim notif untuk `key` (cooldown agar tidak spam). Pakai rate_counters. */
async function notifyThrottled(env, key, cooldownSec) {
  if (!env.DB) return true;
  const t = now();
  try {
    await ensureTables(env);
    const row = await env.DB.prepare('SELECT window_start FROM rate_counters WHERE key = ?').bind(key).first();
    if (row && (t - row.window_start) < cooldownSec) return false;
    await env.DB.prepare(
      'INSERT INTO rate_counters (key, count, window_start) VALUES (?, 1, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET window_start = ?'
    ).bind(key, t, t).run();
    return true;
  } catch (_) { return false; }
}

/**
 * Catat flag + (dengan throttle) kirim notifikasi Telegram.
 * Throttle per-user/IP default 30 menit (var ABUSE_NOTIFY_COOLDOWN_SEC) supaya
 * scraper yang spam 429 tidak membanjiri Telegram.
 */
export async function reportAbuse(env, info) {
  await recordFlag(env, info);
  const cooldown = parseInt(env.ABUSE_NOTIFY_COOLDOWN_SEC || '1800', 10) || 1800;
  const key = 'notif:' + (info.type || 'x') + ':' + (info.userId || info.ip || 'anon');
  if (await notifyThrottled(env, key, cooldown)) {
    const txt =
      '🛡️ <b>Economstock Terminal</b> — aktivitas mencurigakan\n'
      + `• Tipe: <b>${esc(info.type)}</b>\n`
      + `• User: ${esc(info.email || info.userId || '—')}\n`
      + `• IP: ${esc(info.ip || '—')}${info.country ? ' (' + esc(info.country) + ')' : ''}\n`
      + `• Detail: ${esc(info.detail || '—')}\n`
      + '\nBuka /admin → panel "Aktivitas Mencurigakan" untuk review.';
    await sendTelegram(env, txt);
  }

  // Auto-suspend (OPSIONAL, OFF default). Jangan cek ulang untuk flag auto_suspend.
  if (info.type !== 'auto_suspend') {
    await maybeAutoSuspend(env, info);
  }
}

/** Jumlah flag untuk satu user dalam `hours` jam terakhir (exclude auto_suspend). */
async function flagCountForUser(env, userId, hours) {
  if (!env.DB || !userId) return 0;
  try {
    await ensureTables(env);
    const since = now() - hours * 3600;
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM abuse_flags WHERE user_id = ? AND created_at >= ? AND type != 'auto_suspend'"
    ).bind(userId, since).first();
    return (row && row.c) || 0;
  } catch (_) { return 0; }
}

/** True kalau auto-suspend aktif (var ABUSE_AUTOSUSPEND === "true"). */
export function autosuspendEnabled(env) {
  return env.ABUSE_AUTOSUSPEND === 'true';
}

/**
 * Auto-suspend HANYA untuk abuse parah & BERULANG: kalau 1 user mengumpulkan
 * >= ABUSE_AUTOSUSPEND_FLAGS (default 12) flag dalam ABUSE_AUTOSUSPEND_HOURS
 * (default 24) jam. OFF kecuali ABUSE_AUTOSUSPEND="true". Admin dikecualikan di
 * pemanggil (guardProtected tidak menjalankan rate-limit/flag untuk admin).
 * Aman: idempoten (sekali suspend, tidak diulang) + notif Telegram sekali.
 */
async function maybeAutoSuspend(env, info) {
  if (!autosuspendEnabled(env) || !info.userId) return;
  const hours = parseInt(env.ABUSE_AUTOSUSPEND_HOURS || '24', 10) || 24;
  const threshold = parseInt(env.ABUSE_AUTOSUSPEND_FLAGS || '12', 10) || 12;
  const count = await flagCountForUser(env, info.userId, hours);
  if (count < threshold) return;

  let suspended = false;
  try { suspended = await autoSuspendByUserId(env, info.userId); } catch (_) { suspended = false; }
  if (!suspended) return;   // sudah suspended / tidak ada langganan aktif

  await recordFlag(env, {
    userId: info.userId, email: info.email, ip: info.ip, country: info.country,
    type: 'auto_suspend', detail: `${count} flag dalam ${hours} jam → otomatis di-suspend`,
  });
  await sendTelegram(env,
    '⛔ <b>AUTO-SUSPEND</b> — Economstock Terminal\n'
    + `• User: ${esc(info.email || info.userId)}\n`
    + `• Alasan: ${count} flag dalam ${hours} jam\n`
    + '\nBuka /admin → tabel user untuk review / aktifkan kembali (klik ⛔).'
  );
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

// ── Device / IP fingerprint → deteksi akun dibagi (account sharing) ────────
/**
 * Catat IP yang dipakai akun (1 baris per user+ip+hari) lalu, saat ada IP BARU,
 * cek apakah akun dipakai dari terlalu banyak IP/negara dalam 24 jam. Kalau ya →
 * flag `account_sharing` + notif Telegram (throttled). Hanya FLAG untuk review,
 * TIDAK auto-block (hindari salah blokir; IP mobile sering berganti).
 *
 * Ambang via env (default longgar supaya minim false-positive):
 *   ACCOUNT_MAX_IPS_PER_DAY  (default 8)
 *   ACCOUNT_MAX_COUNTRIES    (default 3)
 */
export async function trackDevice(env, { userId, email, ip, country, ua }) {
  if (!env.DB || !userId || !ip) return;
  const maxIps = parseInt(env.ACCOUNT_MAX_IPS_PER_DAY || '8', 10) || 8;
  const maxCountries = parseInt(env.ACCOUNT_MAX_COUNTRIES || '3', 10) || 3;
  try {
    await ensureTables(env);
    const t = now();
    const day = Math.floor(t / 86400);
    const ins = await env.DB.prepare(
      'INSERT OR IGNORE INTO account_ips (user_id, ip, day, email, country, ua, seen_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(userId, ip, day, email || null, country || '', (ua || '').slice(0, 160), t).run();

    // Hanya cek lebih lanjut kalau IP ini BARU hari ini (hemat query).
    const isNew = ins && ins.meta && ins.meta.changes > 0;
    if (!isNew) return;

    const since = t - 86400;
    const row = await env.DB.prepare(
      'SELECT COUNT(DISTINCT ip) AS ips, COUNT(DISTINCT country) AS countries '
      + 'FROM account_ips WHERE user_id = ? AND seen_at >= ?'
    ).bind(userId, since).first();
    const ips = (row && row.ips) || 0;
    const countries = (row && row.countries) || 0;

    if (ips > maxIps || countries > maxCountries) {
      await reportAbuse(env, {
        userId, email, ip, country,
        type: 'account_sharing',
        detail: `${ips} IP & ${countries} negara dalam 24 jam (ambang ${maxIps} IP / ${maxCountries} negara)`,
      });
    }
  } catch (_) { /* abaikan */ }
}

/** Ringkasan akun dengan banyak IP (24 jam) untuk panel admin. */
export async function deviceSummary(env, { hours = 24, limit = 20 } = {}) {
  if (!env.DB) return [];
  try {
    await ensureTables(env);
    const since = now() - hours * 3600;
    const res = await env.DB.prepare(
      'SELECT user_id, MAX(email) AS email, COUNT(DISTINCT ip) AS ips, '
      + 'COUNT(DISTINCT country) AS countries, MAX(seen_at) AS last_at '
      + 'FROM account_ips WHERE seen_at >= ? GROUP BY user_id HAVING ips > 1 '
      + 'ORDER BY ips DESC LIMIT ?'
    ).bind(since, Math.min(100, Math.max(1, limit))).all();
    return (res && res.results) || [];
  } catch (_) { return []; }
}
