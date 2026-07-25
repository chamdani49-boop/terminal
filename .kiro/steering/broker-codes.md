---
title: Kode Broker IDX & Kotak Avatar Firm di Tracker
inclusion: manual
---

# Kode Broker IDX — sumber tunggal

## File canonical
- `public/broker-codes.js` — data + helper. **Semua penambahan / edit
  broker terjadi di file ini.** Load blocking di `<head>` public/index.html
  (tanpa defer).

## API yang di-expose
```
window.BrokerCodes.LIST                  // Array<{code, name, foreign}>
window.BrokerCodes.get(firmName)         // Return entry atau null
window.BrokerCodes.getByCode('DR')       // Return entry atau null
window.BrokerCodes.avatar(firmName)      // Return {text, foreign, matched}
```

`avatar(firmName)`:
- Kalau match ketemu: `text` = kode 2 huruf (`'DR'`), `foreign` = true/false,
  `matched` = true.
- Kalau tidak: `text` = inisial nama (fallback), `foreign` = false,
  `matched` = false.

## Cara nambah broker baru
1. Buka `public/broker-codes.js`, tambah 1 entry ke array `LIST`:
   ```js
   { code: 'XX', name: 'NAMA RESMI SEKURITAS', foreign: false }
   ```
   - `code`: 2 huruf uppercase.
   - `name`: nama resmi (uppercase, apa adanya). Boleh sertakan
     `INDONESIA`, `TBK.`, `ASIA` — helper normalisasi akan strip token
     generik saat matching.
   - `foreign`: `true` untuk broker asing → UI render huruf merah.
2. Simpan → refresh halaman. Otomatis terdistribusi.

## Tempat pemakaian di UI (public/index.html, menu Tracker)

Kotak avatar samping nama sekuritas di:

1. **Sub-tab Analis, sidebar Sekuritas** — `.tr-mdet-item .av`
   di dalam `renderSidebar()`.
2. **Sub-tab Analis, heading detail firm (panel kanan)** — `#trPfAv`
   di dalam `populateHero()`.
3. **View Per Firm (leaderboard firm)** — `.tr-lb-av` di dalam
   `renderFirmList()`.

Semua site pola pemakaian sama:
```js
var _bk = window.BrokerCodes && window.BrokerCodes.avatar(firm.name);
var text = _bk ? _bk.text : initials(firm.name);
var cls  = (_bk && _bk.foreign) ? ' brk-foreign' : '';
// render: <div class="av${cls}">${text}</div>
```

## Styling broker asing (huruf merah)
CSS class `.brk-foreign`. Apply ke `.av`, `.tr-lb-av`, `#trPfAv`.
- Default state: `color: var(--red)`.
- Sidebar active (`.tr-mdet-item.active .av.brk-foreign`): `color:#fca5a5`
  (red-300) supaya tetap kebaca di atas gradient purple.

## Kalau butuh render firm avatar di tempat BARU
- Tambahkan class `.brk-foreign` di element yang punya class avatar
  (mis. `.av`, `.tr-lb-av`).
- Kalau class avatar-nya berbeda, tambahkan selector ke CSS block:
  ```css
  .av.brk-foreign,
  .tr-lb-av.brk-foreign,
  #trPfAv.brk-foreign,
  .YOUR-NEW-SELECTOR.brk-foreign { color: var(--red); }
  ```

## Fallback behavior
Kalau firm data tidak match ke broker manapun (misal firm custom /
bukan anggota IDX / typo di data), `avatar()` return inisial nama —
sama seperti perilaku lama sebelum feature ini. Backward-compatible.
