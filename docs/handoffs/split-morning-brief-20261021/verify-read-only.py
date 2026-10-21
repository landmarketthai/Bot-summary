"""Verify saved local Production UAT PDFs; never reads credentials or uses network."""
import json
import re
from pathlib import Path

import pdfplumber
from pypdf import PdfReader

workspace = Path(__file__).resolve().parents[3]
results = []
normalize = lambda text: re.sub(r"\s+", "", text).replace("ำา", "ำ")
for source in sorted((workspace / ".tmp-live-uat").glob("*.report.json")):
    report = json.loads(source.read_text(encoding="utf-8"))
    path = source.with_name(source.name.replace(".report.json", ".pdf"))
    if report["readiness"]["status"] == "not_ready":
        assert not path.exists(), source.name
        continue
    reader = PdfReader(path)
    text = normalize("".join(page.extract_text() for page in reader.pages))
    assert "รายละเอียดสินค้าและสถานะยอดขาย" not in text, path.name
    assert "สินค้า/หน่วย" not in text, path.name
    assert "รวมคงเหลือ" in text, path.name
    assert all(row["valueStatus"] == "CONFIRMED" or row["expectedSalesSatang"] is None for row in report["salesDetails"]), path.name
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            assert abs(float(page.width) - 595.28) < 1 and abs(float(page.height) - 841.89) < 1
            assert all(20 <= char["x0"] and char["x1"] <= 575.3 and 0 <= char["top"] < 836 for char in page.chars), path.name
    results.append({"file": path.name, "pages": len(reader.pages), "summary_stock_no_weighing_entries_and_margins": "PASS"})
assert len(results) == 5, "Run read-only-uat.tsx for all three approved dates first."
Path(__file__).with_name("read-only-pdf-verification.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
print(json.dumps(results))
