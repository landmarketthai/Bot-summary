# Bot-summary PR #182 — Engineering Review Follow-up, 19 Oct 2026

## Scope, identity, safety
- Worktree: `C:\GitHub\_worktrees\bot-summary-p0-slip-ingest-20261017`
- Branch: `fix/p0-slip-image-ingestion-20261017`; candidate is **uncommitted**; compare Git working tree, NOT only HEAD.
- Historical Independent Review (17 Oct) initially reported 2 P0 + 4 P1 (NO-GO).
- Engineering fixes: Codex addressed both P0; Claude Opus addressed four P1; fresh independent read-only Sonnet 5.5 review on 19 Oct reported **PASS FOR ENGINEERING REVIEW ONLY** for all six original findings, with **NO-GO UAT** until remaining gates.
- Never ran Production queries, remote migrations, real LINE, deploy, merge, push, commit or UAT in this follow-up. All PostgreSQL tests used disposable localhost databases and mocked providers; offline Build had network guard and local-only dummy Supabase variables.

## Verification completed (latest candidate)
- **19 Oct close-out run (latest):** nine-file disposable PostgreSQL gate, including the eight core suites plus the new alert suite: **112 pass / 0 fail / 1,060 assertions**. Latest alert route run: **16/16**; alert PostgreSQL run: **13/13**. Focused caller/unit gate: **214 pass / 0 fail / 25,668 assertions**. Original independent adversarial suite: **5/5**. Original cron hang suite: **1/1**, returning in about **8.07 s**. `tsc --noEmit --incremental false`: exit 0. `git diff --check`: exit 0. Next 16.3.4 webpack build with dummy localhost env and an external-fetch guard: exit 0; generated manifest records alert `maxDuration: 30` and finalize cron `maxDuration: 60`.
- Source lint (`eslint src`): exit 0 with 70 warnings and no errors. Full-worktree `eslint .` is not green: **31 errors / 71 warnings**, with every error under ignored local evidence files in `.tmp-pr182-verification` (`any` and CommonJS); those preserved review artifacts were not rewritten or deleted. This is a local-worktree hygiene deficiency, not a source error, and must not be hidden in release reporting.
- Alert regressions cover disabled-by-default and empty-target dry-run, scheduler bearer auth, missing token/invalid target, missing migration, strict malformed-health rejection, 36-minute floor, concurrent leases, retry/backoff, abort on ambiguous timeout, stable `X-Line-Retry-Key`, simulated LINE 409 already-accepted, accepted-but-ack-lost reconciliation, subsequent recovery, ongoing incident re-alert, stale receipts older than seven days, recipient rotation, hostile error text, migration re-apply, least privilege and rollback. No real LINE request was made.
- Local capacity observation used disposable PostgreSQL and only mock LINE/OCR/Storage: 25 images, observed max 25 ingest calls and 10 OCR provider calls in flight, 25 mock 429 responses with requested 3,000 ms Retry-After, all 25 accounted and completed. In the latest combined gate the instrumented portion took 269 ms and observed peak heap delta 1,168,876 bytes. These are local fake-provider observations, **not** external throughput, quota, latency, memory-sizing or cost claims.
- A new real-PostgreSQL regression sends 26 receipts (one verified, 25 retry-pending), skips every recovery sweep past the approved 2,160-second cutoff, and proves accounting `26 received / 1 attached+OCR-complete / 25 incomplete`, terminal `review_needed`, and an explicit 25-image incomplete notice—never a fabricated 2,600-baht completed result.
- Independent reviewer personally ran original `.tmp-pr182-verification/adversarial.pg.test.ts`: **5 pass / 0 fail** and `.tmp-pr182-verification/cron-budget.pg.test.ts`: **1 pass / 0 fail**; hung LINE push route returned in ~8.06 seconds.
- Earlier P0/P1 engineering suites: 96/96 PostgreSQL across eight files, 185/185 unit/caller tests in owner session; focused unit 101/101; isolated cron route tests 4/4; TypeScript exit 0; Next 16.3.4 webpack Build exit 0 with offline dummy env; Git diff check exit 0.
- **After independent review P2 fixes:** in `schema-compat.pg.test.ts`, permanent `SET LOCAL ROLE service_role` regression test runs the migrated closing claim with an actual queued/attached image and checks no helper privilege for anon/authenticated. Independently retested: **9/9** schema compatibility tests pass. Entire eight-file PG gate re-run: **97/97 pass, 0 fail**; `tsc --noEmit --incremental false` exit 0; `git diff --check` exit 0.
- No remote GitHub CI run on this uncommitted candidate. Historical full-repo baseline failures (22–24 unit, 1 Produce PG) are not claimed fixed.

## Closed P2 review findings locally
1. `.env.example`: `SLIP_CLOSE_INGEST_MAX_SECONDS=2160` (was 1200). Handoff text matches 2160 s (36 min) and recovery phase 40s within 60s route.
2. `src/lib/slips/schema-compat.pg.test.ts`: permanent execution-under-`service_role` PostgreSQL regression; privilege denial to anon/authenticated.
3. Source/current policy: designed for at most 25 images in burst, with 25 ingest lanes, 10 OCR lanes; does **not** promise full attempt opportunities for larger bursts or chronically delayed GitHub Actions.

## Product policy approved by owner — 19 October 2026

Owner explicitly approved these **design / isolated-test policies**, not Commit, Push, Merge, Deploy, Production access, or starting UAT:

