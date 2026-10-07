/**
 * Real PostgreSQL 17 proof for migration 20260825092703_data_quality_issues.sql.
 *
 * The table is standalone (no FKs into the rest of the schema), so the only
 * migration applied here is this one — no bootstrap chain needed. This test
 * proves the constraints the application logic (src/lib/data-quality/inbox.ts)
 * relies on are ALSO enforced at the database level, not just in app code:
 *   - issue_key UNIQUE — the actual dedup guarantee behind "one row per
 *     underlying problem", enforced even if a future caller bypasses
 *     the atomic runner and inserts directly.
 *   - severity CHECK — NORMAL can never be persisted (matches severity.ts's
 *     "NORMAL never reaches the table" contract).
 *   - status CHECK — only OPEN/RESOLVED/IGNORED.
 *   - resolved_at IS NULL iff status = 'OPEN' — resolution metadata can never
 *     be partially set.
 *
 * SKIP (not a failing red) when PostgreSQL 17 is unavailable or the
 * ALLOW_DISPOSABLE_POSTGRES_TESTS=1 guard is not set.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { SQL } from "bun";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { validateProduceEntry } from "@/lib/produce/entry-validation";
import { buildProduceReconciliationIssues } from "@/lib/produce/reconciliation-issues";
import { prepareAtomicUpsertPayload } from "./inbox";

const ROOT = join(import.meta.dir, "..", "..", "..");
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `dqi_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^dqi_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MIGRATION = join(ROOT, "supabase", "migrations", "20260825092703_data_quality_issues.sql");
const RUNNER_MIGRATION = join(ROOT, "supabase", "migrations", "20260827065840_data_quality_atomic_upsert.sql");

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-data-quality-issues.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(args: string[], database = DATABASE): Promise<PsqlResult> {
  const host = PGHOST.includes(":") ? `[${PGHOST}]` : PGHOST;
  const url = `postgres://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}`
    + `@${host}:${PGPORT}/${encodeURIComponent(database)}`;
  const sql = new SQL(url, { max: 1 });

  try {
    const fileIndex = args.indexOf("-f");
    const commandIndex = args.findIndex((arg) => arg === "-c" || arg === "-tAc");
    const query = fileIndex >= 0
      ? readFileSync(args[fileIndex + 1]!, "utf8")
      : args[commandIndex + 1]!;
    const rows = fileIndex >= 0
      ? await sql.unsafe(query).simple()
      : await sql.unsafe(query);
    const stdout = Array.from(rows as Array<Record<string, unknown>>)
      .map((row) => Object.values(row).map((value) => {
        if (typeof value === "boolean") return value ? "t" : "f";
        if (value === null || value === undefined) return "";
        return String(value);
      }).join("|"))
      .join("\n");
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    await sql.close();
  }
}

async function scalar(sql: string): Promise<string> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/** Runs SQL expected to fail; returns the combined error text. */
async function expectSqlError(sql: string): Promise<string> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-tAc", sql]);
  if (result.code === 0) throw new Error(`expected SQL to fail but it succeeded: ${sql}`);
  return result.stderr || result.stdout;
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 130000;
  } catch {
    return false;
  }
}

const pgAvailable = await probe();
let databaseCreated = false;

function insertIssue(overrides: Partial<{
  issue_key: string;
  category: string;
  severity: string;
  business_date: string;
  summary_th: string;
  status: string;
  resolved_at: string | null;
}> = {}): string {
  const row = {
    issue_key: "k1",
    category: "produce_no_return",
    severity: "ACTION_REQUIRED",
    business_date: "2026-08-25",
    summary_th: "test",
    status: "OPEN",
    resolved_at: null as string | null,
    ...overrides,
  };
  const resolvedAtSql = row.resolved_at === null ? "NULL" : `'${row.resolved_at}'`;
  return `
    INSERT INTO public.data_quality_issues
      (issue_key, category, severity, business_date, summary_th, status, resolved_at)
    VALUES
      ('${row.issue_key}', '${row.category}', '${row.severity}', '${row.business_date}',
       '${row.summary_th}', '${row.status}', ${resolvedAtSql})
  `;
}

