---
inclusion: manual
---

# Handoff sesi 7 Nov 2026: menu avatar, WhatsApp, referral, chip identitas, sinkron return Tracker

Bahasa ke user: Indonesia. Semua perubahan sesi ini **langsung di `main`** (permintaan user:
"langsung taruh di main"). Kecuali PR #364, yang dibuat lalu langsung di-merge. Deploy = push
ke `main`, lalu Cloudflare Workers Builds (`terminal`) jalan otomatis. Cek hasil build:
`gh api repos/chamdani49-boop/terminal/commits/<sha>/check-runs`.

Alur push yang aman (bot sering commit data saat jam bursa):
`git pull --rebase origin main && git push origin main`.
Jangan ikutkan file data auto-refresh di commit fitur.

## Ringkasan perubahan (urut waktu)

| # | Perubahan | File | Commit |
|---|---|---|---|
| 1 | Avatar akun pindah ke **kiri logo**. Dropdown avatar berisi **menu + sub-menu** semua halaman (bisa diklik, responsif). | `public/acct-nav.js` (baru), `index.html` (blok `.acct-wrap` dipindah ke depan `.logo`, `#acctNav`, CSS `.acct-nav*`, dropdown `left:0`) | PR #364 |
| 2 | Admin > Data Referral: rincian per email yang diajak + **paket berbayar terakhir** (Tracker 1 Bln / Full 3/6/12 Bln). | `src/lib/db.js` `listReferralsGrouped` (`paid_plan`, `paid_scope`, ada fallback query lama), `public/admin.html` `refPlanLabel` | `93f68aab2` |
| 3 | **Nomor WhatsApp wajib** di pop up Ketentuan, untuk user baru DAN user lama yang belum punya nomor. Kolom WA di tabel user admin + pencarian + Download Excel. | `src/lib/contact.js` (baru; tabel `user_contacts` auto-create), `src/index.js` (`/api/me` → `whatsapp`, `whatsapp_missing`; `/api/accept-terms` terima `{whatsapp}`), `src/lib/db.js` `listUsersWithSub`, `index.html` (popup `#tosgWa`), `admin.html` | `aaa1c9bf4` |
| 4 | Rapikan teks kotak centang popup Ketentuan (dulu terpecah jadi kolom). | `index.html` | `1d8753489` |
| 5 | **SimInvest dilebur ke Sinarmas Sekuritas** (alias brand). | `scripts/build-tracker.js` `_FIRM_BRAND_ALIASES` di `matchCanonicalFirm` | `620796602` |
| 6 | **Chip identitas melayang** (kode + nama) di Tracker > Analisis, Dashboard, semua tab Valuasi, profil firm Consensus. Juga memperbaiki chip lama Analis yang tertinggal di menu lain. | `public/id-sticky.js` (baru; hanya membaca DOM), `index.html` (1 baris script) | `388a2ca91` |
| 7 | **Sinkron return Overview vs Analis**: filter periode di mesin utama sekarang basis **exitDate**. | `public/tracker-stats.js` `compute()`, `index.html` (`_computeFirmDailyEquity` tanpa fallback `pnlEffective`; baris "Dibukukan periode ini" disembunyikan) | `efcfac47e` |
| 8 | Valuasi > Valuation Ratios: batang PBV = cyan `#06b6d4` (dulu `COL.cyan` undefined, jadi warnanya gelap). | `index.html` konstanta `COL` | `578b03af0` |
| 9 | Tambah sub-menu **Screening** (Pasar Live) di dropdown avatar. | `public/acct-nav.js` (`pre: '#plSubTerminal'` untuk panel Terminal) | `d4ccc18b8` |

## Keputusan & aturan penting (jangan diubah tanpa diminta)

### Basis periode Tracker = exitDate (perubahan #7)
- `TrackerStats.compute(firm, {dateFilter})` sekarang memfilter `r.exitDate` (rekomendasi yang
  **selesai** di periode itu). Satu aturan untuk Overview Peringkat vs IHSG, Overview Per Firm,
  KPI NET/WIN RATE Analis, dan baris Mode Eksekusi.
