# Handoff — Aktivasi Paket Tracker Rp 149rb + scope enforcement full-stack
**Tanggal**: 2026-07-17 · **Commit terakhir**: `0d16876`

Rangkuman lengkap sesi 17 Jul 2026: aktivasi paket Tracker Rp 149rb (`plan='1bulan'`) di `/billing` DAN enforcement scope-only (`scope='tracker'`) sehingga buyer paket ini HANYA bisa akses menu Tracker — tidak boleh Valuasi/Consensus/Pasar Live/dll.

---

## 1. Ringkasan commit (kronologis, top = terbaru)

| # | Commit | Ringkasan |
|---|--------|-----------|
| 3 | `0d16876` | billing: bersihkan fallback pre-render Paket Tracker — hilangkan `plan-soon` class + badge "SEGERA HADIR" (FOUC fix) |
| 2 | `36d3e2d` | billing(scope): aktivasi Paket Tracker Rp 149rb + enforcement scope-only full-stack (9 files) |
| 1 | `29d11bd` | migration(0009): `ADD COLUMN scope` di `subscriptions` — prep aktivasi 149k |

Push dilakukan dalam **2 tahap** dgn user action di antara (bukan 1 push single):

**Tahap 1** (commit `29d11bd`): Migration D1 only.
- User buka Cloudflare Dashboard → D1 → `terminal-db` → Console → jalankan `migrations/0009_scope.sql`
- Hasil: 350 rows existing dapat `scope='full'` default + index `idx_sub_scope` created
- User confirm via screenshot: "SUKSES"

**Tahap 2** (commit `36d3e2d` + hotfix `0d16876`): Code changes yang bergantung pada kolom `scope` sudah ada di DB.

Alasan split: kalau code + migration dalam 1 push, ada window "code deployed but migration not run" — buyer 149k akan dapat FULL ACCESS karena `sub.scope` = undefined (bukan 'tracker'). Split menghindari race condition.

---

## 2. State akhir setelah Tahap 2

### Backend (Worker)

**`src/lib/db.js`:**
- `normalizeScope(v)` — jaring nilai kotor, hanya return `'tracker'|'full'`
- `activateSubscription(env, uid, plan, days, source, txnId, scope=null)` — parameter `scope` ADDED
  - `scope=null` (renewal safety) → pertahankan scope existing (kalau ada) atau default `'full'`
  - `scope='tracker'` → paksa tracker-only
  - `scope='full'` → paksa full access
  - INSERT & UPDATE query include kolom `scope`
- `adminExtendDays(email, days, planOverride, scopeOverride)` — pass through
- `adminSetDays(email, days, planOverride, scopeOverride)` — pass through, sama pattern renewal safety
- `listUsersWithSub()` — SELECT `s.scope AS scope`, return `scope` field per user (null kalau belum langganan)

**`src/lib/mayar.js`:**
- `planScope(plan)` — `'1bulan' → 'tracker'`, selain itu `'full'`
- `webhook()` — activateSubscription() dipanggil dgn `planScope(plan)` sbg parameter ke-7 → buyer via Mayar auto-set scope sesuai paket

**`src/lib/admin.js`:**
- `/api/admin/users/extend` parse `body.scope` (`'tracker'|'full'|undefined`)
  - undefined → renewal safety (pertahankan existing)
- Forward ke `adminSetDays` / `adminExtendDays`

**`src/index.js`:**
- `PROTECTED_PREFIXES` — `/tracker.json` DITAMBAHKAN
- `TRACKER_SCOPE_ALLOWED = ['/dashboard', '/data.json', '/tracker.json']` — whitelist path yg boleh diakses user scope='tracker'
  - `/dashboard` — SPA shell
  - `/data.json` — ticker names + IHSG series (dipakai Tracker chart)
  - `/tracker.json` — data utama Tracker
  - PATH LAIN di PROTECTED_PREFIXES (valuation, ohlc, macro, insights, headlines) → 402 upgrade_required
