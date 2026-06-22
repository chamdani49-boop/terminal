// ─────────────────────────────────────────────────────────────────────────
// util.js — helper umum: response, cookie, base64url, HMAC (WebCrypto)
// ─────────────────────────────────────────────────────────────────────────

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

export function redirect(location, status = 302, headers = {}) {
  return new Response(null, { status, headers: { Location: location, ...headers } });
}

export function badRequest(msg) { return json({ error: msg }, 400); }
export function unauthorized(msg = 'Unauthorized') { return json({ error: msg }, 401); }
export function forbidden(msg = 'Forbidden') { return json({ error: msg }, 403); }
export function serverError(msg = 'Internal error') { return json({ error: msg }, 500); }

// ── ID acak (untuk user id, state, dll) ──
export function randomId(bytes = 16) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Kode numerik n-digit (untuk login kode email)
export function numericCode(digits = 6) {
  const max = 10 ** digits;
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % max).padStart(digits, '0');
}

// ── base64url ──
export function b64urlEncode(input) {
  let bytes;
  if (typeof input === 'string') bytes = new TextEncoder().encode(input);
  else bytes = new Uint8Array(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecodeToString(str) {
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ── HMAC-SHA256 ──
async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function hmacSign(secret, data) {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlEncode(sig);
}

export async function hmacVerify(secret, data, signatureB64url) {
  const expected = await hmacSign(secret, data);
  return timingSafeEqual(expected, signatureB64url);
}

// SHA-256 hex (untuk hash kode email, dll)
export async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Perbandingan waktu-konstan (anti timing attack)
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// ── Cookie ──
export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const p = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) p.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) p.push(`Expires=${opts.expires.toUTCString()}`);
  p.push(`Path=${opts.path || '/'}`);
  if (opts.domain) p.push(`Domain=${opts.domain}`);
  if (opts.httpOnly !== false) p.push('HttpOnly');
  if (opts.secure !== false) p.push('Secure');
  p.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return p.join('; ');
}

export function now() { return Math.floor(Date.now() / 1000); }
