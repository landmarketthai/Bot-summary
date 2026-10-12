# Historical baseline recovery and isolated replay — 9 October 2026

**Historical pending-session source RECOVERED. Ordered PG17 replay 130/130
VERIFIED by the authorized host (not the Codex sandbox), with documented
TEST-ONLY compatibility steps. Full financial Staging UAT NO-GO;
Production NO-GO.** Recovery is supported by committed SQL, not a new
Production inspection. This report supplements
[the Compose UAT evidence](staging-compose-uat-20261009.md).

Starting HEAD: `0c2bc241b55acbc9962e1022d85936dbb13308db`, clean worktree.
Only the coordinator edited files. Three read-only agents independently
examined Git provenance, ordered dependencies, and financial HTTP/auth tests.
The sandbox made no Docker calls or database connections. The already active
host Compose services and synthetic database were left untouched.

## Recovered source and exact insertion point

The exact missing file is committed in Git history:

- Commit: `48450f00bba1d371b6af210a80fa804e0435d077`
  (`fix(line): make pending sessions race-safe`).
- Path: `supabase/migrations/0042_pending_close_ingest.sql`.
- Git blob: `e55e853e055d95df5c9834ab6a58a6a28d84229e`.
- Identical backup source at pinned
  `origin/backup/main-before-legacy` tip
  `096c4b0c41c2033092c14c8c220709862b274d5a`.

Read-only recovery command:

```powershell
git show 48450f00bba1d371b6af210a80fa804e0435d077:supabase/migrations/0042_pending_close_ingest.sql
```

[staging_missing_baseline.sql](../supabase/tests/staging_missing_baseline.sql)
contains a provenance header followed by the **byte-for-byte original blob**.
The offline regression and replay builder independently calculate its Git
blob hash; altered payloads fail before SQL execution.

The harness applies this test fixture **after 0030 and before 0031**, then
replays all 130 current migration files, unchanged, in filename order.
This ordering lets Release A/B replace the historical function behavior.
Applying the old functions at reserved slot 0042 would regress those releases.
No numbered migration was added, no historical migration was modified, and
no `supabase_migrations` records are fabricated.

| Recovered object | Exact source / independent corroboration |
|---|---|
| Five generation/close columns on `pending_sessions` | Original 0042; current 0044 asserts types, defaults, nullability |
| `pending_session_ingest`, `pending_session_admission`, PK/FK/indexes | Original 0042; 0044 asserts generation/event PKs and cascading session-key FKs |
| Historical admit, append, register-ingest, readiness, claim RPCs | Original 0042; 0031 replaces/extends guarded overloads, 0032 adds finalization authority |
| Register/readiness captured function parity | Original 0042 resolves 0044 prerequisite; 0048 subsequently installs its own captured definitions |
| Finalization lifecycle columns and produce-session FK | **0034 already supplies these**; no reconstruction needed |

The older `produce_0049_bootstrap.sql` is deliberately unused: it precreates
the 0009 table, does not add columns to an existing 0009 table, omits needed
historical RPCs, and omits 0034's finalization FK. Its wider table shape is
not evidence for replacing committed migration behavior.

## Platform and security boundaries

[staging_platform_prerequisites.sql](../supabase/tests/staging_platform_prerequisites.sql)
establishes only evidenced local prerequisites:

- `extensions.pgcrypto` before 0001, following existing 0049/0051 test
  bootstraps; 0047 and later functions require `extensions.digest`.
  The later trigram migration itself installs `pg_trgm` in `extensions`.
- `anon`, `authenticated`, `service_role` from committed test bootstraps.
  Existing roles must already have the expected NOLOGIN/non-superuser and
  BYPASSRLS flags; unsafe existing roles are rejected, never altered.
- Service-role table defaults from `guided_menu_0051_bootstrap.sql:26-28`,
  set before any application table exists. Anon/authenticated receive no
  default table grants. There is no blanket grant after replay.
- A **synthetic `storage.buckets` metadata shim**, with only the five columns
  actually used by 0019 and the later PDF/OCR bucket migrations, and an `id`
  primary key supporting their `ON CONFLICT (id)`. No complete committed
  Storage platform DDL was found. This is a dependency shim, not recovered
  Storage DDL or evidence that uploads/downloads work.

