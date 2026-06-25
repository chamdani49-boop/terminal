// ─────────────────────────────────────────────────────────────────────────
// db.js — akses Cloudflare D1 (users, subscriptions, email_codes)
// Semua fungsi melempar error jika env.DB belum di-binding.
// ─────────────────────────────────────────────────────────────────────────
import { randomId, now } from './util.js';

function db(env) {
  if (!env.DB) throw new Error('D1 (env.DB) belum di-binding. Lihat docs/AUTH_SETUP.md');
  return env.DB;
}

// ── USERS ──
export async function getUserByEmail(env, email) {
  return db(env).prepare('SELECT * FROM users WHERE email = ?').bind(email.toLowerCase()).first();
}

export async function getUserById(env, id) {
  return db(env).prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
}

export async function ensureUser(env, email, name = null, picture = null) {
  email = email.toLowerCase();
  const existing = await getUserByEmail(env, email);
  const t = now();
  if (existing) {
    // perbarui nama/picture bila kosong sebelumnya
    if ((name && !existing.name) || (picture && !existing.picture)) {
      await db(env).prepare('UPDATE users SET name = COALESCE(?, name), picture = COALESCE(?, picture), updated_at = ? WHERE id = ?')
        .bind(name, picture, t, existing.id).run();
    }
    return getUserById(env, existing.id);
  }
  const id = randomId(16);
  await db(env).prepare('INSERT INTO users (id, email, name, picture, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .bind(id, email, name, picture, t, t).run();
  return getUserById(env, id);
}

// ── SUBSCRIPTIONS ──
// Ambil langganan aktif (status active & belum kedaluwarsa), terbaru dulu
export async function getActiveSubscription(env, userId) {
  return db(env).prepare(
    "SELECT * FROM subscriptions WHERE user_id = ? AND status = 'active' AND expires_at > ? ORDER BY expires_at DESC LIMIT 1"
  ).bind(userId, now()).first();
}

export async function getLatestSubscription(env, userId) {
  return db(env).prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY expires_at DESC LIMIT 1')
    .bind(userId).first();
}

// Aktifkan/perpanjang langganan. Jika sudah ada langganan aktif, tambahkan
// durasi dari tanggal kedaluwarsa saat ini (stacking). Jika tidak, mulai dari sekarang.
export async function activateSubscription(env, userId, plan, days, source = 'mayar', txnId = null) {
  const t = now();
  const active = await getActiveSubscription(env, userId);
  const base = active && active.expires_at > t ? active.expires_at : t;
  const expires = base + days * 86400;
  if (active) {
    await db(env).prepare("UPDATE subscriptions SET plan = ?, expires_at = ?, source = ?, mayar_txn_id = COALESCE(?, mayar_txn_id) WHERE id = ?")
      .bind(plan, expires, source, txnId, active.id).run();
    return getLatestSubscription(env, userId);
  }
  const id = randomId(16);
  await db(env).prepare('INSERT INTO subscriptions (id, user_id, plan, status, started_at, expires_at, source, mayar_txn_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, userId, plan, 'active', t, expires, source, txnId, t).run();
  return getLatestSubscription(env, userId);
}

export async function txnAlreadyProcessed(env, txnId) {
  if (!txnId) return false;
  const row = await db(env).prepare('SELECT id FROM subscriptions WHERE mayar_txn_id = ? LIMIT 1').bind(txnId).first();
  return !!row;
}

// ── ADMIN: daftar user + langganan terbaru ──
export async function listUsersWithSub(env) {
  const admins = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const { results } = await db(env).prepare(`
    SELECT u.id, u.email, u.name, u.created_at,
           s.plan AS plan, s.status AS sub_status, s.expires_at AS expires_at,
           s.source AS source, s.mayar_txn_id AS txn
    FROM users u
    LEFT JOIN subscriptions s ON s.id = (
      SELECT id FROM subscriptions WHERE user_id = u.id ORDER BY expires_at DESC LIMIT 1
    )
    ORDER BY u.created_at DESC
  `).all();
  const t = now();
  return (results || []).map((r) => {
    let status = 'no_sub';
    if (r.sub_status === 'suspended') status = 'suspended';
    else if (r.expires_at && r.expires_at > t && r.sub_status === 'active') status = 'aktif';
    else if (r.expires_at) status = 'expired';
    return {
      email: r.email,
      nama: r.name || '-',
      paket: r.plan || '-',
      berakhir: r.expires_at || null,
      status,
      source: r.source || null,
      // Pendapatan riil = langganan dari pembayaran Mayar yang punya txn id.
      // Grant admin/manual (source!='mayar') TIDAK dihitung sebagai pendapatan.
      paid: r.source === 'mayar' && !!r.txn,
      is_admin: admins.includes((r.email || '').toLowerCase()),
    };
  });
}

export async function adminExtendDays(env, email, days, planOverride) {
  const u = await getUserByEmail(env, email);
  if (!u) throw new Error('User tidak ditemukan');
  const latest = await getLatestSubscription(env, u.id);
  const plan = planOverride || (latest ? latest.plan : 'custom');
  return activateSubscription(env, u.id, plan, days, 'admin', null);
}

// SET masa aktif = SEKARANG + days (override, BUKAN stacking). Dipakai admin
// untuk MENGURANGI / menyetel ulang masa aktif (mis. set jadi 1 hari saja).
// Berbeda dgn adminExtendDays yang menambah dari tanggal kedaluwarsa saat ini.
export async function adminSetDays(env, email, days, planOverride) {
  const u = await getUserByEmail(env, email);
  if (!u) throw new Error('User tidak ditemukan');
  const t = now();
  const expires = t + days * 86400;
  const latest = await getLatestSubscription(env, u.id);
  const plan = planOverride || (latest ? latest.plan : 'custom');
  if (latest) {
    await db(env).prepare("UPDATE subscriptions SET plan = ?, status = 'active', expires_at = ?, source = 'admin' WHERE id = ?")
      .bind(plan, expires, latest.id).run();
    return getLatestSubscription(env, u.id);
  }
  const id = randomId(16);
  await db(env).prepare('INSERT INTO subscriptions (id, user_id, plan, status, started_at, expires_at, source, mayar_txn_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(id, u.id, plan, 'active', t, expires, 'admin', null, t).run();
  return getLatestSubscription(env, u.id);
}

export async function adminSetStatus(env, email, status) {
  const u = await getUserByEmail(env, email);
  if (!u) throw new Error('User tidak ditemukan');
  const latest = await getLatestSubscription(env, u.id);
  if (!latest) throw new Error('User belum punya langganan');
  await db(env).prepare('UPDATE subscriptions SET status = ? WHERE id = ?').bind(status, latest.id).run();
  return { ok: true };
}

// Auto-suspend berdasarkan user_id (dipakai engine anti-abuse). Idempoten:
// hanya men-suspend kalau saat ini ADA langganan aktif. Mengembalikan true bila
// status benar-benar berubah aktif→suspended (untuk hindari notif berulang).
export async function autoSuspendByUserId(env, userId) {
  const active = await getActiveSubscription(env, userId);
  if (!active) return false;
  await db(env).prepare("UPDATE subscriptions SET status = 'suspended' WHERE id = ?").bind(active.id).run();
  return true;
}

export async function adminDeleteUser(env, email) {
  const u = await getUserByEmail(env, email);
  if (!u) throw new Error('User tidak ditemukan');
  await db(env).prepare('DELETE FROM users WHERE id = ?').bind(u.id).run();
  return { ok: true };
}

export async function adminEditUser(env, email, name) {
  const u = await getUserByEmail(env, email);
  if (!u) throw new Error('User tidak ditemukan');
  await db(env).prepare('UPDATE users SET name = ?, updated_at = ? WHERE id = ?').bind(name, now(), u.id).run();
  return { ok: true };
}

// ── EMAIL CODES ──
export async function saveEmailCode(env, email, codeHash, ttl = 600) {
  const t = now();
  await db(env).prepare(`
    INSERT INTO email_codes (email, code_hash, expires_at, attempts, created_at)
    VALUES (?,?,?,0,?)
    ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at
  `).bind(email.toLowerCase(), codeHash, t + ttl, t).run();
}

export async function getEmailCode(env, email) {
  return db(env).prepare('SELECT * FROM email_codes WHERE email = ?').bind(email.toLowerCase()).first();
}

export async function incEmailAttempts(env, email) {
  await db(env).prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?').bind(email.toLowerCase()).run();
}

export async function deleteEmailCode(env, email) {
  await db(env).prepare('DELETE FROM email_codes WHERE email = ?').bind(email.toLowerCase()).run();
}
