---
inclusion: manual
---

# Handoff 10 Nov 2026: Smart Money › Screener (7 tampilan)

Permintaan user: tambah screener di menu Smart Money mengikuti 7 gambar referensi, visual
dirapikan, ikon "Cara pakai" & "Manfaat", responsif HP/tablet/PC, langsung di `main`.

## File
- `public/smartmoney-screener.js` (baru, mandiri, ±1.900 baris). Dimuat DINAMIS oleh
  `smartmoney.js` (`ensureScreener()`) saat sub-tab Screener dibuka, dengan `?v=SCR_V`.
  **Naikkan `SCR_V` di smartmoney.js setiap kali file screener diubah** (cache-busting,
  karena file ini tidak punya entri no-cache di `_headers`, yang termasuk area terkunci).
- `public/smartmoney.js`: sub-tab ke-4 `screener`, kontainer `#smmPgScreener`, `setSub()`
  menerima `screener`, objek `screenerApi` (util + `getData`-terkait + `openStock`),
  `openCodeFromSearch()` (cari kode di Screener: kalender ikut saham, tampilan lain pindah ke
  Broker Activity), entri menu avatar "Screener". Tidak ada perubahan di index.html / _headers.

## Tampilan (tab di dalam Screener)
1. Today: tanggal ‹ ›, KPI, Associate broker & holder searah, kartu Setup Preset + akurasi
   (backtest 10 hari vs rata-rata semua saham, ±3 bulan).
2. Gems: skor 0-100 + tier, 3D trend, harga, RSI-14, Stoch %K, regime, evidence, 8 preset.
3. Accumulation: Positioning 6 bln (floor, PnL, net lot/val, trend, days, TRAPPED) + panel
   filter/quick preset; Daily Flow 10 hari (heatmap).
4. Smart Money: Nampung Retail (SM net beli & ritel net jual) dan Smart Money P&L, rentang tanggal.
5. Broker & Holder: Associate broker (balik arah), holder >5%, insider lintas saham.
6. Foreign: Flow Intensity (skor, intensitas, float%, konsisten, akselerasi, KSEI) + Radar Top 20.
7. Kalender: heatmap net harian per bulan per saham / kelompok / broker, detail per hari.
Setiap tampilan punya tombol Cara pakai & Manfaat (terbuka otomatis pada kunjungan pertama,
`localStorage.sx_seen_*`). HP ≤640px: tabel diganti kartu; Accumulation filter jadi lipatan.

## Data
- Harga & teknikal ASLI dari `/ohlc.json` (±140 hari bursa), nama/sektor/mcap dari `DATA`.
- Arus broker/asing/ritel/insider/holder = dummy deterministik (`simulate()`), kecuali saham di
  index R2 → `applyReal()` dari `/api/admin/smartmoney` (maks 150 saham, 4 paralel), ditandai ●.
- Ritel = `RETAIL` (YP, XL, PD, XC, KK, CP, EP); smart money = broker lain.
- Dummy sengaja TIDAK melihat return masa depan, supaya akurasi preset di Today tidak menipu.

## Revisi: tata letak Insider & Kepemilikan (tanpa ruang kosong)
- Kepemilikan: baris `.smm-grid` diganti `.smm-hocols` (2 kolom flex, tinggi disamakan).
  Kiri: Komposisi → Pemegang terkini → Dewan (`#smmHoBoard`, `.smm-fill`).
  Kanan: Tren 12 bln → Jumlah pemegang → Profil (`#smmHoCompany`, `.smm-fill`).
  Kartu terakhir tiap kolom mengisi sisa tinggi. ≤1099px: satu kolom, urutan via `order`.
  `renderHoProfile()` sekarang mengisi `#smmHoBoard` dan `#smmHoCompany` (bukan `#smmHoProfile`).
- Insider: grafik 380→270px (tablet 250, HP 220). Tablet: Analisis pindah sejajar "Orang dalam",
  Per bulan/tahun lebar penuh di bawah. Analisis + total nilai beli/jual/rata-rata; kotak Orang dalam
  + total kepemilikan & jumlah orang dalam (rata bawah).

