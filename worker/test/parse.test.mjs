// Test ringan untuk parser Live Sheet di Worker.
// Jalankan: node worker/test/parse.test.mjs
import { parseLive, parseConsensus, computeConsensusSummary, parseHistory } from '../src/index.js';

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

// ── Test 5: parseConsensus — grouping, decode B/N/S, target, summary ──
console.log('Test 5: parseConsensus + computeConsensusSummary');
{
  const csv = [
    'Symbol,Date,Firm Name,Rec,T.Price',
    'AADI,2026-06-10,Ciptadana,B,14000',
    'AADI,2026-06-04,Maybank,BUY,12500',
    'AADI,2026-05-25,Samuel,N,13000',
    'BBCA,2026-06-09,UBS,S,9000',
    'X,2026-06-01,Pembatas,B,100',          // marker non-ticker → harus di-skip
    'Sektor Bank,2026-06-01,Banner,B,0',    // ada spasi → skip
  ].join('\n');
  const slim = parseConsensus(csv, { AADI: 8000, BBCA: 10000 });
  eq('AADI ada', !!slim.AADI, true);
  eq('AADI 3 rekomendasi', slim.AADI.length, 3);
  eq('marker "X" di-skip', !!slim.X, false);
  eq('"Sektor Bank" di-skip', !!slim['SEKTOR BANK'], false);
  eq('AADI rec terbaru = 2026-06-10 (sort desc)', slim.AADI[0].date, '2026-06-10');
  eq('decode B → BUY', slim.AADI[0].suggestion, 'BUY');
  eq('decode N → NEUTRAL', slim.AADI[2].suggestion, 'NEUTRAL');
  eq('decode S → SELL', slim.BBCA[0].suggestion, 'SELL');
  approx('AADI target_price baris terbaru', slim.AADI[0].target_price, 14000);
  // pct_d dihitung dari latestPrices kalau kolom pct tak ada: (14000-8000)/8000*100
  approx('AADI pct_d dari latestPrices', slim.AADI[0].pct_d, 75, 1e-6);

  const sum = computeConsensusSummary(slim);
  eq('AADI total', sum.AADI.total, 3);
  eq('AADI buy', sum.AADI.buy, 2);
  eq('AADI neutral', sum.AADI.neutral, 1);
  eq('AADI sell', sum.AADI.sell, 0);
  approx('AADI high', sum.AADI.high, 14000);
  approx('AADI low', sum.AADI.low, 12500);
  approx('AADI target (rata2 13000..14000..12500=13166.67→13167)', sum.AADI.target, 13167);
}

// ── Test 6: parseHistory — header detect, date normalize, ticker cols ──
console.log('Test 6: parseHistory');
{
  const csv = [
    'Date,Label,TLKM,BBCA,IHSG',
    '2026-04-01,Apr-26,3000,9000,7000',
    '2026-05-01,May-26,3100,9200,7100',
    '2026-06-01,Jun-26,3090,9250,7150',
  ].join('\n');
  const ph = parseHistory(csv);
  eq('3 baris history', ph.length, 3);
  eq('baris terakhir date dinormalisasi', ph[2].date, '2026-06-01');
  approx('TLKM bulan terakhir', ph[2].TLKM, 3090);
  approx('BBCA bulan pertama', ph[0].BBCA, 9000);
  eq('urut tanggal naik (Apr dulu)', ph[0].date, '2026-04-01');
}

console.log(`\nHasil: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
