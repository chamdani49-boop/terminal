#!/usr/bin/env node
/**
 * build-screening.js — Agregator data Screening
 * ──────────────────────────────────────────────────────────────────────────
 * Menghasilkan file ramping `public/screening.json` berisi field FUNDAMENTAL
 * TERBARU (annual tahun terakhir) untuk saham yang TERCOVER konsensus analis.
 *
 * Kenapa precompute?
 *   Data fundamental tersebar di ratusan file `public/valuation/<CODE>.json`.
 *   Kalau frontend fetch satu per satu (±109 request) → berat & lambat. Script
 *   ini meringkas hanya field yang dipakai tabel Screening jadi SATU file kecil,
 *   sehingga frontend cukup fetch 1x lalu gabung dengan data.json (stats /
 *   consensus / live) yang sudah ter-load.
 *
 * Universe = SEMUA saham yang punya file valuasi di public/valuation/
 *            (kecuali file non-ticker: index.json, dividends.json).
 *            Saham tanpa data fundamental (annual) dilewati.
 *
 * Field per saham (fundamental "terbaru" = annual tahun terakhir):
 *   name, sector, last_year,
 *   eps, fcf_per_share, dps, market_cap, eps_growth_5y,
 *   per_annual, pbv_annual, max_per_5y (PER historis tertinggi 5 th utk Diskon Valuasi)
 *
 * Field untuk preset screener (Fisher PSR, Buffettology, Peter Lynch,
 * Graham Net-Net, DCF, DDM, Graham Number):
 *   sps, sps_growth_5y, bvps, roe (%), roe_avg_5y (%), dpr,
 *   de (utang/ekuitas), npm (net margin), debt_ni (utang/laba bersih),
 *   net_cash_ps ((kas − utang)/saham, Rp per lembar),
 *   eps_pos_5y (EPS positif 5 th berturut), is_financial,
 *   dcf_fair / ddm_fair (nilai wajar per saham dari valuation.dcf / .ddm)
 *
 * Field turunan (Diskon Harga, FrLows, Div Yield, UpDw, ConsVal, PER kini,
 * P/FCF kini, Diskon Valuasi) sengaja DIHITUNG di frontend dari harga LIVE +
 * data.json, supaya selalu mengikuti harga terkini tanpa rebuild.
 *
 * Jalankan:  node scripts/build-screening.js
 * Output:    public/screening.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'public', 'data.json');
const VAL_DIR = path.join(ROOT, 'public', 'valuation');
const OUT_PATH = path.join(ROOT, 'public', 'screening.json');

const num = (v) => (Number.isFinite(v) ? v : null);
// Bulatkan ke d desimal (hemat ukuran file); null bila bukan angka.
const rnd = (v, d) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

function latestAnnualYear(annual) {
  if (!annual) return null;
  const years = Object.keys(annual)
    .map((y) => parseInt(y, 10))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);
  return years.length ? String(years[years.length - 1]) : null;
}

/** PER historis tertinggi dalam N tahun terakhir (hanya nilai positif valid). */
function maxPerLastN(annual, n) {
  if (!annual) return null;
  const years = Object.keys(annual)
    .map((y) => parseInt(y, 10))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b)
    .slice(-n);
  let mx = null;
  for (const y of years) {
    const per = annual[String(y)] && annual[String(y)].per;
    if (Number.isFinite(per) && per > 0) mx = mx == null ? per : Math.max(mx, per);
  }
  return mx;
}

/** a ÷ b; bila posDen, penyebut harus > 0. */
function div(a, b, posDen) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (posDen ? b <= 0 : b === 0) return null;
  return a / b;
}

// a dan b sama-sama positif dan selisihnya maksimal 2× → dianggap konsisten.
const near = (a, b) => a > 0 && b > 0 && a / b >= 0.5 && a / b <= 2;

/**
 * Data annual konsisten: ada harga & market cap, dan rasio sumber (PER, PBV,
 * market cap) cocok dengan harga ÷ per-saham. Menyaring satuan saham/harga
 * yang salah di file sumber.
 */
function dataConsistent(a) {
  if (!(a.price > 0) || !(a.market_cap > 0)) return false;
  if (a.eps > 0 && a.per > 0 && !near(a.price / a.eps, a.per)) return false;
  if (a.bvps > 0 && a.pbv > 0 && !near(a.price / a.bvps, a.pbv)) return false;
  if (a.shares > 0 && !near(a.shares * a.price, a.market_cap)) return false;
  return true;
}

