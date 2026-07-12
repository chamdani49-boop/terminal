/**
 * tracker-input — Cloudflare Worker
 *
 * Halaman web SEDERHANA untuk kontributor submit rekomendasi trading (menu
 * Tracker). Alur:
 *   Login password → salin prompt → buka Gemini/ChatGPT (tempel prompt + upload
 *   foto sinyal di sana) → salin hasil → tempel/edit di kotak "Data rekomendasi"
 *   (boleh >1 saham) → isi nama inputer → Kirim → POST /api/submit → Worker
 *   teruskan teks ke Google Apps Script (GAS) → GAS append 1 baris ke Google
 *   Sheet "Tracker" (status pending). Foto dikirim ke Telegram admin.
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
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 hari (biar inputer tak sering login ulang)

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

// Terima teks rekomendasi (bisa berisi >1 saham, hasil edit inputer) + nama
// inputer + foto. Teks dikirim apa adanya ke Sheet (kolom "catatan"); foto ke
// Telegram. Tidak ada validasi per-kolom — inputer bebas mengetik/edit.
async function apiSubmit(request, env) {
  if (!env.GAS_URL || !env.GAS_TOKEN) {
    return jsonRes({ error: 'GAS_URL / GAS_TOKEN belum di-set di Worker secret.' }, 500);
  }

  let body;
  try { body = await request.json(); } catch (_) { return jsonRes({ error: 'Body bukan JSON valid.' }, 400); }

  const text = String(body.text || '').trim();
  const submitted_by = String(body.submitted_by || '').trim().slice(0, 80);
  const photos = Array.isArray(body.photos) ? body.photos.slice(0, 5) : [];

  if (!submitted_by) return jsonRes({ error: 'Nama inputer wajib diisi.' }, 400);
  if (!text) return jsonRes({ error: 'Data rekomendasi masih kosong.' }, 400);

  // Teks apa adanya → kolom "catatan" di Sheet. GAS akan menambah 1 baris.
  const tanggal = new Date().toISOString().slice(0, 10);
  const payload = {
    token: env.GAS_TOKEN,
    catatan: text,
    submitted_by,
    tanggal,
  };

  let gasRes, gasText;
  try {
    gasRes = await fetch(env.GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    gasText = await gasRes.text();
  } catch (e) {
    return jsonRes({ error: 'Gagal menghubungi Sheet (GAS): ' + (e && e.message || e) }, 502);
  }

  let gasBody = null;
  try { gasBody = JSON.parse(gasText); } catch (_) { gasBody = { _raw: gasText }; }
  if (!gasRes.ok || !gasBody || gasBody.ok !== true) {
    return jsonRes({ error: (gasBody && gasBody.error) || ('Sheet menolak (HTTP ' + gasRes.status + ')'), detail: gasBody }, 502);
  }

  // Foto → Telegram (best-effort; tidak menggagalkan submit).
  let photoStatus = { sent: 0 };
  try {
    if (photos.length) {
      const preview = text.length > 700 ? text.slice(0, 700) + '…' : text;
      const caption =
        '🆕 <b>Rekomendasi Tracker</b> (pending)\n' +
        'oleh: <b>' + escapeHtml(submitted_by) + '</b> · ' + tanggal + '\n\n' +
        escapeHtml(preview);
      photoStatus = await sendPhotosTelegram(env, photos, caption);
    }
  } catch (_) { /* jangan gagalkan submit hanya karena Telegram */ }

  return jsonRes({ ok: true, submitted_by, photos: photoStatus });
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
  .field{margin-bottom:14px}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px 16px;font-size:15px;font-weight:700;cursor:pointer;transition:background .2s, transform .1s;text-decoration:none;width:100%}
  .btn:hover{background:var(--accent2)}
  .btn:active{transform:scale(.98)}
  .btn[disabled]{opacity:.5;cursor:not-allowed}
  .btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text2);width:auto;padding:8px 14px;font-size:13px}
  .btn-ghost:hover{background:var(--bg2);color:var(--text)}
  .err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px}
  .ok{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:#6ee7b7;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13.5px}
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;flex-wrap:wrap}
  .small{font-size:11px;color:var(--text3);text-align:center;margin-top:14px}
  .hint{font-size:11px;color:var(--text3);margin-top:4px}
  code{background:var(--bg2);padding:1px 6px;border-radius:4px;font-size:12px;font-family:ui-monospace,monospace;color:var(--accent2)}
  .btn-sec{display:inline-flex;align-items:center;justify-content:center;background:var(--bg2);border:1px solid var(--border);color:var(--accent2);width:auto;padding:9px 14px;font-size:13px;font-weight:700;border-radius:8px;cursor:pointer;text-decoration:none}
  .btn-sec:hover{background:var(--card);color:var(--text)}
  .pslots{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:4px}
  .pslot{position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;border:1px solid var(--border);background:var(--bg2);display:flex;align-items:center;justify-content:center}
  .pslot.empty{border-style:dashed;color:var(--text3);font-size:26px;cursor:pointer;font-weight:300}
  .pslot.empty:hover{border-color:var(--accent);color:var(--accent2)}
  .pslot img{width:100%;height:100%;object-fit:cover;display:block}
  .thumb-x{position:absolute;top:2px;right:2px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.7);color:#fff;border:0;cursor:pointer;font-size:12px;line-height:20px;padding:0;text-align:center;z-index:2}
  @media(max-width:480px){.btn-sec{flex:1}}
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
  <div class="small">Password diberikan oleh admin. · <span style="opacity:.5">build parse-v8</span></div>
