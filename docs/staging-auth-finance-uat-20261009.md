# Local Auth/SSR and finance UAT handoff — 9 October 2026

**Host Staging Auth and primary Financial HTTP smoke VERIFIED; complete 04:05,
full month-end performance and Production release gates remain NO-GO.** The
Codex sandbox report below is followed by separately validated host results.
No live result is inferred from a mock or static inspection.

Worktree: `C:\GitHub\_worktrees\bot-summary-p0-return-integrity`.
Read `AGENTS.md`, the installed Next 16.3.4 Proxy, cookies, CLI, custom-server
and `after` guides, installed Supabase SSR implementation, and
[baseline recovery evidence](staging-baseline-recovery-20261009.md).
Three parallel reviewers examined Auth/SSR, finance fixtures, and cutoff/LINE
containment. They performed read-only inspection; the coordinator alone edited
and tested. No Docker command or live HTTP/database connection ran in this
Codex sandbox. The known Docker Linux pipe denial was not retried.

## Existing services and the wiring change

The authorized host previously established PG17 database
`botsummary_baseline_replay_20261009b`, replaying 130 pinned migrations with
explicit test-only compatibility phases. **Do not replay, reset, recreate or
drop database b.** Its Storage metadata shim does not establish Storage API
parity. Existing full-schema REST at `127.0.0.1:56331` remains intact.

GoTrue behind `127.0.0.1:56321` currently uses the different synthetic database
`botsummary_compose_uat_20261009`. The standalone full REST process at 56331
also uses an independently generated JWT secret. Changing only GoTrue's
database, or pointing the SDK at the bare REST URL, would not produce a working
Auth/REST client: the SDK derives both `/auth/v1` and `/rest/v1` from one base URL.

The host handoff moves **original Compose REST and GoTrue together** to b,
preserving their credentials and shared signing secret. The original gateway
continues serving `http://127.0.0.1:56321`. The standalone REST, original probe
database, database container/volume/network and host PostgreSQL 5432 are untouched.

[staging-auth-finance.mjs](../scripts/staging-auth-finance.mjs) provides explicit
host modes. Importing it, Node syntax checks and its unit tests make no Docker
or HTTP calls. Host modes inspect the exact five containers and reject unexpected
network members, extra networks, non-loopback or wrong ports, wrong Compose
project labels, wrong DB hosts/roles/names, or unequal original Auth/REST secrets.
The known standalone REST is independently validated rather than bypassing the
older ownership verifier's now-incomplete four-container allowlist.

| Owned object | Required binding or identity |
|---|---|
| `botsummary-uat-postgres-20261009` | Healthy; `127.0.0.1:56322 -> 5432`; named test volume |
| `botsummary-uat-auth-20261009` | Original Compose project; no published ports |
| `botsummary-uat-rest-20261009` | Original Compose project; no published ports |
| `botsummary-uat-gateway-20261009` | `127.0.0.1:56321 -> 80` |
| `botsummary-replay-rest-20261009` | `127.0.0.1:56331 -> 3000`; database b |
| Network | Only those five members on `botsummary-uat-loopback-20261009` |

Preparation reads live inspected configuration in memory and writes only ignored
`auth-finance/override.json` and `runtime.json`. These contain synthetic secrets:
**never print, commit, upload or include them in a report**. Preparation refuses
existing output files, preserving an earlier handoff rather than overwriting it.
The override changes only Auth/REST environment values; its structure and keys
are checked before use. `docker compose config --quiet` emits no secret config.

Rewiring first reruns the existing baseline verification inside its rollback
transaction. A separate transaction checks the existing connection roles are
LOGIN without superuser, CREATEDB, CREATEROLE, replication or BYPASSRLS flags,
and checks REST memberships in `anon`, `authenticated`, `service_role`.
It grants only database CONNECT, creates a fresh `auth` schema owned by
`botsummary_uat_auth`, and sets this role's database-scoped `search_path=auth`.
It refuses an existing Auth schema. Real GoTrue initializes its own Auth tables;
no guessed Auth DDL, copied user records, financial RPC stub or blanket public
table grant is used. Public ACLs remain those of the verified replay.

