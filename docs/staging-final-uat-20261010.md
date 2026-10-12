# Isolated Staging UAT continuation — 10 October 2026

## Follow-up evidence — 12 October 2026 (supersedes the host-test status below)

**Sales Integrity P0 remains Production NO-GO.** This section records later,
real local host evidence; the 10 October narrative below remains historical.

- Exact owned synthetic PostgreSQL 17 c stack: `--verify-host` exit 0,
  `EXACT_OWNED_FULL_SCHEMA_C_VERIFIED`; no Production access or reseed.
- Genuine local GoTrue expired-session and redirect/refresh UAT:
  `--session-host` exit 0, all five cases PASS, money tables unchanged,
  `REAL_LOCAL_SESSION_REFRESH_20261010_PASSED`.
- Full 31-day representative monthly HTML/PDF workload:
  `--month-host` exit 0, `REAL_LOCAL_MONTH31_20261010_MEASURED`.
  Seeded records remained 310 rounds, 930 sessions, 4,650 transactions and
  620 retained failed generations. 11 actual HTTP requests to each of HTML
  and PDF completed, and compared source and money snapshots were unchanged.
  Warm local HTML p50/p95 17.33/25.51 seconds; PDF 21.72/43.73 seconds.
  These are local development timings, **not Production latency guarantees**.
- The existing owned synthetic database had been seeded with ASCII-digit seller
  labels `ผู้ขาย0` / `ผู้ขาย9` before the tracked fixture source was changed
  to Thai digits. No reseed was performed. The host assertion now obtains the
  expected first/last seller labels by **exact synthetic source, owner and
  date** from stored accountability rounds. It still asserts both dates
  and `return_incomplete`. The default regression retains strict Thai
  labels for newly seeded fixtures. A test reproduces the old false failure.
- Independent read-only review found no new P0 production-path defect in the
  current diff, but identified outstanding release evidence: **04:05 cutoff
  remains UNTESTED and a prior explicit prohibition on rerun remains in force**.
  The invalid-refresh cookie-deletion and follow-up 401/redirect checks were
  subsequently added and passed on the real local GoTrue/Next host. Detailed
  PDF financial content verification and repository-wide lint scope still need
  review.
- No main merge, Production deployment, Production migration, live LINE event,
  ledger correction, or 04:05 cron fixture was performed by this continuation.


**Host finance passed; real monthly and session gates failed before this patch.
Post-patch host reruns remain NOT TESTED. Full Staging and Production remain
NO-GO.** Starting/current HEAD is `889d1c3`; prior uncommitted harness files
remain intact. The first continuation prepared the harness; this continuation
changed report ID batching and the harness redirect guard. The latest review
follow-up corrected stale batch/seed assertions, hardened the scoped transport
reader and repaired proven Proxy cookie loss. Three requested agents investigated
read-only; only the coordinator edited files. Read AGENTS.md and
installed Next 16.3.4 Server Components, data fetching, error handling, Proxy
and cookies documentation. No numbered migration, dependency or deployment
configuration changed.

The first continuation's `lnwjud-local` host tool rejected even a read-only task inventory with
`MCP tool call requires approval, but approval policy is never`. No Docker or
real HTTP command was executed through another channel. Do not bypass that
decision. The authorized host subsequently ran the real tests recorded below;
this sandbox did not retry Docker, a restricted connector or Production.
The host must execute the post-patch commands below when its policy permits.
No user login is needed.

## Actual evidence and outstanding gates

| Gate | Evidence as of this handoff |
|---|---|
| Exact owned full-synthetic c stack | October 10 host `--verify-host` Exit 0 |
| Real login/SSR and finance hard stop/correction | October 10 host `--finance-host` Exit 0: fresh October 6 scope, cash 70 baht, hard stop/rotation/correction, zero new blocked attempts, zero LINE captures/delivery |
| 03:59 and 04:00 cron | October 9 report records PASS; not rerun today |
| 04:05 cron | UNTESTED: host tool safety rejected the attempt; do not bypass or infer PASS |
| Full 31-day workload seed | October 10 host `--seed-month-host` Exit 0: August, 310 rounds, 930 sessions, 4,650 transactions, 620 retired failures; do not reseed |
| Full 31-day real monthly HTML/PDF latency | Host `--month-host` Exit 1: page's 930-UUID URL produced Nginx HTTP 414; Next returned HTTP 200 error HTML missing required workload. No completed representative benchmark. Patched locally; host rerun pending |
| Expired access token and refresh/redirect cookies | Host `--session-host` Exit 1: API refresh HTTP 200 / Set-Cookie count 1 passed; redirect fetch threw before `/login` or `/auth/callback` could be assessed. Harness manual redirect and offline-proven Proxy cookie loss patched; real host rerun pending |
| Production | NO-GO; outside this session's authorized scope |

