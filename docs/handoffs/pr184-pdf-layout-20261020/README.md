# PR #184 — Morning Brief PDF layout

Starting commit: `133aa4a82dad4fbcbad8c49cf78c5a3832fded22`.
Scope: PDF renderer and PDF tests only; financial calculations, LINE, validation, database and PR #182 are unchanged.

| Fixture | Original pages | New pages | Result |
| --- | ---: | ---: | --- |
| Before return, unchanged UAT snapshot | 2 | 1 | PASS |
| After return, unchanged UAT snapshot | 3 | 2 | PASS |
| Synthetic multi-market: 3 markets / 11 products / 3 stock categories | — | 2 | PASS |
| Synthetic overflow: 30 markets / 64 products / long Thai names | — | 5 | PASS |

## Changes

- Audit and market readiness follow the overview on the same page.
- Create stock detail pages only when physical stock exists. Finance-only categories retain all amounts and statuses in compact summaries on the overview.
- Let the market table flow naturally instead of splitting after seven markets.
- Reduce card height, heading spacing and row padding; retain the original 11.1 pt body and 11.7 pt stock fonts.
- Replace repeated category cards with compact financial summaries. Small categories share the stock page.
- Right-align numeric cells; preserve two decimal places for money and signed pending amounts.
- Wrap long Thai table labels at word boundaries, preserving combining marks. Continued tables repeat their headers; individual rows cannot split.

## Financial integrity

Both inputs are the existing [UAT report snapshots](../pr184-uat-20261020/). The renderer asserts that neither input is mutated.

- Before: withdrawal **19,375.50**, return **0.00**, confirmed **0.00**, awaiting return / unavailable **26**.
- After: withdrawal **19,375.50**, return **13,725.00**, confirmed **5,860.50**, pending **-210.00**, calculated including pending **5,650.50** baht.
- The 44.00 baht unclassified withdrawal/return remains visible separately; fruit amounts remain 19,331.50 / 13,681.00.
- Source withdrawal remains an explicitly authorized synthetic fixture, as documented in the original UAT. This layout task adds no new financial evidence.

## Visual QA and automated evidence

All **10 final PNG pages were opened and inspected**, including the multi-line Thai names and repeated headers on overflow pages 2, 4 and 5. No clipped labels, overlapping tone marks, split rows or missing data were observed. Footer page numbers match the actual page counts. The overflow's final page contains the actual remaining long row and unit totals; no explicit category page break creates it.

Automated supplemental checks in [verification.json](verification.json) verify A4 size, footers, page margins, headline amounts and product preservation. They supplement the image review.

Focused regression: **272 passed / 0 failed**, six files, 1,447 assertions. See [regression.log](regression.log). TypeScript and lint passed. No full suite or LINE/database UAT rerun was needed for this presentation change; the 21 historical baseline failures were left alone.

CI must be checked against the pushed layout commit; its live status is on [PR #184](https://github.com/landmarketthai/Bot-summary/pull/184). No merge or production deployment is part of this change.

## PDFs and every rendered page

- Before return: [original 2 pages](../pr184-uat-20261020/pdf/before-return.pdf), [new 1 page](pdf/before-return.pdf), [PNG](rendered/before-return-1.png).
- After return: [original 3 pages](../pr184-uat-20261020/pdf/after-return.pdf), [new 2 pages](pdf/after-return.pdf), [PNG 1](rendered/after-return-1.png), [PNG 2](rendered/after-return-2.png).
- Multi-market: [PDF](pdf/multi-market.pdf), [PNG 1](rendered/multi-market-1.png), [PNG 2](rendered/multi-market-2.png).
- Overflow: [PDF](pdf/overflow.pdf), [PNG 1](rendered/overflow-1.png), [PNG 2](rendered/overflow-2.png), [PNG 3](rendered/overflow-3.png), [PNG 4](rendered/overflow-4.png), [PNG 5](rendered/overflow-5.png).

Reproduce from the repository worktree root:

```powershell
bun docs/handoffs/pr184-pdf-layout-20261020/render.tsx
python docs/handoffs/pr184-pdf-layout-20261020/verify.py
Get-ChildItem docs/handoffs/pr184-pdf-layout-20261020/pdf/*.pdf | ForEach-Object {
  pdftoppm -scale-to 1400 -png $_.FullName "docs/handoffs/pr184-pdf-layout-20261020/rendered/$($_.BaseName)"
}
bun test src/lib/summary/morning-brief-pdf.test.tsx src/lib/summary/morning-sales-integrity.test.tsx src/lib/summary/morning-brief-message.test.ts src/lib/summary/morning-brief-service.test.ts src/lib/sales/calculate.test.ts src/lib/sales/load.test.ts
```

The stress reports are generated locally by `render.tsx`; they are synthetic presentation fixtures, never production reports.
