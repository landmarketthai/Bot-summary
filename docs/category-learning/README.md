# Self-learning produce category dictionary

Goal: stop known fruit and vegetables from landing in **อื่นๆ** report after
report, without touching product identity or money.

## Rules this feature keeps

- **Category is not identity.** A rule maps an exact canonical name to a
  category. It never renames a product, merges SKUs, creates a product code, or
  changes transactions, quantities, prices, totals or fingerprints.
- **No auto-approval.** Discovery only *proposes*. Similar names propose a
  category; they are never merged. No observation threshold creates anything.
- **One policy.** `approvedCategoryFor()` (`src/lib/produce/product-code/category.ts`)
  is consulted first by every surface:
  - Stock Summary — `stockCategoryFor`
  - Morning Brief LINE + PDF sections — `produceSectionOf`, `morningBriefProductIdentity`
  - LINE category totals / good-return value — `dictionaryCategoryFor`
- **Rules without a deployment, one snapshot per report.** Each report loads
  ONE complete immutable snapshot (`loadApprovedCategoryPolicy`, keyset pages
  of 1,000 by `product_name`) and pins it for its whole async run with
  AsyncLocalStorage (`withApprovedCategoryRules` / `enterCategoryPolicy`), so a
  concurrent report's refresh can never change categories midway. Pinned in:
  `/api/cron/daily-stock-summary`, `/api/cron/daily-morning-brief` (report, PDF,
  messages), `/api/cron/daily-summary`, `loadStockSummary`, discovery, review
  postbacks.
- **Failure never yields a partial snapshot.** Any page error → the last
  complete snapshot this process loaded, else business rules only. A report
  never fails because of this feature.
- **Ingestion path stays DB-free.** Session-close receipts (`reply.ts`,
  failed-session recovery) run outside a report and use business rules only;
  Produce ingestion never waits on the rule table.

Business rules shipped in code (`BUSINESS_CATEGORY_RULES`):
`มะละกอดิบ → ผ` (separate product from `มะละกอ`, which stays fruit) and
`เต้าหู้แผ่น → other`. `ปลาทู` / `ขนมจีน` are already `ป` in the code table.

## Flow

```
/api/cron/category-discovery  (CRON_SECRET, last 14 business dates)
  load rules → read produce_transactions (names only, paginated)
  → canonicalProduceProductIdentity → keep names whose section is "other" and
    that no rule / code-table entry classifies
  → suggestCategory: 1-letter typo of a known name (high) | known prefix (medium) | none (low)
  → observe_produce_category_candidate (durable per name; evidence: count, dates, markets)
  → if CATEGORY_REVIEW_NOTIFY_ENABLED=true: Flex card to CATEGORY_REVIEW_LINE_GROUP_IDS
    for the next unannounced revisions, FIFO (`needs_announcement`, ordered by
    created_at, product_name; max 10/run, so the queue always drains;
    LINE retry key = candidate+revision+group)

LINE postback  pcat1|<candidate>|<revision>|<action>|<code>
  raw event persisted first (replay = duplicate, never re-processed)
  → group ∈ CATEGORY_REVIEW_LINE_GROUP_IDS else silent
  → user ∈ CATEGORY_REVIEW_ADMIN_LINE_USER_IDS else "ไม่มีสิทธิ์"
  → decide_produce_category_candidate: event-id idempotent, row lock,
    stale if status ≠ pending or revision changed, append-only audit row,
    rule upsert
```

Actions: approve suggested · select another category · approve reviewed alias
(copies the target's **category** only; the alias target is recorded for an
engineering identity review, never applied at run time) · register distinct new
product (category rule, no product code) · reject (reopens only for a different
suggestion) · mark legitimate other (never re-alerted).

## Tables (migrations `20261022120000_produce_category_learning.sql`, `20261022130000_produce_category_announce_queue.sql`)

| Table | Purpose |
|---|---|
| `produce_category_candidates` | one row per discovered name, evidence, status, revision, notified_revision |
| `produce_category_rules` | approved name → category (`ท ม ผ ป ห พ other`) |
| `produce_category_decisions` | append-only audit: who, which group, which LINE event, which revision |

RLS on, no `anon` / `authenticated` access, RPCs `service_role` only.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CATEGORY_REVIEW_NOTIFY_ENABLED` | unset (off) | `true` sends review cards |
| `CATEGORY_REVIEW_LINE_GROUP_IDS` | empty (fail closed) | the LINE **test group** only, until owner approval |
| `CATEGORY_REVIEW_ADMIN_LINE_USER_IDS` | empty (fail closed) | LINE user ids allowed to decide |

## UAT checklist (test group only)

1. Apply the migration to a non-Production database; deploy a Preview.
2. Set the three env vars to the test group and one admin user.
3. `GET /api/cron/category-discovery` with the cron secret → JSON shows `discovered` and `notified`.
4. Test group receives at most 10 cards; Operations groups receive nothing.
5. Re-run discovery → no new card for unchanged candidates.
6. Admin taps "เลือก: ผัก" on a card → reply `✅ บันทึกแล้ว … → ผัก`.
7. Tap the same button again → `ℹ️`/`⚠️` reply; one row in `produce_category_decisions`.
8. A non-admin member taps a button → `⛔ ไม่มีสิทธิ์…`; no decision row.
9. Next Stock Summary, Morning Brief LINE + PDF show the name under ผัก; totals and quantities equal the previous run.
10. Tap "📦 เป็นสินค้าอื่นๆ จริง" on another card; re-run discovery → no new card for it.
11. `มะละกอดิบ` is under ผัก and `มะละกอ` under ผลไม้ in all three reports.
12. Stop discovery (or break the DB URL) → Produce ingestion and daily close unaffected.
