# PR #184 — final integration UAT, 20 October 2026

## Environment and boundary

Expected starting HEAD verified: `d501cbe2e81c9fd2856bc694bb028f9b77c9ac8d`.
That HEAD had all 11 PostgreSQL CI jobs and Vercel successful.

This run used a **new, disposable native PostgreSQL 17.10 cluster**, database `pr184_uat`, bound to `127.0.0.1:55484`, plus PostgREST 16.4 at `127.0.0.1:55486`. The signed LINE webhook emulator listened on `127.0.0.1:55487`. Runtime ownership was `development`.

The emulator executed the production `verifyLineSignature`, `WebhookService.processEvents`, durable ordered queue, pending-session RPCs, validation gate, `finalizePendingGeneration`, real database finalization/fingerprint functions, real transactions view and `loadMorningBriefReport`. It used the installed Supabase client against real PostgREST. Replies/pushes were captured locally; global fetch allowed only these two loopback HTTP endpoints. No financial persistence function was mocked. No production credentials, production writes, real LINE sends, merges or deployments were used.

Test bootstrap used repository migrations. Historical pending-close baseline came from the exact backup Git file referenced by migrations 0031/0044, installed only into this empty cluster. The fresh schema also needed the equivalent legacy transfer constraint's name normalized before P2E CONTRACT, standard platform roles/storage bucket metadata, and LF SQL input matching Linux CI. No repository migration or financial SQL function was modified. Local clock advancement changed only UAT pending-session scheduling/idle timestamps; business events, financial rows and source dates were retained.

## Fixture provenance

- [Return source](fixtures/return-original.txt): the user's exact 26 item lines and `จบรายกาาชั่งคืน`, totaling **13,725.00 baht**.
- [Withdrawal fixture](fixtures/withdrawal-synthetic.txt): explicitly synthetic, authorized by the user because original withdrawal lines were unavailable. It totals **19,375.50 baht** and retains all known facts: mangosteen/mango withdrawal price 20; pomegranate withdrawal 44; papaya 30 at 16 repeated twice. It has 28 lines because papaya is split into 30 + 30 + 58; the remaining balancing quantity is explicit in the fixture.
- The header, item/quantity messages and closer were separate signed webhook deliveries, not one pasted document. See [event payloads](line-webhook-events.json) and [execution trace](execution.log).

## Results

| Case | Observed result |
|---|---|
| A: before return | SQL withdrawal 19,375.50; zero return rows; confirmed sales 0.00; 26 identities marked waiting for return; cover/detail agree, including 44.00 of unclassified goods. |
| B: typo close | All 26 real return lines accepted; typo closes the same pending generation; one finalized return document worth 13,725.00. |
| C: replay | Correctly spelled closer on replay produces `duplicate / compatibility_fingerprint`; return rows remain **26 before / 26 after**, one return document, 13,725.00 total. |
| D: after return | SQL document difference **5,650.50**. Cover/detail display the calculated total separately from **5,860.50 confirmed and −210.00 pending review**. Entered prices/quantities stay unchanged. |
| Price mismatch 1 | Mangosteen 20-to-40 advisory in durable success outbox; return still saved at 40. |
| Price mismatch 2 | Mango 20-to-40 advisory in durable success outbox; return still saved at 40. |
| Excess return | Pomegranate 47 against 44 advisory; original 47 saved; signed −30.00 difference remains pending. |
| Duplicate papaya lines | Review recorded, proven presented and confirmed by a **different** close event; both legitimate-confirmed lines retained. |
| Real additional withdrawal | Separate main/additional documents, **2 rows / 60 fruit / 960.00 baht** in SQL; no false duplicate block. |
| Other market | Wat Thung Lanna withdrawal 10, return 4 at 10 baht; confirmed **60.00**, authoritative, unchanged behavior. |
| Expiry/recovery/replay | Real inactivity sweep expires one draft, retains its text, captures explicit recovery guidance. Recovery persists one transaction worth 20.00; subsequent replay is duplicate and leaves **1 row / 20.00**. |

All **4 primary scenarios and 5 validation cases** passed through the real database integration path. The apparent main return-document count of zero in an initial diagnostic came from filtering nullable `declared_transaction_type`; the corrected verification counts distinct persisted `session_id` from the authoritative transactions view, scoped by raw-message source. No expected financial total was changed.

## Bug proven and fixed during UAT

Starting HEAD displayed **5,860.50** as sales and **13,545.00** as return value even though SQL stored **13,725.00** returned. The loader discarded entered return prices; the report repriced return quantities at withdrawal prices and excluded the negative excess-quantity difference.

Morning Brief now carries exact persisted line values through the shared calculator's required-return mode. It deducts submitted W/R/D amounts, rounds signed differences once, and puts price/excess-quantity discrepancies in pending review. Physical sold quantities remain unavailable when returns exceed withdrawals. Legacy Daily Sales policy remains unchanged. PDF/LINE explicitly label the combined calculated amount and pending portion. Unclassified withdrawal/return amounts now remain visible even when their sale is zero.

Added regression coverage for actual 20-to-40 prices, excess quantities, unchanged input, signed review amounts, persisted basis precision, missing value evidence and negative half-satang rounding. Acceptance: **757 pass, 0 fail**, 25 files / 2,819 assertions; TypeScript and changed-source ESLint both pass. Relevant regression results and type/lint output are in [regression.log](regression.log). The previously recorded 21 non-PostgreSQL baseline failures were not changed or hidden; no unnecessary full-suite rerun was made.

## Evidence and integration gate

- [Read-only SQL verification](sql-verification.json), generated by [verify.sql](verify.sql).
- [Detailed integration/validation outcomes](results-final.json).
- [Before PDF](pdf/before-return.pdf), [after PDF](pdf/after-return.pdf), with all five rendered pages under [rendered/](rendered/). All pages visually inspected; no clipped amounts/status labels or overlapping tables.
- [Before report JSON](before-return.report.json), [after report JSON](after-return.report.json).
- `origin/main` remains `11e2f4342a900d6dcaf0107f47970ed2a2bc46e4`; no new main changes affected this run.
- PR #182 checked at `0bb0088258a9047ed6641cedfb3b37446fe909f0`. Only shared changed file: `src/lib/line/webhook-service.ts`. A three-way merge preview against the common base returned **exit 0, no conflict markers**. No PR #182 file/worktree/ref was changed. This checks textual integration; the eventual combined release should retain both Produce and Slip behavior.
- Latest HEAD CI must be read from [PR #184 checks](https://github.com/landmarketthai/Bot-summary/pull/184/checks) after this commit is pushed. Successful old-HEAD checks are not substituted for new-HEAD verification.

Production remains untouched. Functional UAT is complete. Release approval, merge and production deployment remain separate actions and were not performed.
