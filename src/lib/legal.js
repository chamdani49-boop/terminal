// ─────────────────────────────────────────────────────────────────────────
// legal.js — pencatatan persetujuan Ketentuan & Kebijakan Privasi (consent).
//
// Persetujuan dicatat di D1 (tabel `consents`) sebagai BUKTI: siapa, versi
// berapa, kapan, dari IP mana. Kalau dokumen diperbarui, naikkan TOS_VERSION →
// user otomatis diminta menyetujui ulang.
//
// FAIL-OPEN: kalau D1 error, anggap sudah setuju (jangan kunci/ganggu user).
// ─────────────────────────────────────────────────────────────────────────
import { now } from './util.js';

// Naikkan angka ini setiap kali isi Ketentuan/Privasi berubah signifikan.
export const TOS_VERSION = 1;

// Persetujuan berlaku 30 hari. Setelah lewat, user diminta menyetujui ulang
// (pop up muncul lagi). Satuan: detik, sama seperti now().
export const CONSENT_MAX_AGE_SEC = 30 * 24 * 60 * 60;

let _tableReady = false;
async function ensureTable(env) {
  if (_tableReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS consents ('
    + 'user_id TEXT PRIMARY KEY, version INTEGER, accepted_at INTEGER, ip TEXT)'
  ).run();
  _tableReady = true;
}

/** Ambil baris consent user (null bila belum ada / error). */
async function getConsent(env, userId) {
  if (!env.DB || !userId) return null;
  try {
    await ensureTable(env);
    return await env.DB.prepare(
      'SELECT version, accepted_at FROM consents WHERE user_id = ?'
    ).bind(userId).first();
  } catch (_) { return null; }
}

/** Versi yang sudah disetujui user (0 bila belum ada). */
export async function getConsentVersion(env, userId) {
  if (!env.DB || !userId) return 0;
  const row = await getConsent(env, userId);
  return (row && row.version) || 0;
}

/**
 * Apakah user sudah menyetujui versi terbaru DAN persetujuannya belum
 * kedaluwarsa (>30 hari). FAIL-OPEN saat error.
 *
 * Pop up hanya muncul:
 *  - saat awal pendaftaran/login (belum pernah setuju), atau
 *  - kalau versi dokumen naik, atau
 *  - kalau persetujuan terakhir sudah lebih dari 30 hari.
 */
export async function hasAcceptedCurrent(env, userId) {
  if (!env.DB || !userId) return true;   // tanpa DB → jangan ganggu
  try {
    const row = await getConsent(env, userId);
    if (!row || (row.version || 0) < TOS_VERSION) return false;
    const acceptedAt = row.accepted_at || 0;
    if (acceptedAt && (now() - acceptedAt) > CONSENT_MAX_AGE_SEC) return false;
    return true;
  } catch (_) { return true; }
}

/** Catat persetujuan versi terbaru. */
export async function saveConsent(env, userId, ip) {
  if (!env.DB || !userId) return { ok: false };
  await ensureTable(env);
  await env.DB.prepare(
    'INSERT INTO consents (user_id, version, accepted_at, ip) VALUES (?, ?, ?, ?) '
    + 'ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, '
    + 'accepted_at = excluded.accepted_at, ip = excluded.ip'
  ).bind(userId, TOS_VERSION, now(), ip || null).run();
  return { ok: true, version: TOS_VERSION };
}