Only original `auth`, `rest`, `gateway` services are started/recreated with
`--pull never --no-build --no-deps`. No images are downloaded. The host must
still establish real health and login; a successful container inspect alone
does not prove Auth migrations finished. Docker/psql failure stderr is retained
privately in ignored `auth-finance/host-failure.log`; console errors are generic
to avoid leaking configuration. Stop at the last printed phase on failure.
Never remove the existing volume or reset either database to make a gate pass.

## Host sequence: Phase 2 Auth and Next SSR

Run sequentially from this worktree and stop on every nonzero exit:

```powershell
node scripts/staging-auth-finance.mjs --prepare-host
node scripts/staging-auth-finance.mjs --rewire-host
node scripts/staging-auth-finance.mjs --verify-host
node scripts/staging-auth-finance.mjs --serve
```

`--prepare-host` and `--rewire-host` are one-shot modes for the current old-DB
wiring, not commands to resume after partial mutation. If Auth initialization
fails after schema creation, inspect the retained synthetic state privately;
do not rerun bootstrap or fabricate schema readiness. Do not rerun the older
`compose/prepare-compose.cjs` or `replay/full-rest-smoke.cjs`: the former generates
old-DB configuration, the latter generates new independent secrets and collides
with the running REST container/role.

`--serve` runs in the foreground; wait for `LOCAL_UAT_NEXT_READY`, then use a
second host terminal for smoke. The server binds only `127.0.0.1:56300`.
An occupied port fails without killing its owner. Stop the runner with Ctrl+C
before starting a cutoff runner. It closes Next watchers on listener failure
and on normal termination. No existing `.next` build is used: the custom dev
server uses webpack and an ignored isolated dist directory.

The child environment keeps only OS execution variables, clears all statically
referenced app env keys and every key declared in root `.env*` files, then sets
explicit local SDK keys, disabled telemetry, local font compilation and
`VERCEL_ENV=development`. It discards inherited `NODE_OPTIONS`, proxy credentials,
admin allowlists, OpenAI credentials and real LINE tokens. A synthetic LINE
token lets the existing transport code exercise its normal path. All webhook
paths and all cron paths are blocked by the runner in normal money mode.

Proxy was inspected directly: `src/proxy.ts` calls GoTrue `getUser()` and requires
cookie sessions on finance APIs. Admin finalize/reopen also independently call
`requireAdminActor`; only trusted `app_metadata.role` or server `ADMIN_USER_IDS`
can grant that role. Smoke clears `ADMIN_USER_IDS`, creates confirmed random
synthetic `.invalid` admin/operator/spoof users through the real local Admin API,
and logs in through installed `@supabase/ssr` `signInWithPassword` with a real
`getAll`/`setAll` cookie jar. It forwards every SDK chunk. Credentials/session
cookies remain in memory and are never logged. Users remain in the local Auth
schema for inspection; no automatic user/database cleanup is included.

## Host sequence: Phase 3 focused finance HTTP

With the unclocked runner still active:

```powershell
node scripts/staging-auth-finance.mjs --smoke-host
```

This is a **one-shot mutating smoke** with plain INSERT fixtures that fail on
reuse. It requires genuine local Auth health, REST service 200/anon 401, and the
runner's `x-local-staging-uat: real` header before seeding. It then requires:

The genuine operator JWT must also be denied a retained-generation REST read
(401 or 403), preserving the service-only evidence contract.

1. Anonymous settlement, yod-song, White Sheet and PDF return 401. A genuine
   admin Bearer token without cookies also returns 401. Operator and untrusted
   `user_metadata.role=admin` spoof finalize requests return 403.
2. Actual UUID-backed round/raw-message/session/item withdrawal of 10 × 10 baht,
   and a failed legacy pending return with explicit source/date/seller/market.
   Legacy structured metadata stays null, matching full-schema constraints.
3. Operator submits cash 70 through HTTP with the exact round UUID. White Sheet
   shows the return hard stop; yod-song is blocked/null. Operator/spoof 403 and
   trusted-admin 409 leave the complete cash rows and lifecycle events unchanged.
