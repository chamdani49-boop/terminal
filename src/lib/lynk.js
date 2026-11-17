// ─────────────────────────────────────────────────────────────────────────
// lynk.js — pembayaran lewat Lynk.id: checkout (redirect ke halaman produk)
// + webhook transaksi sukses + antrean pencocokan manual untuk admin.
//
// ALUR
//   1. User login → klik bayar → /api/checkout → server mengembalikan link produk
//      Lynk + email akun. billing.html menampilkan email itu dan meminta user
//      memakainya saat mengisi data di Lynk.
//   2. Lynk memanggil POST /api/webhook/lynk?token=<LYNK_WEBHOOK_TOKEN> setelah bayar.
//   3. Webhook mencocokkan email pembeli ke akun Terminal:
//        - email cocok + nominal cocok 1 paket  → langganan aktif otomatis
//        - selain itu (email beda / nominal tak dikenal / data kurang)
//          → disimpan sebagai "pending" dan muncul di panel Admin untuk
//            dicocokkan manual. Tidak ada pembayaran yang hilang.
//
// KEAMANAN (dua lapis, keduanya dibandingkan waktu-konstan)
//   - Tanda tangan Lynk (disarankan): header X-Lynk-Signature =
//       sha256_hex(amount + refId + message_id + LYNK_MERCHANT_KEY)   (dokumen webhook Lynk)
//     Dokumen tidak menyebut field `amount` yang dipakai, jadi grandTotal maupun totalPrice diterima.
//   - Token URL: ?token=<LYNK_WEBHOOK_TOKEN> (atau header x-webhook-token / Authorization).
//   - Bila LYNK_MERCHANT_KEY di-set: tanda tangan WAJIB valid untuk aktivasi. Tanda tangan salah tapi
//     token URL benar → disimpan sebagai pending (terlihat di Admin), tidak diaktifkan.
//   - GAGAL TERTUTUP: tanpa LYNK_MERCHANT_KEY dan LYNK_WEBHOOK_TOKEN, semua panggilan ditolak.
//   - Satu transaksi hanya diproses sekali (kunci unik per ID transaksi).
//   - Modul ini TIDAK mengubah langganan yang sudah ada kecuali ada pembayaran baru
//     (perpanjangan = menambah durasi dari tanggal kedaluwarsa saat ini).
//
// CATATAN FORMAT: bentuk payload webhook Lynk belum terdokumentasi publik, jadi parser
// dibuat fleksibel (mencari beberapa nama field umum). Payload MENTAH setiap transaksi
// disimpan di tabel lynk_payments (terlihat di panel Admin) untuk menyesuaikan parser.
// ─────────────────────────────────────────────────────────────────────────
import { json, now, badRequest } from './util.js';
import { getSession } from './session.js';
import { getUserByEmail, ensureUser, activateSubscription, txnAlreadyProcessed } from './db.js';
import { getBillingConfig } from './billing.js';

const PLANS = ['1bulan', '3bulan', '6bulan', 'tahunan'];
const MAX_BODY = 100 * 1024;      // 100 KB — jauh di atas ukuran webhook normal

// ── Helper paket (salinan kecil dari mayar.js supaya modul ini mandiri) ──
function planDays(env, plan) {
  if (plan === 'tahunan') return parseInt(env.PLAN_DAYS_TAHUNAN || '365', 10);
  if (plan === '3bulan') return parseInt(env.PLAN_DAYS_3BULAN || '90', 10);
  if (plan === '1bulan') return parseInt(env.PLAN_DAYS_1BULAN || '30', 10);
  return parseInt(env.PLAN_DAYS_6BULAN || '182', 10);
}
// Paket '1bulan' = paket Tracker-only. Paket lain = akses penuh.
function planScope(plan) { return plan === '1bulan' ? 'tracker' : 'full'; }

// ── Tabel pembayaran Lynk (dibuat sekali, aman dipanggil berulang) ──
async function ensureTable(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS lynk_payments ('
    + 'id TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, email TEXT, name TEXT, '
    + 'amount INTEGER, plan TEXT, user_id TEXT, raw TEXT, created_at INTEGER, '
    + 'resolved_at INTEGER, resolved_by TEXT)'
  ).run();
}

// ── Util kecil ──
function timingSafeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b) return false;
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function isScalar(v) { return typeof v === 'string' || typeof v === 'number'; }

