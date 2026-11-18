"""Check synthetic PDFs with pdfplumber; render every page with local Poppler."""
import argparse
import json
import re
import subprocess
from pathlib import Path
import pdfplumber
from PIL import Image, ImageDraw, ImageOps

parser = argparse.ArgumentParser()
parser.add_argument("--poppler", required=True, help="Path to pdftoppm (no network)")
args = parser.parse_args()
directory = Path("output/pdf/morning-brief-v3")
results = []
def compact(text):
    text = re.sub(r"\s+", "", text).replace("ำา", "ำ")
    text = re.sub(r"([าำ])([่้๊๋])", r"\2\1", text)
    # Sarabun's shaped PDF extraction can reorder Thai tone/vowel codepoints.
    return re.sub(r"[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]+", lambda match: "".join(sorted(match[0])), text)
def quantity(value):
    return "-" if value is None else f"{value:,.3f}".rstrip("0").rstrip(".") if value else "0"

def money(value):
    return f"{value / 100:,.2f}"
def label_signature(value):
    value = compact(value)
    marks = r"[\u0e31\u0e34-\u0e3a\u0e47-\u0e4e]"
    # Compare every base glyph and the exact mark multiset, accommodating
    # PDF glyph-position extraction order without dropping Thai diacritics.
    return re.sub(marks, "", value), sorted(re.findall(marks, value))

def contains_label(text, label):
    # Locate headings by base glyphs; pdfplumber can move tone marks across a
    # consonant boundary. Product cells still compare the exact mark multiset.
    return label_signature(label)[0] in label_signature(text)[0]

