# Setup Login + Langganan (Fase 1)

Panduan mengaktifkan backend auth, langganan, dan admin untuk Economstock Terminal.
Selama langkah-langkah ini **belum** dilakukan, situs tetap berjalan normal seperti
biasa (flag `GATING_ENABLED="false"`, binding D1 dikomentari).

> Urutan aman: **1 → 6**. Jangan menyalakan `GATING_ENABLED="true"` sebelum
> login + langganan terverifikasi jalan, supaya tidak mengunci pengunjung.

---

## Ringkasan arsitektur

- **Worker `terminal`** (`src/index.js`) — hanya jalan untuk `/api/*` + route bersih
  (`/login`, `/billing`, `/admin`, `/dashboard`). Aset lain dilayani langsung.
- **D1** (`DB`) — tabel `users`, `subscriptions`, `email_codes`.
- **Auth** — Google OAuth + kode email (passwordless), sesi via cookie HMAC.
- **Bayar** — Mayar.id: tombol → `/api/checkout` → payment link; webhook
  `/api/webhook/mayar` mengaktifkan langganan.
- **Admin** — `/admin` (UI) + `/api/admin/*` (dibatasi `ADMIN_EMAILS`).

---

## 1. Buat database D1

```bash
npx wrangler d1 create terminal-db
```

Salin `database_id` yang muncul, lalu **uncomment** blok di `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "terminal-db"
database_id = "PASTE_ID_DI_SINI"
```

Jalankan migrasi skema:

```bash
npx wrangler d1 execute terminal-db --remote --file=migrations/0001_init.sql
```

## 2. Set secrets

```bash
npx wrangler secret put SESSION_SECRET        # string acak panjang (mis. hasil openssl rand -hex 32)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MAYAR_WEBHOOK_TOKEN   # token webhook dari dashboard Mayar
npx wrangler secret put MAYAR_LINK_6BULAN     # URL payment link produk 6 bulan
npx wrangler secret put MAYAR_LINK_TAHUNAN    # URL payment link produk tahunan
# Opsional (kirim kode email via Resend):
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM            # mis. "Economstock <noreply@economstock.com>"
# Opsional (cocokkan produk via id, lebih presisi dari nominal):
npx wrangler secret put MAYAR_PRODUCT_6BULAN
npx wrangler secret put MAYAR_PRODUCT_TAHUNAN
```

Set juga **vars** (boleh lewat dashboard atau `wrangler.toml`):

- `ADMIN_EMAILS` = email admin, dipisah koma. Contoh: `chamdani49@gmail.com`

## 3. Google OAuth (Google Cloud Console)

1. Buka [console.cloud.google.com](https://console.cloud.google.com/) → buat/ pilih project.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
3. Application type: **Web application**.
4. **Authorized redirect URIs**, tambahkan:
   ```
   https://terminal.economstock.com/api/auth/google/callback
   ```
5. Simpan **Client ID** & **Client Secret** → masukkan ke secret di langkah 2.
6. Di **OAuth consent screen**, isi data dasar & publish (mode "External").

## 4. Email (opsional, untuk login kode email)

Daftar di [resend.com](https://resend.com) (free tier), buat API key, set `RESEND_API_KEY`.
Verifikasi domain pengirim agar email tidak masuk spam, lalu set `EMAIL_FROM`.

> Tanpa `RESEND_API_KEY`, endpoint kode email tetap berfungsi untuk **pengujian**:
> kode dikembalikan di response (`dev_code`) dan tampil di halaman login. Jangan
> dipakai untuk produksi.

## 5. Mayar.id

1. Di dashboard Mayar, buat **2 produk** (tipe membership/produk berbayar):
   - "Economstock Terminal — 6 Bulan" — harga Rp 997.000
   - "Economstock Terminal — Tahunan" — harga Rp 1.750.000
2. Ambil **payment link** masing-masing → set `MAYAR_LINK_6BULAN` & `MAYAR_LINK_TAHUNAN`.
3. (Opsional) ambil **Product ID** → set `MAYAR_PRODUCT_6BULAN` & `MAYAR_PRODUCT_TAHUNAN`
   untuk pencocokan paket yang presisi. Tanpa ini, paket ditebak dari nominal.
4. Set **webhook URL** ke:
   ```
   https://terminal.economstock.com/api/webhook/mayar
   ```
   dan **webhook token** → set `MAYAR_WEBHOOK_TOKEN`.
5. Lakukan 1 pembayaran uji. Cek log Worker (`wrangler tail`) untuk melihat payload.
   Jika nama field berbeda, sesuaikan `pick(...)` di `src/lib/mayar.js`.

> Penting: pastikan **email** saat checkout = email akun login user, agar langganan
> otomatis terhubung. (Penanganan email berbeda bisa ditambah belakangan.)

## 6. Nyalakan gating

Setelah login + pembayaran + admin terbukti jalan:

1. Di `wrangler.toml`, untuk meng-gate file data, tambahkan path-nya ke
   `run_worker_first` agar Worker bisa memeriksa langganan:
   ```toml
   [assets]
   directory = "./public"
   binding = "ASSETS"
   run_worker_first = ["/api/*", "/data.json", "/valuation.json", "/ohlc.json", "/", "/index.html"]
   ```
2. Set var `GATING_ENABLED = "true"`.
3. Deploy. Sekarang halaman & data terproteksi memerlukan langganan aktif;
   pengunjung tanpa langganan diarahkan ke `/billing`.

> Catatan biaya: meng-gate `/data.json` membuat tiap request data memanggil Worker
> (dihitung ke kuota 100k/hari free). Untuk ~500 user umumnya masih aman; pantau di
> dashboard. Jika perlu, tambahkan cache di Worker.

---

## Uji cepat (setelah langkah 1–5)

```bash
# status sesi
curl https://terminal.economstock.com/api/me

# minta kode email (tanpa Resend → dapat dev_code)
curl -X POST https://terminal.economstock.com/api/auth/email/request \
  -H 'Content-Type: application/json' -d '{"email":"test@example.com"}'
```

Buka `/login` untuk Google/email, `/billing` untuk paket, `/admin` untuk kelola user.
