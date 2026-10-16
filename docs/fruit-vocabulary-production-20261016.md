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

Classification-only field spellings (NOT product aliases):

- เซียนทัอ / เซัยนท้อ (possible เซียนท้อ)
- สัปปรด (possible สับปะรด)
- แก้งมังกรแดง (possible แก้วมังกรแดง)
- อง่นคิมสัน (possible องุ่นคิมสัน)
- สาลึ่หิมะ (possible สาลี่หิมะ)
- แตงโมง (possible แตงโม)
- ผลไม้กลอ่ง (possible ผลไม้กล่อง)
- ว้มโอ (possible ส้มโอ)

These spellings retain their ORIGINAL distinct business identities. Independent
P1 review found that adding global product aliases immediately could bypass
old session dedup fingerprints on replay and alter historical calculated values.
Do not enable aliases until backwards-compatible dedup reservations and financial
parity have been implemented and separately reviewed. This release changes only
fruit classification for these observed spellings.

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

- Focused Bun tests cover dictionary/CSV/migration parity, parser price and
  quantity parity, distinct varieties, stock classification and validation.
  The original run before the P1 safety adjustment had 801 passes; verify the
  final classification-only release separately before applying to Production.
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

No new product identity aliases are activated in this release. Historical
business fingerprints and financial matching remain unchanged. Stock category
headings will improve, including exact known fruit names; displayed historical
category totals may shift. Production SQL and deployment must be verified with
read-back and smoke checks. Alias compatibility remains separate future work.
