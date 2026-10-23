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
  messages), `/api/cron/daily-summary`, `loadStockSummary`, manual LINE
  `สรุปคงเหลือ`, discovery, review
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
  → if CATEGORY_REVIEW_NOTIFY_ENABLED=true: deliver review cards through the
    per-recipient ledger (see "Notification delivery")

/api/cron/category-discovery?requeue=blocked[&group=<review group id>]
  explicit recovery after the LINE token or a group's permission is fixed

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

Manual `สรุปคงเหลือ` in LINE classifies inside the same approved-category
snapshot as the scheduled Stock Summary (one rule read per command).

## Tables

| Table | Migration | Purpose |
|---|---|---|
| `produce_category_candidates` | 20261022120000 | one row per discovered name, evidence, status, revision (`notified_revision` / `needs_announcement` from 20261022130000 are superseded by the ledger and unused) |
| `produce_category_rules` | 20261022120000 | approved name → category (`ท ม ผ ป ห พ other`) |
| `produce_category_decisions` | 20261022120000 | append-only audit: who, which group, which LINE event, which revision; UPDATE / DELETE / TRUNCATE rejected by trigger |
| `produce_category_deliveries` | 20261023100000 | one row per (candidate, revision, group): pending / retryable / delivered / blocked, attempts, lease, last error code |

Privileges (20261023110000): RLS on; `PUBLIC`, `anon`, `authenticated` have
nothing; `service_role` has **SELECT only**, including against Supabase's broad
default ACL. Every write goes through a SECURITY DEFINER RPC (pinned
`search_path`, migration-role owner, EXECUTE for `service_role` only):
`observe_…`, `decide_…`, `claim_produce_category_deliveries`,
`complete_produce_category_delivery`, `requeue_produce_category_deliveries`,
`produce_category_delivery_health`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CATEGORY_REVIEW_NOTIFY_ENABLED` | unset (off) | `true` sends review cards |
| `CATEGORY_REVIEW_LINE_GROUP_IDS` | empty (fail closed) | the LINE **test group** only, until owner approval |
| `CATEGORY_REVIEW_ADMIN_LINE_USER_IDS` | empty (fail closed) | LINE user ids allowed to decide |

## Notification delivery (durable ledger)

- Each run claims up to 10 deliveries FIFO (candidate created_at, name, group)
  with `FOR UPDATE SKIP LOCKED` and a 300 s lease; each claim is one attempt.
  Overlapping runs never claim the same delivery.
- Push retry key = hash(candidate, revision, group): a re-sent card after a
  crash or lost acknowledgement is de-duplicated by LINE.
- Outcome per recipient:
  - accepted → `delivered`; never sent again for that revision.
  - network / 429 / 5xx / **401 / 403** → `retryable`; retried on later runs,
    so a fixed token or group permission recovers automatically.
  - any other 4xx → `blocked` at once.
  - `retryable` after 5 attempts → `blocked` (bounded, no flooding).
- `blocked` rows leave the queue, so they cannot starve later candidates;
  `?requeue=blocked` puts them back with a fresh attempt budget.
- Partial delivery is per group: a delivered group is not re-sent when
  another group is recovered.
- Only the current revision of a pending candidate is ever claimed; a stale
  card cannot be approved (`decide` checks the revision).
- The cron response reports this run's `notified / retrying / blocked` and
  `queue` counts by status. The ledger stores only an HTTP status label — no
  token, payload or raw error text.

## Risk assessment

| Risk | Control | Evidence |
|---|---|---|
| Wrong category in a report | admin-only rule, one snapshot per report incl. manual `สรุปคงเหลือ` | unit 1–3, 9; concurrency tests; webhook manual-stock test |
| Identity / SKU merge | rules key on exact name, store category only; no alias, code or vocabulary change | diff touches no `product-vocabulary`, `dictionary.ts`, fingerprint code; test 5 |
| Money / quantity change | category is grouping only | test 8; financial guard suites (settlement, reconciliation, fingerprint, dedup) |
| Leak to operational groups | send + reply only for `CATEGORY_REVIEW_LINE_GROUP_IDS`; other groups silent, no DB read | webhook + review tests |
| Unauthorized approval | group AND admin allowlist, fail closed when unset | tests 7, unauthorized alias test |
| Audit bypass by a privileged role | service_role SELECT-only; TRUNCATE trigger | PG grants suite under broad default ACL |
| Replay / double tap / race | raw-event dedup, event-id unique, row lock, revision | PG: replay, stale, 3-way race |
| Rule table unavailable / partial | last complete snapshot, else code rules; never partial | P2 + failure tests |
| Lost / duplicated / starved cards | per-recipient ledger, lease, stable retry key, bounded retries, blocked excluded | PG delivery suite (401 / 403 recovery, 400 block, overlap, lease, revision) |
| Ingestion / daily close blocked | no rule read on ingestion path; discovery is its own cron | test 10, ordinary-message test, route test |

## Migration preflight and rollback (owner-run)

Preflight on the target database, read-only:

```sql
SELECT to_regclass('public.produce_category_candidates'),   -- expect NULL
       to_regclass('public.produce_category_rules'),        -- expect NULL
       to_regclass('public.produce_category_decisions'),    -- expect NULL
       to_regclass('public.produce_category_deliveries');   -- expect NULL