// Cari nilai pertama (paling dangkal) untuk nama field tertentu. `names` berurutan
// menurut prioritas: nama pertama yang ditemukan menang.
function deepFind(root, names) {
  for (const name of names) {
    const queue = [[root, 0]];
    while (queue.length) {
      const [node, depth] = queue.shift();
      if (!node || typeof node !== 'object' || depth > 5) continue;
      const entries = Array.isArray(node) ? node.map((v, i) => [String(i), v]) : Object.entries(node);
      for (const [k, v] of entries) {
        if (k.toLowerCase() === name && isScalar(v) && String(v).trim() !== '') return v;
      }
      for (const [, v] of entries) if (v && typeof v === 'object') queue.push([v, depth + 1]);
    }
  }
  return null;
}

// Objek "pembeli" bila ada (supaya email penjual tidak terambil).
function findCustomer(root) {
  for (const key of ['customer', 'buyer', 'pembeli', 'customer_data', 'customerdata', 'user']) {
    const queue = [[root, 0]];
    while (queue.length) {
      const [node, depth] = queue.shift();
      if (!node || typeof node !== 'object' || depth > 4) continue;
      for (const [k, v] of Object.entries(node)) {
        if (k.toLowerCase() === key && v && typeof v === 'object' && !Array.isArray(v)) return v;
      }
      for (const v of Object.values(node)) if (v && typeof v === 'object') queue.push([v, depth + 1]);
    }
  }
  return null;
}

// "149000", 149000, "Rp149.000", "149,000.00" → 149000
export function parseAmount(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : 0;
  let s = String(v).replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Math.round(parseFloat(s));
  return Number.isFinite(n) ? n : 0;
}

function emailOk(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s); }

// Ekstrak field penting dari payload (format apa pun yang masuk akal).
export function extractFields(payload) {
  const cust = findCustomer(payload);
  const emailRaw = (cust && deepFind(cust, ['email', 'customer_email', 'e-mail']))
    || deepFind(payload, ['customer_email', 'customeremail', 'buyer_email', 'buyeremail', 'email']);
  const nameRaw = (cust && deepFind(cust, ['name', 'full_name', 'fullname', 'customer_name']))
    || deepFind(payload, ['customer_name', 'customername', 'buyer_name', 'buyername']);
  const txn = deepFind(payload, ['order_id', 'orderid', 'ref_id', 'refid', 'transaction_id', 'transactionid',
    'invoice_id', 'invoiceid', 'invoice', 'message_id', 'messageid', 'payment_id', 'paymentid', 'id']);
  // Lynk: totals.totalPrice = harga produk (tanpa addon/ongkir). totals.grandTotal = uang BERSIH
  // yang diterima penjual setelah dipotong biaya → TIDAK cocok untuk mengenali paket.
  const amountRaw = deepFind(payload, ['totalprice', 'total_price', 'grand_total', 'grandtotal',
    'total_amount', 'totalamount', 'total', 'amount', 'subtotal', 'price']);
  const netRaw = deepFind(payload, ['grandtotal', 'grand_total']);
  // Lynk: data.message_action = "SUCCESS" untuk pembayaran berhasil.
  const status = deepFind(payload, ['message_action', 'payment_status', 'transaction_status', 'status']);
  const event = deepFind(payload, ['event', 'event_type', 'eventtype', 'type']);
  const title = deepFind(payload, ['product_title', 'producttitle', 'product_name', 'productname', 'item_name', 'title']);
  const email = emailRaw ? String(emailRaw).trim().toLowerCase() : '';
  return {
    email: emailOk(email) ? email : '',
    emailRaw: emailRaw ? String(emailRaw).trim().slice(0, 200) : '',
    name: nameRaw ? String(nameRaw).trim().slice(0, 120) : '',
    txn: txn != null ? String(txn).trim().slice(0, 120) : '',
    amount: parseAmount(amountRaw),
    net: parseAmount(netRaw),
    status: status != null ? String(status).toLowerCase().trim() : '',
    event: event != null ? String(event).toLowerCase().trim() : '',
    title: title != null ? String(title).slice(0, 200) : '',
  };
}

// Status/event yang JELAS bukan lunas → selalu ditolak.
const NOT_PAID_RX = /(created|pending|unpaid|waiting|await|expir|fail|cancel|void|refund|reminder|draft|requir|processing|initiat|reject|\bopen\b|test)/;
const PAID_RX = /(paid|success|settle|complete|capture|berhasil|lunas|payment|order|purchase)/;

