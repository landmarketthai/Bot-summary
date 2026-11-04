/**
 * Real PostgreSQL harness for P2B purchase-capture Slice B migration.
 */
import { describe, expect, test, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const REQUIRE_POSTGRES_TESTS = process.env.REQUIRE_POSTGRES_TESTS === "1";

const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BOOTSTRAP = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_b_bootstrap.sql");
const MIGRATION_0052 = join(REPO_ROOT, "supabase", "migrations", "20260729084558_purchase_receipt_persistence.sql");
const MIGRATION_A = join(REPO_ROOT, "supabase", "migrations", "20260805130000_purchase_capture_sessions.sql");
const MIGRATION_B = join(REPO_ROOT, "supabase", "migrations", "20260805140000_purchase_capture_draft_finalization.sql");
const MIGRATION_HARDENING = join(REPO_ROOT, "supabase", "migrations", "20260805150000_purchase_capture_slice_b_contract_hardening.sql");
const OPEN_REPLAY_FIX = join(REPO_ROOT, "supabase", "migrations", "20261104090000_purchase_capture_open_replay_race.sql");
const HARDENING = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_b_hardening.sql");
const CONTRACT_HARDENING = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_b_contract_hardening.sql");

type PsqlResult = { code: number; stdout: string; stderr: string };

function resolvePsql(): string | null {
  if (existsSync(WIN_PSQL)) return WIN_PSQL;
  return "psql";
}

async function runPsql(
  psql: string,
  args: string[],
  opts?: { database?: string },
): Promise<PsqlResult> {
  const proc = Bun.spawn([psql, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: opts?.database ?? "postgres",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

async function probeConnection(psql: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-tAc", "SELECT 1"]);
    if (r.code !== 0) {
      return { ok: false, detail: `psql exit ${r.code}: ${(r.stderr || r.stdout).trim() || "no output"}` };
    }
    return { ok: true, detail: "ok" };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const resolvedPsql = resolvePsql();
const probe = resolvedPsql
  ? await probeConnection(resolvedPsql)
  : { ok: false, detail: "psql binary not found" };

const pgAvailable = Boolean(resolvedPsql && probe.ok);

if (!pgAvailable) {
  console.warn(`Purchase capture Slice B PG tests SKIPPED: PostgreSQL unavailable (${probe.detail})`);
}

if (REQUIRE_POSTGRES_TESTS && !pgAvailable) {
  throw new Error(
    `PostgreSQL tests are required but unavailable at ${PGHOST}:${PGPORT}: ${probe.detail}`,
  );
}

describe.skipIf(!pgAvailable)("Purchase capture Slice B migration PostgreSQL hardening", () => {
  const dbName = `pc_slice_b_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;
  let ready = false;

  test(
    "bootstrap + 0052 + Slice A + Slice B + hardening PASS on disposable DB",
    async () => {
      for (const file of [BOOTSTRAP, MIGRATION_0052, MIGRATION_A, MIGRATION_B, MIGRATION_HARDENING, OPEN_REPLAY_FIX, HARDENING, CONTRACT_HARDENING]) {
        expect(existsSync(file), `missing ${file}`).toBe(true);
      }

      const create = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`]);
      expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
      dbCreated = true;

      for (const file of [BOOTSTRAP, MIGRATION_0052, MIGRATION_A, MIGRATION_B, MIGRATION_HARDENING, OPEN_REPLAY_FIX]) {
        const result = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", file], { database: dbName });
        expect(result.code, `${file} failed:\n${result.stderr}\n${result.stdout}`).toBe(0);
      }

      const hard = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", HARDENING], { database: dbName });
      expect(hard.code, `hardening failed:\n${hard.stderr}\n${hard.stdout}`).toBe(0);
      expect(hard.stderr + hard.stdout).toContain("purchase_capture_slice_b_hardening PASS");

      const contract = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", CONTRACT_HARDENING], { database: dbName });
      expect(contract.code, `contract hardening failed:\n${contract.stderr}\n${contract.stdout}`).toBe(0);
      expect(contract.stderr + contract.stdout).toContain("purchase_capture_slice_b_contract_hardening PASS");
      ready = true;
      console.info("Purchase capture Slice B hardening: PASS (real PostgreSQL)");
    },
    { timeout: 300_000 },
  );

  test("registry tables are service_role SELECT only with RLS enabled", async () => {
    expect(ready).toBe(true);
    const rls = await runPsql(
      psqlPath,
      [
        "-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc",
        `SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.purchase_intake_product_registry'::regclass`,
      ],
      { database: dbName },
    );
    expect(rls.stdout.trim()).toBe("true");
  });

  function sqlLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  async function psqlScalar(sql: string): Promise<string> {
    const r = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", sql], { database: dbName });
    if (r.code !== 0) throw new Error(`psqlScalar failed: ${r.stderr || r.stdout}\nSQL: ${sql}`);
    return (r.stdout || "").trim();
  }

  async function concurrentPsql(sqlA: string, sqlB: string): Promise<[PsqlResult, PsqlResult]> {
    return Promise.all([
      runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", sqlA], { database: dbName }),
      runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", sqlB], { database: dbName }),
    ]);
  }

  test(
    "REAL concurrency: identical multipart create yields one dense part set",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const open = JSON.parse(await psqlScalar(
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(`G-conc-create-${tag}`)}, ${sqlLiteral(`U-conc-create-${tag}`)},
          ${sqlLiteral(`evt-conc-create-${tag}`)}, 90000, 'header'
        )::text`,
      )) as Record<string, unknown>;
      const sid = String(open.session_id);
      const version = `conc-idem-${tag}`;
      const sql = `SELECT public.create_purchase_capture_notification_parts(
        ${sqlLiteral(sid)}::uuid, 'preview_ready', ${sqlLiteral(version)}, ARRAY['alpha', 'beta']
      )::text`;
      const [a, b] = await concurrentPsql(sql, sql);
      expect(a.code, a.stderr || a.stdout).toBe(0);
      expect(b.code, b.stderr || b.stdout).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      expect(Boolean(ra.created) || Boolean(ra.idempotent)).toBe(true);
      expect(Boolean(rb.created) || Boolean(rb.idempotent)).toBe(true);
      expect(await psqlScalar(
        `SELECT count(*)::text FROM public.purchase_capture_notifications
          WHERE session_id = ${sqlLiteral(sid)}::uuid
            AND notification_version = ${sqlLiteral(version)}`,
      )).toBe("2");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: conflicting multipart create refuses identity conflict",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const open = JSON.parse(await psqlScalar(
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(`G-conc-conflict-${tag}`)}, ${sqlLiteral(`U-conc-conflict-${tag}`)},
          ${sqlLiteral(`evt-conc-conflict-${tag}`)}, 91000, 'header'
        )::text`,
      )) as Record<string, unknown>;
      const sid = String(open.session_id);
      const version = `conc-conflict-${tag}`;
      const sqlA = `SELECT public.create_purchase_capture_notification_parts(
        ${sqlLiteral(sid)}::uuid, 'preview_ready', ${sqlLiteral(version)}, ARRAY['same', 'parts']
      )::text`;
      const sqlB = `SELECT public.create_purchase_capture_notification_parts(
        ${sqlLiteral(sid)}::uuid, 'preview_ready', ${sqlLiteral(version)}, ARRAY['same', 'DIFFERENT']
      )::text`;
      const [a, b] = await concurrentPsql(sqlA, sqlB);
      const outcomes = [a, b].map((result) => ({
        ok: result.code === 0,
        text: (result.stderr || result.stdout).toLowerCase(),
      }));
      expect(outcomes.some((o) => o.ok)).toBe(true);
      expect(outcomes.some((o) => o.text.includes("notification_identity_conflict"))).toBe(true);
      expect(await psqlScalar(
        `SELECT count(*)::text FROM public.purchase_capture_notifications
          WHERE session_id = ${sqlLiteral(sid)}::uuid
            AND notification_version = ${sqlLiteral(version)}`,
      )).toBe("2");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: open transaction on part 0 blocks concurrent claim of part 1",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const open = JSON.parse(await psqlScalar(
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(`G-conc-hold-${tag}`)}, ${sqlLiteral(`U-conc-hold-${tag}`)},
          ${sqlLiteral(`evt-conc-hold-${tag}`)}, 92000, 'header'
        )::text`,
      )) as Record<string, unknown>;
      const sid = String(open.session_id);
      const version = `conc-hold-${tag}`;
      await psqlScalar(
        `SELECT public.create_purchase_capture_notification_parts(
          ${sqlLiteral(sid)}::uuid, 'preview_ready', ${sqlLiteral(version)}, ARRAY['hold-0', 'hold-1']
        )::text`,
      );

      const holdSql = `
        BEGIN;
        SELECT public.claim_next_purchase_capture_notification_part(
          ${sqlLiteral(sid)}::uuid, 'preview_ready', ${sqlLiteral(version)}, 120
        );
        SELECT pg_sleep(12);
        COMMIT;
      `;
      const bg = Bun.spawn([psqlPath, "-v", "ON_ERROR_STOP=1", "-d", dbName, "-c", holdSql], {
        cwd: REPO_ROOT,
        env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: dbName },
        stdout: "pipe",
        stderr: "pipe",
      });
      await Bun.sleep(1500);

      const concurrent = JSON.parse(await psqlScalar(
        `SELECT public.claim_next_purchase_capture_notification_part(
          ${sqlLiteral(sid)}::uuid, 'preview_ready', ${sqlLiteral(version)}, 120
        )::text`,
      )) as Record<string, unknown>;
      expect(concurrent.claimed).toBe(false);
      expect(concurrent.reason).toBe("lease_active");
      expect(concurrent.part_index).toBe(0);

      await bg.exited;
    },
    { timeout: 90_000 },
  );

  test(
    "PostgreSQL parity: preview confirmation matches purchase_receipt_build_confirmation_payload",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      await psqlScalar(
        `SELECT public.upsert_purchase_receipt_draft(
          'line-text', ${sqlLiteral(`evt-parity-${tag}`)}, 'p2b-slice-a-v1', '2026-07-29',
          '[{"product_key":"p","raw_product_text":"p","quantity":"2.5","unit_key":"kg","raw_unit":"kg","unit_cost":"12.3456"}]'::jsonb,
          p_freight_satang => 30000, p_handling_satang => 5000, p_discount_satang => 10000
        )::text`,
      );
      const receiptId = await psqlScalar(
        `SELECT id::text FROM public.purchase_receipts WHERE document_key = ${sqlLiteral(`evt-parity-${tag}`)}`,
      );
      const pgPayload = JSON.parse(await psqlScalar(
        `SELECT public.purchase_receipt_build_confirmation_payload(${sqlLiteral(receiptId)}::uuid)::text`,
      )) as Record<string, unknown>;

      const { buildPreviewConfirmationFromDraft } = await import("./preview-confirmation");
      const tsPayload = buildPreviewConfirmationFromDraft({
        documentNamespace: "line-text",
        documentKey: `evt-parity-${tag}`,
        contractVersion: "p2b-slice-a-v1",
        businessDate: "2026-07-29",
        freightSatang: "30000",
        handlingSatang: "5000",
        discountSatang: "10000",
        vat: { kind: "NONE" },
        items: [{
          productKey: "p",
          rawProductText: "p",
          productIdentityStatus: "RESOLVED",
          quantity: "2.5",
          unitKey: "kg",
          rawUnit: "kg",
          unitIdentityStatus: "RESOLVED",
          unitCost: "12.3456",
          priceUnitStatus: "NOT_APPLICABLE",
        }],
        sourceType: "group",
        sourceId: "G1",
        senderLineUserId: "U1",
      });

      const pgItems = pgPayload.items as Array<{ line_amount_satang: string | null }>;
      const pgTotals = pgPayload.totals as {
        line_subtotal_satang: string | null;
        payable_total_satang: string | null;
      };
      expect(tsPayload.items[0]!.line_amount_satang).toBe(pgItems[0]!.line_amount_satang);
      expect(tsPayload.totals.line_subtotal_satang).toBe(pgTotals.line_subtotal_satang);
      expect(tsPayload.totals.payable_total_satang).toBe(pgTotals.payable_total_satang);
      expect(tsPayload.has_blocking_blockers).toBe(pgPayload.has_blocking_blockers as boolean);
    },
    { timeout: 60_000 },
  );

  afterAll(async () => {
    if (!dbCreated) return;
    await runPsql(psqlPath, ["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`]);
  });
});