- Diverifikasi: 31 firm × 7 periode = 217 kombinasi, **0 selisih**. Contoh BNI Okt 2026: +108,86% (40 trade).
- Yang **tetap basis openDate** (rekomendasi *dirilis* di periode): TOTAL REKOMENDASI, list/tab
  Rekomendasi Sekuritas, grafik harian Analis (`computeFirmDailyEquity` cohort, mark-to-market).
  User sudah diberi tahu dan belum minta diubah.
- TOTAL RETURN Analis = NET (exitDate) + floating SEMUA posisi aktif.

### WhatsApp (perubahan #3)
- Simpan format digit `62812…` (`normalizeWhatsapp` di `contact.js`, cermin `normWa` di popup).
- FAIL-OPEN: kalau D1 error, `whatsapp_missing=false` (user tidak terkunci).
- Saat `whatsapp_missing`, client set `j.tos_accepted=false` supaya panduan & popup PWA menunggu.
- `/api/accept-terms` dengan body `{}` (pemanggilan heal lama) tetap valid: hanya simpan consent.
- Teks Ketentuan poin 4 ditambah "nomor WhatsApp". `TOS_VERSION` **tidak** dinaikkan.
- Tampilan admin/Excel: `+62 812-3456-7890` (berspasi supaya Excel membacanya sebagai teks).

### Menu avatar (`acct-nav.js`)
- Navigasi = klik `.nav-tab` yang sudah ada (showPage, plEnsure, vlEnsureCharts, overlay scope-tracker
  tetap jalan). Sub-menu = klik tombol tab yang ada atau scroll ke kartu. Tidak mengubah logika menu inti.
- Menambah sub-menu baru: edit array `MENU` di `public/acct-nav.js`.

### Chip identitas (`id-sticky.js`)
- Konfigurasi per konteks di array `CONTEXTS` (selector hero + cara baca kode/nama).
- Chip Tracker > Analis yang lama (`#trPfMiniSticky`) tetap dipakai. Modul baru hanya
  menyembunyikannya kalau pane Analis tidak tampil.

### Merge nama firm Tracker
- Alias brand ada di `_FIRM_BRAND_ALIASES` (`build-tracker.js`). Key = signature spaceless
  uppercase. Data mentah Sheet/arsip TIDAK diubah.
- Setelah ubah `build-tracker.js`, trigger refresh:
  `gh api -X POST repos/chamdani49-boop/terminal/actions/workflows/refresh-tracker.yml/dispatches -f ref=main`
  (`gh workflow run` gagal di sandbox karena GH_HOST).

## Info operasional yang ditanyakan user

- **API key Mayar** hanya ada di 1 tempat: secret `MAYAR_API_KEY` di Worker Cloudflare `terminal`.
  Cek dengan `/api/checkout?plan=1bulan&debug=1` (login admin).
  Error `403 API KEY Scope not allowed to write` = key tidak punya izin write. User sudah membuat key baru dengan izin write ("done").
  `MAYAR_WEBHOOK_TOKEN` terpisah.
- **Dividen ITMG masih 2025**: pipeline benar. Sumbernya Excel `data/valuation/401-500_laporan_keuangan.xlsx`
  (upload 24–25 Okt): DPS FY2025 Rp1.730, dividen terakhir Rp992 ex 28 Apr 2026. Data akan update
  setelah user upload Excel baru ke `https://github.com/chamdani49-boop/terminal/upload/main/data/valuation`.
  Workflow `refresh-valuation` membangun ulang Valuasi + `dividends.json` + `screening.json`.
  **Menunggu user upload.**

## Belum dikerjakan / bisa follow-up
1. Grafik harian Analis masih memakai cohort openDate (boleh diseragamkan ke exitDate kalau user minta).
2. TOTAL REKOMENDASI & list rekomendasi masih basis openDate.
3. Verifikasi di situs live dengan akun asli (semua uji sesi ini memakai server lokal + login palsu Playwright).

## Cara uji lokal yang dipakai sesi ini
Server lokal diblokir sandbox. Pakai Playwright `browser_run_code_unsafe` dengan
`page.context().route('http://app.test/**', …)`. Sajikan file via `route.fulfill({path})`, dan mock
`/api/me` (sertakan `whatsapp` supaya popup tidak muncul) serta `/api/admin/*`.
Untuk backend, uji dengan SQLite + skema `migrations/*.sql` dan shim `env.DB.prepare`.
