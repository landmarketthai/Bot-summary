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

## Notification delivery

- Retryable / unknown push failure (network, 429, 5xx): the run stops with the
  candidate unmarked; the next run resends with the same retry key
  (candidate + revision + group) and LINE de-duplicates it.
- Definite rejection (4xx): logged, counted as `undeliverable`, marked as
  announced so it cannot block the FIFO queue head. Its card is lost until
  the next revision; fix the cause from the log.
- Two concurrent runs select the same rows and send the same retry keys.

## Risk assessment

| Risk | Control | Evidence |
|---|---|---|
| Wrong category in a report | admin-only rule, one snapshot per report | unit 1–3, 9; concurrency tests |
| Identity / SKU merge | rules key on exact name, store category only; no alias, code or vocabulary change | diff touches no `product-vocabulary`, `dictionary.ts`, fingerprint code; test 5 |
| Money / quantity change | category is grouping only | test 8: identical satang + item counts |
| Leak to operational groups | send + reply only for `CATEGORY_REVIEW_LINE_GROUP_IDS`; other groups silent, no DB read | webhook + review tests |
| Unauthorized approval | group AND admin allowlist, fail closed when unset | tests 7, unauthorized alias test |
| Replay / double tap / race | raw-event dedup, event-id unique, row lock, revision | PG: replay, stale, 3-way race |
| Rule table unavailable / partial | last complete snapshot, else code rules; never partial | P2 + failure tests |
| Queue starvation / poison card | FIFO generated column; 4xx skipped | queue tests (unit + PG) |
| Ingestion / daily close blocked | no rule read on ingestion path; discovery is its own cron | test 10, route test |

## Migration preflight and rollback (owner-run)

Preflight on the target database, read-only:

```sql
SELECT to_regclass('public.produce_category_candidates'),   -- expect NULL
       to_regclass('public.produce_category_rules'),        -- expect NULL
       to_regclass('public.produce_category_decisions');    -- expect NULL
SELECT current_setting('server_version_num')::int >= 130000; -- gen_random_uuid, normalize()
SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database(); -- UTF8
```

Apply in order: `20261022120000_produce_category_learning.sql`, then
`20261022130000_produce_category_announce_queue.sql`. Both are additive (new
objects only) and transactional. Deploying the app before the migrations is
safe: rule loads fail and reports fall back to the code rules; keep
`CATEGORY_REVIEW_NOTIFY_ENABLED` off and do not schedule discovery until both
are applied.

Rollback, in reverse order: `supabase/rollback/20261022130000_*.down.sql`,
then `supabase/rollback/20261022120000_*.down.sql` (export
`produce_category_decisions` first if the audit must be kept). No business
table is touched; reports return to code-only rules. Proven on PostgreSQL 17:
forward → down → forward.

## CI

`pg-tests.yml` job `category-learning` (Bun 1.4.3, PostgreSQL 17 service):
PostgreSQL suite with `REQUIRE_CATEGORY_LEARNING_POSTGRES=1` (no silent skip;
applies both migrations and both rollbacks), focused unit/webhook/route tests,
report-surface regressions, `tsc`, `eslint --max-warnings=0` on the feature
files, `git diff --check`.

## Preview UAT (isolated)

Requirements: a Preview deployment pointed at a **non-Production** Supabase
database with both migrations applied, and a **test-only** LINE group. Never
point Preview at Production data or an operational group.

## UAT checklist (test group only)

1. Apply both migrations to the isolated database; deploy a Preview against it.
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
