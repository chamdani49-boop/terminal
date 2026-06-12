/**
 * Local sanity tests for build-data.js parser. Tidak dijalankan di CI;
 * panggil manual: `node scripts/test-parser.js`.
 */
const { parseHistory, parseConsensus, parseLive, applyLiveOverlay, decodeSuggestion, cleanTickerName, toNum, parseDate, parseTickerSheet, buildMetaFromTabs } = require('./build-data.js');

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

// "sekarang" / "now" / "today" → current month start
const _todayUTC = new Date();
const _curIso = `${_todayUTC.getUTCFullYear()}-${String(_todayUTC.getUTCMonth()+1).padStart(2,'0')}-01`;
const _toIso = (d) => d ? `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-01` : null;
expect(_toIso(parseDate('sekarang')), _curIso, '"sekarang" → bulan ini');
expect(_toIso(parseDate('Sekarang')), _curIso, '"Sekarang" (mixed case) → bulan ini');
expect(_toIso(parseDate('now')), _curIso, '"now" → bulan ini');
expect(_toIso(parseDate('today')), _curIso, '"today" → bulan ini');

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

// ─── parseHistory: layout produksi (Bulanz=dates di kol 0, label di kol 1) +
//                   baris terakhir "sekarang" (live row) ───
console.log('\n[parseHistory] Bulanz=dates + "sekarang" live row (production layout)');
const liveCsv = [
  'IDX:Bulanz,,IDX:COMPOSITE,IDX:TLKM,IDX:BBCA',
  '3/31/2026,Mar-26,7048,3060,7400',
  '4/30/2026,Apr-26,6957,2810,6450',
  'sekarang,May-26,6130,2750,7000',
].join('\n');
const debug8 = {};
const h8 = parseHistory(liveCsv, debug8);
expect(h8.length, 3, '3 baris (Mar/Apr/May-Live)');
expect(h8[h8.length-1].label, 'May-26', 'label baris live = "May-26" (bukan "sekarang")');
expect(h8[h8.length-1].TLKM, 2750, 'TLKM May (live) = 2750');
expect(h8[h8.length-1].IHSG, 6130, 'IHSG May (live) = 6130');
const _expIso = `${_todayUTC.getUTCFullYear()}-${String(_todayUTC.getUTCMonth()+1).padStart(2,'0')}-01`;
expect(h8[h8.length-1].date, _expIso, 'date "sekarang" → awal bulan ini');
expect(h8[1].label, 'Apr-26', 'label baris Apr = "Apr-26" (dari kol 1, bukan "4/30/2026")');

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

// ─── parseLive: layout sederhana (Ticker | Harga Live | % Live) ───
console.log('\n[parseLive] layout sederhana — 3 kolom');
const liveCsv1 = [
  'Ticker,Harga Live,% Live',
  'TLKM,5775,-3.35%',
  'BBCA,9500,1.20%',
  'AALI,7000,-0.50%',
].join('\n');
const debugL1 = {};
const lv1 = parseLive(liveCsv1, debugL1);
expect(Object.keys(lv1).sort(), ['AALI','BBCA','TLKM'], '3 tickers parsed');
expect(lv1.TLKM.price, 5775, 'TLKM price');
expect(Math.round(lv1.TLKM.change_pct * 10000) / 10000, -0.0335, 'TLKM "-3.35%" → -0.0335');
expect(Math.round(lv1.BBCA.change_pct * 10000) / 10000, 0.012, 'BBCA "1.20%" → 0.012');

// ─── parseLive: %change tanpa tanda "%" (heuristic absolute > 1) ───
console.log('\n[parseLive] %change tanpa "%" — heuristic abs>1 = percent');
const liveCsv2 = [
  'Symbol,Price,Change',
  'TLKM,5775,-3.35',
  'BBCA,9500,1.2',
].join('\n');
const lv2 = parseLive(liveCsv2, {});
expect(Math.round(lv2.TLKM.change_pct * 10000) / 10000, -0.0335, '"-3.35" tanpa % → -0.0335 (abs>1 heuristic)');
expect(Math.round(lv2.BBCA.change_pct * 10000) / 10000, 0.012, '"1.2" → 0.012');

// ─── parseLive: %change dalam fraksi (0.0335) — sudah benar, jangan dibagi ulang ───
console.log('\n[parseLive] %change fraksi (sudah dibagi 100 sebelumnya)');
const liveCsv3 = [
  'Ticker,Harga Live,% Live',
  'TLKM,5775,-0.0335',
  'BBCA,9500,0.012',
].join('\n');
const lv3 = parseLive(liveCsv3, {});
expect(Math.round(lv3.TLKM.change_pct * 10000) / 10000, -0.0335, '"-0.0335" → -0.0335 (apa adanya)');
expect(Math.round(lv3.BBCA.change_pct * 10000) / 10000, 0.012, '"0.012" → 0.012');

