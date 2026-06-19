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
OVERRIDES_FILE = os.path.join(SRC_DIR, 'overrides.json')

# ── ASUMSI VALUASI (transparan & mudah disetel) ──────────────────────────────
ASSUMPTIONS = {
    'risk_free':            0.068,   # SBN 10th — SEMENTARA. Nanti dibaca dari sheet "SBN".
    'equity_risk_premium':  0.075,   # ERP pasar saham Indonesia (asumsi).
    'terminal_growth':      0.035,   # pertumbuhan jangka panjang (≈ inflasi + PDB riil).
    'default_tax_rate':     0.22,    # tarif pajak badan Indonesia (fallback).
    'projection_years':     5,
    # Placeholder pertumbuhan 5 th DCF — DIGANTI bila pemilik beri growth FCF:
    'default_fcf_growth':   0.08,
    'default_div_growth_cap': 0.15,  # batas atas g berkelanjutan DDM.

    # ── Model 5-tahun pemilik (multiples) ──
    'avg_windows':       [3, 5, 7, 10],  # window rata-rata DPR/PBV/PER/PSR
    'avg_window_default': 5,
    'blend_weights':     {'pbv': 0.5, 'per': 0.4, 'psr': 0.1},  # bobot sub-model
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
    q1, q2, q3, q4, annualized, annual = {}, {}, {}, {}, {}, {}
    for row, field in ROW_METRICS.items():
        q1[field] = to_number(grid.get((row, 4)))           # D
        q2[field] = to_number(grid.get((row, 5)))           # E
        q3[field] = to_number(grid.get((row, 6)))           # F
        q4[field] = to_number(grid.get((row, 7)))           # G
        annualized[field] = to_number(grid.get((row, 8)))   # H
        for col in range(9, 27):                            # I..Z
            period = col_period.get(col)
            if period and re.match(r'^\d{4}$', period):
                annual.setdefault(period, {})[field] = to_number(grid.get((row, col)))
    code_in_sheet = grid.get((1, 3))
    q_label = grid.get((1, 4))   # sel D1 = penanda kuartal tahun berjalan (Q1/Q2/Q3)
    result = {
        'code': name.strip().upper(),
        'code_in_sheet': (str(code_in_sheet).strip().upper() if code_in_sheet else None),
        'q_label': (str(q_label).strip() if q_label else None),
        'q1': q1,
        'annualized': annualized,   # = Q1 x 4 (run-rate, BUKAN TTM) — sesuai keputusan: dipakai apa adanya
        'annual': annual,
    }
    if any(v is not None for v in q2.values()):
        result['q2'] = q2
    if any(v is not None for v in q3.values()):
        result['q3'] = q3
    if any(v is not None for v in q4.values()):
        result['q4'] = q4
    return result


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


def dcf_valuation(stock, wacc, warn, financial=False, last_price=None):
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
    price = last_price or stock['q1'].get('price')

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


def ddm_valuation(stock, cost_of_equity, warn, last_price=None):
    """DDM 2-tahap. g berkelanjutan = ROE × (1 − payout)."""
    n  = ASSUMPTIONS['projection_years']
    gt = ASSUMPTIONS['terminal_growth']

    base_dps, dps_year = latest_annual(stock, 'dps')
    roe, _   = latest_annual(stock, 'roe')        # dalam persen (mis. 6.23)
    payout, _= latest_annual(stock, 'dpr')        # fraksi (mis. 0.599)
    price = last_price or stock['q1'].get('price')

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


def annual_years_desc(stock):
    return sorted(stock['annual'].keys(), reverse=True)


def avg_over_window(stock, field, n):
    """Rata-rata `field` atas n tahun terakhir yang tersedia (skip None)."""
    vals = []
    for y in annual_years_desc(stock):
        v = stock['annual'][y].get(field)
        if v is not None:
            vals.append(v)
        if len(vals) >= n:
            break
    return (sum(vals) / len(vals)) if vals else None


def two_latest(stock, field):
    """(nilai_terbaru, nilai_sebelumnya, th_terbaru, th_sebelumnya) untuk sebuah field."""
    found = []
    for y in annual_years_desc(stock):
        v = stock['annual'][y].get(field)
        if v is not None:
            found.append((y, v))
        if len(found) >= 2:
            break
    lv = found[0][1] if len(found) >= 1 else None
    pv = found[1][1] if len(found) >= 2 else None
    ly = found[0][0] if len(found) >= 1 else None
    py = found[1][0] if len(found) >= 2 else None
    return lv, pv, ly, py


def five_year_valuation(stock, last_price, warn, override=None):
    """Model 5-tahun pemilik: 3 sub-model multiples (PBV / PER / PSR) lalu di-blend."""
    n = ASSUMPTIONS['projection_years']
    w = ASSUMPTIONS['avg_window_default']
    bw = ASSUMPTIONS['blend_weights']

    if not last_price or last_price <= 0:
        return {'applicable': False, 'reason': 'Harga tidak tersedia'}

    # Base per-share fundamentals (tahunan terbaru).
    eps_LY, eps_PY, ly, py = two_latest(stock, 'eps')
    sps_LY, sps_PY, _, _   = two_latest(stock, 'sps')
    bvps_LY, _, _, _       = two_latest(stock, 'bvps')

    # Growth tahunan (LY vs PY).
    eps_g_ann = (eps_LY - eps_PY) / eps_PY if (eps_LY is not None and eps_PY) else None
    sps_g_ann = (sps_LY - sps_PY) / sps_PY if (sps_LY is not None and sps_PY) else None
    roe_ann_raw, _, _, _ = two_latest(stock, 'roe')           # persen
    roe_ann = roe_ann_raw / 100.0 if roe_ann_raw is not None else None

    # Angka "5 tahun" diambil dari field data (sesuai arahan pemilik).
    roe_5y   = latest_annual(stock, 'roe_5y')[0]
    eps_g_5y = latest_annual(stock, 'eps_growth_5y')[0]
    sps_g_5y = latest_annual(stock, 'sps_growth_5y')[0]

    # Rata-rata multiples & DPR untuk SEMUA window (3/5/7/10), pakai default utk hitung.
    windows = ASSUMPTIONS['avg_windows']
    avg_multiples = {
        'pbv': {win: round(avg_over_window(stock, 'pbv', win), 4) if avg_over_window(stock, 'pbv', win) is not None else None for win in windows},
        'per': {win: round(avg_over_window(stock, 'per', win), 4) if avg_over_window(stock, 'per', win) is not None else None for win in windows},
        'psr': {win: round(avg_over_window(stock, 'psr', win), 4) if avg_over_window(stock, 'psr', win) is not None else None for win in windows},
        'dpr': {win: round(avg_over_window(stock, 'dpr', win), 4) if avg_over_window(stock, 'dpr', win) is not None else None for win in windows},
    }
    avg_pbv = avg_over_window(stock, 'pbv', w)
    avg_per = avg_over_window(stock, 'per', w)
    avg_psr = avg_over_window(stock, 'psr', w)
    dpr     = avg_over_window(stock, 'dpr', w)

    # ── Override OTORITATIF (dari Excel pemilik via overrides.json) ──
    # Timpa nilai turunan SEBELUM sub-model dihitung, supaya seluruh output
    # (submodels, price_targets, potential_pct) konsisten dgn Excel.
    override_meta = None
    if override:
        oi = override.get('inputs') or {}
        if 'eps' in oi:               eps_LY    = oi['eps']
        if 'sps' in oi:               sps_LY    = oi['sps']
        if 'bvps' in oi:              bvps_LY   = oi['bvps']
        if 'roe_annual' in oi:        roe_ann   = oi['roe_annual']
        if 'roe_5y' in oi:            roe_5y    = oi['roe_5y']
        if 'eps_growth_annual' in oi: eps_g_ann = oi['eps_growth_annual']
        if 'eps_growth_5y' in oi:     eps_g_5y  = oi['eps_growth_5y']
        if 'sps_growth_annual' in oi: sps_g_ann = oi['sps_growth_annual']
        if 'sps_growth_5y' in oi:     sps_g_5y  = oi['sps_growth_5y']
        om = override.get('avg_multiples') or {}
        if 'pbv' in om: avg_pbv = om['pbv']
        if 'per' in om: avg_per = om['per']
        if 'psr' in om: avg_psr = om['psr']
        if 'dpr' in om: dpr     = om['dpr']
        # Cerminkan ke dict avg_multiples pada window default (window lain tetap hasil hitung).
        for metric, val in om.items():
            avg_multiples.setdefault(metric, {})[w] = round(val, 4)
        override_meta = {'source': override.get('source'), 'note': override.get('note'),
                         'inputs': sorted(oi.keys()), 'avg_multiples': sorted(om.keys()),
                         'window': w}
        warn.append(f"{stock.get('code','?')}: five_year memakai override otoritatif "
                    f"({len(oi)} input + {len(om)} multiple, window {w}) "
                    f"dari {override.get('source') or 'overrides.json'}")

    def project(base, g, mult):
        out = []
        val = base
        for t in range(1, n + 1):
            val = val * (1 + g)
            out.append({'year': t, 'value': round(val, 2),
                        'price_target': round(val * mult, 2) if mult is not None else None})
        return out

    def submodel(key, base, g, mult):
        if base is None or g is None or mult is None:
            return {'key': key, 'applicable': False,
                    'growth': round(g, 4) if g is not None else None,
                    'multiple': mult, 'annual': None, 'cagr': None, 'mos': None}
        proj = project(base, g, mult)
        pt5 = proj[-1]['price_target']
        gl = (pt5 - last_price) / last_price
        cagr = (proj[4]['value'] / proj[0]['value']) ** (1 / n) - 1
        mos = 1 - last_price / pt5 if pt5 else None
        return {'key': key, 'applicable': True, 'growth': round(g, 4), 'multiple': round(mult, 4),
                'projection': proj, 'target_5y': round(pt5), 'gl_5y': round(gl, 4),
                'annual': round(gl / n, 4), 'cagr': round(cagr, 4),
                'mos': round(mos, 4) if mos is not None else None}

    g_bv  = (0.8 * roe_5y + 0.2 * roe_ann) if (roe_5y is not None and roe_ann is not None) else None
    g_eps = (0.8 * eps_g_5y + 0.2 * eps_g_ann) if (eps_g_5y is not None and eps_g_ann is not None) else None
    g_sps = (0.8 * sps_g_5y + 0.2 * sps_g_ann) if (sps_g_5y is not None and sps_g_ann is not None) else None

    m_pbv = submodel('pbv', bvps_LY, g_bv, avg_pbv)
    m_per = submodel('per', eps_LY, g_eps, avg_per)
    m_psr = submodel('psr', sps_LY, g_sps, avg_psr)
    submodels = [m_pbv, m_per, m_psr]

    # Blend hanya sub-model yang valid (bobot dinormalisasi ulang).
    avail = [m for m in submodels if m['applicable']]
    wsum = sum(bw[m['key']] for m in avail)
    if wsum == 0:
        missing = []
        if g_bv is None:  missing.append('ROE 5th/tahunan')
        if g_eps is None: missing.append('EPS growth 5th/tahunan')
        if g_sps is None: missing.append('Sales growth 5th/tahunan')
        return {'applicable': False,
                'reason': 'Data 5-tahun belum lengkap (kemungkinan emiten baru listing). '
                          'Input hilang: ' + ', '.join(missing),
                'avg_multiples': avg_multiples}

    blend_annual = sum(bw[m['key']] * m['annual'] for m in avail) / wsum
    cagr_blend   = sum(bw[m['key']] * m['cagr'] for m in avail) / wsum
    mos_blend    = sum(bw[m['key']] * m['mos'] for m in avail if m['mos'] is not None) / wsum
    div_yield = (dpr * eps_LY / last_price) if (dpr is not None and eps_LY is not None) else 0.0
    # Future Value = blend annual G&L + dividend yield (sesuai rumus Excel pemilik).
    future_value = blend_annual + div_yield
    combine = (future_value + cagr_blend) / 2

    # Potensi price akumulasi sesuai rumus Excel pemilik:
    # Future Value = blend Annual + Dividen Yield (sudah di atas), Combine = (FV+CAGR)/2,
    # Potensi(n) = Last × (1 + Combine × n) — ramp pakai COMBINE SAJA.
    price_targets = []
    for yr in range(1, n + 1):
        pt = last_price * (1 + combine * yr)
        price_targets.append({'year': yr, 'target_price': round(pt),
                              'gl_pct': round((pt - last_price) / last_price * 100, 2)})

    if len(avail) < 3:
        warn.append('5y: sub-model tidak lengkap (' +
                    ','.join(m['key'] for m in submodels if not m['applicable']) + ') → bobot dinormalisasi')

    return {
        'applicable': True,
        'method': 'Model 5-tahun multiples (PBV 50% / PER 40% / PSR 10%); FutureValue=blendAnnual+divYield; Potensi=Last×(1+Combine×n)',
        'base_year': ly, 'last_price': last_price,
        'avg_window_used': w, 'avg_windows_available': windows,
        'avg_multiples': avg_multiples,
        'inputs': {
            'eps': eps_LY, 'sps': sps_LY, 'bvps': bvps_LY,
            'roe_annual': round(roe_ann, 4) if roe_ann is not None else None,
            'roe_5y': roe_5y, 'eps_growth_annual': round(eps_g_ann, 4) if eps_g_ann is not None else None,
            'eps_growth_5y': eps_g_5y, 'sps_growth_annual': round(sps_g_ann, 4) if sps_g_ann is not None else None,
            'sps_growth_5y': sps_g_5y, 'dpr': round(dpr, 4) if dpr is not None else None,
        },
        'submodels': {'pbv': m_pbv, 'per': m_per, 'psr': m_psr},
        'future_value': round(future_value, 4),
        'cagr': round(cagr_blend, 4),
        'combine': round(combine, 4),
        'dividend_yield': round(div_yield, 4),
        'margin_of_safety': round(mos_blend, 4),
        'price_targets': price_targets,
        'target_price_5y': price_targets[-1]['target_price'],
        'potential_pct': price_targets[-1]['gl_pct'],
        'override_applied': override_meta,
    }


def load_data_json():
    """Ambil beta, stock_info, dan harga live per kode saham dari public/data.json."""
    try:
        d = json.load(open(DATA_JSON, encoding='utf-8'))
        stats = d.get('stats', {})
        betas = {c: s.get('beta') for c, s in stats.items()}
        live = {c: (v or {}).get('price') for c, v in d.get('live', {}).items()}
        return betas, d.get('stock_info', {}), live
    except Exception as e:
        print(f'[build-valuation] data.json tidak terbaca ({e}) → default dipakai', file=sys.stderr)
        return {}, {}, {}


def load_overrides():
    """Baca override OTORITATIF per-emiten dari data/valuation/overrides.json.

    Format: { "ANTM": { "inputs": {...}, "avg_multiples": {pbv,per,psr,dpr} }, ... }
    Key yang diawali '_' (mis. "_comment") diabaikan.
    """
    try:
        raw = json.load(open(OVERRIDES_FILE, encoding='utf-8'))
        return {k.upper(): v for k, v in raw.items() if not k.startswith('_') and isinstance(v, dict)}
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f'[build-valuation] overrides.json tidak terbaca ({e}) → diabaikan', file=sys.stderr)
        return {}


