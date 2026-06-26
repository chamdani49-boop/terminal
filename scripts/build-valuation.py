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
OUT_DIR  = os.path.join(ROOT, 'public', 'valuation')   # split: index.json + <CODE>.json
DATA_JSON = os.path.join(ROOT, 'public', 'data.json')
OVERRIDES_FILE = os.path.join(SRC_DIR, 'overrides.json')
YEARLY_FILE = os.path.join(ROOT, 'public', 'history-yearly.json')   # fallback Yahoo (<2016)

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

# Kolom kuartal tahun berjalan: D=Q1, E=Q2, F=Q3, G=Q4 → tutup kuartal bln 3/6/9/12.
QUARTER_COLS  = {'Q1': 4, 'Q2': 5, 'Q3': 6, 'Q4': 7}
QUARTER_MONTH = {'Q1': 3, 'Q2': 6, 'Q3': 9, 'Q4': 12}


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
                elif r <= 400 and col in (3, 4, 8, 9):   # Key Stats TTM (di luar A1:Z40):
                    grid[(r, col)] = cell_val(c)          # label di C(3); nilai di D/H/I (4/8/9)
        return grid

    return sheets, read_sheet


def parse_sheet(name, grid):
    col_period = {col: clean_period_label(grid.get((LABEL_ROW, col))) for col in range(9, 27)}
    quarters, annualized, annual = {}, {}, {}
    q_price_libur = {}
    # Kuartal tahun berjalan: D=Q1, E=Q2, F=Q3, G=Q4 (E-G bisa kosong = belum lapor).
    for qn, qcol in QUARTER_COLS.items():
        qf = {}
        for row, field in ROW_METRICS.items():
            qf[field] = to_number(grid.get((row, qcol)))
        quarters[qn] = qf
        # Tandai kalau sel HARGA (baris 2) berisi teks 'libur' → ADA data (perlu diisi
        # dari history). Sel kosong → belum ada laporan kuartal → JANGAN diisi.
        praw = str(grid.get((2, qcol)) or '').strip().lower()
        q_price_libur[qn] = (praw == 'libur')
    for row, field in ROW_METRICS.items():
        annualized[field] = to_number(grid.get((row, 8)))   # H = tahun berjalan
        for col in range(9, 27):                            # I..Z = tahunan
            period = col_period.get(col)
            if period and re.match(r'^\d{4}$', period):
                annual.setdefault(period, {})[field] = to_number(grid.get((row, col)))
    # ── TTM RIIL dari section "Key Stats" (baris BERVARIASI per saham → dicari via
    #    LABEL di kolom C; nilainya bisa di kolom H/I/D). Ini basis "tahun berjalan"
    #    yang lebih bijak = 12 bulan terakhir nyata (bukan run-rate Q1×4).
    ttm = {}
    TTM_LABELS = {
        'EPS - TTM (Q1)':        'eps',
        'Net Income - TTM (Q1)': 'net_income',
        'Revenue - TTM (Q1)':    'total_revenue',
        'Return on Equity (TTM)':'roe',   # fraksi (mis. 0.2184) → dikali 100 saat dipakai
    }
    for (r, c), v in list(grid.items()):
        if c == 3 and v is not None:
            key = TTM_LABELS.get(str(v).strip())
            if key:
                for vc in (8, 9, 4):              # H, I, D — ambil kolom pertama yang terisi
                    val = to_number(grid.get((r, vc)))
                    if val is not None:
                        ttm[key] = val
                        break
    code_in_sheet = grid.get((1, 3))
    q_label = grid.get((1, 4))   # sel D1 = penanda kuartal tahun berjalan (Q1/Q2/Q3)
    return {
        'code': name.strip().upper(),
        'code_in_sheet': (str(code_in_sheet).strip().upper() if code_in_sheet else None),
        'q_label': (str(q_label).strip() if q_label else None),
        'q1': quarters['Q1'],       # backward-compat: mesin & frontend pakai stock['q1']
        'quarters': quarters,        # Q1..Q4 (kolom D..G)
        'q_price_libur': q_price_libur,
        'annualized': annualized,   # kolom H = "tahun berjalan" (TTM, dibaca apa adanya)
        'annual': annual,
        'ttm': ttm,                 # TTM riil (Key Stats): eps/net_income/total_revenue/roe
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
    if base_fcf is None or shares is None or shares <= 0:
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


def avg_over_window_ttm(stock, field, n):
    """Rata-rata `field` untuk model TTM: nilai TTM (kolom H) + n tahun annual
    terakhir = (n+1) angka. Sesuai arahan pemilik (mis. window 5 = TTM + 2021..2025
    → 6 angka; 3 → 4; 7 → 8; 10 → 11). Lewati None."""
    vals = []
    tv = (stock.get('annualized') or {}).get(field)
    if tv is not None:
        vals.append(tv)
    cnt = 0
    for y in annual_years_desc(stock):
        v = stock['annual'][y].get(field)
        if v is not None:
            vals.append(v); cnt += 1
        if cnt >= n:
            break
    return (sum(vals) / len(vals)) if vals else None


def eps_growth_5y_ttm(stock, eps_ttm, n=5):
    """EPS growth 5th (TTM) DIHITUNG di mesin sebagai CAGR:
        (EPS_TTM / EPS_{n tahun lalu})^(1/periode) − 1
    Pembilang  = EPS TTM dihitung (laba / saham).
    Penyebut   = EPS annual FILE di tahun ke-n terbaru (mis. 2021).
    Konsisten dgn cara file menghitung sps_growth_5y kolom H (TTM→2021).
    EPS file kolom H (salah, sesuai pemilik) TIDAK dipakai."""
    if eps_ttm is None or eps_ttm <= 0:
        return None
    pairs = [(int(y), stock['annual'][y].get('eps')) for y in stock['annual']]
    pairs = sorted([(y, v) for y, v in pairs if v is not None],
                   key=lambda p: p[0], reverse=True)
    if not pairs:
        return None
    ttm_year = pairs[0][0] + 1                     # tahun berjalan = annual terbaru + 1
    base_year, base_eps = pairs[min(n, len(pairs)) - 1]   # tahun ke-n (atau tertua tersedia)
    if base_eps is None or base_eps <= 0:
        return None
    periods = ttm_year - base_year
    if periods <= 0:
        return None
    return (eps_ttm / base_eps) ** (1.0 / periods) - 1


def five_year_valuation(stock, last_price, warn, override=None):
    """Model 5-tahun pemilik: 3 sub-model multiples (PBV / PER / PSR) lalu di-blend."""
    n = ASSUMPTIONS['projection_years']
    w = ASSUMPTIONS['avg_window_default']
    bw = ASSUMPTIONS['blend_weights']

    if not last_price or last_price <= 0:
        return {'applicable': False, 'reason': 'Harga tidak tersedia'}

    # ── BASIS TTM (kolom H / "tahun berjalan") ──────────────────────────────
    # Arahan pemilik: model TTM memakai kolom H, BUKAN baris annual terbaru (2025).
    #  • Pendapatan/laba/ekuitas di H sudah disetahunkan (TTM) oleh pemilik.
    #  • EPS H di file SALAH → JANGAN dipakai; hitung di mesin = laba / saham.
    #  • bvps & multiples (pbv/per/psr) diambil apa adanya dari file (kolom H).
    ann = stock.get('annualized') or {}

    def _ttm(field):
        """Nilai kolom H (TTM); fallback ke annual terbaru bila H kosong (emiten
        yang kolom H-nya belum lengkap) supaya model tetap jalan seperti sebelumnya."""
        v = ann.get(field)
        return v if v is not None else latest_annual(stock, field)[0]

    # EPS TTM = EPS-TTM riil (Key Stats) yang sudah di-set ke ann['eps'] di main();
    # fallback: laba/saham (run-rate), lalu EPS annual terakhir.
    eps_ttm = ann.get('eps')
    if eps_ttm is None:
        ni_ttm, shares_ttm = ann.get('net_income'), ann.get('shares')
        if ni_ttm is not None and shares_ttm not in (None, 0):
            eps_ttm = ni_ttm / shares_ttm
    if eps_ttm is None:                          # benar-benar tak ada → fallback EPS annual file
        eps_ttm = latest_annual(stock, 'eps')[0]

    eps_LY  = eps_ttm            # EPS TTM (dihitung di mesin; fallback annual bila perlu)
    sps_LY  = _ttm('sps')        # SPS TTM (kolom H)
    bvps_LY = _ttm('bvps')       # Book value TTM (kolom H, dari file)

    # "Tahun sebelumnya" = annual terbaru dari FILE (annual terkunci PR280).
    eps_PY, ly = latest_annual(stock, 'eps')
    sps_PY, _  = latest_annual(stock, 'sps')

    # Growth tahunan (TTM vs annual terbaru).
    eps_g_ann = (eps_LY - eps_PY) / eps_PY if (eps_LY is not None and eps_PY) else None
    sps_g_ann = (sps_LY - sps_PY) / sps_PY if (sps_LY is not None and sps_PY) else None

    # ROE tahunan = ROE kolom H (TTM), persen → fraksi.
    roe_ann_raw = _ttm('roe')
    roe_ann = roe_ann_raw / 100.0 if roe_ann_raw is not None else None

    # Angka "5 tahun": ROE & SPS pakai nilai file kolom H (sudah benar — arahan pemilik).
    roe_5y   = _ttm('roe_5y')
    sps_g_5y = _ttm('sps_growth_5y')
    # EPS growth 5th DIHITUNG di mesin (CAGR EPS_TTM → tahun ke-5; EPS H file tak dipakai).
    eps_g_5y = eps_growth_5y_ttm(stock, eps_ttm, ASSUMPTIONS['projection_years'])

    # ── Fallback CAGR: hitung dari data annual jika field 5y dari Excel = None ──
    # Untuk emiten baru yang belum punya histori 5 tahun di Excel, kita hitung
    # CAGR dari data annual yang tersedia (minimal 3 tahun).
    fallback_used = False
    # Hitung data_years: jumlah tahun annual yang punya minimal eps atau bvps non-None
    annual_years_with_data = []
    for yr in sorted(stock['annual'].keys()):
        yd = stock['annual'][yr]
        if yd.get('bvps') is not None or yd.get('eps') is not None or yd.get('sps') is not None:
            annual_years_with_data.append(yr)
    data_years = len(annual_years_with_data)

    if data_years >= 3:
        # Fallback ROE 5y: CAGR of BVPS
        if roe_5y is None:
            bvps_pairs = [(yr, stock['annual'][yr].get('bvps')) for yr in annual_years_with_data
                          if stock['annual'][yr].get('bvps') is not None]
            if len(bvps_pairs) >= 3:
                bvps_first = bvps_pairs[0][1]
                bvps_last = bvps_pairs[-1][1]
                n_periods = len(bvps_pairs) - 1
                if bvps_first > 0 and bvps_last > 0:
                    roe_5y = (bvps_last / bvps_first) ** (1.0 / n_periods) - 1
                    fallback_used = True

        # Fallback EPS growth 5y: CAGR of EPS (hanya jika earliest & latest > 0)
        if eps_g_5y is None:
            eps_pairs = [(yr, stock['annual'][yr].get('eps')) for yr in annual_years_with_data
                         if stock['annual'][yr].get('eps') is not None]
            if len(eps_pairs) >= 3:
                eps_first = eps_pairs[0][1]
                eps_last = eps_pairs[-1][1]
                n_periods = len(eps_pairs) - 1
                if eps_first > 0 and eps_last > 0:
                    eps_g_5y = (eps_last / eps_first) ** (1.0 / n_periods) - 1
                    fallback_used = True

        # Fallback SPS growth 5y: CAGR of SPS (hanya jika earliest & latest > 0)
        if sps_g_5y is None:
            sps_pairs = [(yr, stock['annual'][yr].get('sps')) for yr in annual_years_with_data
                         if stock['annual'][yr].get('sps') is not None]
            if len(sps_pairs) >= 3:
                sps_first = sps_pairs[0][1]
                sps_last = sps_pairs[-1][1]
                n_periods = len(sps_pairs) - 1
                if sps_first > 0 and sps_last > 0:
                    sps_g_5y = (sps_last / sps_first) ** (1.0 / n_periods) - 1
                    fallback_used = True

        # Fallback roe_ann: jika None, ambil dari data annual roe terbaru
        if roe_ann is None:
            roe_raw, _ = latest_annual(stock, 'roe')
            if roe_raw is not None:
                roe_ann = roe_raw / 100.0
                fallback_used = True

    if fallback_used:
        warn.append(f"{stock.get('code','?')}: five_year menggunakan fallback CAGR "
                    f"(data_years={data_years}, bukan dari Excel 5y field)")

    # Rata-rata multiples & DPR untuk SEMUA window (3/5/7/10), pakai default utk hitung.
    windows = ASSUMPTIONS['avg_windows']
    # DPR TIDAK dirata-rata — pakai DPR kolom H / TTM (keputusan pemilik).
    dpr = _ttm('dpr')
    _dpr_r = round(dpr, 4) if dpr is not None else None
    avg_multiples = {
        'pbv': {win: round(avg_over_window_ttm(stock, 'pbv', win), 4) if avg_over_window_ttm(stock, 'pbv', win) is not None else None for win in windows},
        'per': {win: round(avg_over_window_ttm(stock, 'per', win), 4) if avg_over_window_ttm(stock, 'per', win) is not None else None for win in windows},
        'psr': {win: round(avg_over_window_ttm(stock, 'psr', win), 4) if avg_over_window_ttm(stock, 'psr', win) is not None else None for win in windows},
        'dpr': {win: _dpr_r for win in windows},   # DPR = kolom H / TTM (tak dirata-rata)
    }
    avg_pbv = avg_over_window_ttm(stock, 'pbv', w)
    avg_per = avg_over_window_ttm(stock, 'per', w)
    avg_psr = avg_over_window_ttm(stock, 'psr', w)

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
        # Mark not-applicable jika input wajib hilang ATAU base/multiple non-positif
        # (mis. emiten dgn ekuitas/laba/pendapatan ≤0 atau last_price ≤0).
        if base is None or g is None or mult is None or base <= 0 or mult <= 0 or last_price is None or last_price <= 0:
            return {'key': key, 'applicable': False,
                    'growth': round(g, 4) if g is not None else None,
                    'multiple': mult, 'annual': None, 'cagr': None, 'mos': None}
        proj = project(base, g, mult)
        pt5 = proj[-1]['price_target']
        gl = (pt5 - last_price) / last_price
        v0, v5 = proj[0]['value'], proj[4]['value']
        cagr = ((v5 / v0) ** (1 / n) - 1) if (v0 and v0 > 0 and v5 and v5 > 0) else None
        mos = 1 - last_price / pt5 if pt5 else None
        return {'key': key, 'applicable': True, 'growth': round(g, 4), 'multiple': round(mult, 4),
                'projection': proj, 'target_5y': round(pt5), 'gl_5y': round(gl, 4),
                'annual': round(gl / n, 4), 'cagr': round(cagr, 4) if cagr is not None else None,
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
                'data_years': data_years,
                'fallback_used': fallback_used,
                'avg_multiples': avg_multiples}

    # Blend per-metric: filter sub-model yg metriknya None & re-normalize bobotnya.
    # (Misal CAGR di salah satu sub-model None karena base/proyeksi non-positif.)
    def _blend(field):
        valid = [m for m in avail if m.get(field) is not None]
        if not valid: return None
        wsum_v = sum(bw[m['key']] for m in valid)
        if wsum_v == 0: return None
        return sum(bw[m['key']] * m[field] for m in valid) / wsum_v
    blend_annual = _blend('annual') or 0.0
    cagr_blend   = _blend('cagr')   or 0.0
    mos_blend    = _blend('mos')
    div_yield = (dpr * eps_LY / last_price) if (dpr is not None and eps_LY is not None and last_price is not None and last_price > 0) else 0.0
    # Future Value = blend annual G&L + dividend yield (sesuai rumus Excel pemilik).
    future_value = blend_annual + div_yield
    combine = (future_value + cagr_blend) / 2

    # Potensi price akumulasi sesuai rumus Excel pemilik:
    # FutureValue = blend Annual + Dividen Yield ; Combine = (FV+CAGR)/2 ;
    # Potensi(n) = Last × (1 + (Combine + Dividen Yield) × n) — ramp = Combine + DivYield.
    price_targets = []
    if last_price is not None and last_price > 0:
        ramp = combine + div_yield
        for yr in range(1, n + 1):
            pt = last_price * (1 + ramp * yr)
            price_targets.append({'year': yr, 'target_price': round(pt),
                                  'gl_pct': round((pt - last_price) / last_price * 100, 2)})

    if len(avail) < 3:
        warn.append('5y: sub-model tidak lengkap (' +
                    ','.join(m['key'] for m in submodels if not m['applicable']) + ') → bobot dinormalisasi')

    return {
        'applicable': True,
        'method': 'Model 5-tahun multiples (PBV 50% / PER 40% / PSR 10%); FutureValue=blendAnnual+divYield; Potensi=Last×(1+(Combine+DivYield)×n)',
        'base_year': ly, 'last_price': last_price,
        'avg_window_used': w, 'avg_windows_available': windows,
        'avg_multiples': avg_multiples,
        'inputs': {
            'eps': eps_LY, 'sps': sps_LY, 'bvps': bvps_LY,
            'roe_annual': round(roe_ann, 4) if roe_ann is not None else None,
            'roe_5y': round(roe_5y, 4) if roe_5y is not None else None,
            'eps_growth_annual': round(eps_g_ann, 4) if eps_g_ann is not None else None,
            'eps_growth_5y': round(eps_g_5y, 4) if eps_g_5y is not None else None,
            'sps_growth_annual': round(sps_g_ann, 4) if sps_g_ann is not None else None,
            'sps_growth_5y': round(sps_g_5y, 4) if sps_g_5y is not None else None,
            'dpr': round(dpr, 4) if dpr is not None else None,
            'data_years': data_years,
            'fallback_used': fallback_used,
        },
        'submodels': {'pbv': m_pbv, 'per': m_per, 'psr': m_psr},
        'future_value': round(future_value, 4),
        'cagr': round(cagr_blend, 4),
        'combine': round(combine, 4),
        'dividend_yield': round(div_yield, 4),
        'margin_of_safety': round(mos_blend, 4) if mos_blend is not None else None,
        'price_targets': price_targets,
        'target_price_5y': price_targets[-1]['target_price'],
        'potential_pct': price_targets[-1]['gl_pct'],
        'override_applied': override_meta,
        'data_years': data_years,
        'fallback_used': fallback_used,
    }


def load_data_json():
    """Ambil beta, stock_info, harga live, & lookup history bulanan per kode saham."""
    try:
        d = json.load(open(DATA_JSON, encoding='utf-8'))
        stats = d.get('stats', {})
        betas = {c: s.get('beta') for c, s in stats.items()}
        live = {c: (v or {}).get('price') for c, v in d.get('live', {}).items()}
        return betas, d.get('stock_info', {}), live, build_hist_monthly(d)
    except Exception as e:
        print(f'[build-valuation] data.json tidak terbaca ({e}) → default dipakai', file=sys.stderr)
        return {}, {}, {}, {}


def build_hist_monthly(d):
    """Lookup {TICKER: {(year, month): close}} dari price_history (semua bulan)."""
    out = {}
    for e in (d.get('price_history') or []):
        m = re.match(r'(\d{4})-(\d{2})', str(e.get('date') or ''))   # "YYYY-MM-01"
        if not m:
            continue
        y, mon = int(m.group(1)), int(m.group(2))
        for k, v in e.items():
            if k in ('date', 'label') or v is None:
                continue
            out.setdefault(str(k).strip().upper(), {})[(y, mon)] = v
    return out


def hist_close_at(monthly, ticker, year, month):
    """Close pada (year, month). Bila kosong/null, mundur ke bulan sebelumnya di
    tahun yang sama. None bila tidak ada sama sekali di tahun itu."""
    mp = monthly.get(ticker)
    if not mp:
        return None
    for mo in range(month, 0, -1):
        v = mp.get((year, mo))
        if v is not None:
            return v
    return None


def load_yearly_close():
    """Fallback Yahoo year-end (public/history-yearly.json) → {TICKER: {year:int: close}}.
    Untuk mengisi harga tahunan <2016 yang tidak ada di price_history."""
    try:
        d = json.load(open(YEARLY_FILE, encoding='utf-8'))
        out = {}
        for tk, ymap in (d.get('closes') or {}).items():
            row = {}
            for y, v in (ymap or {}).items():
                try:
                    if v is not None:
                        row[int(y)] = v
                except (TypeError, ValueError):
                    continue
            if row:
                out[str(tk).strip().upper()] = row
        return out
    except FileNotFoundError:
        return {}
    except Exception as e:
        print(f'[build-valuation] history-yearly.json tidak terbaca ({e}) → fallback Yahoo dilewati', file=sys.stderr)
        return {}


def fill_holiday_prices(stock, monthly, live_price=None, yearly=None):
    """Perbaiki data yang hilang karena harga = 'Libur'/'#VALUE!' (hari bursa libur).

    - TAHUNAN (I..Z): isi `price` kosong dari history close tahun itu (Des/terakhir).
    - KUARTAL (D=Q1..G=Q4): HANYA bila sel harga = 'Libur' (ada data, bukan kosong) →
      isi dari history close bulan tutup kuartal (3/6/9/12) tahun BERJALAN.
      Sel kosong = belum ada laporan kuartal → dilewati.
    - TAHUN BERJALAN (H/annualized): isi `price` kosong dari HARGA LIVE (sheet live).
    - Selalu recompute market_cap = price×shares & rasio (pbv/per/psr) yang kosong.

    HANYA mengisi nilai KOSONG (None) — tidak pernah menimpa angka asli Excel.
    Mengembalikan (n_price, n_market_cap, n_ratio).
    """
    def recompute(fields, price):
        nmc = nrt = 0
        if fields.get('market_cap') is None:
            sh = fields.get('shares')
            if sh is not None and sh > 0:
                fields['market_cap'] = price * sh; nmc += 1
        if fields.get('pbv') is None and fields.get('bvps') not in (None, 0):
            fields['pbv'] = round(price / fields['bvps'], 4); nrt += 1
        if fields.get('per') is None and fields.get('eps') not in (None, 0):
            fields['per'] = round(price / fields['eps'], 4); nrt += 1
        if fields.get('psr') is None and fields.get('sps') not in (None, 0):
            fields['psr'] = round(price / fields['sps'], 4); nrt += 1
        return nmc, nrt

    code = stock.get('code')
    n_price = n_mc = n_ratio = 0
    filled = []

    # 1) TAHUNAN (I..Z) — harga kosong → history close tahun itu.
    for year, fields in stock.get('annual', {}).items():
        try:
            y = int(year)
        except (TypeError, ValueError):
            continue
        if fields.get('price') is None:
            v = hist_close_at(monthly, code, y, 12)
            if v is None and yearly:                      # fallback Yahoo year-end (<2016)
                v = yearly.get(code, {}).get(y)
            if v is not None:
                fields['price'] = v; n_price += 1; filled.append(year)
        price = fields.get('price')
        if price is not None and price > 0:
            mc, rt = recompute(fields, price); n_mc += mc; n_ratio += rt

    # 2) KUARTAL (D..G) — hanya yang sel-nya 'Libur' (ada data). Pakai history bulan
    #    tutup kuartal (3/6/9/12) tahun berjalan = (tahun annual terbaru + 1).
    running = (max(int(y) for y in stock['annual']) + 1) if stock.get('annual') else None
    libur = stock.get('q_price_libur', {})
    for qn, fields in (stock.get('quarters') or {}).items():
        if fields.get('price') is None and libur.get(qn) and running is not None:
            v = hist_close_at(monthly, code, running, QUARTER_MONTH[qn])
            if v is not None:
                fields['price'] = v; n_price += 1; filled.append(f'{running}-{qn}')
        price = fields.get('price')
        if price is not None and price > 0:
            mc, rt = recompute(fields, price); n_mc += mc; n_ratio += rt

    # 3) TAHUN BERJALAN (H/annualized) — harga kosong → LIVE.
    ann = stock.get('annualized')
    if ann is not None:
        if ann.get('price') is None and live_price and live_price > 0:
            ann['price'] = live_price; n_price += 1
        price = ann.get('price')
        if price is not None and price > 0:
            mc, rt = recompute(ann, price); n_mc += mc; n_ratio += rt

    if n_price or n_mc or n_ratio:
        stock['holiday_fill'] = {
            'price': n_price, 'market_cap': n_mc, 'ratio': n_ratio,
            'filled': sorted(filled, reverse=True),
            'source': 'tahunan & kuartal: price_history (per bulan); tahun berjalan: live',
        }
    stock.pop('q_price_libur', None)   # flag transien, jangan ikut ke JSON output
    # Buang kuartal Q2/Q3/Q4 yang SEMUA kosong (belum ada laporan) → hemat ukuran.
    q = stock.get('quarters') or {}
    for qn in ('Q2', 'Q3', 'Q4'):
        if qn in q and all(v is None for v in q[qn].values()):
            del q[qn]
    return n_price, n_mc, n_ratio


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


def _is_empty_stock(data):
    """True bila saham tidak punya satupun harga/pendapatan/laba bernilai (semua
    0/None) — indikasi file Excel belum terhitung (rumus cached 0). Dilewati agar
    tidak muncul sebagai 'Rp 0' di UI."""
    vals = []
    q1 = data.get('q1') or {}
    vals += [q1.get('price'), q1.get('total_revenue')]
    for yd in (data.get('annual') or {}).values():
        vals += [yd.get('price'), yd.get('total_revenue'), yd.get('net_income')]
    return all(v is None or v == 0 for v in vals)


def _shrink_floats(o, nd=6):
    """Bersihkan 'ekor' float (mis. 7.000000000000001 → 7) & bulatkan ke nd desimal,
    rekursif. Float yang bernilai bulat → int. Mengecilkan ukuran JSON signifikan
    tanpa mengubah angka secara berarti."""
    if isinstance(o, bool):
        return o
    if isinstance(o, float):
        if o != o or o in (float('inf'), float('-inf')):
            return None
        r = round(o, nd)
        return int(r) if r == int(r) else r
    if isinstance(o, dict):
        return {k: _shrink_floats(v, nd) for k, v in o.items()}
    if isinstance(o, list):
        return [_shrink_floats(v, nd) for v in o]
    return o


# ════════════════════════════ MAIN ══════════════════════════════════════════
def main():
    files = sorted(glob.glob(os.path.join(SRC_DIR, '*.xlsx')))
    files = [f for f in files if not os.path.basename(f).startswith('~$')]
    if not files:
        print(f'[build-valuation] Tidak ada file .xlsx di {SRC_DIR}', file=sys.stderr)

    betas, stock_info, live_prices, hist_monthly = load_data_json()
    overrides = load_overrides()
    yearly_close = load_yearly_close()
    stocks, warnings, source_files = {}, [], []
    fill_totals = {'price': 0, 'market_cap': 0, 'ratio': 0}
    empty_stocks = []

    for path in files:
        source_files.append(os.path.basename(path))
        try:
            sheets, read_sheet = read_workbook(path)
        except Exception as e:
            warnings.append(f"File {os.path.basename(path)}: gagal dibaca ({type(e).__name__}: {e}) — dilewati")
            continue
        for name, rid in sheets:
            try:
                data = parse_sheet(name, read_sheet(rid))
            except Exception as e:
                warnings.append(f"Sheet '{name}' di {os.path.basename(path)}: parse gagal "
                                f"({type(e).__name__}: {e}) — dilewati")
                continue
            code = data.get('code') or name
            # Lewati saham yang SEMUA datanya 0/kosong (Excel belum terhitung —
            # rumus cached 0). Tidak ditampilkan sbg 'Rp 0'; tunggu re-upload.
            if _is_empty_stock(data):
                empty_stocks.append(code)
                continue
            # Perbaiki harga 'Libur' (hari bursa libur) + recompute market_cap/rasio
            # dari price_history. Hanya mengisi yang kosong; berlaku semua data.
            try:
                hp = fill_holiday_prices(data, hist_monthly, live_prices.get(code), yearly_close)
                fill_totals['price'] += hp[0]; fill_totals['market_cap'] += hp[1]; fill_totals['ratio'] += hp[2]
            except Exception as e:
                warnings.append(f"{code}: gagal isi harga libur ({type(e).__name__}: {e})")
            # ── BASIS TTM RIIL (arus periode berjalan) dari section "Key Stats" Excel:
            #    EPS/Net Income/Revenue - TTM (Q1) + Return on Equity (TTM). Lebih bijak
            #    dari run-rate ×4 → cerminan 12 bulan terakhir nyata, basis laba pemilik.
            #    Fallback ke run-rate (laba/saham) bila TTM tak tersedia (mis. emiten IPO baru).
            _ann = data.get('annualized') or {}
            _ttm = data.get('ttm') or {}
            _sh  = _ann.get('shares')
            if _ttm.get('net_income') is not None:
                _ann['net_income'] = _ttm['net_income']
            if _ttm.get('total_revenue') is not None:
                _ann['total_revenue'] = _ttm['total_revenue']
                if _sh not in (None, 0):
                    _ann['sps'] = round(_ttm['total_revenue'] / _sh, 6)
            if _ttm.get('eps') is not None:
                _ann['eps'] = _ttm['eps']                          # EPS-TTM (laba pemilik)
            elif _ann.get('net_income') is not None and _sh not in (None, 0):
                _ann['eps'] = round(_ann['net_income'] / _sh, 2)   # fallback run-rate
            if _ttm.get('roe') is not None:
                _ann['roe'] = round(_ttm['roe'] * 100, 6)          # fraksi file → persen
            if data.get('code_in_sheet') and data['code_in_sheet'] != code:
                warnings.append(f"Sheet '{name}' di {os.path.basename(path)}: nama sheet != C1 "
                                f"('{code}' vs '{data['code_in_sheet']}')")
            if code in stocks:
                warnings.append(f"Kode '{code}' duplikat (di {os.path.basename(path)}), data lama ditimpa.")

            try:
                info = stock_info.get(code, {})
                financial = is_financial(info)
                # Harga realtime dari sheet/live data.json; fallback ke harga Excel (q1).
                last_price = live_prices.get(code) or data['q1'].get('price')
                price_is_live = bool(live_prices.get(code))

                warn = []
                try:
                    wacc_info = compute_wacc(data, betas.get(code), warn)
                except Exception as e:
                    warn.append(f"WACC error: {type(e).__name__}: {e}")
                    wacc_info = {'cost_of_equity': None, 'wacc': None, 'note': 'WACC gagal dihitung'}
                ke = wacc_info.get('cost_of_equity')
                try:
                    five = five_year_valuation(data, last_price, warn, override=overrides.get(code))
                except Exception as e:
                    warn.append(f"five_year error: {type(e).__name__}: {e}")
                    five = {'applicable': False, 'reason': f'Error build: {type(e).__name__}: {e}'}
                try:
                    dcf = dcf_valuation(data, wacc_info.get('wacc'), warn, financial=financial, last_price=last_price)
                except Exception as e:
                    warn.append(f"dcf error: {type(e).__name__}: {e}")
                    dcf = {'applicable': False, 'reason': f'Error build: {type(e).__name__}: {e}'}
                try:
                    ddm = ddm_valuation(data, ke, warn, last_price=last_price)
                except Exception as e:
                    warn.append(f"ddm error: {type(e).__name__}: {e}")
                    ddm = {'applicable': False, 'reason': f'Error build: {type(e).__name__}: {e}'}

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
            except Exception as e:
                warnings.append(f"Saham '{code}': error fatal saat build "
                                f"({type(e).__name__}: {e}) — dilewati, valuasi diset applicable:false")
                # Tetap simpan data minimum supaya saham masih kelihatan di UI
                # (search emiten, info dasar) walau model tidak applicable.
                if 'valuation' not in data:
                    data['valuation'] = {
                        'sector': stock_info.get(code, {}).get('sector'),
                        'industry': stock_info.get(code, {}).get('industry'),
                        'is_financial': False,
                        'last_price': data.get('q1', {}).get('price'),
                        'price_source': 'excel',
                        'five_year': {'applicable': False, 'reason': f'Build error: {type(e).__name__}: {e}'},
                        'wacc': {'wacc': None, 'cost_of_equity': None},
                        'dcf':  {'applicable': False, 'reason': 'Build error'},
                        'ddm':  {'applicable': False, 'reason': 'Build error'},
                        'notes': [f'Build error: {type(e).__name__}: {e}'],
                    }
                stocks[code] = data

    note = ("Basis 'tahun berjalan' = TTM RIIL (12 bulan terakhir) dari section Key Stats Excel: "
            "EPS/Net Income/Revenue - TTM (Q1) + Return on Equity (TTM); fallback run-rate (Q1x4) "
            "bila TTM tak tersedia (emiten baru). EPS growth 5th = CAGR EPS_TTM->tahun ke-5. "
            "Avg PBV/PER/PSR = nilai TTM + n tahun annual. ROE/SPS 5th & DPR dari kolom H. "
            "Growth 5 th DCF masih PLACEHOLDER. risk_free sementara konstan (akan dari sheet 'SBN').")

    if fill_totals['price'] or fill_totals['market_cap'] or fill_totals['ratio']:
        warnings.append(
            f"Holiday-fill: {fill_totals['price']} harga + {fill_totals['market_cap']} market_cap + "
            f"{fill_totals['ratio']} rasio diisi/dihitung ulang dari price_history.")
    if empty_stocks:
        warnings.append(
            f"{len(empty_stocks)} saham DILEWATI (semua data 0/kosong — Excel belum terhitung): "
            + ', '.join(sorted(empty_stocks)[:30]) + (' ...' if len(empty_stocks) > 30 else ''))

    # ── SPLIT OUTPUT: index ringan + 1 file per saham (lazy-load) ──────────────
    # Frontend memuat index.json (kecil) utk daftar/search, lalu file <CODE>.json
    # hanya saat saham dibuka. Skalabel utk ratusan-ribuan saham.
    os.makedirs(OUT_DIR, exist_ok=True)

    index_stocks = []
    for code in sorted(stocks.keys()):
        s = stocks[code]
        v = s.get('valuation') or {}
        fy = v.get('five_year') or {}
        index_stocks.append({
            'code': code,
            'name': (stock_info.get(code, {}) or {}).get('name') or code,
            'sector': v.get('sector'),
            'applicable': bool(fy.get('applicable')),
            'potential_pct': fy.get('potential_pct'),
            'last_price': v.get('last_price'),
        })

    index_payload = {
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'source_files': source_files,
        'count': len(stocks),
        'assumptions': ASSUMPTIONS,
        'note': note,
        'warnings': warnings,
        'stocks': index_stocks,
    }
    with open(os.path.join(OUT_DIR, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(_shrink_floats(index_payload), f, ensure_ascii=False, separators=(',', ':'))

    # Tulis 1 file per saham.
    for code in stocks:
        with open(os.path.join(OUT_DIR, code + '.json'), 'w', encoding='utf-8') as f:
            json.dump(_shrink_floats(stocks[code]), f, ensure_ascii=False, separators=(',', ':'))

    # File dividen agregat (kecil) — dipakai halaman Simulasi yang butuh dps
    # SEMUA saham sekaligus (tidak cocok lazy per-saham).
    dividends = {}
    for code in stocks:
        annual = (stocks[code] or {}).get('annual') or {}
        by_year = {}
        latest_dps, latest_yr = None, -1
        for yr, yd in annual.items():
            d = (yd or {}).get('dps')
            if isinstance(d, (int, float)):
                by_year[yr] = d
                try:
                    y = int(yr)
                    if y > latest_yr:
                        latest_yr, latest_dps = y, d
                except (TypeError, ValueError):
                    pass
        if by_year:
            dividends[code] = {'byYear': by_year, 'latestDps': latest_dps}
    with open(os.path.join(OUT_DIR, 'dividends.json'), 'w', encoding='utf-8') as f:
        json.dump(_shrink_floats({'generated_at': index_payload['generated_at'], 'stocks': dividends}),
                  f, ensure_ascii=False, separators=(',', ':'))

    # Bersihkan file per-saham basi (kode yang sudah tidak ada → mis. file dihapus/diganti).
    keep = set(code + '.json' for code in stocks) | {'index.json', 'dividends.json'}
    removed = 0
    for fn in os.listdir(OUT_DIR):
        if fn.endswith('.json') and fn not in keep:
            try: os.remove(os.path.join(OUT_DIR, fn)); removed += 1
            except OSError: pass

    # Monolith lama tidak dipakai lagi → hapus bila ada (hemat ukuran deploy).
    if os.path.exists(OUT_FILE):
        try: os.remove(OUT_FILE)
        except OSError: pass

    print(f"[build-valuation] {len(stocks)} saham (split) -> {OUT_DIR}/ "
          f"(index.json + {len(stocks)} file; {removed} basi dihapus)")
    if empty_stocks:
        print(f"[build-valuation] {len(empty_stocks)} saham dilewati (data 0/kosong).")
    if warnings:
        print('[build-valuation] WARNINGS:')
        for w in warnings:
            print('  - ' + w)


if __name__ == '__main__':
    main()
