/**
 * Real PostgreSQL 17 proof for the Produce Product Dictionary Cleanup
 * migration (20260818100000): the ม54 spelling correction (ไชมัส → ไซมัส) and
 * the nine new ม63-ม71 codes, applied on top of the base dictionary seed
 * (20260813090000).
 *
 * Four things need proving before this runs against Production:
 *
 *  1. the composed state is exactly right — 262 rows, 262 enabled, ม=71,
 *     ม54 corrected, ม63-ม71 resolving to their exact approved names;
 *  2. the identity guard the base migration installs is STILL ARMED
 *     afterwards — this migration's own narrow, temporary DISABLE/ENABLE of
 *     that trigger must never leave it disabled in committed state, and this
 *     is the regression test that proves it;
 *  3. the migration is not silently destructive — no OTHER row's
 *     canonical_name moved;
 *  4. applying it a second time never corrupts state, whatever it decides to
 *     do (this migration RAISEs a clear "already applied" notice rather than
 *     silently no-opping — see its own header comment for why).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PRODUCT_CODE_ENTRIES } from "./product-code/dictionary";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `pdcl_${randomBytes(4).toString("hex")}`;
const DB_NAME_PATTERN = /^pdcl_[a-f0-9]+$/;
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const BASE_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260813115826_produce_product_code_dictionary.sql",
);
const CLEANUP_MIGRATION = join(
  ROOT, "supabase", "migrations", "20260818105651_produce_product_dictionary_cleanup.sql",
);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error("migration-product-dictionary-cleanup.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1");
  }
  if (!ALLOWED_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!DB_NAME_PATTERN.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

async function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  const proc = Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    // Thai canonical names are the whole point of this table; without an
    // explicit UTF-8 client encoding a Windows psql returns question marks.
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database, PGCLIENTENCODING: "UTF8" },
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

function run(sql: string): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
}

async function scalar(sql: string): Promise<string> {
  const result = await run(sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

async function expectFailure(sql: string): Promise<string> {
  const result = await run(sql);
  expect(result.code, `expected failure but succeeded:\n${sql}`).not.toBe(0);
  return `${result.stderr}${result.stdout}`;
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function applyExpectFailure(file: string): Promise<string> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `expected ${file} to fail but it succeeded`).not.toBe(0);
  return `${result.stderr}${result.stdout}`;
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !ALLOWED_HOSTS.has(PGHOST)) return false;
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_PRODUCT_CODE_POSTGRES === "1") {
  throw new Error("REQUIRE_PRODUCT_CODE_POSTGRES=1 but the PostgreSQL 17 harness is unavailable");
}

/** The other 252 base rows' canonical names, captured before the cleanup migration runs. */
let otherRowsBefore: Record<string, string> = {};

