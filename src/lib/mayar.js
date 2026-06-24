// ─────────────────────────────────────────────────────────────────────────
// mayar.js — checkout (redirect ke payment link) + webhook aktivasi langganan
//
// CATATAN: bentuk payload webhook Mayar bisa berbeda antar versi. Parser di
// bawah dibuat fleksibel (mencoba beberapa nama field umum). Setelah webhook
// pertama masuk, cek log & sesuaikan pemetaan bila perlu (lihat docs/AUTH_SETUP.md).
// ─────────────────────────────────────────────────────────────────────────
import { json, now } from './util.js';
import { getSession } from './session.js';
import { ensureUser, activateSubscription, txnAlreadyProcessed } from './db.js';
import { getBillingConfig } from './billing.js';

// ── Ingatan invoice TERMINAL (D1) — untuk pemisahan 100% akurat dari GAS ──
// Terminal mencatat ID invoice yang IA buat. Webhook hanya mengaktifkan langganan
// untuk invoice yang tercatat di sini → invoice GAS (ID beda) tidak akan pernah cocok,
// tanpa bergantung pada nominal harga.
async function ensureInvoiceTable(env) {
  if (!env.DB) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS mayar_invoices (invoice_id TEXT PRIMARY KEY, plan TEXT, email TEXT, amount INTEGER, created_at INTEGER)'
  ).run();
}
async function rememberInvoice(env, { invoiceId, plan, email, amount }) {
  if (!env.DB || !invoiceId) return;
  try {
    await ensureInvoiceTable(env);
    await env.DB.prepare(
      'INSERT INTO mayar_invoices (invoice_id, plan, email, amount, created_at) VALUES (?,?,?,?,?) '
      + 'ON CONFLICT(invoice_id) DO UPDATE SET plan=excluded.plan, email=excluded.email, amount=excluded.amount'
    ).bind(String(invoiceId), plan, email || '', amount || 0, now()).run();
  } catch (_) { /* jangan ganggu alur utama */ }
}
async function lookupInvoicePlan(env, ids) {
  if (!env.DB || !Array.isArray(ids)) return null;
  try {
    await ensureInvoiceTable(env);
    for (const id of ids) {
      if (!id) continue;
      const row = await env.DB.prepare('SELECT plan FROM mayar_invoices WHERE invoice_id = ?')
        .bind(String(id)).first();
      if (row && row.plan) return row.plan;
    }
  } catch (_) { /* abaikan */ }
  return null;
}

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
      const { link, invId } = await createMayarInvoice(env, {
        plan, amount, planName,
        email: session.email,
        name: session.name || '',
        redirectUrl,
      });
      // Ingat invoice ini sebagai milik TERMINAL (untuk pemisahan akurat di webhook).
      await rememberInvoice(env, { invoiceId: invId, plan, email: session.email, amount });
      return json({ ok: true, url: link });
    } catch (e) {
      // Invoice gagal (API key salah / Mayar down / format beda) → JANGAN
      // menggagalkan checkout. Lanjut ke fallback payment link statis di bawah
      // supaya user tetap bisa bayar. (Sesuai permintaan: invoice, fallback statis.)
      console.warn('[mayar] invoice gagal, fallback ke link statis:', (e && e.message) || e);
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

// ── Teruskan webhook mentah ke sistem lain (mis. Google Apps Script) ──
// Mayar cuma punya 1 slot webhook. Supaya GAS (sistem lama) TETAP dapat notif,
// website ini jadi penerima utama lalu MENERUSKAN salinan payload ke GAS.
// Set env GAS_WEBHOOK_URL = URL .../exec milik GAS. Token diteruskan apa adanya
// (atau pakai GAS_WEBHOOK_TOKEN bila GAS minta token tertentu).
async function forwardToGas(env, raw, request) {
  const gasUrl = env.GAS_WEBHOOK_URL;
  if (!gasUrl) return;
  const tok = env.GAS_WEBHOOK_TOKEN
    || request.headers.get('x-callback-token')
    || request.headers.get('x-webhook-token')
    || '';
  try {
    await fetch(gasUrl, {
      method: 'POST',
      headers: {
        'Content-Type': request.headers.get('content-type') || 'application/json',
        'x-callback-token': tok,
        'x-webhook-token': tok,
      },
      body: raw,
    });
  } catch (e) {
    console.warn('[mayar] forward webhook ke GAS gagal:', (e && e.message) || e);
  }
}

// ── Deteksi paket TERMINAL dari payload (pemisahan dari produk GAS/research) ──
// Prioritas: Product ID terminal (kalau di-set di env) → lalu cocokkan NOMINAL
// dengan harga paket terminal pada RENTANG SEMPIT [0.9x .. 1.5x]. Karena harga
// terminal (mis. 699rb+) jauh di atas produk GAS (10rb–79rb), produk GAS / produk
// lain TIDAK akan pernah cocok → tidak mengaktifkan langganan terminal.
async function detectTerminalPlan(env, { productId, amount, invoiceIds }) {
  // 0) PALING PASTI: invoice yang DIBUAT terminal sendiri (tak bergantung harga).
  const byInvoice = await lookupInvoicePlan(env, invoiceIds || []);
  if (byInvoice) return byInvoice;

  // 1) Product ID terminal (untuk payment link statis / fallback, kalau di-set).
  if (productId != null && productId !== '') {
    if (env.MAYAR_PRODUCT_TAHUNAN && productId == env.MAYAR_PRODUCT_TAHUNAN) return 'tahunan';
    if (env.MAYAR_PRODUCT_6BULAN && productId == env.MAYAR_PRODUCT_6BULAN) return '6bulan';
    if (env.MAYAR_PRODUCT_3BULAN && productId == env.MAYAR_PRODUCT_3BULAN) return '3bulan';
  }
  // 2) Jaring pengaman: cocokkan NOMINAL dgn harga paket terminal [0.9x..1.5x].
  const amt = parseInt(amount, 10) || 0;
  if (amt > 0) {
    try {
      const cfg = await getBillingConfig(env);
      for (const k of ['tahunan', '6bulan', '3bulan']) {
        const price = (cfg.plans[k] && cfg.plans[k].priceReal) || 0;
        if (price > 0 && amt >= Math.round(price * 0.9) && amt <= Math.round(price * 1.5)) return k;
      }
    } catch (_) { /* abaikan */ }
  }
  return null;
}

// ── WEBHOOK ──
export async function webhook(request, env, ctx) {
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

  // 1b) Catatan: forward ke GAS dipindah ke BAWAH — hanya untuk pembayaran yang
  //     BUKAN milik terminal (lihat langkah 4), supaya terminal tak bocor ke GAS.

  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'Bad JSON' }, 400); }

  // 2) Normalisasi data (bentuk payload bisa { event, data: {...} } atau flat)
  const data = payload.data || payload;
  const event = (payload.event || payload.type || data.status || '').toString().toLowerCase();

  // 2b) Event tes dari tombol "Test URL" Mayar → balas 200 OK tanpa aktivasi.
  if (event === 'testing' || event === 'test') {
    return json({ ok: true, test: true });
  }

  const status = (pick(data, ['status', 'paymentStatus', 'transactionStatus']) || event || '').toString().toLowerCase();
  const isPaid = ['paid', 'success', 'settled', 'capture', 'completed', 'payment.received', 'paymentreceived'].some((s) => status.includes(s) || event.includes(s));

  const email = pick(data, ['customerEmail', 'customer_email', 'email', 'buyerEmail']);
  const txnId = pick(data, ['id', 'transactionId', 'transaction_id', 'paymentId', 'invoiceId']);
  const productId = pick(data, ['productId', 'product_id', 'productLinkId', 'link_id']);
  const amount = parseInt(pick(data, ['amount', 'total', 'grossAmount']) || '0', 10);

  // 3) Apakah pembayaran ini milik TERMINAL? (invoice buatan terminal / produk / harga)
  const invoiceIds = [
    pick(data, ['invoiceId', 'invoice_id']),
    pick(data, ['id', 'transactionId', 'transaction_id', 'paymentId']),
  ];
  const plan = await detectTerminalPlan(env, { productId, amount, invoiceIds });
  const isTerminalPayment = !!plan;

  // 4) Forward ke GAS HANYA bila BUKAN pembayaran terminal (produk GAS/research,
  //    atau produk lain). Jalan di latar belakang (non-blocking).
  if (env.GAS_WEBHOOK_URL && !isTerminalPayment) {
    const fwd = forwardToGas(env, raw, request);
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(fwd);
    else fwd.catch(() => {});
  }

  // 5) Bukan pembayaran terminal → selesai (tidak mengaktifkan langganan terminal).
  if (!isTerminalPayment) {
    return json({ ok: true, skipped: true, reason: `bukan produk terminal (product=${productId}, amount=${amount})` });
  }

  // 6) Pembayaran terminal: aktifkan langganan (hanya bila benar-benar lunas).
  if (!isPaid) return json({ ok: true, skipped: true, reason: `status=${status}` });
  if (!email) return json({ error: 'Email tidak ditemukan di payload' }, 400);
  if (txnId && (await txnAlreadyProcessed(env, txnId))) return json({ ok: true, duplicate: true });

  const user = await ensureUser(env, email);
  await activateSubscription(env, user.id, plan, planDays(env, plan), 'mayar', txnId);

  return json({ ok: true, activated: { email, plan } });
}
