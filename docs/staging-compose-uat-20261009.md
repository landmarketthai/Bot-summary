# Local Compose staging UAT — 9 October 2026

**PARTIAL STAGING API VERIFIED; FULL FINANCIAL STAGING NO-GO. Production NO-GO.**
The Codex sandbox originally produced a Compose scaffold but lacked permission
to inspect Docker. The coordinating host session subsequently started real
local PostgREST, GoTrue and Nginx, and verified synthetic SQL/REST permissions
through HTTP. This does not establish a fully migrated Bot Summary financial
schema or Next.js authenticated application E2E. See host execution appendix.

Inspected application HEAD: `ba0dbf786eb292d113c52768f0786d0408838e91`.
Worktree: `C:\GitHub\_worktrees\bot-summary-p0-return-integrity`, initially clean.
Read `AGENTS.md`, [previous staging evidence](staging-uat-20261009.md),
[release UAT](release-uat-20261009.md), and installed Next 16.3.4 CLI, Proxy,
cookies and Route Handler guides under `node_modules/next/dist/docs/`.
Exactly two authorized read-only agents reviewed migration prerequisites and
HTTP/auth/financial paths; only the coordinator wrote files.

## Runtime access blocker

The user's host-session evidence establishes Docker Linux engine 29.6.2 and the
owned healthy PostgreSQL 17.6 container `botsummary-uat-postgres-20261009`, test
volume `botsummary-uat-pgdata-20261009`, owned bridge network
`botsummary-uat-loopback-20261009`, and explicit `127.0.0.1:56322 -> 5432`.
That earlier verification is not a fresh inspection by this sandbox.

At 15:49 Bangkok, the coordinator repeated explicit engine version and container
inspection with a separate empty Docker client config under the ignored worktree.
Both exited 1: `permission denied while trying to connect to the docker API at
npipe:////./pipe/dockerDesktopLinuxEngine`. Moving only client configuration
removed the unrelated user-config warning but did not resolve engine access.
The schema review agent independently received the same engine denial.

Docker Compose 5.3.1 is callable locally. Its offline `config --quiet` succeeds;
that does not require daemon access or prove services exist. No host connector,
alternate Docker transport, permission escalation or Supabase CLI start was used
to work around the denied engine pipe. Current container health, roles and actual
published bindings therefore could not be re-proven before SQL/HTTP, so those
actions stayed blocked.

## Independent full-schema blocker

The repository contains 130 migrations. The header of
`supabase/migrations/0048_pending_session_function_parity.sql` explicitly records
that a clean chain fails at `0032_pending_session_finalization_barrier.sql` because
the historical pending-session baseline was applied out of band and is absent
from version control. Migration 0048 deliberately does not restore it. This is
existing source evidence; no new full-chain execution was possible here.

Missing baseline objects include generation/close/finalization columns on
`pending_sessions`, `pending_session_ingest`, `pending_session_admission`, and
historical RPCs subsequently asserted by migration 0044. The disposable
`supabase/tests/produce_0049_bootstrap.sql` describes some required shape but
cannot repair the ordered chain: precreating `pending_sessions` conflicts with
0009, while `CREATE TABLE IF NOT EXISTS` after 0009 does not add missing columns.
It also does not supply every historical RPC. No RPC stubs, skipped assertions,
fabricated migration history or reconstructed baseline were introduced.

Other prerequisites identified by static review:

- `storage.buckets` needs `id text PRIMARY KEY`, `name text`, `public boolean`,
  `file_size_limit bigint`, and `allowed_mime_types text[]`. A metadata shim can
  satisfy bucket migrations; it does not implement the Storage API.
- Establish `pgcrypto` in `extensions` before 0001. A later `IF NOT EXISTS WITH
  SCHEMA extensions` does not relocate an extension installed in `public`.
  Later functions call `extensions.digest`. `pg_trgm` likewise needs `extensions`
  for the explicit `extensions.gin_trgm_ops` index.
- Verify `anon`, `authenticated`, and `service_role`, including service-role
  `BYPASSRLS` and PostgREST connection-role membership. Establish required baseline
  defaults before replay; never run schema-wide `GRANT ALL` afterwards, which
  would reopen deliberately narrowed evidence-table privileges.
- Let real GoTrue initialize Auth. Existing namespaces alone do not establish
  Auth readiness. Do not run `supabase/seed.sql`, which uses removed weigh entries.

