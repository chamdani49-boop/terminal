#!/usr/bin/env python3
"""
build-valuation.py — Pipeline valuasi saham (Fase 1-3).

ALUR:
  1. Baca SEMUA file .xlsx di data/valuation/ (tiap sheet = 1 kode saham),
     ekstrak seri laporan keuangan A1:Z40 dengan layout tetap.
  2. Ambil beta/volatilitas dari public/data.json (hasil build-data.js).
  3. Hitung WACC (CAPM), lalu valuasi DCF (FCFF 2-tahap) & DDM (2-tahap).
  4. Tulis public/valuation.json (raw data + hasil model + asumsi transparan).

Tanpa dependency eksternal: .xlsx dibaca langsung (zip + XML stdlib),
jadi script jalan di mana saja (lokal & GitHub Actions) tanpa npm/pip install.

CATATAN: bagian proyeksi 5 tahun (growth) saat ini memakai DEFAULT placeholder
yang ditandai jelas. Nanti diganti dengan rumus proyeksi 5 tahun dari pemilik.
"""

import os, sys, glob, json, zipfile, re, datetime
import xml.etree.ElementTree as ET

NS  = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR  = os.path.join(ROOT, 'data', 'valuation')
OUT_FILE = os.path.join(ROOT, 'public', 'valuation.json')
DATA_JSON = os.path.join(ROOT, 'public', 'data.json')

# ── ASUMSI VALUASI (transparan & mudah disetel) ──────────────────────────────
ASSUMPTIONS = {
    'risk_free':            0.068,   # SBN 10th — SEMENTARA. Nanti dibaca dari sheet "SBN".
    'equity_risk_premium':  0.075,   # ERP pasar saham Indonesia (asumsi).
    'terminal_growth':      0.035,   # pertumbuhan jangka panjang (≈ inflasi + PDB riil).
    'default_tax_rate':     0.22,    # tarif pajak badan Indonesia (fallback).
    'projection_years':     5,
    # Placeholder pertumbuhan 5 th — DIGANTI rumus pemilik nanti:
    'default_fcf_growth':   0.08,
    'default_div_growth_cap': 0.15,  # batas atas g berkelanjutan DDM.
}

# ── Peta baris → field (layout tetap, sama di semua sheet) ───────────────────
ROW_METRICS = {
    2:'price', 4:'total_revenue', 5:'net_income', 6:'total_equity', 7:'shares_bn',
    8:'fcf', 9:'fcf_per_share', 10:'p_fcf', 11:'cash', 12:'net_debt', 13:'total_debt',
    14:'interest_expense', 15:'tax_expense', 16:'pretax_income', 20:'market_cap',
    21:'shares', 23:'roe', 24:'roe_5y', 25:'eps', 26:'eps_growth_5y', 27:'sps',
    28:'sps_growth_5y', 32:'bvps', 33:'pbv', 34:'per', 35:'psr', 36:'dpr', 37:'dps',
}
LABEL_ROW = 18
BAD_STRINGS = {'#value!', '#n/a', '#div/0!', '#ref!', 'libur', '', 'n/a', '-'}


# ════════════════════════════ PARSING XLSX ══════════════════════════════════
def col_to_idx(col):
    idx = 0
    for c in col:
        idx = idx * 26 + (ord(c) - 64)
    return idx


def to_number(val):
    if val is None:
        return None
    s = str(val).strip()
    if s.lower() in BAD_STRINGS:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def clean_period_label(raw):
    if raw is None:
        return None
    s = str(raw).strip()
    m = re.search(r'(\d{4})', s)
    if s.lower().startswith('12m') and m:
        return m.group(1)
    return s


def read_workbook(path):
    z = zipfile.ZipFile(path)
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        root = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in root.findall(f'{NS}si'):
            shared.append(''.join(t.text or '' for t in si.iter(f'{NS}t')))

    wb = ET.fromstring(z.read('xl/workbook.xml'))
    sheets = [(s.get('name'), s.get(f'{RNS}id')) for s in wb.find(f'{NS}sheets')]
    rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    rid_to_target = {r.get('Id'): r.get('Target') for r in rels}

    def cell_val(c):
        t = c.get('t')
        v = c.find(f'{NS}v')
        if t == 's':
            return shared[int(v.text)] if v is not None else None
        if t == 'inlineStr':
            is_ = c.find(f'{NS}is')
            return ''.join(x.text or '' for x in is_.iter(f'{NS}t')) if is_ is not None else None
        return v.text if v is not None else None

    def read_sheet(rid):
        target = rid_to_target[rid]
        if not target.startswith('xl/'):
            target = 'xl/' + target
        ws = ET.fromstring(z.read(target))
        grid = {}
        for row in ws.iter(f'{NS}row'):
            for c in row.iter(f'{NS}c'):
                m = re.match(r'([A-Z]+)(\d+)', c.get('r'))
                col = col_to_idx(m.group(1)); r = int(m.group(2))
                if col <= 26 and r <= 40:
                    grid[(r, col)] = cell_val(c)
        return grid

    return sheets, read_sheet


