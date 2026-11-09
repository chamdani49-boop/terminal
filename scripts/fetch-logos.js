#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
 * fetch-logos.js — unduh logo emiten ke public/logos/<KODE>.png
 *
 * Sumber daftar kode : public/data.json → stock_info (semua emiten IDX).
 * Sumber gambar      : https://assets.stockbit.com/logos/companies/<KODE>.png
 * Output             : public/logos/<KODE>.png  (hanya ditulis bila berubah)
 *                      public/logos/index.json  (daftar kode yg punya logo,
 *                      dibaca public/stock-logos.js supaya tidak request 404)
 *
 * Logo yang gagal diunduh (404 / error jaringan) TIDAK menghapus file lama.
 * Jalankan: node scripts/fetch-logos.js
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'logos');
const DATA_JSON = path.join(ROOT, 'public', 'data.json');
const SRC = (code) => `https://assets.stockbit.com/logos/companies/${code}.png`;
const CONCURRENCY = 8;
const MAX_BYTES = 512 * 1024;

function loadCodes() {
  const data = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
  const codes = Object.keys(data.stock_info || {})
    .map((c) => String(c).trim().toUpperCase())
    .filter((c) => /^[A-Z0-9]{2,6}$/.test(c));
  return [...new Set(codes)].sort();
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function fetchOne(code) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(SRC(code), { signal: AbortSignal.timeout(20000) });
      if (res.status === 404 || res.status === 403) return { code, status: 'missing' };
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_BYTES || !buf.subarray(0, 8).equals(PNG_SIG)) {
        return { code, status: 'invalid' };
      }
      return { code, status: 'ok', buf };
    } catch (e) {
      if (attempt === 3) return { code, status: 'error', err: e.message };
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function main() {
  const codes = loadCodes();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Kode emiten: ${codes.length}`);

  const stats = { written: 0, unchanged: 0, missing: [], failed: [] };
  let i = 0;
  async function worker() {
    while (i < codes.length) {
      const code = codes[i++];
      const r = await fetchOne(code);
      const file = path.join(OUT_DIR, code + '.png');
      if (r.status === 'ok') {
        const old = fs.existsSync(file) ? fs.readFileSync(file) : null;
        if (old && old.equals(r.buf)) stats.unchanged++;
        else { fs.writeFileSync(file, r.buf); stats.written++; }
      } else if (r.status === 'missing' || r.status === 'invalid') {
        stats.missing.push(code);
      } else {
        stats.failed.push(code);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // index.json = semua kode yang file logonya ada di disk (termasuk sisa
  // unduhan lama bila kali ini gagal sementara).
  const available = fs.readdirSync(OUT_DIR)
    .filter((f) => /^[A-Z0-9]{2,6}\.png$/.test(f))
    .map((f) => f.replace(/\.png$/, ''))
    .sort();
  const indexFile = path.join(OUT_DIR, 'index.json');
  const next = JSON.stringify({ codes: available }) + '\n';
  const prev = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  if (prev !== next) fs.writeFileSync(indexFile, next);

  console.log(`Ditulis: ${stats.written}, tidak berubah: ${stats.unchanged}, total tersedia: ${available.length}`);
  if (stats.missing.length) console.log(`Tidak ada logo (${stats.missing.length}): ${stats.missing.join(', ')}`);
  if (stats.failed.length) console.log(`Gagal sementara (${stats.failed.length}): ${stats.failed.join(', ')}`);

  // Gagal total (mis. sumber memblokir) → exit non-zero agar workflow kelihatan merah.
  if (stats.written + stats.unchanged === 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
