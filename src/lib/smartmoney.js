// ─────────────────────────────────────────────────────────────────────────
// smartmoney.js — API data Smart Money (KHUSUS ADMIN, dipanggil dari admin.js
// setelah requireAdmin lolos).
//
// Sumber data: bucket R2 private `smartmoney` (binding SMARTMONEY di
// wrangler.toml). Diisi dari laptop oleh upload_smartmoney.py (repo scraper).
// Struktur bucket:
//   index.json          → { updated, codes: [...] }  daftar saham yang punya data
//   broker/{KODE}.json  → data broker harian per saham
//   insider/{KODE}.json → transaksi orang dalam per saham
//   holder/{KODE}.json  → kepemilikan (pemegang >1%, komposisi KSEI, jumlah pemegang, profil)
//   screener/summary.json → ringkasan semua saham untuk Screener (scripts/build-smartmoney-screener.js)
//
// Terpisah dari D1 (user/billing) dan dari repo GitHub: kalau bucket kosong
// atau error, hanya menu Smart Money yang terdampak (frontend jatuh ke data
// dummy). FAIL-OPEN: error R2 → { ok: true, ..., null } bukan 500.
// ─────────────────────────────────────────────────────────────────────────
import { json, badRequest } from './util.js';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

async function readJson(env, key) {
  try {
    const obj = await env.SMARTMONEY.get(key);
    if (!obj) return null;
    return await obj.json();
  } catch (e) {
    console.warn('[smartmoney] gagal baca', key, e && e.message);
    return null;
  }
}

export async function handleSmartMoneyApi(request, env, url) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!env.SMARTMONEY) return json({ ok: false, error: 'r2_not_bound' }, 200, NO_STORE);

  if (url.pathname === '/api/admin/smartmoney/index') {
    const idx = await readJson(env, 'index.json');
    return json({ ok: true, index: idx }, 200, NO_STORE);
  }

  // Ringkasan seluruh pasar untuk menu Screener (dibuat scripts/build-smartmoney-screener.js).
  // Dikirim apa adanya (stream) supaya Worker tidak mem-parse file besar.
  if (url.pathname === '/api/admin/smartmoney/screener') {
    try {
      const obj = await env.SMARTMONEY.get('screener/summary.json');
      if (!obj) return json({ ok: true, summary: null }, 200, NO_STORE);
      return new Response(obj.body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE } });
    } catch (e) {
      console.warn('[smartmoney] gagal baca screener/summary.json', e && e.message);
      return json({ ok: true, summary: null }, 200, NO_STORE);
    }
  }

  const code = String(url.searchParams.get('code') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(code)) return badRequest('Kode saham tidak valid');
  const [broker, insider, holder] = await Promise.all([
    readJson(env, `broker/${code}.json`),
    readJson(env, `insider/${code}.json`),
    readJson(env, `holder/${code}.json`),
  ]);
  return json({ ok: true, code, broker, insider, holder }, 200, NO_STORE);
}