// Paket dari judul produk (hanya pengecekan silang, bukan penentu utama).
function planFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return null;
  if (/tahun|12\s*bulan/.test(t)) return 'tahunan';
  if (/6\s*bulan|enam\s*bulan|semester/.test(t)) return '6bulan';
  if (/3\s*bulan|tiga\s*bulan|kuartal/.test(t)) return '3bulan';
  if (/1\s*bulan|satu\s*bulan|tracker/.test(t)) return '1bulan';
  return null;
}

// Paket dari nominal: harus cocok dengan TEPAT SATU paket pada rentang [0.9x .. 1.15x]
// harga (toleransi diskon kecil / biaya layanan yang ditanggung pembeli).
async function planFromAmount(env, amount) {
  if (!(amount > 0)) return { plan: null, why: 'nominal kosong' };
  let cfg;
  try { cfg = await getBillingConfig(env); } catch { return { plan: null, why: 'konfigurasi harga tak terbaca' }; }
  const hits = PLANS.filter((k) => {
    const price = (cfg.plans[k] && cfg.plans[k].priceReal) || 0;
    return price > 0 && amount >= Math.round(price * 0.9) && amount <= Math.round(price * 1.15);
  });
  if (hits.length === 1) return { plan: hits[0], why: '' };
  return { plan: null, why: hits.length ? 'nominal cocok lebih dari satu paket' : `nominal Rp${amount} tidak cocok paket mana pun` };
}

async function savePayment(env, row) {
  await env.DB.prepare(
    'INSERT INTO lynk_payments (id, status, reason, email, name, amount, plan, user_id, raw, created_at) '
    + 'VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).bind(row.id, row.status, row.reason || null, row.email || null, row.name || null,
    row.amount || 0, row.plan || null, row.user_id || null, row.raw || null, now()).run();
}

// ── Tanda tangan Lynk: sha256_hex(amount + refId + message_id + merchantKey) ──
function lynkSigParts(payload) {
  const d = (payload && payload.data) || {};
  const md = d.message_data || {};
  const tot = md.totals || {};
  const refId = md.refId != null ? String(md.refId) : (deepFind(payload, ['refid']) != null ? String(deepFind(payload, ['refid'])) : '');
  const msgId = d.message_id != null ? String(d.message_id) : (deepFind(payload, ['message_id']) != null ? String(deepFind(payload, ['message_id'])) : '');
  const amounts = [];
  for (const v of [tot.grandTotal, tot.totalPrice, deepFind(payload, ['grandtotal']), deepFind(payload, ['totalprice'])]) {
    if (v == null || v === '') continue;
    const sv = String(v);
    if (!amounts.includes(sv)) amounts.push(sv);
  }
  return { refId, msgId, amounts };
}
export async function verifyLynkSignature(payload, received, key) {
  received = String(received || '').trim().toLowerCase();
  if (!key || !received) return false;
  const { refId, msgId, amounts } = lynkSigParts(payload);
  if (!refId || !msgId || !amounts.length) return false;
  let ok = false;
  for (const amount of amounts) {
    const calc = await sha256Hex(amount + refId + msgId + key);
    if (timingSafeEqual(calc, received)) ok = true;   // tidak berhenti lebih awal (waktu tetap)
  }
  return ok;
}

