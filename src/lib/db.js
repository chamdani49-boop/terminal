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
  const created = await getUserById(env, id);
  if (created) created.is_new = true;   // penanda (in-memory) — dipakai utk reward referral saat daftar
  return created;
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

// ── FEATURE FLAGS (toggle dari panel admin, disimpan di app_settings) ──
// Mengizinkan admin meng-aktif/non-aktifkan fitur TANPA deploy ulang.
//   key 'feature_flags' → {"trial":true,"referral":true}
// Default: kedua fitur AKTIF (perilaku tidak berubah sampai admin mematikan).
// FAIL-SAFE: bila tabel belum ada / D1 error → kembalikan default (aktif).
export async function getFeatureFlags(env) {
  const out = { trial: true, referral: true, trial_minutes: null };
  try {
    await db(env).prepare('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)').run();
    const row = await db(env).prepare('SELECT value FROM app_settings WHERE key = ?').bind('feature_flags').first();
    if (row && row.value) {
      const v = JSON.parse(row.value);
      if (typeof v.trial === 'boolean') out.trial = v.trial;
      if (typeof v.referral === 'boolean') out.referral = v.referral;
      // Durasi trial (menit) — khusus testing, diatur dari panel admin. null = pakai env TRIAL_MINUTES.
      if (Number.isFinite(v.trial_minutes) && v.trial_minutes > 0) out.trial_minutes = v.trial_minutes;
    }
  } catch { /* default: aktif */ }
  return out;
}

export async function setFeatureFlags(env, flags) {
  const cur = await getFeatureFlags(env);
  const next = {
    trial: typeof (flags && flags.trial) === 'boolean' ? flags.trial : cur.trial,
    referral: typeof (flags && flags.referral) === 'boolean' ? flags.referral : cur.referral,
    // Durasi trial (menit): simpan bila angka valid > 0, selain itu pertahankan nilai lama.
    trial_minutes: (flags && Number.isFinite(Number(flags.trial_minutes)) && Number(flags.trial_minutes) > 0)
      ? Math.floor(Number(flags.trial_minutes))
      : cur.trial_minutes,
  };
  await db(env).prepare('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)').run();
  await db(env).prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind('feature_flags', JSON.stringify(next), now()).run();
  return next;
}

// ── REFERRAL (ajak teman) ──
// Reward +REFERRAL_DAYS hari (default 3) ke REFERRER tiap berhasil mengajak
// USER BARU mendaftar. Kelipatan tanpa batas, STACKING (lewat activateSubscription),
// source='referral' → TIDAK dihitung pendapatan. Semua fungsi FAIL-SAFE: bila
// kolom/tabel referral belum ada (migration belum jalan) → diam-diam dilewati.
const _REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa I,O,0,1 (anti-ambigu)
function _genReferralCode() {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < 6; i++) s += _REF_ALPHABET[arr[i] % _REF_ALPHABET.length];
  return `ES-${s}`;
}

export async function getUserByReferralCode(env, code) {
  if (!code) return null;
  try {
    return await db(env).prepare('SELECT * FROM users WHERE referral_code = ? LIMIT 1')
      .bind(String(code).trim().toUpperCase()).first();
  } catch { return null; }
}

// Pastikan user punya referral_code unik (generate lazy & simpan). Mengembalikan
// kode, atau null bila migration belum jalan / gagal.
export async function ensureReferralCode(env, user) {
  try {
    if (!user || !user.id) return null;
    if (user.referral_code) return user.referral_code;
    for (let attempt = 0; attempt < 6; attempt++) {
      const code = _genReferralCode();
      const t = now();
      try {
        const r = await db(env).prepare('UPDATE users SET referral_code = ?, updated_at = ? WHERE id = ? AND referral_code IS NULL')
          .bind(code, t, user.id).run();
        if (r && r.meta && r.meta.changes > 0) return code;
      } catch { /* tabrakan UNIQUE → ulang dgn kode lain */ }
      // changes==0: sudah punya kode (race) → ambil yang ada
      const fresh = await getUserById(env, user.id);
      if (fresh && fresh.referral_code) return fresh.referral_code;
    }
    return null;
  } catch { return null; }
}

// Kode + statistik untuk ditampilkan (N orang · M hari).
export async function getReferralInfo(env, userId) {
  if (!(await getFeatureFlags(env)).referral) return null;   // fitur dimatikan dari admin
  const user = await getUserById(env, userId);
  if (!user) return null;
  let code = user.referral_code || null;
  if (!code) code = await ensureReferralCode(env, user);
  const raw = env.REFERRAL_DAYS;
  let per = (raw === undefined || raw === null || String(raw).trim() === '') ? 3 : parseInt(raw, 10);
  if (!Number.isFinite(per) || per < 0) per = 3;
  const count = user.referrals_count || 0;
  return { code, count, days: count * per };
}

