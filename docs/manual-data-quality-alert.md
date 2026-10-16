# Manual daily DQ test-group pilot — release BLOCKED

This worktree adds a read-only alert and a manual workflow only. No schedule is
installed. No real LINE push, production connection, secret setup, migration,
deployment, commit, push or merge is part of this implementation.

The endpoint is `GET /api/cron/daily-data-quality-alert`, protected by Bearer
`CRON_SECRET`. Missing auth configuration fails with 500; wrong auth fails with
401. `date` must be a real, exact `YYYY-MM-DD`; omission uses the existing
previous Bangkok business-date helper (04:00 cutoff). At 03:59 Bangkok on
October 16 the default is October 14; at 04:00 it is October 15.

`debug=1` always previews, even without a target or activation flag. It still
requires cron auth and complete data. With debug absent/0, the endpoint returns
`ok: true, status: inactive, sent: false` without reading data unless both are set:

- `BOT_SUMMARY_DQ_ALERT_ENABLED` is exactly `true`.
- `BOT_SUMMARY_DQ_ALERT_TEST_GROUP_ID` is exactly `C` plus 32 lowercase hex digits.

No query target override is accepted. HEAD cannot send. Pilot activation remains
off by default; never configure production activation without explicit user
approval. The workflow requires an approved HTTPS deployment origin in repository
variable `DQ_ALERT_BASE_URL`; there is no production URL fallback. It has only
`workflow_dispatch`, defaults to debug, and does not retry the HTTP request.

The reader loads existing OPEN issues by exact `business_date`, plus
`produce_items JOIN produce_sessions` by exact `session_date` with `voided_at IS
NULL`. It never filters by `created_at`, reads raw chat, runs the DQ scanner,
writes data, changes severity, or corrects names/amounts. Material return-exceeds
means excess ≥10 units, or ≥1 unit and ≥25% of withdrawal, with consistent numeric
snapshot evidence. Selection includes every CRITICAL/ACTION_REQUIRED issue,
material return-exceeds issue, and OPEN `produce_unknown_product` issue, including
ADVISORY. An unknown-product advisory stays ADVISORY. These groups may overlap;
`selectedIssues` counts each selected case once. The inbox
can be stale or absent: a zero count only describes existing issues, not a new
audit. `raw_messages.is_processed=false` for item lines is normal.

Product grouping uses existing deterministic product normalization, then checks
`stockCategoryFor` and `resolveApprovedProductName` independently. The anomaly
union includes every stock-uncategorized name **or** name without an approved code,
regardless of stock category. For example, `กล้วยเล็บมือนาง` is already stock fruit
but lacks an approved code, so it must appear in the missing-code group.

Counts distinguish item rows from distinct normalized names:

- `anomalyItems` / `anomalyNames`: the union, counted once per row/name.
- `uncategorizedItems` / `uncategorizedNames`: all stock-uncategorized rows/names.
- `missingCodeItems` / `missingCodeNames`: all missing-code rows/names, including
  products already classified as fruit, vegetables or durian.
- `approvedMissingCategoryItems` / `approvedMissingCategoryNames`: approved-code
  rows/names that remain stock-uncategorized. Together with missing-code counts,
  these form the disjoint union; do not add uncategorized and missing-code counts.
- `unknownProductIssues`: selected OPEN unknown-product cases, including ADVISORY.
  DQ cases and item rows are signals from separate sources that may describe the
  same product. They must never be added into a combined incident count.

The display has three disjoint groups: missing code and uncategorized stock,
missing code with an existing stock category, and approved code with uncategorized
stock. Each shows row/name totals and up to five names by descending row count,
then name. Each omitted-name count applies to that group; `omittedNames` is their
sum. This keeps lower-frequency categorized missing-code products visible even
when other groups have many names. `produceSectionOf` supplies a hint, not an
automatic category correction. No aliases or dictionary entries are written.
Only short Thai product labels are rendered; unsafe labels are redacted. Issues
are shown as curated category totals (up to ten categories, plus omission count),
with overall urgent, material-return and unknown-product counts always shown,
never IDs, free-form context or raw summaries. Reports stay within 4,500 characters;
the reader retains a fail-closed size check.
Each source is bounded at 20,000 rows in pages of 500 with exact remaining counts;
missing counts, truncated pages, duplicate IDs or count drift fail with 500 and
no send. Separate SELECTs are not a transaction snapshot: concurrent edits with
unchanged counts can escape drift detection. Use a stable test dataset for UAT.

Delivery uses `pushLineMessage(to, text, retryKey)` and a SHA-256-derived UUID
based only on namespace, date and exact target. Debug never calls it. LINE 409
with that key is successful `already_accepted`. Other send failures return 502;
delivery may be unknown after a timeout. Retry with the same date/target and key,
never introduce a revision to force delivery. LINE's retry-key retention is
finite; this is not a permanent local delivery ledger. Do not rerun old dates
expecting indefinite deduplication. The existing preview digest text is never
sent by this endpoint.

## UAT required before release

1. Use a Preview deployment and a test database containing synthetic known-code,
   categorized missing-code (`กล้วยเล็บมือนาง`), uncategorized missing-code
   (`ส้มจีน`), approved-but-uncategorized (`แก้วมังกรแดง`), duplicate-name,
   voided, wrong-day and OPEN unknown-product ADVISORY fixtures. Confirm no production DB
   connection. Keep activation unset/false for preview verification.
2. Use a dedicated test LINE channel/token, handled by an authorized operator.
   Confirm test group membership, the bot is in that exact group, and the intended
   testers have consented. Manually verify the full exact target in configuration;
   never copy an arbitrary source group from production.
3. An authorized operator configures Preview/test secrets and the workflow origin.
   Run authenticated debug for an exact fixture date. Check the union and separate
   row/name counts, each group's top five and omissions, Thai labels, redaction and
   no outgoing LINE request. Verify all three named products appear when present,
   advisories stay advisories, and urgent/material-return findings remain visible. Check
   incomplete data returns 500 without claiming zero problems.
4. Obtain explicit user approval for the **first real LINE push** to that verified
   test group, then an authorized operator enables the flag and runs debug=false
   manually. Verify message content and exact recipient; run the same date again
   within LINE's retry window and verify `already_accepted` without a second push.
5. Disable the pilot again. Record test evidence and approval. Production release
   and any future scheduling require separate explicit user approval.

Release stays **BLOCKED** until membership, bot presence, dedicated token,
Preview/test DB, exact target and approved first-send UAT are verified. Fixture
tests cannot establish these facts. No real message was sent during implementation.

The P1 regression fixture models 128 item lines and nine OPEN unknown-product
advisories, using synthetic counts rather than a production read: 120 `หมอนทอง`,
2 `ส้มจีน`, 3 `แก้วมังกรแดง`, and 3 `กล้วยเล็บมือนาง`. It verifies 8 anomaly rows /
3 names, 5 uncategorized rows / 2 names, 5 missing-code rows / 2 names, and
3 approved-but-uncategorized rows / 1 name. The nine advisory cases remain
separate from these item counts. This is regression evidence, not verification
of the live October 15 dataset. Activation remains **BLOCKED**.
