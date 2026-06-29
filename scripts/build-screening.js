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
 *   eps, fcf_per_share, dps, eps_growth_5y,
 *   per_annual, pbv_annual, max_per_5y (PER historis tertinggi 5 th utk Diskon Valuasi)
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

    stocks[code] = {
      name: info.name || (v.valuation && v.valuation.name) || code,
      sector: info.sector || (v.valuation && v.valuation.sector) || null,
      last_year: ly ? parseInt(ly, 10) : null,
      eps: num(a.eps),
      fcf_per_share: num(a.fcf_per_share),
      dps: num(a.dps),
      eps_growth_5y: num(a.eps_growth_5y),
      per_annual: num(a.per),
      pbv_annual: num(a.pbv),
      max_per_5y: num(maxPerLastN(annual, 5)),
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
