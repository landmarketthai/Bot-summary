# Independent review handoff — PR #187

Review the PR head SHA stated in the PR description, against `origin/main`.
Scope: category classification only. Out of scope: PR #158, PR #174.

## Re-review of the 53c6acf findings

| Finding | Fix | Permanent regression |
|---|---|---|
| F1 P1: a 4xx (401/403) was marked announced; no per-recipient state | durable ledger `produce_category_deliveries` (migration 20261023100000) with claim / complete / requeue RPCs; 401/403 retryable (bounded), other 4xx blocked, blocked excluded from the queue | `category-delivery.pg.test.ts`: `F1a: a fixed 401 …`, `F1b: group A delivered, group B 403 …`, 400 block + requeue, bounded retries, overlapping runs, lease, revision |
| F2 P1: manual `สรุปคงเหลือ` ignored approved rules | `processRemainingFruitCommand` fetches and builds inside `withApprovedCategoryRules` | `webhook-manual-stock-category.test.ts` through `WebhookService.processEvents` (fails on 53c6acf, passes now) |
| F3 P2: inherited default-ACL privileges let service_role UPDATE rules / TRUNCATE audit | migration 20261023110000: REVOKE ALL from PUBLIC/anon/authenticated/service_role, GRANT SELECT to service_role, TRUNCATE trigger on decisions | `category-delivery.pg.test.ts`: `F3a …`, `F3b …`, effective privileges, SECURITY DEFINER owner / search_path / EXECUTE, RPC still works |

The five independent cases map to: F1a, F1b, F2 (`manual สรุปคงเหลือ …`), F3a, F3b.

## Round 2 (053313c): exhausted pending delivery after a crash

| | |
|---|---|
| Root cause | claim increments `attempts` before the push; a crash before `complete_…` leaves the row `pending`. At `attempts = max` claim skipped it (`attempts < max`) and requeue skipped it (`blocked`/`retryable` only). |
| Fix | new migration `20261023120000_produce_category_delivery_exhaustion.sql` (rollback `supabase/rollback/20261023120000_produce_category_delivery_exhaustion.down.sql` restores the 20261023100000 definitions). `claim_…` first moves exhausted, unleased, current-revision `pending`/`retryable` rows to `blocked` (token + lease cleared). `requeue_…` also restores `pending` rows with spent attempts, and for every status only when no lease is active, so one `?requeue=blocked&group=` request recovers them. Same signatures; grants kept. |
| Regression | `category-delivery.pg.test.ts` → `exhausted claims after a crash (round 2 P1)`, 7 tests: 1 discovery blocks, 2 ONE handler request recovers (reconciled or not), 3 active final-attempt lease untouched + late completion honoured, 4+5 only A's card, B untouched, no duplicate to delivered, 6 concurrent runs + superseded token ignored, 7 health exact, 8 retry key stable. Rollback test asserts the restored definitions. |
| Before / after | without 20261023120000: 6 fail / 1 pass (test 3, the active-lease guard). With it: 7 / 7. |

```bash
ALLOW_DISPOSABLE_POSTGRES_TESTS=1 REQUIRE_CATEGORY_LEARNING_POSTGRES=1 PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
  bun test src/lib/produce/category-learning/category-delivery.pg.test.ts -t "round 2"
```

## High-risk code

| File | Functions | What to check |
|---|---|---|
| `src/lib/produce/category-learning/discovery.ts` | `runCategoryDiscovery`, `classifyPushFailure`, `requeueCategoryDeliveries` | never records an unsuccessful push as delivered; retry key = candidate + revision + group; outcome recorded with the claim token |
| `supabase/migrations/20261023100000_produce_category_delivery_ledger.sql` | `claim_…`, `complete_…`, `requeue_…`, `…_health` | enqueue only current revisions of pending candidates; `FOR UPDATE SKIP LOCKED` + lease; complete only with the current token; retryable → blocked at max attempts; health exposes counts only |
| `supabase/migrations/20261023110000_produce_category_privilege_hardening.sql` | grants, TRUNCATE trigger | effective privileges under the broad default ACL |
| `src/lib/line/webhook-service.ts` | `processRemainingFruitCommand`, `pcat1` branch | one snapshot per command; no rule read on ordinary Produce messages |
| `src/app/api/cron/category-discovery/handler.ts` | `?requeue=blocked[&group=]` | only `blocked`, only configured review groups |
| `src/lib/produce/category-learning/rules.ts`, `product-code/category.ts` | snapshot pinning | unchanged since 53c6acf |
| `supabase/rollback/*.down.sql` | four scripts | reverse order, no business table |

## Commands

```bash
bun install
bun test src/lib/produce/category-learning/category-learning.test.ts src/lib/line/webhook-category-review.test.ts src/lib/line/webhook-manual-stock-category.test.ts src/app/api/cron/category-discovery/handler.test.ts
ALLOW_DISPOSABLE_POSTGRES_TESTS=1 REQUIRE_CATEGORY_LEARNING_POSTGRES=1 PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
  bun test src/lib/produce/category-learning/migration-category-learning.pg.test.ts src/lib/produce/category-learning/category-delivery.pg.test.ts
# just the five previously failing cases:
ALLOW_DISPOSABLE_POSTGRES_TESTS=1 REQUIRE_CATEGORY_LEARNING_POSTGRES=1 PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres \
  bun test src/lib/produce/category-learning/category-delivery.pg.test.ts -t "F1a|F1b|F3a|F3b"
bun test src/lib/line/webhook-manual-stock-category.test.ts
npx tsc --noEmit
```

The PostgreSQL suites apply the broad Supabase default ACL before the
migrations and run every RPC `SET ROLE service_role`. Codex's own
`review-independent*.js` files exercise the old `notified_revision` contract
and the fake DB without ledger RPCs; the cases above replace them against the
real database.

The repository-wide `bun test` hangs on `origin/main` too; compare scoped runs
with `origin/main` (pre-existing failures are identical).

## Races to probe

1. Two admins tap different buttons on one card: exactly one `applied`, the other `stale`.
2. LINE redelivers the same postback event: `duplicate`, one decision row.
3. A revision changes while its card is in flight: the old revision is never claimed again, its card is `stale`, the new revision is delivered once per group.
4. Two discovery runs overlap: disjoint claims (SKIP LOCKED + lease), no delivery pushed twice.
5. A push is accepted but its outcome is not recorded: re-claimed only after the lease, with the same retry key.
6. A report starts, another refreshes rules, the first resumes: the first keeps its snapshot.

## Authorization

- Fail closed: an empty `CATEGORY_REVIEW_LINE_GROUP_IDS` / `CATEGORY_REVIEW_ADMIN_LINE_USER_IDS` allows nothing.
- Non-group sources and other groups get no reply and no DB read; non-admins in the review group get a refusal with no candidate data.
- Identity comes only from the signature-verified webhook `source`.
- Database: `service_role` SELECT-only on all four tables; writes only through SECURITY DEFINER RPCs owned by the migration role.

## Invariants that must hold

- `มะละกอดิบ` → ผัก, `มะละกอ` → ผลไม้, two products.
- `เต้าหู้แผ่น`, `ปลาทู`, `ขนมจีน` stay other, no review.
- No change to transactions, quantities, prices, satang totals, fingerprints, product codes, `PRODUCT_ALIASES` or vocabulary.
- Approved rules affect the next report, including manual `สรุปคงเหลือ`, without deployment.
- No category-rule read on Produce ingestion or financial close.
