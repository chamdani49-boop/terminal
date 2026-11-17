# Tutorial: Pembayaran lewat Lynk.id

Panduan memindahkan pembayaran langganan Economstock Terminal dari Mayar ke Lynk.id.
Ikuti urutannya. Selama sakelar di panel Admin masih **Mayar**, tidak ada yang berubah
bagi pembeli.

> **Yang belum terverifikasi.** Dokumentasi webhook Lynk.id tidak tersedia publik, jadi
> nama menu di dashboard Lynk dan bentuk data webhook-nya belum bisa dipastikan. Kode
> dibuat untuk membaca berbagai bentuk data, dan setiap pembayaran yang tidak bisa
> dikenali **tidak hilang**: ia masuk antrean admin (langkah 7). Uji dulu dengan satu
> pembayaran sungguhan sebelum mengganti sakelar (langkah 6).

---

## Cara kerjanya

1. Pembeli login di Terminal, buka **/billing**, lalu klik bayar.
2. Muncul panduan berisi **email akun Terminal** pembeli (bisa disalin), lalu tombol
   "Lanjut ke Lynk.id" membuka halaman produk paket itu di Lynk.
3. Pembeli mengisi nama dan email di Lynk, lalu membayar.
4. Lynk memanggil `https://terminal.economstock.com/api/webhook/lynk?token=…`.
5. Terminal memeriksa token, lalu:
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
   dari nominal yang dibayar. Toleransinya 90% sampai 115% dari harga, dan nominal harus
   cocok dengan tepat satu paket.
3. **Biaya layanan (convenience fee):** sebaiknya ditanggung penjual, supaya nominal di
   webhook sama dengan harga paket. Kalau ditanggung pembeli dan totalnya lebih dari 15%
   di atas harga, pembayaran masuk antrean manual. Lynk punya panduan
   "mengatur penanggung convenience fee" di halaman FAQ-nya.
4. Pastikan formulir pembelian **meminta email** pembeli.
5. Hindari angka paket yang bertentangan di judul produk. Judul dipakai sebagai cek silang:
   kalau judul berkata "Tahunan" tapi nominalnya harga 1 bulan, pembayaran masuk antrean.

## 2. Isi link produk di panel Admin

1. Buka **/admin → Pengaturan Billing**.
2. Di setiap paket, isi kolom **"Link Lynk.id (halaman produk paket ini)"** dengan link
   produk dari langkah 1. Tombol **Buka** bisa dipakai untuk mengecek link.
3. Klik **💾 Simpan Billing**.

Kolom "Link Mayar" biarkan apa adanya, karena masih dipakai selama sakelar di Mayar.

## 3. Buat token webhook

Token ini mencegah orang lain memalsukan pembayaran. Jalankan di folder repo:

```sh
openssl rand -hex 32                      # salin hasilnya
npx wrangler secret put LYNK_WEBHOOK_TOKEN  # tempel hasil di atas
```

Simpan token di tempat aman. Tanpa token ini, webhook Lynk menolak semua panggilan,
dan sakelar ke Lynk.id di panel Admin tidak bisa dinyalakan.

## 4. Deploy Worker

Kalau Worker `terminal` belum terdeploy otomatis dari GitHub, jalankan:

```sh
npx wrangler deploy
```

Tidak perlu migrasi database. Tabel `lynk_payments` dibuat otomatis saat webhook pertama masuk.

## 5. Pasang webhook di Lynk.id

1. Di dashboard Lynk.id, buka pengaturan webhook. Lynk menyebutnya "Webhook transaksi
   sukses" di halaman FAQ. Fitur ini mungkin hanya tersedia untuk akun tertentu (mis. PRO);
   cek di akunmu.
2. Isi URL webhook:

   ```
   https://terminal.economstock.com/api/webhook/lynk?token=TOKEN_DARI_LANGKAH_3
   ```

   Kalau Lynk menyediakan kolom token atau header terpisah, token juga diterima lewat header
   `x-webhook-token`, `x-callback-token`, atau `Authorization: Bearer …`.
3. Simpan. Kalau ada tombol uji, klik. Data uji biasanya masuk antrean di panel Admin
   (bukan mengaktifkan langganan). Klik **Abaikan** setelah dicek.

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
| `LYNK_WEBHOOK_TOKEN` | secret Worker (`wrangler secret put`) | token acak panjang, wajib |
| Link Lynk.id per paket | Admin → Pengaturan Billing | link produk Lynk |
| Sakelar penyedia | Admin → Penyedia Pembayaran | Mayar / Lynk.id |
| `PAYMENT_PROVIDER` | variabel Worker (opsional) | nilai awal bila sakelar belum pernah diatur; `lynk` atau kosong (= Mayar) |
| `LYNK_LINK_1BULAN` … `LYNK_LINK_TAHUNAN` | variabel Worker (opsional) | cadangan bila kolom link di Admin kosong |