SELECT current_setting('server_version_num')::int >= 130000; -- gen_random_uuid, normalize()
SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname = current_database(); -- UTF8
SELECT pg_has_role('service_role', current_user, 'MEMBER');  -- expect false (definer owner)
```

Apply in order, all additive and transactional:

1. `20261022120000_produce_category_learning.sql`
2. `20261022130000_produce_category_announce_queue.sql`
3. `20261023100000_produce_category_delivery_ledger.sql`
4. `20261023110000_produce_category_privilege_hardening.sql`

Deploying the app before the migrations is safe: rule loads fail and reports
fall back to the code rules. Keep `CATEGORY_REVIEW_NOTIFY_ENABLED` off and do
not schedule discovery until all four are applied.

Rollback, exactly in reverse (`supabase/rollback/*.down.sql`): 20261023110000
→ 20261023100000 → 20261022130000 → 20261022120000. Export
`produce_category_decisions` first if the audit must be kept. No business
table is touched; reports return to code-only rules (restart the app to drop a
warm process's last snapshot). Proven on PostgreSQL 17 under the broad default
ACL: forward → down → forward, with `produce_transactions` byte-identical.

## CI

`pg-tests.yml` job `category-learning` (Bun 1.4.3, PostgreSQL 17 service):
both PostgreSQL suites with `REQUIRE_CATEGORY_LEARNING_POSTGRES=1` (no silent
skip; all four migrations and rollbacks, broad default ACL, RPCs as
service_role), focused unit / webhook / manual-stock / route tests,
report-surface regressions, settlement / reconciliation / fingerprint / dedup
guards, `tsc`, `eslint --max-warnings=0` on the feature files, `git diff --check`.

## Preview UAT (isolated)

Requirements: a Preview deployment pointed at a **non-Production** Supabase
database with all four migrations applied, and a **test-only** LINE group.
Never point Preview at Production data or an operational group.

## UAT checklist (test group only)

1. Apply all four migrations to the isolated database; deploy a Preview against it.
2. Set the three env vars to the test group and one admin user.
3. `GET /api/cron/category-discovery` with the cron secret → JSON shows `discovered`, `notified`, `queue`.
4. Test group receives at most 10 cards; Operations groups receive nothing.
5. Re-run discovery → no new card for unchanged candidates.
6. Admin taps "เลือก: ผัก" on a card → reply `✅ บันทึกแล้ว … → ผัก`.
7. Tap the same button again → `ℹ️`/`⚠️` reply; one row in `produce_category_decisions`.
8. A non-admin member taps a button → `⛔ ไม่มีสิทธิ์…`; no decision row.
9. Next Stock Summary, Morning Brief LINE + PDF **and manual `สรุปคงเหลือ`** show the name under ผัก; totals and quantities equal the previous run.
10. Tap "📦 เป็นสินค้าอื่นๆ จริง" on another card; re-run discovery → no new card for it.
11. `มะละกอดิบ` is under ผัก and `มะละกอ` under ผลไม้ in all reports.
12. Stop discovery (or break the DB URL) → Produce ingestion and daily close unaffected.
13. Temporarily set a wrong LINE token on the Preview → run → `retrying` > 0, no card; restore the token → run → each card arrives once per group.
14. Remove the bot from a second test group (403) → only that group stays `retryable`; re-add → only that group receives the card.
15. After 5 failed runs a delivery is `blocked`; `?requeue=blocked` restores it.