/**
 * PSR sumber cocok dengan harga ÷ SPS. Gagal biasanya karena emiten
 * melapor dalam USD (pendapatan USD, harga Rupiah) → angka penjualan,
 * kas & utang tidak bisa dibandingkan langsung dengan harga.
 */
function psrConsistent(a) {
  return a.price > 0 && a.sps > 0 && a.psr > 0 && near(a.price / a.sps, a.psr);
}

/** Kuartal terbaru yang terisi (dideteksi dari ekuitas, sama dgn vlFilledQuarters). */
function latestQuarter(v) {
  const q = v.quarters || {};
  let last = null;
  for (const k of ['Q1', 'Q2', 'Q3', 'Q4']) {
    const o = q[k];
    if (o && (Number.isFinite(o.total_equity) || Number.isFinite(o.bvps))) last = o;
  }
  return last;
}

/**
 * Basis TTM terbaru untuk preset screener. Laba/penjualan/ROE/growth memakai
 * input TTM model Valuasi (valuation.five_year.inputs — sama dgn basis TTM di
 * halaman Valuasi); neraca (kas, utang, ekuitas) dari kuartal terbaru.
 * null bila emiten tidak punya data TTM.
 */
function ttmBlock(v, a) {
  const inp = (v.valuation && v.valuation.five_year && v.valuation.five_year.inputs) || null;
  const label = (v.ttm_is && v.ttm_is.q_latest) || null;      // mis. "Q2 2026"
  if (!inp || !label || !Number.isFinite(inp.eps)) return null;
  const year = parseInt(String(label).split(' ')[1], 10);
  const qb = latestQuarter(v) || {};
  const shares = Number.isFinite(qb.shares) && qb.shares > 0 ? qb.shares : a.shares;
  const debt = Number.isFinite(qb.total_debt) ? qb.total_debt : null;
  const ni = Number.isFinite(inp.eps) && shares > 0 ? inp.eps * shares : null;
  // Konsistensi neraca kuartal: harga kuartal ÷ BVPS ≈ PBV sumber.
  const qOk = !(qb.bvps > 0 && qb.pbv > 0 && qb.price > 0) || near(qb.price / qb.bvps, qb.pbv);
  return {
    label,
    year: Number.isFinite(year) ? year : null,
    eps: rnd(inp.eps, 2),
    sps: rnd(inp.sps, 2),
    bvps: rnd(inp.bvps, 2),
    roe: rnd(Number.isFinite(inp.roe_annual) ? inp.roe_annual * 100 : null, 2),   // persen
    eps_growth_5y: rnd(inp.eps_growth_5y, 4),
    sps_growth_5y: rnd(inp.sps_growth_5y, 4),
    dpr: rnd(inp.dpr, 4),
    npm: rnd(div(inp.eps, inp.sps, true), 4),
    de: rnd(div(debt, qb.total_equity, true), 3),
    debt_ni: rnd(div(debt, ni, true), 2),
    net_cash_ps: (Number.isFinite(qb.cash) && Number.isFinite(debt)) ? rnd(div(qb.cash - debt, shares, true), 0) : null,
    data_ok: qOk,
  };
}

function lastNYears(annual, n) {
  return Object.keys(annual || {})
    .map((y) => parseInt(y, 10))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b)
    .slice(-n)
    .map(String);
}

/** Rata-rata field annual N tahun terakhir; null bila datanya < N tahun. */
function avgLastN(annual, field, n) {
  const vals = lastNYears(annual, n)
    .map((y) => annual[y] && annual[y][field])
    .filter((x) => Number.isFinite(x));
  if (vals.length < n) return null;
  return vals.reduce((s, x) => s + x, 0) / vals.length;
}

/** true bila field annual positif di SETIAP N tahun terakhir (data harus lengkap). */
function allPositiveLastN(annual, field, n) {
  const ys = lastNYears(annual, n);
  if (ys.length < n) return false;
  return ys.every((y) => annual[y] && Number.isFinite(annual[y][field]) && annual[y][field] > 0);
}

