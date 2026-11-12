#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════
 * build-smartmoney-screener.js — ringkasan SEMUA saham untuk menu
 * Smart Money › Screener (admin).
 *
 * Kenapa: Screener butuh ±960 saham sekaligus. Mengambil 1 file per saham
 * dari R2 terlalu berat, jadi skrip ini merangkum file per saham menjadi
 * SATU file `screener/summary.json` di bucket R2 `smartmoney`.
 *
 * Input  : folder lokal berisi file yang sama dengan yang diunggah
 *          upload_smartmoney.py:
 *            <dir>/broker/{KODE}.json   (wajib untuk saham itu)
 *            <dir>/insider/{KODE}.json  (opsional)
 *            <dir>/holder/{KODE}.json   (opsional)
 * Output : <out> (default <dir>/screener/summary.json)
 *
 * Pakai  :
 *   node scripts/build-smartmoney-screener.js --dir ../smartmoney
 *   npx wrangler r2 object put smartmoney/screener/summary.json \
 *       --file ../smartmoney/screener/summary.json --remote
 *   (atau tambahkan --upload untuk menjalankan perintah wrangler di atas)
 *
 * Format summary.json (v1). Nilai rupiah dalam satuan `u` (Rp1 jt), lot utuh:
 *   { v:1, updated, u:100000, days:[iso…≤140],
 *     stocks:{ KODE:{
 *       g:{ smB,smS,smBL,smSL, rtB,rtS,rtBL,rtSL, fB,fS }   // array sejajar `days`
 *       bk:[[code, nv[≤21 hari terakhir], [bv,sv,bl,sl] 6 bln, n10, trough, peak], …]  // ≤12 broker + 5 net beli & 5 net jual terbesar
 *       asc:'XX'|null, ascBv:[≤21],                          // associate broker (underwriter)
 *       ins:[[date,name,role,'BUY'|'SELL',shares,price], …], // ≤140 hari
 *       h5:[[ 'YYYY-MM', name, pct ], …],                    // pemegang ≥4,5%, 4 bulan terakhir
 *       ff:freeFloat(0-1)|null, so:sharesOut|null } } }
 * Klasifikasi ritel SAMA dengan public/smartmoney-screener.js (RETAIL).
 *
 * Indeks tambahan (popup broker & popup nama di Smart Money), ikut ditulis & diunggah:
 *   brokers/{BROKER}.json → { v:1, updated, u:1e6, days:[iso ≤250],
 *                             s:{ SAHAM:[[iDay, bv, sv, bl, sl], …] } }   bv/sv dalam satuan u, bl/sl lot
 *   people.json           → { v:1, updated, p:{ NAMA_NORMAL:{ n:nama, t:[[saham,date,role,'B'|'S',lembar,harga,nilai]],
 *                             h:[[saham,'YYYY-MM',pct,tipe]], b:[[saham,jabatan]], o:[[saham,via,pct]] } } }
 * ══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const RETAIL = { YP: 1, XL: 1, PD: 1, XC: 1, KK: 1, CP: 1, EP: 1 };
