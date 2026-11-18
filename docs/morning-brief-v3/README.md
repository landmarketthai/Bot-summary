# Morning Brief V3 — review and staged operation

Status: **Release/activation NO-GO pending remaining gates.** Synthetic local
tests, reconstructed migration replay and isolated SQL/extension tests are
recorded in [release-validation.md](release-validation.md). GitHub CI,
independent code review, isolated staging and operator release gates must pass
before production rollout. Exact package lock and historical migrations are
unchanged. No actual production records, recipient identifiers or credentials
are included in this repository's test fixtures or release evidence.

## Identity and financial reconciliation

Only the existing qualified interpretation หนูเล็ก-พาซีโอ้, or seller exactly
หนูเล็ก with one of the three existing bare Pasio spellings, resolves to Vegetable.
Explicit reviewed qualified Fruit markets remain Fruit. A historical bare-label alias establishes spelling equivalence, not a Fruit business mapping. No new
business mapping, catalog edit, historical round repair or fingerprint change is made.

Bare Pasio, unknown labels and bound rows with missing/cancelled/wrong-date rounds
remain in an explicit **unassigned** review bucket, outside both assigned totals.
It contains source transaction IDs, reason counts, calculated confirmed/pending
subtotals, withdrawal money and unavailable sales counts. Unvalued/missing withdrawal
money is null; no recorded withdrawals is zero. Unknown sales include an
incomplete-total warning. Fruit PDF/LINE warn even when there is no assigned
produce. Only Fruit carries this review bucket (shown **once**); Vegetable LINE,
PDF and reference JSON exclude its money and source IDs. Reconciliation adds it once:
Fruit + Vegetable + unassigned = comparable legacy confirmed/pending/withdrawal money.
Raw withdrawal review money uses the existing exact source-line calculator;
sub-satang aggregation can differ from legacy per-identity rounding, so only
equivalent rounding/grouping is directly comparable.

Known qualified legacy Fruit remains attributable without a round. An unrelated
unknown market stays visible without blocking otherwise ready Vegetable. Plausible
Vegetable ambiguity (Pasio, vegetables, absent identity or the qualified seller)
fails closed unless an explicit reviewed Fruit identity resolves it. This substring
review trigger never assigns a business. Reasons distinguish unbound, missing,
cancelled, wrong-date and unreviewed Vegetable identities. QA sources are excluded,
including conflicting display labels on referenced QA rounds.

Vegetable requires withdrawal (เบิก/เบิกเพิ่ม) and good return (คืน/ชั่งคืนเพิ่ม)
in every known noncancelled Vegetable round on that business date. Damage-only
returns never qualify. Any unresolved pending document on a known or potentially
Vegetable noncancelled round also blocks, regardless of document type or raw text.
Only finalized, duplicate and expired_empty_draft are resolved, matching
RESOLVED_PENDING_STATUSES. Open rounds can be ready; no closed-status gate exists.
Empty known rounds block; use the existing operational
review process for abandoned rounds. Only effective produce_transactions is read,
never the archive. SQL context and the app's loaded evidence both must be ready.
This is an as-of snapshot, not a promise against future late amendments. It does
not certify all markets or all quantities/prices are complete, and adds no resend
behavior. Verify live effective-view and round-status parity privately before rollout.

## Schedule and delayed arrival

Fruit remains **12:00 Bangkok**. Vegetable keeps exactly nine scheduled slots:
14:00, 14:30, 15:00, 15:30, 16:00, 16:30, 17:00, 17:30, 18:00.
UTC cron is Fruit 0 5 * * *, Vegetable 0,30 7-10 * * * plus 0 11 * * *.
No 18:30 invocation or extra scheduled poll is introduced.

Each original slot accepts arrival for five minutes, excluding the five-minute
boundary: Fruit 12:00:00–12:04:59.999; final Vegetable 18:00:00–18:04:59.999.
SQL and TS associate the grace with the original slot/dedupe key. The app passes
one captured arrival time to SQL preflight, avoiding two timing decisions when
clocks/minutes straddle. Configured calls outside grace return sanitized HTTP 409
outside_window and a warning. Vegetable manual sends also obey the slots/grace.
Debug is read-only and can preview outside the slots.

Normal runs report yesterday's business date. SQL seeds outstanding target/date
rows even when unready, then checks readiness/acceptance before queuing HTTP.
Unique date/scope/check-date/original-slot keys dedupe concurrent delayed dispatch.
Only already outstanding date-minus-two reports get one first-slot recovery
opportunity, Fruit noon or Vegetable 14:00. No older history is scanned.

