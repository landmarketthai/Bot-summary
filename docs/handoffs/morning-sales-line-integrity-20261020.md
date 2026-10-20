# Morning Brief / LINE integrity — 20 October 2026

Base: `origin/main` at `11e2f43`. Branch: `codex/morning-sales-line-integrity-20261020`.
The original checkout has unrelated uncommitted work. All changes here were made in an isolated worktree; PR #182 and its worktree were not modified.
The only shared changed file with PR #182 is `src/lib/line/webhook-service.ts`; these changes are confined to Produce close normalization/feedback, so an eventual integration must preserve that PR's separate Slip changes.

## Behavior

- Morning Brief calls the shared sales loader with `requireReturnEvidence`. A withdrawal without an observed good return (including explicit zero) is unavailable, with `รอชั่งคืน`; it cannot become a confirmed sale. Legacy Daily Sales callers retain their existing policy.
- Cover, market totals, category KPIs and LINE show confirmed sales. Pending money and unavailable counts are separate; category sales no longer add pending money into an unlabeled total.
- A close prefix one edit from `จบรายการ` is repaired only when its transaction suffix exactly matches a supported main closer. `จบรายกาาชั่งคืน` is recognized through webhook ordering, close validation and finalizer reconstruction. Cross-type closes are still refused. Other unclear close attempts immediately receive corrective guidance.
- Inactivity warnings include correct close commands. Expired drafts with admitted content receive status and safe replay instructions; messages stay retained. A closer without an active session receives explicit status/recovery guidance. Terminalized snapshots skip finalization.
- Identical canonical item lines inside a document require the existing digest/generation-bound review confirmation. Nothing is silently deleted. A separate explicit additional batch remains additive; the existing atomic business fingerprint prevents re-posting the same main document.
- Return price changes and excessive returns are visible advisories in the successful notification. Entered prices, quantities and historical data are never rewritten.

## Verification

- Acceptance: **754 pass, 0 fail**, 25 files, 2,802 assertions. Covers calculator/loader, legacy behavior, PDF render, LINE replies, finalization, 26-item replay, duplicate review and additional withdrawals.
- Entire non-PostgreSQL suite: **5,311 pass, 21 fail**, 287 files. Clean base with the same command: **5,294 pass, 21 fail**, 285 files. Compared complete failing test names: **no new failures**.
- Existing failures concern migration-history baselines, preflight/central-price expectations, category purity, reconciliation/report fixtures, purchase-planning evidence and a review-state migration assertion. They were not changed to hide failures.
- `tsc --noEmit --incremental false`: pass.
- ESLint on changed production files and new tests: 0 errors; one pre-existing unused `replyMessage` warning in `webhook-service.ts`.
- PostgreSQL suite was stopped when its local connection probe hung. No migration was added or applied. Database race guarantees are exercised through existing fake-RPC contracts here, not a fresh PostgreSQL run.
- Both before/after A4 PDFs were rendered and all four pages visually inspected: no clipped status labels, values or tables.

The original PDF and original 26 item lines were not supplied. Fixtures use the supplied totals and named anomalies; the 26-line replay uses explicitly synthetic quantities. This proves the requested invariants without claiming an exact transcription of the production ledger.

## UAT (test group / local or test database only)

1. Record a withdrawal worth 19,375.50 baht, with no return. Generate the brief: confirmed sales for it must be 0.00, withdrawal remains 19,375.50, status `รอชั่งคืน`.
2. Complete its return worth 13,725.00 baht using `จบรายกาาชั่งคืน`. Regenerate: representative supplied-total fixture yields 5,650.50 baht in both cover and category detail.
3. Resend the same 26-line main return with a normal closer. Expect duplicate feedback and one saved return document, not 52 return rows. An expired generation itself must not persist.
4. Submit an uncertain closer: expect immediate correction guidance, retained draft and no close boundary. Use the correct closer to complete.
5. Submit papaya 30 ลูก at 16 baht twice: expect confirmation, unchanged draft and no write until confirmed. Replaying the same confirmation event must not authorize it. An edit invalidates the old digest.
6. Submit an explicit additional withdrawal: it remains valid. Do not use an additional command to replay the original document.
7. Return mangosteen and มะม่วงจิ้ว at 40 instead of 20 baht; return 47 pomegranates against 44 withdrawn. Expect price/excess advisories and unchanged entered data.

Expiry pushes use the existing best-effort push mechanism; delivery failure is logged, and a later close receives explicit recovery guidance. UAT should include a LINE outage/retry scenario. Successful financial notifications continue to use the existing durable outbox.

No production database writes, production migrations, real LINE sends, merges or deployments were performed. This branch is ready for isolated UAT; existing suite failures and PostgreSQL verification remain visible limitations.
