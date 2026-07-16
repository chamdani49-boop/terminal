// ─────────────────────────────────────────────────────────────────────────
// admin.js — API pengelolaan user (dibatasi ADMIN_EMAILS)
// ─────────────────────────────────────────────────────────────────────────
import { json, badRequest, forbidden, unauthorized } from './util.js';
import { getSession } from './session.js';
import {
  listUsersWithSub, adminExtendDays, adminSetDays, adminSetStatus, adminDeleteUser, adminEditUser,
  getFeatureFlags, setFeatureFlags, listReferralsGrouped,
} from './db.js';
import { getBillingConfig, saveBillingConfig } from './billing.js';
import { recentFlags, flagSummary, sendTelegram, deviceSummary, autosuspendEnabled } from './abuse.js';

export function isAdmin(env, email) {
  if (!email) return false;
  const list = (env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

export async function requireAdmin(request, env) {
  const session = await getSession(request, env);
  if (!session) return { error: unauthorized('Belum login') };
  if (!isAdmin(env, session.email)) return { error: forbidden('Bukan admin') };
  return { session };
}

export async function handleAdminApi(request, env, url) {
  const { error, session } = await requireAdmin(request, env);
  if (error) return error;

  const path = url.pathname;

  if (path === '/api/admin/users' && request.method === 'GET') {
    const users = await listUsersWithSub(env);
    return json({ ok: true, users, admin: session.email });
  }

  // Rekap referral (read-only): dikelompokkan per pengajak → panel admin.
  if (path === '/api/admin/referrals' && request.method === 'GET') {
    const referrals = await listReferralsGrouped(env);
    return json({ ok: true, referrals });
  }

  if (path === '/api/admin/usage' && request.method === 'GET') {
    return adminUsage(env);
  }

  // ── Anti-abuse: flag aktivitas mencurigakan (review manual admin) ──
  if (path === '/api/admin/abuse' && request.method === 'GET') {
    const [flags, summary, devices] = await Promise.all([
      recentFlags(env, { limit: 100 }),
      flagSummary(env, { hours: 24, limit: 20 }),
      deviceSummary(env, { hours: 24, limit: 20 }),
    ]);
    const telegram_configured = !!((env.TELEGRAM_BOT_TOKEN || '').trim() && (env.TELEGRAM_CHAT_ID || '').trim());
    return json({ ok: true, flags, summary, devices, telegram_configured, autosuspend: autosuspendEnabled(env) });
  }

  // ── Anti-abuse: kirim pesan test ke Telegram (verifikasi setup) ──
  if (path === '/api/admin/abuse/test-telegram' && request.method === 'POST') {
    const r = await sendTelegram(env, '✅ <b>Test notifikasi Economstock Terminal</b>\nKalau kamu menerima pesan ini, notifikasi Telegram sudah aktif. 🎉');
    if (r.ok) return json({ ok: true, message: 'Pesan test terkirim. Cek Telegram-mu.' });
    if (r.skipped) return json({ error: r.reason || 'Telegram belum dikonfigurasi.' }, 400);
    return json({ error: 'Gagal kirim: ' + (r.error || 'unknown') }, 400);
  }

  // ── Billing: baca config lengkap (termasuk link Mayar) untuk editor ──
  if (path === '/api/admin/billing' && request.method === 'GET') {
    const cfg = await getBillingConfig(env);
    return json({ ok: true, config: cfg });
  }

  // ── Billing: simpan config ──
  if (path === '/api/admin/billing' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return badRequest('Body tidak valid'); }
    try {
      const saved = await saveBillingConfig(env, body.config || body);
      return json({ ok: true, config: saved });
    } catch (e) {
      return json({ error: e.message || 'Gagal menyimpan' }, 400);
    }
  }

  // ── Feature flags: baca status toggle (trial & ajak teman) ──
  if (path === '/api/admin/features' && request.method === 'GET') {
    const features = await getFeatureFlags(env);
    return json({ ok: true, features });
  }

  // ── Feature flags: simpan toggle ──
  if (path === '/api/admin/features' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return badRequest('Body tidak valid'); }
    try {
      const features = await setFeatureFlags(env, body.features || body);
      return json({ ok: true, features });
    } catch (e) {
      return json({ error: e.message || 'Gagal menyimpan' }, 400);
    }
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return badRequest('Body tidak valid'); }
    const email = (body.email || '').trim().toLowerCase();
    if (!email) return badRequest('Email wajib diisi');
    if ((path === '/api/admin/users/delete' || path === '/api/admin/users/suspend') && isAdmin(env, email)) {
      return forbidden('Akun admin tidak bisa dihapus atau di-suspend');
    }

    try {
      if (path === '/api/admin/users/extend') {
        const days = parseInt(body.days || '0', 10);
        if (!days || days < 1) return badRequest('days harus > 0');
        // mode 'set' → setel masa aktif = sekarang + days (bisa MENGURANGI);
        // selain itu (default) → perpanjang/menambah dari kedaluwarsa saat ini.
        const sub = (body.mode === 'set')
          ? await adminSetDays(env, email, days, body.plan)
          : await adminExtendDays(env, email, days, body.plan);
        return json({ ok: true, sub });
      }
      if (path === '/api/admin/users/suspend') {
        const status = body.status === 'active' ? 'active' : 'suspended';
        await adminSetStatus(env, email, status);
        return json({ ok: true, status });
      }
      if (path === '/api/admin/users/edit') {
        await adminEditUser(env, email, (body.name || '').trim());
        return json({ ok: true });
      }
      if (path === '/api/admin/users/delete') {
        await adminDeleteUser(env, email);
        return json({ ok: true });
      }
    } catch (e) {
      return json({ error: e.message || 'Gagal' }, 400);
    }
  }

  return json({ error: 'Not found' }, 404);
}

