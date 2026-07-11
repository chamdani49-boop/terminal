/**
 * tracker-input — Cloudflare Worker
 *
 * Halaman web SEDERHANA untuk kontributor submit rekomendasi trading (menu
 * Tracker). Alur:
 *   Login password → isi form → POST /api/submit → Worker teruskan ke Google
 *   Apps Script (GAS) Web App → GAS append 1 baris ke Google Sheet "Tracker"
 *   dengan status "pending" (menunggu approve owner).
 *
 * TERISOLASI: worker ini terpisah total dari site utama & terminal-live.
 * Tidak menyentuh apa pun yang sudah live.
 *
 * Env yang dibutuhkan:
 *   - APP_PASSWORD (secret) — password login kontributor
 *   - GAS_URL      (secret) — URL Web App GAS (…/exec)
 *   - GAS_TOKEN    (secret) — token yg dicocokkan GAS (= TOKEN di gas/Code.gs)
 *   - APP_TITLE    (var)    — judul halaman (kosmetik)
 */

const COOKIE_NAME = 'ti_auth';
const COOKIE_MAX_AGE = 60 * 60 * 12; // 12 jam

const TIPE_OPTS = ['BUY', 'SELL'];
// Horizon/timeframe rekomendasi (opsional): 1 hari … 1 tahun.
const HORIZON_OPTS = ['1H', '1M', '1Bln', '3Bln', '6Bln', '1Th'];
const HORIZON_LABEL = {
  '1H': '1 Hari', '1M': '1 Minggu', '1Bln': '1 Bulan',
  '3Bln': '3 Bulan', '6Bln': '6 Bulan', '1Th': '1 Tahun',
};

// ── Helpers ────────────────────────────────────────────────────────────