4. Updating the pending generation invokes the real retention trigger. The
   retained failure survives with its full text/round/status; it still blocks
   money and finalize while the cash/audit snapshot remains identical.
5. A strictly later matching main return of 3 × 10 baht yields numeric yod-song
   70/complete, expected sales/cash 70, difference zero and matched status.
   Genuine admin finalize succeeds, preserves cash 70, records its real Auth
   UUID, and adds exactly one lifecycle event. The retained failure is unchanged.
6. Settlement POST explicitly uses `notify_line:false` and omits `source_id`.
   It saves 70, reports zero LINE targets/no LINE error, uses null source/round,
   retains the same ID on repeat upsert, and leaves reconciliation/finalization
   tables unchanged. The source-aware path has broader workflow side effects
   and is outside this contained smoke.
7. Small-fixture monthly HTML/PDF return 200 with the correct types and real
   `%PDF-` bytes. This does **not** load or benchmark the 31-day volume fixture.
   The money smoke requires no captured LINE call and no denied transport event.

The three guarded SQL fixtures are
[seed](../supabase/tests/staging_auth_finance_seed.sql),
[rotation](../supabase/tests/staging_auth_finance_rotate.sql), and
[correction](../supabase/tests/staging_auth_finance_correct.sql).
They insert backing tables, not the `produce_transactions` view, and preserve
equal transaction times so financial report grouping is meaningful. Correction
is deliberate backing-table seeding, not evidence of parser/ingestion E2E.
Successful smoke writes only safe facts in ignored `money-result.json`.

## Test-only 03:59, 04:00 and 04:05

After stopping the unclocked runner, start each process separately. In terminal
one run the first command; wait for READY. In terminal two run `--cutoff-host`.
Stop terminal one's runner before advancing to the next clock:

```powershell
node scripts/staging-auth-finance.mjs --serve 2026-10-08T20:59:00.000Z
node scripts/staging-auth-finance.mjs --cutoff-host

node scripts/staging-auth-finance.mjs --serve 2026-10-08T21:00:00.000Z
node scripts/staging-auth-finance.mjs --cutoff-host

node scripts/staging-auth-finance.mjs --serve 2026-10-08T21:05:00.000Z
node scripts/staging-auth-finance.mjs --cutoff-host
```

These are Bangkok October 9 03:59, 04:00 and 04:05. Only these process clocks
are accepted; no OS/host clock is changed. Explicit Date constructors, parse,
UTC and monotonic elapsed-time clocks retain their normal semantics. PostgreSQL
`now()`/`clock_timestamp()` stays **real**. The fixture refuses to proceed unless
the actual DB clock is beyond its October 8 20:00:30Z close deadline.

The local cutoff runner alone opens exact GET
`/api/cron/finalize-pending-produce-sessions`, authenticated by a synthetic cron
secret. No remote cron, webhook or other cron route is invoked. Before fixture
creation and each invocation, inventory requires no unrelated live pending
generation and empty global notification/deferred/webhook queues. The genuine
`open_pending_plain_text_generation` RPC creates admission/ingest/close authority
for a parser-tested undated return. Only its returned generation is backdated
to a close well outside the cutoff margin; the process clock introduces the
ambiguity. All three cases must refuse because the existing margin is 30 minutes.

Required results: 200/due 1/failedClosed 1/finalized 0/errors 0, exact pending
failed-close with the ambiguity error and no round/finalized-session reference,
unchanged financial tables, one captured synthetic refusal mentioning 04:00.
Repeat GET requires due 0 and no second capture. Capture remains active through
Next `after()`; bounded settling and reinspection follow both responses. Each
case writes a separate safe result JSON. Fixtures are left for inspection.

## Transport containment and evidence limits