Historical 0042 does not enable ledger RLS. The harness adds ledger RLS in a
separate test phase, using the committed precedent in
`produce_0050_verification.sql:114-117`. The historical blob stays unchanged.
This local hardening is **not** a claim about Production's actual ledger RLS.
The existing notification-boundary suite separately tests vulnerable broad
default ACLs; this staging baseline does not reproduce anon/authenticated
ALL table defaults.

No repo migration references `auth.*`. Real Auth initialization and user
login remain the responsibility of local GoTrue, after schema replay.
The harness does not fabricate `auth.users`, JWT functions, Auth RPCs, a
Storage API, or financial RPC stubs. It does not start or reconfigure services.

## Deterministic replay harness

[staging-baseline-replay.mjs](../scripts/staging-baseline-replay.mjs) has two
explicit modes. `--prepare` is entirely offline; `--run` is for the authorized
host coordinator only. Both check the pinned 130-entry
[migration manifest](../supabase/tests/staging_migration_manifest.json),
including SHA-256 of every migration's committed LF content. Windows CRLF
checkouts are normalized back to Git's LF representation for hashing/replay;
new fixture attributes preserve the exact historical blob across checkouts.
New, missing, edited or reordered
migrations fail until the manifest is deliberately reviewed and repinned.

The generated bundle and manifest live under ignored
`.tmp-staging-uat-20261009/baseline/`. The bundle hash and every phase hash
are reproducible; timestamps/secrets are excluded. The generated SQL logs
START/OK for each phase, with a final success marker only after verification.

`--run` reuses the existing owned-container guard before sending any SQL.
It fixes the local Docker Linux pipe, exact owned container, and PostgreSQL
Unix socket **inside that container**. It never uses a host PG connection,
inherited database URL, remote Docker context, or the original host port 5432.
Ownership verification must prove healthy PG, the owned test volume/network,
and the sole publication `127.0.0.1:56322 -> 5432`.

The SQL guard requires the named synthetic database, owner `postgres`, and
**PG17.x**. It rejects any existing public relation/function/type, platform
schema, or default ACL. It creates, drops and resets **no database**. The
current active `botsummary_compose_uat_20261009` contains Auth/probe objects,
so it must be rejected. Do not reset it to make the harness pass.

The authorized host created a disposable sibling named
`botsummary_baseline_replay_20261009b`, used it for the successful full replay,
and left it intact for inspection. That database must **not** be replayed again;
the runner's freshness guard will reject it. A separate unused name ending
`20261009c` is allowed for a future independently authorized fresh run.
The existing Compose Auth/probe database is not a replay target.

Offline checks, safe in this sandbox:

```powershell
node --test scripts/staging-baseline-replay.test.mjs
node --check scripts/staging-baseline-replay.mjs
node scripts/staging-baseline-replay.mjs --prepare botsummary_baseline_replay_20261009b
```

**Historical commands executed by the authorized host against fresh sibling b (do not rerun on b):**

```powershell
node .tmp-staging-uat-20261009/compose/verify-owned.cjs
docker --config .tmp-staging-uat-20261009/compose/docker-config -H npipe:////./pipe/dockerDesktopLinuxEngine exec botsummary-uat-postgres-20261009 psql -X --no-password -h /var/run/postgresql -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE botsummary_baseline_replay_20261009b TEMPLATE template0;"
node scripts/staging-baseline-replay.mjs --prepare botsummary_baseline_replay_20261009b
node scripts/staging-baseline-replay.mjs --run botsummary_baseline_replay_20261009b
```

Run commands sequentially and stop on every nonzero exit. CREATE DATABASE
intentionally fails if that name already exists. There is no cleanup/reset
command in this handoff. The runner pipes UTF-8 bytes directly from Node to
psql, avoiding PowerShell text-pipeline corruption of Thai literals. It saves
stdout/stderr under ignored `baseline/replay.log`; return the first failing
phase/error and the manifest SHA to the sandbox for an evidenced fix.

Many migrations contain their own BEGIN/COMMIT. There is no misleading
whole-chain single-transaction claim: a SQL failure leaves a partially
replayed disposable DB for inspection. **Never skip, resume, stamp successful
migrations, or disable assertions.** A subsequent corrected replay requires
another genuinely fresh database under separately agreed local scope.
Do not point the active REST/Auth services at the sibling during replay.