- `guardProtected()` — fetch `sub` sekali (bukan hanya boolean allowed), cek scope:
  - `sub.scope === 'tracker'` + path bukan di whitelist → 402 `{error, upgrade_required:true, current_scope:'tracker'}`
  - Admin skip semua enforcement
- `/api/me` return `subscription.scope` (`'full'` default kalau kolom null di DB)

**`wrangler.toml`:**
- `run_worker_first` ditambah `/tracker.json` — supaya guardProtected() eksekusi (kalau tidak listed, asset di-serve langsung tanpa lewat Worker → scope check bypass)

**`src/lib/billing.js`:**
- DEFAULT_BILLING.plans['1bulan']:
  - `comingSoon: true → false`
  - `btnText: 'Segera Hadir' → 'Langganan Tracker 1 Bulan'`
  - `sub`: hilangkan "(segera hadir)"
- Comment di header diupdate untuk mencerminkan status AKTIF

### Frontend user (`public/index.html`)

**`_ensureAccess()`** (baris ~15484):
- Baca `j.subscription.scope` dari `/api/me`
- Kalau `scope === 'tracker'` && !`is_admin`:
  - `document.body.classList.add('scope-tracker')`
  - Auto-navigate ke page Tracker: `showPage('tracker')` dipanggil **3x** (sync + 200ms + 800ms) — supaya menang dari logika restore last-tab yg mungkin jalan setelahnya
- `window.__ES_SCOPE = scope || 'full'` — exposed utk debugging

**CSS `body.scope-tracker`** (baris ~2612, dekat komentar `.tr-menu display gating`):
```css
body.scope-tracker .nav-tabs .nav-tab:not(.tr-menu){display:none !important}
body.scope-tracker .bottom-nav-item:not(.tr-menu){display:none !important}
body.scope-tracker .search-wrap{display:none !important}
body.scope-tracker .nav-tabs .nav-tab.tr-menu{font-weight:700}
```
Rationale: user scope='tracker' hanya perlu lihat tab Tracker. Search bar disembunyikan karena redirect ke Valuasi/Consensus yg gak boleh diakses. CSS = UI hint saja, backend tetap protect (defense in depth).

### Frontend billing (`public/billing.html`)

- **Fallback pre-render** tier-tracker: hapus class `plan-soon` + badge `<div class="plan-soon-badge">SEGERA HADIR</div>` (commit `0d16876`)
- Fallback tombol: `class="btn-pay outline" data-plan="1bulan">Langganan Tracker 1 Bulan`
- JS renderer `renderPlan()` di line ~774 tetap baca `pl.comingSoon` dari config API → kalau backend return `false`, JS render clean. Fallback adalah safety net kalau JS lambat.

### Frontend admin (`public/admin.html`)

**Table user (line ~720):**
- Pill paket `'1bulan'` pakai class `plan1` (kuning)
- Badge scope `🎯 Tracker` (pill kuning, `.pill.scope-tracker`) muncul di samping pill paket bila `u.scope === 'tracker'`
- `USERS.map` include field `scope`

**Modal Perpanjang (line ~458):**
- Opsi durasi baru dgn data attrs:
  ```html
  <option value="30" data-plan="1bulan" data-scope="tracker">1 Bulan (Tracker Rp 149rb)</option>
  <option value="90" data-plan="3bulan" data-scope="full">3 Bulan (Full)</option>
  <option value="182" data-plan="6bulan" data-scope="full">6 Bulan (Full)</option>
  <option value="365" data-plan="tahunan" data-scope="full">1 Tahun (Full)</option>
  ```
  (opsi 1/3/7 hari tidak punya data-scope → biarkan pilihan manual / renewal safety)
- Radio Scope: `🔓 Full Akses` vs `🎯 Tracker saja`
- `_syncExtScopeFromOption()` — helper auto-sync radio dari `data-scope` opsi (skip kalau opsi tidak punya)
- `openExtendModal(email)`:
  - Kalau user existing scope='tracker' → pre-select radio tracker (renewal safety, jangan keliru upgrade)
  - Else → sync dari opsi default (30 hari → tracker)
