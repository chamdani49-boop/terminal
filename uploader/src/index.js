/**
 * valuation-uploader — Cloudflare Worker
 *
 * Halaman web sederhana untuk:
 *   - Login via password (env APP_PASSWORD)
 *   - List file .xlsx di data/valuation/ (via GitHub Contents API)
 *   - Upload file .xlsx baru (commit ke main)
 *   - Hapus file (DELETE commit ke main)
 *
 * Tidak ada framework, tidak ada build step. Pure Worker JS.
 *
 * Env yang dibutuhkan:
 *   - GITHUB_TOKEN   (secret) — PAT dgn scope repo / fine-grained Contents R&W
 *   - APP_PASSWORD   (secret) — password login UI
 *   - GITHUB_OWNER   (var)   — default "chamdani49-boop"
 *   - GITHUB_REPO    (var)   — default "terminal"
 *   - GITHUB_BRANCH  (var)   — default "main"
 *   - UPLOAD_DIR     (var)   — default "data/valuation"
 */

const COOKIE_NAME = 'vu_auth';
const COOKIE_MAX_AGE = 60 * 60 * 12; // 12 jam

// ── Helpers ────────────────────────────────────────────────────────────

function envCfg(env) {
  return {
    owner:  env.GITHUB_OWNER  || 'chamdani49-boop',
    repo:   env.GITHUB_REPO   || 'terminal',
    branch: env.GITHUB_BRANCH || 'main',
    dir:    (env.UPLOAD_DIR   || 'data/valuation').replace(/^\/+|\/+$/g, ''),
  };
}

