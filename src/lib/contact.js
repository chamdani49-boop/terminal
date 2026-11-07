// ─────────────────────────────────────────────────────────────────────────
// contact.js — nomor WhatsApp user (diminta di pop up Ketentuan Layanan).
//
// Disimpan di tabel terpisah `user_contacts` yang dibuat otomatis
// (CREATE TABLE IF NOT EXISTS) → tidak perlu menjalankan migrasi D1 manual.
// Format simpan: digit saja dengan kode negara, mis. "6281234567890".
// ─────────────────────────────────────────────────────────────────────────
import { now } from './util.js';

let _tableReady = false;
export async function ensureContactTable(env) {
  if (_tableReady || !env.DB) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS user_contacts ('
    + 'user_id TEXT PRIMARY KEY, whatsapp TEXT, updated_at INTEGER)'
  ).run();
  _tableReady = true;
}

/**
 * Normalisasi nomor WhatsApp → "62xxxxxxxxxx" (digit saja), atau null bila tidak valid.
 * Terima: 0812..., 812..., +62 812-..., 62812..., atau nomor internasional +<kode>...
 */
export function normalizeWhatsapp(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  let d = s.replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);            // 0062... → 62...
  else if (d.startsWith('0')) d = '62' + d.slice(1); // 0812... → 62812...
  else if (d.startsWith('8')) d = '62' + d;          // 812...  → 62812...
  if (d.startsWith('62')) {
    // Nomor HP Indonesia: 62 8xx, total 10–15 digit.
    if (!/^628\d{7,12}$/.test(d)) return null;
  } else if (!/^[1-9]\d{8,14}$/.test(d)) {
    return null;
  }
  return d;
}

/** Nomor WhatsApp user (null bila belum ada). Melempar error bila D1 bermasalah. */
export async function getWhatsapp(env, userId) {
  if (!env.DB || !userId) return null;
  await ensureContactTable(env);
  const row = await env.DB.prepare('SELECT whatsapp FROM user_contacts WHERE user_id = ?')
    .bind(userId).first();
  return (row && row.whatsapp) || null;
}

export async function saveWhatsapp(env, userId, wa) {
  if (!env.DB || !userId || !wa) return { ok: false };
  await ensureContactTable(env);
  await env.DB.prepare(
    'INSERT INTO user_contacts (user_id, whatsapp, updated_at) VALUES (?, ?, ?) '
    + 'ON CONFLICT(user_id) DO UPDATE SET whatsapp = excluded.whatsapp, updated_at = excluded.updated_at'
  ).bind(userId, wa, now()).run();
  return { ok: true };
}