// ── WEBHOOK ──
export async function webhook(request, env) {
  if (!env.DB) return json({ error: 'D1 belum di-binding' }, 503);

  // 1) Siapkan autentikasi (gagal tertutup)
  const secret = (env.LYNK_WEBHOOK_TOKEN || '').trim();
  const merchantKey = (env.LYNK_MERCHANT_KEY || '').trim();
  if (!secret && !merchantKey) return json({ error: 'Webhook Lynk belum dikonfigurasi (LYNK_MERCHANT_KEY / LYNK_WEBHOOK_TOKEN kosong)' }, 503);
  const url = new URL(request.url);
  const got = url.searchParams.get('token')
    || request.headers.get('x-webhook-token')
    || request.headers.get('x-callback-token')
    || (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const tokenOk = !!secret && timingSafeEqual(got, secret);
  // Tanpa Merchant Key, token URL wajib benar sebelum badan dibaca.
  if (!merchantKey && !tokenOk) return json({ error: 'Invalid webhook token' }, 401);

  // 2) Baca & parse badan (JSON, atau form-urlencoded sebagai cadangan)
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ error: 'Payload terlalu besar' }, 413);
  let payload;
  try { payload = JSON.parse(text); } catch { try { payload = JSON.parse(text.replace(/,\s*([}\]])/g, '$1')); } catch { payload = undefined; } }
  if (payload === undefined) {
    // Cadangan: form-urlencoded (a=b&c=d). Teks tanpa pola kunci=nilai ditolak.
    if (!/^[^=\s&]+=[^&]*(&[^=\s&]+=[^&]*)*$/.test(text.trim())) return badRequest('Payload bukan JSON');
    payload = Object.fromEntries(new URLSearchParams(text.trim()));
  }
  if (!payload || typeof payload !== 'object') return badRequest('Payload tidak valid');

  // 1b) Tanda tangan Lynk (bila Merchant Key di-set)
  let sigProblem = '';
  if (merchantKey) {
    const sigOk = await verifyLynkSignature(payload, request.headers.get('x-lynk-signature'), merchantKey);
    if (!sigOk) {
      if (!tokenOk) return json({ error: 'Invalid signature' }, 401);
      // Token URL benar tapi tanda tangan tidak cocok/tidak ada → simpan untuk diperiksa, jangan aktifkan.
      sigProblem = request.headers.get('x-lynk-signature') ? 'tanda tangan Lynk tidak cocok (cek LYNK_MERCHANT_KEY)' : 'header X-Lynk-Signature tidak ada';
    }
  }

  await ensureTable(env);
  const f = extractFields(payload);
  const raw = text.slice(0, 8000);
  // ID transaksi: dari payload; bila tak ada, pakai sidik jari payload (retry identik tetap terdeteksi).
  const id = f.txn ? `lynk:${f.txn}` : `lynk:h-${(await sha256Hex(text)).slice(0, 24)}`;

  // 3) Duplikat (Lynk bisa mengirim ulang) → jangan diproses lagi
  const dup = await env.DB.prepare('SELECT id, status FROM lynk_payments WHERE id = ?').bind(id).first();
  if (dup) return json({ ok: true, duplicate: true, status: dup.status });
  if (await txnAlreadyProcessed(env, id)) return json({ ok: true, duplicate: true });

  const base = { id, email: f.email || f.emailRaw, name: f.name, amount: f.amount, raw };
  if (sigProblem) {
    await savePayment(env, { ...base, status: 'pending', reason: sigProblem });
    return json({ ok: true, pending: true });
  }

  // 4) Bukan transaksi lunas? (status/event jelas gagal → abaikan; tak dikenal → pending)
  const signals = `${f.status} ${f.event}`.trim();
  console.log(`[lynk] webhook id=${id} status="${f.status}" event="${f.event}" amount=${f.amount} email=${f.email ? 'ok' : 'kosong'}`);
  if (signals && NOT_PAID_RX.test(signals)) {
    await savePayment(env, { ...base, status: 'ignored', reason: `status bukan lunas: ${signals}` });
    return json({ ok: true, skipped: true, reason: 'bukan transaksi lunas' });
  }
  if (signals && !PAID_RX.test(signals)) {
    await savePayment(env, { ...base, status: 'pending', reason: `status tidak dikenali: ${signals}` });
    return json({ ok: true, pending: true });
  }

  // 5) Data wajib
  if (!f.email) {
    await savePayment(env, { ...base, status: 'pending', reason: f.emailRaw ? `email tidak valid: ${f.emailRaw}` : 'email pembeli tidak ditemukan di payload' });
    return json({ ok: true, pending: true });
  }

  // 6) Paket (nominal; judul produk dipakai sebagai pengecekan silang)
  const byAmount = await planFromAmount(env, f.amount);
  if (!byAmount.plan) {
    await savePayment(env, { ...base, status: 'pending', reason: byAmount.why });
    return json({ ok: true, pending: true });
  }
  const byTitle = planFromTitle(f.title);
  if (byTitle && byTitle !== byAmount.plan) {
    await savePayment(env, { ...base, status: 'pending', plan: byAmount.plan, reason: `judul produk (${byTitle}) tidak sama dengan nominal (${byAmount.plan})` });
    return json({ ok: true, pending: true });
  }
  const plan = byAmount.plan;

  // 7) Akun: harus sudah terdaftar. Email beda → antrean pencocokan admin.
  const user = await getUserByEmail(env, f.email);
  if (!user) {
    await savePayment(env, { ...base, status: 'pending', plan, reason: 'email belum terdaftar di Terminal (kemungkinan beda dengan email akun)' });
    return json({ ok: true, pending: true });
  }

  // 8) Aktifkan. Klaim dulu (kunci unik id) agar webhook ganda tidak menambah durasi dua kali.
  try {
    await savePayment(env, { ...base, status: 'activated', plan, user_id: user.id });
  } catch {
    return json({ ok: true, duplicate: true });
  }
  try {
    await activateSubscription(env, user.id, plan, planDays(env, plan), 'lynk', id, planScope(plan));
  } catch (e) {
    await env.DB.prepare("UPDATE lynk_payments SET status='pending', reason=? WHERE id=?")
      .bind(`gagal mengaktifkan: ${(e && e.message) || e}`.slice(0, 200), id).run();
    return json({ error: 'Gagal mengaktifkan langganan; masuk antrean admin' }, 500);
  }
  return json({ ok: true, activated: { email: f.email, plan } });
}

