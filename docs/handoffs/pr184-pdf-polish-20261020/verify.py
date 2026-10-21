"""Supplement visual inspection with page, money, content and margin checks."""
import json
import re
from pathlib import Path

import pdfplumber
from pypdf import PdfReader

root = Path(__file__).resolve().parent


def normalized(text):
    # PDF font extraction expands Sara Am; ignore layout spaces, preserving every hyphen and minus sign.
    return re.sub(r"\s+", "", text).replace("ำา", "ำ")


results = {}
for name, expected in [("before-return", 1), ("after-return", 2), ("multi-market", 2), ("overflow", 4)]:
    path = root / "pdf" / f"{name}.pdf"
    pages = PdfReader(path).pages
    assert len(pages) == expected, (name, len(pages))
    texts = [page.extract_text() for page in pages]
    text = normalized("".join(texts))
    for i, page in enumerate(pages, 1):
        assert abs(float(page.mediabox.width) - 595.28) < 1
        assert abs(float(page.mediabox.height) - 841.89) < 1
        assert f"หน้า{i}/{expected}" in normalized(texts[i - 1])
    with pdfplumber.open(path) as document:
        for page in document.pages:
            assert all(20 <= c["x0"] and c["x1"] <= 575.3 and 0 <= c["top"] < 836 for c in page.chars), name
    if name in ("before-return", "after-return"):
        amounts = ["19,375.50", "0.00"] if name == "before-return" else ["19,375.50", "13,725.00", "5,860.50", "-210.00", "5,650.50"]
        assert all(amount in texts[0] for amount in amounts), name
        assert ("รอชั่งคืน26รายการ" in normalized(texts[0])) == (name == "before-return")
        if name == "before-return":
            assert "ยังไม่คำนวณ26รายการ" in text
            assert "รายการ(ผลไม้)" not in text
        source = root.parent / "pr184-uat-20261020" / f"{name}.report.json"
    else:
        source = root / f"{name}.report.json"
    report = json.loads(source.read_text(encoding="utf-8"))
    assert all(normalized(market["marketLabel"]) in text for market in report["produceReadiness"]["markets"]), name
    items = [item for group in report["purchasePlanning"].values() for item in group.get("items", [])]
    if name != "before-return":
        assert all(normalized(item["productName"]) in text for item in items), name
    if name == "overflow":
        assert "ตลาดทดสอบ30" in text
        assert "รายการ(ผลไม้)" in normalized(texts[3])
        assert "สินค้าทดสอบ4" in normalized(texts[3])
        assert "รายการ(อื่นๆ)" in normalized(texts[3])
        assert "การตัดบรรทัด" in normalized(texts[3])
    if name in ("multi-market", "overflow"):
        with pdfplumber.open(path) as document:
            last = document.pages[-1]
            starts = [word["top"] for word in last.extract_words() if word["text"].startswith("สินค้าทดสอบ")]
            assert starts, name
            assert all(c["x1"] <= 244 for c in last.chars if min(starts) <= c["top"] < 805 and re.search(r"[ก-๛]", c["text"])), name
    results[name] = {"pages": len(pages), "planning_items": len(items), "a4_and_footers": "PASS", "margins": "PASS", "content": "PASS"}

(root / "verification.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps(results, ensure_ascii=False))