[staging-auth-finance-preload.cjs](../scripts/staging-auth-finance-preload.cjs)
is inherited by Node workers. It denies non-numeric-loopback connections,
unexpected local ports including 5432, socket pipes, DNS resolution, UDP,
HTTP/2 external connections and nonlocal fetch. Fetch redirects are rejected.
Only explicit HTTP 127.0.0.1 ports 56300/56321/56331/56343 and embedded base64 WASM
`data:application/wasm` or `application/octet-stream` are allowed. The embedded
Yoga allowance performs no external request. Installed Google font mocking uses
real local Sarabun bytes; PDF fonts already reside under `public/fonts`.

The only simulated fetch responses are exact LINE POST push/reply endpoints.
They require synthetic `uat-20261009-` destinations/reply tokens and capture
all typed messages and retry keys in ignored PID-specific JSONL. Authorization
and reply tokens are omitted. Unknown LINE endpoints, content downloads and
OpenAI are denied. This is **Node transport containment, not an OS firewall**;
arbitrary native addons or directly spawned network binaries are outside the
guard's guarantee. The runner uses webpack rather than native Turbopack network
behavior. No real LINE acceptance/delivery is tested: a captured synthetic 200
proves only application handling of that simulated response.

Existing Proxy also has a refresh limitation: it sets refreshed cookies on its
initial response, but authenticated `/login`/`/auth` redirects construct a new
response without copying those cookies. This harness deliberately establishes
fresh-cookie protected-route evidence. Login redirect/expired-session refresh
E2E remains unverified; no application auth behavior was changed here.

## Executed checks and remaining gate

| Sandbox check | Actual result |
|---|---|
| Node harness + existing replay tests | **8 passed, 0 failed, 0 skipped** |
| Focused yod-song / White Sheet finalize / finalizer regressions | **13 passed, 60 assertions**; mocked application tests |
| New Node script syntax checks | Passed |
| Focused ESLint on all three new scripts | Passed |
| `bun run type-check` | Passed |
| Ignored runtime directory / Git whitespace | Passed |
| Real GoTrue migration/login, Next HTTP, SQL fixtures, local cutoff | **Not executed here**; host continuation required |
| Real 31-day report p50/p95 / Storage API / Auth refresh | **Not checked** |

Only test scripts, synthetic SQL fixtures and this report were added. No numbered
migration, application route, Proxy, package dependency or deployment config was
changed. No Production/Cloud query, real LINE call, remote cron, push, merge or
deployment occurred. Full staging remains NO-GO until the host returns actual
results and the remaining broader UAT gates are satisfied.

Local Git staging was attempted for exactly these seven reviewed files and
failed: Git could not create
`C:/GitHub/Bot-summary/.git/worktrees/bot-summary-p0-return-integrity/index.lock`
(`Permission denied`). Shared worktree metadata lies outside this sandbox's
writable root. No commit was created, no lock was removed, and no retry or
alternate Git index bypass was used. The host may create the local commit after
reviewing the checks/evidence, without pushing:

```powershell
git add -- docs/staging-auth-finance-uat-20261009.md scripts/staging-auth-finance.mjs scripts/staging-auth-finance-preload.cjs scripts/staging-auth-finance.test.mjs supabase/tests/staging_auth_finance_seed.sql supabase/tests/staging_auth_finance_rotate.sql supabase/tests/staging_auth_finance_correct.sql
git diff --cached --check
git diff --cached --stat
git commit -m "test: add contained local auth and finance UAT handoff"
```

Stop on a failed command. Review the staged paths before committing; never add
the ignored runtime directory, config files, cookies or raw host diagnostics.

## Authorized host continuation — real local full-schema Staging UAT

The original Codex sandbox could not access Docker/Git worktree metadata.
The authorized host-side `lnwjud-local` session continued on 9 October, using
the previously reconstructed, synthetic **PG17 database
`botsummary_baseline_replay_20261009c`** and a real GoTrue/PostgREST gateway
on `127.0.0.1:56343`. The original older gateway at 56321 and REST at
56331 were **not treated as equivalent** to this newer shared-JWT stack.
Test-only GoTrue signup, password-token login and `/user` on 56343 were
verified via HTTP 200; retired evidence service read 200, anon read 401.
No Production database, Vercel deploy, remote cron or LINE service was used.

