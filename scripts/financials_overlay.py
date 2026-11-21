#!/usr/bin/env python3
"""
financials_overlay.py — sambungkan laporan keuangan baru dari R2 ke data Excel (valuation-uploader).

Sumber:
  - Excel di data/valuation/ = DATA DASAR (laporan pertama s/d periode terakhir yang Anda upload). Selalu menang.
  - data/financials-r2/<KODE>/<periode>.json = hasil scraper web Pantau (diunduh scripts/fetch-financials-r2.py),
    isinya data mentah yang sama dengan sheet Excel baris 51+ (Income Statement, Balance Sheet, Cash Flow, Key Ratio,
    Key Stats; label sama persis).

Cara kerja = meniru rumus baris 1-40 sheet Anda (INDEX/MATCH label di kolom C, atau kolom A untuk kuartal):
  - Label tiap baris diambil dari sheet saham itu sendiri (kolom A/C), jadi label yang Anda ubah per saham ikut dipakai.
  - Kolom kuartal (D..G) = kuartal TAHUN BERJALAN, terbaru di D (sama seperti Excel sekarang). Contoh Q3 2026:
    D = Q3 2026, E = Q2 2026, F = Q1 2026, G kosong. Kuartal yang sudah ada di Excel memakai angka Excel (digeser kolomnya).
  - Harga kuartal = closing bulan tutup kuartal (Q1 Mar, Q2 Jun, Q3 Sep, Q4 Des) dari price_history.
    Harga tahunan = closing Desember (diisi fill_holiday_prices seperti biasa).
  - Tahun berjalan (H) dihitung ulang dengan rumus Excel: arus (pendapatan, laba, beban, pajak) = jumlah × 4 / jumlah kuartal;
    posisi (ekuitas, saham, kas, utang, rasio) = INDEX(D:G, COUNT).
  - Tahun baru (mis. FY 2026) yang belum ada di Excel ditambahkan ke data tahunan.
  - TTM (Key Stats & Σ 4 kuartal) diperbarui bila R2 punya kuartal yang lebih baru dari Excel.
"""

import glob, json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
R2_DIR = os.path.join(ROOT, 'data', 'financials-r2')

SECTIONS = ['Income Statement', 'Balance Sheet', 'Cash Flow', 'Key Ratio']
QMONTH = {1: 3, 2: 6, 3: 9, 4: 12}
Q_RE = re.compile(r'Q\s*([1-4])\D{0,3}(\d{4})', re.I)

# baris → (field, cara). 'C' = label kolom C; 'A' = kolom kuartal memakai label kolom A (lihat rumus Excel).
DIRECT = {
    4: ('total_revenue', 'C'), 5: ('net_income', 'C'), 6: ('total_equity', 'C'), 7: ('shares_bn', 'C'),
    8: ('fcf', 'A'), 9: ('fcf_per_share', 'A'), 11: ('cash', 'C'), 12: ('net_debt', 'A'), 13: ('total_debt', 'A'),
    14: ('interest_expense', 'C'), 15: ('tax_expense', 'C'), 16: ('pretax_income', 'C'), 25: ('eps', 'A'),
    32: ('bvps', 'A'), 33: ('pbv', 'A'), 34: ('per', 'A'), 35: ('psr', 'A'), 36: ('dpr', 'C'), 37: ('dps', 'C'),
}
FLOW = ('total_revenue', 'net_income', 'interest_expense', 'tax_expense', 'pretax_income')     # H = SUM × 4 / COUNT
DEFAULT_LABELS = {4: 'Total Pendapatan', 5: 'Pemilik Entitas Induk', 6: 'Total Ekuitas', 7: 'Share Outstanding',
                  11: 'Kas Dan Setara Kas', 14: 'Beban Keuangan', 15: 'Beban Pajak Penghasilan', 16: 'Laba Sebelum Pajak',
                  36: 'Net Income - Payout Ratio', 37: 'EPS - Div (TTM)'}
DEFAULT_A = {8: 'Free cash flow (Quarter)', 9: 'Free cash flow per share (Quarter)', 12: 'Net Debt (Quarter)',
             13: 'Total Debt (Quarter)', 25: 'EPS', 32: 'Book Value Per Share (quarter)', 33: 'Price to Book Value (quarter)',
             34: 'PE Ratio (quarter)', 35: 'Price to Sales (Quarter)'}
