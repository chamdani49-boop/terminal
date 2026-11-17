# Tutorial: Pembayaran lewat Lynk.id

Panduan memindahkan pembayaran langganan Economstock Terminal dari Mayar ke Lynk.id.
Ikuti urutannya. Selama sakelar di panel Admin masih **Mayar**, tidak ada yang berubah
bagi pembeli.

> Format webhook dan tanda tangan mengikuti dokumentasi webhook Lynk.id (event
> `payment.received`, header `X-Lynk-Signature`). Satu hal yang tidak dijelaskan dokumen:
> nominal mana yang dipakai di tanda tangan, jadi Terminal menerima `grandTotal` maupun
> `totalPrice`. Pembayaran yang tidak bisa dikenali **tidak hilang**: ia masuk antrean
> admin (langkah 8). Uji dulu dengan satu pembayaran sungguhan sebelum mengganti sakelar
> (langkah 6).

---

## Cara kerjanya

1. Pembeli login di Terminal, buka **/billing**, lalu klik bayar.
2. Muncul panduan berisi **email akun Terminal** pembeli (bisa disalin), lalu tombol
   "Lanjut ke Lynk.id" membuka halaman produk paket itu di Lynk.
3. Pembeli mengisi nama dan email di Lynk, lalu membayar.
4. Lynk memanggil `https://terminal.economstock.com/api/webhook/lynk?token=…` dengan header
   `X-Lynk-Signature`.
5. Terminal memeriksa tanda tangan (Merchant Key) dan/atau token, lalu:
   - **email cocok dengan akun + nominal cocok dengan satu paket** → langganan aktif otomatis;
   - **selain itu** (email beda, nominal tidak dikenal, data kurang) → masuk antrean
     *Pembayaran Lynk.id menunggu pencocokan* di panel Admin.

Pembayaran yang sama tidak pernah diproses dua kali, meskipun Lynk mengirim ulang webhook.

---

## 1. Buat produk di Lynk.id

1. Masuk ke dashboard Lynk.id, lalu buat **1 produk digital per paket**:

   | Paket Terminal | Nama produk (saran) | Harga |
   |---|---|---|
   | 1 bulan (Tracker) | Economstock Terminal – Paket Tracker 1 Bulan | sama dengan Admin → Pengaturan Billing |
   | 3 bulan | Economstock Terminal – Paket 3 Bulan | sama |
   | 6 bulan | Economstock Terminal – Paket 6 Bulan | sama |
   | Tahunan | Economstock Terminal – Paket Tahunan | sama |

2. **Harga harus sama persis** dengan harga real di panel Admin. Terminal mengenali paket
   dari harga produk di webhook (`totals.totalPrice`). Toleransinya 90% sampai 115% dari
   harga, dan nominal harus cocok dengan tepat satu paket.
3. **Biaya layanan (convenience fee):** bebas diatur. Terminal membaca harga produk, bukan
   uang bersih setelah biaya, jadi pengaturan ini tidak memengaruhi aktivasi.
   **Jangan pakai addon** di produk ini, dan biarkan jumlah beli 1.
4. Pastikan formulir pembelian **meminta email** pembeli.
5. Hindari angka paket yang bertentangan di judul produk. Judul dipakai sebagai cek silang:
   kalau judul berkata "Tahunan" tapi nominalnya harga 1 bulan, pembayaran masuk antrean.

## 2. Isi link produk di panel Admin

1. Buka **/admin → Pengaturan Billing**.
2. Di setiap paket, isi kolom **"Link Lynk.id (halaman produk paket ini)"** dengan link
   produk dari langkah 1. Tombol **Buka** bisa dipakai untuk mengecek link.
3. Klik **💾 Simpan Billing**.

Kolom "Link Mayar" biarkan apa adanya, karena masih dipakai selama sakelar di Mayar.

## 3. Simpan Merchant Key dan token di Cloudflare

Keduanya mencegah orang lain memalsukan pembayaran. **Merchant Key** adalah pengaman utama
(dari Lynk, tidak pernah tampil di URL). **Token URL** adalah lapis kedua.

1. **Merchant Key**: di Lynk buka **Settings → Integrations → Webhook**, lalu di kotak
   **Merchant Key** klik **Copy**.
2. **Token URL**: ketik sendiri sekitar 40 huruf dan angka acak, tanpa spasi dan simbol.
   Jangan memakai contoh dari mana pun.
3. Buka **dash.cloudflare.com → Workers & Pages → terminal → Settings → Variables and
   Secrets**, lalu tambahkan dua baris bertipe **Secret**:

   | Variable name | Value |
   |---|---|
   | `LYNK_MERCHANT_KEY` | Merchant Key dari langkah 1 |
   | `LYNK_WEBHOOK_TOKEN` | token dari langkah 2 |

4. Klik **Deploy/Save**.
5. Cek di **/admin → Penyedia Pembayaran**: chip **Webhook Lynk** dan **Tanda tangan Lynk**
   harus hijau.

Kalau Merchant Key di Lynk di-**Regenerate**, perbarui juga `LYNK_MERCHANT_KEY` di
Cloudflare. Selama belum diperbarui, pembayaran masuk antrean (tidak aktif otomatis).

Lewat terminal juga bisa: `npx wrangler secret put LYNK_MERCHANT_KEY` dan
`npx wrangler secret put LYNK_WEBHOOK_TOKEN`.