/** Nilai wajar per saham dari blok valuation.dcf / valuation.ddm. */
function fairValue(block) {
  if (!block || !block.applicable) return null;
  const f = block.fair_value_per_share;
  return Number.isFinite(f) && f > 0 ? f : null;
}

function main() {
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const stockInfo = data.stock_info || {};

  // Universe = SEMUA saham yang punya file valuasi (kecuali file non-ticker).
  const EXCLUDE = new Set(['index.json', 'dividends.json', 'screening.json', 'overrides.json']);
  const files = fs.readdirSync(VAL_DIR)
    .filter((f) => f.endsWith('.json') && !EXCLUDE.has(f));

  const stocks = {};
  let ok = 0;
  let skipped = 0;

  for (const f of files) {
    const code = f.replace(/\.json$/, '');
    let v;
    try {
      v = JSON.parse(fs.readFileSync(path.join(VAL_DIR, f), 'utf8'));
    } catch (e) {
      skipped++;
      continue;
    }

    const annual = v.annual || {};
    const ly = latestAnnualYear(annual);
    if (!ly && !v.annualized) { skipped++; continue; }   // tanpa data fundamental → lewati
    const a = (ly && annual[ly]) || v.annualized || {};
    const info = stockInfo[code] || {};
    const val = v.valuation || {};

    stocks[code] = {
      name: info.name || (v.valuation && v.valuation.name) || code,
      sector: info.sector || (v.valuation && v.valuation.sector) || null,
      last_year: ly ? parseInt(ly, 10) : null,
      eps: num(a.eps),
      fcf_per_share: num(a.fcf_per_share),
      dps: num(a.dps),
      price_annual: num(a.price),
      market_cap: num(a.market_cap),
      eps_growth_5y: num(a.eps_growth_5y),
      per_annual: num(a.per),
      pbv_annual: num(a.pbv),
      max_per_5y: num(maxPerLastN(annual, 5)),
      // ── field untuk preset screener (Fisher / Buffettology / Lynch /
      //    Graham Net-Net / DCF / DDM / Graham Number) ──
      sps: rnd(a.sps, 2),
      sps_growth_5y: rnd(a.sps_growth_5y, 4),
      bvps: rnd(a.bvps, 2),
      roe: rnd(a.roe, 2),                         // persen (20.9 = 20,9%)
      roe_avg_5y: rnd(avgLastN(annual, 'roe', 5), 2),
      dpr: num(a.dpr),                         // fraksi
      // Rasio neraca (dihitung di sini supaya file tetap ramping):
      //   de          = total utang ÷ ekuitas
      //   npm         = laba bersih ÷ pendapatan (net margin)
      //   debt_ni     = total utang ÷ laba bersih (tahun lunas utang dari laba)
      //   net_cash_ps = (kas − total utang) ÷ jumlah saham, Rp/lembar
      de: rnd(div(a.total_debt, a.total_equity, true), 3),
      npm: rnd(div(a.net_income, a.total_revenue, true), 4),
      debt_ni: rnd(div(a.total_debt, a.net_income, true), 2),
      net_cash_ps: (Number.isFinite(a.cash) && Number.isFinite(a.total_debt))
        ? rnd(div(a.cash - a.total_debt, a.shares, true), 0) : null,
      eps_pos_5y: allPositiveLastN(annual, 'eps', 5),
      is_financial: !!(val.is_financial),
      dcf_fair: rnd(fairValue(val.dcf), 0),
      dcf_wacc: rnd(val.dcf && val.dcf.applicable ? val.dcf.wacc : null, 4),
      ddm_fair: rnd(fairValue(val.ddm), 0),
      // Cek kualitas data (dipakai preset screener supaya data anomali tidak lolos)
      data_ok: dataConsistent(a),
      psr_ok: psrConsistent(a),
      ttm: ttmBlock(v, a),
    };
    ok++;
  }

  const out = {
    generated_at: new Date().toISOString(),
    count: ok,
    note:
      'Universe = semua saham dengan data valuasi. Field fundamental = annual ' +
      'tahun terakhir. Kolom turunan (diskon harga, diskon valuasi, div yield, ' +
      'UpDw, ConsVal, PER kini, P/FCF kini) dihitung di frontend.',
    stocks,
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(out));
  console.log(`✓ screening.json ditulis: ${ok} saham (dari ${files.length} file valuasi, ${skipped} dilewati)`);
}

main();
