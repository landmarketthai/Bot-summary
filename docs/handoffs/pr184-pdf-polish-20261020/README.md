# PR #184 — Final PDF polish

Starting local and remote HEAD: `4b748c91b8c61f5cea521ef4b9ec0dd7290dbb35`.
Scope: PDF presentation, layout tests and visual fixtures only. Financial calculations, validation, LINE, parser, dictionary, database/migrations and PR #182 are unchanged.

| Report | Previous | Final | Result |
| --- | ---: | ---: | --- |
| Before return | 1 page | 1 page | PASS |
| After return | 2 pages | 2 pages | PASS |
| Multi-market | 2 pages | 2 pages | PASS |
| Overflow | 5 pages | 4 pages | PASS |

## Three fixes

1. **Pagination:** React-pdf measures the final product row and all its unit totals as one block before deciding whether the remaining page area fits. This replaces the fixed 35 pt reserve. Category heading gaps and total-row padding are smaller; duplicate all-zero category review lines are omitted while nonzero warnings remain. Body and stock font sizes are unchanged. All four long-name rows and both unit totals now fit on overflow page 4. Continued tables retain their headers and rows cannot split.
2. **Market readiness:** one summary shows observed markets, markets with withdrawals, markets with returns, and markets with both. Only missing evidence or existing financial exceptions get individual status lines. The financial table still lists every market. Pending money, unresolved/unavailable counts, price/return issues, awaiting returns and non-authoritative values remain visible. The report explicitly says that observing both document types does not establish completeness. Tests cover 3, 10 and 30 markets with healthy and exceptional cases.
3. **Thai wrapping:** long labels use Thai word boundaries with nearly invisible space-only glyphs instead of textkit's hyphenation penalties. No letters are reduced or removed; every stock letter stays at the existing 11.7 pt size. Only long rows grow to multiple lines. Product identities and source data remain unchanged.

## Integrity and validation

The original UAT snapshots and the same multi-market/overflow fixture data were reused. The shared visual-fixture builder was extracted unchanged so PDF tests and the rendering script use the same data. Rendering asserts that input reports are not mutated.

- Before: withdrawal **19,375.50**, return **0.00**, confirmed **0.00**, awaiting return **26**.
- After: withdrawal **19,375.50**, return **13,725.00**, confirmed **5,860.50**, pending **-210.00**, calculated including pending **5,650.50** baht.
- Focused tests: **276 PASS / 0 FAIL / 1,449 assertions**, six files. [Regression log](regression.log).
- TypeScript and changed-file ESLint PASS; `git diff --check` PASS.
- **All 9 final PNG pages were opened and visually inspected.** No missing products, clipped Thai marks, overlapping rows, number-column intrusion, blank pages or broken continuation headers were observed. Overflow page 4 was checked with all four long names and both total rows present.
- Supplemental [verification](verification.json) checks A4 dimensions, all footers, margins, financial amounts, every product and market, and long-name column bounds. Unlike the earlier check, normalization preserves hyphens, so an inserted hyphen inside a product name fails content preservation.
- No financial logic changed. Full-suite/LINE/database UAT was not repeated; the existing 21 baseline failures were not touched. No merge, production deployment or real LINE send occurred.
- CI must be evaluated for the pushed polish HEAD; the final current result is recorded on [PR #184](https://github.com/landmarketthai/Bot-summary/pull/184), without using earlier-head checks as a substitute.

The original withdrawal remains an explicitly authorized synthetic fixture; this presentation task does not supply additional source-business evidence.

## Final PDFs and all rendered pages

- Before: [PDF](pdf/before-return.pdf), [PNG](rendered/before-return-1.png).
- After: [PDF](pdf/after-return.pdf), [PNG 1](rendered/after-return-1.png), [PNG 2](rendered/after-return-2.png).
- Multi-market: [PDF](pdf/multi-market.pdf), [PNG 1](rendered/multi-market-1.png), [PNG 2](rendered/multi-market-2.png).
- Overflow: [PDF](pdf/overflow.pdf), [PNG 1](rendered/overflow-1.png), [PNG 2](rendered/overflow-2.png), [PNG 3](rendered/overflow-3.png), [PNG 4](rendered/overflow-4.png).
- Previous PDFs/images for comparison: [layout evidence](../pr184-pdf-layout-20261020/README.md).

Reproduce from the isolated worktree root (Python requires the PDF skill's `pypdf` and `pdfplumber` packages):

```powershell
$env:PR184_PDF_OUTPUT = (Resolve-Path docs/handoffs/pr184-pdf-polish-20261020).Path
bun docs/handoffs/pr184-pdf-layout-20261020/render.tsx
python docs/handoffs/pr184-pdf-polish-20261020/verify.py
Get-ChildItem docs/handoffs/pr184-pdf-polish-20261020/pdf/*.pdf | ForEach-Object {
  pdftoppm -scale-to 1400 -png $_.FullName "docs/handoffs/pr184-pdf-polish-20261020/rendered/$($_.BaseName)"
}
bun test src/lib/summary/morning-brief-pdf.test.tsx src/lib/summary/morning-sales-integrity.test.tsx src/lib/summary/morning-brief-message.test.ts src/lib/summary/morning-brief-service.test.ts src/lib/sales/calculate.test.ts src/lib/sales/load.test.ts
```
