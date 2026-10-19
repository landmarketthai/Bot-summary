# Bot-summary — Global Slip Deduplication P0/P1 (19 October 2026)

## Intent
A payment must not be auto-counted more than once when a LINE receipt is posted
to multiple markets, including Thai Help Thai / G-Wallet receipts.

## Implemented
- **P0**: EXTRACTED and PARTIAL_EXTRACTED rows lacking a non-empty reference ID
  are excluded from trusted slip-batch totals, with a visible manual-review reason.
  The database guard also downgrades newly verified rows without a reference to NEED_REVIEW.
- **P1**: PostgreSQL BEFORE INSERT/UPDATE trigger serializes new verified references,
  using transaction-scoped advisory locks. A second accepted use of a reference is
  downgraded to NEED_REVIEW with an audit-friendly failure reason.
- **P1**: Exact byte-identical image SHA-256 values across groups/markets are also
  serialized; the subsequent claimant is held for review, even if the OCR reference
  differs.
- LINE per-image messages read persisted status after the trigger, and batch
  summaries surface duplicate-reference, duplicate-image and missing-reference reasons.
- Historical duplicates remain physically present. Existing read-time global-winner
  logic continues to exclude losing historical records without destructive cleanup.

## Security and limitations
- SHA-256 matching is exact, not perceptual. Re-cropped, compressed or newly
  photographed images can have different hashes. Repeated reference IDs still
  cover those cases; absent reference IDs are held for manual review.
- Missing reference is **unknown**, not proof of fraud or proof of a duplicate.
  It must not become a verified payment without authorized human reference resolution.
- Older data without reference IDs is not retroactively modified by the migration.
  It is already excluded from reconciliation; newly rendered batches exclude it.
- A duplicate attempt remains as a NEED_REVIEW evidence record for audit, never deleted.
- Do not merge this work blindly with PR #182: both touch slip ingestion/check-service
  and batch finalization. Rebase after #182 and repeat all tests.

## Verification completed
- Isolated PostgreSQL integration test creates a disposable local DB, reapplies
  the migration, starts concurrent submissions, and checks that exactly one
  conflicting reference is verified. Also tests same-image collision, missing
  IDs, and re-admission of the original record.
- Focused Bun slip tests passed; TypeScript --noEmit passed.
- Nothing has been applied to production.

## Release gate (do not skip)
1. Rebase atop approved ingestion remediation (#182 or its final merge), resolve
   source conflicts without losing existing evidence retry/recovery guards.
2. On a non-production DB with migrated schema, run integration PostgreSQL proof
   and the full slip, settlement, LINE and ledger test suites.
3. Replay original + exact image duplicate in another market, same reference
   with different image, simultaneous submissions, absent ID, partial OCR,
   distinct legitimate same amounts, and historical duplicates.
4. Verify LINE notifications, global winner reconciliation, settlement
   accountability/white-sheet and retries without double accounting.
5. Confirm migration precedes application rollout. Do NOT switch the application
   while trigger is absent; the app relies on persisted status to report collisions.
6. Take a data-free preflight snapshot of constraint/triggers. Only then stage
   and deploy with production approval. Monitor held reasons and trusted totals.
7. Rollback plan: revert app deployment first, then disable the new trigger
   only if explicitly approved after evaluating potential double-count exposure.
   Do not modify or delete historical evidence.

## Open engineering work beyond exact-match safety
- Perceptual fingerprint (dHash/pHash) for resized/cropped near-duplicate evidence,
  with manual-review only, false-positive evaluation and retention policy.
- Full end-to-end UAT through real LINE webhook + migrated staging DB and integration
  with the pending PR #182 image-ingestion remediation.