## 4. Deploy Worker

Worker `terminal` terdeploy otomatis setiap ada perubahan di `main` (Cloudflare Workers
Builds). Tanda kode baru sudah aktif: kartu **💱 Penyedia Pembayaran** muncul di /admin.
Kalau tidak muncul, deploy manual dengan `npx wrangler deploy`.

Tidak perlu migrasi database. Tabel `lynk_payments` dibuat otomatis saat webhook pertama masuk.

## 5. Pasang webhook di Lynk.id

1. Di dashboard Lynk.id, buka **Settings → Integrations → Webhook**.
2. Isi kolom **URL Webhook**, lalu klik **Save URL**:

   ```
   https://terminal.economstock.com/api/webhook/lynk?token=TOKEN_DARI_LANGKAH_3
   ```

3. Klik **Test URL**. Lynk mengirim data contoh (email `user@lynk.id`, harga Rp25.000).
   Data itu masuk antrean di panel Admin, bukan mengaktifkan langganan. Klik **Abaikan**.
   Riwayat kirimannya terlihat di **Webhook History** di halaman yang sama.

> **URL ini rahasia** karena berisi token. Jangan dibagikan. Kalau bocor, buat token baru
> (langkah 3), deploy, lalu perbarui URL di Lynk.

## 6. Uji dengan satu pembayaran sungguhan

1. Login ke Terminal dengan akun milikmu sendiri.
2. Beli paket termurah lewat link Lynk-nya **langsung** (sakelar masih Mayar, jadi
   tombol di /billing belum ke Lynk). Isi email yang **sama** dengan email akun itu.
3. Cek **/admin → Penyedia Pembayaran → Riwayat terbaru**. Seharusnya tercatat
   **✅ Aktif**, dan masa aktif akun bertambah sesuai paket.
4. Kalau malah masuk antrean "menunggu pencocokan", klik **Payload**, salin isinya, lalu
   kirim ke developer agar pembacaan datanya disesuaikan. Pembayaran tetap bisa diaktifkan
   manual lewat tombol **Aktifkan**.

## 7. Nyalakan Lynk.id

1. Buka **/admin → 💱 Penyedia Pembayaran**.
2. Klik **Lynk.id**, lalu konfirmasi.
3. Sakelar menolak berpindah kalau token webhook belum diisi atau ada paket aktif yang
   belum punya link Lynk. Status siap tidaknya terlihat di baris chip di bawah sakelar.

Mulai saat itu, tombol bayar di /billing mengarah ke Lynk.id.

**Kembali ke Mayar** kapan saja: klik **Mayar** di sakelar yang sama. Berlaku seketika.

## 8. Memproses antrean pencocokan

Pembayaran masuk antrean bila email pembeli tidak terdaftar, nominal tidak dikenali, atau
data webhook tidak lengkap. Untuk setiap baris:

1. Cek nama, email, nominal, dan alasannya. Klik **Payload** bila perlu melihat data mentah.
2. Isi **email akun Terminal** yang benar dan pilih paketnya.
3. Klik **Aktifkan**. Langganan akun itu bertambah sesuai paket.
4. Untuk data uji atau pembayaran yang bukan produk Terminal, klik **Abaikan**.

Satu pembayaran hanya bisa diaktifkan sekali.

---

## Pelanggan yang sudah berjalan

- Langganan aktif **tidak diubah** saat sakelar diganti. Masa aktif, paket, dan level
  akses (Tracker / penuh) tetap seperti sebelumnya.
- Kalau pelanggan aktif membayar lagi lewat Lynk, durasinya **ditambahkan dari tanggal
  berakhir yang sekarang** (bukan dihitung ulang dari hari ini).
- Pelanggan paket Tracker yang memperpanjang tetap di paket Tracker.
- Riwayat pembayaran Mayar tetap tersimpan dan tetap terhitung di laporan pendapatan Admin.

## Kapan Mayar boleh dimatikan

Webhook Mayar tetap aktif meskipun sakelar di Lynk.id, supaya tagihan Mayar yang sudah
dibuat sebelum peralihan tetap diproses. Matikan produk dan webhook Mayar setelah:

1. pembayaran Lynk sudah berjalan beberapa hari tanpa masalah, **dan**
2. tagihan Mayar terakhir sudah kedaluwarsa (cek di dashboard Mayar).

Kode Mayar sengaja belum dihapus agar peralihan bisa dibatalkan. Penghapusannya bisa
dilakukan terpisah setelah dua syarat di atas terpenuhi.

## Ringkasan pengaturan

| Nama | Di mana | Isi |
|---|---|---|
| `LYNK_MERCHANT_KEY` | secret Worker | Merchant Key dari Lynk (Settings → Integrations → Webhook), disarankan |
| `LYNK_WEBHOOK_TOKEN` | secret Worker | token acak panjang, juga ditempel di URL webhook |
| Link Lynk.id per paket | Admin → Pengaturan Billing | link produk Lynk |
| Sakelar penyedia | Admin → Penyedia Pembayaran | Mayar / Lynk.id |
| `PAYMENT_PROVIDER` | variabel Worker (opsional) | nilai awal bila sakelar belum pernah diatur; `lynk` atau kosong (= Mayar) |
| `LYNK_LINK_1BULAN` … `LYNK_LINK_TAHUNAN` | variabel Worker (opsional) | cadangan bila kolom link di Admin kosong |