type RunnerCandidate = {
  issue_key: string;
  category: string;
  severity: string;
  business_date: string;
  affected_refs: string[];
  summary_th: string;
  technical_context: Record<string, unknown>;
};

function runnerCandidate(overrides: Partial<RunnerCandidate> = {}): RunnerCandidate {
  return {
    issue_key: "produce_no_return::2026-08-25::round-runner",
    category: "produce_no_return",
    severity: "ACTION_REQUIRED",
    business_date: "2026-08-25",
    affected_refs: ["round-runner"],
    summary_th: "missing return",
    technical_context: { source: "pg-test" },
    ...overrides,
  };
}

function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function runnerSql(candidates: readonly RunnerCandidate[], seenAt: string): string {
  return `SELECT count(*) FROM public.upsert_data_quality_issues(`
    + `'${sqlLiteral(JSON.stringify(candidates))}'::jsonb, '${sqlLiteral(seenAt)}'::timestamptz)`;
}

describe.skipIf(!pgAvailable)("data_quality_issues migration on PostgreSQL", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(MIGRATION);
    await apply(RUNNER_MIGRATION);
  }, 60_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  }, 60_000);

  test("a normal insert round-trips with defaults (id, first_seen, last_seen, created_at)", async () => {
    await psql(["-v", "ON_ERROR_STOP=1", "-c", insertIssue({ issue_key: "roundtrip-1" })]);
    expect(await scalar("SELECT status FROM public.data_quality_issues WHERE issue_key = 'roundtrip-1'")).toBe("OPEN");
    expect(await scalar("SELECT resolved_at IS NULL FROM public.data_quality_issues WHERE issue_key = 'roundtrip-1'")).toBe("t");
    expect(await scalar("SELECT id IS NOT NULL FROM public.data_quality_issues WHERE issue_key = 'roundtrip-1'")).toBe("t");
  });

  test("issue_key is UNIQUE — the actual dedup guarantee, enforced by the database itself", async () => {
    await psql(["-v", "ON_ERROR_STOP=1", "-c", insertIssue({ issue_key: "dup-key" })]);
    const error = await expectSqlError(insertIssue({ issue_key: "dup-key", category: "produce_price_conflict" }));
    expect(error).toMatch(/duplicate key value violates unique constraint/i);
    expect(await scalar("SELECT count(*) FROM public.data_quality_issues WHERE issue_key = 'dup-key'")).toBe("1");
  });

  test("severity is constrained to CRITICAL / ACTION_REQUIRED / ADVISORY — NORMAL can never be persisted", async () => {
    const error = await expectSqlError(insertIssue({ issue_key: "normal-1", severity: "NORMAL" }));
    expect(error).toMatch(/violates check constraint/i);
    expect(await scalar("SELECT count(*) FROM public.data_quality_issues WHERE issue_key = 'normal-1'")).toBe("0");
  });

  test("severity rejects an arbitrary invented value", async () => {
    const error = await expectSqlError(insertIssue({ issue_key: "bogus-severity", severity: "URGENT" }));
    expect(error).toMatch(/violates check constraint/i);
  });

  test("status is constrained to OPEN / RESOLVED / IGNORED", async () => {
    const error = await expectSqlError(insertIssue({ issue_key: "bogus-status", status: "DELETED" }));
    expect(error).toMatch(/violates check constraint/i);
  });

  test("resolved_at must be NULL for OPEN and NOT NULL for RESOLVED/IGNORED — never partially set", async () => {
    const openWithResolvedAt = await expectSqlError(
      insertIssue({ issue_key: "bad-open", status: "OPEN", resolved_at: "2026-08-25T00:00:00Z" }),
    );
    expect(openWithResolvedAt).toMatch(/violates check constraint/i);

    const resolvedWithoutResolvedAt = await expectSqlError(
      insertIssue({ issue_key: "bad-resolved", status: "RESOLVED", resolved_at: null }),
    );
    expect(resolvedWithoutResolvedAt).toMatch(/violates check constraint/i);

    // The valid pairing succeeds.
    await psql([
      "-v", "ON_ERROR_STOP=1", "-c",
      insertIssue({ issue_key: "good-resolved", status: "RESOLVED", resolved_at: "2026-08-25T00:00:00Z" }),
    ]);
    expect(await scalar("SELECT status FROM public.data_quality_issues WHERE issue_key = 'good-resolved'")).toBe("RESOLVED");
  });

  test("the status/business_date/severity indexes from the migration exist", async () => {
    for (const name of [
      "data_quality_issues_status_idx",
      "data_quality_issues_business_date_idx",
      "data_quality_issues_severity_idx",
      "data_quality_issues_status_date_idx",
    ]) {
      expect(
        await scalar(`SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='${name}'`),
      ).toBe("1");
    }
  });

  test("first scan inserts and second scan deduplicates while advancing last_seen", async () => {
    const row = runnerCandidate();
    expect(await scalar(runnerSql([row], "2026-08-25T10:00:00Z"))).toBe("1");
    expect(await scalar(runnerSql([{ ...row, summary_th: "refreshed" }], "2026-08-25T11:00:00Z"))).toBe("1");
    // A delayed concurrent request must not move last_seen backward.
    expect(await scalar(runnerSql([{ ...row, summary_th: "delayed" }], "2026-08-25T10:30:00Z"))).toBe("1");
    expect(await scalar(`SELECT count(*) FROM public.data_quality_issues WHERE issue_key='${row.issue_key}'`)).toBe("1");
    expect(await scalar(
      `SELECT first_seen='2026-08-25T10:00:00Z'::timestamptz
        AND last_seen='2026-08-25T11:00:00Z'::timestamptz
        AND summary_th='refreshed'
       FROM public.data_quality_issues WHERE issue_key='${row.issue_key}'`,
    )).toBe("t");
  });

  test("concurrent first scans converge on one issue_key row", async () => {
    const row = runnerCandidate({
      issue_key: "produce_no_return::2026-08-25::round-concurrent",
      affected_refs: ["round-concurrent"],
    });
    const results = await Promise.all([
      scalar(runnerSql([{ ...row, summary_th: "scan-a" }], "2026-08-25T10:00:00Z")),
      scalar(runnerSql([{ ...row, summary_th: "scan-b" }], "2026-08-25T10:00:01Z")),
    ]);
    expect(results).toEqual(["1", "1"]);
    expect(await scalar(
      `SELECT count(*) FROM public.data_quality_issues WHERE issue_key='${row.issue_key}'`,
    )).toBe("1");
    expect(await scalar(
      `SELECT last_seen='2026-08-25T10:00:01Z'::timestamptz
       FROM public.data_quality_issues WHERE issue_key='${row.issue_key}'`,
    )).toBe("t");
  });

  test("a recurring RESOLVED issue reopens and clears human resolution metadata", async () => {
    const row = runnerCandidate({
      issue_key: "produce_no_return::2026-08-25::round-resolved",
      affected_refs: ["round-resolved"],
    });
    await scalar(runnerSql([row], "2026-08-25T10:00:00Z"));
    await psql(["-v", "ON_ERROR_STOP=1", "-c", `
      UPDATE public.data_quality_issues
      SET status='RESOLVED', resolved_at='2026-08-25T10:30:00Z',
          resolved_by='admin', resolution_note='fixed'
      WHERE issue_key='${row.issue_key}'
    `]);

    await scalar(runnerSql([{ ...row, summary_th: "recurred" }], "2026-08-25T12:00:00Z"));
    expect(await scalar(
      `SELECT status='OPEN' AND resolved_at IS NULL AND resolved_by IS NULL
        AND resolution_note IS NULL AND summary_th='recurred'
       FROM public.data_quality_issues WHERE issue_key='${row.issue_key}'`,
    )).toBe("t");
  });

  test("a scan observed before a human resolution cannot reopen or overwrite it", async () => {
    const row = runnerCandidate({
      issue_key: "produce_no_return::2026-08-25::round-resolution-race",
      affected_refs: ["round-resolution-race"],
      summary_th: "before resolution",
    });
    await scalar(runnerSql([row], "2026-08-25T10:00:00Z"));
    await psql(["-v", "ON_ERROR_STOP=1", "-c", `
      UPDATE public.data_quality_issues
      SET status='RESOLVED', resolved_at='2026-08-25T12:00:00Z',
          resolved_by='admin', resolution_note='fixed later'
      WHERE issue_key='${row.issue_key}'
    `]);

    await scalar(runnerSql([{ ...row, summary_th: "stale scan" }], "2026-08-25T11:00:00Z"));
    expect(await scalar(
      `SELECT status='RESOLVED' AND resolved_by='admin'
        AND resolution_note='fixed later' AND summary_th='before resolution'
       FROM public.data_quality_issues WHERE issue_key='${row.issue_key}'`,
    )).toBe("t");
  });

  test("an IGNORED issue only advances last_seen and preserves human metadata and details", async () => {
    const row = runnerCandidate({
      issue_key: "produce_no_return::2026-08-25::round-ignored",
      affected_refs: ["round-ignored"],
      summary_th: "original",
    });
    await scalar(runnerSql([row], "2026-08-25T10:00:00Z"));
    await psql(["-v", "ON_ERROR_STOP=1", "-c", `
      UPDATE public.data_quality_issues
      SET status='IGNORED', resolved_at='2026-08-25T10:30:00Z',
          resolved_by='admin', resolution_note='accepted'
      WHERE issue_key='${row.issue_key}'
    `]);

    await scalar(runnerSql([{
      ...row,
      severity: "CRITICAL",
      summary_th: "must not replace ignored detail",
      technical_context: { changed: true },
    }], "2026-08-25T12:00:00Z"));
    expect(await scalar(
      `SELECT status='IGNORED' AND severity='ACTION_REQUIRED' AND summary_th='original'
        AND resolved_by='admin' AND resolution_note='accepted'
        AND last_seen='2026-08-25T12:00:00Z'::timestamptz
       FROM public.data_quality_issues WHERE issue_key='${row.issue_key}'`,
    )).toBe("t");
  });

  test("the same entity and category on different business dates stays separate", async () => {
    const rows = [
      runnerCandidate({
        issue_key: "produce_no_return::2026-08-25::round-date",
        affected_refs: ["round-date"],
      }),
      runnerCandidate({
        issue_key: "produce_no_return::2026-08-26::round-date",
        business_date: "2026-08-26",
        affected_refs: ["round-date"],
      }),
    ];
    expect(await scalar(runnerSql(rows, "2026-08-26T10:00:00Z"))).toBe("2");
    expect(await scalar(
      "SELECT count(*) FROM public.data_quality_issues WHERE issue_key LIKE 'produce_no_return::2026-08-2%::round-date'",
    )).toBe("2");
  });

  test("ADVISORY remains advisory and an empty scan is safe", async () => {
    const advisory = runnerCandidate({
      issue_key: "produce_price_conflict::2026-08-25::fruit::kg",
      category: "produce_price_conflict",
      severity: "ADVISORY",
      affected_refs: ["fruit::kg"],
    });
    expect(await scalar(runnerSql([advisory], "2026-08-25T10:00:00Z"))).toBe("1");
    expect(await scalar(
      `SELECT severity FROM public.data_quality_issues WHERE issue_key='${advisory.issue_key}'`,
    )).toBe("ADVISORY");
    expect(await scalar(runnerSql([], "2026-08-25T10:00:00Z"))).toBe("0");
  });

  test("Produce reconciliation issues persist as ADVISORY and a replay is idempotent", async () => {
    const parsed = parseWeighSession([
      "ดำ-ตลาด ชั่งคืน 6/10/2569",
      "1.องุ่นแดง120บาท", "3ถุง",
      "1.มังคุด60บาท", "2กิโล",
    ].join("\n"), "2026-10-06");
    const result = validateProduceEntry({
      parsed,
      roundBound: true,
      roundRows: [
        { product_name: "องุ่นแดง", unit: "แพค", quantity: 5, price_per_unit: 120, transaction_type: "เบิก" },
        { product_name: "มังคุด", unit: "โล", quantity: 1, price_per_unit: 60, transaction_type: "เบิก" },
      ],
    });
    const payload = prepareAtomicUpsertPayload(buildProduceReconciliationIssues({
      produceSessionId: "ps-pg", pendingSessionKey: "key-pg", pendingSessionGeneration: "gen-pg",
      accountabilityRoundId: null, parsed, reconciliation: result.reconciliation,
    })) as unknown as RunnerCandidate[];
    expect(payload).toHaveLength(3);

    expect(await scalar(runnerSql(payload, "2026-10-06T10:00:00Z"))).toBe("3");
    expect(await scalar(runnerSql(payload, "2026-10-06T11:00:00Z"))).toBe("3");
    expect(await scalar(
      "SELECT count(*) FROM public.data_quality_issues WHERE affected_refs ? 'produce_session:ps-pg'",
    )).toBe("3");
    expect(await scalar(
      "SELECT string_agg(DISTINCT severity, ',') FROM public.data_quality_issues WHERE affected_refs ? 'produce_session:ps-pg'",
    )).toBe("ADVISORY");
    expect(await scalar(
      "SELECT technical_context->>'raw_unit' FROM public.data_quality_issues "
      + "WHERE category='produce_item_renumbered' AND affected_refs ? 'produce_session:ps-pg'",
    )).toBe("กิโล");
  });

  test("a bad candidate rolls back the complete multi-candidate scan", async () => {
    const valid = runnerCandidate({
      issue_key: "produce_no_return::2026-08-25::rollback-valid",
      affected_refs: ["rollback-valid"],
    });
    const invalid = runnerCandidate({
      issue_key: "produce_no_return::2026-08-25::rollback-invalid",
      affected_refs: ["rollback-invalid"],
      severity: "NORMAL",
    });
    const error = await expectSqlError(runnerSql([valid, invalid], "2026-08-25T10:00:00Z"));
    expect(error).toMatch(/candidate_severity_invalid/i);
    expect(await scalar(
      "SELECT count(*) FROM public.data_quality_issues WHERE issue_key LIKE '%rollback-%'",
    )).toBe("0");
  });

  test("a duplicate key inside one batch is refused before any row persists", async () => {
    const row = runnerCandidate({
      issue_key: "produce_no_return::2026-08-25::duplicate-batch",
      affected_refs: ["duplicate-batch"],
    });
    const error = await expectSqlError(runnerSql([row, row], "2026-08-25T10:00:00Z"));
    expect(error).toMatch(/duplicate_issue_key_in_batch/i);
    expect(await scalar(
      `SELECT count(*) FROM public.data_quality_issues WHERE issue_key='${row.issue_key}'`,
    )).toBe("0");
  });

  test("the atomic runner is executable only by service_role", async () => {
    expect(await scalar(
      "SELECT has_function_privilege('service_role', 'public.upsert_data_quality_issues(jsonb,timestamptz)', 'EXECUTE')",
    )).toBe("t");
    expect(await scalar(
      "SELECT has_function_privilege('anon', 'public.upsert_data_quality_issues(jsonb,timestamptz)', 'EXECUTE')",
    )).toBe("f");
    expect(await scalar(
      "SELECT has_function_privilege('authenticated', 'public.upsert_data_quality_issues(jsonb,timestamptz)', 'EXECUTE')",
    )).toBe("f");
  });

  test("re-applying the migration is refused (preflight guard), never silently duplicating the table", async () => {
    const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", MIGRATION]);
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/already applied/i);
  });
});