## Revisi 2: Insider grafik 2 kolom
- `.smm-ins-row`: grafik (kolom lebar) + "Orang dalam" (`#smmInsHolders`, 340px; 280px di ≤1099px).
  Kotak Orang dalam dibungkus `.smm-ins-sidewrap` (position:relative) dan isinya absolute,
  jadi tingginya MENGIKUTI grafik; daftar panjang (data asli bisa puluhan orang) di-scroll di
  `.smm-ins-list`. ≤640px: ditumpuk, maks 360px.
- `.smm-ins-mid`: Buy record · Kualitas timing · Analisis (3 kolom), Per bulan/tahun lebar penuh.
  641-900px: 2 kolom, Analisis lebar penuh. Tiap kotak punya ringkasan `.smm-ins-foot` rata bawah.
- Kualitas timing + rata-rata 1/6 bln setelah beli, 1 bln setelah jual, harga rata-rata beli.

## Revisi 3: data asli seluruh pasar lewat 1 file ringkasan
- `scripts/build-smartmoney-screener.js --dir <folder smartmoney> [--upload]` merangkum
  `broker/`, `insider/`, `holder/` per saham → `screener/summary.json` (format di header skrip,
  nilai Rp dalam satuan Rp1 jt, ±9 KB per saham). `--upload` menjalankan
  `npx wrangler r2 object put smartmoney/screener/summary.json --remote`.
  Jalankan SETELAH `upload_smartmoney.py` (repo private) setiap kali data diperbarui.
- Endpoint admin `GET /api/admin/smartmoney/screener` (src/lib/smartmoney.js) mengalirkan file itu
  apa adanya; tidak ada file → `{ok:true, summary:null}` → Screener tetap dummy.
- Frontend: `loadSummary()` → `applySummary()` untuk semua saham di file; `loadRealAll()` (per saham,
  maks 150) hanya untuk kode di index.json yang TIDAK ada di ringkasan.
- Batasan ringkasan: net harian per broker hanya 21 hari terakhir (cukup untuk Daily Flow, assoc
  broker 1M, kalender per broker bulan berjalan); total 6 bulan per broker utuh. Block Absorption
  belum punya data asli (butuh data pasar nego).
- `SCR_V` = 20261110b.

## Revisi 4: Kalender + grafik Broker Flow
- `.sx-cal-split`: kiri grafik (1,6 fr: candle harga + garis kumulatif net smart money / asing /
  ritel / broker terpilih, `buildCalChart()` dengan lightweight-charts), kanan kalender (1 fr).
  ≤1099px ditumpuk. Grafik menampilkan bulan terpilih + 2 bulan sebelumnya; klik grafik memilih
  tanggal di kalender, tanggal terpilih diberi panah. `SCR_V` = 20261110c.

## Revisi 5: Kalender pindah ke Broker Activity
- Tampilan Kalender DIHAPUS dari Screener (sekarang 6 tampilan). Kalender flow ada di
  `smartmoney.js`: `.smm-flowrow` = Broker Flow (1,6 fr) + `#smmCalCard` (1 fr), ≤1099px ditumpuk.
- `renderCal()` dipanggil di akhir `renderAction()`. Data dari `getData()` (sama dengan grafik),
  ikut filter investor (`S.inv`). Kelompok: smart money (non-`RETAIL`), ritel, asing, atau 1 broker.
- Ketuk tanggal (`data-act="calday"`) → `S.actEnd` → Broker Action & Distribution pindah ke hari itu;
  bulan kalender mengikuti `S.actEnd` (‹ › untuk pindah bulan manual). `SCR_V` = 20261110d.

## Revisi 6: baris kode saham dihapus, saran pencarian seperti Dashboard
- `#smmQuick` (deret tombol kode saham) beserta CSS & handler `quick` dihapus.
- `<datalist id="smmCodes">` diganti dropdown `#smmDrop` di `.smm-searchwrap` (`suggestSearch()`):
  sama dengan `buildSearchIndex()` di index.html (DATA.stock_list, cocok kode/nama, maks 12,
  kode · nama · sektor), plus bagian Broker dan Orang dalam. Enter: kode persis → broker → nama
  persis → saham pertama yang cocok (seperti Dashboard) → nama mirip. index.html tidak diubah.