// Beri reward referral SAAT user baru daftar (dipanggil dari alur login).
// Anti-curang B+: 1 reward/referee (referee_id UNIQUE), IP referee != IP referrer.
export async function rewardReferralIfEligible(env, { newUser, refCode, ip } = {}) {
  try {
    if (!newUser || !newUser.id || !refCode) return null;
    if (!(await getFeatureFlags(env)).referral) return null;   // fitur dimatikan dari admin
    const raw = env.REFERRAL_DAYS;
    const days = (raw === undefined || raw === null || String(raw).trim() === '') ? 3 : parseInt(raw, 10);
    if (!Number.isFinite(days) || days <= 0) return null;          // fitur dimatikan
    const code = String(refCode).trim().toUpperCase();
    const referrer = await getUserByReferralCode(env, code);
    if (!referrer || referrer.id === newUser.id) return null;       // kode tak valid / refer diri sendiri
    // B+ : IP daftar referee tidak boleh sama dengan IP yang pernah dipakai referrer.
    if (ip) {
      try {
        const same = await db(env).prepare('SELECT 1 FROM account_ips WHERE user_id = ? AND ip = ? LIMIT 1')
          .bind(referrer.id, ip).first();
        if (same) return null;
      } catch { /* tabel account_ips belum ada → lewati cek IP */ }
    }
    // Klaim atomik: 1 reward per referee (referee_id UNIQUE). Sudah pernah → batal.
    const id = randomId(16);
    const t = now();
    const ins = await db(env).prepare('INSERT OR IGNORE INTO referrals (id, referrer_id, referee_id, code, ip, created_at) VALUES (?,?,?,?,?,?)')
      .bind(id, referrer.id, newUser.id, code, ip || null, t).run();
    if (!ins || !ins.meta || ins.meta.changes === 0) return null;
    try { await db(env).prepare('UPDATE users SET referred_by = ?, updated_at = ? WHERE id = ?').bind(code, t, newUser.id).run(); } catch { /* kolom opsional */ }
    try { await db(env).prepare('UPDATE users SET referrals_count = COALESCE(referrals_count,0) + 1, updated_at = ? WHERE id = ?').bind(t, referrer.id).run(); } catch { /* kolom opsional */ }
    // Admin = akses permanen → tak perlu baris langganan 'referral' (biar panel admin rapi).
    const admins = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const referrerIsAdmin = referrer.email && admins.includes(String(referrer.email).toLowerCase());
    if (!referrerIsAdmin) {
      await activateSubscription(env, referrer.id, 'referral', days, 'referral', null);
    }
    return { referrerId: referrer.id, days };
  } catch { return null; }
}

// ── TRIAL (sekali per user, dimulai saat LOGIN bila memenuhi syarat) ──
// Memberi langganan 'trial' selama TRIAL_MINUTES menit JIKA:
//   (1) user belum punya langganan aktif (berbayar/admin/trial berjalan), DAN
//   (2) hak trial belum pernah dipakai (users.trial_used = 0).
// Penanda trial_used diklaim ATOMIK (UPDATE ... WHERE trial_used=0) agar tidak
// dobel saat login bersamaan. Durasi via env TRIAL_MINUTES (default 30; 0/invalid
// → trial dimatikan). FAIL-SAFE: bila kolom trial_used belum ada (migration belum
// dijalankan) atau D1 error, fungsi diam-diam tidak memberi trial & TIDAK
// mengganggu proses login.
export async function grantTrialIfEligible(env, userId, email = null) {
  // Admin TIDAK dapat trial — akses admin permanen via ADMIN_EMAILS (lepas dari
  // langganan), jadi jangan buatkan baris trial untuk admin (biar panel admin rapi
  // & admin tak ikut terdampak masa trial).
  const admins = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (email && admins.includes(String(email).toLowerCase())) return null;
  const flags = await getFeatureFlags(env);
  if (!flags.trial) return null;          // fitur dimatikan dari admin
  // Durasi trial: utamakan setelan admin (app_settings, khusus testing), lalu env TRIAL_MINUTES, default 30.
  const raw = (flags.trial_minutes != null) ? flags.trial_minutes : env.TRIAL_MINUTES;
  const mins = (raw === undefined || raw === null || String(raw).trim() === '') ? 30 : parseInt(raw, 10);
  if (!Number.isFinite(mins) || mins <= 0) return null;          // trial dimatikan
  try {
    // Punya langganan aktif? → tak perlu trial, & JANGAN konsumsi hak trial
    // (supaya saat langganan expired nanti dia tetap berhak dapat trial).
    const active = await getActiveSubscription(env, userId);
    if (active) return null;
    // Klaim hak trial secara atomik: hanya berhasil bila trial_used masih 0.
    const t = now();
    const claim = await db(env).prepare('UPDATE users SET trial_used = 1, updated_at = ? WHERE id = ? AND trial_used = 0')
      .bind(t, userId).run();
    if (!claim || !claim.meta || claim.meta.changes === 0) return null;  // sudah pernah trial / user tak ada
    const id = randomId(16);
    await db(env).prepare('INSERT INTO subscriptions (id, user_id, plan, status, started_at, expires_at, source, mayar_txn_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .bind(id, userId, 'trial', 'active', t, t + mins * 60, 'trial', null, t).run();
    return getLatestSubscription(env, userId);
  } catch {
    return null;   // mis. kolom trial_used belum ada → lewati dengan aman
  }
}

// ── ADMIN: daftar user + langganan terbaru ──
export async function listUsersWithSub(env) {
  const admins = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // last_seen = aktivitas terakhir user (MAX seen_at di account_ips, dicatat saat
  // buka dashboard/data.json). Subquery dibungkus fallback: bila tabel account_ips
  // belum ada (anti-abuse belum pernah jalan), pakai query tanpa last_seen.
  const sql = (withSeen) => `
    SELECT u.id, u.email, u.name, u.created_at,
           s.plan AS plan, s.status AS sub_status, s.expires_at AS expires_at,
           s.source AS source, s.mayar_txn_id AS txn${withSeen ? `,
           (SELECT MAX(a.seen_at) FROM account_ips a WHERE a.user_id = u.id) AS last_seen` : ''}
    FROM users u
    LEFT JOIN subscriptions s ON s.id = (
      SELECT id FROM subscriptions WHERE user_id = u.id ORDER BY expires_at DESC LIMIT 1
    )
    ORDER BY u.created_at DESC
  `;
  let results;
  try { ({ results } = await db(env).prepare(sql(true)).all()); }
  catch { ({ results } = await db(env).prepare(sql(false)).all()); }
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
      last_seen: r.last_seen || null,   // epoch detik aktivitas terakhir (null = belum pernah)
      status,
      source: r.source || null,
      // Pendapatan riil = langganan dari pembayaran Mayar yang punya txn id.
      // Grant admin/manual (source!='mayar') TIDAK dihitung sebagai pendapatan.
      paid: r.source === 'mayar' && !!r.txn,
      is_admin: admins.includes((r.email || '').toLowerCase()),
    };
  });
}