Today's host evidence was read from the ignored
`.tmp-staging-uat-20261009/host-20261010-evidence.md` and the user's explicit
host session result. These are host results, not tests executed in this sandbox.
Historical live results come from
[the October 9 Auth/finance report](staging-auth-finance-uat-20261009.md),
not today's unit tests. Full-schema reconstruction provenance is in
[the baseline recovery report](staging-baseline-recovery-20261009.md).
No current cutoff result artifacts were available to independently revalidate
the two historical passes. No PASS is inferred from a mock, syntax check or
prepared script.

The prior sparse October report had five samples per endpoint, including cold
development compilation: HTML p50 462.8 ms / p95 4,639.4 ms; PDF p50 235.5 ms /
p95 2,310.4 ms. That workload is not the representative August 4,650-row month;
these numbers establish no monthly performance gate or Production SLA.

## Confirmed bugs and local repair

The financial-summary page now deduplicates and looks up raw-message UUIDs in
sequential batches of 50, accumulates one complete source map, and throws on
any batch error before returning report groups. The regression uses the real
installed PostgREST query builder with a local fetch fixture, 930 distinct UUIDs
and 4,650 transaction rows; it checks full mapping, repeated rows, null IDs,
empty input, URL size, and failures in the first/middle/final batch.

The financial PDF has no direct raw-message-ID lookup. Both report surfaces use
daily preflights; the sales/evidence loaders previously batched UUID/hash and
retained session-key lookups at 500. Those existing bounds are now 50 too.
A 620-key regression proves full classification and rejects a failed second
ingest batch. The host seed's 620 generations reuse 20 session keys; the offline
monthly fixture now deliberately stresses 620 distinct retained keys,
enforces bounded filters and checks all 31 preflights reach their final round
query. The PDF test preserves blocked versus resolved verdicts. Round-return
lookups already use bounded 200-UUID filters; report-summary PDF date filters
contain at most the month's 31 dates. Monthly settlement GET uses date bounds;
the separate settlement notification context's raw-ID lookup is day-scoped
and was not changed. Unpaged settlement reads beyond 1,000
rows remain a separate scale limit outside the seeded workload.

The read-only review reproduced three false failures left by the prior changes:
the page expected nine batches of 100 rather than eighteen of 50 plus 30; the
620-key loader expected six batches of 100 rather than twelve of 50 plus 20;
the monthly PDF expected 217 ingest queries rather than 403 (31 × 13). Only the
test expectations and fixture bounds changed in this follow-up. Page failure
injection now covers batches 1, 10 and 19, including the actual final batch.
The host HTML guard now requires the seed's Thai labels `ผู้ขาย๐` and `ผู้ขาย๙`.
An offline regression first failed on those labels, then passed after correction;
Arabic labels, missing first/last dates and a missing blocked status still fail.
The seeded August SQL and database were not changed or rerun.

The preload previously changed `redirect: manual` to `error`, making native
fetch reject a 302/307 response even though manual never follows it. It now
converts only `follow` (including the default) to `error`. A real local HTTP
302 regression preserves Location and Set-Cookie for manual mode, including
Request input, rejects follow/default/error modes, and asserts zero target
requests. No port, destination or outbound restriction was expanded.

## Transport accounting fix

The ignored original finance script scanned every archived PID log, counting
intentional earlier guard-test denials. Tracked scripts used offsets but still
enumerated all runs. The preload now creates a validated random run UUID and
writes PID logs only under ignored `auth-finance/transport/<runId>/`. Every
Node child inherits that UUID. A fresh CLI client uses a separate UUID.

The local Next harness exposes the nonsecret UUID in `x-local-staging-uat-run`
and writes ignored `server-state.json` only after successfully binding the
listener. Tests take explicit client/server baselines **before readiness**,
verify the metadata against the HTTP response, and require the same server
UUID throughout. Archives, unit-test runs and reused PIDs in other runs cannot
affect the count. New workers within either run remain included. Missing,
truncated, partial or malformed current logs fail closed. No global audit scan
remains in the corrected finance/cutoff paths. The latest follow-up proved and
fixed two reader gaps: baseline JSON was not parsed, and newly discovered files
were not remembered between polls. Every baseline/new record now validates its
event schema and run/PID identity against its directory/filename. Blank records,
unknown fields/kinds, invalid clocks and incomplete synthetic captures fail.
Observed file counts are tracked separately from the original offsets, so a new
worker disappearing or losing observed records fails without dropping already
counted events. The regressions failed before the fix and passed afterward.

