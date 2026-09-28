/**
 * PostgreSQL 17 proof for generation-scoped ledger ownership
 * (20260926120000_produce_generation_scoped_ledger.sql).
 *
 * `pending_session_ingest` and `pending_session_admission` used to cascade off
 * `pending_sessions` keyed on `session_key` ALONE, even though one session_key
 * spans many generations (pending_sessions holds exactly one row per
 * session_key, mutated in place on every rotation — it is NOT an append-only
 * log of every generation that ever existed). Deleting the one pending_sessions
 * row for a session_key therefore erased ledger evidence for every OTHER
 * generation of that key too.
 *
 * This proves, against real PostgreSQL, seeded with MULTI-generation data:
 *   1. forward-applying the migration on top of existing multi-generation
 *      ledger rows creates ZERO orphans and loses ZERO rows, and drops the old
 *      session_key-only FK regardless of its name (one fixture FK is named
 *      non-conventionally on purpose);
 *   2. deleting one generation's new `pending_session_generations` registry row
 *      (what the fixed `PendingSessionService.deleteGeneration` now does)
 *      cascades ONLY that generation's ingest/admission rows — an older and a
 *      newer generation of the SAME session_key both survive untouched;
 *   3. a genuine full-key purge (`PendingSessionService.delete`) still cascades
 *      every generation, via the registry's own FK to pending_sessions;
 *   4. no future INSERT can create an orphan: the BEFORE INSERT trigger
 *      auto-registers a never-before-seen generation, and a session_key with no
 *      pending_sessions parent at all is still rejected;
 *   5. the migration is idempotent on double-apply;
 *   6. anon/authenticated cannot touch the registry.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";
const DATABASE = `gen_ledger_${randomBytes(4).toString("hex")}`;
const SAFE_DATABASE = /^gen_ledger_[a-f0-9]+$/;
const SAFE_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const MIGRATION = join(
  ROOT, "supabase", "migrations",
  "20260926120000_produce_generation_scoped_ledger.sql",
);
const BOOTSTRAP = join(
  ROOT, "supabase", "tests",
  "produce_generation_scoped_ledger_bootstrap.sql",
);

function assertSafe(): void {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1") {
    throw new Error(
      "migration-generation-scoped-ledger.pg.test.ts requires ALLOW_DISPOSABLE_POSTGRES_TESTS=1",
    );
  }
  if (!SAFE_HOSTS.has(PGHOST)) throw new Error(`refusing PGHOST=${PGHOST}`);
  if (!SAFE_DATABASE.test(DATABASE)) throw new Error(`refusing database=${DATABASE}`);
}

type PsqlResult = { code: number; stdout: string; stderr: string };

function spawnPsql(args: string[], database = DATABASE, stdin?: string) {
  return Bun.spawn([PSQL, "-X", ...args], {
    cwd: ROOT,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    env: {
      ...process.env,
      PGHOST,
      PGUSER,
      PGPASSWORD,
      PGPORT,
      PGDATABASE: database,
      PGCLIENTENCODING: "UTF8",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function collect(proc: ReturnType<typeof spawnPsql>): Promise<PsqlResult> {
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function psql(args: string[], database = DATABASE, stdin?: string): Promise<PsqlResult> {
  return collect(spawnPsql(args, database, stdin));
}

function run(sql: string): Promise<PsqlResult> {
  return psql(["-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], DATABASE, sql);
}

async function scalar(sql: string): Promise<string> {
  const result = await run(sql);
  if (result.code !== 0) throw new Error(`${result.stderr || result.stdout}\nSQL: ${sql}`);
  return result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

async function apply(file: string): Promise<void> {
  const result = await psql(["-v", "ON_ERROR_STOP=1", "-f", file]);
  expect(result.code, `${file}\n${result.stderr}\n${result.stdout}`).toBe(0);
}

async function probe(): Promise<boolean> {
  if (process.env.ALLOW_DISPOSABLE_POSTGRES_TESTS !== "1" || !SAFE_HOSTS.has(PGHOST)) return false;
  try {
    const result = await psql(["-tAc", "SHOW server_version_num"], "postgres");
    return result.code === 0 && Number(result.stdout.trim()) >= 170000;
  } catch {
    return false;
  }
}

function q(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

let sequence = 1;
function nextUuid(): string {
  return `00000000-0000-4000-a000-${String(sequence++).padStart(12, "0")}`;
}

async function seedPendingSession(sessionKey: string, generation: string): Promise<void> {
  await scalar(`
    INSERT INTO public.pending_sessions (session_key, session_generation)
    VALUES (${q(sessionKey)}, ${q(generation)}::uuid)
    ON CONFLICT (session_key) DO UPDATE SET session_generation = EXCLUDED.session_generation
    RETURNING 1`);
}

async function seedLedgerRow(
  sessionKey: string,
  generation: string,
  lineEventId: string,
  timestampMs = 1000,
): Promise<void> {
  await scalar(`
    INSERT INTO public.pending_session_admission (
      session_key, session_generation, line_event_id, line_timestamp_ms
    ) VALUES (${q(sessionKey)}, ${q(generation)}::uuid, ${q(lineEventId)}, ${timestampMs})
    RETURNING 1`);
  await scalar(`
    INSERT INTO public.pending_session_ingest (
      session_key, session_generation, line_event_id, line_timestamp_ms, raw_text
    ) VALUES (
      ${q(sessionKey)}, ${q(generation)}::uuid, ${q(lineEventId)}, ${timestampMs}, ${q("x")}
    ) RETURNING 1`);
}

async function ingestCount(sessionKey: string, generation?: string): Promise<number> {
  const filter = generation
    ? `session_key = ${q(sessionKey)} AND session_generation = ${q(generation)}::uuid`
    : `session_key = ${q(sessionKey)}`;
  return Number(await scalar(
    `SELECT count(*)::text FROM public.pending_session_ingest WHERE ${filter}`,
  ));
}

async function admissionCount(sessionKey: string, generation?: string): Promise<number> {
  const filter = generation
    ? `session_key = ${q(sessionKey)} AND session_generation = ${q(generation)}::uuid`
    : `session_key = ${q(sessionKey)}`;
  return Number(await scalar(
    `SELECT count(*)::text FROM public.pending_session_admission WHERE ${filter}`,
  ));
}

// Count FKs on a ledger table that still reference pending_sessions by
// session_key ALONE — the exact cross-generation cascade the migration removes.
// Catalog-driven, so it does not depend on the constraint's name.
async function residualSessionKeyOnlyFkCount(table: string): Promise<number> {
  return Number(await scalar(`
    SELECT count(*)::text
    FROM pg_constraint con
    WHERE con.conrelid = 'public.${table}'::regclass
      AND con.contype = 'f'
      AND con.confrelid = 'public.pending_sessions'::regclass
      AND con.conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.${table}'::regclass AND attname = 'session_key')
      ]`));
}

const pgAvailable = await probe();
let databaseCreated = false;
if (!pgAvailable && process.env.REQUIRE_GENERATION_LEDGER_POSTGRES === "1") {
  throw new Error("REQUIRE_GENERATION_LEDGER_POSTGRES=1 but the PostgreSQL 17 harness is unavailable");
}

describe.skipIf(!pgAvailable)("generation-scoped ledger ownership on PostgreSQL 17", () => {
  beforeAll(async () => {
    assertSafe();
    const created = await psql(["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`], "postgres");
    expect(created.code, created.stderr).toBe(0);
    databaseCreated = true;
    await apply(BOOTSTRAP);
  }, 120_000);

  afterAll(async () => {
    if (!databaseCreated) return;
    await psql(["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE}`], "postgres");
  });

  test("forward apply on top of pre-existing MULTI-generation data creates zero orphans, loses zero rows, and drops the old FK by name-independent discovery", async () => {
    const key = `group:test:forward:${nextUuid()}`;
    const genA = nextUuid();
    const genB = nextUuid();
    const genC = nextUuid();

    // Old schema (pre-migration): pending_sessions holds only the CURRENT
    // generation. genA and genB are already-rotated-away history; genC is
    // current. This is exactly production's shape (the vast majority of ingest
    // rows do not match their session_key's current generation).
    await seedPendingSession(key, genA);
    await seedLedgerRow(key, genA, "evt-a1", 1000);
    await seedLedgerRow(key, genA, "evt-a2", 1001);
    await seedPendingSession(key, genB);
    await seedLedgerRow(key, genB, "evt-b1", 2000);
    await seedPendingSession(key, genC);
    await seedLedgerRow(key, genC, "evt-c1", 3000);
    await seedLedgerRow(key, genC, "evt-c2", 3001);
    await seedLedgerRow(key, genC, "evt-c3", 3002);

    expect(await ingestCount(key)).toBe(6);
    expect(await admissionCount(key)).toBe(6);

    // Both fixture FKs (one conventional, one arbitrarily named) still present.
    expect(await residualSessionKeyOnlyFkCount("pending_session_ingest")).toBe(1);
    expect(await residualSessionKeyOnlyFkCount("pending_session_admission")).toBe(1);

    await apply(MIGRATION);

    // No row lost.
    expect(await ingestCount(key)).toBe(6);
    expect(await admissionCount(key)).toBe(6);
    expect(await ingestCount(key, genA)).toBe(2);
    expect(await ingestCount(key, genB)).toBe(1);
    expect(await ingestCount(key, genC)).toBe(3);

    // The old session_key-only FKs are gone from BOTH tables — including the
    // one the bootstrap named non-conventionally, proving catalog discovery.
    expect(await residualSessionKeyOnlyFkCount("pending_session_ingest")).toBe(0);
    expect(await residualSessionKeyOnlyFkCount("pending_session_admission")).toBe(0);

    // Zero orphans: every ledger row now has a matching registry parent.
    expect(await scalar(`
      SELECT count(*)::text FROM public.pending_session_ingest i
      WHERE NOT EXISTS (
        SELECT 1 FROM public.pending_session_generations g
        WHERE g.session_key = i.session_key AND g.session_generation = i.session_generation
      )`)).toBe("0");
    expect(await scalar(`
      SELECT count(*)::text FROM public.pending_session_admission a
      WHERE NOT EXISTS (
        SELECT 1 FROM public.pending_session_generations g
        WHERE g.session_key = a.session_key AND g.session_generation = a.session_generation
      )`)).toBe("0");

    // The registry itself has exactly the three generations, no more.
    expect(await scalar(`
      SELECT count(*)::text FROM public.pending_session_generations WHERE session_key = ${q(key)}`))
      .toBe("3");
  });

  test("deleting ONE generation's registry row cascades only that generation — older and newer survive", async () => {
    const key = `group:test:isolation:${nextUuid()}`;
    const genOld = nextUuid();
    const genMiddle = nextUuid();
    const genCurrent = nextUuid();

    await seedPendingSession(key, genOld);
    await seedLedgerRow(key, genOld, "evt-old-1");
    await seedPendingSession(key, genMiddle);
    await seedLedgerRow(key, genMiddle, "evt-mid-1");
    await seedLedgerRow(key, genMiddle, "evt-mid-2");
    await seedPendingSession(key, genCurrent);
    await seedLedgerRow(key, genCurrent, "evt-cur-1");

    // This is exactly what the fixed PendingSessionService.deleteGeneration
    // does: DELETE FROM pending_session_generations WHERE session_key = ...
    // AND session_generation = ... (no longer DELETE FROM pending_sessions).
    const deleted = await scalar(`
      DELETE FROM public.pending_session_generations
      WHERE session_key = ${q(key)} AND session_generation = ${q(genMiddle)}::uuid
      RETURNING 1`);
    expect(deleted).toBe("1");

    // The targeted generation's ledger rows are gone.
    expect(await ingestCount(key, genMiddle)).toBe(0);
    expect(await admissionCount(key, genMiddle)).toBe(0);

    // The OLDER generation is untouched — this is the exact defect: before the
    // fix, deleting any one generation's pending_sessions row cascaded away
    // every other generation's evidence too.
    expect(await ingestCount(key, genOld)).toBe(1);
    expect(await admissionCount(key, genOld)).toBe(1);

    // The NEWER (current) generation is untouched.
    expect(await ingestCount(key, genCurrent)).toBe(1);
    expect(await admissionCount(key, genCurrent)).toBe(1);

    // pending_sessions itself (the mutable current-generation pointer) is
    // untouched by a registry-scoped delete — only the registry's own FK points
    // AT pending_sessions, never the reverse.
    expect(await scalar(`
      SELECT session_generation::text FROM public.pending_sessions WHERE session_key = ${q(key)}`))
      .toBe(genCurrent);
  });

  test("a genuine full-key purge still cascades every generation, via the registry", async () => {
    const key = `group:test:full-purge:${nextUuid()}`;
    const genA = nextUuid();
    const genB = nextUuid();

    await seedPendingSession(key, genA);
    await seedLedgerRow(key, genA, "evt-a");
    await seedPendingSession(key, genB);
    await seedLedgerRow(key, genB, "evt-b");

    // This is PendingSessionService.delete(sessionKey) — a full, intentional
    // wipe of one session_key. Unchanged semantics: everything for this key
    // goes, exactly as it does today.
    await scalar(`DELETE FROM public.pending_sessions WHERE session_key = ${q(key)} RETURNING 1`);

    expect(await scalar(`
      SELECT count(*)::text FROM public.pending_session_generations WHERE session_key = ${q(key)}`))
      .toBe("0");
    expect(await ingestCount(key)).toBe(0);
    expect(await admissionCount(key)).toBe(0);
  });

  test("no future insert can create an orphan: a never-before-seen generation auto-registers", async () => {
    const key = `group:test:auto-register:${nextUuid()}`;
    const genInitial = nextUuid();
    const genRotated = nextUuid();
    await seedPendingSession(key, genInitial);

    // Simulate a rotation (replaceGeneration's UPDATE) followed directly by a
    // ledger insert for the brand-new generation, with no explicit registry
    // INSERT anywhere in the call path.
    await scalar(`
      UPDATE public.pending_sessions SET session_generation = ${q(genRotated)}::uuid
      WHERE session_key = ${q(key)} RETURNING 1`);
    await seedLedgerRow(key, genRotated, "evt-rotated");

    expect(await scalar(`
      SELECT count(*)::text FROM public.pending_session_generations
      WHERE session_key = ${q(key)} AND session_generation = ${q(genRotated)}::uuid`))
      .toBe("1");
    expect(await ingestCount(key, genRotated)).toBe(1);
  });

  test("a session_key with no pending_sessions parent at all is still rejected", async () => {
    const ghostKey = `group:test:ghost:${nextUuid()}`;
    const result = await run(`
      INSERT INTO public.pending_session_admission (
        session_key, session_generation, line_event_id, line_timestamp_ms
      ) VALUES (${q(ghostKey)}, ${q(nextUuid())}::uuid, 'evt-ghost', 1000)`);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("foreign key");
  });

  test("the migration is idempotent on double-apply", async () => {
    await apply(MIGRATION);

    expect(await scalar(`
      SELECT count(*)::text FROM pg_constraint
      WHERE conname = 'pending_session_ingest_generation_fkey'`)).toBe("1");
    expect(await scalar(`
      SELECT count(*)::text FROM pg_constraint
      WHERE conname = 'pending_session_admission_generation_fkey'`)).toBe("1");
    expect(await scalar(`
      SELECT convalidated::text FROM pg_constraint
      WHERE conname = 'pending_session_ingest_generation_fkey'`)).toBe("true");
    expect(await scalar(`
      SELECT convalidated::text FROM pg_constraint
      WHERE conname = 'pending_session_admission_generation_fkey'`)).toBe("true");
    // No session_key-only FK reappears on a second apply, by any name.
    expect(await residualSessionKeyOnlyFkCount("pending_session_ingest")).toBe(0);
    expect(await residualSessionKeyOnlyFkCount("pending_session_admission")).toBe(0);
    expect(await scalar(`
      SELECT count(*)::text FROM pg_trigger
      WHERE tgname = 'pending_session_ingest_register_generation'`)).toBe("1");
    expect(await scalar(`
      SELECT count(*)::text FROM pg_trigger
      WHERE tgname = 'pending_session_admission_register_generation'`)).toBe("1");
  });

  test("anon and authenticated cannot read or write the registry", async () => {
    expect(await scalar(`
      SELECT has_table_privilege('anon', 'public.pending_session_generations', 'SELECT')::text`))
      .toBe("false");
    expect(await scalar(`
      SELECT has_table_privilege('authenticated', 'public.pending_session_generations', 'INSERT')::text`))
      .toBe("false");
  });
});