- `extSelect.change` → `_syncExtScopeFromOption()`
- `extConfirm` include `scope` di POST body

**Config paket (line ~589):**
```js
var PRICE={'1bulan':149000,'3bulan':699000,'6bulan':997000,'tahunan':1750000};
var PLAN_LABEL={'1bulan':'1 Bulan','3bulan':'3 Bulan','6bulan':'6 Bulan','tahunan':'Tahunan','custom':'Custom','-':'—'};
var PLAN_DAYS={'1bulan':30,'3bulan':90,'6bulan':182,'tahunan':365};
```

**Editor Billing (line ~939):**
- `BILL_PLANS = ['1bulan','3bulan','6bulan','tahunan']`
- `BILL_PLAN_LABEL['1bulan'] = 'Paket Tracker 1 Bulan'`
- `BILL_MONTHS['1bulan'] = 1`
- `bfFeatured` dropdown tambah `<option value="1bulan">1 Bulan (Tracker)</option>`

**CSS (line ~116):**
```css
.pill.plan1{background:var(--yellow-bg);color:var(--yellow)}       /* Paket 149rb */
.pill.scope-tracker{background:var(--yellow-bg);color:var(--yellow);margin-left:4px;font-size:11px;padding:3px 8px}
```

---

## 3. Keputusan penting (decision log)

### A. Split 2 push (bukan 1 push single)
- **Chosen**: migration terpisah (Tahap 1) → user action → code changes (Tahap 2)
- **Rejected**: 
  - defensive `try/catch` around scope SQL — kompleks + tetap ada risk buyer window
  - `hasScopeColumn()` PRAGMA check every call — overhead + caching issues
- **Reason**: dalam window "code deployed but migration not run", buyer 149k akan dapat full access — violate user requirement strict scope='tracker' dari day 1

### B. TRACKER_SCOPE_ALLOWED whitelist
- **Chosen**: `['/dashboard', '/data.json', '/tracker.json']`
- **Rejected**: `['/tracker.json']` only → tracker page broken tanpa data.json (butuh ticker names + IHSG series)
- **Reason**: SPA architecture — user butuh `/dashboard` HTML shell, page Tracker butuh 2 data source

### C. Renewal safety pattern (scope=null → pertahankan existing)
- **Chosen**: `activateSubscription(...scope=null)` → pertahankan scope existing (kalau ada) atau `'full'` (baru)
- **Reason**: admin yg cuma mau extend user tracker jangan keliru upgrade ke full. Sebaliknya juga true. Pattern konsisten di `adminExtendDays` & `adminSetDays`.

### D. `showPage('tracker')` 3x call (sync + 200ms + 800ms)
- **Chosen**: multiple call
- **Reason**: `_ensureAccess()` bisa jalan sebelum `showPage()` ter-define; logika restore last-tab mungkin jalan setelah _ensureAccess. Multiple call memastikan akhirnya menang.

### E. Radio scope di modal admin (bukan sync otomatis paksa)
- **Chosen**: auto-sync dari `data-scope` opsi + BISA di-override manual
- **Rejected**: paksa scope sesuai plan tanpa opsi override
- **Reason**: fleksibilitas — admin mungkin mau kasih Full Access 30 hari untuk user special (trial extended, gift, dll)

### F. CSS enforcement (UI hint) + backend enforcement (source of truth)
- **Chosen**: DUA lapis. CSS hide tab supaya user tidak lihat tombol yg gak boleh diklik. Backend 402 kalau di-bypass (curl, dev tools, dll)
- **Reason**: defense in depth. Backend ADALAH source of truth. CSS untuk UX (jangan tampilkan tombol yg gak boleh).

---

## 4. Blocker/issue yang belum tuntas

### 🚨 CRITICAL: Deployment belum otomatis

