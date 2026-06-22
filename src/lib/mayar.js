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

// Map plan -> jumlah hari (dari vars)
function planDays(env, plan) {
  if (plan === 'tahunan') return parseInt(env.PLAN_DAYS_TAHUNAN || '365', 10);
  if (plan === '3bulan') return parseInt(env.PLAN_DAYS_3BULAN || '90', 10);
  return parseInt(env.PLAN_DAYS_6BULAN || '182', 10);
}

// ── CHECKOUT: arahkan user ke halaman bayar Mayar ──
export async function checkout(request, env, url) {
  const plan = url.searchParams.get('plan');
  if (!['3bulan', '6bulan', 'tahunan'].includes(plan)) return json({ error: 'Paket tidak valid' }, 400);

  const link = plan === 'tahunan' ? env.MAYAR_LINK_TAHUNAN
    : plan === '3bulan' ? env.MAYAR_LINK_3BULAN
      : env.MAYAR_LINK_6BULAN;
  if (!link) {
    return json({ error: 'Pembayaran belum dikonfigurasi untuk paket ini.' }, 503);
  }

  // Sertakan email user (kalau sudah login) agar checkout terhubung ke akun.
  const session = await getSession(request, env);
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
  else if (amount >= 1500000) plan = 'tahunan';
  else if (amount >= 850000) plan = '6bulan';
  else if (amount >= 400000) plan = '3bulan';

  if (!plan) return json({ error: `Paket tidak dikenali (product=${productId}, amount=${amount})` }, 400);

  // 5) Aktifkan langganan
  const user = await ensureUser(env, email);
  await activateSubscription(env, user.id, plan, planDays(env, plan), 'mayar', txnId);

  return json({ ok: true, activated: { email, plan } });
}
