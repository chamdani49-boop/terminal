/**
 * Local sanity tests for build-data.js parser. Tidak dijalankan di CI;
 * panggil manual: `node scripts/test-parser.js`.
 */
const { parseHistory, parseConsensus, decodeSuggestion, cleanTickerName, toNum, parseDate } = require('./build-data.js');

let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label); }
}
function expect(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗', label, '\n    expected:', b, '\n    actual:  ', a); }
}

// ─── parseDate ───
console.log('\n[parseDate]');
assert(parseDate('5/31/2016') instanceof Date, 'mm/dd/yyyy');
assert(parseDate('31/5/2016') instanceof Date, 'dd/mm/yyyy');
assert(parseDate('2016-05-31') instanceof Date, 'iso');
assert(parseDate('May-26') instanceof Date, 'Mmm-YY');
assert(parseDate('Mei-26') instanceof Date, 'Indonesian month');
assert(parseDate('2026-02') instanceof Date, 'yyyy-mm');
assert(parseDate('') === null, 'empty → null');
assert(parseDate('-') === null, 'dash → null');
assert(parseDate('Foo') === null, 'no digit → null');

// ─── toNum ───
console.log('\n[toNum]');
expect(toNum('4,797'),     4797,      '"4,797" thousand-sep (US)');
expect(toNum('4.797'),     4797,      '"4.797" thousand-sep (Indo) — IDR konteks');
expect(toNum('1.234.567'), 1234567,   '"1.234.567" indo style');
expect(toNum('1,234.56'),  1234.56,   '"1,234.56" banker style');
expect(toNum('Rp 4.500'),  4500,      'with currency prefix');
expect(toNum('-'),         null,      'dash → null');
expect(toNum('N/A'),       null,      'N/A → null');
expect(toNum(''),          null,      'empty → null');

// ─── cleanTickerName ───
console.log('\n[cleanTickerName]');
expect(cleanTickerName('IDX:BBCA'),     'BBCA',     'strip IDX:');
expect(cleanTickerName('JK:TLKM'),      'TLKM',     'strip JK:');
expect(cleanTickerName('AALI Close'),   'AALI',     'strip Close suffix');
expect(cleanTickerName('  ihsg  '),     'IHSG',     'trim+upper');
expect(cleanTickerName('IDX:COMPOSITE'),'IHSG',     'COMPOSITE → IHSG (alias)');
expect(cleanTickerName('JKSE'),         'IHSG',     'JKSE → IHSG (alias)');
expect(cleanTickerName('JCI'),          'IHSG',     'JCI → IHSG (alias)');

// ─── decodeSuggestion ───
console.log('\n[decodeSuggestion]');
expect(decodeSuggestion('B'),           'BUY',      'B → BUY');
expect(decodeSuggestion('S'),           'SELL',     'S → SELL');
expect(decodeSuggestion('N'),           'NEUTRAL',  'N → NEUTRAL');
expect(decodeSuggestion('Buy'),         'BUY',      'Buy → BUY');
expect(decodeSuggestion('OVERWEIGHT'),  'BUY',      'OVERWEIGHT → BUY');
expect(decodeSuggestion('Hold'),        'NEUTRAL',  'Hold → NEUTRAL');
expect(decodeSuggestion('Reduce'),      'SELL',     'Reduce → SELL');

// ─── parseHistory: layout Bulanz tradisional ───
console.log('\n[parseHistory] Bulanz layout (3-row preamble)');
const bulanzCsv = [
  'IDX:Bulanz,,IDX:COMPOSITE,IDX:AALI,IDX:BBCA',
  ',,COMPOSITE,1,2',
  'Bulanz,Bulanz,IHSG,AALI,BBCA',
  '5/31/2024,May-24,"7,000","13,000","9,500"',
  '6/30/2024,Jun-24,"7,100","13,200","9,800"',
  '7/31/2024,Jul-24,"7,250","13,500","10,000"',
].join('\n');
const debug1 = {};
const h1 = parseHistory(bulanzCsv, debug1);
expect(h1.length, 3, '3 baris data');
expect(h1[0].IHSG, 7000, 'IHSG row 0');
expect(h1[0].BBCA, 9500, 'BBCA row 0');
expect(h1[2].AALI, 13500, 'AALI row 2');
expect(h1[0].date, '2024-05-01', 'date normalized');

// ─── parseHistory: layout tanpa label "IHSG" (pakai COMPOSITE) ───
console.log('\n[parseHistory] header pakai COMPOSITE → di-alias jadi IHSG');
const compositeCsv = [
  'Date,COMPOSITE,AALI,BBCA',
  '2024-05-31,7000,13000,9500',
  '2024-06-30,7100,13200,9800',
].join('\n');
const debug2 = {};
const h2 = parseHistory(compositeCsv, debug2);
expect(h2.length, 2, '2 baris (composite layout)');
expect(h2[0].IHSG, 7000, 'COMPOSITE → IHSG (alias)');
expect(h2[0].BBCA, 9500, 'BBCA col');

// ─── parseHistory: prefix IDX: di header ticker ───
console.log('\n[parseHistory] IDX: prefix di header — JKSE → IHSG');
const prefCsv = [
  'tanggal,IDX:JKSE,IDX:BBCA,IDX:TLKM',
  '5/31/2024,7000,9500,3500',
  '6/30/2024,7100,9800,3600',
].join('\n');
const debug3 = {};
const h3 = parseHistory(prefCsv, debug3);
expect(h3.length, 2, '2 baris (idx-prefix layout)');
expect(h3[0].IHSG, 7000, 'JKSE → IHSG (alias)');
expect(h3[0].BBCA, 9500, 'BBCA setelah strip IDX:');