// ── CHECKOUT: kembalikan link produk Lynk + email akun ──
export async function lynkCheckout(request, env, url) {
  const plan = url.searchParams.get('plan');
  if (!PLANS.includes(plan)) return json({ error: 'Paket tidak valid' }, 400);
  const session = await getSession(request, env);
  if (!session || !session.email) return json({ error: 'Silakan login dulu sebelum membayar.' }, 401);

  let link = '';
  try { link = ((await getBillingConfig(env)).plans[plan] || {}).lynkLink || ''; } catch { /* env */ }
  if (!link) {
    link = plan === 'tahunan' ? env.LYNK_LINK_TAHUNAN
      : plan === '3bulan' ? env.LYNK_LINK_3BULAN
        : plan === '1bulan' ? env.LYNK_LINK_1BULAN
          : env.LYNK_LINK_6BULAN;
  }
  if (!link) return json({ error: 'Pembayaran belum dikonfigurasi untuk paket ini.' }, 503);
  return json({ ok: true, provider: 'lynk', url: link, email: session.email, plan });
}

// ─────────────────────────── SAKELAR PENYEDIA PEMBAYARAN ───────────────────────────
// Dipilih dari panel Admin (disimpan di app_settings, berlaku seketika tanpa deploy).
// Nilai awal bila belum pernah diatur: env PAYMENT_PROVIDER ('lynk'), selain itu 'mayar'
// — jadi perilaku yang sedang berjalan TIDAK berubah sampai admin menggantinya.
const PROVIDER_KEY = 'payment_provider';

async function ensureSettings(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)').run();
}

export async function getPaymentProvider(env) {
  const fallback = env.PAYMENT_PROVIDER === 'lynk' ? 'lynk' : 'mayar';
  if (!env.DB) return fallback;
  try {
    await ensureSettings(env);
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(PROVIDER_KEY).first();
    if (row && row.value) {
      const v = JSON.parse(row.value);
      if (v && (v.provider === 'lynk' || v.provider === 'mayar')) return v.provider;
    }
  } catch { /* gagal baca → pakai nilai awal; jangan memblokir checkout */ }
  return fallback;
}

// Paket aktif (bukan "segera hadir") yang belum punya link Lynk.
async function plansMissingLynkLink(env) {
  const cfg = await getBillingConfig(env);
  const envLink = { '1bulan': env.LYNK_LINK_1BULAN, '3bulan': env.LYNK_LINK_3BULAN, '6bulan': env.LYNK_LINK_6BULAN, tahunan: env.LYNK_LINK_TAHUNAN };
  return PLANS.filter((k) => {
    const p = cfg.plans[k] || {};
    return !p.comingSoon && !(p.lynkLink || envLink[k]);
  });
}

export async function providerStatus(env) {
  let setBy = null, setAt = null, stored = false;
  try {
    await ensureSettings(env);
    const row = await env.DB.prepare('SELECT value FROM app_settings WHERE key = ?').bind(PROVIDER_KEY).first();
    if (row && row.value) { const v = JSON.parse(row.value); stored = true; setBy = v.by || null; setAt = v.at || null; }
  } catch { /* abaikan */ }
  return {
    provider: await getPaymentProvider(env),
    fromAdmin: stored, setBy, setAt,
    lynk: {
      tokenConfigured: !!((env.LYNK_WEBHOOK_TOKEN || '').trim() || (env.LYNK_MERCHANT_KEY || '').trim()),
      merchantKey: !!(env.LYNK_MERCHANT_KEY || '').trim(),
      missingLinks: await plansMissingLynkLink(env),
    },
    mayar: { apiKey: !!(env.MAYAR_API_KEY || '').trim(), webhookToken: !!(env.MAYAR_WEBHOOK_TOKEN || '').trim() },
  };
}