All existing network restrictions remain. A new `denied` event fails the suite;
it means a **blocked attempt**, not successful external traffic. Finance allows
zero LINE captures; cutoff requires exactly one simulated synthetic refusal.
Polling uses monotonic time, a 10-second deadline, at least 2 seconds of
observation and 1.5 seconds of quiet. This bounded observation does not prove
all arbitrary background work ended. Node interception remains distinct from
an OS firewall; native addons/spawned network binaries are outside its guarantee.

## Exact host continuation

Run from `C:\GitHub\_worktrees\bot-summary-p0-return-integrity`.
Execute sequentially, inspect each exit code, and stop on rejection or failure.
Never run `supabase start`, `db push`, Compose rewire, database replay/reset,
cloud commands or the old one-shot finance fixture. Do not use ports 5432,
56321 or 56331 as substitutes for the c stack.

The scripts pin `npipe:////./pipe/dockerDesktopLinuxEngine`, the ignored owned
Docker config, exact PG17 container, its internal Unix socket and the exact c
database. Before test writes, the c guard checks the owned four-container
stack, the known eight-member bridge, sole loopback publications
PG `127.0.0.1:56322` and gateway `127.0.0.1:56343`, full-schema Auth/REST DB
wiring, shared synthetic JWT signature, and runtime target. Unexpected state
is a failure to investigate, not an allowlist to expand automatically.

First verify without starting or changing any service:

```powershell
node scripts/staging-full-schema-uat.mjs --verify-host
```

Expected Exit 0 and `EXACT_OWNED_FULL_SCHEMA_C_VERIFIED`.
The first startup below is required to load the revised preload/run headers;
an old Next process cannot provide them. If port 56300 is occupied, inspect
its owner and stop only the verified owned UAT runner through its terminal or
managed task. Do not kill an unrelated listener.

04:05 remains UNTESTED after the host safety rejection. The user's current
instruction explicitly prohibits retrying it; do not execute the fixture through
any channel. Offline Date-shim assertions provide no cutoff HTTP/database
evidence. Do not rerun completed 03:59/04:00, reopen a generation, or remove rows
to manufacture a new pass.

For the required month/session reruns, stop only the verified owned old Next
runner through its managed task/terminal if it is still running. Never stop an
unrelated listener. A fresh process is required to load the revised preload.
Terminal A:

```powershell
node .tmp-staging-uat-20261009/host-next-c.cjs
```

Wait for READY, then terminal B, one command at a time:

```powershell
node scripts/staging-full-schema-uat.mjs --month-host
node scripts/staging-full-schema-uat.mjs --session-host
```

Finance and month seeding already succeeded on the host; **do not rerun
`--finance-host` or `--seed-month-host`**. The finance command is one-shot: it refuses any existing finance workload on
October 6 and its fresh `uat-20261010-finance` namespace. It adapts the existing
guarded fixtures in memory to c, new UUIDs and October 6; October 7 rows remain
intact. Genuine local accounts/cookies exercise 401/403, cash 70, hard-stop 409
with unchanged cash/audit, real retention-trigger rotation, later correction,
numeric 70/complete, trusted-admin finalize, no-notify repeat settlement upsert,
and actual HTML/PDF. Expected Exit 0 and
`REAL_LOCAL_FINANCE_20261010_PASSED money=70 newBlockedAttempts=0 syntheticLineCaptures=0`.
Receipt: `auth-finance/finance-20261010-result.json`. Do not rerun on collision.

## Month fixture and measured report

`--seed-month-host` requires an unclocked owned Next server and refuses existing
August sessions/rounds/settlements/retired rows or a reused fixture. Its single
transaction inserts 310 rounds, 930 real backing sessions/raw messages, 4,650
produce items/view rows and 620 synthetic retained failures across all 31 days
and ten Thai seller labels. SQL count assertions roll back on mismatch.
It creates no mutable pending row or notification/deferred queue entry and
does not alter October fixtures. Direct retained-ledger insertion is workload
seeding, not retention/ingestion evidence. No cleanup/delete/reset is included.

`--month-host` is repeatable and does not seed. It checks SQL counts and real
service-only PostgREST view count 4,650, then requests actual Next monthly HTML
and PDF. HTML must contain first/last fixture dates/sellers and the uncertified
`return_incomplete` status. PDF must have real `%PDF-` bytes and the PDF type.
Both endpoints get one separately recorded first request, including any dev
compilation, then ten sequential complete-body warm timings. Nearest-rank
p50/p95, every timing/byte count, Node/Next versions and workload counts are
saved privately in `auth-finance/month-20261010-result.json`.

Expected Exit 0 and `REAL_LOCAL_MONTH31_20261010_MEASURED`. A partial receipt has
`passed:false`; do not publish it as completed. Ten local development samples
provide rough local percentiles, not a Production SLA. Process/DB cache state
is uncontrolled. The suite does not simulate latency or call the offline mock
monthly fixture. PDF document-content/layout QA and PostgREST version capture
remain outside this small timing harness.

