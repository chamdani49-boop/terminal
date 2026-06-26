// ─────────────────────────────────────────────────────────────────────────
// auth.js — Google OAuth (openid) + login kode email (passwordless)
// ─────────────────────────────────────────────────────────────────────────
import {
  json, redirect, badRequest, randomId, numericCode, sha256Hex, timingSafeEqual,
  parseCookies, now,
} from './util.js';
import { ensureUser, saveEmailCode, getEmailCode, incEmailAttempts, deleteEmailCode, grantTrialIfEligible } from './db.js';
import { createSessionToken, sessionCookieHeader, tempCookieHeader } from './session.js';

const OAUTH_STATE = 'es_oauth_state';

function appUrl(env) { return (env.APP_URL || '').replace(/\/$/, ''); }

// ── GOOGLE: mulai ──
export function googleStart(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: 'Google OAuth belum dikonfigurasi' }, 503);
  const state = randomId(16);
  const next = url.searchParams.get('next') || '/';
  const payload = `${state}|${next}`;
  const redirectUri = `${appUrl(env)}/api/auth/google/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  auth.searchParams.set('redirect_uri', redirectUri);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope', 'openid email profile');
  auth.searchParams.set('state', payload);
  auth.searchParams.set('access_type', 'online');
  auth.searchParams.set('prompt', 'select_account');
  return redirect(auth.toString(), 302, {
    'Set-Cookie': tempCookieHeader(OAUTH_STATE, state),
  });
}

// ── GOOGLE: callback ──
export async function googleCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state') || '';
  const [state, next = '/'] = stateParam.split('|');
  const cookies = parseCookies(request);
  if (!code || !state || cookies[OAUTH_STATE] !== state) {
    return redirect('/login?error=state', 302);
  }
  const redirectUri = `${appUrl(env)}/api/auth/google/callback`;
  // tukar code -> token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return redirect('/login?error=token', 302);
  const token = await tokenRes.json();
  // ambil profil
  const uiRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!uiRes.ok) return redirect('/login?error=userinfo', 302);
  const profile = await uiRes.json();
  if (!profile.email || !profile.email_verified) return redirect('/login?error=email', 302);

  const user = await ensureUser(env, profile.email, profile.name || null, profile.picture || null);
  // Trial 30 menit otomatis saat login bila memenuhi syarat (1x per user). Fail-open.
  try { await grantTrialIfEligible(env, user.id); } catch { /* jangan blokir login */ }
  const sessionToken = await createSessionToken(env, { uid: user.id, email: user.email, name: user.name });
  const safeNext = next.startsWith('/') ? next : '/';
  return redirect(safeNext, 302, { 'Set-Cookie': sessionCookieHeader(sessionToken) });
}

// ── EMAIL CODE: minta kode ──
export async function emailRequest(request, env) {
  let body;
  try { body = await request.json(); } catch { return badRequest('Body tidak valid'); }
  const email = (body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return badRequest('Email tidak valid');

  // rate-limit sederhana: kalau ada kode aktif < 60 detik lalu, tolak
  const existing = await getEmailCode(env, email);
  if (existing && existing.created_at > now() - 45) {
    return json({ error: 'Tunggu sebentar sebelum meminta kode lagi.' }, 429);
  }

  const code = numericCode(6);
  const codeHash = await sha256Hex(`${email}:${code}:${env.SESSION_SECRET || ''}`);
  await saveEmailCode(env, email, codeHash, 600); // 10 menit

  const sent = await sendEmail(
    env,
    email,
    'Kode masuk Economstock Terminal',
    `<div style="font-family:sans-serif;max-width:420px;margin:auto">
       <h2 style="color:#6d28d9">Economstock Terminal</h2>
       <p>Gunakan kode berikut untuk masuk. Berlaku 10 menit.</p>
       <p style="font-size:32px;font-weight:800;letter-spacing:8px;color:#1a0f3c">${code}</p>
       <p style="color:#888;font-size:12px">Jika kamu tidak meminta kode ini, abaikan email ini.</p>
     </div>`,
  );
  // Saat pengembangan tanpa provider email, kode dikembalikan agar bisa diuji.
  const devEcho = env.RESEND_API_KEY ? undefined : code;
  return json({ ok: true, sent, ...(devEcho ? { dev_code: devEcho } : {}) });
}

// ── EMAIL CODE: verifikasi ──
export async function emailVerify(request, env) {
  let body;
  try { body = await request.json(); } catch { return badRequest('Body tidak valid'); }
  const email = (body.email || '').trim().toLowerCase();
  const code = (body.code || '').trim();
  if (!email || !code) return badRequest('Email & kode wajib diisi');

  const row = await getEmailCode(env, email);
  if (!row) return json({ error: 'Kode tidak ditemukan, minta ulang.' }, 400);
  if (row.expires_at < now()) { await deleteEmailCode(env, email); return json({ error: 'Kode kedaluwarsa.' }, 400); }
  if (row.attempts >= 5) { await deleteEmailCode(env, email); return json({ error: 'Terlalu banyak percobaan. Minta kode baru.' }, 429); }

  const codeHash = await sha256Hex(`${email}:${code}:${env.SESSION_SECRET || ''}`);
  if (!timingSafeEqual(codeHash, row.code_hash)) {
    await incEmailAttempts(env, email);
    return json({ error: 'Kode salah.' }, 400);
  }
  await deleteEmailCode(env, email);
  const user = await ensureUser(env, email, null, null);
  // Trial 30 menit otomatis saat login bila memenuhi syarat (1x per user). Fail-open.
  try { await grantTrialIfEligible(env, user.id); } catch { /* jangan blokir login */ }
  const sessionToken = await createSessionToken(env, { uid: user.id, email: user.email, name: user.name });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(sessionToken) });
}

// ── Kirim email via Resend (kalau RESEND_API_KEY di-set) ──
export async function sendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) return false; // dev mode: lihat dev_code
  const from = env.EMAIL_FROM || 'Economstock Terminal <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  return res.ok;
}
