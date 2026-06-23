// ─────────────────────────────────────────────────────────────────────────
// mayar.js — checkout (redirect ke payment link) + webhook aktivasi langganan
//
// CATATAN: bentuk payload webhook Mayar bisa berbeda antar versi. Parser di
// bawah dibuat fleksibel (mencoba beberapa nama field umum). Setelah webhook
// pertama masuk, cek log & sesuaikan pemetaan bila perlu (lihat docs/AUTH_SETUP.md).
// ─────────────────────────────────────────────────────────────────────────
import { json } from './util.js';
import { getSession } from './session.js';
import { ensureUser, activateSubscription, txnAlreadyProcessed } from './db.js';
import { getBillingConfig } from './billing.js';

// Map plan -> jumlah hari (dari vars)
function planDays(env, plan) {
  if (plan === 'tahunan') return parseInt(env.PLAN_DAYS_TAHUNAN || '365', 10);
  if (plan === '3bulan') return parseInt(env.PLAN_DAYS_3BULAN || '90', 10);
  return parseInt(env.PLAN_DAYS_6BULAN || '182', 10);
}

// Base URL API headless Mayar. Bisa di-override lewat env (mis. untuk sandbox).
function mayarApiBase(env) {
  return (env.MAYAR_API_BASE || 'https://api.mayar.id/hl/v1').replace(/\/+$/, '');
}

// ── Buat invoice/tagihan via API Mayar (tanpa GAS) ──
// Mengembalikan { link } (URL halaman bayar) atau melempar error.
// Docs: POST {base}/invoice/create — body { name, email, mobile?, amount,
// description, redirectUrl, items[] }, balasan { data: { id, link, ... } }.
async function createMayarInvoice(env, { plan, amount, planName, email, name, redirectUrl }) {
  const apiKey = env.MAYAR_API_KEY;
  if (!apiKey) throw new Error('NO_API_KEY');

  const body = {
    name: name || email || 'Pelanggan Economstock',
    email,
    amount,                                  // total tagihan (Rupiah, tanpa desimal)
    description: `Langganan Economstock Terminal — ${planName} (${plan})`,
    redirectUrl,                             // tujuan setelah pembayaran sukses
    items: [
      { quantity: 1, rate: amount, description: planName },
    ],
  };
  // mobile opsional — sebagian akun Mayar mewajibkannya; isi bila tersedia.
  if (env.MAYAR_DEFAULT_MOBILE) body.mobile = env.MAYAR_DEFAULT_MOBILE;

  const res = await fetch(`${mayarApiBase(env)}/invoice/create`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });

  let out = {};
  try { out = await res.json(); } catch { /* biarkan kosong */ }
  if (!res.ok) {
    const msg = (out && (out.messages || out.message || out.error)) || `HTTP ${res.status}`;
    throw new Error(`Mayar API: ${msg}`);
  }

  // Bentuk balasan bisa { data: {...} } atau flat. Ambil link & id fleksibel.
  const d = (out && out.data) || out;
  const link = pick(d, ['link', 'url', 'paymentUrl', 'payment_url', 'checkoutUrl']);
  const invId = pick(d, ['id', 'transactionId', 'transaction_id', 'invoiceId']);
  if (!link) throw new Error('Mayar API: link pembayaran tidak ditemukan di respons');
  return { link, invId };
}

// ── CHECKOUT: buat tagihan Mayar (atau fallback link statis) lalu arahkan user ──
export async function checkout(request, env, url) {
  const plan = url.searchParams.get('plan');
  if (!['3bulan', '6bulan', 'tahunan'].includes(plan)) return json({ error: 'Paket tidak valid' }, 400);

  const session = await getSession(request, env);

  // ── MODE BARU: buat invoice via API Mayar (butuh MAYAR_API_KEY + user login) ──
  if (env.MAYAR_API_KEY) {
    if (!session || !session.email) {
      return json({ error: 'Silakan login dulu sebelum membuat tagihan.' }, 401);
    }
    // Ambil harga & nama paket dari billing config (sumber kebenaran harga).
    let amount = 0;
    let planName = plan;
    try {
      const cfg = await getBillingConfig(env);
      const p = cfg.plans[plan] || {};
      amount = Math.round(Number(p.priceReal) || 0);
      planName = p.name || plan;
    } catch (_) { /* fallback amount=0 → ditolak di bawah */ }

    if (!amount || amount < 1000) {
      return json({ error: 'Harga paket belum dikonfigurasi di panel admin.' }, 503);
    }

    // Tujuan setelah bayar: override via env, atau halaman billing situs ini.
    const redirectUrl = env.MAYAR_REDIRECT_URL || `${new URL(request.url).origin}/billing?paid=1`;

    try {
      const { link } = await createMayarInvoice(env, {
        plan, amount, planName,
        email: session.email,
        name: session.name || '',
        redirectUrl,
      });
      return json({ ok: true, url: link });
    } catch (e) {
      if ((e && e.message) !== 'NO_API_KEY') {
        return json({ error: `Gagal membuat tagihan: ${(e && e.message) || 'error'}` }, 502);
      }
      // NO_API_KEY tidak mungkin di cabang ini, tapi jaga-jaga → lanjut ke fallback.
    }
  }

  // ── MODE LAMA (fallback): redirect ke payment link statis ──
  // Prioritas link: direct link yang di-set admin (D1 billing config) → env var.
  let link = '';
  try {
    const cfg = await getBillingConfig(env);
    link = (cfg.plans[plan] && cfg.plans[plan].mayarLink) || '';
  } catch (_) { /* abaikan → fallback env */ }
  if (!link) {
    link = plan === 'tahunan' ? env.MAYAR_LINK_TAHUNAN
      : plan === '3bulan' ? env.MAYAR_LINK_3BULAN
        : env.MAYAR_LINK_6BULAN;
  }
  if (!link) {
    return json({ error: 'Pembayaran belum dikonfigurasi untuk paket ini.' }, 503);
  }

  // Sertakan email user (kalau sudah login) agar checkout terhubung ke akun.
  let target = link;
  if (session && session.email) {
    const sep = link.includes('?') ? '&' : '?';
    // Banyak payment link Mayar menerima prefill via query (mis. ?email=).
    target = `${link}${sep}email=${encodeURIComponent(session.email)}`;
  }
  return json({ ok: true, url: target });
}