**Fakta:**
- Site pakai **Cloudflare Workers with Static Assets** (`main = "src/index.js"` + `[assets]` binding)
- Repo TIDAK punya GitHub Action untuk deploy Worker terminal (workflows yg ada semua tentang data refresh, bukan deploy)
- Push ke `main` **TIDAK** auto-update Worker code

**User feedback terakhir:** "di paket 149k tombolnya belum aktif"
- Kemungkinan penyebab: Worker belum di-redeploy dgn code baru dari commit `36d3e2d`
- Fallback HTML sudah aku bersihkan di `0d16876` untuk safety, tapi ini sekedar mengurangi FOUC, bukan fix utama

**Yang perlu user lakukan:**
1. Hard-refresh `/billing` (Ctrl+Shift+R)
2. Kalau tombol masih "Segera Hadir": cek Cloudflare Dashboard → Workers & Pages → `terminal` → Deployments
3. Kalau tidak ada Git integration → deploy manual: `npx wrangler deploy` di root repo

**Belum dijawab user:** Bagaimana biasanya user deploy Worker `terminal`? (Wrangler manual, Cloudflare Workers Builds, atau ada mekanisme lain?)

Berbeda dgn `terminal-live` Worker (di folder `worker/`) yg `SESSION-HANDOFF.md` bilang deploy manual `cd worker && npx wrangler deploy`.

---

## 5. Testing checklist (untuk user, setelah Worker di-deploy)

1. **Fresh billing page** — buka `/billing` (hard-refresh):
   - [ ] Card Paket Tracker Rp 149rb tampil paling kiri
   - [ ] Tombol biru "Langganan Tracker 1 Bulan" (bukan "Segera Hadir")
   - [ ] Tidak ada badge "SEGERA HADIR" di kanan atas card
   - [ ] Klik tombol → redirect ke Mayar checkout

2. **Admin grant Tracker scope** (rekomendasi test cepat tanpa bayar):
   - Buka `/admin` → cari user test → klik 🔁 Perpanjang
   - Modal: pilih "1 Bulan (Tracker Rp 149rb)" → scope radio auto pindah ke 🎯 Tracker
   - Konfirmasi → tabel refresh: badge `🎯 Tracker` (kuning) muncul di samping pill paket

3. **Login sbg user test scope='tracker'**:
   - [ ] Redirect otomatis ke tab Tracker (bukan Dashboard)
   - [ ] Nav-tab desktop: HANYA "Tracker" yg tampil, Pasar Live/Dashboard/Valuasi/Consensus HILANG
   - [ ] Bottom-nav mobile: sama, hanya Tracker
   - [ ] Search bar hilang
   - [ ] Klik area lain (misal via bookmark ke `/dashboard`) → SPA tampil, tapi tab Tracker tetap terpilih

4. **Backend enforcement** (test via URL langsung):
   - [ ] `curl /valuation.json` (sambil login sbg tracker user) → 402 `{"error":"...","upgrade_required":true,"current_scope":"tracker"}`
   - [ ] `curl /tracker.json` → 200 (data)
   - [ ] `curl /data.json` → 200 (data)
   - [ ] `curl /macro.json` → 402

5. **Upgrade ke Full** (via admin):
   - Modal Perpanjang → pilih "3 Bulan (Full)" → scope auto ke 🔓 Full → konfirmasi
   - User reload → semua tab kembali tampil, semua endpoint accessible

6. **Renewal safety** (test kritikal):
   - User existing scope='tracker' → admin klik perpanjang → pilih durasi manual 7 hari (opsi tanpa data-scope)
   - Radio scope: **HARUS pre-select ke 🎯 Tracker** (karena user existing tracker)
   - Kalau admin submit tanpa ubah → scope tetap tracker (bukan keliru upgrade ke full)

---

## 6. Hal-hal yang saya SUDAH edit (di working tree, sudah di-push)

File yang berubah di commit `36d3e2d` (9 files):
- `src/lib/db.js`
- `src/lib/mayar.js`
- `src/lib/admin.js`
- `src/index.js`
- `src/lib/billing.js`
- `wrangler.toml`
- `public/index.html`
- `public/admin.html`
- `public/billing.html`