**Residual risk:** Fruit has one scheduled attempt. Grace handles short arrival
delay, not loss/failure after grace. Next-day noon is 24h after a noon attempt,
outside the conservative 23h retry cutoff. Early Vegetable attempts can also
expire before next-day 14:00; late 18:00 attempts can still fit. These cases need
operator review. There is no authorization to add slots or reset retry clocks.

## Frozen delivery, runtime and retention

Ledger identity is business date + scope + SHA256 of the existing exact target.
Claim/lease/fence/freeze/prepare/accept preserve the original text/PDF bodies,
artifact path, URLs, order and individual retry keys. Accepted targets skip all
report/render/push work. Unknown outcomes retry the same prepared part/key.
Acceptance means LINE accepted a request, not recipient receipt/read.

A five-minute lease fences old workers. First attempts at least 23h old become
needs_review; frozen payloads at least six days old also stop before their seven-day
URL expires, including never-attempted payloads. Operator reset/delete/recreate or
reissue of a delivery is forbidden: deterministic keys do not define a new
generation. Never renew a frozen URL in place, delete acceptance evidence, or use
retry_nonce to bypass delivery state. Artifact
paths include the lease identity so a stale renderer cannot overwrite a frozen PDF.

The route stops starting targets/parts after 195s; each LINE call has a 15s timeout.
It returns 503 pending with deferred counts and resumes frozen progress at an
eligible existing slot. Six requests per target (five text parts plus PDF) can
consume 90s of provider timeout alone. DB/storage/render work and actual host-plan
limits still constrain the 240s route cap; arbitrary target counts are not promised
to finish. The manual workflow waits 250s. LINE batching is deferred because it
would change frozen request/key and partial-acceptance semantics.

Failures expose only fixed stage/error codes and counts (500 failed); missing schema returns
503 schema_unavailable before claim/render/push; human review returns 409
needs_review, ahead of not_ready/pending status. sent/sentCount/pdfDelivered refer
to newly accepted ledger deliveries in this request; previouslyAcceptedCount is
separate. Configured routes check exact private SHA256 target-set parity before
claims/render/push and return count-only 409 target_config_mismatch for drift,
empty targets or absent/disabled config. Scheduled legacy-marker dispatch explicitly provides `scheduled=1`, one
`target_marker` and business date. It resolves the existing group and checks the
same private parity and slots as configured ENV sends; empty/disabled legacy
ENV values need no change. A changed target fails closed. Manual isolated
UAT/debug bypass this parity gate, keeping schema/ledger/slot protections.
No configuration is seeded.
Each deduplicated scheduled check records a sanitized outcome (not_ready, invoked,
accepted, busy, review, skipped, enqueue_failed). Invoked means queued, not LINE
acceptance. A final blocked slot emits at most one scope/outcome LOG observation;
no external alert is sent. Operators inspect checks/ledger and scheduler HTTP status.

Do not automatically clean ledger rows or referenced artifacts. Retain accepted
and unknown evidence through reconciliation. Unreferenced render attempts and old
never-attempted pending rows need a separately reviewed retention/sweeper policy.
No automatic cleanup is implemented; bounded recovery intentionally does not sweep
old dates. Backups remain private for rollback/audit and require a separate owner
decision before removal.

## Private command storage and controlled rollout

Config and cron backups live in the non-exposed morning_brief_private schema,
with RLS and all access revoked from PUBLIC/anon/authenticated/service_role.
Only the reviewed owner has access by default. The template guard requires a
single SELECT net.http_get prefix and rejects semicolons/comments. Privately strip
trailing whitespace, then remove exactly one terminal semicolon when staging;
never remove interior semicolons or rewrite expressions. Verify that the existing private statement matches these constraints before staging. Preserve URL, headers, timeout, and
the existing auth/Vault expression. This guard is not a SQL parser: nested
expressions still require trusted private review. No auth expression is invented,
and commands/headers/signed URLs must never be logged or copied into tickets.
A BEFORE trigger emits a fixed validation error instead of a CHECK failure that
could echo the secret-bearing row. Operator transport/SQL statement logging must
also be privately reviewed; this task changes no database logging/security settings.

Operator steps below require verified release gates; they are not executed merely by applying this migration:

1. Rerun revised disposable PG17 tests, full evidence-backed migration replay and
   real pg_cron/pg_net integration on synthetic isolated inputs. Keep network
   delivery disabled. Verify catalog/TS labels, transaction vocabulary, status,
   effective view, RLS and grants. Run staging preview and approved test-recipient
   LINE smoke checks separately.
2. Privately recheck live job owner, schedules, auth/URL/target hashes and duplicate
   senders. Activation validates both reviewed schedules and owner.
3. Apply the additive **inert migration FIRST**, before the compatible app, under
   the reviewed existing cron owner. No config is seeded/enabled and no cron
   changes occur in the migration. If the normal migration runner differs from
   the cron owner, obtain a separately reviewed DBA ownership/privilege plan.
   Activation refuses a dispatcher definer different from the cron owner, so
   private auth expressions execute under the preserved identity.
4. Suspend existing Morning Brief jobs before app cutover/baseline import. Keep
   dispatch disabled. Establish previous accepted/unknown deliveries per target
   from LINE acceptance evidence, not PDF existence. Import proved acceptance as
   accepted and uncertain sends as needs_review; no empty-ledger replay.
5. Deploy the compatible app while jobs remain suspended. Verify context/delivery
   RPCs and sanitized missing-RPC behavior, preserve existing auth/target env
   values, and check synthetic previews. No live app-first deployment.
6. Privately stage disabled config rows for both scopes with exactly matching
   SHA256 target lists and explicit date=__BRIEF_DATE__. Where the operator confirms
   a shared legacy group, preserve the original Fruit marker in both scope
   templates and add `scheduled=1`; retain each scope's auth and HTTP settings.
   No environment-target change is needed. Verify the marker resolves uniquely
   to the approved group, not the UAT group. Reject manual target/debug/nonce,
   duplicate dates and extra statements. Review all gates.
7. In a deliberate transaction set LOCAL morning_brief_v3.activate = 'reviewed'
   and run activate.sql. It privately backs up two original jobs including owner,
   preserves active flags and installs exactly the approved schedules. Suspended
   jobs stay suspended. Verify safe metadata, then separately authorize controlled
   unsuspension and observe acceptance counts/state.

Rollback first suspends delivery, then runs rollback.sql in one reviewed
transaction with LOCAL morning_brief_v3.rollback = 'reviewed'. It checks preserved
ownership/original jobs, disables config, restores exact saved commands/schedules
suspended, and removes only the owned final-slot job. Preserve ledger/backups/
artifacts; an app rollback must not reactivate a legacy sender that ignores
acceptance. Reconcile accepted/unknown outcomes before any legacy resumption.
Rollback deliberately preserves private backups, so reactivation refuses
"Backup already exists". Before a separately reviewed new activation, the owner
must archive those backups durably in private storage with owner/job IDs, exact
commands, schedules, original active flags and rollout identity intact. Verify
the archive before removing only the archived working backup rows. Never discard
or overwrite rollback evidence; no archival/cleanup is performed by this task.

## Synthetic verification

The PR-only morning-brief-v3-pr workflow runs exact npm ci, separate summary/PDF/
migration, route, LINE and actual local PG17 processes, typecheck, scoped lint and
synthetic build, with no secrets or external sends. Its guard rejects skipped or
zero-test results even if Bun exits zero. Actual pg_cron/pg_net remain a separate
operator gate. Local commands/results are in release-validation.md.

Six renderer fixtures contain 140 products and 66 market rows over 37 A4 landscape
pages. Only normal Fruit includes a review page; overflow/stress remain seven pages
each. Preserve 20pt body/product/market content, 26pt cover title, 24pt repeated
titles, 36pt sales hero, colored stock/KPIs, exact zero versus unknown values,
unit totals and repeated headers. Empty market pages and empty categories are
omitted; meaningful diagnostic pages remain. Engineering decision for review:
retain data quality, true unknowns and real zero evidence as required for truthful
reporting, without inventing quantities or new business identities.

The existing Sarabun font change uses the declared SIL-OFL dependency for an
offline build; manifest-test reconciliation matches already-recorded repository
history. Neither changes dependencies or historical migrations. Generated
output/ artifacts are ignored. No production snapshot is loaded for testing.

Historical reports remain **dry-run review only**. A future
approved review must reconcile each target's prior acceptance and every source/
quantity/amount/identity before considering an explicit manual send. No historical
loop, reset or new backfill authorization is included here.
