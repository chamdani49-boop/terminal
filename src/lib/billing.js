// ─────────────────────────────────────────────────────────────────────────
// billing.js — konfigurasi paket langganan (harga, teks card, link Mayar)
//
// Disimpan di D1 tabel `app_settings` (key = 'billing_config') sebagai JSON.
// Admin bisa mengedit lewat /api/admin/billing; halaman billing publik membaca
// lewat /api/billing-config. Persentase hemat & harga per-bulan TIDAK disimpan —
// selalu dihitung otomatis dari harga real & harga coret ("mesin" kita), supaya
// tidak pernah meleset dari harga di Mayar.
// ─────────────────────────────────────────────────────────────────────────
import { now } from './util.js';

export const PLAN_ORDER = ['3bulan', '6bulan', 'tahunan'];
export const PLAN_MONTHS = { '3bulan': 3, '6bulan': 6, 'tahunan': 12 };

// Default = nilai yang saat ini hard-coded di billing.html (supaya tampilan
// tidak berubah sebelum admin mengedit, & jadi fallback bila D1 belum siap).
export const DEFAULT_BILLING = {
  promoLabel: 'PALING HEMAT',
  featured: 'tahunan',
  plans: {
    '3bulan': {
      name: 'Paket Kuartal',
      dur: '3 Bulan',
      priceReal: 699000,
      priceCoret: 1000000,
      sub: 'Sekali bayar untuk 3 bulan penuh',
      features: [
        'Akses penuh seluruh fitur Economstock Terminal',
        'Valuasi & konsensus analis lengkap',
        'Insight & headline pasar',
      ],
      btnText: 'Langganan 3 Bulan',
      mayarLink: '',
    },
    '6bulan': {
      name: 'Paket Semester',
      dur: '6 Bulan',
      priceReal: 997000,
      priceCoret: 1500000,
      sub: 'Sekali bayar untuk 6 bulan penuh',
      features: [
        'Akses penuh seluruh fitur Economstock Terminal',
        'Valuasi & konsensus analis lengkap',
        'Insight & headline pasar',
      ],
      btnText: 'Langganan 6 Bulan',
      mayarLink: '',
    },
    'tahunan': {
      name: 'Paket Tahunan',
      dur: '12 Bulan',
      priceReal: 1750000,
      priceCoret: 2750000,
      sub: 'Sekali bayar untuk 1 tahun penuh',
      features: [
        'Akses penuh seluruh fitur Economstock Terminal',
        'Valuasi & konsensus analis lengkap',
        'Hemat lebih banyak dibanding paket pendek',
      ],
      btnText: 'Langganan Tahunan',
      mayarLink: '',
    },
  },
};

// ── Hitung otomatis (dipakai server & klien punya rumus sama) ──
export function discountPct(priceReal, priceCoret) {
  const r = Number(priceReal) || 0;
  const c = Number(priceCoret) || 0;
  if (c <= 0 || r >= c) return 0;
  return Math.round((1 - r / c) * 100);
}

export function monthlyPrice(plan, priceReal) {
  const m = PLAN_MONTHS[plan] || 1;
  return Math.round((Number(priceReal) || 0) / m);
}

// ── Validasi + merge dengan default (defensif terhadap input parsial) ──
export function mergeBilling(cfg) {
  const out = JSON.parse(JSON.stringify(DEFAULT_BILLING));
  if (!cfg || typeof cfg !== 'object') return out;
  if (typeof cfg.promoLabel === 'string') out.promoLabel = cfg.promoLabel.slice(0, 60);
  if (PLAN_ORDER.includes(cfg.featured)) out.featured = cfg.featured;
  for (const p of PLAN_ORDER) {
    const src = cfg.plans && cfg.plans[p];
    if (!src || typeof src !== 'object') continue;
    const dst = out.plans[p];
    if (typeof src.name === 'string') dst.name = src.name.slice(0, 80);
    if (typeof src.dur === 'string') dst.dur = src.dur.slice(0, 60);
    if (typeof src.sub === 'string') dst.sub = src.sub.slice(0, 160);
    if (typeof src.btnText === 'string') dst.btnText = src.btnText.slice(0, 60);
    if (typeof src.mayarLink === 'string') dst.mayarLink = src.mayarLink.trim().slice(0, 500);
    if (Number.isFinite(+src.priceReal)) dst.priceReal = Math.max(0, Math.round(+src.priceReal));
    if (Number.isFinite(+src.priceCoret)) dst.priceCoret = Math.max(0, Math.round(+src.priceCoret));
    if (Array.isArray(src.features)) {
      dst.features = src.features.slice(0, 6).map((f) => String(f || '').slice(0, 160)).filter((f) => f.length);
    }
  }
  return out;
}

async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)'
  ).run();
}

// Baca config; selalu kembalikan objek lengkap (default jika belum di-set / D1 mati).
export async function getBillingConfig(env) {
  if (!env.DB) return JSON.parse(JSON.stringify(DEFAULT_BILLING));
  try {
    await ensureTable(env);
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind('billing_config').first();
    if (row && row.value) return mergeBilling(JSON.parse(row.value));
  } catch (_) { /* fallback ke default */ }
  return JSON.parse(JSON.stringify(DEFAULT_BILLING));
}

// Simpan config (upsert). Mengembalikan config yang sudah di-merge & tersimpan.
export async function saveBillingConfig(env, cfg) {
  if (!env.DB) throw new Error('D1 (env.DB) belum di-binding');
  const merged = mergeBilling(cfg);
  await ensureTable(env);
  await env.DB.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind('billing_config', JSON.stringify(merged), now()).run();
  return merged;
}

// Versi publik (tanpa mayarLink mentah — checkout diproses server-side).
export function publicBilling(cfg) {
  const pub = { promoLabel: cfg.promoLabel, featured: cfg.featured, plans: {} };
  for (const p of PLAN_ORDER) {
    const s = cfg.plans[p];
    if (!s) continue;
    pub.plans[p] = {
      name: s.name, dur: s.dur, sub: s.sub, btnText: s.btnText,
      priceReal: s.priceReal, priceCoret: s.priceCoret,
      features: s.features,
      hasLink: !!(s.mayarLink && s.mayarLink.length),
    };
  }
  return pub;
}