## Expired/refresh session gate

`--session-host` uses fresh genuine GoTrue logins for each scenario. In memory
only, it validates each user JWT against the inspected local Auth secret,
re-signs it with already expired `iat`/`exp`, and preserves the genuine refresh
token. Installed SSR chunk helpers serialize the cookie. No OS/DB clock,
Auth TTL/configuration or app authentication code changes. This is an
artificial locally signed expired-token fixture with real GoTrue refresh.

Protected API refresh must return 200, every refreshed cookie must reach the
client, and an updated-cookie follow-up must return 200. Authenticated `/login`
and `/auth/callback` must redirect to `/` with refreshed cookies. Separate
expired sessions with invalid random refresh tokens must fail closed: API 401
and page redirect to `/login?next=/financial-summary`. Money tables are
snapshotted and must remain unchanged. Cookie values/tokens are never reported.

The follow-up established executable offline evidence using installed
`NextRequest`/`NextResponse` and a mocked SSR `getUser()` invoking the actual
Proxy cookie adapter. Before the app fix, authenticated protected-page
continuation preserved three cookies, while `/login`, `/auth/callback`, protected
API 401 and protected-page login redirect each returned zero cookies. The
persistent regression failed in those four cases. Proxy now copies only response
cookies into its three replacement-response branches. Refreshed chunks, obsolete
chunk deletion (`Max-Age=0`), path, HttpOnly, Secure, SameSite and Max-Age survive;
status, Location, unauthorized JSON and auth bypass behavior remain checked.
Continuation headers are not copied onto redirect/401 responses. All nine Proxy
tests pass. This proves the code-level loss and repair, not real GoTrue/browser
refresh. The host session suite still requires genuine refresh/redirect evidence;
its cookie assertions were not softened and no new host PASS is claimed.

## Local validation and handoff limits

Only offline/local process tests and the isolated local HTTP 302 fixture were
executed here. The Node suite verifies
guard scope, actual child run inheritance, rejection paths, cookie chunk/deletion
handling, fixture adaptation and nearest-rank percentiles, plus existing baseline
replay invariants. SQL contains assert-based workload checks; the authorized host
executed the August seed outside this sandbox. Final local check results follow.

| Executed local check | Result |
|---|---|
| Node harness/audit/c-stack and existing replay regressions, including real local manual 302 | 18 passed, 0 failed, 0 skipped; no host/DB command or migration replay executed |
| Financial page batching regression | 5 passed, 0 failed; 930 UUIDs / 4,650 rows, 1,043 assertions, fixture transport; first/middle/final batch rejection |
| Sales/evidence, lifecycle, settlement confidence, daily preflight and round-return regressions | 241 passed across seven files, 0 failed; includes 620-key batching and second-batch fail-closed |
| Monthly financial PDF regression | 2 passed, 0 failed; real local renderer, mocked DB, zero network attempts, all 31 preflights completed |
| Proxy cookie/auth and shared monthly fixture's yod-song regressions | 14 passed, 0 failed; nine Proxy and five yod-song tests |
| Focused ESLint on changed/new source, tests and harness scripts | Passed |
| Repository-wide `bun run lint` | Exit 1: 66 errors in existing ignored `.tmp-staging-uat-20261009` helper files (CommonJS require rule); 72 warnings across ignored helpers and existing source. Helpers/config preserved; no lint-rule suppression added |
| `bun run type-check` | Passed |
| Changed audit/session/harness Node syntax | Passed through Node test imports; ignored host launchers were not rechecked in this follow-up |
| Git whitespace | Passed; HEAD remains `889d1c3` |

The reviewed ignored c launcher now pins the owned Docker pipe, avoids
printing synthetic keys on comparison failure, and reuses the tracked
`appEnvNames()` discovery to clear every statically referenced/root-dotenv
app key before applying explicit local settings. No build/deploy/server
restart was executed here.

The latest follow-up executed 280 focused tests in total (262 Bun, 18 Node),
all passing. Typecheck and focused lint passed; repository-wide lint remains
failed as recorded above. Host access was not retried after the documented
rejection. Exact live ownership and loopback guards were not freshly proven,
so real month/session reruns remain NOT TESTED. Full Staging and Production
remain **NO-GO** pending those gates and the prohibited 04:05 gate.

No push, merge, PR, deployment, Production Supabase, Vercel/Neon, real LINE,
cloud cron, third-party credential, real-record or host PG5432 operation occurred.
Ignored launch/runtime files and all credentials remain untracked. No commit
was attempted; the prior report records inaccessible shared Git index metadata
outside the writable worktree. Leave the validated diff for the authorized host
coordinator to review and commit. The large pre-existing diff was not all reviewed
for commit, and absence of other local-session writers was not established.
No staging or commit was attempted. Do not stage `.tmp`.