// ─────────────────────────────────────────────────────────────────────────
// Usage / kuota Worker — dibaca dari Cloudflare GraphQL Analytics.
// Plan (free/paid) dideteksi OTOMATIS via subscriptions API; bisa di-override
// dengan variabel WORKERS_PLAN ("free"/"paid"). Limit menyesuaikan plan:
//   free  → 100.000 request / HARI
//   paid  → 10.000.000 request / BULAN
// Butuh: CF_API_TOKEN (secret, scope Account Analytics:Read) + CF_ACCOUNT_ID.
// ─────────────────────────────────────────────────────────────────────────
function usageLinks(acc) {
  const base = acc ? `https://dash.cloudflare.com/${acc}` : 'https://dash.cloudflare.com';
  return {
    metricsTerminal: `${base}/workers/services/view/terminal/production/metrics`,
    metricsLive: `${base}/workers/services/view/terminal-live/production/metrics`,
    plans: `${base}/workers/plans`,
  };
}

async function detectPaid(env) {
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/subscriptions`, {
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    });
    const d = await r.json();
    if (d && d.success && Array.isArray(d.result)) {
      return d.result.some((s) => {
        const blob = JSON.stringify(s || {}).toLowerCase();
        return blob.includes('workers') && blob.includes('paid');
      });
    }
  } catch (_) { /* abaikan → anggap free */ }
  return false;
}

async function adminUsage(env) {
  const token = env.CF_API_TOKEN;
  if (!token) return json({ ok: true, configured: false, links: usageLinks(env.CF_ACCOUNT_ID) });

  // Account ID: pakai env kalau ada; kalau tidak, deteksi otomatis dari token.
  // (Auto-detect bikin panel tetap jalan walau CF_ACCOUNT_ID terhapus saat deploy.)
  let acc = env.CF_ACCOUNT_ID;
  if (!acc) {
    try {
      const r = await fetch('https://api.cloudflare.com/client/v4/accounts', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (d && d.success && Array.isArray(d.result) && d.result[0]) acc = d.result[0].id;
    } catch (_) { /* abaikan */ }
  }
  const links = usageLinks(acc);
  if (!acc) return json({ ok: true, configured: false, links });

  const d0 = new Date();
  const todayStart = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)).toISOString();
  const query = `query U($acc:String!,$d:Time!,$m:Time!){viewer{accounts(filter:{accountTag:$acc}){`
    + `today:workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$d}){sum{requests}}`
    + `month:workersInvocationsAdaptive(limit:10000,filter:{datetime_geq:$m}){sum{requests}}`
    + `}}}`;

  let today = 0, month = 0, apiErr = null;
  try {
    const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { acc, d: todayStart, m: monthStart } }),
    });
    const d = await r.json();
    const a = d && d.data && d.data.viewer && d.data.viewer.accounts && d.data.viewer.accounts[0];
    if (a) {
      today = (a.today || []).reduce((s, n) => s + ((n.sum && n.sum.requests) || 0), 0);
      month = (a.month || []).reduce((s, n) => s + ((n.sum && n.sum.requests) || 0), 0);
    }
    if (d && d.errors && d.errors.length) apiErr = d.errors[0].message;
  } catch (e) { apiErr = e.message || String(e); }

  // Resolusi plan: env override → deteksi otomatis → default free.
  let plan = (env.WORKERS_PLAN || '').toLowerCase();
  if (plan !== 'free' && plan !== 'paid') plan = (await detectPaid(env)) ? 'paid' : 'free';

  const basis = plan === 'paid' ? 'month' : 'day';
  const limit = plan === 'paid' ? 10000000 : 100000;
  const used = basis === 'month' ? month : today;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;
  const status = pct >= 90 ? 'red' : (pct >= 70 ? 'yellow' : 'green');

  return json({ ok: true, configured: true, plan, today, month, used, limit, basis, pct, status, apiErr, links });
}
