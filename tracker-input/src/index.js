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
  const tp     = Number(body.tp);
  const sl     = Number(body.sl);
  const tanggal = String(body.tanggal || '').trim();

  const errs = [];
  if (!analis) errs.push('Nama analis wajib diisi.');
  if (!/^[A-Z0-9.\-]{1,12}$/.test(ticker)) errs.push('Kode saham tidak valid.');
  if (!TIPE_OPTS.includes(tipe)) errs.push('Tipe harus BUY atau SELL.');
  if (!(entry > 0)) errs.push('Entry harus angka > 0.');
  if (!(tp > 0)) errs.push('Target (TP) harus angka > 0.');
  if (!(sl > 0)) errs.push('Stop Loss (SL) harus angka > 0.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tanggal)) errs.push('Tanggal harus format YYYY-MM-DD.');
  // Sanity arah TP/SL relatif entry (peringatan, tetap divalidasi).
  if (entry > 0 && tp > 0 && sl > 0) {
    if (tipe === 'BUY' && !(tp > entry && sl < entry)) errs.push('Untuk BUY: TP harus di atas Entry, SL di bawah Entry.');
    if (tipe === 'SELL' && !(tp < entry && sl > entry)) errs.push('Untuk SELL: TP harus di bawah Entry, SL di atas Entry.');
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
    tp,
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

  return jsonRes({ ok: true, ticker, tipe });
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

      <div class="grid3">
        <div class="field">
          <label class="req" for="entry">Entry</label>
          <input id="entry" name="entry" type="number" step="any" min="0" required inputmode="decimal">
        </div>
        <div class="field">
          <label class="req" for="tp">Target (TP)</label>
          <input id="tp" name="tp" type="number" step="any" min="0" required inputmode="decimal">
        </div>
        <div class="field">
          <label class="req" for="sl">Stop Loss (SL)</label>
          <input id="sl" name="sl" type="number" step="any" min="0" required inputmode="decimal">
        </div>
      </div>
      <div class="hint" id="dirHint">BUY: TP di atas Entry, SL di bawah. SELL: kebalikannya.</div>

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

  f.addEventListener('submit', async function(e){
    e.preventDefault();
    setMsg('', '');
    var data = {
      analis: f.analis.value, firm: f.firm.value, sertifikasi: f.sertifikasi.value,
      ticker: f.ticker.value, tipe: f.tipe.value,
      entry: f.entry.value, tp: f.tp.value, sl: f.sl.value,
      tanggal: f.tanggal.value, horizon: f.horizon.value,
      catatan: f.catatan.value, submitted_by: f.submitted_by.value
    };
    btn.disabled = true; var lbl = btn.textContent; btn.textContent = 'Mengirim…';
    try{
      var res = await fetch('/api/submit', {
        method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'}, body: JSON.stringify(data)
      });
      var j = await res.json().catch(function(){ return {}; });
      if(!res.ok || j.error){ throw new Error(j.error || ('HTTP '+res.status)); }
      setMsg('✓ Terkirim: <b>'+esc(j.tipe)+' '+esc(j.ticker)+'</b>. Menunggu approve admin. Form dikosongkan untuk input berikutnya.', 'ok');
      // Reset tapi pertahankan nama analis, firm, sertifikasi, & "diinput oleh"
      var keepA=f.analis.value, keepF=f.firm.value, keepS=f.sertifikasi.value, keepBy=f.submitted_by.value;
      f.reset();
      f.analis.value=keepA; f.firm.value=keepF; f.sertifikasi.value=keepS; f.submitted_by.value=keepBy;
      f.tanggal.value = new Date().toISOString().slice(0,10);
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