Full application UAT requires a reviewed missing-baseline reconstruction and a
successful ordered replay in the synthetic DB. A minimal retention-only fixture
could separately advance HTTP retention proof after runtime access returns; it
cannot stand in for the full application database or justify staging GO.

## Prepared local artifacts

All runtime configuration, synthetic secrets and raw evidence are ignored under
`.tmp-staging-uat-20261009/compose/`. This report is the only tracked change.

| Artifact | Purpose / limits |
|---|---|
| `prepare-compose.cjs` | Generates scaffold and test-only `.env`; preserves existing secrets on rerun; asserts JWT signatures/roles/expiry, DB container hostname/database and loopback publications |
| `.env` | Synthetic JWT secret, anon/service JWTs and synthetic DB-role URLs; never print, commit or upload |
| `compose.json` | PostgREST v14.15, GoTrue v2.194.0, nginx; external owned network, `pull_policy: never`, no restart; only publication is `127.0.0.1:56321:80` |
| `nginx.conf` | Local `/rest/v1/` and `/auth/v1/` proxy; other paths 404 |
| `verify-owned.cjs` | Inspects exact test network/container/volume/ports; optionally all three Compose service names/project labels and gateway health; emits no inspected environment values |
| `smoke-http.cjs` | Calls ownership verifier first; only then real Auth health and retired-table service/anon GETs, with redirect rejection, timeout and status/byte-only output |

The Auth process listens on its container interface internally; Auth and REST
publish no host ports. The gateway healthcheck probes both upstream services.
The existing PostgreSQL container is external to this Compose project: the
scaffold neither creates it nor mounts/removes its volume.

Image defaults are `public.ecr.aws/supabase/postgrest:v14.15`,
`public.ecr.aws/supabase/gotrue:v2.194.0`, and `nginx:alpine`. Their exact cached
repository names/digests remain unverified in this sandbox. Update only the three
ignored image variables to match a fresh cached inventory. `pull_policy: never`
prevents a missing name from triggering a download.

The generated URLs name a separate synthetic database
`botsummary_compose_uat_20261009` and synthetic connection roles
`botsummary_uat_rest` / `botsummary_uat_auth`. **Those roles and database were not
created.** Their privileges, Auth schema ownership and the missing application
baseline require reviewed local bootstrap before starting these services. This
is a configuration scaffold, not a completed installation or automatic replay
script. The nginx proxy does not implement Kong API-key filtering: REST and Auth
must enforce the JWT role checks themselves.

## Reproduction and gated continuation

Run from the exact worktree. These first commands perform offline preparation
and validation only and do not print the secret configuration:

```powershell
node .tmp-staging-uat-20261009/compose/prepare-compose.cjs
docker --config .tmp-staging-uat-20261009/compose/docker-config compose --env-file .tmp-staging-uat-20261009/compose/.env -f .tmp-staging-uat-20261009/compose/compose.json config --quiet
node .tmp-staging-uat-20261009/compose/verify-owned.cjs --self-check
node .tmp-staging-uat-20261009/compose/verify-owned.cjs
```

The last command exits 1 here. Stop on any ownership failure; do not issue SQL or
app requests. The initial PowerShell-script version also hit the host's script
execution policy and was replaced with a Node verifier using the same ordinary
Docker CLI. No execution-policy or host-setting change was made.

After Docker inspection works, establish schema/role prerequisites in the owned
synthetic database, repair the missing baseline through review, and replay with
`ON_ERROR_STOP=1`. Re-run ownership verification before each SQL phase. Verify
cached images and that host TCP 56321 is free before starting anything. Only once
those prerequisites pass, the service-start/health sequence is:

```powershell
node .tmp-staging-uat-20261009/compose/verify-owned.cjs
docker --config .tmp-staging-uat-20261009/compose/docker-config compose --env-file .tmp-staging-uat-20261009/compose/.env -f .tmp-staging-uat-20261009/compose/compose.json up -d --pull never
node .tmp-staging-uat-20261009/compose/verify-owned.cjs --services
node .tmp-staging-uat-20261009/compose/smoke-http.cjs
```

None of the start/SQL steps above ran here. The HTTP probe asserts service 200
and anon 401 on the retained table; it does not claim authenticated denial,
retention-trigger behavior, mutation restrictions or financial correctness.
An empty service result would establish access only, not retention.

