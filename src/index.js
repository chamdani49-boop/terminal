// ═════════════════════════════════════════════════════════════════════════
// Economstock Terminal — Worker entry
//
// Worker HANYA dijalankan untuk /api/* (lihat wrangler.toml run_worker_first)
// plus route bersih tanpa file (/login, /billing, /admin, /dashboard).
// Semua aset lain (index.html, data.json, dst) dilayani langsung oleh
// Cloudflare Static Assets tanpa melewati kode ini.
//
// Feature flag GATING_ENABLED ("true"/"false"): saat "true", halaman & data
// terproteksi memerlukan langganan aktif. Untuk meng-gate file statis
// (data.json dll), tambahkan path-nya ke run_worker_first di wrangler.toml.
// ═════════════════════════════════════════════════════════════════════════
import { json, redirect, serverError, now, b64urlEncode, hmacSign } from './lib/util.js';
import { getSession, clearSessionCookieHeader } from './lib/session.js';
import { googleStart, googleCallback, emailRequest, emailVerify } from './lib/auth.js';
import { checkout, webhook } from './lib/mayar.js';
import { handleAdminApi } from './lib/admin.js';
import { getActiveSubscription } from './lib/db.js';

// Path yang butuh langganan aktif saat gating menyala
const PROTECTED_PREFIXES = ['/data.json', '/valuation.json', '/ohlc.json', '/macro.json', '/insights.json', '/headlines.json', '/dashboard'];

function assetFor(env, url, pathname, request) {
  const u = new URL(url.toString());
  u.pathname = pathname;
  return env.ASSETS.fetch(new Request(u.toString(), request));
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // ───────────── API ─────────────
      if (path.startsWith('/api/')) {
        return await handleApi(request, env, url);
      }

      // ──────── Route bersih (tanpa .html) ────────
      if (path === '/login') return assetFor(env, url, '/login.html', request);
      if (path === '/billing') return assetFor(env, url, '/billing.html', request);
      if (path === '/dashboard') return assetFor(env, url, '/index.html', request);
      if (path === '/admin') return assetFor(env, url, '/admin.html', request);

      // ──────── Gating (opsional, default OFF) ────────
      if (env.GATING_ENABLED === 'true' && isProtected(path)) {
        const ok = await hasActiveSub(request, env);
        if (!ok) {
          // navigasi halaman → redirect ke billing; request data → 402
          const accept = request.headers.get('Accept') || '';
          if (accept.includes('text/html')) return redirect('/billing', 302);
          return json({ error: 'Langganan tidak aktif' }, 402);
        }
      }

      // ──────── Cache privat untuk data JSON ter-gate ────────
      // Data ter-gate (data.json, valuation.json, dll) sebelumnya selalu
      // di-fetch ulang tanpa cache → dashboard & valuasi terasa lama saat
      // dibuka / saat pindah antar halaman. Tambah header cache PRIVAT
      // (per-browser, bukan CDN publik karena data berbayar) dengan
      // stale-while-revalidate: browser boleh memakai salinan lokal dulu
      // (muncul instan) sambil revalidasi versi baru di latar belakang.
      if (isProtected(path) && path.endsWith('.json')) {
        const assetRes = await env.ASSETS.fetch(request);
        const r = new Response(assetRes.body, assetRes);
        r.headers.set('Cache-Control', 'private, max-age=60, stale-while-revalidate=600');
        return r;
      }

      // default: serahkan ke static assets
      return env.ASSETS.fetch(request);
    } catch (e) {
      return serverError(e && e.message ? e.message : 'error');
    }
  },
};

function isProtected(path) {
  return PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(p));
}

async function hasActiveSub(request, env) {
  const session = await getSession(request, env);
  if (!session) return false;
  // Admin selalu boleh (untuk pengelolaan & pengujian, walau tanpa langganan).
  const admins = (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (admins.includes((session.email || '').toLowerCase())) return true;
  try {
    const sub = await getActiveSubscription(env, session.uid);
    return !!sub;
  } catch { return false; }
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // ── Auth ──
  if (path === '/api/auth/google' && method === 'GET') return googleStart(request, env, url);
  if (path === '/api/auth/google/callback' && method === 'GET') return googleCallback(request, env, url);
  if (path === '/api/auth/email/request' && method === 'POST') return emailRequest(request, env);
  if (path === '/api/auth/email/verify' && method === 'POST') return emailVerify(request, env);
  if (path === '/api/auth/logout') {
    return redirect('/', 302, { 'Set-Cookie': clearSessionCookieHeader() });
  }

  // ── Profil & status langganan ──
  if (path === '/api/me' && method === 'GET') {
    const session = await getSession(request, env);
    if (!session) return json({ authenticated: false });
    let sub = null;
    try {
      const s = await getActiveSubscription(env, session.uid);
      if (s) sub = { plan: s.plan, status: s.status, expires_at: s.expires_at, active: s.expires_at > now() };
    } catch { /* D1 belum siap */ }
    const admins = (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    return json({
      authenticated: true,
      email: session.email,
      name: session.name || null,
      is_admin: admins.includes((session.email || '').toLowerCase()),
      subscription: sub,
    });
  }

  // ── Token akses feed live (Worker terminal-live, lintas-domain) ──
  // Hanya diberikan ke user dengan langganan aktif (atau admin). Token HMAC
  // singkat (15 mnt) yang diverifikasi Worker terminal-live tanpa perlu D1.
  if (path === '/api/live-token' && method === 'GET') {
    const session = await getSession(request, env);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    const admins = (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const isAdmin = admins.includes((session.email || '').toLowerCase());
    let allowed = isAdmin;
    if (!allowed) {
      try { allowed = !!(await getActiveSubscription(env, session.uid)); } catch { allowed = false; }
    }
    if (!allowed) return json({ error: 'no_sub' }, 402);
    const secret = env.LIVE_TOKEN_SECRET;
    if (!secret) return json({ error: 'LIVE_TOKEN_SECRET belum di-set di Worker terminal' }, 500);
    const exp = now() + 900; // 15 menit
    const payloadB64 = b64urlEncode(JSON.stringify({ scope: 'live', exp }));
    const sig = await hmacSign(secret, payloadB64);
    return json({ token: `${payloadB64}.${sig}`, exp });
  }

  // ── Checkout & webhook Mayar ──
  if (path === '/api/checkout' && method === 'GET') return checkout(request, env, url);
  if (path === '/api/webhook/mayar' && method === 'POST') return webhook(request, env);

  // ── Admin ──
  if (path.startsWith('/api/admin/')) return handleAdminApi(request, env, url);

  return json({ error: 'Not found' }, 404);
}