// ─── parseConsensus: layout Bulanz (B/N/S codes) ───
console.log('\n[parseConsensus] B/N/S codes + T.PRICE');
const consCsv = [
  'Pesan di dashboard,,,,,,,,',
  '1,2,,3,header,,,,',
  'Symbol,By,,Lynk.id/economstock,,,,,',
  'Symbol,#,DATE,FIRM NAME,[],T.PRICE,DISC,%D,T.PRICE',
  'BBCA,1,2026-02-18,Mandiri Sekuritas,B,"11,000","11,000",0,"11,000"',
  'BBCA,2,2026-02-10,UBS,N,"10,500","10,500",0,"10,500"',
  'TLKM,1,2026-01-15,DBS Bank,B,"4,500","4,500",10,"4,500"',
  'AALI,1,2026-03-01,RHB Sekuritas,S,"6,000","6,000",-5,"6,000"',
].join('\n');
const debug4 = {};
const c4 = parseConsensus(consCsv, { BBCA: 10000, TLKM: 4000, AALI: 6500 }, debug4);
expect(Object.keys(c4).sort(), ['AALI','BBCA','TLKM'], '3 tickers');
expect(c4.BBCA.length, 2, 'BBCA punya 2 rec');
expect(c4.BBCA[0].suggestion, 'BUY', 'B decoded → BUY');
expect(c4.BBCA[0].target_price, 11000, 'target_price terbaca');
expect(c4.BBCA[0].date, '2026-02-18', 'date diformat');
expect(c4.AALI[0].suggestion, 'SELL', 'S decoded → SELL');
expect(c4.AALI[0].target_price, 6000, 'AALI target');

// ─── parseConsensus: nama kolom alternatif (Indonesia) ───
console.log('\n[parseConsensus] kolom dlm Bahasa Indonesia');
const consIdCsv = [
  'Kode,Tanggal,Sekuritas,Rekomendasi,Target Harga',
  'BBCA,2026-02-18,Mandiri Sekuritas,Buy,11000',
  'TLKM,2026-01-15,DBS Bank,Hold,4500',
].join('\n');
const debug5 = {};
const c5 = parseConsensus(consIdCsv, {}, debug5);
expect(Object.keys(c5).sort(), ['BBCA', 'TLKM'], '2 tickers (id layout)');
expect(c5.BBCA[0].target_price, 11000, 'target dari Target Harga');
expect(c5.BBCA[0].date, '2026-02-18', 'date dari Tanggal');
expect(c5.BBCA[0].firm, 'Mandiri Sekuritas', 'firm dari Sekuritas');
expect(c5.BBCA[0].suggestion, 'BUY', 'Buy → BUY');
expect(c5.TLKM[0].suggestion, 'NEUTRAL', 'Hold → NEUTRAL');

// ─── parseConsensus: tanpa header eksplisit (content-based fallback) ───
console.log('\n[parseConsensus] header T.PRICE missing → content-based detection');
const consWeirdCsv = [
  'TICKER,WHEN,WHO,CALL,VALUE',
  'BBCA,2026-02-18,Mandiri,Buy,11000',
  'BBCA,2026-02-10,UBS,Hold,10500',
  'TLKM,2026-01-15,DBS,Buy,4500',
].join('\n');
const debug6 = {};
const c6 = parseConsensus(consWeirdCsv, {}, debug6);
expect(c6.BBCA[0].target_price, 11000, 'target via content-fallback');
// "WHEN" mungkin kena substring match dari nothing, tapi parseDate-nya works
assert(c6.BBCA[0].date.startsWith('2026'), 'date via content-fallback');

// ─── parseConsensus: header pakai literal "[]" untuk suggestion (Bulanz) ───
console.log('\n[parseConsensus] header [] untuk suggestion column');
const consBracketCsv = [
  ',,,,,,,,',
  '1,2,,3,header,,,,',
  ',By,,Lynk.id,Hitung Nilai Wajar,,,,0',
  'Symbol,#,DATE,FIRM NAME,[],T.PRICE,DISC,%D,T.PRICE',
  'AALI,1,2026-04-27,RHB Sekuritas,N,8250,8250,0,8250',
  'AALI,2,2026-03-05,PT Indo Premier,N,7850,7850,0,7850',
  'ACES,1,2026-05-25,Maybank,B,500,500,0,500',
  'ACES,2,2026-05-22,OCBC,N,380,380,0,380',
  'ACES,3,2026-05-20,BRI Danareksa,B,450,450,0,450',
  'TLKM,1,2026-01-15,DBS,S,4500,4500,0,4500',
].join('\n');
const debug7 = {};
const c7 = parseConsensus(consBracketCsv, {}, debug7);
expect(c7.AALI[0].suggestion, 'NEUTRAL', 'AALI N → NEUTRAL (bukan "1")');
expect(c7.ACES[0].suggestion, 'BUY', 'ACES B → BUY');
expect(c7.ACES[1].suggestion, 'NEUTRAL', 'ACES N → NEUTRAL');
expect(c7.TLKM[0].suggestion, 'SELL', 'TLKM S → SELL');
expect(c7.AALI[0].target_price, 8250, 'AALI target masih benar');
expect(c7.ACES[0].date, '2026-05-25', 'ACES date masih benar');

// ─── Summary ───
console.log(`\n──────────────────────────────────────`);
console.log(`Pass: ${pass}  Fail: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