DEFAULT_C_ANNUAL = {8: 'Free cash flow (Annual)', 9: 'Free cash flow per share (Annual)', 12: 'Net Debt (Annual)',
                    13: 'Total Debt (Annual)', 25: 'EPS (Annual)', 32: 'Book Value Per Share (Annual)',
                    33: 'Price to Book Value (Annual)', 34: 'PE Ratio (Annual)', 35: 'Price to Sales (Annual)'}
EMPTY = {'', '-', '--', 'n/a', 'na', 'n.a', 'n.a.', 'nan', 'none', 'null', '–', '—', '.'}
SUF = {'K': 1e3, 'M': 1e6, 'B': 1e9, 'T': 1e12}


def num(v):
    """Angka gaya Stockbit / Excel → float. '7,870 B' → 7.87e12, '(50,799 B)' → -5.0799e13, '0.96%' → 0.0096 (persen
    disimpan sebagai pecahan, sama seperti sel persen di Excel). Kosong / teks → None."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s.lower() in EMPTY:
        return None
    neg = '(' in s and ')' in s
    s = s.replace('(', '').replace(')', '').replace(',', '').strip()
    if s.startswith('-'):
        neg, s = True, s[1:].strip()
    pct = s.endswith('%')
    if pct:
        s = s[:-1].strip()
    mult = 1.0
    if s[-1:].upper() in SUF and re.search(r'\d', s[:-1]):
        mult, s = SUF[s[-1].upper()], s[:-1].strip()
    try:
        x = float(s) * mult
    except ValueError:
        return None
    if pct:
        x /= 100.0
    return -x if neg else x


def rri(n, pv, fv):
    """Excel RRI(n, pv, fv) = (fv/pv)^(1/n) − 1; error (pv 0 / tanda beda) → None (IFERROR → "")."""
    if pv in (None, 0) or fv is None:
        return None
    r = fv / pv
    if r < 0:
        return None
    return r ** (1.0 / n) - 1


def qkey(label):
    m = Q_RE.search(str(label or '').upper())
    return (int(m.group(2)), int(m.group(1))) if m else None


def ykey(label):
    s = str(label or '')
    if Q_RE.search(s.upper()):
        return None
    m = re.search(r'(\d{4})', s)
    return int(m.group(1)) if m else None


def load_docs(r2_dir=R2_DIR):
    """{KODE: [doc, ...]} dari data/financials-r2/<KODE>/<periode>.json (tidak ada folder = {})."""
    out = {}
    for p in glob.glob(os.path.join(r2_dir, '*', '*.json')):
        try:
            d = json.load(open(p, encoding='utf-8'))
        except Exception:
            continue
        code = str(d.get('symbol') or os.path.basename(os.path.dirname(p))).upper()
        if isinstance(d.get('data'), dict):
            out.setdefault(code, []).append(d)
    return out


class Source:
    """Gabungan semua file R2 satu saham (yang di-scrape belakangan menimpa). Pencarian label TIDAK peka huruf besar/kecil,
    baris pertama yang cocok dipakai (sama seperti MATCH di Excel), urut: Income, Balance, Cash Flow, Key Ratio, Key Stats."""

    def __init__(self, docs):
        self.rows = []          # [(label_lower, {'q': {(y,q): v}, 'a': {y: v}})]
        idx = {}
        self.ks = {}            # label_lower -> rec keystats
        self.ks_q_latest = None
        self.latest_q = None
        self.latest_fy = None
        for d in sorted(docs, key=lambda x: str(x.get('scraped') or '')):
            data = d['data']
            for sec in SECTIONS:
                st = (data.get('store') or {}).get(sec) or {}
                for lab in st.get('order') or []:
                    m = (st.get('metrics') or {}).get(lab) or {}
                    key = (sec, lab.strip().lower())
                    if key not in idx:
                        idx[key] = {'q': {}, 'a': {}}
                        self.rows.append((sec, lab.strip().lower(), idx[key]))
                    for p, v in (m.get('Quarterly') or {}).items():
                        k = qkey(p)
                        if k and num(v) is not None:
                            idx[key]['q'][k] = num(v)
                    for p, v in (m.get('Annual') or {}).items():
                        k = ykey(p)
                        if k and num(v) is not None:
                            idx[key]['a'][k] = num(v)
            qs = [qkey(p) for p in data.get('quarter_periods') or []]
            qs = [k for k in qs if k]
            lq = max(qs) if qs else None
            ks = data.get('keystats') or {}
            if ks.get('order'):
                self.ks = {lab.strip().lower(): (ks.get('rows') or {}).get(lab) or {} for lab in ks['order']}
                self.ks_q_latest = lq
            if lq and (self.latest_q is None or lq > self.latest_q):
                self.latest_q = lq
            ys = [ykey(p) for p in data.get('annual_periods') or []]
            ys = [y for y in ys if y]
            if ys and (self.latest_fy is None or max(ys) > self.latest_fy):
                self.latest_fy = max(ys)
        order = {s: i for i, s in enumerate(SECTIONS)}
        self.rows.sort(key=lambda r: order[r[0]])        # urutan bagian seperti di sheet (stabil per bagian)

    def _find(self, label):
        lab = str(label or '').strip().lower()
        return [r[2] for r in self.rows if r[1] == lab] if lab else []

    def q(self, label, k):
        for r in self._find(label):
            if k in r['q']:
                return r['q'][k]
        ks = self.ks.get(str(label or '').strip().lower())
        if ks and self.ks_q_latest:
            if ks.get('quarter_series'):                  # deret 4 kuartal terbaru (terbaru dulu)
                y, qn = self.ks_q_latest
                for v in ks['quarter_series']:
                    if (y, qn) == k:
                        return num(v)
                    y, qn = (y, qn - 1) if qn > 1 else (y - 1, 4)
            if ks.get('d_value') is not None and k == self.ks_q_latest:
                return num(ks['d_value'])
        return None

    def a(self, label, y):
        for r in self._find(label):
            if y in r['a']:
                return r['a'][y]
        ks = self.ks.get(str(label or '').strip().lower())
        if ks:
            aby = ks.get('annual_by_year') or {}
            if str(y) in aby:
                return num(aby[str(y)])
            if ks.get('i_value') is not None and y == self.latest_fy:
                return num(ks['i_value'])
        return None

    def ks_year(self, label):
        """Nilai Key Stats tahun berjalan (kolom H): tahun terbaru di deret, atau nilai tunggal."""
        ks = self.ks.get(str(label or '').strip().lower())
        if not ks:
            return None
        aby = ks.get('annual_by_year') or {}
        if aby:
            return num(aby[max(aby, key=lambda x: int(x) if str(x).isdigit() else 0)])
        return num(ks.get('i_value') if ks.get('i_value') is not None else ks.get('d_value'))

    def sum4(self, *subs):
        """Σ 4 kuartal terbaru untuk baris pertama yang labelnya mengandung salah satu kata (TTM laporan keuangan)."""
        if not self.latest_q:
            return None
        y, qn = self.latest_q
        ks = []
        for _ in range(4):
            ks.append((y, qn))
            y, qn = (y, qn - 1) if qn > 1 else (y - 1, 4)
        for sec, lab, r in self.rows:
            if sec == 'Key Ratio':
                continue
            if any(s in lab for s in subs):
                vals = [r['q'].get(k) for k in ks]
                vals = [v for v in vals if v is not None]
                return sum(vals) if vals else None
        return None


def sheet_labels(grid):
    """Label kolom A / C baris 4..37 dari sheet saham itu (rumus INDEX/MATCH memakai label ini)."""
    a, c = {}, {}
    for row in DIRECT:
        cv = str(grid.get((row, 3)) or '').strip()
        av = str(grid.get((row, 1)) or '').strip()
        c[row] = cv or DEFAULT_LABELS.get(row) or DEFAULT_C_ANNUAL.get(row) or ''
        a[row] = (av if DIRECT[row][1] == 'A' and av else '') or (DEFAULT_A.get(row) if DIRECT[row][1] == 'A' else '') or c[row]
    return a, c


def fields_for(src, a_lab, c_lab, kind, key):
    """Satu kolom (kuartal key=(y,q) atau tahun key=y) → field seperti ROW_METRICS, meniru rumus baris 4..37."""
    get = (lambda lab: src.q(lab, key)) if kind == 'q' else (lambda lab: src.a(lab, key))
    f = {}
    for row, (field, how) in DIRECT.items():
        lab = a_lab[row] if (kind == 'q' and how == 'A') else c_lab[row]
        f[field] = get(lab)
    sh_raw = get(c_lab[7])
    f['shares_bn'] = sh_raw / 1e9 if sh_raw is not None else None          # baris 7: /1.000.000.000
    f['shares'] = sh_raw                                                   # baris 21: lembar penuh
    f['roe'] = f['net_income'] / f['total_equity'] * 100 if (f['net_income'] is not None and f['total_equity']) else None
    f['sps'] = f['total_revenue'] / sh_raw if (f['total_revenue'] is not None and sh_raw) else None
    for k in ('price', 'p_fcf', 'market_cap', 'roe_5y', 'eps_growth_5y', 'sps_growth_5y'):
        f.setdefault(k, None)
    return f


def _has(f):
    return any(f.get(k) is not None for k in ('total_revenue', 'net_income', 'total_equity', 'eps'))


def apply(stock, grid, docs, monthly, hist_close_at):
    """Sambungkan R2 ke `stock` (hasil parse_sheet). Mengembalikan ringkasan perubahan, atau None bila tidak ada yang baru."""
    if not docs:
        return None
    src = Source(docs)
    if not src.latest_q and not src.latest_fy:
        return None
    a_lab, c_lab = sheet_labels(grid)
    code = stock.get('code')
    annual = stock.setdefault('annual', {})
    note = {'quarters_from_r2': [], 'years_from_r2': [], 'ttm_updated': False}

    # ── tahunan baru (tidak pernah menimpa tahun yang sudah ada di Excel) ──
    years = sorted({y for _, _, r in src.rows for y in r['a']})
    for y in years:
        if str(y) in annual:
            continue
        f = fields_for(src, a_lab, c_lab, 'a', y)
        if not _has(f):
            continue
        annual[str(y)] = f
        note['years_from_r2'].append(str(y))
    # growth 5 th untuk tahun baru = RRI(5, nilai 5 th sebelumnya, nilai tahun itu)
    for ys in note['years_from_r2']:
        f, prev = annual[ys], annual.get(str(int(ys) - 5)) or {}
        f['roe_5y'] = rri(5, prev.get('roe'), f.get('roe'))
        f['eps_growth_5y'] = rri(5, prev.get('eps'), f.get('eps'))
        f['sps_growth_5y'] = rri(5, prev.get('sps'), f.get('sps'))

    # ── kuartal tahun berjalan ──
    base_latest = qkey((stock.get('ttm_is') or {}).get('q_latest'))
    hdr = {}                                               # periode asli tiap kolom Excel (baris header data mentah, mis. 'Q2 2026')
    for r in range(38, 72):
        if qkey(grid.get((r, 4))):
            for i, col in enumerate((4, 5, 6, 7)):
                k = qkey(grid.get((r, col)))
                if k:
                    hdr[k] = 'Q%d' % (i + 1)
            break
    if src.latest_q and (base_latest is None or src.latest_q > base_latest):
        y, latest_qn = src.latest_q
        old_q = stock.get('quarters') or {}
        new_q, libur = {}, {}
        for i, qn in enumerate(range(latest_qn, 0, -1)):   # terbaru di D (Q1 = kolom D)
            col = 'Q%d' % (i + 1)
            base_col = hdr.get((y, qn))
            if base_col and _has(old_q.get(base_col) or {}):
                f = dict(old_q[base_col])                    # angka laporan dari Excel tetap dipakai, hanya pindah kolom
                px = hist_close_at(monthly, code, y, QMONTH[qn])   # harga = closing bulan tutup kuartal itu
                if px is not None:
                    f['price'], f['market_cap'] = px, None   # market cap dihitung ulang dari harga ini
                    f['p_fcf'] = px / f['fcf_per_share'] if f.get('fcf_per_share') else None
                new_q[col] = f
            else:
                f = fields_for(src, a_lab, c_lab, 'q', (y, qn))
                if not _has(f):
                    continue
                f['price'] = hist_close_at(monthly, code, y, QMONTH[qn])   # closing Mar / Jun / Sep / Des
                if f['price'] is not None and f.get('fcf_per_share'):
                    f['p_fcf'] = f['price'] / f['fcf_per_share']
                ann_k = annual.get(str(y - 1 - i)) or {}          # rumus Excel: D↔I, E↔J, F↔K (kolom tahunan bergeser)
                f['roe_5y'] = rri(5, ann_k.get('roe'), f.get('roe'))
                f['eps_growth_5y'] = rri(5, ann_k.get('eps'), f.get('eps'))
                f['sps_growth_5y'] = rri(5, ann_k.get('sps'), f.get('sps'))
                new_q[col] = f
                note['quarters_from_r2'].append('Q%d %d' % (qn, y))
            libur[col] = False
        if new_q:
            stock['quarters'] = new_q
            stock['q1'] = new_q.get('Q1') or stock.get('q1')
            stock['q_price_libur'] = libur
            stock['q_label'] = 'Q%d' % latest_qn
            # tahun berjalan (H) = rumus Excel atas kolom D..G
            cols = [new_q[c] for c in ('Q1', 'Q2', 'Q3', 'Q4') if c in new_q]
            h = dict(stock.get('annualized') or {})
            for field in set(f for f, _ in DIRECT.values()) | {'shares', 'roe', 'sps'}:
                vals = [c.get(field) for c in cols if c.get(field) is not None]
                if field in FLOW:
                    h[field] = sum(vals) * (4 / max(1, len(vals))) if vals else None
                else:
                    h[field] = vals[-1] if vals else None    # INDEX(D:G, COUNT)
            h['roe'] = h['net_income'] / h['total_equity'] * 100 if (h.get('net_income') is not None and h.get('total_equity')) else None
            h['sps'] = h['total_revenue'] / h['shares'] if (h.get('total_revenue') is not None and h.get('shares')) else None
            h['dpr'] = src.ks_year(c_lab[36]) if src.ks_year(c_lab[36]) is not None else h.get('dpr')
            h['dps'] = src.ks_year(c_lab[37]) if src.ks_year(c_lab[37]) is not None else h.get('dps')
            m5 = annual.get(str(y - 5)) or {}                # rumus Excel H: RRI(5, M, H)
            h['roe_5y'] = rri(5, m5.get('roe'), h.get('roe'))
            h['eps_growth_5y'] = rri(5, m5.get('eps'), h.get('eps'))
            h['sps_growth_5y'] = rri(5, m5.get('sps'), h.get('sps'))
            h['price'] = None                                # tahun berjalan: harga live (fill_holiday_prices)
            h['market_cap'] = h['p_fcf'] = None
            stock['annualized'] = h

        # ── TTM (Key Stats + Σ 4 kuartal) ──
        ttm = dict(stock.get('ttm') or {})
        lq_txt = 'Q%d' % src.latest_q[1]
        for field, labels in (('eps', ['EPS - TTM (Q1)', 'EPS - TTM (%s)' % lq_txt, 'Current EPS (TTM)']),
                              ('net_income', ['Net Income - TTM (Q1)', 'Net Income - TTM (%s)' % lq_txt, 'Net Income (TTM)']),
                              ('total_revenue', ['Revenue - TTM (Q1)', 'Revenue - TTM (%s)' % lq_txt, 'Revenue (TTM)']),
                              ('roe', ['Return on Equity (TTM)'])):
            for lab in labels:
                v = src.ks_year(lab)
                if v is not None and v != 0:
                    ttm[field] = v
                    break
        stock['ttm'] = ttm
        stock['ttm_is'] = {
            'q_latest': 'Q%d %d' % (src.latest_q[1], src.latest_q[0]),
            'revenue': src.sum4('total pendapatan'),
            'ni_parent': src.sum4('pemilik entitas induk'),
            'ni_total': src.sum4('laba bersih tahun berjalan', 'total laba bersih yang dapat'),
        }
        note['ttm_updated'] = True

    if not (note['quarters_from_r2'] or note['years_from_r2'] or note['ttm_updated']):
        return None
    note['latest'] = 'Q%d %d' % src.latest_q[::-1] if src.latest_q else None
    stock['r2_overlay'] = note
    return note