## Revisi 7: visual Kepemilikan v2 (beda dari Stockbit, info tetap lengkap)
- Helper SVG baru: `hoLine` (garis+area, skala diperbesar), `hoDeltas` (batang perubahan ±),
  `hoDonut`, `hoRing`, `hoPill` (▲/▼ pp). CSS `.smm-hm`, `.smm-hcomp`, `.smm-hcats`, `.smm-chain`, `.smm-tiles` dll.
- Pergerakan >1%: tabel → kartu per pemegang (peringkat, bar porsi, Δ pill, lembar/nilai/scripless/scrip,
  sparkline) + legenda bar + chip ringkasan + baris "keluar daftar". `#smmHoMoveTbl`/`#smmHoMoveTxt` kini div.
- Komposisi: donut + legenda dengan Δ, meter Scrip/Scripless & Ritel/Institusi.
- Tren 12 bln: Lokal vs Asing = garis porsi asing + batang perubahan per bulan; Per kategori = baris sparkline.
- Jumlah pemegang: garis + batang perubahan, ringkasan 1 thn/bulan naik/turun, daftar 2 kolom.
- Pemegang terkini: peta kepemilikan + bar per pemegang; direksi/komisaris dengan inisial; UBO sebagai rantai.
- Dewan: chip orang per jabatan. Profil: kartu ikon + free float ring + harga vs IPO + chip penjamin emisi.

## Revisi 8: SEMUA data dummy dihapus
- smartmoney.js: `generate()`, `genHolder()`, konstanta dummy (FIRST/LAST/CORP/ROLES/FUNDS/SECTORS,
  END_DATE, N_PRICE, N_FLOW) dihapus. `getData()` → data asli R2 atau `emptyData()` (kosong).
  Halaman Broker, Insider (baru punya `.smm-empty`), Kepemilikan menampilkan kotak kosong.
  Fungsi render broker/insider diberi guard `hasBroker` / `hasInsider`. Badge: "Data asli · tgl" /
  "Memuat data…" / "Belum ada data".
- smartmoney-screener.js: `simulate()` dihapus → `blank()` (arus nol). `presetHit` & KPI Today hanya
  menghitung saham `realBroker`. Tanpa data asli muncul banner `.sx-nodata` berisi cara mengunggah.
  Harga & teknikal tetap asli dari ohlc.json. `SCR_V` = 20261110e.
- Catatan: kolom "KSEI" di Foreign masih perkiraan dari arus transaksi asing (bukan file KSEI).

## Revisi 9: visual Kalender flow (Broker Activity)
- Bug: lingkaran di belakang "Avg" berasal dari class `.av` avatar Kepemilikan → diganti `.smm-av`.
- Sel baru: tanggal + panah SVG (▲/▼) di atas, nilai net besar, "lot · @harga rata-rata", garis
  kekuatan di bawah (`--w`), warna pekat menurut besar net. Hari tanpa transaksi / libur = arsir,
  hari mendatang = garis putus-putus. Minggu di luar bulan disembunyikan.
- Header: kartu Net bulan ini (+lot) dan Hari beli/jual dengan bar porsi, chip beli & jual terbesar,
  legenda skala warna di bawah kalender.

## Revisi 10: Broker Flow · tampilan Ringkasan (utama) + Grafik (opsi kedua)
- Switch `#smmFlowView` (Ringkasan | Grafik), state `S.flowView`, disimpan di localStorage `smm_flowview`
  (default `story`). Grafik = candle + garis kumulatif per broker (LWC lama, tidak berubah).
- Ringkasan (`#smmFlowStory`, fungsi `flowStoryData`, `flowStoryHead`, `renderFlowStory`, `drawStoryPlots`,
  `storyHover`, `storyRead`): harga + perubahan periode, judul otomatis (Tarik-tambang / Akumulasi /
  Distribusi), kartu Akumulator (chip net > 0) vs Distributor (chip net < 0), SVG harga (Puncak, Low,
  Titik balik) + SVG net flow kumulatif tiap kubu, bar net per broker. Ikut chip, periode, Value/Volume,
  filter investor. SVG digambar ulang lewat ResizeObserver; layout 2 kolom via container query ≥ 640px.