const DAYS = 140, WIN = 126, NV_DAYS = 21, TOP_BK = 12, U = 1e6, BK_DAYS = 250;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function num(v) { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; }
function isoOf(x) {
  if (typeof x === 'number') return new Date(x < 1e12 ? x * 1000 : x).toISOString().slice(0, 10);
  const s = String(x || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}
const r = v => Math.round(v / U);       // rupiah → satuan U
const rl = v => Math.round(v);           // lot

function brokerCodes() {
  const file = path.join(__dirname, '..', 'public', 'broker-codes.js');
  const ctx = { window: {} };
  try { vm.runInNewContext(fs.readFileSync(file, 'utf8'), ctx); } catch (e) { console.warn('broker-codes.js gagal dibaca:', e.message); }
  return ctx.window.BrokerCodes || { LIST: [], get: () => null };
}

function buildStock(code, B, I, H, BC) {
  if (!B || !Array.isArray(B.days) || !Array.isArray(B.brokers) || !B.days.length) return null;
  const allDays = B.days.map(isoOf);
  const order = allDays.map((d, i) => [d, i]).filter(x => x[0]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const uniq = [...new Set(order.map(x => x[0]))].slice(-DAYS);
  const dIdx = {}; uniq.forEach((d, i) => { dIdx[d] = i; });
  const n = uniq.length;
  const zero = () => new Array(n).fill(0);
  const g = { smB: zero(), smS: zero(), smBL: zero(), smSL: zero(), rtB: zero(), rtS: zero(), rtBL: zero(), rtSL: zero(), fB: zero(), fS: zero() };
  const foreign = {}; (BC.LIST || []).forEach(b => { foreign[b.code] = !!b.foreign; });
  const wS = n - Math.min(WIN, n);
  const rows = [];
  B.brokers.forEach(raw => {
    const cd = String(raw.code || '').toUpperCase(); if (!cd) return;
    const R = !!RETAIL[cd], fx = ['fbv', 'fsv'].every(k => Array.isArray(raw[k]));
    const isF = (foreign[cd] != null ? foreign[cd] : !!raw.foreign) && !R;
    const nv = zero(), w = [0, 0, 0, 0];
    allDays.forEach((d, i) => {
      const t = dIdx[d]; if (t === undefined) return;
      const bv = num(raw.bv && raw.bv[i]), sv = num(raw.sv && raw.sv[i]), bl = num(raw.bl && raw.bl[i]), sl = num(raw.sl && raw.sl[i]);
      const p = R ? 'rt' : 'sm';
      g[p + 'B'][t] += bv; g[p + 'S'][t] += sv; g[p + 'BL'][t] += bl; g[p + 'SL'][t] += sl;
      if (fx) { g.fB[t] += num(raw.fbv[i]); g.fS[t] += num(raw.fsv[i]); }
      else if (isF) { g.fB[t] += bv; g.fS[t] += sv; }
      nv[t] += bv - sv;
      if (t >= wS) { w[0] += bv; w[1] += sv; w[2] += bl; w[3] += sl; }
    });
    let cum = 0, mn = 0, mnI = wS - 1, mx = 0, mxI = wS - 1, n10 = 0;
    for (let t = wS; t < n; t++) {
      cum += nv[t];
      if (cum < mn) { mn = cum; mnI = t; }
      if (cum > mx) { mx = cum; mxI = t; }
      if (t >= n - 10) n10 += nv[t];
    }
    rows.push({ cd, nv, w, n10, trough: n - 1 - mnI, peak: n - 1 - mxI, gross: w[0] + w[1] });
  });
  if (!rows.length) return null;

  // associate broker = penjamin emisi (nama di holder.profile.underwriters → kode)
  let asc = null;
  const uw = H && H.profile && Array.isArray(H.profile.underwriters) ? H.profile.underwriters : [];
  for (const name of uw) {
    const hit = BC.get ? BC.get(name) : null;
    const cd = hit ? hit.code : String(name).toUpperCase();
    if (rows.some(x => x.cd === cd)) { asc = cd; break; }
  }
  rows.sort((a, b) => b.gross - a.gross);
  let top = rows.slice(0, TOP_BK);
  if (asc && !top.some(x => x.cd === asc)) top = top.slice(0, TOP_BK - 1).concat(rows.filter(x => x.cd === asc));
  // pastikan net beli & jual terbesar 6 bulan ikut (untuk Accumulation)
  const byNet = rows.slice().sort((a, b) => (b.w[0] - b.w[1]) - (a.w[0] - a.w[1]));
  byNet.slice(0, 5).concat(byNet.slice(-5)).forEach(x => { if (!top.includes(x)) top.push(x); });

  const nvFrom = Math.max(0, n - NV_DAYS);
  const ascRow = asc ? B.brokers.find(x => String(x.code || '').toUpperCase() === asc) : null;
  const ascBv = zero();
  if (ascRow) allDays.forEach((d, i) => { const t = dIdx[d]; if (t !== undefined) ascBv[t] += num(ascRow.bv && ascRow.bv[i]); });

  const out = {
    g: {}, bk: top.map(x => [x.cd, x.nv.slice(nvFrom).map(r), [r(x.w[0]), r(x.w[1]), rl(x.w[2]), rl(x.w[3])], r(x.n10), x.trough, x.peak]),
    asc, ascBv: asc ? ascBv.slice(nvFrom).map(r) : [],
    ins: [], h5: [], ff: null, so: null, days: uniq
  };
  Object.keys(g).forEach(k => { out.g[k] = g[k].map(/L$/.test(k) ? rl : r); });

  const first = uniq[0];
  (I && Array.isArray(I.trades) ? I.trades : []).forEach(t => {
    const d = isoOf(t.date); if (!d || d < first) return;
    const act = String(t.action || '').toUpperCase().indexOf('S') === 0 || /JUAL/i.test(t.action) ? 'SELL' : 'BUY';
    out.ins.push([d, String(t.name || '-').trim(), String(t.role || '-').trim(), act, Math.abs(num(t.shares)), num(t.price)]);
  });
  if (H) {
    const months = [...new Set((H.movement || []).map(x => String(x.month || '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort().slice(-4);
    (H.movement || []).forEach(x => {
      const m = String(x.month || '').slice(0, 7), pct = num(x.pct);
      if (months.includes(m) && pct >= 4.5) out.h5.push([m, String(x.name || '-').trim(), +pct.toFixed(3)]);
    });
    const ff = H.profile && H.profile.freeFloat != null ? num(H.profile.freeFloat) : null;
    out.ff = ff == null ? null : ff > 1 ? ff / 100 : ff;
    out.so = num(H.sharesOut) || null;
  }
  if (!out.so && I && num(I.sharesOut)) out.so = num(I.sharesOut);
  return out;
}

// Nama orang: sama dengan normName() di public/smartmoney.js.
function normName(n) { return String(n || '').toUpperCase().replace(/^(BAPAK|BPK\.?|IBU|SDR\.?|SDRI\.?)\s+/, '').replace(/\s+/g, ' ').trim(); }

// brokers/{BROKER}.json + people.json (lihat format di atas).
function buildIndexes(dir, codes) {
  const bdir = path.join(dir, 'broker'), daySet = {}, raw = {};
  codes.forEach(code => {
    const B = readJson(path.join(bdir, code + '.json'));
    if (!B || !Array.isArray(B.days) || !Array.isArray(B.brokers)) return;
    raw[code] = B; B.days.forEach(d => { const x = isoOf(d); if (x) daySet[x] = 1; });
  });
  const days = Object.keys(daySet).sort().slice(-BK_DAYS), gi = {};
  days.forEach((d, i) => { gi[d] = i; });
  const brokers = {};
  Object.keys(raw).forEach(code => {
    const B = raw[code], dd = B.days.map(isoOf);
    B.brokers.forEach(b => {
      const cd = String(b.code || '').toUpperCase(); if (!/^[A-Z0-9]{2}$/.test(cd)) return;
      const rows = [];
      dd.forEach((d, i) => {
        const t = gi[d]; if (t === undefined) return;
        const bv = num(b.bv && b.bv[i]), sv = num(b.sv && b.sv[i]), bl = num(b.bl && b.bl[i]), sl = num(b.sl && b.sl[i]);
        if (bv || sv || bl || sl) rows.push([t, +(bv / U).toFixed(2), +(sv / U).toFixed(2), Math.round(bl), Math.round(sl)]);
      });
      if (rows.length) (brokers[cd] = brokers[cd] || {})[code] = rows;
    });
  });
  const people = {};
  const P = (name) => { const k = normName(name); if (!k || k === '-') return null; return people[k] = people[k] || { n: String(name).trim(), t: [], h: [], b: [], o: [] }; };
  codes.forEach(code => {
    const I = readJson(path.join(dir, 'insider', code + '.json'));
    ((I && I.trades) || []).forEach(r => {
      const p = P(r.name); if (!p) return;
      const d = isoOf(r.date); if (!d) return;
      const act = /^S|JUAL/i.test(String(r.action || '')) ? 'S' : 'B';
      const sh = Math.abs(num(r.shares)), pr = num(r.price), v = num(r.value) || sh * pr;
      p.t.push([code, d, String(r.role || '').trim() || '-', act, sh, pr, Math.round(v)]);
    });
    const H = readJson(path.join(dir, 'holder', code + '.json'));
    if (!H) return;
    const months = [...new Set((H.movement || []).map(x => String(x.month || '').slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m)))].sort();
    const last = months[months.length - 1];
    (H.movement || []).forEach(x => {
      const m = String(x.month || '').slice(0, 7); if (m !== last) return;
      const p = P(x.name); if (p) p.h.push([code, m, +num(x.pct).toFixed(3), String(x.type || '-')]);
    });
    (H.board || []).forEach(x => { const p = P(x.name); if (p) p.b.push([code, String(x.role || x.board || '').trim()]); });
    (H.ubo || []).forEach(x => { const p = P(x.name); if (p) p.o.push([code, String(x.via || '').trim(), +num(x.pct).toFixed(3)]); });
  });
  return { days, brokers, people };
}

function main() {
  const dir = arg('dir');
  if (!dir || dir === true) { console.error('Pakai: node scripts/build-smartmoney-screener.js --dir <folder smartmoney> [--out file] [--upload]'); process.exit(1); }
  const outFile = arg('out', path.join(dir, 'screener', 'summary.json'));
  const BC = brokerCodes();
  const bdir = path.join(dir, 'broker');
  const codes = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter(f => /^[A-Z0-9]{2,6}\.json$/i.test(f)).map(f => f.slice(0, -5).toUpperCase()).sort() : [];
  if (!codes.length) { console.error('Tidak ada file di ' + bdir); process.exit(1); }

  const stocks = {}, daySet = {};
  let skipped = 0;
  codes.forEach(code => {
    const s = buildStock(code, readJson(path.join(bdir, code + '.json')), readJson(path.join(dir, 'insider', code + '.json')), readJson(path.join(dir, 'holder', code + '.json')), BC);
    if (!s) { skipped++; return; }
    s.days.forEach(d => { daySet[d] = 1; });
    stocks[code] = s;
  });
  // sumbu tanggal bersama: per saham disimpan ulang sejajar `days` global (hari kosong = 0)
  const days = Object.keys(daySet).sort().slice(-DAYS), gi = {};
  days.forEach((d, i) => { gi[d] = i; });
  Object.keys(stocks).forEach(code => {
    const s = stocks[code], loc = s.days, n = days.length;
    const remap = (arr, offLocal) => { const o = new Array(n).fill(0); arr.forEach((v, j) => { const t = gi[loc[j + offLocal]]; if (t !== undefined) o[t] = v; }); return o; };
    Object.keys(s.g).forEach(k => { s.g[k] = remap(s.g[k], 0); });
    const nvOff = loc.length - (s.bk[0] ? s.bk[0][1].length : 0);
    const cut = Math.max(0, n - NV_DAYS);
    s.bk.forEach(b => { b[1] = remap(b[1], nvOff).slice(cut); });
    if (s.ascBv.length) s.ascBv = remap(s.ascBv, nvOff).slice(cut);
    delete s.days;
  });
  const out = { v: 1, updated: new Date().toISOString(), u: U, days, stocks };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(out));
  const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(`OK ${Object.keys(stocks).length} saham (${skipped} dilewati), ${days.length} hari → ${outFile} (${kb} KB)`);

  // Indeks popup broker & nama
  const ix = buildIndexes(dir, codes), now = new Date().toISOString(), files = [];
  const bkDir = path.join(dir, 'brokers');
  fs.mkdirSync(bkDir, { recursive: true });
  Object.keys(ix.brokers).sort().forEach(cd => {
    const f = path.join(bkDir, cd + '.json');
    fs.writeFileSync(f, JSON.stringify({ v: 1, updated: now, u: U, days: ix.days, s: ix.brokers[cd] }));
    files.push(['brokers/' + cd + '.json', f]);
  });
  const pf = path.join(dir, 'people.json');
  fs.writeFileSync(pf, JSON.stringify({ v: 1, updated: now, p: ix.people }));
  files.push(['people.json', pf]);
  console.log(`OK indeks: ${Object.keys(ix.brokers).length} broker, ${Object.keys(ix.people).length} nama → ${bkDir}, ${pf}`);

  if (arg('upload')) {
    console.log('Mengunggah ke R2 smartmoney/screener/summary.json …');
    execFileSync('npx', ['wrangler', 'r2', 'object', 'put', 'smartmoney/screener/summary.json', '--file', outFile, '--content-type', 'application/json', '--remote'], { stdio: 'inherit' });
    files.forEach(([key, f], i) => {
      console.log(`(${i + 1}/${files.length}) smartmoney/${key}`);
      execFileSync('npx', ['wrangler', 'r2', 'object', 'put', 'smartmoney/' + key, '--file', f, '--content-type', 'application/json', '--remote'], { stdio: 'inherit' });
    });
  }
}

if (require.main === module) main();
module.exports = { buildStock, buildIndexes };