File yang berubah di commit `0d16876` (1 file):
- `public/billing.html` (fallback HTML cleanup)

Migration di commit `29d11bd`:
- `migrations/0009_scope.sql`

---

## 7. Konteks dari sesi sebelumnya (yg penting utk lanjutan)

- **Text badge tier VIP**: "GRATIS SPECIAL" (final, setelah eksperimen "GRATIS BERSYARAT" → "BONUS NASABAH" → "GRATIS SPECIAL")
- **Audience tags per plan** (commit `88d4f9d`, sesi sebelumnya):
  - Tracker (1bulan): `['Trader','Spekulan']`
  - Premium (3/6/tahunan): `['Investor','Swing Trader','Trader','Spekulan','Investor Dividen']`
  - Elite: no audience (segmen khusus nasabah)
- **Nomor WA Elite Investor**: `6289654619822`
- **Tab default Tracker**: Overview (bukan restore last)
- **Admin email**: `chamdani49@gmail.com` (hanya 1)
- **Mayar API mode**: invoice ad-hoc via API, tidak perlu produk pre-created di dashboard Mayar. Env var `MAYAR_API_KEY` sudah aktif → checkout otomatis buat invoice via API.

---

## 8. Push git pattern yg WORKS di repo ini

Bot data-refresh commit ke `main` tiap ~5 menit → `git push` sering dapat `[rejected] main -> main (fetch first)`.

**Solusi yg terbukti works** (sudah aku pakai berulang sesi ini):
```bash
git commit -m "..."
# Coba push via kiro_powers github push_to_remote
# Kalau rejected:
git fetch origin main --quiet
git rebase origin/main
# Retry push via kiro_powers
```

Atau di kiro_powers, kalau rejected pertama → langsung fetch+rebase → retry. Biasanya berhasil di attempt kedua.

Kadang bahkan tanpa rebase, retry langsung juga sukses (race condition sudah lewat).

---

## 9. Next actions saat sesi baru dimulai

1. **KONFIRMASI ke user**: apakah Worker `terminal` sudah di-deploy setelah push `36d3e2d`?
   - Kalau BELUM → arahkan user cara deploy (wrangler deploy atau Cloudflare Dashboard git integration)
   - Kalau SUDAH → skip ke langkah 2
2. **Testing verify**: user hard-refresh `/billing`, cek tombol 149k aktif
3. **User grant Tracker scope** ke user test → verify UI enforcement (tab hide, auto-nav ke Tracker, dll)
4. **User verify backend enforcement** via URL langsung ke `/valuation.json` (harus 402 upgrade_required)
5. Kalau semua OK → session ini SELESAI, move on ke feature berikutnya
6. Kalau ada bug → debug per kasus, patch, push, minta user re-deploy

---

## 10. Ref file penting

- `/projects/sandbox/terminal/migrations/0009_scope.sql` — migration D1
- `/projects/sandbox/terminal/src/lib/db.js` — scope helper functions (baris 55 `normalizeScope`, 70 `activateSubscription`)
- `/projects/sandbox/terminal/src/lib/mayar.js` — `planScope()` di baris ~56
- `/projects/sandbox/terminal/src/index.js` — `TRACKER_SCOPE_ALLOWED` di baris 34, `guardProtected()` scope check di baris ~123
- `/projects/sandbox/terminal/public/index.html` — `_ensureAccess()` scope handling di baris ~15505, CSS `body.scope-tracker` di baris ~2612
- `/projects/sandbox/terminal/public/admin.html` — modal Perpanjang di baris ~458, `_syncExtScopeFromOption` di baris ~825
- `/projects/sandbox/terminal/public/billing.html` — fallback tier-tracker di baris ~455 (sudah dibersihkan)

Semua pattern sudah terjaga: renewal safety, admin skip enforcement, CSS+backend dual layer. Handoff done.