## Regression coverage and observed results

The offline regression passed **3/3, zero skipped**: historical blob identity,
deterministic exact 130-file order and insertion, and rejection of unnamed
or malicious targets. Node syntax checking and offline bundle preparation
passed. This is file/harness evidence, not PostgreSQL execution.
Focused ESLint, Git whitespace checking and ignored-artifact checking also
passed. Each preparation prints its bundle SHA-256 and writes it in the
ignored manifest; the sibling-target bundle has a different guard/hash by
design. Every canonical migration hash was checked against the starting
HEAD's committed content.

[staging_baseline_verification.sql](../supabase/tests/staging_baseline_verification.sql)
is appended after the complete chain. Its PG17 regression was not executed in the Codex sandbox, but the host ran it successfully as part of the canonical 130-file replay described below.
It checks financial relations/view, representative exact columns/defaults,
the real finalization FK, extension schemas, current RPC signatures/return
types/ACLs, enabled retention trigger, RLS, and evidence permissions including
PG17 MAINTAIN. It performs genuine failed/open/resolved generation rotations
and checks retained content; synthetic verification writes roll back. The
retired ledger must allow service SELECT only, and review turns must retain
their SELECT/INSERT/DELETE contract. Built-in 0044/0048 and subsequent
migration assertions remain intact and execute in order as well.

The previous isolated retention result of 12/12 and Compose Auth-health 200,
service probe 200 / anon probe 401 remain valid **narrow prior host evidence**.
They do not become evidence for this new ordered replay. The existing PG
retention test has default host 5432 and a partial/stub bootstrap; it was not
invoked. No thousands-test rerun or Next app code change was needed here.

## Financial HTTP UAT after successful replay

Replay success establishes synthetic application SQL plus an explicit
platform shim. It does not establish current Production schema parity.
Before connecting local Compose to any fully migrated database, the host
must verify local Auth ownership/readiness and PostgREST memberships/schema
cache while preserving narrowed table ACLs. That is a separate host phase.

Required financial evidence remains:

1. Genuine local GoTrue sign-in, using confirmed synthetic `.invalid` users.
   Trusted admin role belongs in `app_metadata.role`; an operator spoofing
   `user_metadata.role: admin` must remain unprivileged. Use installed
   `@supabase/ssr` password sign-in with getAll/setAll cookie jar for actual
   SSR cookies; a Bearer header alone does not satisfy `src/proxy.ts`.
2. Next server bound only to `127.0.0.1:56300`, with local API keys and
   outbound containment. Existing no-network preload blocks PDF `data:` WASM;
   review that allowance before PDF UAT, keep non-loopback fetch/socket denial.
3. Anonymous finance 401, operator finalize 403, trusted-admin incomplete
   return finalize 409, with before/after cash rows proving no mutation.
   Corrected return must permit finalization while preserving retired evidence.
4. Real yod-song blocked/null then complete/numeric. Settlement POST must use
   `notify_line:false` and omit `source_id` for the contained route path.
5. Real UUID-backed monthly raw messages/rounds/sessions/items. Insert backing
   tables, not `produce_transactions` view. Existing descriptive-ID mock
   fixture and simulated latency are unsuitable as real DB/performance proof.
   Measure actual month HTML/PDF status, bytes and cold/warm p50/p95 against
   a stated budget.
6. 04:00/04:05 scenarios require a contained process clock and full transport
   capture. Leave finalizer cron uncalled until these exist; stored historical
   timestamps alone do not test the route's current-clock behavior.

## Host verification after Codex handoff (actual PG17 and REST)

The Codex sandbox could not reach the Docker pipe. The authorized lnwjud-local
host continued against the **owned test-only** PostgreSQL container with
exact published binding `127.0.0.1:56322 -> 5432`; host PostgreSQL 5432,
Production, LINE and all Cloud projects were untouched.

1. The recovered original Git `0042` source was applied after `0030`,
   before `0031`. First full rehearsal moved past the prior `0032`
   failure and through `0049`, then reached a new, unrelated P2E CONTRACT
   assertion after 65 successful numbered migrations.