// Ganti penyedia. Ke Lynk hanya bila webhook-nya terkonfigurasi & semua paket aktif punya link
// (kalau tidak, pembeli tidak bisa bayar / pembayaran tidak aktif otomatis).
export async function setPaymentProvider(env, provider, adminEmail) {
  if (provider !== 'lynk' && provider !== 'mayar') throw new Error('Penyedia tidak valid');
  if (provider === 'lynk') {
    if (!(env.LYNK_WEBHOOK_TOKEN || '').trim() && !(env.LYNK_MERCHANT_KEY || '').trim()) {
      throw new Error('Belum bisa pindah ke Lynk.id: LYNK_MERCHANT_KEY atau LYNK_WEBHOOK_TOKEN belum diisi di Worker (webhook akan menolak semua pembayaran).');
    }
    const missing = await plansMissingLynkLink(env);
    if (missing.length) {
      throw new Error('Belum bisa pindah ke Lynk.id: link Lynk belum diisi untuk paket ' + missing.join(', ') + ' (Pengaturan Billing).');
    }
  }
  await ensureSettings(env);
  await env.DB.prepare(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind(PROVIDER_KEY, JSON.stringify({ provider, by: adminEmail, at: now() }), now()).run();
  return providerStatus(env);
}

// ─────────────────────────── API ADMIN ───────────────────────────
export async function listLynk(env) {
  await ensureTable(env);
  const cols = 'id, status, reason, email, name, amount, plan, user_id, created_at, resolved_at, resolved_by';
  const pending = await env.DB.prepare(`SELECT ${cols}, raw FROM lynk_payments WHERE status = 'pending' ORDER BY created_at DESC LIMIT 100`).all();
  const recent = await env.DB.prepare(`SELECT ${cols} FROM lynk_payments WHERE status != 'pending' ORDER BY created_at DESC LIMIT 30`).all();
  return {
    configured: !!((env.LYNK_WEBHOOK_TOKEN || '').trim() || (env.LYNK_MERCHANT_KEY || '').trim()),
    provider: await getPaymentProvider(env),
    pending: (pending.results || []).map((r) => ({ ...r, raw: String(r.raw || '').slice(0, 1500) })),
    recent: recent.results || [],
  };
}

// Admin mencocokkan pembayaran pending ke email akun tertentu (+ paket bila perlu).
export async function resolveLynk(env, adminEmail, { id, email, plan }) {
  await ensureTable(env);
  email = String(email || '').trim().toLowerCase();
  if (!emailOk(email)) throw new Error('Email tidak valid');
  const row = await env.DB.prepare('SELECT * FROM lynk_payments WHERE id = ?').bind(id).first();
  if (!row) throw new Error('Pembayaran tidak ditemukan');
  const useplan = plan || row.plan;
  if (!PLANS.includes(useplan)) throw new Error('Pilih paket yang valid');
  // Klaim atomik: hanya satu admin/klik yang bisa memproses baris pending ini.
  const claim = await env.DB.prepare("UPDATE lynk_payments SET status='processing' WHERE id = ? AND status = 'pending'").bind(id).run();
  const changed = claim && claim.meta && (claim.meta.changes != null ? claim.meta.changes : claim.meta.rows_written);
  if (!changed) throw new Error('Pembayaran ini sudah diproses');
  try {
    const user = await ensureUser(env, email, row.name || null);
    await activateSubscription(env, user.id, useplan, planDays(env, useplan), 'lynk', row.id, planScope(useplan));
    await env.DB.prepare("UPDATE lynk_payments SET status='activated', plan=?, user_id=?, email=?, resolved_at=?, resolved_by=?, reason=COALESCE(reason,'')||' → dicocokkan manual' WHERE id=?")
      .bind(useplan, user.id, email, now(), adminEmail, id).run();
    return { email, plan: useplan };
  } catch (e) {
    await env.DB.prepare("UPDATE lynk_payments SET status='pending' WHERE id = ? AND status='processing'").bind(id).run();
    throw e;
  }
}

export async function ignoreLynk(env, adminEmail, id) {
  await ensureTable(env);
  const r = await env.DB.prepare("UPDATE lynk_payments SET status='ignored', resolved_at=?, resolved_by=? WHERE id = ? AND status = 'pending'")
    .bind(now(), adminEmail, id).run();
  const changed = r && r.meta && (r.meta.changes != null ? r.meta.changes : r.meta.rows_written);
  if (!changed) throw new Error('Pembayaran ini sudah diproses');
  return { ok: true };
}
