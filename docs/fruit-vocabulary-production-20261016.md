# Production fruit vocabulary rollout — 2026-10-16

Prepared on `fix/fruit-vocabulary-production-20261016`. The owner handles review,
migration execution and application deployment. No Production query or mutation,
push, merge or deployment was performed while preparing this change.

## Exact scope

| New code | Distinct canonical product |
| --- | --- |
| ม99 | ส้มจีน |
| ม100 | ส้มสายน้ำผึ้ง |
| ม101 | กล้วยเล็บมือนาง |
| ม102 | มะขามป้อม |

CSV is authoritative; `node scripts/generate-product-code-dictionary.mjs`
regenerates the runtime module. Repository totals become 327 codes, including
102 fruit codes. Existing codes, names, grades and orange varieties retain their
identities. No historical rows or financial arithmetic are changed.

Reviewed exact aliases only:

- เซียนทัอ / เซัยนท้อ → เซียนท้อ (ม12)
- สัปปรด → สับปะรด (ม49)
- แก้งมังกรแดง → แก้วมังกรแดง (ม07)
- อง่นคิมสัน → องุ่นคิมสัน (ม68)
- สาลึ่หิมะ → สาลี่หิมะ (ม83)
- แตงโมง → แตงโม (ม14)
- ผลไม้กลอ่ง → ผลไม้กล่อง (พ01)
- ว้มโอ → ส้มโอ (ม47)

The 51 observations of แก้วขมิ้น establish usage, without enough supplied
same-SKU evidence for an identity alias to มะม่วงแก้วขมิ้น (ม72). It remains
classification-only, as do มะม่วงจิ๋ว, ฝรั่งแดงตำหนิ and มังกรแดง.

Stock classification preserves its existing explicit categories, then uses only
the exact dictionary fruit category as a fallback. The existing approved special
fruit packs from `produce-section.ts` are listed exactly: ผลไม้กล่อง, ขนุนแพ็ค,
ส้มโอแพ็ค, สับปะรดแบบหัว. Other special items and unknown names are not inferred.
The dictionary category module depends only on generated data, preventing a
dependency cycle back through summary or identity normalization.

## Owner rollout

1. Review only migration
   `supabase/migrations/20261016113744_produce_product_dictionary_add_production_fruit_vocabulary.sql`.
   It was created with Supabase CLI 2.110.0 using `npx supabase migration new`
   after inspecting help (offline cached CLI in this workspace).
2. Recheck the Production target and migration ledger through the normal release
   process. Confirm ม01..ม98 exist, ม98 is enabled ลูกพลุน / ม / ผลไม้, and none
   of the four new names belong to another code. Review pending migrations
   individually; do not apply an unrelated backlog as part of this change.
3. Apply the reviewed migration as one transaction before deploying the app.
   The only data mutation is the four-row INSERT. No schema changes, updates,
   deletes or history backfills occur. Exact existing target rows, including a
   partial application, are accepted. Conflicting names, categories or enabled
   states abort; so do missing baseline codes or additional fruit codes.
   A catalog write lock prevents races; lock timeout is 5 seconds and statement
   timeout is 30 seconds. Retry a lock timeout after the competing writer ends.
4. Confirm all four mappings and 102 fruit codes. Other namespace counts are
   deliberately not assumed by this Production migration. Deploy the matching
   application, then smoke-check coded intake and stock grouping in the normal
   release test environment, preserving prices, quantities and units.
5. If application rollback is needed, keep released catalog codes. Do not delete,
   repoint or backfill them. Stop and review a catalog mismatch rather than
   weakening migration guards.

## Validation and remaining risk

- Focused Bun run: 801 passed across 14 files (`--timeout 20000`), including
  dictionary/CSV/migration parity, parser price and quantity parity, aliases,
  distinct variants, stock reports, validation and fingerprint compatibility.
- Disposable local PostgreSQL 17: 24 passed, including full migration composition,
  exact rerun, partial application, all target-field conflicts, duplicate identity,
  baseline drift and forced postflight failure with atomic rollback. Historical
  transaction quantities and prices remain unchanged in the real-schema harness.
- `tsc --noEmit` and scoped ESLint: passed.
- Broader checks exposed eight existing failures: seven migration-manifest
  assertions still expect 96 historical entries while the committed manifest has
  99, and one Morning Brief financial-section expectation. All eight reproduce
  with the unchanged HEAD dictionary and stock category module; they are left
  for their own fixes. The initial 5-second pathological reply timeout passes in
  the focused run with a 20-second test timeout.

Aliases affect in-memory report aggregation, validation and business fingerprints,
including reads of older raw names. Stored evidence and monetary values remain
untouched, but displayed grouping may change. Existing product-alias fingerprint
compatibility does not cover replays of documents hashed before a newly added
alias; coordinate replay/recovery across the release boundary. No new compatibility
scheme is introduced here. Production execution and deployed smoke checks remain
the owner's responsibility.