async function sha256Hex(s) {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function expectedToken(env) {
  // Token cookie = hash dari APP_PASSWORD. Ganti password → sesi lama invalid.
  return sha256Hex('tracker-input:v1:' + (env.APP_PASSWORD || ''));
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}

async function isAuthed(request, env) {
  const tok = readCookie(request, COOKIE_NAME);
  if (!tok) return false;
  return tok === await expectedToken(env);
}

async function authCookieHeader(env) {
  const tok = await expectedToken(env);
  return `${COOKIE_NAME}=${encodeURIComponent(tok)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
}

function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// Kirim foto ke Telegram (album bila >1) untuk validasi admin. Foto TIDAK
// disimpan di mana pun — hanya diteruskan ke chat admin. Butuh secret
// TELEGRAM_BOT_TOKEN & TELEGRAM_CHAT_ID (nilai sama dgn worker terminal).
async function sendPhotosTelegram(env, photos, caption) {
  const token = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return { sent: 0, skipped: true, reason: 'telegram belum di-set' };

  // data URL / base64 → Uint8Array
  const toBytes = (dataUrl) => {
    const b64 = String(dataUrl).replace(/^data:[^,]*,/, '');
    let bin;
    try { bin = atob(b64); } catch (_) { return new Uint8Array(0); }
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  };

  try {
    const items = photos.slice(0, 5).map(toBytes).filter(a => a.length > 0);
    if (!items.length) return { sent: 0 };

    if (items.length === 1) {
      const fd = new FormData();
      fd.append('chat_id', chatId);
      fd.append('caption', caption);
      fd.append('parse_mode', 'HTML');
      fd.append('photo', new Blob([items[0]], { type: 'image/jpeg' }), 'signal.jpg');
      const r = await fetch('https://api.telegram.org/bot' + token + '/sendPhoto', { method: 'POST', body: fd });
      return { sent: r.ok ? 1 : 0, ok: r.ok };
    }

    const fd = new FormData();
    fd.append('chat_id', chatId);
    const media = items.map((_, i) => Object.assign(
      { type: 'photo', media: 'attach://f' + i },
      i === 0 ? { caption, parse_mode: 'HTML' } : {}
    ));
    fd.append('media', JSON.stringify(media));
    items.forEach((a, i) => fd.append('f' + i, new Blob([a], { type: 'image/jpeg' }), 'f' + i + '.jpg'));
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMediaGroup', { method: 'POST', body: fd });
    return { sent: r.ok ? items.length : 0, ok: r.ok };
  } catch (e) {
    return { sent: 0, error: String((e && e.message) || e) };
  }
}

// ── Handlers ────────────────────────────────────────────────────────────

async function handleLogin(request, env) {
  const form = await request.formData();
  const password = form.get('password') || '';
  if (!env.APP_PASSWORD) {
    return htmlRes(renderLoginPage(env, 'APP_PASSWORD belum di-set di Worker secret.'), 500);
  }
  if (password !== env.APP_PASSWORD) {
    return htmlRes(renderLoginPage(env, 'Password salah.'), 401);
  }
  return new Response(null, {
    status: 303,
    headers: { 'Location': '/', 'Set-Cookie': await authCookieHeader(env) },
  });
}

function handleLogout() {
  return new Response(null, {
    status: 303,
    headers: { 'Location': '/', 'Set-Cookie': clearCookieHeader() },
  });
}

async function apiSubmit(request, env) {
  if (!env.GAS_URL || !env.GAS_TOKEN) {
    return jsonRes({ error: 'GAS_URL / GAS_TOKEN belum di-set di Worker secret.' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (_) { return jsonRes({ error: 'Body bukan JSON valid.' }, 400); }

  // ── Validasi field wajib ──
  const analis = String(body.analis || '').trim();
  const ticker = String(body.ticker || '').trim().toUpperCase();
  const tipe   = String(body.tipe || '').trim().toUpperCase();
  const entry  = Number(body.entry);
  const tp1    = Number(body.tp1);
  const tp2raw = String(body.tp2 == null ? '' : body.tp2).trim();
  const tp2    = tp2raw === '' ? null : Number(tp2raw);   // TP2 opsional
  const sl     = Number(body.sl);
  const tanggal = String(body.tanggal || '').trim();

  const errs = [];
  if (!analis) errs.push('Nama analis wajib diisi.');
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) errs.push('Kode saham tidak valid.');
  if (!TIPE_OPTS.includes(tipe)) errs.push('Tipe harus BUY atau SELL.');
  if (!(entry > 0)) errs.push('Entry harus angka > 0.');
  if (!(tp1 > 0)) errs.push('Target 1 (TP1) harus angka > 0.');
  if (tp2 !== null && !(tp2 > 0)) errs.push('Target 2 (TP2) harus angka > 0 bila diisi.');
  if (!(sl > 0)) errs.push('Stop Loss (SL) harus angka > 0.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) errs.push('Tanggal harus format YYYY-MM-DD.');
  // Sanity arah TP/SL relatif entry (TP2 harus lebih jauh dari TP1).
  if (entry > 0 && tp1 > 0 && sl > 0) {
    if (tipe === 'BUY') {
      if (!(tp1 > entry && sl < entry)) errs.push('Untuk BUY: TP1 harus di atas Entry, SL di bawah Entry.');
      if (tp2 !== null && !(tp2 > tp1)) errs.push('Untuk BUY: TP2 harus di atas TP1.');
    }
    if (tipe === 'SELL') {
      if (!(tp1 < entry && sl > entry)) errs.push('Untuk SELL: TP1 harus di bawah Entry, SL di atas Entry.');
      if (tp2 !== null && !(tp2 < tp1)) errs.push('Untuk SELL: TP2 harus di bawah TP1.');
    }
  }
  if (errs.length) return jsonRes({ error: errs.join(' ') }, 400);

  const horizon = HORIZON_OPTS.includes(String(body.horizon)) ? String(body.horizon) : '';

  const payload = {
    token: env.GAS_TOKEN,
    analis,
    firm: String(body.firm || '').trim(),
    sertifikasi: String(body.sertifikasi || '').trim(),
    ticker,
    tipe,
    entry,
    tp1,
    tp2: tp2 == null ? '' : tp2,
    sl,
    tanggal,
    horizon,
    catatan: String(body.catatan || '').trim().slice(0, 500),
    submitted_by: String(body.submitted_by || '').trim().slice(0, 60),
  };

  // ── Teruskan ke GAS (server-side → tidak ada isu CORS di browser) ──
  let gasRes, gasText;
  try {
    gasRes = await fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    gasText = await gasRes.text();
  } catch (e) {
    return jsonRes({ error: 'Gagal menghubungi GAS: ' + (e && e.message || e) }, 502);
  }

  let gasBody = null;
  try { gasBody = JSON.parse(gasText); } catch (_) { gasBody = { _raw: gasText }; }

  if (!gasRes.ok || !gasBody || gasBody.ok !== true) {
    return jsonRes({ error: (gasBody && gasBody.error) || ('GAS menolak (HTTP ' + gasRes.status + ')'), detail: gasBody }, 502);
  }

  // ── Kirim foto ke Telegram utk validasi admin (best-effort; foto TIDAK disimpan) ──
  let photoStatus = { sent: 0 };
  try {
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 5) : [];
    if (photos.length) {
      const caption =
        '🆕 <b>Rekomendasi Tracker</b> (pending)\n' +
        tipe + ' <b>' + escapeHtml(ticker) + '</b>\n' +
        'Entry ' + entry + ' · TP1 ' + tp1 + (tp2 != null ? ' · TP2 ' + tp2 : '') + ' · SL ' + sl + '\n' +
        'Analis: ' + escapeHtml(analis) + (payload.submitted_by ? ' · oleh: ' + escapeHtml(payload.submitted_by) : '') + ' · ' + tanggal;
      photoStatus = await sendPhotosTelegram(env, photos, caption);
    }
  } catch (_) { /* jangan gagalkan submit hanya karena Telegram */ }

  return jsonRes({ ok: true, ticker, tipe, photos: photoStatus });
}

// ── HTML ─────────────────────────────────────────────────────────────

function htmlRes(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  });
}

// Tema disamakan dgn terminal (ungu gelap) supaya konsisten.
const STYLE = `
<style>
  :root{
    --bg:#0b0a23; --bg2:#161434; --card:#1a1840; --border:#2a2856;
    --text:#e8e6f5; --text2:#a09cc3; --text3:#6e6890;
    --accent:#7c3aed; --accent2:#a78bfa;
    --green:#10b981; --red:#ef4444; --yellow:#f59e0b;
    --radius:10px; --radius-pill:999px;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;min-height:100vh;padding:24px 16px}
  .wrap{max-width:560px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;margin-bottom:16px}
  h1{margin:0 0 4px;font-size:22px;font-weight:700;letter-spacing:.3px}
  .sub{color:var(--text2);font-size:13px;margin-bottom:18px}
  label{display:block;font-size:12px;color:var(--text2);margin-bottom:6px;font-weight:600;letter-spacing:.4px}
  .req::after{content:" *";color:var(--red)}
  input,select,textarea{width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px;outline:none;transition:border-color .2s, box-shadow .2s;font-family:inherit}
  input:focus,select:focus,textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(124,58,237,.18)}
  textarea{resize:vertical;min-height:64px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
  .field{margin-bottom:14px}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:11px 16px;font-size:14px;font-weight:700;cursor:pointer;transition:background .2s, transform .1s;text-decoration:none;width:100%}
  .btn:hover{background:var(--accent2)}
  .btn:active{transform:scale(.98)}
  .btn[disabled]{opacity:.5;cursor:not-allowed}
  .btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text2);width:auto;padding:8px 14px;font-size:13px}
  .btn-ghost:hover{background:var(--bg2);color:var(--text)}
  .err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px}
  .ok{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:#6ee7b7;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13.5px}
  .info{background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3);color:var(--accent2);border-radius:8px;padding:10px 12px;margin-bottom:16px;font-size:12.5px;line-height:1.6}
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;flex-wrap:wrap}
  .small{font-size:11px;color:var(--text3);text-align:center;margin-top:14px}
  .hint{font-size:11px;color:var(--text3);margin-top:4px}
  code{background:var(--bg2);padding:1px 6px;border-radius:4px;font-size:12px;font-family:ui-monospace,monospace;color:var(--accent2)}
  .btn-sec{background:var(--bg2);border:1px solid var(--border);color:var(--accent2);width:auto;padding:9px 14px;font-size:13px;font-weight:700;border-radius:8px;cursor:pointer}
  .btn-sec:hover{background:var(--card);color:var(--text)}
  .photo-drop{display:block;border:1px dashed var(--border);border-radius:8px;padding:14px;text-align:center;color:var(--text2);cursor:pointer;font-size:13px;background:var(--bg2)}
  .photo-drop:hover{border-color:var(--accent);color:var(--text)}
  .thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .thumb{position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid var(--border);background:var(--bg2)}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .thumb-x{position:absolute;top:2px;right:2px;width:18px;height:18px;border-radius:50%;background:rgba(0,0,0,.65);color:#fff;border:0;cursor:pointer;font-size:11px;line-height:18px;padding:0;text-align:center}
  @media(max-width:480px){.grid3{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}}
</style>
`;

function renderLoginPage(env, error) {
  const title = escapeHtml(env.APP_TITLE || 'Input Rekomendasi Tracker');
  const errHtml = error ? `<div class="err">${escapeHtml(error)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login · ${title}</title>
${STYLE}
</head><body>
<div class="wrap" style="max-width:380px;margin-top:70px">
  <div class="card">
    <h1>${title}</h1>
    <div class="sub">Masukkan password untuk mulai submit rekomendasi.</div>
    ${errHtml}
    <form method="POST" action="/login">
      <div class="field">
        <label for="pw">Password</label>
        <input id="pw" name="password" type="password" autofocus required>
      </div>
      <button class="btn" type="submit">Masuk</button>
    </form>
  </div>
  <div class="small">Password diberikan oleh admin.</div>
</div>
</body></html>`;
}

function renderFormPage(env) {
  const title = escapeHtml(env.APP_TITLE || 'Input Rekomendasi Tracker');
  const today = new Date().toISOString().slice(0, 10);
  const tipeOpts = TIPE_OPTS.map(t => `<option value="${t}">${t}</option>`).join('');
  const horizonOpts = ['<option value="">— (opsional)</option>']
    .concat(HORIZON_OPTS.map(h => `<option value="${h}">${escapeHtml(HORIZON_LABEL[h])}</option>`))
    .join('');
  // Prompt untuk Gemini/ChatGPT — dirender langsung ke HTML (server-side) supaya
  // SELALU tampil, tidak bergantung JS. Dipakai juga oleh tombol Salin Prompt.
  const aiPromptText = [
    'Baca screenshot rekomendasi saham ini. Tulis ULANG datanya PERSIS dengan format label di bawah (satu per baris), tanpa kalimat lain. Kosongkan (biarkan kosong setelah titik dua) bila datanya memang tidak ada di gambar.',
    '',
    'Analis: <nama analis / sumber sinyal>',
    'Firm: <sekuritas / komunitas, bila ada>',
    'Tanggal: <tanggal rilis, format YYYY-MM-DD>',
    'Tipe: <BUY atau SELL>',
    'Saham: <kode saham, mis. BBCA>',
    'Entry: <harga masuk>',
    'TP1: <target pertama/terdekat>',
    'TP2: <target kedua, bila ada>',
    'SL: <stop loss>',
    'Catatan: <alasan/tesis singkat, bila ada>',
    '',
    'Aturan harga: tulis angka polos tanpa pemisah ribuan (contoh: 9500, bukan 9.500).'
  ].join('\n');
  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${STYLE}
</head><body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>${title}</h1>
      <div class="sub">Isi rekomendasi trading. Setelah submit, menunggu <b>approve admin</b> sebelum tampil.</div>
    </div>
    <a href="/logout" class="btn btn-ghost">Keluar</a>
  </div>

  <div class="card">
    <div style="font-weight:700;margin-bottom:6px">⚡ Tempel &amp; Parse <span style="color:var(--text3);font-weight:500;font-size:11px">(cara cepat)</span></div>
    <div class="hint" style="margin-bottom:8px">Punya screenshot sinyal? <b>1)</b> Salin prompt di bawah → <b>2)</b> buka Gemini/ChatGPT (akunmu sendiri) → <b>3)</b> di sana upload foto + tempel prompt → <b>4)</b> salin hasilnya → tempel ke kotak "Tempel &amp; Parse" di bawah. Atau ketik manual.</div>
    <textarea id="aiPrompt" rows="6" readonly onclick="this.select()" style="font-size:12px;background:var(--bg2)">${escapeHtml(aiPromptText)}</textarea>
    <div style="display:flex;gap:8px;margin:8px 0;flex-wrap:wrap;align-items:center">
      <button type="button" class="btn-sec" id="copyPrompt">📋 Salin Prompt</button>
      <a class="btn-sec" href="https://gemini.google.com/app" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center">Buka Gemini ↗</a>
      <a class="btn-sec" href="https://chatgpt.com/" target="_blank" rel="noopener" style="text-decoration:none;display:inline-flex;align-items:center">Buka ChatGPT ↗</a>
    </div>
    <div id="aiInfo" class="hint" style="margin-bottom:8px"></div>
    <textarea id="rawParse" rows="6" placeholder="Tempel hasil AI di sini, mis.:
Analis: Budi Santoso
Firm: XYZ Sekuritas
Tanggal: 2026-07-11
Tipe: BUY
Saham: BBCA
Entry: 9500
TP1: 9800
TP2: 10100
SL: 9300
Catatan: breakout resistance"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button type="button" class="btn" id="parseBtn" style="width:auto">⚡ Parse &amp; Isi Form</button>
      <button type="button" class="btn btn-ghost" id="parseDemoBtn">Contoh</button>
    </div>
    <div id="parseInfo" class="hint" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <div style="font-weight:700;margin-bottom:6px">📷 Foto Bukti <span style="color:var(--text3);font-weight:500;font-size:11px">(opsional, maks 5)</span></div>
    <div class="hint" style="margin-bottom:8px">Lampirkan screenshot sinyal. Foto <b>dikirim ke admin via Telegram</b> untuk validasi — <b>tidak disimpan</b> di database/Sheet.</div>
    <label class="photo-drop" for="photoInput">📎 Pilih foto (bisa lebih dari satu, maks 5)</label>
    <input id="photoInput" type="file" accept="image/*" multiple style="display:none">
    <div class="thumbs" id="thumbs"></div>
    <div id="photoInfo" class="hint" style="margin-top:6px"></div>
  </div>

  <div class="card">
    <div id="msg"></div>
    <form id="form" autocomplete="off">
      <div class="field">
        <label class="req" for="analis">Nama Analis</label>
        <input id="analis" name="analis" type="text" maxlength="60" required placeholder="mis. Budi Santoso">
      </div>
      <div class="grid2">
        <div class="field">
          <label for="firm">Firm / Instansi</label>
          <input id="firm" name="firm" type="text" maxlength="60" placeholder="opsional">
        </div>
        <div class="field">
          <label for="sertifikasi">Sertifikasi</label>
          <input id="sertifikasi" name="sertifikasi" type="text" maxlength="40" placeholder="mis. CTA, WPPE (opsional)">
        </div>
      </div>

      <div class="grid2">
        <div class="field">
          <label class="req" for="ticker">Kode Saham</label>
          <input id="ticker" name="ticker" type="text" maxlength="12" required placeholder="mis. BBCA" style="text-transform:uppercase">
        </div>
        <div class="field">
          <label class="req" for="tipe">Tipe</label>
          <select id="tipe" name="tipe" required>${tipeOpts}</select>
        </div>
      </div>

      <div class="grid2">
        <div class="field">
          <label class="req" for="entry">Entry</label>
          <input id="entry" name="entry" type="number" step="any" min="0" required inputmode="decimal">
        </div>
        <div class="field">
          <label class="req" for="sl">Stop Loss (SL)</label>
          <input id="sl" name="sl" type="number" step="any" min="0" required inputmode="decimal">
        </div>
      </div>
      <div class="grid2">
        <div class="field">
          <label class="req" for="tp1">Target 1 (TP1)</label>
          <input id="tp1" name="tp1" type="number" step="any" min="0" required inputmode="decimal">
        </div>
        <div class="field">
          <label for="tp2">Target 2 (TP2)</label>
          <input id="tp2" name="tp2" type="number" step="any" min="0" inputmode="decimal" placeholder="opsional">
        </div>
      </div>
      <div class="hint" id="dirHint">BUY: TP di atas Entry, SL di bawah (TP2 lebih jauh dari TP1). SELL: kebalikannya.</div>

      <div class="grid2" style="margin-top:14px">
        <div class="field">
          <label class="req" for="tanggal">Tanggal Rilis</label>
          <input id="tanggal" name="tanggal" type="date" required value="${today}">
        </div>
        <div class="field">
          <label for="horizon">Horizon</label>
          <select id="horizon" name="horizon">${horizonOpts}</select>
        </div>
      </div>

      <div class="field">
        <label for="catatan">Catatan / Tesis</label>
        <textarea id="catatan" name="catatan" maxlength="500" placeholder="opsional — alasan singkat rekomendasi"></textarea>
      </div>

      <div class="field">
        <label for="submitted_by">Diinput oleh</label>
        <input id="submitted_by" name="submitted_by" type="text" maxlength="60" placeholder="opsional — nama kamu">
      </div>

      <button class="btn" id="submitBtn" type="submit">Kirim Rekomendasi</button>
    </form>
  </div>

  <div class="small">Data masuk sebagai <code>pending</code> → tayang setelah di-approve admin.</div>
</div>

<script>
(function(){
  var f = document.getElementById('form');
  var msg = document.getElementById('msg');
  var btn = document.getElementById('submitBtn');

  function setMsg(text, cls){ msg.innerHTML = text ? '<div class="'+cls+'">'+text+'</div>' : ''; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }

  // ── Tempel & Parse: ekstrak Tipe/Saham/Entry/TP/SL dari teks bebas ──
  // Bersihkan angka: pemisah ribuan (mis. 9.500 / 9,500) → integer;
  // desimal koma (mis. 1,08) → titik.
  function cleanNum(s){
    if(s==null) return '';
    s = String(s).replace(/\s/g,'');
    if(/^\d{1,3}([.,]\d{3})+$/.test(s)) return String(parseInt(s.replace(/[.,]/g,''),10));
    if(/^\d+,\d{1,2}$/.test(s)) return s.replace(',', '.');
    return s.replace(/,/g,'');
  }
  // Normalisasi tanggal apa pun → YYYY-MM-DD (dukung DD/MM/YYYY & YYYY-MM-DD).
  function normDate(s){
    s=String(s).trim().replace(/\//g,'-');
    var p=s.split('-'); if(p.length!==3) return '';
    var y,mo,d;
    if(p[0].length===4){ y=p[0]; mo=p[1]; d=p[2]; } else { d=p[0]; mo=p[1]; y=p[2]; }
    if(y.length===2) y='20'+y;
    mo=('0'+mo).slice(-2); d=('0'+d).slice(-2);
    if(!/^\d{4}$/.test(y)|| +mo<1 || +mo>12 || +d<1 || +d>31) return '';
    return y+'-'+mo+'-'+d;
  }
  function parseSignalText(text){
    text = String(text||'');
    var U = text.toUpperCase();
    var out = { analis:'', firm:'', tanggal:'', tipe:'', ticker:'', entry:'', tps:[], sl:'', catatan:'' };
    function grab(re){ var m=text.match(re); return m ? m[1].trim() : ''; }
    // Field berlabel (dari output AI atau teks sinyal)
    out.analis  = grab(/(?:ANALIS|ANALYST|OLEH)\s*[:=]\s*(.+)/i);
    out.firm    = grab(/(?:FIRM|SEKURITAS|BROKER|INSTANSI|KOMUNITAS)\s*[:=]\s*(.+)/i);
    out.catatan = grab(/(?:CATATAN|NOTE|TESIS|ALASAN)\s*[:=]\s*(.+)/i);
    var td = grab(/(?:TANGGAL|TGL|DATE)\s*[:=]\s*([0-9]{1,4}[-\/][0-9]{1,2}[-\/][0-9]{1,4})/i);
    if(td) out.tanggal = normDate(td);
    // Tipe: label dulu, lalu kata kunci di teks
    var tl = grab(/(?:TIPE|TYPE|ARAH|SINYAL|SIGNAL|POSISI)\s*[:=]\s*(BUY|SELL|LONG|SHORT|BELI|JUAL)/i);
    if(tl){ out.tipe = /SELL|SHORT|JUAL/i.test(tl)?'SELL':'BUY'; }
    else { if(/\b(SELL|SHORT|JUAL)\b/.test(U)) out.tipe='SELL'; if(/\b(BUY|LONG|BELI)\b/.test(U)) out.tipe='BUY'; }
    // Saham: label dulu, lalu tebak token 2–5 huruf kapital
    var sh = grab(/(?:SAHAM|TICKER|KODE|EMITEN|STOCK)\s*[:=]\s*([A-Za-z0-9.\-]{2,12})/i);
    if(sh){ out.ticker = sh.toUpperCase(); }
    else {
      var STOP={BUY:1,SELL:1,LONG:1,SHORT:1,TP:1,SL:1,ENTRY:1,TARGET:1,STOP:1,LOSS:1,BELI:1,JUAL:1,AREA:1,OP:1,OPEN:1,CL:1,IDX:1,WA:1,RR:1,CUT:1,ANALIS:1,FIRM:1,TIPE:1,SAHAM:1,TANGGAL:1,CATATAN:1,TGL:1,DATE:1,NOTE:1};
      var toks = U.match(/\b[A-Z]{2,5}\b/g) || [];
      for(var i=0;i<toks.length;i++){ if(!STOP[toks[i]]){ out.ticker=toks[i]; break; } }
    }
    var em = text.match(/(?:ENTRY|BUY\s*AREA|AREA|BELI|OP|OPEN)\s*[:=]?\s*([\d.,]+)/i);
    if(em) out.entry = cleanNum(em[1]);
    var tpRe = /(?:TP|TARGET)\s*\d*\s*[:=]?\s*([\d.,]+)/ig, m;
    while((m = tpRe.exec(text))){ if(out.tps.length<2) out.tps.push(cleanNum(m[1])); }
    var sm = text.match(/(?:SL|STOP\s*LOSS|STOPLOSS|STOP|CUT\s*LOSS|CUTLOSS|CL)\s*[:=]?\s*([\d.,]+)/i);
    if(sm) out.sl = cleanNum(sm[1]);
    return out;
  }
  var parseInfo = document.getElementById('parseInfo');
  var parseBtn = document.getElementById('parseBtn');
  if(parseBtn) parseBtn.onclick = function(){
    var out = parseSignalText(document.getElementById('rawParse').value);
    var filled = [];
    if(out.analis){ f.analis.value = out.analis; filled.push('Analis'); }
    if(out.firm){ f.firm.value = out.firm; filled.push('Firm'); }
    if(out.tanggal){ f.tanggal.value = out.tanggal; filled.push('Tanggal'); }
    if(out.tipe){ f.tipe.value = out.tipe; filled.push('Tipe'); }
    if(out.ticker){ f.ticker.value = out.ticker; filled.push('Saham'); }
    if(out.entry){ f.entry.value = out.entry; filled.push('Entry'); }
    if(out.tps[0]){ f.tp1.value = out.tps[0]; filled.push('TP1'); }
    if(out.tps[1]){ f.tp2.value = out.tps[1]; filled.push('TP2'); }
    if(out.sl){ f.sl.value = out.sl; filled.push('SL'); }
    if(out.catatan){ f.catatan.value = out.catatan; filled.push('Catatan'); }
    if(filled.length){ parseInfo.innerHTML = '<span style="color:var(--green)">✓ Terisi otomatis: '+esc(filled.join(', '))+'. Periksa sebentar, lalu Kirim.</span>'; }
    else { parseInfo.innerHTML = '<span style="color:var(--yellow)">Tidak terdeteksi. Tempel hasil AI (format berlabel Analis/Tipe/Saham/Entry/TP1/SL), atau isi manual.</span>'; }
  };
  var parseDemoBtn = document.getElementById('parseDemoBtn');
  if(parseDemoBtn) parseDemoBtn.onclick = function(){
    document.getElementById('rawParse').value = 'Analis: Budi Santoso\nFirm: XYZ Sekuritas\nTanggal: 2026-07-11\nTipe: BUY\nSaham: BBCA\nEntry: 9500\nTP1: 9800\nTP2: 10100\nSL: 9300\nCatatan: breakout resistance';
  };

  // Prompt AI — dari server (sama dgn isi #aiPrompt yg sudah dirender HTML).
  var AI_PROMPT = ${JSON.stringify(aiPromptText)};
  var aiPromptEl = document.getElementById('aiPrompt');
  if(aiPromptEl && !aiPromptEl.value) aiPromptEl.value = AI_PROMPT;
  var aiInfo = document.getElementById('aiInfo');
  // Tombol SALIN saja (murni gesture user → clipboard andal). Buka situs
  // ditangani link <a target=_blank> di HTML (tidak pernah diblokir popup).
  var copyPromptBtn = document.getElementById('copyPrompt');
  if(copyPromptBtn) copyPromptBtn.onclick = function(){
    function ok(){ if(aiInfo) aiInfo.innerHTML='<span style="color:var(--green)">✓ Prompt tersalin. Buka Gemini/ChatGPT, upload foto, tempel prompt, lalu salin hasilnya ke kotak Tempel &amp; Parse.</span>'; }
    function manual(){ if(aiInfo) aiInfo.innerHTML='<span style="color:var(--yellow)">Teks prompt sudah diblok otomatis — tinggal tekan Ctrl+C (di HP: tahan lalu Copy).</span>'; }
    // Cara PALING ANDAL: seleksi teks di kotak lalu copy (readonly dilepas
    // sementara agar jalan di HP/iOS). Teks tetap keblok → bisa Ctrl+C manual.
    var copied = false;
    try{
      aiPromptEl.removeAttribute('readonly');
      aiPromptEl.focus();
      aiPromptEl.setSelectionRange(0, (aiPromptEl.value||'').length);
      try{ copied = document.execCommand('copy'); }catch(_){}
      aiPromptEl.setAttribute('readonly','readonly');
    }catch(_){ try{ aiPromptEl.setAttribute('readonly','readonly'); }catch(__){} }
    if(copied){ ok(); return; }
    // Cadangan: clipboard API
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(AI_PROMPT).then(ok, manual);
    } else { manual(); }
  };

  // ── Upload & kompres foto (maks 5) ──
  var MAX_PHOTOS = 5;
  var photos = [];   // array data URL (base64) terkompres
  var photoInput = document.getElementById('photoInput');
  var thumbs = document.getElementById('thumbs');
  var photoInfo = document.getElementById('photoInfo');
  function renderThumbs(){
    thumbs.innerHTML = photos.map(function(src,i){
      return '<div class="thumb"><img src="'+src+'"><button type="button" class="thumb-x" data-i="'+i+'" title="Hapus">✕</button></div>';
    }).join('');
    Array.prototype.forEach.call(thumbs.querySelectorAll('.thumb-x'), function(b){
      b.onclick=function(){ photos.splice(parseInt(b.getAttribute('data-i'),10),1); renderThumbs(); };
    });
    if(photoInfo) photoInfo.textContent = photos.length ? (photos.length+' foto siap dikirim ke Telegram saat Kirim.') : '';
  }
  function compress(file){
    return new Promise(function(resolve){
      var img = new Image(); var url = URL.createObjectURL(file);
      img.onload = function(){
        var max=1280, w=img.width, h=img.height;
        if(w>max||h>max){ if(w>=h){ h=Math.round(h*max/w); w=max; } else { w=Math.round(w*max/h); h=max; } }
        var c=document.createElement('canvas'); c.width=w; c.height=h;
        c.getContext('2d').drawImage(img,0,0,w,h);
        URL.revokeObjectURL(url);
        try{ resolve(c.toDataURL('image/jpeg', 0.72)); }catch(e){ resolve(null); }
      };
      img.onerror=function(){ URL.revokeObjectURL(url); resolve(null); };
      img.src=url;
    });
  }
  if(photoInput) photoInput.onchange = async function(){
    var files = Array.prototype.slice.call(photoInput.files||[]);
    for(var i=0;i<files.length;i++){
      if(photos.length>=MAX_PHOTOS){ if(photoInfo) photoInfo.innerHTML='<span style="color:var(--yellow)">Maksimal '+MAX_PHOTOS+' foto.</span>'; break; }
      if(!/^image\//.test(files[i].type)) continue;
      var d = await compress(files[i]);
      if(d) photos.push(d);
    }
    photoInput.value='';
    renderThumbs();
  };

  f.addEventListener('submit', async function(e){
    e.preventDefault();
    setMsg('', '');
    var data = {
      analis: f.analis.value, firm: f.firm.value, sertifikasi: f.sertifikasi.value,
      ticker: f.ticker.value, tipe: f.tipe.value,
      entry: f.entry.value, tp1: f.tp1.value, tp2: f.tp2.value, sl: f.sl.value,
      tanggal: f.tanggal.value, horizon: f.horizon.value,
      catatan: f.catatan.value, submitted_by: f.submitted_by.value,
      photos: photos
    };
    btn.disabled = true; var lbl = btn.textContent; btn.textContent = 'Mengirim…';
    try{
      var res = await fetch('/api/submit', {
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify(data)
      });
      var j = await res.json().catch(function(){ return {}; });
      if(!res.ok || j.error){ throw new Error(j.error || ('HTTP '+res.status)); }
      setMsg('✓ Terkirim: <b>'+esc(j.tipe)+' '+esc(j.ticker)+'</b>.'+((j.photos&&j.photos.sent)?(' '+j.photos.sent+' foto dikirim ke Telegram.'):'')+' Menunggu approve admin. Form dikosongkan untuk input berikutnya.', 'ok');
      // Reset tapi pertahankan nama analis, firm, sertifikasi, & "diinput oleh"
      var keepA=f.analis.value, keepF=f.firm.value, keepS=f.sertifikasi.value, keepBy=f.submitted_by.value;
      f.reset();
      f.analis.value=keepA; f.firm.value=keepF; f.sertifikasi.value=keepS; f.submitted_by.value=keepBy;
      f.tanggal.value = new Date().toISOString().slice(0,10);
      var rp=document.getElementById('rawParse'); if(rp) rp.value='';
      if(parseInfo) parseInfo.innerHTML='';
      photos.length=0; renderThumbs();
      window.scrollTo({top:0, behavior:'smooth'});
    }catch(err){
      setMsg('Gagal: '+esc(err.message), 'err');
    }finally{
      btn.disabled = false; btn.textContent = lbl;
    }
  });
})();
</script>
</body></html>`;
}

// ── Router ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    if (path === '/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/logout') return handleLogout();

    const authed = await isAuthed(request, env);

    if (path === '/api/submit' && method === 'POST') {
      if (!authed) return jsonRes({ error: 'unauthorized' }, 401);
      return apiSubmit(request, env);
    }

    if (path === '/' || path === '/index.html') {
      return htmlRes(authed ? renderFormPage(env) : renderLoginPage(env, null));
    }

    return new Response('Not found', { status: 404 });
  },
};
