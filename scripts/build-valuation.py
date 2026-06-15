#!/usr/bin/env python3
"""
build-valuation.py — Fondasi data valuasi (Fase 1).

Baca SEMUA file .xlsx di data/valuation/ (tiap sheet = 1 kode saham),
ekstrak seri laporan keuangan dari range A1:Z40 dengan layout tetap,
lalu tulis public/valuation.json sebagai "kontrak data" untuk model
DCF / DDM / proyeksi 5 tahun nanti.

Tanpa dependency eksternal: .xlsx dibaca langsung (zip + XML stdlib),
jadi script ini jalan di mana saja (lokal & GitHub Actions) tanpa npm/pip install.
"""

import os, sys, glob, json, zipfile, re, datetime
import xml.etree.ElementTree as ET

NS  = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, 'data', 'valuation')
OUT_FILE = os.path.join(ROOT, 'public', 'valuation.json')

# ── Peta baris → nama field (layout tetap, sama di semua sheet) ──────────────
# Kolom: D = Q1 (kuartal terakhir), H = "tahun berjalan" (lihat catatan di README),
#        I..Z = data tahunan (label diambil dari baris 18: "12M 2025" dst).
ROW_METRICS = {
    2:  'price',                 # harga (D=terkini, I.. = harga akhir tahun)
    4:  'total_revenue',         # Total Pendapatan
    5:  'net_income',            # Laba bersih (pemilik entitas induk)
    6:  'total_equity',          # Total Ekuitas
    7:  'shares_bn',             # Share outstanding (miliar lembar)
    8:  'fcf',                   # Free cash flow
    9:  'fcf_per_share',
    10: 'p_fcf',                 # Price to Free Cash Flow
    11: 'cash',                  # Kas & setara kas
    12: 'net_debt',
    13: 'total_debt',
    14: 'interest_expense',      # Beban Keuangan (untuk cost of debt)
    15: 'tax_expense',           # Beban Pajak Penghasilan
    16: 'pretax_income',         # Laba Sebelum Pajak (untuk tax rate efektif)
    20: 'market_cap',
    21: 'shares',                # Share outstanding (jumlah penuh)
    23: 'roe',
    24: 'roe_5y',
    25: 'eps',
    26: 'eps_growth_5y',
    27: 'sps',
    28: 'sps_growth_5y',
    32: 'bvps',                  # Book value per share
    33: 'pbv',
    34: 'per',
    35: 'psr',
    36: 'dpr',                   # Dividend payout ratio
    37: 'dps',                   # Dividend per share
}

LABEL_ROW = 18   # baris yang berisi label periode (Q1 / tahun Berjalan / 12M YYYY)
BAD_STRINGS = {'#value!', '#n/a', '#div/0!', '#ref!', 'libur', '', 'n/a', '-'}


def col_to_idx(col):
    idx = 0
    for c in col:
        idx = idx * 26 + (ord(c) - 64)
    return idx


def to_number(val):
    """Konversi ke float bila numerik; selain itu None. Aman utk error Excel & 'Libur'."""
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
    """'12M 2025' -> '2025'. 'Q1'/'tahun Berjalan' dikembalikan apa adanya."""
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
    """Ekstrak satu saham dari grid sel mentah."""
    # Label periode per kolom dari baris 18
    col_period = {}
    for col in range(9, 27):  # I..Z
        col_period[col] = clean_period_label(grid.get((LABEL_ROW, col)))

    q1 = {}
    annualized = {}
    annual = {}  # { '2025': {field: val}, ... }

    for row, field in ROW_METRICS.items():
        q1[field] = to_number(grid.get((row, 4)))            # kolom D
        annualized[field] = to_number(grid.get((row, 8)))    # kolom H
        for col in range(9, 27):                             # I..Z
            period = col_period.get(col)
            if not period or not re.match(r'^\d{4}$', period):
                continue
            annual.setdefault(period, {})[field] = to_number(grid.get((row, col)))

    code_in_sheet = grid.get((1, 3))  # C1
    return {
        'code': name.strip().upper(),
        'code_in_sheet': (str(code_in_sheet).strip().upper() if code_in_sheet else None),
        'q1': q1,
        'annualized': annualized,   # CATATAN: ini Q1 x 4, BUKAN TTM (lihat README)
        'annual': annual,
    }


def main():
    files = sorted(glob.glob(os.path.join(SRC_DIR, '*.xlsx')))
    files = [f for f in files if not os.path.basename(f).startswith('~$')]  # skip lockfile Excel
    if not files:
        print(f'[build-valuation] Tidak ada file .xlsx di {SRC_DIR}', file=sys.stderr)

    stocks = {}
    warnings = []
    source_files = []

    for path in files:
        source_files.append(os.path.basename(path))
        sheets, read_sheet = read_workbook(path)
        for name, rid in sheets:
            data = parse_sheet(name, read_sheet(rid))
            code = data['code']
            if data['code_in_sheet'] and data['code_in_sheet'] != code:
                warnings.append(
                    f"Sheet '{name}' di {os.path.basename(path)}: nama sheet != C1 "
                    f"('{code}' vs '{data['code_in_sheet']}')")
            if code in stocks:
                warnings.append(
                    f"Kode '{code}' duplikat (muncul lagi di {os.path.basename(path)}), data lama ditimpa.")
            stocks[code] = data

    out = {
        'generated_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'source_files': source_files,
        'count': len(stocks),
        'note': ("Kolom 'annualized' = nilai 'tahun berjalan' dari sheet = Q1 x 4 "
                 "(run-rate, BUKAN TTM). 'annual' di-key per tahun (12M YYYY)."),
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