For eventual Next HTTP UAT, use a fresh process with explicit
`-H 127.0.0.1 -p 56300`, local API URL and synthetic keys. Clear inherited LINE,
OpenAI, remote notification, admin allowlist and cron configuration. Load the
existing `scripts/release-uat-no-network.cjs` through `NODE_OPTIONS`, and use
`scripts/release-uat-fonts.cjs` for local font compilation. The network preload
needs a reviewed allowance for embedded PDF `data:` WASM while preserving
non-loopback socket/fetch denial. Do not start using the old `.next` artifact.

Create only synthetic users through local GoTrue. Use installed `@supabase/ssr`
with a cookie jar and `signInWithPassword` to obtain genuine SSR cookies. A Bearer
header alone will not satisfy `src/proxy.ts`. Give the synthetic admin trusted
`app_metadata.role: "admin"`; `user_metadata` does not confer admin access.

## Live gates and safe request scope

| Gate | This attempt / required continuation |
|---|---|
| Container/role isolation | Blocked by engine denial; no fresh bindings/health/roles result |
| Real PostgREST/GoTrue | Not started; HTTP probe exited at ownership gate before fetch |
| Retention HTTP | Not run; prove failed/refused/open rotation, preserved content, service SELECT, anon/auth denial and backend mutation denial |
| Authenticated Next | Not started; require anonymous 401, operator finalize 403 and trusted admin guard behavior |
| White Sheet | Not run; real read/submit warning, submitted admin finalize 409 without mutation, then trusted correction permits finalize |
| Settlement | Not run; real yod-song blocked/null then complete/numeric; safe POST uses `notify_line:false` and no `source_id` |
| 04:00 / 04:05 | Local mocked regression passed; actual HTTP finalizer not called; needs process-only clock and complete contained runtime |
| LINE/cron | No live transport/cron invoked; token clearing alone is insufficient because reply/push code still attempts external LINE URLs |
| 31-day page/PDF performance | Not measured; blocked by runtime access and incomplete schema, no fixture loaded |

After prerequisites pass, finance paths are `/api/settlement/yod-song`,
`/api/white-sheet`, admin `/api/white-sheet/finalize`, `/api/settlement`,
`/financial-summary?month=2026-10`, and
`/api/pdf/financial-summary?month=2026-10`. Use synthetic identities and actual
UUIDs. Preserve retained evidence when testing corrected retries.

The monthly target fixture remains 31 dates × 10 sellers × 3 document types ×
5 products: 4,650 view rows, 930 sessions, 620 retained generations and 310
seller/date groups. Persist actual raw messages, sessions, items and rounds;
`produce_transactions` is a view. The existing mock fixture's descriptive IDs
cannot be loaded as UUIDs. Record real HTML/PDF status/content/bytes and cold/warm
timings, p50/p95 and a stated runtime budget. Earlier mock latency numbers were
not rerun and do not become real staging latency.

The finalizer cron has no debug mode and also handles outbox, deferred work,
inactivity and webhook recovery. Leave it uncalled until complete schema,
transport containment/capture and process-clock fixtures are ready. Historical
timestamps alone do not test its current-clock 04:00 behavior.

## Executed verification and cleanup

| Command/check | Observed result |
|---|---|
| Explicit engine version / DB inspect | Both exit 1, Docker pipe permission denied |
| Prepare configuration and JWT/endpoint assertions | Exit 0 |
| Compose `config --quiet` | Exit 0; offline configuration validation only |
| Ownership guard negative self-check | Exit 0; rejects `0.0.0.0`, `::`, non-loopback, wrong port, unexpected publication and wrong network |
| Node syntax checks | Exit 0 for verifier and HTTP probe |
| Live ownership / HTTP probe commands | Both exit 1; no SQL or fetch executed |
| `bun run type-check` | Exit 0 |
| `bun test src/app/api/settlement/yod-song/route.test.ts src/lib/white-sheet/server-finalize.test.ts src/lib/line/pending-session-finalizer-additional.test.ts` | Exit 0; 13 pass, 0 fail, 60 assertions across 3 files; mocked regression evidence only |
| Git ignore / whitespace | Scratch directory ignored; `git diff --check` passed |

Raw logs: `docker-access-probe.txt`, `ownership-probe.txt`, `http-probe.txt`,
`typecheck.txt`, `focused-tests.txt` under the ignored Compose directory.
PowerShell capture wraps native stderr in `NativeCommandError`; native exit
codes and substantive output above determine the results.

No Docker container, network, image, volume, SQL object or Next process was
created, stopped or changed by this attempt. The previously owned DB was left
untouched; its current health cannot be verified here. The separate host 5432
process and unrelated containers were untouched. No download, Production/Neon/
Vercel/cloud access, real LINE delivery, remote cron, push, PR, merge or deployment
occurred. No synthetic secrets enter the tracked report.

