# Staging UAT — Bot Summary — 2026-10-09

**STAGING BLOCKED. Production remains NO-GO.** No genuine staging database,
PostgREST, Auth or Next HTTP UAT was established in this session. No staging
scenario is marked passed. This report records a bounded local setup attempt,
not a deployment or another mock-based UAT.

Inspected HEAD: `9d2d3d86fc5fc64ef1c8e864cae7dc8fc5cab94e`, branch
`fix/failed-return-sales-integrity-20261008`, worktree
`C:\GitHub\_worktrees\bot-summary-p0-return-integrity`. The initial worktree was clean.
Read `AGENTS.md`, [release UAT](release-uat-20261009.md),
[P0 integrity handoff](p0-return-sales-integrity-20261008.md), and the installed
Next CLI guide at `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md`.
Two authorized read-only agents inspected local DB availability and HTTP fixture/auth
requirements; the coordinator alone created local files and attempted Docker startup.

## Authorization and isolation boundary

The user authorized local isolated STAGING UAT, including a safe local Docker start.
Production deployment, Production migrations/writes, cloud staging creation,
Vercel deployments, Production-data cloning, Git push/merge and real LINE delivery
were outside scope and were not performed. No cloud connector was called and no
Production endpoint or database was contacted, including for read-only verification.
The only attempted external shell request was a HEAD request for an official public
PostgREST release asset; it could not connect. Public documentation browsing was
limited to PostgREST installation/release information.

The coordinating assistant separately verified using **read-only cloud inventory**
that the connected Supabase account lists only Production project `Bot-summary` /
`apjjsqibavjaitcedavn`, with zero development branches. Vercel lists existing
Bot Summary Preview deployments, but their database/LINE isolation was not proven,
so none was used for staging. This inventory did not query or alter Production
records. The Codex local staging session itself used no cloud connectors.
Neon `LandmarketThai` is unrelated and must never be used for this project.

Only `.env.example` exists in the worktree; no live secret file was read or used.
The probe configuration has unique project ID `bot-summary-uat-20261009-isolated`
and candidate API/DB/shadow ports `56321` / `56322` / `56320`.
It is a **status-probe configuration**, not a completed Supabase bootstrap.
No API endpoint, DB connection URL, synthetic key set or fixture database became
operational. Therefore DB isolation is **not established**; no SQL was permitted or run.

Native `netstat -ano -p tcp` confirmed an existing listener on `0.0.0.0:5432`,
PID `10620`. It was untouched. The same snapshot showed no listeners on proposed
Next `56300`, standalone PostgREST `56301`, Supabase API `56321`, Supabase DB
`56322`, or standalone PG `56327`; ports must be checked again before later use.

## Local setup evidence

