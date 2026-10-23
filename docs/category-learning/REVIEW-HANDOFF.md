# Independent review handoff — PR #187

Review the PR head SHA stated in the PR description, against `origin/main`.
Scope: category classification only. Out of scope: PR #158, PR #174.

## High-risk code

| File | Functions | What to check |
|---|---|---|
| `src/lib/produce/product-code/category.ts` | `approvedCategoryFor`, `buildCategoryPolicy`, `setCategoryPolicySource`, `dictionaryCategoryFor` | business rules always present; no mutable shared policy; outside a report only code rules |
| `src/lib/produce/category-learning/rules.ts` | `fetchAllRules`, `loadApprovedCategoryPolicy`, `withApprovedCategoryRules`, `enterCategoryPolicy` | keyset paging complete; any error → last complete snapshot, never partial; `enterWith` only called in the route function after an await |
| `src/lib/produce/category-learning/review.ts` | `handleCategoryReviewPostback`, `parseCategoryReviewPostback`, `buildCategoryReviewMessage` | group + admin check before any DB read; alias category resolved server-side; label ≤ 40 code points |
| `src/lib/produce/category-learning/discovery.ts` | `runCategoryDiscovery`, `needsCategoryReview`, `suggestCategory` | notify opt-in; FIFO queue; 4xx skip vs retryable stop; retry key stability; suggestions never change identity |
| `src/lib/line/webhook-service.ts` | `pcat1` branch in `processOne` | runs after raw-event persist (replay = duplicate) |
| `src/app/api/cron/{daily-stock-summary,daily-morning-brief,daily-summary}/route.ts`, `src/lib/summary/stock-summary-service.ts` | policy pinning | snapshot pinned before classification, covers PDF + messages |
| `supabase/migrations/20261022120000_produce_category_learning.sql` | `observe_produce_category_candidate`, `decide_produce_category_candidate` | SECURITY DEFINER search_path; event-id idempotency; `FOR UPDATE`; stale revision; alias target must equal reviewed `similar_product_name`; append-only trigger; grants |
| `supabase/migrations/20261022130000_produce_category_announce_queue.sql` | `needs_announcement` | generated expression matches the notifier |
| `supabase/rollback/2026102212*.down.sql`, `2026102213*.down.sql` | | reverse order, no business table |

## Commands

```bash
bun install
bun test src/lib/produce/category-learning/category-learning.test.ts src/lib/line/webhook-category-review.test.ts src/app/api/cron/category-discovery/handler.test.ts
ALLOW_DISPOSABLE_POSTGRES_TESTS=1 REQUIRE_CATEGORY_LEARNING_POSTGRES=1 PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres bun test src/lib/produce/category-learning/migration-category-learning.pg.test.ts
bun test src/lib/summary src/app/api/cron/daily-morning-brief src/app/api/cron/daily-stock-summary src/lib/line/daily-summary-cron.test.ts src/lib/line/daily-summary-message.test.ts
npx tsc --noEmit
```

The repository-wide `bun test` hangs on `origin/main` too. Compare scoped runs
against `origin/main` instead; the 11 failures there are pre-existing.

## Races to probe

1. Two admins tap different buttons on one card at the same time: exactly one `applied`, the other `stale`.
2. LINE redelivers the same postback event: `duplicate`, one decision row.
3. Discovery re-observes a pending candidate with a new suggestion while an admin taps the old card: revision bump → `stale`.
4. Two discovery runs overlap: same rows, same retry keys; `notified_revision` set only with `revision` unchanged.
5. A report starts, another report refreshes rules, the first resumes: the first keeps its snapshot.

## Authorization

- Fail closed: an empty `CATEGORY_REVIEW_LINE_GROUP_IDS` / `CATEGORY_REVIEW_ADMIN_LINE_USER_IDS` allows nothing.
- Non-group sources and other groups get no reply and no DB read; non-admins in the review group get a refusal with no candidate data.
- Identity comes only from the signature-verified webhook `source`; nothing in the postback data is trusted for identity or for the alias category.

## Invariants that must hold

- `มะละกอดิบ` → ผัก, `มะละกอ` → ผลไม้, and they stay two products.
- `เต้าหู้แผ่น`, `ปลาทู`, `ขนมจีน` stay other and raise no review.
- No change to transactions, quantities, prices, satang totals, fingerprints, product codes, `PRODUCT_ALIASES` or vocabulary.
- An approved rule affects the next report without a deployment.
- LLM/API failure cannot block ingestion or daily close: no LLM in this PR, and no rule read on the ingestion path.
