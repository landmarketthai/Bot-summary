# Synthetic release validation (candidate, 2026-11-18)

- 269 app tests (184 summary/PDF/scope/migration, 41 route, 44 LINE); 21 actual
  PostgreSQL 17.10 tests, no skips or failures. The SQL suite mocks HTTP/cron
  interfaces. Typecheck and scoped ESLint passed; synthetic Next 16.3.4 build
  passed. Six synthetic PDF fixtures passed verifier (37 A4 landscape pages,
  140 products, 66 market rows). All contact sheets inspected.
- Fresh reconstructed replay on PostgreSQL 17: 139/139 phases, 135 repository
  migrations and four documented historical/bootstrap test prerequisites.
  Historical files and lock unchanged. Raw replay without the historical
  baseline is not represented as passing.
- Actual isolated Supabase PostgreSQL 17.6, pg_cron 1.6.4, pg_net 0.20.3:
  activation, suspended schedules, target parity, unresolved pending gate,
  delayed-slot dedupe, acceptance/no-repeat and rollback passed using synthetic
  stand-in source tables. Network disabled; HTTP queue transaction rolled back.
  Not a real timed worker/remote HTTP/LINE test or production inspection.
- CI is PR-only with exact npm ci, separate summary/route/LINE/PG suites and
  explicit failure on skipped SQL tests, typecheck, lint and synthetic build.
  Candidate Preview uses branch-scoped synthetic configuration with no real DB/provider credentials. Preview build is not end-to-end staging.
  Never bypass required Vercel status checks. No raw reviewer output, private
  identifiers, production rows, generated reports or local machine artifacts
  are included.
- Independent read-only code re-review: GO, no P0/P1 found; N1-N10 dispositions accepted. Remaining: CI, isolated staging with authorized test
  recipient, private live schema/target/cron/acceptance parity and safe cutover.
  Do not merge while a gate is unresolved.

Reproduce application suites with:
```sh
node scripts/test-morning-brief-v3.mjs --self-test
node scripts/test-morning-brief-v3.mjs summary
node scripts/test-morning-brief-v3.mjs route
node scripts/test-morning-brief-v3.mjs line
# PG only against a newly owned disposable loopback database, using synthetic values.
node scripts/test-morning-brief-v3.mjs pg
npm run type-check
```