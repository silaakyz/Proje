"""
Converts TÜİK's 2023 supply-use / input-output tables (A64, CPA Rev. 2.1, current prices, thousand TRY) into
src/lib/io/data/tuik-2023.json for the input-output engine (src/lib/io/engine.ts).

    python3 scripts/io/import-tuik-2023.py "tüik veri"        (needs: pip install xlrd)

Read, unchanged (only reshaped):
  Yurtiçi Üretim Girdi-Çıktı Tablosu (T9)      domestic product × product intermediate use Z, output P.1, GVA B1.g, compensation D.1
  Kullanım Tablosu, alıcı fiyatlarıyla (T2)    household final consumption at purchasers' prices, per product
  Kullanım Tablosu, temel fiyatlarla (T5)      household final consumption at basic prices
  Yurtiçi Kullanım Tablosu, temel fiyatlarla (T6)  household final consumption of domestic output at basic prices
  Ticaret ve Ulaştırma Marjları (T4)           household column: margins on each product (negative on margin products)
  Ürün Üzerindeki Vergi Eksi Sübvansiyonlar (T7)  household column: net product taxes
The script checks the valuation identity purchasers = basic + margins + taxes per product before writing.
"""
import glob, json, os, sys
import xlrd

folder = sys.argv[1] if len(sys.argv) > 1 else "tüik veri"
out = sys.argv[2] if len(sys.argv) > 2 else "src/lib/io/data/tuik-2023.json"

def sheet(prefix):
    files = [f for f in glob.glob(os.path.join(folder, "*.xls")) if os.path.basename(f).startswith(prefix)]
    if len(files) != 1:
        sys.exit(f"expected one file starting with {prefix!r}, found {files}")
    return xlrd.open_workbook(files[0]).sheet_by_index(0), os.path.basename(files[0])

FIRST, N = 9, 64          # product rows 9..72, product/industry columns 3..66
HH_COL = 68               # "Hanehalkının nihai tüketim harcaması"

def num(v):
    return float(v) if v not in ("", None) else 0.0

def row_by_code(s, code):
    for r in range(FIRST + N, s.nrows):
        if str(s.cell_value(r, 1)).strip() == code:
            return r
    sys.exit(f"row {code} not found in {s.name}")

io, io_file = sheet("Yurtiçi Üretim Girdi")
codes = [str(io.cell_value(FIRST + i, 1)).strip() for i in range(N)]
names = [str(io.cell_value(FIRST + i, 2)).split("\n")[0].strip() for i in range(N)]
assert [str(io.cell_value(7, 3 + j)).strip() for j in range(N)] == codes, "column codes differ from row codes"
Z = [[num(io.cell_value(FIRST + i, 3 + j)) for j in range(N)] for i in range(N)]
output = [num(io.cell_value(row_by_code(io, "P.1"), 3 + j)) for j in range(N)]
gva = [num(io.cell_value(row_by_code(io, "B1.g"), 3 + j)) for j in range(N)]
comp = [num(io.cell_value(row_by_code(io, "D.1"), 3 + j)) for j in range(N)]

def hh(prefix):
    s, f = sheet(prefix)
    got = [str(s.cell_value(FIRST + i, 1)).strip() for i in range(N)]
    assert got == codes, f"{f}: product codes differ"
    assert "Hanehalk" in str(s.cell_value(5, HH_COL)), f"{f}: column {HH_COL} is not household consumption"
    return [num(s.cell_value(FIRST + i, HH_COL)) for i in range(N)], f

hh_purch, f2 = hh("Kullanım Tablosu, 2023 (Alıcı")
hh_basic, f5 = hh("Kullanım Tablosu, 2023 (Temel")
hh_dom, f6 = hh("Yurtiçi Kullanım")
hh_margin, f4 = hh("Ticaret ve Ulaştırma")
hh_tax, f7 = hh("Ürün Üzerindeki Vergi")

for i in range(N):
    lhs, rhs = hh_purch[i], hh_basic[i] + hh_margin[i] + hh_tax[i]
    assert abs(lhs - rhs) <= max(1.0, 1e-6 * abs(lhs)), f"valuation identity fails for {codes[i]}: {lhs} vs {rhs}"

data = {
    "source": "TÜİK, Arz ve Kullanım Tabloları, Girdi-Çıktı Tabloları, 2023 (A64, CPA Rev. 2.1, cari fiyatlarla, bin TL)",
    "files": [io_file, f2, f5, f6, f4, f7],
    "year": 2023,
    "unit": "thousand TRY",
    "products": [{"code": c, "name": n} for c, n in zip(codes, names)],
    "Z": Z, "output": output, "gva": gva, "compensation": comp,
    "household": {"purchasers": hh_purch, "basic": hh_basic, "domesticBasic": hh_dom, "margins": hh_margin, "taxes": hh_tax},
}
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
print(f"wrote {out}: {N} products, output total {sum(output):,.0f} thousand TRY")