def apply_override(code, five, override, warn):
    """DEPRECATED: override kini diterapkan di dalam five_year_valuation(override=...).
    Disisakan sebagai no-op untuk kompatibilitas bila ada pemanggil lama."""
    return


# ════════════════════════════ MAIN ══════════════════════════════════════════
def main():
    files = sorted(glob.glob(os.path.join(SRC_DIR, '*.xlsx')))
    files = [f for f in files if not os.path.basename(f).startswith('~$')]
    if not files:
        print(f'[build-valuation] Tidak ada file .xlsx di {SRC_DIR}', file=sys.stderr)

    betas, stock_info, live_prices = load_data_json()
    overrides = load_overrides()
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
            # Harga realtime dari sheet/live data.json; fallback ke harga Excel (q1).
            last_price = live_prices.get(code) or data['q1'].get('price')
            price_is_live = bool(live_prices.get(code))

            warn = []
            wacc_info = compute_wacc(data, betas.get(code), warn)
            ke = wacc_info['cost_of_equity']
            five = five_year_valuation(data, last_price, warn, override=overrides.get(code))
            dcf = dcf_valuation(data, wacc_info['wacc'], warn, financial=financial, last_price=last_price)
            ddm = ddm_valuation(data, ke, warn, last_price=last_price)

            data['valuation'] = {
                'sector': info.get('sector'),
                'industry': info.get('industry'),
                'is_financial': financial,
                'last_price': last_price,
                'price_source': 'live' if price_is_live else 'excel',
                'five_year': five,            # model utama pemilik
                'wacc': wacc_info,
                'dcf': dcf,                   # cross-check profesional
                'ddm': ddm,                   # cross-check profesional
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