for fixture in sorted(directory.glob("*.synthetic.json")):
    data = json.loads(fixture.read_text(encoding="utf-8"))
    stem = fixture.name.replace(".synthetic.json", "")
    path = directory / f"{stem}.pdf"
    with pdfplumber.open(path) as pdf:
        report = data["report"]
        if report.get("reportScope") == "vegetable":
            assert not report.get("unassigned"), f"private unassigned evidence in vegetable reference {stem}"
        hero = "".join(c["text"] for c in pdf.pages[0].chars if round(c["size"]) == 36)
        assert money(report["sales"]["confirmedSalesSatang"]) in compact(hero), f"changed sales hero {stem}"
        finances = report.get("produceFinancial") or {"fruit": report.get("fruitFinancial")}
        active_finances = [finance for finance in finances.values() if finance and (finance["markets"] or any(
            finance.get(key) for key in ["withdrawalValueSatang", "salesValueSatang", "goodReturnValueSatang", "houseStockValueSatang", "readyValueSatang"]))]
        expected_kpis = [money(sum(finance[key] for finance in active_finances))
                         for key in ["withdrawalValueSatang", "goodReturnValueSatang"]]
        expected_kpis += [money(sum(finance[key] for finance in active_finances))
                          for key in ["houseStockValueSatang", "readyValueSatang"]
                          if active_finances and all(finance.get(key) is not None for finance in active_finances)]
        kpi_cells = {}
        for char in pdf.pages[0].chars:
            if round(char["size"], 1) == 24 and char["text"] in "0123456789,.-":
                key = (round(char["top"], 1), char["x0"] > pdf.pages[0].width / 2)
                kpi_cells[key] = kpi_cells.get(key, "") + char["text"]
        assert sorted(kpi_cells.values()) == sorted(expected_kpis), f"changed cover KPI amounts {stem}"
        text = compact("\n".join(page.extract_text() or "" for page in pdf.pages))
        if report.get("reportScope") == "vegetable":
            assert not contains_label(text, "รายการรอตรวจขอบเขต"), f"unassigned page leaked to vegetable {stem}"
        if report.get("unassigned"):
            assert contains_label(text, "รายการรอตรวจขอบเขต"), f"missing scope review page {stem}"
            assert contains_label(text, "ห้ามบวกซ้ำ"), f"missing double-count warning {stem}"
            assert money(report["unassigned"]["confirmedSalesSatang"]) in text, f"missing unassigned amount {stem}"
        body_sizes = set()
        for page in pdf.pages:
            assert abs(float(page.width) - 841.89) < 1 and abs(float(page.height) - 595.28) < 1, "not A4 landscape"
            assert all(c["x0"] >= 20 and c["x1"] <= page.width - 20 and c["top"] >= 0 and c["bottom"] <= page.height for c in page.chars), "text outside page"
            body = [c for c in page.chars if c["top"] > 100 and c["bottom"] < page.height - 40 and c["size"] > 1]
            body_sizes.update(round(c["size"], 1) for c in body)
            assert all(c["size"] >= 19.9 for c in body), "body smaller than 20pt"
            # The footer owns the final 36pt on either orientation.
            assert not any(page.height - 42 < c["bottom"] < page.height - 36 for c in page.chars), "content overlaps footer"
            header_text = page.crop((24, 0, page.width - 24, 120)).extract_text() or ""
            if contains_label(header_text, "สินค้าคงเหลือ"):
                assert re.search(r"(?<!\d)\d+\.\s", page.extract_text() or ""), "empty detail page"
                for header in ["รายการ/หน่วย", "บ้านเจ๊", "ในตลาด", "รวมคงเหลือ"]:
                    assert contains_label(header_text, header), f"missing repeated header {header}"
        items = report["purchasePlanning"]["strong"]["items"]
        units = sorted({"กก." if item["unit"] == "โล" else item["unit"] for item in items})
        ordered = [item for unit in units for item in items if ("กก." if item["unit"] == "โล" else item["unit"]) == unit]
        for number, item in enumerate(ordered, 1):
            unit = "กก." if item["unit"] == "โล" else item["unit"]
            matches = [(page, match) for page in pdf.pages for match in page.search(rf"(?<!\d){number}\.(?!\d)")
                       if match["x0"] < 320 and match["top"] > 100]
            assert len(matches) == 1, f"missing/duplicate row number {stem} {number}"
            page, match = matches[0]
            borders = [edge["top"] for edge in page.edges if edge["orientation"] == "h" and edge["x1"] - edge["x0"] > 100]
            top = max(y for y in borders if y <= match["top"])
            bottom = min(y for y in borders if y >= match["bottom"])
            columns = [24 + (page.width - 48) * fraction for fraction in [0, .4, .6, .8, 1]]
            values = [compact(page.crop((columns[i], top, columns[i + 1], bottom)).extract_text() or "") for i in range(4)]
            assert label_signature(values[0]) == label_signature(f"{number}. {item['productName']} ({unit})"), f"changed product/unit {stem} {number}: {values[0]!r}"
            expected = [quantity(item.get(key)) for key in ["houseStockQuantity", "marketStockQuantity", "totalRemainingQuantity"]]
            assert values[1:] == expected, f"changed numeric/null cells {stem} {number}: {values[1:]} != {expected}"
            red_numbers = [c for c in page.chars if columns[2] <= c["x0"] < columns[3] and top <= c["top"] < bottom and c["text"].isdigit()]
            assert all(tuple(round(channel, 2) for channel in c["non_stroking_color"]) == (.85, .18, .13) for c in red_numbers), "market numbers must be red"
        for unit in units:
            unit_items = [item for item in items if ("กก." if item["unit"] == "โล" else item["unit"]) == unit]
            expected = [quantity(sum(item[key] for item in unit_items)) if all(item.get(key) is not None for item in unit_items) else "-"
                        for key in ["houseStockQuantity", "marketStockQuantity", "totalRemainingQuantity"]]
            found = []
            for page in pdf.pages:
                if not contains_label(page.crop((24, 0, page.width - 24, 120)).extract_text() or "", "สินค้าคงเหลือ"):
                    continue
                borders = sorted(set(round(edge["top"], 2) for edge in page.edges if edge["orientation"] == "h" and edge["x1"] - edge["x0"] > 100 and edge["top"] >= 119))
                columns = [24 + (page.width - 48) * fraction for fraction in [0, .4, .6, .8, 1]]
                for top, bottom in zip(borders, borders[1:]):
                    values = [compact(page.crop((columns[i], top, columns[i + 1], bottom)).extract_text() or "") for i in range(4)]
                    if label_signature(values[0]) == label_signature(f"รวม ({unit})"):
                        found.append(values[1:])
            assert found == [expected], f"changed unit totals {stem} {unit}: {found} != {[expected]}"
        for market in report["sales"].get("markets", []):
            totals = [entry for finance in finances.values() if finance for entry in finance["markets"] if entry["marketLabel"] == market["marketLabel"]]
            expected = [money(sum(entry["withdrawalValueSatang"] for entry in totals)) if totals else "-",
                        money(market["confirmedSalesSatang"]), money(sum(entry["goodReturnValueSatang"] for entry in totals)) if totals else "-"]
            found = []
            for page in pdf.pages[1:]:
                if not contains_label(page.crop((24, 0, page.width - 24, 120)).extract_text() or "", "สรุปยอดตามตลาด"):
                    continue
                borders = sorted(set(round(edge["top"], 2) for edge in page.edges if edge["orientation"] == "h" and edge["x1"] - edge["x0"] > 100 and edge["top"] >= 119))
                columns = [24 + (page.width - 48) * fraction for fraction in [0, .28, .52, .76, 1]]
                for top, bottom in zip(borders, borders[1:]):
                    values = [compact(page.crop((columns[i], top, columns[i + 1], bottom)).extract_text() or "") for i in range(4)]
                    if label_signature(values[0]) == label_signature(market["marketLabel"]):
                        found.append(values[1:])
            assert found == [expected], f"changed market money {stem} {market['marketLabel']}: {found} != {[expected]}"
        assert any("Sarabun" in c["fontname"] for p in pdf.pages for c in p.chars), "Thai font not embedded"
        results.append({"fixture": stem, "pages": len(pdf.pages), "rows": len(items), "markets": len(report["sales"].get("markets", [])), "bodyPt": sorted(body_sizes), "checks": "A4 landscape; bounds; 20pt; every numbered row and numeric/null value; unit totals; cover KPIs; sales hero and every market amount; red market stock; embedded Sarabun; repeating detail headers"})
    subprocess.run([args.poppler, "-scale-to", "1000", "-png", str(path), str(directory / stem)], check=True)
    count = results[-1]["pages"]
    sheet = Image.new("RGB", (1500, ((count + 2) // 3) * 385), "white")
    for index in range(count):
        page_path = directory / f"{stem}-{index + 1}.png"
        with Image.open(page_path) as png:
            sheet.paste(ImageOps.contain(png, (500, 355)), ((index % 3) * 500, (index // 3) * 385 + 25))
        ImageDraw.Draw(sheet).text(((index % 3) * 500 + 8, (index // 3) * 385 + 5), page_path.name, fill="black")
    sheet.save(directory / f"{stem}-contact.png")
(directory / "verification.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
print(json.dumps(results, indent=2))