// ── Ambil nilai pertama yang ada dari beberapa kemungkinan field ──
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

// ── WEBHOOK ──
export async function webhook(request, env) {
  const raw = await request.text();

  // 1) Verifikasi token (Mayar mengirim token webhook di header).
  const token = env.MAYAR_WEBHOOK_TOKEN;
  if (token) {
    const got =
      request.headers.get('x-callback-token') ||
      request.headers.get('x-webhook-token') ||
      (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
      '';
    if (got !== token) return json({ error: 'Invalid webhook token' }, 401);
  }

  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'Bad JSON' }, 400); }

  // 2) Normalisasi data (bentuk payload bisa { event, data: {...} } atau flat)
  const data = payload.data || payload;
  const event = (payload.event || payload.type || data.status || '').toString().toLowerCase();

  const status = (pick(data, ['status', 'paymentStatus', 'transactionStatus']) || event || '').toString().toLowerCase();
  const isPaid = ['paid', 'success', 'settled', 'capture', 'completed', 'payment.received', 'paymentreceived'].some((s) => status.includes(s) || event.includes(s));
  if (!isPaid) return json({ ok: true, skipped: true, reason: `status=${status}` });

  const email = pick(data, ['customerEmail', 'customer_email', 'email', 'buyerEmail']);
  const txnId = pick(data, ['id', 'transactionId', 'transaction_id', 'paymentId', 'invoiceId']);
  const productId = pick(data, ['productId', 'product_id', 'productLinkId', 'link_id']);
  const amount = parseInt(pick(data, ['amount', 'total', 'grossAmount']) || '0', 10);

  if (!email) return json({ error: 'Email tidak ditemukan di payload' }, 400);

  // 3) Idempotensi
  if (txnId && (await txnAlreadyProcessed(env, txnId))) {
    return json({ ok: true, duplicate: true });
  }

  // 4) Tentukan paket: berdasarkan product id, fallback ke nominal.
  let plan = null;
  if (productId && env.MAYAR_PRODUCT_TAHUNAN && productId == env.MAYAR_PRODUCT_TAHUNAN) plan = 'tahunan';
  else if (productId && env.MAYAR_PRODUCT_6BULAN && productId == env.MAYAR_PRODUCT_6BULAN) plan = '6bulan';
  else if (productId && env.MAYAR_PRODUCT_3BULAN && productId == env.MAYAR_PRODUCT_3BULAN) plan = '3bulan';

  // Fallback nominal: cocokkan dengan harga real di billing config (mengikuti
  // harga yang di-set admin), supaya tetap akurat saat harga diubah.
  if (!plan && amount > 0) {
    try {
      const cfg = await getBillingConfig(env);
      for (const k of ['tahunan', '6bulan', '3bulan']) {
        const price = (cfg.plans[k] && cfg.plans[k].priceReal) || 0;
        if (price > 0 && amount >= Math.round(price * 0.9)) { plan = k; break; }
      }
    } catch (_) { /* abaikan → fallback threshold statis */ }
  }
  if (!plan) {
    if (amount >= 1500000) plan = 'tahunan';
    else if (amount >= 850000) plan = '6bulan';
    else if (amount >= 400000) plan = '3bulan';
  }

  if (!plan) return json({ error: `Paket tidak dikenali (product=${productId}, amount=${amount})` }, 400);

  // 5) Aktifkan langganan
  const user = await ensureUser(env, email);
  await activateSubscription(env, user.id, plan, planDays(env, plan), 'mayar', txnId);

  return json({ ok: true, activated: { email, plan } });
}
