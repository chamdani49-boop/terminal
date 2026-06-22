// ─────────────────────────────────────────────────────────────────────────
// session.js — sesi login via cookie HTTP-only yang ditandatangani (HMAC).
// Token format: base64url(payloadJSON) + "." + HMAC(base64url(payload))
// Payload: { uid, email, name, exp }  (exp = epoch detik)
// ─────────────────────────────────────────────────────────────────────────
import {
  b64urlEncode, b64urlDecodeToString, hmacSign, hmacVerify,
  parseCookies, serializeCookie, now,
} from './util.js';

const COOKIE = 'es_session';
const DEFAULT_TTL = 60 * 60 * 24 * 30; // 30 hari

export async function createSessionToken(env, payload, ttl = DEFAULT_TTL) {
  const secret = env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET belum di-set');
  const body = { ...payload, exp: now() + ttl };
  const p = b64urlEncode(JSON.stringify(body));
  const sig = await hmacSign(secret, p);
  return `${p}.${sig}`;
}

export async function verifySessionToken(env, token) {
  const secret = env.SESSION_SECRET;
  if (!secret || !token || token.indexOf('.') < 0) return null;
  const [p, sig] = token.split('.');
  if (!p || !sig) return null;
  const ok = await hmacVerify(secret, p, sig);
  if (!ok) return null;
  let body;
  try { body = JSON.parse(b64urlDecodeToString(p)); } catch { return null; }
  if (!body || !body.exp || body.exp < now()) return null;
  return body;
}

export async function getSession(request, env) {
  const cookies = parseCookies(request);
  const token = cookies[COOKIE];
  if (!token) return null;
  return verifySessionToken(env, token);
}

export function sessionCookieHeader(token, ttl = DEFAULT_TTL) {
  return serializeCookie(COOKIE, token, { maxAge: ttl, httpOnly: true, secure: true, sameSite: 'Lax' });
}

export function clearSessionCookieHeader() {
  return serializeCookie(COOKIE, '', { maxAge: 0, httpOnly: true, secure: true, sameSite: 'Lax' });
}

// Cookie sementara untuk OAuth state / email pending (10 menit)
export function tempCookieHeader(name, value, ttl = 600) {
  return serializeCookie(name, value, { maxAge: ttl, httpOnly: true, secure: true, sameSite: 'Lax' });
}
