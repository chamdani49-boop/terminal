// ─────────────────────────────────────────────────────────────────────────
// admin.js — API pengelolaan user (dibatasi ADMIN_EMAILS)
// ─────────────────────────────────────────────────────────────────────────
import { json, badRequest, forbidden, unauthorized } from './util.js';
import { getSession } from './session.js';
import {
  listUsersWithSub, adminExtendDays, adminSetStatus, adminDeleteUser, adminEditUser,
} from './db.js';

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

  if (path === '/api/admin/usage' && request.method === 'GET') {
    return adminUsage(env);
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return badRequest('Body tidak valid'); }
    const email = (body.email || '').trim().toLowerCase();
    if (!email) return badRequest('Email wajib diisi');

    try {
      if (path === '/api/admin/users/extend') {
        const days = parseInt(body.days || '0', 10);
        if (!days || days < 1) return badRequest('days harus > 0');
        const sub = await adminExtendDays(env, email, days, body.plan);
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
