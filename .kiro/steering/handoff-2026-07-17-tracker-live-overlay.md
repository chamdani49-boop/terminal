**Tanggal**: 2026-07-17 · **Commit terakhir**: `176acb4` (merge PR #360)

Rangkuman lengkap sesi 17 Jul 2026 (sore–malam): implementasi **live intraday state overlay** untuk Tracker. Fix kasus "rec yang rilis hari ini selalu stuck MENUNGGU sampai EOD" — dua-lapis: frontend overlay klien-side + backend candle injection via Worker `/live.json`.

---

## 1. Ringkasan commit (kronologis, top = terbaru)

| # | Commit | Ringkasan |
|---|--------|-----------|
| 5 | `176acb4` | Merge PR #360 (backend live candle injection) |
| 4 | `e0a28e3` | build-tracker: switch live source dari gviz direct → Worker `/live.json` |
| 3 | `3974cbe` | build-tracker: inject virtual today candle dari sheet Live (initial: gviz direct) |
| 2 | `07b86fe` | tracker(live): scan missedList + expired guard + sticky MISSED |
| 1 | `12171ca` | tracker(live): fix DATA scope bug + safety-net interval + debug log |
| 0 | `a9a073b` | Merge PR #359 (frontend live overlay awal) |

Selain itu 1 PR sebelumnya:
- **PR #359 → `4d412b0`**: tracker: overlay live state pakai candle intraday hari ini (frontend IIFE awal, ada bug `window.DATA` scope)

---

## 2. Problem awal & root cause

**Contoh kasus (screenshot dari user)**: AMMN OCBC Sekuritas, rilis 17 Jul 2026, entry 3.910, SL 3.860, TP1 4.120. Harga live sudah 3.870 (di bawah entry, mestinya AKTIF atau bahkan SL), tapi badge tetap **MENUNGGU**.

**Akar**: `scripts/build-tracker.js` derivasi state dari `public/ohlc.json` yang di-refresh EOD (~17:00 WIB) via workflow `refresh-ohlc.yml`. Untuk rec dengan `openDate = hari ini`:

```js
const relevant = ohlcEntry.candles.filter(c => c[0] >= openTs);
```

filter ini menghasilkan array kosong (belum ada candle hari ini di ohlc.json) → loop touch-detection tidak jalan → `didTouchEntry: false` → state stays PENDING. Bukti dari tracker.json production sebelum patch:

```json
{
  "id": "AMMN-2026-07-17-553",
  "lastPrice": 3920,
  "lastPriceTime": "2026-07-16T00:00:00.000Z",   ← candle kemarin
  "openPriceAtPublish": null,                    ← belum ada candle hari ini
  "state": "PENDING"
}
```

---

## 3. Arsitektur akhir (2 lapis)

### Lapis 1: Frontend live overlay (defensive, in-memory)

`public/index.html` line ~16040 — IIFE `TRACKER LIVE OVERLAY`:

```
DATA.live[ticker]          ← dari Worker /live.json (60s poll)
  ↓
_synthTodayCandleForRec()  ← bangun virtual candle {ts, open, high, low, close}
  ↓
_recomputeRecState()       ← state machine mini (port derivePosition subset)
  ↓
overlayLiveTrackerState()  ← mutate __TR_DATA__ + pindah bucket
  ↓
window.__TR_rerender()     ← re-invoke updateStatusHint + updateLiveChip +
                             semua __TR_DATA_CALLBACKS__ (Live/Perf/Ringkasan/Analis)
```

**Hooks (3 trigger):**
1. `_pollLiveFeed` success (60s) → `window.__TR_liveOverlay('live-poll')`
2. `__TR_onData` callback saat tracker.json first load → `setTimeout(triggerOverlay('tracker-load'), 150)`
3. Safety-net `setInterval(15s)` → `triggerOverlay('interval')` (jaga-jaga race + tab background)

Debounce 3 detik di `triggerOverlay` supaya tidak overhead.

### Lapis 2: Backend candle injection (persistent, ke tracker.json)

`scripts/build-tracker.js` line ~223 — new IIFE `LIVE OVERLAY`:

```
Worker /live.json (via HMAC token)     ← sumber SAMA dgn frontend
  ↓
fetchLiveMap()                          ← parse json.live
  ↓
buildTodayCandleFromLive()              ← format [ts, o, h, l, c] sama ohlc.json
  ↓
augmentOhlcWithLive()                   ← inject virtual candle ke ohlc.tickers[t].candles
  ↓
derivePosition() (unchanged)            ← otomatis "lihat" candle hari ini
  ↓
tracker.json                            ← state sudah AKTIF/SL/TP untuk rec hari ini
```

Dipanggil di `main()` setelah `loadOhlc()`, sebelum loop `derivePosition`. **State machine tidak dimodifikasi** — dia otomatis handle karena `relevant = candles.filter(c => c[0] >= openTs)` sekarang non-empty.

---

## 4. State machine rules (kesepakatan user)

Encoded di frontend `_recomputeRecState` + backend `derivePosition`:

1. **Belum kena entry/SL/TP1/TP2 sampai 10 hari** → `EXPIRED` (final, pindah ke `historyList`)
2. **Sudah kena entry, belum kena SL/TP1/TP2** → `TRIGGERED` (lanjutkan, tak dibatasi 10 hari — cap horizon 30 hari via backend)
3. **Belum 10 hari, gak kena entry, harga drift >5% dari entry** → `RUNNING_MISSED` (harga lari)

Transisi yg di-handle overlay klien:
- `PENDING` → `TRIGGERED` / `SL_HIT` / `TP_HIT` / `RUNNING_MISSED`
- `TRIGGERED` → `SL_HIT` / `TP_HIT` / partial-TP1 (phase2 trailing SL)
- `RUNNING_MISSED` → `TRIGGERED` (revive kalau harga balik nyentuh entry sebelum 10 hari)

**Sticky MISSED**: rec `RUNNING_MISSED` yang harganya balik dekat entry tapi belum touch → tetap MISSED (tidak flip-flop balik ke PENDING). Cegah UI berkedip antara badge TERLEWAT ↔ MENUNGGU saat harga oscillate di sekitar threshold 5%.

**Expired guard**: rec `PENDING/MISSED` dengan `pendingExpiresAt < today` → overlay skip. Backend akan pindahkan ke `historyList` di refresh berikutnya; sementara itu UI sudah tandai "KADALUARSA" via `__TR_isPendingExpired`. **TRIGGERED tidak kena guard ini** (rule #2 "lanjutkan").

---

## 5. Bug yang di-fix mid-session (jangan diulang!)

**Bug 1: `window.DATA` scope** (initial PR #359, fixed di `12171ca`).
`DATA` di `public/index.html` didefinisikan sebagai `let DATA = null;` di top-level script (line ~15209). **`let` top-level TIDAK membuat properti di window** (beda dgn `var`), sehingga `window.DATA` selalu `undefined`. Awal aku pakai `var DATA = window.DATA;` di IIFE overlay → selalu undefined → overlay TIDAK PERNAH JALAN.

**Fix**: akses `DATA` via lexical closure (IIFE overlay ada di `<script>` yg sama, line 14197–21930). Wrapper `_getData()` dgn try/catch defensive.

**Lesson**: kalau overlay/hook mau akses global variable dari script utama, pastikan itu `var` (window-scoped) atau akses via lexical closure. Sama seperti `_ohlcMergeToday` di frontend yg langsung pakai `DATA` (bukan `window.DATA`) dan bisa jalan di chart popup.

**Bug 2: race condition** (fixed di `12171ca`).
Overlay via hook `_pollLiveFeed` bisa "kelewatan" kalau:
- Tracker.json load duluan → `__TR_onData` fire saat `DATA.live` masih kosong
- Live feed sukses tapi `__TR_DATA__` masih null

**Fix**: safety-net `setInterval(15s)` yang selalu jalan selama page terbuka. Debounce 3s cegah overhead.

---

## 6. Konfigurasi runtime (yang perlu di-set)

### GitHub Secrets (repo Settings → Secrets and variables → Actions)

**`LIVE_TOKEN_SECRET`** — WAJIB kalau mau backend candle injection jalan (PR #360).
- Nilai harus **IDENTIK** dengan yang di-set di:
  - Cloudflare Worker `terminal` (main) — untuk generate token via `/api/live-token`
  - Cloudflare Worker `terminal-live` — untuk verify token
- Copy dari Cloudflare Dashboard → Workers → Settings → Variables
- Kalau kosong: `build-tracker.js` skip augment (log: `ℹ LIVE_TOKEN_SECRET tidak di-set — skip live overlay`). Fallback: overlay klien-side yang handle di UI (tetap benar, cuma ada flicker 1-2s saat cron refresh baseline).

**Optional**: `LIVE_WORKER_URL` — override URL Worker (default hardcoded ke `https://terminal-live.chamdani49.workers.dev/live.json`).

### Cloudflare Workers (sudah ada, tidak perlu ubah)

- `terminal` Worker: `LIVE_TOKEN_SECRET`, `LIVE_SHEET_ID`, `LIVE_GID`
- `terminal-live` Worker: `LIVE_TOKEN_SECRET`, `LIVE_SHEET_ID`, `LIVE_GID`, `CACHE_SECONDS=60`, `STALE_TTL_SECONDS=43200`

---

## 7. Sumber data: pilihan yang dipertimbangkan

Diskusi arsitektur — kenapa akhirnya pilih Worker `/live.json`:

| Opsi | Freshness dari sheet | Latensi | Konsistensi dgn UI | Auth |
|---|---|---|---|---|
| **Gviz direct** | Real-time | ~200-500ms | Bisa berbeda 60s | Zero |
| **Worker `/live.json`** ✅ | Max 60s stale | 50-300ms | **Persis identik** | HMAC token |
| Mirror JSON di CDN | Stale sesuai cron mirror | 30-100ms | Bergantung mirror | Zero |
| Yahoo/EODHD direct | Real-time (bypass sheet) | 200-500ms | Beda dari UI | API key |

**Keputusan**: Worker `/live.json`. Alasan:
- Konsistensi > freshness untuk cron 60-min interval
- Worker punya backup stale 12 jam → resilient thd sheet error
- Kalau sheet format berubah, Worker jadi buffer transformation
- Auth HMAC 15-min token digenerate on-the-fly di script (algo persis dgn `src/index.js` `/api/live-token`)

Format candle output: `[ts_unix_sec, open, high, low, close]` — persis format `ohlc.json`. Open estimated dari `price / (1 + change_pct)`, high = max(open, price), low = min(open, price), close = price. Sama logic dgn frontend `_ohlcMergeToday`.

---

## 8. Guard bursa & session (mirror di frontend & backend)

Virtual today candle HANYA di-inject/di-synthesize kalau:

1. **Hari kerja WIB** (Sen–Jum, `dow >= 1 && dow <= 5`)
2. **Sudah lewat jam buka bursa** (`hour >= 9` WIB)
   - Sebelum 09:00 WIB: harga live masih closing kemarin → candle "hari ini" akan salah
   - **Note**: tidak ada upper bound (jam >16:30 tetap PASS). Setelah bursa tutup, harga live = closing hari ini, jadi virtual candle "hari ini" tetap valid.
3. **Live entry ada** untuk ticker + `price` valid & > 0
4. **`_meta.generated_at` fresh today** (frontend only — cek `DATA._meta.generated_at` == today WIB)
5. **`rec.openDate <= today`** (bukan future rec)
6. **Backend: belum ada candle >= today di `ohlc.json`** (skip duplicate)

---

## 9. Debugging aids

**Console log**:
- Frontend: `[tracker-live] run (reason=live-poll|tracker-load|interval) · updated=N moved=M skipExpired=K · DATA.live keys=X · pending=... open=... missed=... history=...`
- Backend: `✓ Live feed (Worker): N ticker · generated_at=... [STALE?]` + `✓ Live overlay: N ticker di-augment dgn virtual today candle`

**On-screen debug box** (frontend): buka URL dengan `?livedebug=1` atau `localStorage.setItem('livedebug', '1')`. Kotak hitam di bawah dengan trace live.

**Skip reasons** (via `_skipReason` internal): `no-live-<TICKER>` / `not-session (dow=X hour=Y)` / `not-fresh (genWibDay=X today=Y)` / `future-rec`

---

## 10. Verifikasi (offline test harness, 12 skenario pass)

Test scenarios yg sudah verified di sesi ini (mix frontend + backend logic):

**State machine (frontend `_recomputeRecState`):**
- A. PENDING + live 3870 (touch entry 3910) → TRIGGERED (pindah ke openList) ✅
- B. PENDING + live 3855 (touch + kena SL 3860) → SL_HIT (pindah ke historyList) ✅
- C. PENDING + live 3920 (di atas entry, no touch) → tetap PENDING ✅
- D. PENDING + live 4130 (gap-past entry tanpa touch low) → RUNNING_MISSED ✅
- E. TRIGGERED + live 3850 (SL hit setelah trigger) → SL_HIT ✅
- F. PENDING + live 4200 (drift +7.4% tanpa touch) → RUNNING_MISSED ✅
- G. RUNNING_MISSED + touch entry (revive) → TRIGGERED (pindah ke openList) ✅
- H. RUNNING_MISSED + masih lari → sticky MISSED ✅
- I. RUNNING_MISSED + harga balik dekat entry belum touch → sticky MISSED ✅
- J. PENDING dgn pendingExpiresAt 2 hari lalu → SKIP (expired guard) ✅
- K. TRIGGERED dgn pendingExpiresAt lewat → tetap lanjut (rule #2) ✅
- L. PENDING normal + touch → TRIGGERED ✅

**Backend candle injection (`augmentOhlcWithLive`):**
- AMMN live 3880 chg -1.28% → augmented candle 17 Jul O=3930 H=3930 L=3880 C=3880 ✅
- TLKM live 2700 chg +1.89% → augmented candle 17 Jul O=2650 H=2700 L=2650 C=2700 ✅
- Ticker tanpa live entry → skip (unchanged) ✅
- Ticker sudah punya candle hari ini → skip (no duplicate) ✅

**Token roundtrip (build-tracker.js ↔ worker/src/index.js):**
- Generate dgn secret X → verify dgn secret X → PASS ✅
- Generate dgn secret X → verify dgn secret Y → FAIL (sig-mismatch) ✅

---

## 11. Untuk sesi berikutnya

**Sudah tuntas:**
- ✅ Overlay klien-side untuk responsivitas UI real-time
- ✅ Backend inject virtual today candle → tracker.json output benar tanpa nunggu EOD
- ✅ Konsistensi sumber: frontend & backend fetch dari Worker `/live.json` yg sama
- ✅ State rules per aturan user (10 hari expiry, sticky MISSED, revive on touch)
- ✅ Guard defensif (bursa buka, live fresh, openDate, duplicate)

**Yang mungkin perlu tindak lanjut:**
- Verify `LIVE_TOKEN_SECRET` sudah di-set di GitHub Actions. Kalau belum, cron refresh-tracker.yml akan log warning + skip augment (bukan error). Fallback ke overlay klien-side yang jalan sempurna.
- Observe 1-2 refresh cycle setelah merge PR #360 — pastikan tracker.json production sudah punya state benar untuk rec hari ini (bukan cuma di UI overlay).
- Kalau nanti sumber sheet Live upgrade (mis. dari GOOGLEFINANCE 15-min delay ke Yahoo real-time via Apps Script), TIDAK ada perubahan yg diperlukan di code — Worker handle transformasi.

**Yang jangan di-break:**
- Pattern `let DATA = null` di line ~15209 `public/index.html` — akses via lexical scope, JANGAN pakai `window.DATA`.
- `_reinvokeRenderers` di IIFE loadTrackerData (line ~9344) — exposed sebagai `window.__TR_rerender`. Overlay klien-side & future features akan panggil ini untuk re-render setelah mutasi `__TR_DATA__`.
- Format candle `[ts, o, h, l, c]` di `ohlc.json` — kalau diubah, `derivePosition` + `_ohlcMergeToday` + `buildTodayCandleFromLive` semua harus di-update bareng.
- Debounce 3s di `triggerOverlay` — jangan turunin di bawah 1s (bisa bikin re-render spam).

**File utama yg disentuh sesi ini:**
- `public/index.html` (frontend IIFE overlay + fix DATA scope + safety-net + debug)
- `scripts/build-tracker.js` (helper `fetchLiveMap` + `augmentOhlcWithLive` + token gen)
- `.github/workflows/refresh-tracker.yml` (expose secret `LIVE_TOKEN_SECRET`)

**Sumber referensi:**
- Frontend live poll pattern: `_pollLiveFeed()` di line ~15939, `applyLiveFeed()` di line ~15902
- Chart popup synthetic today candle: `_ohlcMergeToday()` di line ~14545 (pattern yang direplika overlay klien-side & backend)
- Worker token verify: `verifyLiveToken()` di `worker/src/index.js` line ~900
- Worker token generate: `/api/live-token` handler di `src/index.js` line ~288

---

## 12. Konteks user preferences (dari diskusi sesi ini)

- User prefer **konsistensi > freshness** untuk backend cron (60s stale acceptable)
- User prefer **single source of truth** — frontend & backend fetch dari endpoint yang sama
- User comfortable dengan **push langsung ke main** untuk fix cepat (kecuali file CI/workflow yg butuh PR)
- User pattern communication: casual Indonesian, "gas", "sudah merge", "langsung taruh main"
- User aware Cloudflare Workers ecosystem, tidak perlu diedukasi soal edge cache/HMAC