</div>
</body></html>`;
}

function renderFormPage(env) {
  const title = escapeHtml(env.APP_TITLE || 'Input Rekomendasi Tracker');

  // Prompt untuk Gemini/ChatGPT. Hasilnya ditempel apa adanya ke kotak data.
  const aiPromptText = [
    'Kamu adalah asisten ekstraksi data. Baca screenshot rekomendasi saham (IDX) yang aku lampirkan, lalu tulis ULANG datanya PERSIS memakai format label di bawah — satu field per baris, tanpa kalimat pembuka/penutup, tanpa markdown. Jika sebuah data tidak ada di gambar, biarkan KOSONG setelah titik dua. Jika ada beberapa saham, ulangi blok ini untuk tiap saham dan pisahkan dengan satu baris kosong.',
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
    'Aturan angka: tulis angka polos tanpa pemisah ribuan (contoh 9500, bukan 9.500). Pakai titik untuk desimal (contoh 1.08). Tipe: tulis BUY atau SELL saja.'
  ].join('\n');

  // String.raw WAJIB: agar backslash pada skrip inline (\n, regex, dst) tidak
  // dimakan template literal — kalau dimakan, JS ke browser rusak & tombol mati.
  return String.raw`<!DOCTYPE html>
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
      <div class="sub">Ambil data dari foto pakai AI → tempel di kotak data → Kirim. Setelah submit, menunggu <b>approve admin</b>.</div>
    </div>
    <a href="/logout" class="btn btn-ghost">Keluar</a>
  </div>

  <div class="card">
    <div class="cardhead"><span class="step">1</span> Salin prompt &amp; buka AI</div>
    <div class="hint" style="margin-bottom:8px">Tekan <b>Salin Prompt</b> → buka Gemini/ChatGPT (akunmu sendiri) → di sana tempel prompt + upload screenshot sinyal → salin hasilnya.</div>
    <textarea id="aiPrompt" rows="6" readonly onclick="this.select()" style="font-size:12px;background:var(--bg2)">${escapeHtml(aiPromptText)}</textarea>
    <div style="display:flex;gap:8px;margin:10px 0 0;flex-wrap:wrap;align-items:center">
      <button type="button" class="btn-sec" onclick="tiCopy()">📋 Salin Prompt</button>
      <a class="btn-sec" href="https://gemini.google.com/app" target="_blank" rel="noopener noreferrer">Buka Gemini ↗</a>
      <a class="btn-sec" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Buka ChatGPT ↗</a>
    </div>
    <div id="aiInfo" class="hint" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <div class="cardhead"><span class="step">2</span> Data rekomendasi</div>
    <div class="hint" style="margin-bottom:8px">Tempel hasil dari AI di sini. <b>Boleh lebih dari satu saham.</b> Edit langsung di kotak ini bila perlu — isi kotak inilah yang dikirim ke admin.</div>
    <textarea id="dataText" rows="12" placeholder="Tempel hasil dari Gemini/ChatGPT di sini…"></textarea>
  </div>

  <div class="card">
    <div class="cardhead"><span class="step">3</span> Foto bukti <span style="color:var(--text3);font-weight:500;font-size:11px;margin-left:6px">(opsional, maks 5)</span></div>
    <div class="hint" style="margin-bottom:8px">Foto <b>dikirim ke admin via Telegram</b> untuk validasi — <b>tidak disimpan</b> di Sheet.</div>
    <div class="pslots" id="photoSlots"><label class="pslot empty" for="photoInput">+</label><label class="pslot empty" for="photoInput">+</label><label class="pslot empty" for="photoInput">+</label><label class="pslot empty" for="photoInput">+</label><label class="pslot empty" for="photoInput">+</label></div>
    <input id="photoInput" type="file" accept="image/*" multiple style="display:none">
    <div id="photoInfo" class="hint" style="margin-top:8px">0/5 foto — ketuk kotak + untuk menambah.</div>
  </div>

  <div class="card">
    <div class="cardhead"><span class="step">4</span> Kirim</div>
    <div id="msg"></div>
    <div class="field">
      <label class="req" for="inputer">Nama inputer</label>
      <input id="inputer" type="text" maxlength="80" placeholder="nama kamu" autocomplete="name">
    </div>
    <button class="btn" id="submitBtn" type="button">Kirim ke Admin</button>
  </div>

  <div class="small">Data masuk sebagai <code>pending</code> → tayang setelah di-approve admin. · <span style="opacity:.5">build parse-v8</span></div>
