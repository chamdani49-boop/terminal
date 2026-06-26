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
import { getActiveSubscription, getReferralInfo } from './lib/db.js';
import { getBillingConfig, publicBilling } from './lib/billing.js';
import { rateLimit, reportAbuse, trackDevice } from './lib/abuse.js';
import { TOS_VERSION, hasAcceptedCurrent, saveConsent } from './lib/legal.js';

// Path yang butuh langganan aktif saat gating menyala
const PROTECTED_PREFIXES = ['/data.json', '/valuation.json', '/valuation/', '/ohlc.json', '/macro.json', '/insights.json', '/headlines.json', '/dashboard'];

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
        return await handleApi(request, env, url, ctx);
      }

      // ──────── Route bersih (tanpa .html) ────────
      if (path === '/login') return assetFor(env, url, '/login.html', request);
      if (path === '/billing') return assetFor(env, url, '/billing.html', request);
      if (path === '/dashboard') return assetFor(env, url, '/index.html', request);
      if (path === '/admin') return assetFor(env, url, '/admin.html', request);

      // ──────── Gating + anti-abuse (opsional, default OFF) ────────
      if (env.GATING_ENABLED === 'true' && isProtected(path)) {
        const blocked = await guardProtected(request, env, ctx, path);
        if (blocked) return blocked;   // redirect billing / 402 / 429
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

function adminList(env) {
  return (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

/**
 * Penjaga endpoint ter-proteksi: cek langganan + rate limit anti-scraping.
 * @returns {Promise<Response|null>} Response bila harus diblokir, null bila boleh lanjut.
 *
 * Alur (sesuai flowchart):
 *   1. Cek sesi + langganan aktif → kalau tidak: redirect /billing (halaman) atau 402 (data).
 *   2. Rate limit per-user pada endpoint data .json (lawan scraping). Admin dikecualikan.
 *      Melebihi limit → 429 + catat flag untuk review admin. FAIL-OPEN bila D1 error.
 */
async function guardProtected(request, env, ctx, path) {
  const session = await getSession(request, env);
  const isAdmin = !!(session && adminList(env).includes((session.email || '').toLowerCase()));

  // 1) Langganan aktif?
  let allowed = isAdmin;
  if (session && !isAdmin) {
    try { allowed = !!(await getActiveSubscription(env, session.uid)); }
    catch { allowed = false; }
  }
  if (!allowed) {
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/html')) return redirect('/billing', 302);
    return json({ error: 'Langganan tidak aktif' }, 402);
  }

  // 2) Rate limit — hanya user non-admin & hanya endpoint DATA (.json) yang
  //    jadi target scraping. Halaman /dashboard (HTML) tidak dihitung.
  if (session && !isAdmin && path.endsWith('.json')) {
    const limitPerMin = parseInt(env.RATE_LIMIT_PER_MIN || '120', 10) || 120;
    const rl = await rateLimit(env, { identity: session.uid, limit: limitPerMin });
    if (!rl.ok) {
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const country = (request.cf && request.cf.country) || '';
      if (ctx && ctx.waitUntil) {
        ctx.waitUntil(reportAbuse(env, {
          userId: session.uid, email: session.email, ip, country,
          type: 'rate_limit', detail: `${rl.count} req/min > ${limitPerMin} (${path})`,
        }));
      }
      return json(
        { error: 'Terlalu banyak request. Coba lagi sebentar.' },
        429,
        { 'Retry-After': String(rl.retryAfter || 30) }
      );
    }
  }

  // 3) Fingerprint device/IP → deteksi akun dibagi. Cukup di /data.json
  //    (di-fetch tiap buka dashboard) supaya hemat write D1. Hanya FLAG +
  //    notif (tidak blokir). trackDevice sendiri fail-safe & throttled.
  if (session && !isAdmin && path === '/data.json' && ctx && ctx.waitUntil) {
    ctx.waitUntil(trackDevice(env, {
      userId: session.uid,
      email: session.email,
      ip: request.headers.get('CF-Connecting-IP') || '',
      country: (request.cf && request.cf.country) || '',
      ua: request.headers.get('User-Agent') || '',
    }));
  }
  return null;
}

async function hasActiveSub(request, env) {
  const session = await getSession(request, env);
  if (!session) return false;
  // Admin selalu boleh (untuk pengelolaan & pengujian, walau tanpa langganan).
  if (adminList(env).includes((session.email || '').toLowerCase())) return true;
  try {
    const sub = await getActiveSubscription(env, session.uid);
    return !!sub;
  } catch { return false; }
}

async function handleApi(request, env, url, ctx) {
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
    const admins = (env.ADMIN_EMAILS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const isAdminUser = admins.includes((session.email || '').toLowerCase());
    // Admin = akses PERMANEN, tidak punya masa aktif → tidak usah cek langganan.
    let sub = null;
    if (!isAdminUser) {
      try {
        const s = await getActiveSubscription(env, session.uid);
        if (s) sub = { plan: s.plan, status: s.status, expires_at: s.expires_at, active: s.expires_at > now() };
      } catch { /* D1 belum siap */ }
    }
    let tosAccepted = true;
    try { tosAccepted = await hasAcceptedCurrent(env, session.uid); } catch { tosAccepted = true; }
    return json({
      authenticated: true,
      email: session.email,
      name: session.name || null,
      is_admin: isAdminUser,
      permanent: isAdminUser,   // admin: permanen, tanpa masa aktif
      subscription: sub,
      tos_version: TOS_VERSION,
      tos_accepted: tosAccepted,
    });
  }

  // ── Referral: kode ajakan + statistik (N orang · M hari) ──
  if (path === '/api/referral' && method === 'GET') {
    const session = await getSession(request, env);
    if (!session) return json({ authenticated: false });
    try {
      const info = await getReferralInfo(env, session.uid);
      const base = (env.APP_URL || '').replace(/\/$/, '');
      const link = info && info.code ? `${base}/login?ref=${encodeURIComponent(info.code)}` : null;
      return json({
        authenticated: true,
        code: (info && info.code) || null,
        link,
        count: (info && info.count) || 0,
        days: (info && info.days) || 0,
      });
    } catch {
      // Migration belum jalan / D1 error → kembalikan kosong (UI sembunyikan).
      return json({ authenticated: true, code: null, link: null, count: 0, days: 0 });
    }
  }

  // ── Persetujuan Ketentuan & Privasi ──
  if (path === '/api/accept-terms' && method === 'POST') {
    const session = await getSession(request, env);
    if (!session) return json({ error: 'unauthenticated' }, 401);
    try {
      const ip = request.headers.get('CF-Connecting-IP') || '';
      const r = await saveConsent(env, session.uid, ip);
      return json({ ok: !!r.ok, version: TOS_VERSION });
    } catch (e) {
      return json({ error: (e && e.message) || 'gagal menyimpan persetujuan' }, 500);
    }
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
  if (path === '/api/webhook/mayar' && method === 'POST') return webhook(request, env, ctx);

  // ── Konfigurasi billing (publik, dibaca billing.html) ──
  if (path === '/api/billing-config' && method === 'GET') {
    const cfg = await getBillingConfig(env);
    return json(publicBilling(cfg), 200, { 'Cache-Control': 'public, max-age=30' });
  }

  // ── Admin ──
  if (path.startsWith('/api/admin/')) return handleAdminApi(request, env, url);

  return json({ error: 'Not found' }, 404);
}
