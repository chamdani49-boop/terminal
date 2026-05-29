// Test ringan untuk parser Live Sheet di Worker.
// Jalankan: node worker/test/parse.test.mjs
import { parseLive } from '../src/index.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, '\n     got :', JSON.stringify(got), '\n     want:', JSON.stringify(want)); }
}
function approx(label, got, want, eps = 1e-9) {
  const ok = Number.isFinite(got) && Math.abs(got - want) <= eps;
  if (ok) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, '\n     got :', got, '\n     want:', want); }
}

// ── Test 1: headerful layout (Ticker | Harga Live | % Live | | Max | when max | LOW | when low) ──
console.log('Test 1: headerful, % Live (header ber-% → mode percent)');
{
  const csv = [
    'Ticker,Harga Live,% Live,,Max 1 Tahun,when max,LOW 1 Tahun,when low',
    'TLKM,3090,5.46,,3990,2026-01-27,2560,2026-01-26',
    'BBCA,"9,250",-1.2,,10800,2026-02-10,8500,2025-09-01',
    'IHSG,7100,0.33,,7400,2026-03-01,6500,2025-06-01',
  ].join('\n');
  const live = parseLive(csv);
  approx('TLKM price', live.TLKM.price, 3090);
  approx('TLKM change_pct (5.46 → 0.0546)', live.TLKM.change_pct, 0.0546);
  approx('TLKM max_price', live.TLKM.max_price, 3990);
  eq('TLKM max_date', live.TLKM.max_date, '2026-01-27');
  approx('TLKM low_price', live.TLKM.low_price, 2560);
  eq('TLKM low_date', live.TLKM.low_date, '2026-01-26');
  approx('BBCA price (thousand sep)', live.BBCA.price, 9250);
  approx('BBCA change_pct (-1.2 → -0.012)', live.BBCA.change_pct, -0.012);
  approx('IHSG price', live.IHSG.price, 7100);
}

// ── Test 2: % dengan tanda persen eksplisit ──
console.log('Test 2: nilai dengan tanda %');
{
  const csv = [
    'Ticker,Harga Live,% Live',
    'ANTM,1500,2.5%',
    'GOTO,60,-3.35%',
  ].join('\n');
  const live = parseLive(csv);
  approx('ANTM change_pct (2.5% → 0.025)', live.ANTM.change_pct, 0.025);
  approx('GOTO change_pct (-3.35% → -0.0335)', live.GOTO.change_pct, -0.0335);
}

// ── Test 3: headerless (langsung ticker,harga,pct) — mode percent ──
console.log('Test 3: headerless');
{
  const csv = [
    'AALI,6000,0.77',
    'ADRO,2800,-0.5',
  ].join('\n');
  const live = parseLive(csv);
  approx('AALI price', live.AALI.price, 6000);
  approx('AALI change_pct (0.77 → 0.0077, mode percent)', live.AALI.change_pct, 0.0077);
  approx('ADRO change_pct (-0.5 → -0.005)', live.ADRO.change_pct, -0.005);
}

// ── Test 4: baris sampah / non-ticker di-skip ──
console.log('Test 4: filter baris sampah');
{
  const csv = [
    'Ticker,Harga Live,% Live',
    'TLKM,3090,5.46',
    'TOTAL,123456,0',          // bukan ticker valid? "TOTAL" 5 huruf → match TICKER_RX! tapi harga ok
    ',,,',                     // kosong
    'Sektor Perbankan,0,0',    // ada spasi → skip
    '12345,100,1',             // angka → skip
  ].join('\n');
  const live = parseLive(csv);
  eq('TLKM ada', !!live.TLKM, true);
  eq('"Sektor Perbankan" di-skip', !!live['SEKTOR PERBANKAN'], false);
  eq('numeric ticker di-skip', !!live['12345'], false);
}

console.log(`\nHasil: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