describe.skipIf(!pgAvailable)("Produce Product Dictionary Cleanup on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;

    await apply(BASE_MIGRATION);

    otherRowsBefore = JSON.parse(
      await scalar(`
        SELECT jsonb_object_agg(product_code, canonical_name)::text
        FROM public.produce_product_codes
        WHERE product_code <> 'ม54'`),
    ) as Record<string, string>;
    expect(Object.keys(otherRowsBefore)).toHaveLength(252);

    await apply(CLEANUP_MIGRATION);
  });

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`], "postgres");
  });

  // ── 1. The composed state is exactly right ────────────────────────────────

  test("composes to exactly 262 rows, 262 enabled, ม=71", async () => {
    expect(await scalar("SELECT count(*)::text FROM public.produce_product_codes")).toBe("262");
    expect(await scalar(
      "SELECT count(*)::text FROM public.produce_product_codes WHERE code_enabled",
    )).toBe("262");
    expect(await scalar(
      "SELECT count(*)::text FROM public.produce_product_codes WHERE category_code = 'ม'",
    )).toBe("71");
  });

  test("ม54 is corrected to ไซมัส", async () => {
    expect(await scalar(
      "SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม54'",
    )).toBe("ไซมัส");
  });

  test("ม63-ม71 resolve to their exact expected name and category ผลไม้", async () => {
    const expected: Array<[string, string]> = [
      ["ม63", "มะม่วงจิ้ว"],
      ["ม64", "ลูกพีชเล็ก"],
      ["ม65", "ลูกพีชใหญ่"],
      ["ม66", "ลูกไหนเขียว"],
      ["ม67", "ลูกไหนดำ"],
      ["ม68", "องุ่นคิมสัน"],
      ["ม69", "ส้มแมนดาริน"],
      ["ม70", "องุ่นเคียวโฮ"],
      ["ม71", "ลิ้นจี่"],
    ];
    for (const [code, name] of expected) {
      expect(await scalar(
        `SELECT canonical_name || '|' || category_name || '|' || category_code::text || '|' || code_enabled::text
         FROM public.produce_product_codes WHERE product_code = '${code}'`,
      )).toBe(`${name}|ผลไม้|ม|true`);
    }
  });

  test("matches PRODUCT_CODE_ENTRIES exactly, up through this migration", async () => {
    // This file is an isolated proof of migration 20260818100000 only: its
    // beforeAll applies the base seed + this cleanup migration and
    // deliberately does not apply 20260824090000 or any migration after it.
    // PRODUCT_CODE_ENTRIES is the full current approved set, so codes owned
    // by later dictionary migrations (ม72–ม80) are excluded from this comparison — the unscoped, full-table equality
    // against PRODUCT_CODE_ENTRIES is proven in
    // migration-product-code-dictionary.pg.test.ts, which composes every
    // migration in order.
    const CODES_FROM_LATER_MIGRATIONS = new Set(["ม72", "ม73", "ม74", "ม75", "ม76", "ม77", "ม78", "ม79", "ม80"]);
    const actual = JSON.parse(await scalar(
      "SELECT jsonb_object_agg(product_code, canonical_name)::text FROM public.produce_product_codes",
    )) as Record<string, string>;
    const expected = Object.fromEntries(
      PRODUCT_CODE_ENTRIES
        .filter((e) => !CODES_FROM_LATER_MIGRATIONS.has(e.code))
        .map((e) => [e.code, e.canonicalName]),
    );
    expect(actual).toEqual(expected);
  });

  // ── 2. The identity guard is still armed afterwards ───────────────────────

  test("the identity guard trigger is enabled (tgenabled = 'O') after the migration", async () => {
    expect(await scalar(`
      SELECT tgenabled::text FROM pg_trigger
      WHERE tgrelid = 'public.produce_product_codes'::regclass
        AND tgname = 'produce_product_codes_identity_guard'`)).toBe("O");
  });

  test("still refuses to repoint an UNRELATED row's canonical_name", async () => {
    const error = await expectFailure(
      "UPDATE public.produce_product_codes SET canonical_name = 'ทุเรียน' WHERE product_code = 'ม02'",
    );
    expect(error).toContain("identity is immutable");
    expect(await scalar(
      "SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม02'",
    )).toBe("กล้วยน้ำว้า");
  });

  test("still refuses to repoint ม54 itself a second time, outside a migration", async () => {
    const error = await expectFailure(
      "UPDATE public.produce_product_codes SET canonical_name = 'ทุเรียน' WHERE product_code = 'ม54'",
    );
    expect(error).toContain("identity is immutable");
    expect(await scalar(
      "SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม54'",
    )).toBe("ไซมัส");
  });

  test("still refuses to delete a released code, including a freshly issued one", async () => {
    const error = await expectFailure(
      "DELETE FROM public.produce_product_codes WHERE product_code = 'ม63'",
    );
    expect(error).toContain("must not be deleted");
    expect(await scalar("SELECT count(*)::text FROM public.produce_product_codes")).toBe("262");
  });

  // ── 3. Not silently destructive ───────────────────────────────────────────

  test("no OTHER row's canonical_name moved", async () => {
    const otherRowsAfter = JSON.parse(
      await scalar(`
        SELECT jsonb_object_agg(product_code, canonical_name)::text
        FROM public.produce_product_codes
        WHERE product_code <> 'ม54'
          AND product_code NOT IN ('ม63', 'ม64', 'ม65', 'ม66', 'ม67', 'ม68', 'ม69', 'ม70', 'ม71')`),
    ) as Record<string, string>;
    expect(Object.keys(otherRowsAfter)).toHaveLength(252);
    expect(otherRowsAfter).toEqual(otherRowsBefore);
  });

  // ── 4. Reapplication never corrupts state ─────────────────────────────────

  test("applying the cleanup migration a second time RAISEs rather than silently no-opping", async () => {
    const error = await applyExpectFailure(CLEANUP_MIGRATION);
    expect(error).toContain("already applied");

    // And state is exactly where the first application left it.
    expect(await scalar("SELECT count(*)::text FROM public.produce_product_codes")).toBe("262");
    expect(await scalar(
      "SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม54'",
    )).toBe("ไซมัส");
    expect(await scalar(`
      SELECT tgenabled::text FROM pg_trigger
      WHERE tgrelid = 'public.produce_product_codes'::regclass
        AND tgname = 'produce_product_codes_identity_guard'`)).toBe("O");
  });
});

// ── 5. The guard is proven healthy BEFORE it is bypassed ─────────────────────
//
// The cleanup migration steps around a business-identity invariant for one
// reviewed spelling correction. It may only do that from a proven-healthy
// start: a missing guard, or one already disabled, is drift it must neither
// silently inherit nor quietly repair by re-enabling something it did not
// disable. Proving refusal needs a database whose guard is unhealthy BEFORE
// the cleanup runs, so this gets its own scratch database.
describe.skipIf(!pgAvailable)("cleanup migration refuses an unhealthy identity guard", () => {
  const SCRATCH = `pdcl_${randomBytes(4).toString("hex")}`;
  let scratchCreated = false;

  const GUARD_STATE = `
    SELECT coalesce((
      SELECT tgenabled::text FROM pg_trigger
      WHERE tgrelid = 'public.produce_product_codes'::regclass
        AND tgname = 'produce_product_codes_identity_guard'), 'MISSING')`;

  function scratchPsql(args: string[]): Promise<PsqlResult> {
    return psql(args, SCRATCH);
  }
  // SQL goes in over stdin, never as a -c argument: Thai canonical names do not
  // survive a Windows psql command line, exactly as `run`/`scalar` above.
  async function scratchScalar(sql: string): Promise<string> {
    const result = await psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], SCRATCH, sql);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  async function scratchExec(sql: string): Promise<void> {
    const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", "-"], SCRATCH, sql);
    expect(result.code, result.stderr).toBe(0);
  }
  function applyCleanup(): Promise<PsqlResult> {
    return scratchPsql(["-v", "ON_ERROR_STOP=1", "-f", CLEANUP_MIGRATION]);
  }

  /** The dictionary as the base migration left it — nothing the cleanup would touch. */
  async function expectUntouched(): Promise<void> {
    expect(await scratchScalar("SELECT count(*)::text FROM public.produce_product_codes")).toBe("253");
    expect(await scratchScalar(
      "SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม54'",
    )).toBe("ไชมัส");
    expect(await scratchScalar(`
      SELECT count(*)::text FROM public.produce_product_codes
      WHERE product_code IN ('ม63','ม64','ม65','ม66','ม67','ม68','ม69','ม70','ม71')`)).toBe("0");
  }

  beforeAll(async () => {
    assertSafe();
    if (!DB_NAME_PATTERN.test(SCRATCH)) throw new Error(`refusing database=${SCRATCH}`);
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${SCRATCH}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    scratchCreated = true;

    const base = await scratchPsql(["-v", "ON_ERROR_STOP=1", "-f", BASE_MIGRATION]);
    expect(base.code, `${base.stderr}${base.stdout}`).toBe(0);
  });

  afterAll(async () => {
    if (!scratchCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`], "postgres");
  });

  test("the base migration leaves the guard normally enabled ('O')", async () => {
    expect(await scratchScalar(GUARD_STATE)).toBe("O");
  });

  test("refuses, mutating nothing, when the identity guard is ALREADY DISABLED", async () => {
    await scratchExec(
      "ALTER TABLE public.produce_product_codes DISABLE TRIGGER produce_product_codes_identity_guard",
    );
    expect(await scratchScalar(GUARD_STATE)).toBe("D");

    const result = await applyCleanup();
    expect(result.code, "cleanup migration must refuse a disabled guard").not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("unexpected state");

    // The refusal is total: no rename, no inserts, and it did not "repair" the
    // guard it never disabled.
    await expectUntouched();
    expect(await scratchScalar(GUARD_STATE)).toBe("D");
  });

  test("refuses, mutating nothing, when the identity guard is MISSING entirely", async () => {
    await scratchExec(
      "DROP TRIGGER produce_product_codes_identity_guard ON public.produce_product_codes",
    );
    expect(await scratchScalar(GUARD_STATE)).toBe("MISSING");

    const result = await applyCleanup();
    expect(result.code, "cleanup migration must refuse a missing guard").not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("missing");

    await expectUntouched();
    expect(await scratchScalar(GUARD_STATE)).toBe("MISSING");
  });

  test("applies cleanly once the guard is healthy again: 'O' before, 'O' after", async () => {
    await scratchExec(`
      CREATE TRIGGER produce_product_codes_identity_guard
        BEFORE UPDATE OR DELETE ON public.produce_product_codes
        FOR EACH ROW EXECUTE FUNCTION public.produce_product_codes_forbid_identity_mutation()`);
    expect(await scratchScalar(GUARD_STATE)).toBe("O");

    const result = await applyCleanup();
    expect(result.code, `${result.stderr}${result.stdout}`).toBe(0);

    expect(await scratchScalar(GUARD_STATE)).toBe("O");
    expect(await scratchScalar(
      "SELECT canonical_name FROM public.produce_product_codes WHERE product_code = 'ม54'",
    )).toBe("ไซมัส");
    expect(await scratchScalar("SELECT count(*)::text FROM public.produce_product_codes")).toBe("262");
    expect(await scratchScalar(`
      SELECT string_agg(canonical_name, ',' ORDER BY product_code)
      FROM public.produce_product_codes
      WHERE product_code IN ('ม63','ม64','ม65','ม66','ม67','ม68','ม69','ม70','ม71')`))
      .toBe("มะม่วงจิ้ว,ลูกพีชเล็ก,ลูกพีชใหญ่,ลูกไหนเขียว,ลูกไหนดำ,องุ่นคิมสัน,ส้มแมนดาริน,องุ่นเคียวโฮ,ลิ้นจี่");
  });
});