The host-specific runtime and tests were written under ignored
`.tmp-staging-uat-20261009/` and contain only synthetic local config.
The Next host runner individually inspected the exact owned DB/Auth/REST
containers, bridge network, full-schema database URI, shared synthetic
JWT secret, and published addresses before starting. Its child environment
discarded inherited app/cloud credentials, retained no real LINE secret,
and applied the network-deny preload. Next.js custom development HTTP was
available **only** at `127.0.0.1:56300`.

Real HTTP results, from synthetic account sessions and real PostgREST:

| Check | Observed |
|---|---|
| Unauthenticated `GET /api/settlement?month=2026-10` | **401** |
| GoTrue operator signup/login + Supabase SSR cookies | **PASS** |
| Authenticated operator `GET /api/settlement` | **200** |
| Authenticated `GET /financial-summary?month=2026-10` | **200** |
| Operator and spoofed user-metadata admin finalize attempts | **403**, **403** |
| Synthetic cash POST of 70 baht | **200**, `submitted` |
| Failed return pending: yod-song | **200**, `blocked`, money `null` |
| Real admin finalize while failed return unresolved | **409** |
| Rotation retaining the earlier failed generation | **Retention verified; finalize remains 409** |
| Later 3 × 10 baht return correction | `complete`, yod-song **70** |
| Admin finalization after correction | **200** |
| Settlement POST with `notify_line:false` | **200**, `lineTargets=0` |

The full host money test process itself exited **1** only at its final
aggregated transport-audit assertion: it incorrectly counted 78 denial
records from **earlier offline guard unit tests** in every archived PID log.
This does not undo the prior genuine HTTP/SQL assertions, but **is not a
fully green end-to-end suite**. Per-PID inspection showed the current
finance client guard with zero new denials/captures and no real LINE
delivery; a pre-existing isolated Next PID had one denied attempted
network operation that remained blocked. This should be diagnosed before
calling global transport auditing green.

The cutoff runner used three reviewed process-only clocks, not OS or DB
clock changes. Initially its Middleware failed because the test Date
constructor lacked **own** `Date.parse`/`Date.UTC` properties inside
Webpack's VM; the test-only preload now provides them explicitly.
The original test harness had also incorrectly supplied
`x-cron-secret`; the repository cron authentication helper **requires
`Authorization: Bearer <secret>`**. Both are test harness corrections,
not application behavior changes.

The exact synthetic pending fixture created on the failed initial 03:59
attempt was verified and reused rather than inserting a duplicate.
After correcting the test harness:

| Bangkok process clock | Actual cron HTTP | Result |
|---|---|---|
| **03:59** | **200**, due 1 → failedClosed 1, finalized 0, errors 0; repeat due 0 | **PASS** |
| **04:00** | **200**, due 1 → failedClosed 1, finalized 0, errors 0; repeat due 0 | **PASS** |
| **04:05** | Clocked Next prepared, but host execution did not complete | **NOT TESTED** |

For both completed cutoff tests, snapshots of financial backing tables
were unchanged, one **synthetic** LINE message was intercepted rather than
sent, no new denied transport calls were recorded during the test, and
there was no duplicate capture on retry. The 04:05 runner was not
executed after host execution was blocked by tool safety controls; the
owned Next process was subsequently stopped. **Do not infer a third PASS.**

No full 31-day financial report p50/p95 was measured against this staged
DB. The original synthetic 31-day latency estimates remain insufficient
for a Production SLA. Expired/refresh-token redirect cookies, actual
webhook ingestion, operator workflows across every market, Storage API
and production deployment were not exercised.

**Release verdict:** Primary **Phase 2 Login/SSR** and **Phase 3 money
hard-stop/correction** paths now have genuine isolated HTTP evidence;
two cutoff boundaries pass. **Full Staging remains NO-GO** pending 04:05,
clean transport-audit accounting, wider finance regressions, and realistic
monthly latency. **Production remains NO-GO** pending separately approved
migration/release safeguards. The host committed only reviewed
non-secret source, tests and docs locally; no Push/Merge/Deploy/Production
SQL/real LINE action occurred.