def parse_sheet(name, grid):
    col_period = {col: clean_period_label(grid.get((LABEL_ROW, col))) for col in range(9, 27)}
    q1, annualized, annual = {}, {}, {}
    for row, field in ROW_METRICS.items():
        q1[field] = to_number(grid.get((row, 4)))           # D
        annualized[field] = to_number(grid.get((row, 8)))   # H
        for col in range(9, 27):                            # I..Z
            period = col_period.get(col)
            if period and re.match(r'^\d{4}$', period):
                annual.setdefault(period, {})[field] = to_number(grid.get((row, col)))
    code_in_sheet = grid.get((1, 3))
    return {
        'code': name.strip().upper(),
        'code_in_sheet': (str(code_in_sheet).strip().upper() if code_in_sheet else None),
        'q1': q1,
        'annualized': annualized,   # = Q1 x 4 (run-rate, BUKAN TTM) — sesuai keputusan: dipakai apa adanya
        'annual': annual,
    }


# ════════════════════════════ MESIN VALUASI ═════════════════════════════════
def latest_annual(stock, field):
    """Nilai tahunan terbaru yang tidak None untuk sebuah field, beserta tahunnya."""
    for year in sorted(stock['annual'].keys(), reverse=True):
        v = stock['annual'][year].get(field)
        if v is not None:
            return v, year
    return None, None


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def compute_wacc(stock, beta, warn):
    """WACC via CAPM. Mengembalikan dict komponen WACC (None bila tak terhitung)."""
    rf  = ASSUMPTIONS['risk_free']
    erp = ASSUMPTIONS['equity_risk_premium']

    if beta is None:
        beta = 1.0
        warn.append('beta tidak ada di data.json → pakai beta=1.0')

    cost_of_equity = rf + beta * erp

    # Tarif pajak efektif = |beban pajak| / laba sebelum pajak (tahun terbaru).
    tax_exp, _  = latest_annual(stock, 'tax_expense')
    pretax, _   = latest_annual(stock, 'pretax_income')
    if tax_exp is not None and pretax and pretax > 0:
        tax_rate = clamp(abs(tax_exp) / pretax, 0.0, 0.35)
    else:
        tax_rate = ASSUMPTIONS['default_tax_rate']

    # Cost of debt = |beban keuangan| / total debt (tahun terbaru).
    int_exp, _ = latest_annual(stock, 'interest_expense')
    debt, _    = latest_annual(stock, 'total_debt')
    if int_exp is not None and debt and debt > 0:
        cost_of_debt = clamp(abs(int_exp) / debt, 0.0, 0.30)
    else:
        cost_of_debt = None

    # Bobot: E = market cap (q1), D = total debt (q1 atau tahunan terbaru).
    equity_val = stock['q1'].get('market_cap')
    if equity_val is None:
        price = stock['q1'].get('price'); sh = stock['q1'].get('shares')
        equity_val = price * sh if (price and sh) else None
    debt_val = stock['q1'].get('total_debt')
    if debt_val is None:
        debt_val = debt

    kd_after_tax = cost_of_debt * (1 - tax_rate) if cost_of_debt is not None else None

    if equity_val and equity_val > 0 and debt_val and debt_val > 0 and kd_after_tax is not None:
        total = equity_val + debt_val
        we, wd = equity_val / total, debt_val / total
        wacc = we * cost_of_equity + wd * kd_after_tax
    else:
        # Tanpa utang berbunyi → WACC = cost of equity.
        we, wd, wacc = 1.0, 0.0, cost_of_equity

    return {
        'risk_free': rf, 'equity_risk_premium': erp, 'beta': round(beta, 3),
        'cost_of_equity': round(cost_of_equity, 4),
        'cost_of_debt': round(cost_of_debt, 4) if cost_of_debt is not None else None,
        'cost_of_debt_after_tax': round(kd_after_tax, 4) if kd_after_tax is not None else None,
        'tax_rate_effective': round(tax_rate, 4),
        'weight_equity': round(we, 4), 'weight_debt': round(wd, 4),
        'wacc': round(wacc, 4),
    }


