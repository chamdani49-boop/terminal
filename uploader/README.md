# valuation-uploader

Cloudflare Worker yang menyajikan halaman web sederhana untuk **upload, list, dan hapus** file Excel valuasi (`.xlsx`) di folder `data/valuation/` repo ini, tanpa harus pakai UI GitHub.

Setiap upload/hapus = 1 commit ke `main` lewat **GitHub Contents API**, sehingga workflow [`refresh-valuation.yml`](../.github/workflows/refresh-valuation.yml) auto-trigger dan rebuild `public/valuation.json`.

---

## URL hasil deploy

Setelah deploy:

```
https://valuation-uploader.<subdomain-akun-kamu>.workers.dev/
```

Untuk akun `chamdani49` → `https://valuation-uploader.chamdani49.workers.dev/`

---

## Deploy

Prasyarat: sudah login `wrangler` (`npx wrangler login`).

```bash
cd uploader
npx wrangler deploy
```

Setelah deploy sukses, set 2 secret:

```bash
# Personal Access Token GitHub dgn izin commit ke repo "terminal".
# - Classic PAT: pilih scope "repo".
# - Fine-grained PAT (lebih aman): batasi ke repo "terminal" saja, izin
#   "Contents: Read and write".
npx wrangler secret put GITHUB_TOKEN

# Password buat login halaman uploader (bebas, makin panjang makin baik).
npx wrangler secret put APP_PASSWORD
```

Selesai. Buka URL Worker, login pakai `APP_PASSWORD`, lalu upload/hapus file.

---

## Variabel non-rahasia

Sudah di-set di `wrangler.toml`:

| Var             | Default              | Keterangan                                  |
|-----------------|----------------------|---------------------------------------------|
| `GITHUB_OWNER`  | `chamdani49-boop`    | Owner repo target                           |
| `GITHUB_REPO`   | `terminal`           | Nama repo                                   |
| `GITHUB_BRANCH` | `main`               | Branch yang di-commit                       |
| `UPLOAD_DIR`    | `data/valuation`     | Folder tempat file di-simpan dlm repo      |

---

## Endpoint

| Method | Path           | Auth          | Keterangan                                  |
|--------|----------------|---------------|---------------------------------------------|
| GET    | `/`            | Cookie/login  | UI utama (login form atau halaman uploader) |
| POST   | `/login`       | Public        | Submit password → set cookie `vu_auth`      |
| GET    | `/logout`      | Public        | Hapus cookie                                |
| GET    | `/api/list`    | Cookie        | List file di `UPLOAD_DIR`                   |
| POST   | `/api/upload`  | Cookie        | Multipart upload (`field=file`, max 80 MB)  |
| DELETE | `/api/delete?name=...` | Cookie | Hapus file by nama                       |

Cookie `vu_auth` di-set HttpOnly + Secure + SameSite=Lax, masa berlaku 12 jam.

---

## Catatan keamanan

- Hanya 1 password global (`APP_PASSWORD`). Kalau bocor, ganti via `npx wrangler secret put APP_PASSWORD` — semua sesi lama otomatis invalid (token cookie di-derive dari password).
- `GITHUB_TOKEN` bisa commit ke main. Jangan share password ke orang yang tidak punya akses repo.
- Worker tidak menyimpan log file content; hanya proxy ke GitHub API.
- File yang di-upload langsung commit ke `main`. Tidak ada review/PR. Cocok karena workflow yang trigger memang aman (cuma rebuild JSON dari Excel).

---

## Limit

- Maks 1 file 80 MB per upload (limit GitHub Contents API ~100 MB; kita ngasih buffer).
- Hanya `.xlsx` (validasi extension di server & client).
- Multi-file upload didukung di UI; di-upload sekuensial supaya tidak race di GitHub API.

---

## Kalau ada error

- **"GITHUB_TOKEN belum di-set"** → jalanin `npx wrangler secret put GITHUB_TOKEN`.
- **"APP_PASSWORD belum di-set"** → jalanin `npx wrangler secret put APP_PASSWORD`.
- **"GitHub list gagal" / 401** → token salah / expired / izin kurang.
- **"GitHub list gagal" / 404** → owner/repo/branch/folder salah di `wrangler.toml`.
- **Workflow tidak trigger setelah upload** → cek tab Actions di GitHub. Trigger workflow manual dari sana kalau perlu (`workflow_dispatch`).