2. Root cause: the local fresh chain already carried the correctly defined
   `UNIQUE(source_id,business_date)` constraint under the auto-generated
   name `transfer_reconciliations_source_id_business_date_key`. The
   `20260731111743` migration intentionally does not rename an equivalent
   existing constraint, but later `20260809045849` P2E CONTRACT requires and
   drops the old name `transfer_reconciliations_source_date_key`.
   `staging_p2e_legacy_unique_name.sql` is an explicit **local-only**
   exact-definition/name compatibility phase immediately before CONTRACT.
   It rejects wrong source columns, already conflicting names, wrong PG17,
   wrong database and wrong role. Neither actual financial identity nor
   any committed migration text is changed.
3. The next rehearsal reached `20261007060911`, whose exact-text SQL check
   failed on Windows CRLF transport although the expected old finalizer
   fragment appeared exactly once when compared with CR removed. The replay
   harness normalizes checkout CRLF back to the committed Git LF bytes before
   applying, consistent with its pinned SHA-256 manifest, without changing
   semantics or overwriting repository migration files.
4. **Canonical reproducible replay PASSED:** a new empty
   `botsummary_baseline_replay_20261009b` database was created with
   `TEMPLATE template0`. The reviewed
   `node scripts/staging-baseline-replay.mjs --run botsummary_baseline_replay_20261009b`
   returned exit **0**, emitting
   `PG17 ordered replay and schema/security assertions passed` after all
   **130** SHA-256-pinned migrations, the verbatim historic baseline,
   test-only ledger RLS and exact P2E naming compatibility. Its generated
   SQL bundle hash was
   `134055ae5e33ece8ec807e3d12ef41d7e8765a12f40ba10ed750474311470609`.
   This is a proof of the *explicitly staged* replay chain, not proof that
   the unmodified 130-file chain alone builds cleanly.
5. `node --test scripts/staging-baseline-replay.test.mjs` passed **3/3**.
   A separate scratch-chain rehearsal against another synthetic fresh
   database completed with exit 0 and verification SQL passed with
   `BEGIN/DO/ROLLBACK`, checking retained evidence, RPC/column shapes,
   service ACLs and RLS; these are not Production results.
6. A separate isolated full-schema PostgREST v14.15 container at
   `127.0.0.1:56331` was started with a synthetic login and JWT secret
   (never committed). **Real HTTP** GETs on the fully replayed database
   returned `service_role=200`, `anon=401` for both
   `pending_session_retired_generations` and `accountability_rounds`.
   This is stronger than the earlier unrelated probe-table HTTP smoke,
   but does not establish money correctness, genuine GoTrue login/SSR or
   monthly financial performance.

**Remaining NO-GO:** The full-schema PostgREST instance is not yet linked
with a verified full-schema GoTrue Auth/Next process. The original GoTrue
health check ran against a different synthetic database. Authenticated
web-flow access, actual White Sheet finalize/sale/settlement HTTP, LINE
no-send 04:00 behavior, durable correction of historical cases and 31-day
report timing all require further UAT. The test-only replay also includes
deliberate local platform metadata shims rather than full Supabase Storage
services. A deployed Production release still requires a separate explicit
authorization and its own safe migration sequencing.

All added test database/container resources have synthetic names and remain
on loopback for controlled continuation. Do not run the generated replay
bundle against existing databases or Production. No Git push, merge, deploy,
Production query/mutation or real LINE send occurred.

## Remaining definitions and release decision

**Missing pending-session application definitions: none identified after
committed-history recovery.** Static dependency review found no other absent
required public relation definitions in the 130-file chain. Host PG execution
may expose a new mismatch; it must be handled from source evidence.

Complete Storage platform definitions are absent from this repo, so Storage
API parity remains blocked beyond the explicit metadata shim. Auth platform
definitions are not reconstructed; use real local GoTrue, not guessed tables.
Any proposal to compare those objects or this recovered baseline with actual
Production requires distinct approval. None is requested or performed here.

Although host ordered replay and isolated full-schema REST ACL checks now pass,
genuine Auth/SSR, financial correction/finalization, contained cutoff scenarios
and actual monthly performance still need testing; full Staging and Production
remain **NO-GO**. No Production SQL/read/write/schema pull,
Production data copy, LINE send, Vercel/Neon/remote cron, push, merge or deploy
occurred. The original host PostgreSQL on 5432 was untouched.
