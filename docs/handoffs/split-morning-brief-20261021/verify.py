"""Local PDF geometry, content, pagination, and PR #184 pixel comparisons."""
import json
import re
import subprocess
from pathlib import Path

import pdfplumber
from PIL import Image, ImageChops, ImageDraw
from pypdf import PdfReader

root = Path(__file__).resolve().parent
workspace = root.parents[2]
poppler = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe"
rendered = root / "rendered"
rendered.mkdir(exist_ok=True)


def render(pdf, prefix):
    for stale in prefix.parent.glob(prefix.name + "-*.png"):
        if re.fullmatch(re.escape(prefix.name) + r"-\d+", stale.stem):
            stale.unlink()
    subprocess.run([str(poppler), "-scale-to", "1100", "-png", str(pdf), str(prefix)], check=True, capture_output=True)
    return sorted(prefix.parent.glob(prefix.name + "-*.png"))


def normalized(text):
    return re.sub(r"\s+", "", text).replace("ำา", "ำ")


results = {}
for path in sorted((root / "pdf").glob("*.pdf")):
    pages = PdfReader(path).pages
    texts = [page.extract_text() for page in pages]
    for index, page in enumerate(pages, 1):
        assert abs(float(page.mediabox.width) - 595.28) < 1
        assert abs(float(page.mediabox.height) - 841.89) < 1
        assert f"หน้า{index}/{len(pages)}" in normalized(texts[index - 1]), path.name
    with pdfplumber.open(path) as pdf:
        for index, page in enumerate(pdf.pages, 1):
            bad = [c for c in page.chars if not (20 <= c["x0"] and c["x1"] <= 575.3 and 0 <= c["top"] < 836)]
            assert not bad, (path.name, index, bad[:2])
    text = normalized("".join(texts))
    assert "รายละเอียดสินค้าและสถานะยอดขาย" not in text, path.name
    assert "สินค้า/หน่วย" not in text, path.name
    for phrase in ["รายละเอียดการตรวจข้อมูล", "สถานะข้อมูล", "รอตรวจ", "รอชั่งคืน", "ยังไม่คำนวณ", "รอยอดบ้าน", "รอข้อมูล"]:
        assert phrase not in text, (path.name, phrase)
    if path.stem.startswith("vegetable"):
        assert "พาซิโอ้ผลไม้" not in text and "พาซิโอ้ทุเรียน" not in text, path.name
    else:
        assert "พาซิโอ้ผัก" not in text, path.name
    images = [image for image in render(path, rendered / path.stem)
              if re.fullmatch(re.escape(path.stem) + r"-\d+", image.stem)]
    assert len(images) == len(pages)
    results[path.stem] = {"pages": len(pages), "a4_footers_margins_no_status_or_weighing_entries": "PASS"}

# Compare identical unscoped inputs against the clean latest-main worktree.
baseline = workspace.parent / "split-morning-baseline/.tmp-pr184-baseline/pdf"
new = workspace / ".tmp-pr184-layout/pdf"
pixels = {}
for name in ["before-return", "after-return", "multi-market", "overflow"]:
    old_images = render(baseline / f"{name}.pdf", workspace / f".tmp-baseline-{name}")
    new_images = render(new / f"{name}.pdf", workspace / f".tmp-current-{name}")
    assert len(old_images) == len(new_images), name
    for old, current in zip(old_images, new_images):
        assert ImageChops.difference(Image.open(old).convert("RGB"), Image.open(current).convert("RGB")).getbbox() is None, (name, old)
    pixels[name] = {"pages": len(old_images), "identical_pixels": True}

thumbs = []
for name in ["fruit", "vegetable", "vegetable-review", "vegetable-unavailable"]:
    for path in sorted(rendered.glob(name + "-*.png")):
        # Exact stem prevents a shorter prefix selecting another fixture.
        if not re.fullmatch(re.escape(name) + r"-\d+", path.stem):
            continue
        image = Image.open(path).convert("RGB")
        image.thumbnail((360, 510))
        tile = Image.new("RGB", (380, 540), "#e5e7eb")
        tile.paste(image, ((380-image.width)//2, 23))
        ImageDraw.Draw(tile).text((8, 7), path.stem, fill="black")
        thumbs.append(tile)
sheet = Image.new("RGB", (380 * 4, 540 * ((len(thumbs) + 3) // 4)), "white")
for index, tile in enumerate(thumbs):
    sheet.paste(tile, ((index % 4) * 380, (index // 4) * 540))
sheet.save(rendered / "contact-sheet.png")
(root / "visual-verification.json").write_text(json.dumps({"synthetic": results, "pr184_pixel_regression": pixels}, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"synthetic": results, "pr184_pixel_regression": pixels}))