// ── Rekap REFERRAL untuk panel admin (READ-ONLY, dikelompokkan per PENGAJAK) ──
// Sumber: tabel `referrals` (referrer_id → referee_id) + users + subscriptions.
// Per pengajak: kode, jumlah diajak, jumlah yang BERLANGGANAN (pernah bayar via
// Mayar), + daftar referee {email, nama, status langganan, berlangganan?}.
// FAIL-SAFE: bila tabel referrals belum ada → kembalikan [] (tidak error).
// CATATAN: murni tampilan; TIDAK mengubah logika reward yang sudah ada.
export async function listReferralsGrouped(env) {
  const t = now();
  let results;
  try {
    ({ results } = await db(env).prepare(`
      SELECT r.referrer_id, r.created_at,
             ru.email AS referrer_email, ru.referral_code AS code,
             eu.email AS referee_email, eu.name AS referee_name,
             s.status AS sub_status, s.expires_at AS expires_at,
             (SELECT COUNT(*) FROM subscriptions ps
                WHERE ps.user_id = r.referee_id AND ps.source = 'mayar'
                  AND ps.mayar_txn_id IS NOT NULL) AS paid_count
      FROM referrals r
      JOIN users ru ON ru.id = r.referrer_id
      JOIN users eu ON eu.id = r.referee_id
      LEFT JOIN subscriptions s ON s.id = (
        SELECT id FROM subscriptions WHERE user_id = r.referee_id ORDER BY expires_at DESC LIMIT 1
      )
      ORDER BY ru.email ASC, r.created_at DESC
    `).all());
  } catch { return []; }

  const map = new Map();
  for (const r of (results || [])) {
    let status = 'no_sub';
    if (r.sub_status === 'suspended') status = 'suspended';
    else if (r.expires_at && r.expires_at > t && r.sub_status === 'active') status = 'aktif';
    else if (r.expires_at) status = 'expired';
    const subscribed = (r.paid_count || 0) > 0;   // pernah bayar (Mayar) = "berlangganan"
    const key = r.referrer_id;
    if (!map.has(key)) {
      map.set(key, { referrer: r.referrer_email, code: r.code || null, count: 0, subscribed: 0, referees: [] });
    }
    const g = map.get(key);
    g.count += 1;
    if (subscribed) g.subscribed += 1;
    g.referees.push({ email: r.referee_email, nama: r.referee_name || '-', status, subscribed });
  }
  // Urutkan: pengajak dgn ajakan terbanyak dulu, lalu yg paling banyak berlangganan.
  return Array.from(map.values()).sort((a, b) => (b.count - a.count) || (b.subscribed - a.subscribed));
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

// Tandai panduan tur sudah dilihat (per email/akun). FAIL-SAFE: bila kolom
// guide_seen belum ada (migration belum jalan) → diabaikan dengan aman.
export async function markGuideSeen(env, userId) {
  if (!userId) return { ok: false };
  try {
    await db(env).prepare('UPDATE users SET guide_seen = 1, updated_at = ? WHERE id = ?').bind(now(), userId).run();
    return { ok: true };
  } catch { return { ok: false }; }
}

export async function adminDeleteUser(env, email) {
  const u = await getUserByEmail(env, email);
  if (!u) throw new Error('User tidak ditemukan');
  // Hapus HANYA baris user. Data turunan (subscriptions, account_ips, dst)
  // sengaja DIBIARKAN sesuai permintaan (mis. untuk arsip/jejak).
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