| Probe | Observed result | Implication |
|---|---|---|
| Docker binary/Desktop | Docker CLI `29.6.2`; Desktop executable exists at `C:/Program Files/Docker/Docker/Docker Desktop.exe` | Installation exists; engine readiness is a separate gate |
| Initial `docker info` | Exit 1; `docker_engine` named pipe absent; user `.docker/config.json` access denied | No usable daemon in this session |
| `docker desktop start --timeout 30` | Exit 1: `Docker Desktop is still starting: context deadline exceeded`; log directory access denied | Bounded startup attempt failed |
| Explicit Linux engine check | `docker -H npipe:////./pipe/dockerDesktopLinuxEngine version`, exit 1, pipe absent after startup attempt | Linux container runtime unavailable |
| Cached image inventory | Explicit Linux-engine `image ls`, exit 1, pipe absent | Image names, sizes and restart policies could not be inventoried; do not claim an empty cache |
| Docker service/processes | `com.docker.service` stopped; no Docker process observed after the attempt | No successful Desktop startup observed |
| Docker disk cache | `.../Docker/wsl/disk/docker_data.vhdx` exists, 14,616,100,864 bytes; `.../Docker/wsl/main/ext4.vhdx` exists, 100,663,296 bytes | Disk presence does not prove a usable Supabase/PostgREST image |
| WSL | `wsl --list --verbose`, exit -1, `Wsl/EnumerateDistros/Service/E_ACCESSDENIED` | Distro availability could not be established within this sandbox |
| Supabase CLI cache | Native `2.111.0` and `2.110.0` binaries found in Bun cache, neither on PATH | CLI is locally available without installing a dependency |
| Initial cached CLI `--version` | Exit 1, telemetry write to user `.supabase` directory failed with EPERM | Default invocation cannot initialize under these permissions |
| CLI with process-local isolation | `SUPABASE_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `SUPABASE_HOME` and `XDG_CONFIG_HOME` under the worktree; `--version` returns `2.111.0`, exit 0 | Initial telemetry failure was resolved locally; host HOME and settings were not changed |
| Isolated CLI status | `--workdir .tmp-staging-uat-20261009 status`, exit 1, `LegacyStatusDbInspectError`, missing `docker_engine` pipe | Local Supabase still blocked by Docker; no `start`, `link`, `db push`, `db pull`, reset or cloud SQL ran |
| Native PostgREST inventory | No executable/archive found in PATH or readable Program Files, Bun install cache, WinGet package cache and Downloads; matches were JS client code | No locally runnable alternative found; inaccessible files remain unknown |
| Official Windows PostgREST asset | `curl --head --location --max-time 20` for v14.18 Windows x86-64 zip, exit 7: could not connect to `github.com:443` | Small native-binary fallback could not be obtained from this shell; no image/package download was made |
| PG17 | `C:/Program Files/PostgreSQL/17/bin/postgres.exe` and `libpq.dll` exist | A new native cluster is possible, but PG alone does not provide PostgREST/Auth |

The cached 2.111.0 CLI is at
`C:/Users/User/.bun/install/cache/@supabase/cli-windows-x64@2.111.0@@@1/bin/supabase.exe`.
Readable Docker logs contained no exact `postgrest/postgrest`, `supabase/postgres`
or `supabase/gotrue` repository tags. This is not a reliable image inventory.

The [official installation guide](https://docs.postgrest.org/en/stable/explanations/install.html)
documents native Windows binaries and PostgreSQL support; the
[official v14.18 release](https://github.com/PostgREST/postgrest/releases/tag/v14.18)
was checked as a small fallback to pulling a full Supabase stack. The attempted
asset was `postgrest-v14.18-windows-x86-64.zip`. No alternative download channel,
privilege escalation or host permission bypass was attempted.

Ignored local evidence is retained in `.tmp-staging-uat-20261009/`:
`local-runtime-probes.txt`, `supabase-version.txt`, `supabase-isolated-status.txt`,
`port-inventory.txt`, and `supabase/config.toml`. The bounded Docker start result
and initial CLI failure are recorded in the session tool output and this report;
they are not claimed as separate raw log files. WSL emitted UTF-16 output through
the PowerShell capture, so its raw log contains NUL characters.

## Genuine staging gates — all blocked / not run

| Required gate | Required objective evidence on an isolated runtime | This session |
|---|---|---|
| Isolation before SQL | Explicit loopback DB URL with unique non-5432 port, matching owned new cluster/container, loopback-only listener; API/Auth URLs also local | Not established; no SQL |
| Retention through real PostgREST | Apply prerequisites and retention migration only to that new local DB; rotate failed, refused and open returns; real trigger retains content; service-role REST SELECT succeeds; anon/authenticated read and backend mutations are denied | Not run |
| Failed/open/retired returns and retry | Unresolved return prevents sold-out/confirmed money; only a later main return covering every candidate releases it; unrelated seller/market/source remains unaffected; missing evidence fails closed | Not run |
| White Sheet | Real authenticated HTTP read/close shows provisional warning; admin finalize returns 409 without finalization mutation while blocked; trusted correction permits finalize | Not run |
| Settlement | Real HTTP yod-song gives null/blocked while unresolved and numeric/complete after valid correction; settlement write uses `notify_line:false` in the synthetic DB | Not run |
| 04:00 Bangkok cutoff | Historical event/ingest fixtures protect earlier-day evidence from later-day ordinary returns; real HTTP finalizer also exercised at process clock 04:00 and 04:05 | Not run |
| No-send LINE/cron | Local DB-backed debug messages preserve provisional wording; transport capture count is zero and non-loopback network guard rejects external transport | Not run; no cron or LINE transport invoked |
| Monthly page/PDF latency | Actual authenticated Next HTTP month page/PDF, representative 31-day records and retained history, pending/resolved content, bytes/status, cold/warm timings and p50/p95 against an agreed runtime budget | Not measured |

The existing full builds, PG17 12/12 test and mocked 31-day profile were **not rerun**.
Their evidence remains in the release UAT report. In particular, 434 mock queries
and 58.206 seconds at synthetic 250 ms/query are a performance warning, not measured
PostgREST, staging HTTP latency or proof of a deployed timeout. The prior `.next`
artifact has synthetic public configuration and must not be deployed.

## Setup requirements found in code review

`src/proxy.ts` calls Supabase Auth `getUser()` and protects White Sheet, settlement
and PDF HTTP routes. A standalone PostgREST server is insufficient for the complete
UAT: real local GoTrue Auth is also required. Replacing Auth or query responses with
a stub would leave a disclosed partial test and must not count as genuine staging GO.
Use a synthetic admin account and a synthetic operator account, real SSR cookies,
and verify anonymous 401/operator 403/admin financial-guard behavior.

The repository has 130 migration files. Full schema replay references
`storage.buckets` (including migration 0019); a plain PostgreSQL fixture with only
the three retention-test migrations is not a faithful application database.
The default `supabase/seed.sql` inserts removed `weigh_entries` records. Disable
that seed in a separate local config and create current-schema synthetic fixtures;
do not alter or import Production data. Cached CLI 2.111.0 also warns that
`[inbucket]` is deprecated in favor of `[local_smtp]`; the isolated probe config
uses the latter. Existing repository configuration was not changed.

Fixtures must include real produce sessions/items/transactions view, raw messages,
accountability rounds, pending sessions and retired generations, plus supporting
preflight tables. White Sheet additionally requires slip/manual-slip tables, cash
entries and finalize/reopen RPCs; monthly financial UAT requires settlement entries.
The prior monthly data model (31 days, 10 sellers, 4,650 transactions, 930 sessions,
620 retained generations) can supply synthetic values, but its fake client cannot
serve as the runtime or evidence.

There is no application-wide no-send environment switch. LINE transport uses
hardcoded external URLs. A local transport capture and a verified process network
guard are required before exercising delivery paths; clear inherited LINE/OpenAI
credentials and all notification targets. Use synthetic cron authorization only.
`daily-summary?debug=1` exits before financial preflight, so it cannot establish
provisional-money content. The pending-session finalizer has no debug mode and
also performs outbox/inactivity/recovery work; leave it uncalled until the complete
synthetic DB and transport containment exist. It reads the current clock directly:
historical timestamps alone do not test its 04:00/04:05 behavior. Use a documented
process-only test clock, not a Windows clock change.

## Exact next decision

**Recommended next path: repair/provide the local container runtime in a host
session that can access Docker Desktop/WSL, then resume the already authorized
local UAT.** The failed engine/WSL checks are environmental gates; repeating mock
tests or starting only Next/PG cannot close them. No permission escalation was
available in this session, and no further startup or download workaround was used.

Before a host operator starts an existing Docker installation, inspect existing
containers/restart policies and prevent unrelated workloads from running; do not
delete unknown resources. Verify the Linux engine and list cached images first.
Use the unique local project ID and free test ports, prefer proven cached images,
disable seed/email/analytics/optional services, and verify actual published bindings
are loopback-only. Review missing-image sizes and use the smallest sufficient local
stack, avoiding massive image downloads wherever a smaller practical path exists.

If Docker cannot be made usable, obtain a small official native PostgREST binary
in the worktree and pair it with a newly initialized loopback PG17 cluster on a
unique port, accurate local schema and real local Auth. PG plus PostgREST alone may
advance REST/retention proof but leaves authenticated application UAT blocked.

For either route, prove endpoint/cluster ownership and loopback DB URL **before
every SQL setup phase**, create only synthetic test keys/records, then execute the
gate table above through actual PostgREST and Next HTTP. Close with GO/NO-GO using
actual response, privilege, retention and latency evidence. Do not reuse the earlier
build as a release artifact. Stop only the processes/resources created for this UAT.

Creating a cloud Supabase project/branch or Vercel deployment is a separate human
decision after isolation and cost review and requires separate authorization.
No such resource was created or proposed as an automatic fallback. Production and
the unrelated Neon project remain excluded.

## Changes and closeout

The only tracked change is this report. Disposable probe configuration and evidence
remain ignored under the worktree; no application, dependency, migration, repository
Supabase config, existing PostgreSQL cluster or host setting was edited. No database
or Next service was started, no fixture was loaded, and no unknown resource was
deleted. No staging GO, SQL result, HTTP response or latency is invented.

Closeout verification: isolated CLI status still exits 1 on the missing Docker pipe,
with no deprecated-section warning after the probe-only config adjustment. Git
tracked diff whitespace check passes; the new report has no trailing whitespace.
Git confirms the probe/evidence files are ignored and this report is the sole new
tracked candidate. HEAD is unchanged; no commit was created. Final port/process
checks still show the same port-5432 listener and no observed Docker/PostgREST/
Supabase process or proposed application/DB test listener.

**Stop: local best-effort setup is complete; genuine staging UAT is blocked.**
Production remains NO-GO for the release gates already recorded in the handoff,
including required capability/migration, real runtime verification, latency margin,
baseline issues and historical incident reconciliation. None was cleared here.

## Follow-up: Docker unblocked and isolated database verified (9 Oct, 14:22–14:38 Bangkok)

The previous Docker-unavailable result is historical. At the user's explicit
request, the coordinator invoked lnwjud-local and launched Docker Desktop.
The Linux engine became ready (`29.6.2 linux`). At engine startup there were
zero pre-existing containers; relevant Supabase image caches were present.

- The 130 repository migrations were copied into the ignored isolated workdir;
  no repository migration was edited and no Production endpoint was accessed.
- A bounded `supabase start` attempt with unique local project and ports
  revealed Docker Desktop publishing test DB TCP 56322 on
  `0.0.0.0` and `::`. It was **cancelled immediately**; the one owned
  container was stopped and the isolated Supabase CLI project was cleaned.
  Do not repeat the standard CLI start without enforcing loopback bindings.
- An isolated Docker bridge network's default host-bind preference was
  insufficient on this Windows Docker Desktop host. Explicit
  `--publish 127.0.0.1:56390:80` was confirmed to bind only loopback
  and serve an HTTP 200 test. Both temporary Nginx probes were stopped.
- A dedicated local **test-only** Supabase PostgreSQL container named
  `botsummary-uat-postgres-20261009` was started on the owned network
  `botsummary-uat-loopback-20261009` with
  `127.0.0.1:56322 -> 5432`, synthetic credentials and a named test
  volume. PostgreSQL `17.6` reports healthy. The existing host listener
  on 5432 was never touched.
- Targeting that exact loopback container, the disposable migration
  regression suite `migration-retired-generations.pg.test.ts` passed
  **12/12 (0 failed)**, including historical rotation, refusal, service-role
  privilege checks, idempotency and 04:00. The suite creates and drops its
  own disposable test database, not Production.
- The base Postgres image has `auth` and `storage` namespaces/roles but
  no `storage.buckets` relation. Thus the project's full 130 migrations,
  real PostgREST/GoTrue Auth, real Next HTTP workflows and 31-day staging
  latency remain **NOT TESTED**. Do not report an E2E Staging GO.

Verified closeout: only the dedicated loopback PostgreSQL test container
was running; no all-interface published ports or Supabase CLI containers
remained, and Git was clean before this documentation update. Docker
Desktop remains active. No Git push/merge, Production SQL/deploy, LINE send
or cloud staging creation occurred.

**Next:** construct a fully isolated local Supabase runtime using explicit
`127.0.0.1` bindings for each published service (rather than default CLI
bindings), initialize complete current schema plus synthetic Auth users,
and perform real HTTP UAT. If that cannot be achieved, seek separate
authorization for a dedicated cloud staging instance. Production remains NO-GO.
