# tracker-input

Cloudflare Worker berisi **halaman web sederhana** untuk kontributor meng-input
rekomendasi trading (Entry / TP1 · TP2 / SL) menu **Tracker**, tanpa harus buka Google
Sheet langsung.

Alur:

```
Kontributor  →  Worker (login password + form)  →  GAS Web App  →  Google Sheet "Tracker"
                                                                     status = "pending"
                                                                          │
                                                        approve admin (ubah status → approved)
                                                                          │
                                            (nanti) build script  →  tracker.json  →  menu Tracker
```

> **Isolasi:** Worker ini **terpisah total** dari site utama `terminal`, dari
> `terminal-live`, dan dari `valuation-uploader`. Deploy-nya manual & sendiri.
> **Tidak menyentuh apa pun yang sudah live.**

---

## Kenapa lewat Worker, bukan browser langsung ke GAS?

- Browser hanya bicara ke Worker (same-origin) → **tidak ada masalah CORS**.
- Token GAS tidak pernah terekspos ke browser (disimpan sebagai secret Worker).
- Gampang ganti auth / tambah validasi di satu tempat.

---

## Fitur bantu input (mengurangi ketik manual)

- **Tempel & Parse**: tempel teks sinyal → Tipe/Saham/Entry/TP1/TP2/SL terisi otomatis.
- **Tombol Gemini / ChatGPT**: menyalin prompt siap-pakai ke clipboard + membuka
  situs AI (pakai **akun inputer sendiri**, tanpa API key/biaya di sisi kita).
  Inputer upload fotonya di sana → salin hasil → tempel ke Tempel & Parse.
- **Foto bukti (maks 5)**: dikompres di browser lalu **dikirim ke Telegram** admin
  (`sendMediaGroup`) untuk validasi. **Foto TIDAK disimpan** di Sheet/Drive — hanya
  lewat ke chat Telegram. Butuh secret `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID`
  (nilai sama dgn worker terminal); bila tidak di-set, fitur foto diam-diam dilewati.

---

## Skema Google Sheet (tab `Tracker`)

Dibuat otomatis oleh GAS (`setup()` / submit pertama). Kolom:

| Kolom          | Isi                                             |
|----------------|-------------------------------------------------|
| `timestamp`    | waktu submit (otomatis)                         |
| `status`       | `pending` / `approved` / `rejected` (default `pending`) |
| `analis`       | nama analis                                     |
| `firm`         | firm/instansi (opsional)                        |
| `sertifikasi`  | mis. CTA, WPPE (opsional)                        |
| `ticker`       | kode saham (mis. `BBCA`)                         |
| `tipe`         | `BUY` / `SELL`                                   |
| `entry`        | harga entry                                      |
| `tp1`          | target price 1                                   |
| `tp2`          | target price 2 (opsional)                        |
| `sl`           | stop loss                                        |
| `tanggal`      | tanggal rilis `YYYY-MM-DD`                        |
| `horizon`      | `1H`/`1M`/`1Bln`/`3Bln`/`6Bln`/`1Th` (opsional)  |
| `catatan`      | tesis singkat (opsional)                         |
| `submitted_by` | nama pengupload (opsional)                        |
| `approved_by`  | diisi manual saat approve                         |

**Approval (MVP):** owner cukup ubah kolom `status` sebuah baris menjadi
`approved`. Nanti build script hanya mengambil baris `status = approved`.

---

## Cara pasang GAS (sekali saja)

1. Buat **Google Sheet baru** khusus tracker (mis. "Tracker DB").
2. Menu **Extensions ▸ Apps Script**.
3. Tempel seluruh isi [`gas/Code.gs`](gas/Code.gs), lalu **Simpan** (Ctrl+S).
4. Ganti `TOKEN` di file itu dengan token rahasia (bebas, panjang).
5. Kembali ke tab Google Sheet → **muat ulang halaman (refresh)** → muncul
   menu baru **🎯 Tracker** di bar menu. *(Ini "efek" setelah paste kode.)*
6. Klik **🎯 Tracker ▸ 1) Setup / Buat Tabel** → saat diminta, **Authorize**
   (Review permissions ▸ pilih akun ▸ Advanced ▸ Go to project ▸ Allow) →
   tab `Tracker` + header dibuat otomatis.
7. **Deploy ▸ New deployment ▸ Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Salin URL yang berakhiran `/exec`.

> Menu **🎯 Tracker** juga menyediakan **✅ Approve / 🚫 Reject** untuk menandai
> baris yang sedang dipilih — memudahkan alur persetujuan tanpa ketik manual.

---

## Cara deploy Worker

Prasyarat: sudah `npx wrangler login`.

```bash
cd tracker-input
npx wrangler deploy
```

Set secret (sekali saja):

```bash
npx wrangler secret put APP_PASSWORD        # password login halaman input
npx wrangler secret put GAS_URL             # URL Web App GAS (…/exec)
npx wrangler secret put GAS_TOKEN           # HARUS sama dgn TOKEN di gas/Code.gs
# Opsional — untuk fitur kirim foto bukti ke Telegram:
npx wrangler secret put TELEGRAM_BOT_TOKEN  # sama dgn worker terminal
npx wrangler secret put TELEGRAM_CHAT_ID    # sama dgn worker terminal
```

URL hasil deploy: `https://tracker-input.<subdomain-akun>.workers.dev/`
(untuk akun `chamdani49` → `https://tracker-input.chamdani49.workers.dev/`)

---

## Endpoint

| Method | Path          | Auth         | Keterangan                          |
|--------|---------------|--------------|-------------------------------------|
| GET    | `/`           | Cookie/login | Login form atau form input          |
| POST   | `/login`      | Public       | Submit password → set cookie        |
| GET    | `/logout`     | Public       | Hapus cookie                        |
| POST   | `/api/submit` | Cookie       | Kirim rekomendasi (JSON) → GAS      |

Cookie `ti_auth`: HttpOnly + Secure + SameSite=Lax, berlaku 12 jam. Token
di-derive dari `APP_PASSWORD` — ganti password ⇒ semua sesi lama invalid.

---

## Validasi (server-side)

- `analis`, `ticker`, `tipe`, `entry`, `tp1`, `sl`, `tanggal` wajib. `tp2` opsional.
- `ticker` di-uppercase, pola `[A-Z0-9.\-]{1,12}`.
- Arah TP/SL dicek relatif Entry (TP2, bila diisi, harus lebih jauh dari TP1):
  - **BUY** → TP1 di atas Entry, SL di bawah Entry, TP2 > TP1.
  - **SELL** → TP1 di bawah Entry, SL di atas Entry, TP2 < TP1.

---

## Catatan

- 1 password global (`APP_PASSWORD`) untuk semua kontributor. Cukup untuk MVP;
  bisa dinaikkan ke akun per-kontributor nanti.
- Worker tidak menulis apa pun ke repo; hanya meneruskan ke GAS.
- Semua submission masuk sebagai `pending` → **butuh approve admin** sebelum
  dibangun ke `tracker.json`. Build script + integrasi menu Tracker menyusul
  di langkah berikutnya (di balik feature flag, belum live).