async function sha256Hex(s) {
  const buf = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function expectedToken(env) {
  // Token cookie = HMAC-ish dari APP_PASSWORD. Kalau password diganti,
  // semua sesi lama otomatis invalid.
  const pw = env.APP_PASSWORD || '';
  return sha256Hex('valuation-uploader:v1:' + pw);
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ── GitHub API ──────────────────────────────────────────────────────────

async function ghFetch(path, env, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'valuation-uploader-worker',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (_) { body = { _raw: text }; }
  }
  return { status: res.status, body };
}

async function ghListDir(env) {
  const cfg = envCfg(env);
  const path = `${cfg.dir}`;
  const { status, body } = await ghFetch(
    `/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${encodeURIComponent(cfg.branch)}`,
    env
  );
  if (status !== 200) {
    return { error: 'GitHub list gagal', status, detail: body };
  }
  if (!Array.isArray(body)) return { items: [] };
  return {
    items: body
      .filter(f => f && f.type === 'file')
      .map(f => ({
        name: f.name,
        size: f.size,
        sha: f.sha,
        path: f.path,
        download_url: f.download_url,
        html_url: f.html_url,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function ghPutFile(env, filename, contentB64, sha) {
  const cfg = envCfg(env);
  const apiPath = `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dir}/${encodeURIComponent(filename)}`;
  const body = {
    message: sha ? `valuation: replace ${filename}` : `valuation: add ${filename}`,
    content: contentB64,
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  return ghFetch(apiPath, env, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function ghDeleteFile(env, filename, sha) {
  const cfg = envCfg(env);
  const apiPath = `/repos/${cfg.owner}/${cfg.repo}/contents/${cfg.dir}/${encodeURIComponent(filename)}`;
  return ghFetch(apiPath, env, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `valuation: delete ${filename}`,
      sha,
      branch: cfg.branch,
    }),
  });
}

// ── Handlers ────────────────────────────────────────────────────────────

async function handleLogin(request, env) {
  const form = await request.formData();
  const password = form.get('password') || '';
  if (!env.APP_PASSWORD) {
    return new Response(renderLoginPage('APP_PASSWORD belum di-set di Worker secret.'), {
      status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  if (password !== env.APP_PASSWORD) {
    return new Response(renderLoginPage('Password salah.'), {
      status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  return new Response(null, {
    status: 303,
    headers: {
      'Location': '/',
      'Set-Cookie': await authCookieHeader(env),
    },
  });
}

function handleLogout() {
  return new Response(null, {
    status: 303,
    headers: { 'Location': '/', 'Set-Cookie': clearCookieHeader() },
  });
}

async function apiList(env) {
  const result = await ghListDir(env);
  if (result.error) return jsonRes(result, result.status || 500);
  return jsonRes({ items: result.items });
}

async function apiUpload(request, env) {
  if (!env.GITHUB_TOKEN) return jsonRes({ error: 'GITHUB_TOKEN belum di-set' }, 500);

  const ct = request.headers.get('Content-Type') || '';
  if (!ct.startsWith('multipart/form-data')) {
    return jsonRes({ error: 'Content-Type harus multipart/form-data' }, 400);
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string' || !file.name) {
    return jsonRes({ error: 'Field "file" tidak ditemukan' }, 400);
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return jsonRes({ error: 'Hanya file .xlsx yang diperbolehkan' }, 400);
  }
  if (file.size > 80 * 1024 * 1024) {
    return jsonRes({ error: 'Ukuran file melebihi 80 MB (limit GitHub Contents API)' }, 413);
  }

  // Cek apakah file dgn nama sama sudah ada → ambil sha utk update.
  const list = await ghListDir(env);
  if (list.error) return jsonRes(list, list.status || 500);
  const existing = list.items.find(f => f.name === file.name);

  const buffer = await file.arrayBuffer();
  const b64 = arrayBufferToBase64(buffer);
  const result = await ghPutFile(env, file.name, b64, existing ? existing.sha : null);

  if (result.status >= 200 && result.status < 300) {
    return jsonRes({
      ok: true,
      name: file.name,
      replaced: !!existing,
      commit: result.body && result.body.commit && result.body.commit.html_url,
    });
  }
  return jsonRes({ error: 'Upload ke GitHub gagal', status: result.status, detail: result.body }, 502);
}

async function apiDelete(request, env) {
  if (!env.GITHUB_TOKEN) return jsonRes({ error: 'GITHUB_TOKEN belum di-set' }, 500);

  const url = new URL(request.url);
  const name = url.searchParams.get('name');
  if (!name) return jsonRes({ error: 'Parameter "name" diperlukan' }, 400);

  const list = await ghListDir(env);
  if (list.error) return jsonRes(list, list.status || 500);
  const existing = list.items.find(f => f.name === name);
  if (!existing) return jsonRes({ error: 'File tidak ditemukan' }, 404);

  const result = await ghDeleteFile(env, name, existing.sha);
  if (result.status >= 200 && result.status < 300) {
    return jsonRes({
      ok: true,
      name,
      commit: result.body && result.body.commit && result.body.commit.html_url,
    });
  }
  return jsonRes({ error: 'Hapus di GitHub gagal', status: result.status, detail: result.body }, 502);
}

// ── HTML pages ─────────────────────────────────────────────────────────

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
  .wrap{max-width:880px;margin:0 auto}
  .card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;margin-bottom:16px}
  h1{margin:0 0 4px;font-size:22px;font-weight:700;letter-spacing:.3px}
  .sub{color:var(--text2);font-size:13px;margin-bottom:18px}
  label{display:block;font-size:12px;color:var(--text2);margin-bottom:6px;font-weight:600;letter-spacing:.5px;text-transform:uppercase}
  input[type=password],input[type=text]{width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px;outline:none;transition:border-color .2s, box-shadow .2s}
  input[type=password]:focus,input[type=text]:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(124,58,237,.18)}
  .btn{display:inline-flex;align-items:center;gap:6px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:13px;font-weight:700;cursor:pointer;transition:background .2s, transform .1s;text-decoration:none}
  .btn:hover{background:var(--accent2)}
  .btn:active{transform:scale(.97)}
  .btn[disabled]{opacity:.5;cursor:not-allowed}
  .btn-ghost{background:transparent;border:1px solid var(--border);color:var(--text2)}
  .btn-ghost:hover{background:var(--bg2);color:var(--text)}
  .btn-danger{background:var(--red)}
  .btn-danger:hover{background:#dc2626}
  .err{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px}
  .ok{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.3);color:#6ee7b7;border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13px}
  .info{background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.3);color:var(--accent2);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12.5px;line-height:1.6}
  table{width:100%;border-collapse:collapse;margin-top:6px}
  th{text-align:left;font-size:11px;color:var(--text3);font-weight:700;letter-spacing:.7px;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid var(--border)}
  td{padding:11px 10px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle}
  tr:last-child td{border-bottom:0}
  td.size{color:var(--text2);font-variant-numeric:tabular-nums;white-space:nowrap}
  td.act{text-align:right;white-space:nowrap}
  .empty{padding:20px;text-align:center;color:var(--text3);font-size:13px}
  .drop{border:2px dashed var(--border);border-radius:var(--radius);padding:24px;text-align:center;color:var(--text2);transition:border-color .2s, background .2s;cursor:pointer}
  .drop:hover,.drop.over{border-color:var(--accent);background:rgba(124,58,237,.06);color:var(--text)}
  .drop input{display:none}
  .drop .big{font-size:15px;font-weight:600;color:var(--text);margin-bottom:4px}
  .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;flex-wrap:wrap}
  .small{font-size:11px;color:var(--text3)}
  a{color:var(--accent2);text-decoration:none}
  a:hover{text-decoration:underline}
  .progress{margin-top:10px;height:6px;background:var(--bg2);border-radius:999px;overflow:hidden;display:none}
  .progress.active{display:block}
  .progress > div{height:100%;background:var(--accent);width:0%;transition:width .15s}
  code{background:var(--bg2);padding:1px 6px;border-radius:4px;font-size:12px;font-family:ui-monospace,monospace;color:var(--accent2)}
</style>
`;

function renderLoginPage(error) {
  const errHtml = error ? `<div class="err">${escapeHtml(error)}</div>` : '';
  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login · Valuation Uploader</title>
${STYLE}
</head><body>
<div class="wrap" style="max-width:380px;margin-top:80px">
  <div class="card">
    <h1>Valuation Uploader</h1>
    <div class="sub">Login dulu untuk akses upload file Excel valuasi.</div>
    ${errHtml}
    <form method="POST" action="/login">
      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" autofocus required>
      <div style="margin-top:14px"><button class="btn" type="submit" style="width:100%;justify-content:center">Masuk</button></div>
    </form>
  </div>
  <div class="small" style="text-align:center">Hanya admin repo yang punya passwordnya.</div>
</div>
</body></html>`;
}

function renderAppPage(env) {
  const cfg = envCfg(env);
  const repoUrl = `https://github.com/${cfg.owner}/${cfg.repo}/tree/${cfg.branch}/${cfg.dir}`;
  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Valuation Uploader</title>
${STYLE}
</head><body>
<div class="wrap">
  <div class="top">
    <div>
      <h1>Valuation Uploader</h1>
      <div class="sub">Folder: <code>${cfg.dir}/</code> di <a href="${repoUrl}" target="_blank" rel="noopener">${cfg.owner}/${cfg.repo}@${cfg.branch}</a></div>
    </div>
    <a href="/logout" class="btn btn-ghost">Keluar</a>
  </div>

  <div class="info">
    <strong>Cara pakai:</strong> drag-drop atau klik area di bawah untuk upload <code>.xlsx</code>.
    Setelah upload/hapus berhasil, GitHub Actions <code>refresh-valuation</code> auto-trigger
    dan rebuild <code>valuation.json</code> dalam ~30 detik.
  </div>

  <div class="card">
    <label class="drop" id="drop" tabindex="0">
      <input type="file" id="filePick" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple>
      <div class="big">Klik / drop file <code>.xlsx</code> di sini untuk upload</div>
      <div class="small">Maks 80 MB per file. File dengan nama yang sama akan di-overwrite.</div>
    </label>
    <div class="progress" id="prog"><div></div></div>
    <div id="msg" style="margin-top:10px"></div>
  </div>

  <div class="card">
    <div class="top" style="margin-bottom:6px">
      <strong style="font-size:14px">File saat ini</strong>
      <button class="btn btn-ghost" id="refresh" type="button">Refresh</button>
    </div>
    <div id="list">
      <div class="empty">Memuat...</div>
    </div>
  </div>

  <div class="small" style="text-align:center;margin-top:18px">
    Workflow refresh: <a href="https://github.com/${cfg.owner}/${cfg.repo}/actions/workflows/refresh-valuation.yml" target="_blank" rel="noopener">refresh-valuation.yml</a>
  </div>
</div>

<script>
(function(){
  const $list = document.getElementById('list');
  const $drop = document.getElementById('drop');
  const $pick = document.getElementById('filePick');
  const $msg  = document.getElementById('msg');
  const $prog = document.getElementById('prog');
  const $refr = document.getElementById('refresh');

  function fmtSize(n){
    if(n==null) return '-';
    if(n<1024) return n+' B';
    if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
    return (n/(1024*1024)).toFixed(2)+' MB';
  }
  function setMsg(text, cls){
    $msg.innerHTML = text ? '<div class="'+cls+'">'+text+'</div>' : '';
  }
  function showProg(on){
    $prog.classList.toggle('active', !!on);
    if(!on) $prog.firstElementChild.style.width='0%';
  }

  async function loadList(){
    $list.innerHTML = '<div class="empty">Memuat...</div>';
    try{
      const res = await fetch('/api/list', {credentials:'same-origin'});
      const j = await res.json();
      if(!res.ok || j.error){ throw new Error(j.error || ('HTTP '+res.status)); }
      renderList(j.items || []);
    }catch(e){
      $list.innerHTML = '<div class="err">Gagal memuat daftar: '+escapeHtml(e.message)+'</div>';
    }
  }

  function renderList(items){
    if(!items.length){
      $list.innerHTML = '<div class="empty">Belum ada file.</div>';
      return;
    }
    let h = '<table><thead><tr><th>Nama</th><th>Ukuran</th><th></th></tr></thead><tbody>';
    items.forEach(f=>{
      h += '<tr>'+
        '<td><a href="'+escapeAttr(f.html_url)+'" target="_blank" rel="noopener">'+escapeHtml(f.name)+'</a></td>'+
        '<td class="size">'+fmtSize(f.size)+'</td>'+
        '<td class="act"><button class="btn btn-danger" data-name="'+escapeAttr(f.name)+'" type="button">Hapus</button></td>'+
      '</tr>';
    });
    h += '</tbody></table>';
    $list.innerHTML = h;
    $list.querySelectorAll('button[data-name]').forEach(btn=>{
      btn.addEventListener('click', ()=> doDelete(btn.getAttribute('data-name')));
    });
  }

  async function doDelete(name){
    if(!confirm('Hapus file "'+name+'" dari repo? Tindakan ini akan langsung commit ke main.')) return;
    setMsg('Menghapus '+escapeHtml(name)+'...', 'info');
    try{
      const res = await fetch('/api/delete?name='+encodeURIComponent(name), {method:'DELETE', credentials:'same-origin'});
      const j = await res.json();
      if(!res.ok || j.error){ throw new Error(j.error || ('HTTP '+res.status)); }
      setMsg('Berhasil dihapus: <code>'+escapeHtml(name)+'</code>'+(j.commit?' · <a href="'+escapeAttr(j.commit)+'" target="_blank">commit</a>':''), 'ok');
      loadList();
    }catch(e){
      setMsg('Gagal hapus: '+escapeHtml(e.message), 'err');
    }
  }

  async function doUpload(file){
    if(!file) return;
    if(!/\\.xlsx$/i.test(file.name)){
      setMsg('Hanya file .xlsx yg diperbolehkan: '+escapeHtml(file.name), 'err');
      return;
    }
    setMsg('Mengupload '+escapeHtml(file.name)+' ('+fmtSize(file.size)+')...', 'info');
    showProg(true);
    try{
      const fd = new FormData();
      fd.append('file', file, file.name);
      const xhr = new XMLHttpRequest();
      const done = await new Promise((resolve, reject)=>{
        xhr.upload.addEventListener('progress', (e)=>{
          if(e.lengthComputable){
            const pct = Math.min(99, (e.loaded/e.total)*100);
            $prog.firstElementChild.style.width = pct.toFixed(1)+'%';
          }
        });
        xhr.addEventListener('load', ()=>{
          $prog.firstElementChild.style.width = '100%';
          let body=null; try{ body = JSON.parse(xhr.responseText); }catch(_){}
          resolve({ status:xhr.status, body });
        });
        xhr.addEventListener('error', ()=> reject(new Error('Network error')));
        xhr.open('POST', '/api/upload');
        xhr.withCredentials = true;
        xhr.send(fd);
      });
      const { status, body } = done;
      if(status<200||status>=300 || !body || body.error){
        throw new Error((body && body.error) || ('HTTP '+status));
      }
      const tag = body.replaced ? 'di-overwrite' : 'di-upload';
      setMsg('Berhasil '+tag+': <code>'+escapeHtml(body.name)+'</code>'+(body.commit?' · <a href="'+escapeAttr(body.commit)+'" target="_blank">commit</a>':''), 'ok');
    }catch(e){
      setMsg('Gagal upload: '+escapeHtml(e.message), 'err');
    }finally{
      setTimeout(()=> showProg(false), 600);
      loadList();
    }
  }

  async function uploadAll(files){
    for(const f of files){
      // upload sequential supaya tidak race di GitHub API
      await doUpload(f);
    }
  }

  function escapeHtml(s){
    return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  }
  function escapeAttr(s){ return escapeHtml(s); }

  $drop.addEventListener('click', ()=> $pick.click());
  $drop.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); $pick.click(); } });
  $pick.addEventListener('change', ()=>{ if($pick.files && $pick.files.length){ uploadAll(Array.from($pick.files)); $pick.value=''; } });
  ;['dragenter','dragover'].forEach(ev=> $drop.addEventListener(ev, e=>{ e.preventDefault(); $drop.classList.add('over'); }));
  ;['dragleave','drop'].forEach(ev=> $drop.addEventListener(ev, e=>{ e.preventDefault(); $drop.classList.remove('over'); }));
  $drop.addEventListener('drop', e=>{
    if(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length){
      uploadAll(Array.from(e.dataTransfer.files));
    }
  });
  $refr.addEventListener('click', loadList);

  loadList();
})();
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

// ── Router ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    // Public: login form
    if (path === '/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/logout') return handleLogout();

    const authed = await isAuthed(request, env);

    // Protected routes
    if (path === '/api/list' && method === 'GET') {
      if (!authed) return jsonRes({ error: 'unauthorized' }, 401);
      return apiList(env);
    }
    if (path === '/api/upload' && method === 'POST') {
      if (!authed) return jsonRes({ error: 'unauthorized' }, 401);
      return apiUpload(request, env);
    }
    if (path === '/api/delete' && method === 'DELETE') {
      if (!authed) return jsonRes({ error: 'unauthorized' }, 401);
      return apiDelete(request, env);
    }

    // HTML
    if (path === '/' || path === '/index.html') {
      const html = authed ? renderAppPage(env) : renderLoginPage(null);
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};