// ─── parseLive: prefix IDX:, alias COMPOSITE ───
console.log('\n[parseLive] prefix IDX: + alias');
const liveCsv4 = [
  'Ticker,Harga Live,% Live',
  'IDX:TLKM,5775,-3.35%',
  'IDX:COMPOSITE,7100,1.0%',
].join('\n');
const lv4 = parseLive(liveCsv4, {});
expect(lv4.TLKM.price, 5775, 'IDX:TLKM → TLKM');
expect(lv4.IHSG.price, 7100, 'IDX:COMPOSITE → IHSG (alias)');

// ─── parseLive: row tanpa price atau ticker invalid → di-skip ───
console.log('\n[parseLive] skip row invalid');
const liveCsv5 = [
  'Ticker,Harga Live,% Live',
  'TLKM,5775,-3.35%',
  ',7000,1%',                    // empty ticker → skip
  'INVALID TICKER,1000,0%',      // spasi → skip
  'BBCA,,1.0%',                  // empty price → skip
  'BBCA,0,1.0%',                 // zero price → skip
  'AALI,7000,abc',               // invalid pct → price tetap masuk, pct = null
].join('\n');
const lv5 = parseLive(liveCsv5, {});
expect(Object.keys(lv5).sort(), ['AALI','TLKM'], 'cuma TLKM & AALI lolos');
expect(lv5.AALI.price, 7000, 'AALI price masih kepake');
expect(lv5.AALI.change_pct, null, 'AALI pct invalid → null');

// ─── parseLive: sheet kosong / 1 row → empty ───
console.log('\n[parseLive] sheet kosong → empty map');
expect(Object.keys(parseLive('', {})), [], 'csv kosong');
expect(Object.keys(parseLive('Ticker,Harga\n', {})), [], 'cuma header');

// ─── applyLiveOverlay: integrasi dengan price_history ───
// CONTRACT BARU: applyLiveOverlay(price_history, live, debug) — cuma modify
// price_history. Stats di-compute fresh oleh caller (computeStats) SETELAH
// overlay applied. Sebelumnya function ini mutate stats juga, tapi pendekatan
// itu race-prone dan bikin z-score salah karena MoM ditumpuk dengan daily
// %change dari sheet (apple-vs-orange).
console.log('\n[applyLiveOverlay] overwrite price_history[last] (last row = bulan ini)');
const _now = new Date();
const _curIsoMonth = `${_now.getUTCFullYear()}-${String(_now.getUTCMonth()+1).padStart(2,'0')}-01`;
const _lastDayUtc = new Date(Date.UTC(_now.getUTCFullYear(), _now.getUTCMonth()+1, 0)).getUTCDate();
const _curLabelExpected = `${_now.getUTCMonth()+1}/${_lastDayUtc}/${_now.getUTCFullYear()}`;

const ph = [
  { date: '2026-03-01', label: '3/31/2026', TLKM: 3000, BBCA: 9000, IHSG: 7000 },
  { date: '2026-04-01', label: '4/30/2026', TLKM: 2810, BBCA: 9200, IHSG: 6957 },
  { date: _curIsoMonth, label: 'Cur-XX', TLKM: 2750, BBCA: 9300, IHSG: 6130 },
];
const live = {
  TLKM: { price: 5775, change_pct: -0.0335 },
  BBCA: { price: 9500, change_pct: 0.0215 },
};
const debugO = {};
applyLiveOverlay(ph, live, debugO);

expect(ph[ph.length-1].TLKM, 5775, 'price_history[last].TLKM = 5775 (live)');
expect(ph[ph.length-1].BBCA, 9500, 'price_history[last].BBCA = 9500 (live)');
expect(ph[ph.length-1].IHSG, 6130, 'price_history[last].IHSG = unchanged (no live)');
assert(debugO.live_tickers_overlaid === 2, 'debug.live_tickers_overlaid = 2');
expect(debugO.live_appended_current_month, false, 'gak append (last row sudah bulan ini)');

// ─── applyLiveOverlay: APPEND row baru kalau last row bukan bulan ini ───
console.log('\n[applyLiveOverlay] APPEND row baru (last row = April, sekarang bulan berjalan)');
const phNoCurr = [
  { date: '2026-02-01', label: '2/28/2026', TLKM: 3000, IHSG: 7000 },
  { date: '2026-03-01', label: '3/31/2026', TLKM: 2900, IHSG: 6900 },
  { date: '2026-04-01', label: '4/30/2026', TLKM: 2810, IHSG: 6800 },
];
const debugApp = {};
applyLiveOverlay(phNoCurr, { TLKM: { price: 5775, change_pct: -0.0335 } }, debugApp);