- Mode Ringkasan menghapus chart LWC (hemat memori); `buildFlow()` tetap jadi pintu masuk keduanya.

## Revisi 11: Orbit "Siapa lawan X?" + Peta posisi Value × Volume (dilebur)
- Broker Distribution (`#smmSankeyCard`) punya switch `#smmSkView` Orbit | Aliran (`S.skView`, default orbit).
  Orbit (`renderOrbit`, `skFocusOf`, `fracWord`): komposisi lawan (Asing / X sendiri / Lokal / BUMN),
  kalimat otomatis, orbit SVG (klik lingkaran → `skfocus` ke broker lawan), daftar lawan + %, select
  `#smmSkFocus`. Fokus tetap `S.skFocus` ('b:KODE' / 's:KODE'), sama dengan Sankey.
- Sankey (`renderSankeyFlow`) kini membagi pita PROPORSIONAL (bobot acak `rng` dihapus) supaya angka
  Orbit dan Aliran sama. Data bursa tidak mencatat pasangan pembeli-penjual → keduanya diberi label estimasi.
- Value × Volume dilebur ke Ringkasan Broker Flow: bar "Net value per broker" diganti tabel
  (Net value, Net lot, Rata², vs harga) + Peta posisi broker (`drawStoryMap`, `storyMapText`, `stVs`).
  Toggle Value/Volume yang sudah ada dipakai, jadi tidak ada opsi "Keduanya" terpisah.

## Revisi 12: tiga kartu baru terpisah (membatalkan peleburan Revisi 10–11)
- User: visual baru harus jadi kartu/kolom baru, bukan digabung ke kartu lama.
- Broker Flow kembali grafik saja (switch Ringkasan/Grafik dan `S.flowView` dihapus).
  Broker Distribution kembali Sankey saja (switch Orbit/Aliran dihapus; pita tetap proporsional).
- Baris baru `.smm-cols3` setelah Broker Flow + Kalender: `#smmStoryCard` (Order Flow, `renderFlowStory`),
  `#smmOrbitCard` (Lawan Transaksi, `renderOrbit`, state `S.obMetric` / `S.obFocus`, select `#smmObFocus`),
  `#smmVxvCard` (Value × Volume, `renderVxv` / `drawVxvMap`, mode `S.vxv` value|volume|both).
  3 kolom ≥ 1181px, 2 kolom (Value × Volume selebar penuh) 761–1180px, 1 kolom di HP.
- Anti dobel: bar "net per broker" Order Flow dihapus (rinciannya ada di tabel Value × Volume).
- `fitStory()` memanjangkan grafik Order Flow agar setinggi kartu tetangga saat sejajar.

## Revisi 13: Broker Flow kembali Ringkasan (utama) | Grafik (opsi kedua)
- User menegaskan perintah Revisi 10 sudah benar dan TIDAK boleh diubah: Broker Flow = switch
  Ringkasan (default) | Grafik, Ringkasan lengkap dengan bar "Net value per broker".
- Kartu Order Flow terpisah dihapus (isinya sama dengan Ringkasan). Baris `.smm-cols3` kini 2 kartu:
  Lawan Transaksi + Value × Volume (2 kolom > 900px, 1 kolom di bawahnya). `fitStory` dihapus.

## Revisi 14: kartu Broker Summary (kolom ke-3 baru)
- `#smmBSumCard` di depan Lawan Transaksi & Value × Volume dalam `.smm-cols3` (3 kolom > 1180px,
  2 kolom + Value × Volume selebar penuh 761–1180px, 1 kolom di HP). Kartu lama tidak diubah.
- `renderBSum()` (dipanggil di akhir `renderAction`): ikut tanggal & mode Net/Gross Broker Action.
  Meter top 9 beli vs top 9 jual + kalimat, tarik-tambang berpasangan per peringkat, gaya order pembeli.
