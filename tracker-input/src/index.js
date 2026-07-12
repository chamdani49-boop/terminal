/**
 * tracker-input — Cloudflare Worker
 *
 * Halaman web SEDERHANA untuk kontributor submit rekomendasi trading (menu
 * Tracker). Alur baru (parse-driven):
 *   Login password → salin prompt → buka Gemini/ChatGPT (upload foto + tempel
 *   prompt) → salin hasil → tempel & Parse (SEMUA kolom terisi otomatis) →
 *   periksa sebentar → Kirim → POST /api/submit → Worker teruskan ke Google
 *   Apps Script (GAS) → GAS append 1 baris ke Google Sheet "Tracker" (pending).
 *
 * TERISOLASI: worker ini terpisah total dari site utama & terminal-live.
 *
 * Env yang dibutuhkan:
 *   - APP_PASSWORD (secret) — password login kontributor
 *   - GAS_URL      (secret) — URL Web App GAS (…/exec)
 *   - GAS_TOKEN    (secret) — token yg dicocokkan GAS (= TOKEN di gas/Code.gs)
 *   - APP_TITLE    (var)    — judul halaman (kosmetik)
 *   - TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID (secret, opsional) — kirim foto bukti
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
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
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
  if (!env.APP_PASSWORD) {
    return htmlRes(renderLoginPage(env, 'APP_PASSWORD belum di-set di Worker secret.'), 500);
  }
  let form;
  try {
    form = await request.formData();
  } catch (_) {
    return htmlRes(renderLoginPage(env, 'Form tidak valid. Coba lagi.'), 400);
  }
  const password = form.get('password') || '';
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
  .step{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font-size:12px;font-weight:700;margin-right:8px;flex:0 0 auto}
  .cardhead{display:flex;align-items:center;font-weight:700;margin-bottom:6px;font-size:15px}
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
  .link{color:var(--accent2);cursor:pointer;text-decoration:underline;font-size:12.5px}
  .summary{background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:4px 14px;margin-bottom:14px}
  .srow{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid var(--border);font-size:13.5px}
  .srow:last-child{border-bottom:0}
  .srow>span{color:var(--text2);flex:0 0 auto}
  .srow>b{color:var(--text);text-align:right;word-break:break-word}
  .srow.miss>b{color:var(--yellow)}
  code{background:var(--bg2);padding:1px 6px;border-radius:4px;font-size:12px;font-family:ui-monospace,monospace;color:var(--accent2)}
  .btn-sec{display:inline-flex;align-items:center;justify-content:center;background:var(--bg2);border:1px solid var(--border);color:var(--accent2);width:auto;padding:9px 14px;font-size:13px;font-weight:700;border-radius:8px;cursor:pointer;text-decoration:none}
  .btn-sec:hover{background:var(--card);color:var(--text)}
  .photo-drop{display:block;border:1px dashed var(--border);border-radius:8px;padding:14px;text-align:center;color:var(--text2);cursor:pointer;font-size:13px;background:var(--bg2)}
  .photo-drop:hover{border-color:var(--accent);color:var(--text)}
  .thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .thumb{position:relative;width:64px;height:64px;border-radius:8px;overflow:hidden;border:1px solid var(--border);background:var(--bg2)}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .thumb-x{position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.7);color:#fff;border:0;cursor:pointer;font-size:12px;line-height:20px;padding:0;text-align:center;z-index:2}
  .pslots{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:4px}
  .pslot{position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;border:1px solid var(--border);background:var(--bg2);display:flex;align-items:center;justify-content:center}
  .pslot.empty{border-style:dashed;color:var(--text3);font-size:26px;cursor:pointer;font-weight:300}
  .pslot.empty:hover{border-color:var(--accent);color:var(--accent2)}
  .pslot img{width:100%;height:100%;object-fit:cover;display:block}
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
  <div class="small">Password diberikan oleh admin. · <span style="opacity:.5">build parse-v3</span></div>
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

  // Prompt untuk Gemini/ChatGPT — MENCAKUP SEMUA kolom yang dibutuhkan Sheet,
  // supaya hasilnya bisa di-Parse sekaligus (tanpa isi manual satu per satu).
  const aiPromptText = [
    'Kamu adalah asisten ekstraksi data. Baca screenshot rekomendasi saham (IDX) yang aku lampirkan, lalu tulis ULANG datanya PERSIS memakai format label di bawah — satu field per baris, tanpa kalimat pembuka/penutup, tanpa markdown. Jika sebuah data tidak ada di gambar, biarkan KOSONG setelah titik dua (jangan hapus barisnya, jangan menebak).',
    '',
    'Analis:',
    'Firm:',
    'Sertifikasi:',
    'Tanggal:',
    'Tipe:',
    'Saham:',
    'Entry:',
    'TP1:',
    'TP2:',
    'SL:',
    'Horizon:',
    'Catatan:',
    '',
    'Aturan pengisian:',
    '- Analis: nama analis / sumber sinyal.',
    '- Firm: sekuritas / komunitas (bila ada).',
    '- Sertifikasi: mis. CTA, WPPE, RSA (bila ada).',
    '- Tanggal: tanggal rilis, format YYYY-MM-DD.',
    '- Tipe: tulis BUY atau SELL saja.',
    '- Saham: kode 4 huruf, mis. BBCA.',
    '- Entry / TP1 / TP2 / SL: angka polos tanpa pemisah ribuan (contoh 9500, bukan 9.500). Pakai titik untuk desimal (contoh 1.08).',
    '- Horizon: salah satu dari 1 Hari / 1 Minggu / 1 Bulan / 3 Bulan / 6 Bulan / 1 Tahun (bila ada).',
    '- Catatan: alasan/tesis singkat (bila ada).'
  ].join('\n');

  const demoText = [
    'Analis: Budi Santoso', 'Firm: XYZ Sekuritas', 'Sertifikasi: CTA',
    'Tanggal: ' + today, 'Tipe: BUY', 'Saham: BBCA',
    'Entry: 9500', 'TP1: 9800', 'TP2: 10100', 'SL: 9300',
    'Horizon: 1 Bulan', 'Catatan: breakout resistance'
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
      <div class="sub">Ambil data dari foto pakai AI → Parse → periksa → Kirim. Setelah submit, menunggu <b>approve admin</b>.</div>
    </div>
    <a href="/logout" class="btn btn-ghost">Keluar</a>
  </div>

  <div class="card">
    <div class="cardhead"><span class="step">1</span> Salin prompt &amp; buka AI</div>
    <div class="hint" style="margin-bottom:8px">Tekan <b>Salin Prompt</b> → buka Gemini/ChatGPT (akunmu sendiri) → di sana tempel prompt + upload screenshot sinyal → salin hasilnya, lalu tempel di Langkah 2.</div>
    <textarea id="aiPrompt" rows="7" readonly onclick="this.select()" style="font-size:12px;background:var(--bg2)">${escapeHtml(aiPromptText)}</textarea>
    <div style="display:flex;gap:8px;margin:10px 0 0;flex-wrap:wrap;align-items:center">
      <button type="button" class="btn-sec" id="copyPrompt">📋 Salin Prompt</button>
      <a class="btn-sec" href="https://gemini.google.com/app" target="_blank" rel="noopener">Buka Gemini ↗</a>
      <a class="btn-sec" href="https://chatgpt.com/" target="_blank" rel="noopener">Buka ChatGPT ↗</a>
    </div>
    <div id="aiInfo" class="hint" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <div class="cardhead"><span class="step">2</span> Tempel hasil AI &amp; Parse</div>
    <div class="hint" style="margin-bottom:8px">Tempel seluruh hasil dari AI di sini, lalu tekan <b>Parse</b>. Semua kolom akan terisi otomatis — kamu tinggal periksa.</div>
    <textarea id="rawParse" rows="8" placeholder="Tempel hasil AI di sini, mis.:
${escapeHtml(demoText)}"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
      <button type="button" class="btn" id="parseBtn" style="width:auto">⚡ Parse &amp; Isi</button>
      <button type="button" class="btn btn-ghost" id="parseDemoBtn">Contoh</button>
    </div>
    <div id="parseInfo" class="hint" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <div class="cardhead"><span class="step">3</span> Foto bukti <span style="color:var(--text3);font-weight:500;font-size:11px;margin-left:6px">(opsional, maks 5)</span></div>
    <div class="hint" style="margin-bottom:8px">Foto <b>dikirim ke admin via Telegram</b> untuk validasi — <b>tidak disimpan</b> di database/Sheet.</div>
    <div class="pslots" id="photoSlots"></div>
    <input id="photoInput" type="file" accept="image/*" multiple style="display:none">
    <div id="photoInfo" class="hint" style="margin-top:8px">0/5 foto. Ketuk kotak bertanda + untuk menambah.</div>
  </div>

  <div id="reviewWrap">
    <div id="msg"></div>
  </div>

  <div class="card" id="reviewCard">
    <div class="cardhead"><span class="step">4</span> Periksa &amp; Kirim</div>
    <div class="hint" style="margin-bottom:12px">Kolom di bawah terisi otomatis dari Parse (atau isi manual). Periksa sebentar — terutama harga — lalu tekan <b>Kirim Rekomendasi</b> di bawah.</div>
    <form id="form" autocomplete="off">
      <div id="editFields">
      <div class="grid2">
        <div class="field">
          <label class="req" for="analis">Nama Analis</label>
          <input id="analis" name="analis" type="text" maxlength="60" required placeholder="mis. Budi Santoso">
        </div>
        <div class="field">
          <label for="firm">Firm / Instansi</label>
          <input id="firm" name="firm" type="text" maxlength="60" placeholder="opsional">
        </div>
      </div>
      <div class="grid2">
        <div class="field">
          <label for="sertifikasi">Sertifikasi</label>
          <input id="sertifikasi" name="sertifikasi" type="text" maxlength="40" placeholder="mis. CTA, WPPE (opsional)">
        </div>
        <div class="field">
          <label class="req" for="ticker">Kode Saham</label>
          <input id="ticker" name="ticker" type="text" maxlength="12" required placeholder="mis. BBCA" style="text-transform:uppercase">
        </div>
      </div>

      <div class="grid2">
        <div class="field">
          <label class="req" for="tipe">Tipe</label>
          <select id="tipe" name="tipe" required>${tipeOpts}</select>
        </div>
        <div class="field">
          <label class="req" for="entry">Entry</label>
          <input id="entry" name="entry" type="number" step="any" min="0" required inputmode="decimal">
        </div>
      </div>
      <div class="grid3">
        <div class="field">
          <label class="req" for="tp1">TP1</label>
          <input id="tp1" name="tp1" type="number" step="any" min="0" required inputmode="decimal">
        </div>
        <div class="field">
          <label for="tp2">TP2</label>
          <input id="tp2" name="tp2" type="number" step="any" min="0" inputmode="decimal" placeholder="opsional">
        </div>
        <div class="field">
          <label class="req" for="sl">SL</label>
          <input id="sl" name="sl" type="number" step="any" min="0" required inputmode="decimal">
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
      </div><!-- /editFields -->

      <div class="field">
        <label for="submitted_by">Diinput oleh</label>
        <input id="submitted_by" name="submitted_by" type="text" maxlength="60" placeholder="opsional — nama kamu">
      </div>

      <button class="btn" id="submitBtn" type="submit">Kirim Rekomendasi</button>
    </form>
  </div>

  <div class="small">Data masuk sebagai <code>pending</code> → tayang setelah di-approve admin. · <span style="opacity:.5">build parse-v3</span></div>
</div>

<script>
(function(){
  var AI_PROMPT = ${JSON.stringify(aiPromptText)};
  var DEMO = ${JSON.stringify(demoText)};

  var f = document.getElementById('form');
  var msg = document.getElementById('msg');
  var btn = document.getElementById('submitBtn');
  var reviewCard = document.getElementById('reviewCard');
  var aiInfo = document.getElementById('aiInfo');
  var parseInfo = document.getElementById('parseInfo');

  var summaryEl = document.getElementById('summary');
  var editFields = document.getElementById('editFields');
  var editToggle = document.getElementById('editToggle');
  var HLABEL = { '1H':'1 Hari','1M':'1 Minggu','1Bln':'1 Bulan','3Bln':'3 Bulan','6Bln':'6 Bulan','1Th':'1 Tahun' };

  function setMsg(text, cls){ if(msg) msg.innerHTML = text ? '<div class="'+cls+'">'+text+'</div>' : ''; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
  function showReview(){ if(reviewCard) reviewCard.style.display=''; }
  function showEdit(){ if(editFields) editFields.style.display=''; }
  function hideEdit(){ if(editFields) editFields.style.display='none'; }
  function val(id){ return f && f[id] ? String(f[id].value||'').trim() : ''; }

  // Ringkasan read-only hasil Parse (pengganti form banyak-kolom). Field wajib
  // yang masih kosong ditandai kuning + ⚠ supaya jelas apa yg perlu dikoreksi.
  function renderSummary(){
    if(!summaryEl) return;
    var rows = [
      ['Tipe / Saham', ((val('tipe')||'—')+'  '+(val('ticker')||'—')), !val('ticker')||!val('tipe')],
      ['Entry', val('entry')||'—', !val('entry')],
      ['TP1', val('tp1')||'—', !val('tp1')],
      ['TP2', val('tp2')||'—', false],
      ['SL', val('sl')||'—', !val('sl')],
      ['Tanggal', val('tanggal')||'—', !val('tanggal')],
      ['Horizon', (HLABEL[val('horizon')]||'—'), false],
      ['Analis', val('analis')||'—', !val('analis')],
      ['Firm', val('firm')||'—', false],
      ['Sertifikasi', val('sertifikasi')||'—', false],
      ['Catatan', val('catatan')||'—', false]
    ];
    summaryEl.innerHTML = rows.map(function(r){
      return '<div class="srow'+(r[2]?' miss':'')+'"><span>'+r[0]+'</span><b>'+esc(r[1])+(r[2]?' ⚠':'')+'</b></div>';
    }).join('');
  }

  // ── Copy util yang ANDAL (clipboard API dulu, fallback execCommand) ──
  function copyText(text){
    return new Promise(function(resolve){
      if(navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext){
        navigator.clipboard.writeText(text).then(function(){ resolve(true); }, function(){ resolve(fallbackCopy(text)); });
      } else {
        resolve(fallbackCopy(text));
      }
    });
  }
  function fallbackCopy(text){
    try{
      // Pakai textarea prompt yang SUDAH terlihat bila memungkinkan — lebih
      // andal di iOS/Safari daripada elemen tersembunyi.
      var el = document.getElementById('aiPrompt');
      var ta, created = false;
      if(el && el.value === text){ ta = el; }
      else {
        ta = document.createElement('textarea'); ta.value = text;
        ta.style.position='fixed'; ta.style.top='0'; ta.style.left='0'; ta.style.opacity='0';
        document.body.appendChild(ta); created = true;
      }
      var wasRO = ta.hasAttribute('readonly'); ta.removeAttribute('readonly');
      ta.focus(); ta.select(); try{ ta.setSelectionRange(0, text.length); }catch(_){}
      var ok=false; try{ ok=document.execCommand('copy'); }catch(_){}
      if(created) document.body.removeChild(ta); else if(wasRO) ta.setAttribute('readonly','');
      return ok;
    }catch(_){ return false; }
  }

  var copyBtn = document.getElementById('copyPrompt');
  if(copyBtn) copyBtn.onclick = function(){
    copyText(AI_PROMPT).then(function(ok){
      if(aiInfo) aiInfo.innerHTML = ok
        ? '<span style="color:var(--green)">✓ Prompt tersalin. Buka Gemini/ChatGPT, upload foto + tempel prompt, lalu salin hasilnya ke Langkah 2.</span>'
        : '<span style="color:var(--yellow)">Gagal menyalin otomatis. Klik area prompt di atas (otomatis terblok), lalu tekan Ctrl+C / (di HP: tahan → Copy).</span>';
    });
  };
  // ── Bersih-bersih angka & tanggal ──
  function cleanNum(s){
    if(s==null) return '';
    s = String(s).replace(/\s/g,'');
    if(/^\d{1,3}([.,]\d{3})+$/.test(s)) return String(parseInt(s.replace(/[.,]/g,''),10));
    if(/^\d+,\d{1,2}$/.test(s)) return s.replace(',', '.');
    return s.replace(/,/g,'');
  }
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
  // Teks bebas horizon → salah satu kode HORIZON_OPTS.
  function normHorizon(s){
    s=String(s||'').toLowerCase().trim();
    if(!s) return '';
    if(/(^|\D)1\s*th\b|1\s*tahun|1\s*year|tahun|year/.test(s)) return '1Th';
    if(/6\s*bln|6\s*bulan|6\s*month/.test(s)) return '6Bln';
    if(/3\s*bln|3\s*bulan|3\s*month/.test(s)) return '3Bln';
    if(/1\s*bln|1\s*bulan|1\s*month|bulan|month/.test(s)) return '1Bln';
    if(/1\s*mgg|1\s*minggu|minggu|week|pekan/.test(s)) return '1M';
    if(/1\s*hr|1\s*hari|hari|day|harian|intraday/.test(s)) return '1H';
    return '';
  }
  // Buang nilai placeholder yang belum diisi AI (mis. "<nama analis>").
  function clean(v){ v=String(v==null?'':v).trim(); if(/^<.*>$/.test(v)) return ''; return v; }

  function firstNum(s){ var m=String(s||'').match(/[\d.,]+/); return m ? cleanNum(m[0]) : ''; }
  // Label baris (dicocokkan PERSIS pada teks sebelum ":"/"=") → key kanonik.
  var LABELS = {
    analis:      /^(?:analis|nama analis|analyst|oleh|by|sumber)$/i,
    firm:        /^(?:firm|instansi|sekuritas|broker|komunitas|perusahaan)$/i,
    sertifikasi: /^(?:sertifikasi|sertifikat|certification|cert|lisensi|licen[sc]e)$/i,
    tanggal:     /^(?:tanggal|tgl|date)$/i,
    tipe:        /^(?:tipe|type|arah|sinyal|signal|posisi|aksi|rekomendasi)$/i,
    saham:       /^(?:saham|kode saham|kode emiten|emiten|ticker|kode|stock)$/i,
    entry:       /^(?:entry|entri|buy area|sell area|area|beli|op|open|harga entry)$/i,
    tp1:         /^(?:tp1|tp 1|target 1|target1|tp|target|tp\/target)$/i,
    tp2:         /^(?:tp2|tp 2|target 2|target2)$/i,
    sl:          /^(?:sl|stop loss|stoploss|stop|cut loss|cutloss|cl)$/i,
    horizon:     /^(?:horizon|timeframe|time frame|jangka|jangka waktu)$/i,
    catatan:     /^(?:catatan|note|notes|tesis|alasan|remark|keterangan)$/i
  };

  function parseSignalText(text){
    text = String(text||'').replace(/\r/g, '');
    var U = text.toUpperCase();
    var out = { analis:'', firm:'', sertifikasi:'', tanggal:'', tipe:'', ticker:'', entry:'', tps:[], sl:'', horizon:'', catatan:'' };

    // ── 1) Baris berlabel "Label: value" (format keluaran AI) ──
    // Tahan banting terhadap gaya keluaran AI: bullet (- * •), penomoran (1.),
    // markdown bold (**), heading (#), dan backtick — semua dibersihkan dulu.
    var map = {};
    text.split('\n').forEach(function(line){
      var raw = line.replace(/[*#\`]/g, '').replace(/^\s*(?:[-–—•·>]+|\d+[.)])\s+/, '');
      var m = raw.match(/^\s*([^:=]+?)\s*[:=]\s*(.*)$/);   // hanya nilai di baris yg SAMA
      if(!m) return;
      var key = m[1].trim(), value = clean(m[2]);
      for(var k in LABELS){ if(map[k] === undefined && LABELS[k].test(key)){ map[k] = value; break; } }
    });

    out.analis      = map.analis || '';
    out.firm        = map.firm || '';
    out.sertifikasi = map.sertifikasi || '';
    out.catatan     = map.catatan || '';
    if(map.tanggal){ var dm = map.tanggal.match(/[0-9]{1,4}[-\/][0-9]{1,2}[-\/][0-9]{1,4}/); if(dm){ var d=normDate(dm[0]); if(d) out.tanggal=d; } }
    if(map.horizon) out.horizon = normHorizon(map.horizon);
    if(map.tipe){ out.tipe = /SELL|SHORT|JUAL/i.test(map.tipe) ? 'SELL' : (/BUY|LONG|BELI/i.test(map.tipe) ? 'BUY' : ''); }
    if(map.saham){ var sm2 = map.saham.match(/[A-Za-z]{2,6}/); if(sm2) out.ticker = sm2[0].toUpperCase(); }
    if(map.entry) out.entry = firstNum(map.entry);
    if(map.tp1) { var v1=firstNum(map.tp1); if(v1) out.tps[0]=v1; }
    if(map.tp2) { var v2=firstNum(map.tp2); if(v2) out.tps[1]=v2; }
    if(map.sl)  out.sl = firstNum(map.sl);

    // ── 2) Fallback teks bebas (sinyal messy tanpa label) ──
    if(!out.tipe){ if(/\b(SELL|SHORT|JUAL)\b/.test(U)) out.tipe='SELL'; else if(/\b(BUY|LONG|BELI)\b/.test(U)) out.tipe='BUY'; }
    if(!out.ticker){
      var STOP={BUY:1,SELL:1,LONG:1,SHORT:1,TP:1,SL:1,ENTRY:1,TARGET:1,STOP:1,LOSS:1,BELI:1,JUAL:1,AREA:1,OP:1,OPEN:1,CL:1,IDX:1,WA:1,RR:1,CUT:1,ANALIS:1,FIRM:1,TIPE:1,SAHAM:1,TANGGAL:1,CATATAN:1,TGL:1,DATE:1,NOTE:1,HORIZON:1,SWING:1};
      var toks = U.match(/\b[A-Z]{2,5}\b/g) || [];
      for(var i=0;i<toks.length;i++){ if(!STOP[toks[i]]){ out.ticker=toks[i]; break; } }
    }
    if(!out.entry){ var em = text.match(/(?:ENTRY|BUY\s*AREA|AREA|BELI|OP|OPEN)\s*[:=]?\s*([\d.,]+)/i); if(em) out.entry = cleanNum(em[1]); }
    if(!out.tps.length){
      var tpRe = /(?:TP|TARGET)\s*\d{0,2}[\s:=]+([\d.,]+)/ig, mm;
      while((mm = tpRe.exec(text))){ if(out.tps.length<2) out.tps.push(cleanNum(mm[1])); }
    }
    if(!out.sl){ var sf = text.match(/(?:SL|STOP\s*LOSS|STOPLOSS|STOP|CUT\s*LOSS|CUTLOSS|CL)\s*[:=]?\s*([\d.,]+)/i); if(sf) out.sl = cleanNum(sf[1]); }
    if(!out.horizon && /\b(swing|scalp|intraday|harian|mingguan|bulanan)\b/i.test(text)) out.horizon = normHorizon(text);
    return out;
  }

  var parseBtn = document.getElementById('parseBtn');
  if(parseBtn) parseBtn.onclick = function(){
    var out = parseSignalText(document.getElementById('rawParse').value);
    var filled = [];
    if(out.analis){ f.analis.value = out.analis; filled.push('Analis'); }
    if(out.firm){ f.firm.value = out.firm; filled.push('Firm'); }
    if(out.sertifikasi){ f.sertifikasi.value = out.sertifikasi; filled.push('Sertifikasi'); }
    if(out.tanggal){ f.tanggal.value = out.tanggal; filled.push('Tanggal'); }
    if(out.tipe){ f.tipe.value = out.tipe; filled.push('Tipe'); }
    if(out.ticker){ f.ticker.value = out.ticker; filled.push('Saham'); }
    if(out.entry){ f.entry.value = out.entry; filled.push('Entry'); }
    if(out.tps[0]){ f.tp1.value = out.tps[0]; filled.push('TP1'); }
    if(out.tps[1]){ f.tp2.value = out.tps[1]; filled.push('TP2'); }
    if(out.sl){ f.sl.value = out.sl; filled.push('SL'); }
    if(out.horizon){ f.horizon.value = out.horizon; filled.push('Horizon'); }
    if(out.catatan){ f.catatan.value = out.catatan; filled.push('Catatan'); }
    if(reviewCard) reviewCard.scrollIntoView({behavior:'smooth', block:'start'});
    if(filled.length){
      parseInfo.innerHTML = '<span style="color:var(--green)">✓ Terbaca: '+esc(filled.join(', '))+'. Periksa di Langkah 4, lalu Kirim.</span>';
    } else {
      parseInfo.innerHTML = '<span style="color:var(--yellow)">Tidak terbaca. Pastikan menempel hasil AI yang berlabel (Analis:, Tipe:, Saham:, Entry:, TP1:, SL: …), atau isi kolom di Langkah 4 secara manual.</span>';
    }
  };
  var parseDemoBtn = document.getElementById('parseDemoBtn');
  if(parseDemoBtn) parseDemoBtn.onclick = function(){ document.getElementById('rawParse').value = DEMO; };

  // Kode saham selalu tampil kapital saat diketik.
  if(f && f.ticker) f.ticker.addEventListener('input', function(){ this.value = this.value.toUpperCase(); });

  // ── Upload & kompres foto (maks 5) ──
  var MAX_PHOTOS = 5;
  var photos = [];
  var photoInput = document.getElementById('photoInput');
  var photoSlots = document.getElementById('photoSlots');
  var photoInfo = document.getElementById('photoInfo');
  // Selalu tampilkan 5 kotak: yang terisi = thumbnail + tombol hapus,
  // yang kosong = kotak "+" yang bisa diketuk untuk menambah foto.
  function renderThumbs(){
    if(!photoSlots) return;
    var html='';
    for(var i=0;i<MAX_PHOTOS;i++){
      if(photos[i]){
        html += '<div class="pslot"><img src="'+photos[i]+'"><button type="button" class="thumb-x" data-i="'+i+'" title="Hapus">✕</button></div>';
      } else {
        html += '<div class="pslot empty" title="Tambah foto">+</div>';
      }
    }
    photoSlots.innerHTML = html;
    Array.prototype.forEach.call(photoSlots.querySelectorAll('.thumb-x'), function(b){
      b.onclick=function(ev){ ev.stopPropagation(); photos.splice(parseInt(b.getAttribute('data-i'),10),1); renderThumbs(); };
    });
    Array.prototype.forEach.call(photoSlots.querySelectorAll('.pslot.empty'), function(s){
      s.onclick=function(){ if(photoInput) photoInput.click(); };
    });
    if(photoInfo) photoInfo.innerHTML = photos.length + '/5 foto' + (photos.length ? ' — siap dikirim ke Telegram saat Kirim.' : '. Ketuk kotak + untuk menambah.');
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
  renderThumbs(); // tampilkan 5 slot kosong saat halaman dibuka

  if(f) f.addEventListener('submit', async function(e){
    e.preventDefault();
    setMsg('', '');
    // Validasi ringan di klien; kalau ada yg kurang, buka "Koreksi data".
    var need = [['analis','Nama Analis'],['ticker','Kode Saham'],['tipe','Tipe'],['entry','Entry'],['tp1','TP1'],['sl','SL'],['tanggal','Tanggal']];
    var miss = need.filter(function(n){ return !val(n[0]); }).map(function(n){ return n[1]; });
    if(miss.length){
      setMsg('Data belum lengkap: '+esc(miss.join(', '))+'. Lengkapi kolom bertanda * lalu Kirim lagi.', 'err');
      if(reviewCard) reviewCard.scrollIntoView({behavior:'smooth', block:'start'});
      return;
    }
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
    try {
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const method = request.method;

      // Login: POST memproses password; GET diarahkan balik ke halaman utama
      // (menghindari 404 bila kontributor mengetik /login di address bar).
      if (path === '/login') {
        if (method === 'POST') return handleLogin(request, env);
        return new Response(null, { status: 303, headers: { 'Location': '/' } });
      }
      if (path === '/logout') return handleLogout();

      const authed = await isAuthed(request, env);

      if (path === '/api/submit') {
        if (method !== 'POST') return jsonRes({ error: 'method not allowed' }, 405);
        if (!authed) return jsonRes({ error: 'unauthorized' }, 401);
        return apiSubmit(request, env);
      }

      if (path === '/' || path === '/index.html') {
        if (method !== 'GET' && method !== 'HEAD') {
          return new Response('Method not allowed', { status: 405 });
        }
        return htmlRes(authed ? renderFormPage(env) : renderLoginPage(env, null));
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      // Jangan pernah membocorkan stack trace ke user; kembalikan pesan bersih.
      return jsonRes({ error: 'Terjadi kesalahan tak terduga di server.' }, 500);
    }
  },
};