</div>

<script>
// Penangkap error global: tampilkan error DI LAYAR (bar merah) supaya kalau ada
// yang rusak langsung kelihatan & bisa di-screenshot.
window.__tiErr=function(e){
  try{
    var b=document.getElementById('tiErrBar');
    if(!b){ b=document.createElement('div'); b.id='tiErrBar'; b.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#7f1d1d;color:#fff;font:12px/1.4 ui-monospace,monospace;padding:8px 12px;white-space:pre-wrap;max-height:45vh;overflow:auto'; (document.body||document.documentElement).appendChild(b); }
    b.textContent='⚠ Error skrip halaman (screenshot ke admin):\n'+((e&&e.message)?e.message:e)+((e&&e.stack)?('\n'+e.stack):'');
  }catch(_){}
};
window.onerror=function(msg,url,line,col,err){ window.__tiErr((err&&err.stack)?err.stack:(msg+' @'+line+':'+col)); return false; };

// Salin Prompt — fungsi global di blok terpisah agar tetap jalan walau skrip
// utama bermasalah. Coba Clipboard API, lalu fallback seleksi + execCommand.
function tiCopy(){
  try{
    var t=document.getElementById('aiPrompt'); if(!t) return;
    t.removeAttribute('readonly'); t.focus(); t.select();
    try{ t.setSelectionRange(0, (t.value||'').length); }catch(e){}
    var ok=false; try{ ok=document.execCommand('copy'); }catch(e){}
    t.setAttribute('readonly','');
    if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(t.value).catch(function(){}); }
    var i=document.getElementById('aiInfo');
    if(i) i.innerHTML = ok
      ? '<span style="color:var(--green)">✓ Prompt tersalin! Tinggal tempel di Gemini/ChatGPT.</span>'
      : '<span style="color:var(--yellow)">Teks prompt sudah dipilih — tekan Ctrl+C (di HP: tahan lalu Copy).</span>';
  }catch(e){}
}
</script>