- Gaya order butuh frekuensi transaksi: `adapt()` kini membaca array opsional `bf` / `sf` per broker
  (jumlah transaksi beli/jual per hari). Data R2 sekarang belum punya → kartu menampilkan catatan
  "belum tersedia". Untuk mengaktifkan: tambahkan `bf`/`sf` ke file broker di R2 (pipeline data).

## Revisi 15: kartu Broker Summary & Lawan Transaksi tampak kosong
- Penyebab: tanggal default = hari terakhir harga (mis. hari ini), sedangkan data broker baru ada sampai
  hari bursa sebelumnya. Kartu menulis `.smm-empty`, yang di luar halaman kosong ber-`display:none`.
- Perbaikan: `activeRange(g)` mundur ke hari terakhir yang ada transaksi broker + catatan `.smm-cardnote`
  ("… belum ada transaksi broker. Ditampilkan hari terakhir …"). Pesan kosong di kartu baru memakai
  `.smm-cardnote` (selalu terlihat), bukan `.smm-empty`.

## Revisi 16: Lawan Transaksi punya switch Orbit | Aliran
- `#smmObView` (`S.obView` orbit|flow). Aliran = `obFlowSvg()`: Sankey terfokus gaya Broker Distribution
  Stockbit. Broker fokus besar di kolomnya, broker sejenis lain kecil (ketuk = pindah fokus), kolom lawan =
  lawan transaksi (top 6/7 + Lain). Fokus penjual dicerminkan (penjual di kanan). Pita abu-abu = estimasi
  aliran broker lain. Bar komposisi & select tetap di atas untuk kedua tampilan.

## Revisi 17: Broker Summary punya switch Ringkasan | Tabel + Net | Gross
- `#smmBsView` (`S.bsView` sum|table), `#smmBsNet` mengubah `S.actMode` (sinkron dengan select Broker Action).
- Tabel gaya Stockbit: BY, B.val, B.lot, B.freq, B.avg | SL, S.val, S.lot, S.freq, S.avg, 10 teratas +
  "Lihat semua" (`S.bsAll`). Geser horizontal di layar sempit, kolom BY sticky. Freq dari `bf`/`sf`
  (tampil "-" bila belum ada di data atau filter investor bukan Semua).

## Revisi 18: Broker Action dilebur ke Broker Summary
- Kartu `#smmActionCard` dihapus. Kontrol tanggal (‹ tanggal ›, date picker), rentang 1/5/20/60 hari dan
  Net/Gross (`#smmActDate`, `#smmActPick`, `#smmActWin`, `#smmActMode`) pindah ke `#smmBSumCard`
  (tombol Net|Gross `#smmBsNet` dihapus, diganti select Mode).
- `renderAction()` kini hanya mengisi kontrol tanggal lalu `renderCal()` + `renderBSum()`.
- Broker Summary mendapat total transaksi / net asing / harga (`.smm-totals`), tabel bisa diurutkan
  (`actsort`, `S.actSort`) dan kode broker bisa diketuk (`bkpick` → chip Broker Flow).
- Broker Distribution (Sankey) kini kartu selebar penuh. Klik kalender menggulir ke Broker Summary.

## Revisi 19: Broker Distribution dihapus + tata letak rapi
- Kartu `#smmSankeyCard` beserta `renderSankeyFlow`, `_skLinks`, tooltip pita, `skmetric` dihapus.
  `renderSankey()` kini hanya `renderOrbit()` (nama dipertahankan karena dipanggil di banyak tempat).
- Broker Activity: `.smm-cols3` align stretch, kartu flex-column, kotak terakhir tiap kartu mengisi sisa.
- Kepemilikan: `balanceHoCols()` + ResizeObserver (`watchHoCols`) membagi 6 kartu ke 2 kolom dengan
  selisih tinggi terkecil (64 kombinasi, urutan HO_ORDER dipertahankan). Selisih < 160px → kartu
  terakhir kolom pendek diberi `.smm-fill`. Hanya saat `.smm-hocols` berupa grid (> 1100px).