1. Allow an incomplete slip batch to wait up to **2,160 seconds (36 minutes)** for eligible image retries rather than falsely certify incomplete financial totals.
2. Use **25 concurrent ingest lanes / 10 concurrent OCR lanes** as the initial design for **isolated capacity testing only**. Safe live throughput, memory footprint, OCR cost and provider rate limits remain unverified.
3. A burst exceeding 25 images, extreme scheduler delays, or retry exhaustion must produce an explicit **`review_needed` / incomplete notice**, never an unsupported `completed` summary.
4. **Verify LINE webhook redelivery is enabled** before any rollout. Owner reports personally verifying **Webhook redelivery ON** and **Use webhook ON** in the read-only LINE Developers UI for the real Bot-summary channel ID `2010200826`. Codex did not access or change that UI in this close-out.
5. **Provide an operator alert** for unhealthy queue / ledger / unbound receipts. The implementation now exists and is locally verified, but remains disabled/unconfigured and has never been exercised against real LINE.

Read-only Vercel inventory supplied by the owner showed `SLIP_CLOSE_INGEST_MAX_SECONDS` absent from 44 visible keys; no values were decrypted and no Production code was deployed. Therefore `.env.example=2160` is not proof of an effective deployed value, and rollout must explicitly configure and verify it.

The new `/api/cron/slip-ledger-alert` route uses a separate service-role-only migration and a per-recipient durable state row. It pages terminal loss immediately or unresolved receipt/OCR state at 36 minutes, re-alerts an ongoing incident no more often than six hours, and emits recovery only after a confirmed incident delivery. PostgreSQL leases overlapping workers; a notification keeps one LINE retry UUID through ambiguous timeouts/ack loss and treats the same-key 409 as accepted. Retry keys expire closed at 23 hours rather than minting a duplicate-risk key. Health payloads and UUIDs are strictly parsed before sending. The route is exact opt-in (`SLIP_LEDGER_ALERT_ENABLED=true`), requires an explicit valid LINE target and token, and an empty target is log-only dry-run. The scheduler secret is passed through the workflow environment and checked only as a Bearer token.

Migration order is now fixed: `20261017100000_slip_image_ingestion_ledger.sql` → `20261017110000_slip_ocr_claim_fencing.sql` → `20261019120000_slip_ingest_health_alert.sql` → matching application. The alert state table grants no direct client/service-role table access; only `service_role` can execute its SECURITY DEFINER RPCs, with a locked `pg_catalog, public` search path and no dynamic SQL from caller data. The alert migration is locally safe to re-apply. Its narrow rollback is `supabase/rollback/20261019120000_slip_ingest_health_alert.down.sql`.

**Remaining hard gates:** explicit authorization for commit/push/CI and isolated staging; staging migration/rehearsal with fake or isolated recipients; effective staging/Production env verification (especially the absent ingest wait and alert flag/recipient); real provider quota/cost/rate-limit and platform memory validation; and separate UAT/Production release authorization. The local load result validates concurrency control and accounting only.

## Release gate (not authorized)
1. With explicit Git authorization only, commit the intended candidate files by exact path (the worktree is dirty; never blanket-add), feature-branch push, and inspect remote CI. Do not include `.tmp-pr182-verification` artifacts or unrelated dirty files.
2. With separate isolated-staging authorization, set the 2,160-second ingest wait explicitly; keep the alert disabled or empty-target dry-run first; use isolated DB/keys and no real LINE recipient. Apply ledger → OCR fencing → alert migrations before the matching app. Quiesce old intake/cron/workers and avoid mixed-version OCR.
3. Validate staging scheduler lateness, memory/back-pressure, provider quotas/costs and the intended alert recipient. Turning on a real recipient or sending a real LINE message requires separate authorization; local mocks do not satisfy this gate.
4. UAT starts only with a new explicit authorization; no Production merge/deploy/migration/env mutation until separate release approval.

## Rollback gate (not authorized)
1. Disable the alert feature flag and scheduler first; confirm no alert lease/send is in flight. Roll back the alert migration with its narrow down file before any underlying ledger rollback.
2. Roll app traffic back before schema contraction. Follow the guarded ledger rollback; it refuses unresolved open-batch images unless an explicit audited degraded override is chosen. Do not roll OCR fencing back while mixed-version workers run.
3. A missing alert migration fails closed (503, no send), but leaving an enabled scheduler against a removed helper creates noisy failures; disabled-first is mandatory. Preserve alert/ledger audit evidence before destructive rollback.
4. None of these rollback actions, migrations or environment changes were executed in this close-out.

## Secret and external-I/O check
- No Production token/value was read or changed. Added environment examples are blank; tests use obvious dummy values. No remote curl, LINE, Supabase, Vercel or GitHub request was made.
- No commit, stage, push, merge, deploy, Production/staging migration, env mutation or real alert occurred.
- Post-test localhost cleanup inspection found three zero-connection disposable databases created before this close-out (`independent182basepriv_de7134f7` and two `slip_chain_*`, with filesystem timestamps 13:18 on 19 Oct and 15:34 on 17 Oct Bangkok time). They were preserved rather than destructively assuming ownership; the databases created by this run were dropped by their harnesses.

## Key references
- `docs/handoffs/p0-slip-image-ingestion-reliability.md` — current architecture/rollout safety and 2160s.
- `docs/handoffs/pr182-integration-verification-20261017.md` — historical Oct17 numbers (not latest).
- `.tmp-pr182-verification/independent-review-20261017.md` — original six adversarial findings.