expect(phNoCurr.length, 4, 'history sekarang punya 4 row (Feb/Mar/Apr/Cur)');
expect(phNoCurr[3].date, _curIsoMonth, 'row baru date = bulan berjalan');
expect(phNoCurr[3].label, _curLabelExpected, 'row baru label = "M/D/YYYY" matching history format');
expect(phNoCurr[3].TLKM, 5775, 'TLKM di row baru = harga live');
expect(phNoCurr[2].TLKM, 2810, 'April UNCHANGED (gak ke-overwrite)');
assert(debugApp.live_appended_current_month === true, 'debug flag: appended = true');

// ─── applyLiveOverlay: empty live → no-op ───
console.log('\n[applyLiveOverlay] live kosong → no-op');
const ph4 = [{ date: _curIsoMonth, label: 'Cur-XX', TLKM: 5000 }];
applyLiveOverlay(ph4, {}, {});
expect(ph4[0].TLKM, 5000, 'price_history unchanged');

// ─── parseTickerSheet + buildMetaFromTabs: Meta Spreadsheet 2 tab ───
console.log('\n[parseTickerSheet] tab "perusahaan" (Source.Name=sektor, Saham=jml saham)');
const companyCsv = [
  'Source.Name,No,Kode,Nama Perusahaan,Tanggal Pencatatan,Saham,Papan Pencatatan',
  'Basic Materials,1,AKPI,Argha Karya Prima Industry Tbk,18 Des 1992,"612,248,000",Pengembangan',
  'Transportation & Logistic,2,WBSA,BSA Logistics Indonesia Tbk.,02 Jan 2024,"1,000,000,000",Pengembangan',
].join('\n');
const compTab = parseTickerSheet(companyCsv);
expect(Object.keys(compTab.byCode).sort(), ['AKPI', 'WBSA'], 'perusahaan: 2 ticker (Kode = kolom ticker, bukan Saham)');
assert(compTab.byCode.AKPI.namaperusahaan === 'Argha Karya Prima Industry Tbk', 'perusahaan: nama tertangkap');

console.log('\n[parseTickerSheet] tab "sektor screener" (header Kode Saham + fundamental)');
const screenerCsv = [
  'No,Nama Perusahaan,Kode Saham,Kode Subindustri,Sektor,Subsektor,Industri,Subindustri,Index,PER,PBV,ROE %,ROA %,DER,Mkt Cap,Total Rev,4-wk %Pr. Chg,13-wk %Pr. Chg,26-wk %Pr. Chg,52-wk %Pr. Chg,NPM %,MTD,YTD',
  '1,BSA Logistics,WBSA,K211,Transportation & Logistic,Logistics & Deliv,Logistics,Logistics,"COMPOSITE, DB","5,48","1,02","18,58","12,15","0,53","890784000","219808000","-13,08","-17,14","8,14","10,38","67,28","-4,20","13,12"',
].join('\n');
const screenTab = parseTickerSheet(screenerCsv);
expect(Object.keys(screenTab.byCode), ['WBSA'], 'screener: deteksi "Kode Saham" sebagai ticker (bukan "Kode Subindustri")');

console.log('\n[buildMetaFromTabs] merge 2 tab → info + fundamentals');
const { info, fundamentals } = buildMetaFromTabs(compTab.byCode, screenTab.byCode);
expect(info.WBSA.name, 'BSA Logistics Indonesia Tbk.', 'WBSA name dari tab perusahaan (otoritatif)');
expect(info.WBSA.sector, 'Transportation & Logistic', 'WBSA sector dari screener');
expect(info.WBSA.subsector, 'Logistics & Deliv', 'WBSA subsector dari screener');
expect(info.WBSA.board, 'Pengembangan', 'WBSA board dari perusahaan');
expect(info.WBSA.listing_date, '02 Jan 2024', 'WBSA listing_date dari perusahaan');
expect(info.AKPI.sector, 'Basic Materials', 'AKPI sector dari Source.Name (perusahaan)');
expect(fundamentals.WBSA.per, 5.48, 'PER "5,48" → 5.48 (desimal Indonesia)');
expect(fundamentals.WBSA.roe, 18.58, 'ROE % "18,58" → 18.58');
expect(fundamentals.WBSA.chg_52w, 10.38, '52-wk %Chg → 10.38');
expect(fundamentals.WBSA.shares, 1000000000, 'shares dari tab perusahaan');
expect(fundamentals.WBSA.mkt_cap, 890784000, 'Mkt Cap tertangkap');

// ─── Summary ───
console.log(`\n──────────────────────────────────────`);
console.log(`Pass: ${pass}  Fail: ${fail}`);
process.exit(fail > 0 ? 1 : 0);