When services are eventually started, stop only the three exact Compose service
names using this project/file; never remove the existing DB volume. Because none
started here, no service cleanup command was needed. Application, migrations and
dependencies remain unchanged. Changes are left uncommitted for host review;
shared Git metadata is outside this worktree's writable boundary.

**Codex-sandbox decision (historical):** Docker access and the full
historical migration baseline were unavailable in the Codex sandbox. The
host-side continuation below supersedes the Docker-access blocker but NOT
the schema/application release blockers.

## Host-side continuation: real Compose API and ACL proof

After the sandbox handoff, the coordinating assistant used the authorized
lnwjud-local host tools on the same owned worktree. No Production account,
remote database, Vercel deployment or LINE service was accessed.

1. Re-verified the pre-existing test-only PostgreSQL container
   `botsummary-uat-postgres-20261009` healthy and bound **only**
   `127.0.0.1:56322 -> 5432` on network
   `botsummary-uat-loopback-20261009`. Existing host PostgreSQL on 5432
   remained untouched. Docker Linux Engine 29.6.2 was ready.
2. Read generated ignored `.env` without printing secrets, validated the
   local DB target `botsummary_compose_uat_20261009`, and created only that
   synthetic database plus `botsummary_uat_rest` and `botsummary_uat_auth`
   connection roles on the owned test container. Granted minimal schema
   permissions and PostgREST role memberships. Never ran repository's full
   migrations or copied Production records.
3. Using the generated Compose file, ran `docker compose config --quiet`
   successfully, then `docker compose up -d --pull never --no-build`.
   The three owned services are `botsummary-uat-rest-20261009`,
   `botsummary-uat-auth-20261009`, and
   `botsummary-uat-gateway-20261009`. Docker inspection showed **no**
   published ports for Auth or REST and exactly
   `127.0.0.1:56321 -> 80` for gateway. The gateway healthcheck was
   healthy; all services remained running. No extra host interfaces opened.
4. Real local HTTP `GET /auth/v1/health` returned **200**, and
   `GET /rest/v1/` returned **200**, not mock results. In the separate
   synthetic database, a clearly named `public.staging_http_probe` table
   with the single value `synthetic-local-only` was created. The initial
   real PostgREST request required a schema-cache refresh via local
   `NOTIFY pgrst, 'reload schema'`. After refresh,
   `GET /rest/v1/staging_http_probe?select=id,note` returned
   **200** with the expected synthetic record.
5. Revoked `anon` and `authenticated` read privileges on the
   synthetic probe and granted only `service_role` SELECT. PostgreSQL
   `has_table_privilege` confirmed `anon=false`,
   `service_role=true`. The host-side
   `node .tmp-staging-uat-20261009/compose/smoke-http.cjs` first
   passed the owned-container/port/network guard and then made **real HTTP**
   requests: Auth health **200**, service-role read **200**, anonymous
   read **401**. No response secrets were printed and no LINE call occurred.

**Important evidence boundary:** These prove an isolated functional HTTP
Auth-health and PostgREST service/anonymous permission path only. They do
NOT prove a genuine interactive GoTrue user login, the original retired
generation table through REST, all 130 schema migrations, an authenticated
Next.js route, White Sheet finalize, settlement, 04:00 HTTP, LINE no-send
flow, or 31-day staging financial latency. The prior PostgreSQL 17
retention trigger tests (12/12) were executed against an isolated
disposable database, not a faithful full application schema. Those
unverified gates remain blockers, especially the missing historical
pending-session baseline recorded by migration 0048.

The ignored runtime files and synthetic secrets stay under
`.tmp-staging-uat-20261009/compose/`. The local test database, Auth,
PostgREST and gateway are deliberately **left running** for further
non-Production UAT; never run these against Production endpoints.
To stop only this app's three Compose services, use the exact generated
Compose file and its `down` command without `--volumes`; the separately
owned test PostgreSQL is not a Compose service and will remain intact.

**Combined decision:** Local API staging PARTIALLY PASSED, full Bot Summary
financial Staging UAT **NO-GO**, and Production **NO-GO**. Before attempting
any Production release, first reconstruct and independently review the
missing historical SQL baseline (without guessing Production state),
replay complete schema onto a fresh synthetic database, verify genuine
GoTrue sign-in and Next SSR, financial close/settlement/cutoff no-send
scenarios, and measure real month-end page/PDF latency.