<script>
(function(){
  var msg = document.getElementById('msg');
  var btn = document.getElementById('submitBtn');
  function setMsg(t,c){ if(msg) msg.innerHTML = t ? '<div class="'+c+'">'+t+'</div>' : ''; }
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }

  // ── Upload & kompres foto (maks 5) ──
  var MAX_PHOTOS = 5;
  var photos = [];
  var photoInput = document.getElementById('photoInput');
  var photoSlots = document.getElementById('photoSlots');
  var photoInfo = document.getElementById('photoInfo');

  function renderThumbs(){
    if(!photoSlots) return;
    var html='';
    for(var i=0;i<MAX_PHOTOS;i++){
      if(photos[i]){
        html += '<div class="pslot"><img src="'+photos[i]+'"><button type="button" class="thumb-x" data-i="'+i+'" title="Hapus">✕</button></div>';
      } else {
        html += '<label class="pslot empty" for="photoInput" title="Tambah foto">+</label>';
      }
    }
    photoSlots.innerHTML = html;
    Array.prototype.forEach.call(photoSlots.querySelectorAll('.thumb-x'), function(b){
      b.onclick=function(ev){ ev.stopPropagation(); ev.preventDefault(); photos.splice(parseInt(b.getAttribute('data-i'),10),1); renderThumbs(); };
    });
    if(photoInfo) photoInfo.innerHTML = photos.length + '/5 foto' + (photos.length ? ' — siap dikirim ke Telegram saat Kirim.' : ' — ketuk kotak + untuk menambah.');
  }

  function compress(file){
    return new Promise(function(resolve){
      // Fallback: baca apa adanya (base64) tanpa kompres — utk format yang tak
      // bisa digambar ke canvas (mis. HEIC dari iPhone).
      function raw(){ try{ var fr=new FileReader(); fr.onload=function(){ resolve(fr.result); }; fr.onerror=function(){ resolve(null); }; fr.readAsDataURL(file); }catch(e){ resolve(null); } }
      var img = new Image(); var url;
      try{ url = URL.createObjectURL(file); }catch(e){ return raw(); }
      img.onload = function(){
        try{
          var max=1280, w=img.width, h=img.height;
          if(!w || !h){ URL.revokeObjectURL(url); return raw(); }
          if(w>max||h>max){ if(w>=h){ h=Math.round(h*max/w); w=max; } else { w=Math.round(w*max/h); h=max; } }
          var c=document.createElement('canvas'); c.width=w; c.height=h;
          c.getContext('2d').drawImage(img,0,0,w,h);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.72));
        }catch(e){ try{URL.revokeObjectURL(url);}catch(_){} raw(); }
      };
      img.onerror=function(){ try{URL.revokeObjectURL(url);}catch(_){} raw(); };
      img.src=url;
    });
  }

  if(photoInput) photoInput.onchange = async function(){
    try{
      var files = Array.prototype.slice.call(photoInput.files||[]);
      for(var i=0;i<files.length;i++){
        if(photos.length>=MAX_PHOTOS){ if(photoInfo) photoInfo.innerHTML='<span style="color:var(--yellow)">Maksimal '+MAX_PHOTOS+' foto.</span>'; break; }
        if(!/^image\//.test(files[i].type||'')) continue;
        var d = await compress(files[i]);
        if(d) photos.push(d);
      }
      photoInput.value='';
      renderThumbs();
    }catch(e){ window.__tiErr&&window.__tiErr(e); }
  };
  try{ renderThumbs(); }catch(e){ window.__tiErr&&window.__tiErr(e); }

  // ── Kirim ──
  if(btn) btn.addEventListener('click', async function(){
    setMsg('','');
    var text = (document.getElementById('dataText').value || '').trim();
    var inputer = (document.getElementById('inputer').value || '').trim();
    if(!inputer){ setMsg('Isi <b>nama inputer</b> dulu.', 'err'); return; }
    if(!text){ setMsg('Isi <b>data rekomendasi</b> dulu (tempel hasil AI di kotak Langkah 2).', 'err'); return; }
    btn.disabled = true; var lbl = btn.textContent; btn.textContent = 'Mengirim…';
    try{
      var res = await fetch('/api/submit', {
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ text: text, submitted_by: inputer, photos: photos })
      });
      if(res.status===401){ setMsg('Sesi login sudah habis. Halaman akan dimuat ulang untuk login lagi…','err'); setTimeout(function(){ location.href='/'; }, 1600); return; }
      var j = await res.json().catch(function(){ return {}; });
      if(!res.ok || j.error){ throw new Error(j.error || ('HTTP '+res.status)); }
      setMsg('✓ Terkirim ke admin.' + ((j.photos&&j.photos.sent)?(' '+j.photos.sent+' foto dikirim ke Telegram.'):'') + ' Menunggu approve. Kotak dikosongkan untuk input berikutnya.', 'ok');
      document.getElementById('dataText').value='';
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

      // Login: POST memproses password; GET diarahkan balik ke halaman utama.
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