def is_financial(info):
    """Deteksi emiten sektor keuangan (bank/asuransi/multifinance) → FCFF tak sesuai."""
    blob = ' '.join(str(info.get(k, '')) for k in ('sector', 'subsector', 'industry', 'subindustry')).lower()
    return any(kw in blob for kw in ('financ', 'bank', 'insuranc', 'asuransi'))


def dcf_valuation(stock, wacc, warn, financial=False):
    """DCF FCFF 2-tahap. Growth 5 th = placeholder (akan diganti rumus pemilik)."""
    if financial:
        return {'applicable': False,
                'reason': 'Emiten sektor keuangan — model FCFF tidak sesuai; gunakan DDM / excess-return'}

    n = ASSUMPTIONS['projection_years']
    g  = ASSUMPTIONS['default_fcf_growth']     # PLACEHOLDER
    gt = ASSUMPTIONS['terminal_growth']

    base_fcf, base_year = latest_annual(stock, 'fcf')
    shares = stock['q1'].get('shares') or (latest_annual(stock, 'shares')[0])
    net_debt = stock['q1'].get('net_debt')
    if net_debt is None:
        net_debt = latest_annual(stock, 'net_debt')[0]
    price = stock['q1'].get('price')

    caveats = []
    if base_fcf is None or shares is None:
        return {'applicable': False, 'reason': 'FCF / jumlah saham tidak tersedia'}
    if base_fcf <= 0:
        caveats.append('FCF dasar negatif/nol → DCF tidak andal untuk emiten ini')
    if wacc <= gt:
        caveats.append('WACC <= terminal growth → terminal value tidak valid; DCF dilewati')
        return {'applicable': False, 'reason': 'WACC <= terminal growth', 'caveats': caveats}

    pv_fcf, projected = 0.0, []
    fcf = base_fcf
    for t in range(1, n + 1):
        fcf = fcf * (1 + g)
        pv = fcf / ((1 + wacc) ** t)
        pv_fcf += pv
        projected.append({'year': t, 'fcf': round(fcf), 'pv': round(pv)})

    terminal = fcf * (1 + gt) / (wacc - gt)
    pv_terminal = terminal / ((1 + wacc) ** n)
    ev = pv_fcf + pv_terminal
    equity_value = ev - (net_debt if net_debt is not None else 0)
    fair = equity_value / shares
    upside = (fair / price - 1) if (price and price > 0) else None

    return {
        'applicable': True,
        'method': 'FCFF 2-tahap (5 th eksplisit + terminal Gordon)',
        'base_year': base_year, 'base_fcf': round(base_fcf),
        'growth_5y': g, 'growth_5y_source': 'PLACEHOLDER (menunggu rumus proyeksi 5 th pemilik)',
        'terminal_growth': gt, 'wacc': round(wacc, 4),
        'projected_fcf': projected,
        'pv_fcf_sum': round(pv_fcf), 'pv_terminal': round(pv_terminal),
        'enterprise_value': round(ev), 'net_debt': round(net_debt) if net_debt is not None else 0,
        'equity_value': round(equity_value),
        'fair_value_per_share': round(fair, 2),
        'current_price': price,
        'upside_pct': round(upside * 100, 2) if upside is not None else None,
        'caveats': caveats,
    }


def ddm_valuation(stock, cost_of_equity, warn):
    """DDM 2-tahap. g berkelanjutan = ROE × (1 − payout)."""
    n  = ASSUMPTIONS['projection_years']
    gt = ASSUMPTIONS['terminal_growth']

    base_dps, dps_year = latest_annual(stock, 'dps')
    roe, _   = latest_annual(stock, 'roe')        # dalam persen (mis. 6.23)
    payout, _= latest_annual(stock, 'dpr')        # fraksi (mis. 0.599)
    price = stock['q1'].get('price')

    caveats = []
    if not base_dps or base_dps <= 0:
        return {'applicable': False, 'reason': 'Emiten tidak membayar dividen (DPS=0) → DDM tidak berlaku'}

    # Sustainable growth g = ROE × retention.
    if roe is not None and payout is not None:
        g = (roe / 100.0) * (1 - payout)
        g = clamp(g, 0.0, ASSUMPTIONS['default_div_growth_cap'])
        g_source = 'g = ROE × (1 − payout) [berkelanjutan]'
    else:
        g = ASSUMPTIONS['terminal_growth']
        g_source = 'fallback = terminal growth (ROE/payout tidak lengkap)'

    if cost_of_equity <= gt:
        return {'applicable': False, 'reason': 'cost of equity <= terminal growth', 'caveats': caveats}

    pv_div, projected = 0.0, []
    dps = base_dps
    for t in range(1, n + 1):
        dps = dps * (1 + g)
        pv = dps / ((1 + cost_of_equity) ** t)
        pv_div += pv
        projected.append({'year': t, 'dps': round(dps, 2), 'pv': round(pv, 2)})

    terminal = dps * (1 + gt) / (cost_of_equity - gt)
    pv_terminal = terminal / ((1 + cost_of_equity) ** n)
    fair = pv_div + pv_terminal
    upside = (fair / price - 1) if (price and price > 0) else None

    return {
        'applicable': True,
        'method': 'DDM 2-tahap (5 th eksplisit + terminal Gordon)',
        'base_year': dps_year, 'base_dps': round(base_dps, 2),
        'growth_5y': round(g, 4), 'growth_5y_source': g_source,
        'terminal_growth': gt, 'cost_of_equity': round(cost_of_equity, 4),
        'projected_dps': projected,
        'pv_dividends_sum': round(pv_div, 2), 'pv_terminal': round(pv_terminal, 2),
        'fair_value_per_share': round(fair, 2),
        'current_price': price,
        'upside_pct': round(upside * 100, 2) if upside is not None else None,
        'caveats': caveats,
    }


def load_data_json():
    """Ambil beta & stock_info per kode saham dari public/data.json."""
    try:
        d = json.load(open(DATA_JSON, encoding='utf-8'))
        stats = d.get('stats', {})
        betas = {c: s.get('beta') for c, s in stats.items()}
        return betas, d.get('stock_info', {})
    except Exception as e:
        print(f'[build-valuation] data.json tidak terbaca ({e}) → beta default dipakai', file=sys.stderr)
        return {}, {}


# ════════════════════════════ MAIN ══════════════════════════════════════════
def main():
    files = sorted(glob.glob(os.path.join(SRC_DIR, '*.xlsx')))
    files = [f for f in files if not os.path.basename(f).startswith('~$')]
    if not files:
        print(f'[build-valuation] Tidak ada file .xlsx di {SRC_DIR}', file=sys.stderr)

    betas, stock_info = load_data_json()
    stocks, warnings, source_files = {}, [], []

    for path in files:
        source_files.append(os.path.basename(path))
        sheets, read_sheet = read_workbook(path)
        for name, rid in sheets:
            data = parse_sheet(name, read_sheet(rid))
            code = data['code']
            if data['code_in_sheet'] and data['code_in_sheet'] != code:
                warnings.append(f"Sheet '{name}' di {os.path.basename(path)}: nama sheet != C1 "
                                f"('{code}' vs '{data['code_in_sheet']}')")
            if code in stocks:
                warnings.append(f"Kode '{code}' duplikat (di {os.path.basename(path)}), data lama ditimpa.")

            info = stock_info.get(code, {})
            financial = is_financial(info)
            warn = []
            wacc_info = compute_wacc(data, betas.get(code), warn)
            ke = wacc_info['cost_of_equity']
            dcf = dcf_valuation(data, wacc_info['wacc'], warn, financial=financial)
            ddm = ddm_valuation(data, ke, warn)

            # Metode yang disarankan + fair value ringkas untuk UI.
            if financial:
                primary = 'DDM' if ddm.get('applicable') else None
            else:
                primary = 'DCF' if dcf.get('applicable') else ('DDM' if ddm.get('applicable') else None)
            primary_model = {'DCF': dcf, 'DDM': ddm}.get(primary)
            fair = primary_model.get('fair_value_per_share') if primary_model else None
            upside = primary_model.get('upside_pct') if primary_model else None

            data['valuation'] = {
                'sector': info.get('sector'),
                'industry': info.get('industry'),
                'is_financial': financial,
                'recommended_method': primary,
                'fair_value_per_share': fair,
                'upside_pct': upside,
                'wacc': wacc_info,
                'dcf': dcf,
                'ddm': ddm,
                'notes': warn,
            }
            stocks[code] = data

    out = {
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'source_files': source_files,
        'count': len(stocks),
        'assumptions': ASSUMPTIONS,
        'note': ("'annualized' = 'tahun berjalan' sheet = Q1 x 4 (run-rate, dipakai apa adanya). "
                 "Growth 5 th DCF masih PLACEHOLDER (menunggu rumus proyeksi pemilik). "
                 "risk_free sementara konstan; akan dibaca dari sheet 'SBN'."),
        'stocks': stocks,
        'warnings': warnings,
    }

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"[build-valuation] {len(stocks)} saham dari {len(source_files)} file -> {OUT_FILE}")
    if warnings:
        print('[build-valuation] WARNINGS:')
        for w in warnings:
            print('  - ' + w)


if __name__ == '__main__':
    main()
