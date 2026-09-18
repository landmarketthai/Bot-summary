/**
 * Real PostgreSQL harness for P2A migration 0047.
 *
 * - Creates a disposable DB, applies bootstrap + 0047 + hardening via psql.
 * - Runs REAL multi-connection concurrency cases (≥2 independent psql processes).
 * - SKIP (not green PASS) when psql/connection is unavailable.
 *
 * Env: PGPASSWORD=postgres (default), PGHOST=localhost, PGUSER=postgres
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const PGHOST = process.env.PGHOST ?? "localhost";
const PGUSER = process.env.PGUSER ?? "postgres";
const PGPASSWORD = process.env.PGPASSWORD ?? "postgres";
const PGPORT = process.env.PGPORT ?? "5432";

const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const BOOTSTRAP = join(REPO_ROOT, "supabase", "tests", "p2a_0047_bootstrap.sql");
const MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "0047_physical_inventory_capture.sql",
);
const PRICED_MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260803122757_priced_house_stock.sql",
);
const EMPTY_SNAPSHOT_MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260826102627_house_stock_explicit_empty.sql",
);
const UNSEND_CLOSE_CANCEL_MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260918090000_house_stock_unsend_close_cancel.sql",
);
const HARDENING = join(REPO_ROOT, "supabase", "tests", "p2a_0047_hardening.sql");

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
    const r = await runPsql(psql, [
      "-v",
      "ON_ERROR_STOP=1",
      "-d",
      "postgres",
      "-tAc",
      "SELECT 1",
    ]);
    if (r.code !== 0) {
      return {
        ok: false,
        detail: `psql exit ${r.code}: ${(r.stderr || r.stdout).trim() || "no output"}`,
      };
    }
    return { ok: true, detail: "ok" };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function psqlScalar(
  psql: string,
  database: string,
  sql: string,
): Promise<string> {
  const r = await runPsql(
    psql,
    ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sql],
    { database },
  );
  if (r.code !== 0) {
    throw new Error(`psqlScalar failed: ${r.stderr || r.stdout}\nSQL: ${sql}`);
  }
  return (r.stdout || "").trim();
}

async function psqlJson(
  psql: string,
  database: string,
  sql: string,
): Promise<Record<string, unknown>> {
  const raw = await psqlScalar(psql, database, sql);
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Two independent psql processes (two DB connections). */
async function concurrentPsql(
  psql: string,
  database: string,
  sqlA: string,
  sqlB: string,
): Promise<[PsqlResult, PsqlResult]> {
  return Promise.all([
    runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sqlA], {
      database,
    }),
    runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sqlB], {
      database,
    }),
  ]);
}

const resolvedPsql = resolvePsql();
const probe = resolvedPsql
  ? await probeConnection(resolvedPsql)
  : { ok: false, detail: "psql binary not found" };

const pgAvailable = Boolean(resolvedPsql && probe.ok);
const pgSkipReason = pgAvailable
  ? null
  : `SKIPPED: PostgreSQL unavailable (${probe.detail}). Tried: ${resolvedPsql ?? "none"}`;

if (pgSkipReason) {
  console.warn(`P2A 0047 PG tests ${pgSkipReason}`);
}

describe.skipIf(!pgAvailable)("P2A migration 0047 PostgreSQL hardening", () => {
  const dbName = `p2a_0047_hardening_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;
  let ready = false;

  test(
    "bootstrap + 0047 + hardening PASS on disposable DB",
    async () => {
      expect(existsSync(BOOTSTRAP)).toBe(true);
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(PRICED_MIGRATION)).toBe(true);
      expect(existsSync(EMPTY_SNAPSHOT_MIGRATION)).toBe(true);
      expect(existsSync(UNSEND_CLOSE_CANCEL_MIGRATION)).toBe(true);
      expect(existsSync(HARDENING)).toBe(true);

      const create = await runPsql(psqlPath, [
        "-v",
        "ON_ERROR_STOP=1",
        "-d",
        "postgres",
        "-c",
        `CREATE DATABASE ${dbName}`,
      ]);
      expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
      dbCreated = true;

      const boot = await runPsql(
        psqlPath,
        ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", BOOTSTRAP],
        { database: dbName },
      );
      expect(boot.code, `bootstrap failed:\n${boot.stderr}\n${boot.stdout}`).toBe(0);

      const pgcryptoSchema = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT n.nspname
           FROM pg_extension AS e
           JOIN pg_namespace AS n ON n.oid = e.extnamespace
          WHERE e.extname = 'pgcrypto'`,
      );
      const extensionsDigestExists = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT (to_regprocedure('extensions.digest(text,text)') IS NOT NULL)::text`,
      );
      const publicDigestAbsent = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT (to_regprocedure('public.digest(text,text)') IS NULL)::text`,
      );
      expect(pgcryptoSchema).toBe("extensions");
      expect(extensionsDigestExists).toBe("true");
      expect(publicDigestAbsent).toBe("true");

      const mig = await runPsql(
        psqlPath,
        ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", MIGRATION],
        { database: dbName },
      );
      expect(mig.code, `migration 0047 failed:\n${mig.stderr}\n${mig.stdout}`).toBe(0);
      expect(
        await psqlScalar(
          psqlPath,
          dbName,
          `SELECT public.physical_inventory_compute_ingest_set_hash(
             '00000000-0000-4000-8000-000000000001'::uuid
           )`,
        ),
      ).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      expect(
        await psqlScalar(
          psqlPath,
          dbName,
          `SELECT (
             to_regprocedure('extensions.digest(text,text)') IS NOT NULL
             AND to_regprocedure('public.digest(text,text)') IS NULL
           )::text`,
        ),
      ).toBe("true");

      const hard = await runPsql(
        psqlPath,
        ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", HARDENING],
        { database: dbName },
      );
      expect(hard.code, `hardening failed:\n${hard.stderr}\n${hard.stdout}`).toBe(0);
      expect(hard.stderr + hard.stdout).toContain("p2a_0047_hardening PASS");
      const priced = await runPsql(
        psqlPath,
        ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", PRICED_MIGRATION],
        { database: dbName },
      );
      expect(priced.code, `priced migration failed:\n${priced.stderr}\n${priced.stdout}`).toBe(0);
      const emptySnap = await runPsql(
        psqlPath,
        ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", EMPTY_SNAPSHOT_MIGRATION],
        { database: dbName },
      );
      expect(
        emptySnap.code,
        `explicit-empty migration failed:\n${emptySnap.stderr}\n${emptySnap.stdout}`,
      ).toBe(0);
      const unsendCancel = await runPsql(
        psqlPath,
        ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", UNSEND_CLOSE_CANCEL_MIGRATION],
        { database: dbName },
      );
      expect(
        unsendCancel.code,
        `unsend close-cancel migration failed:\n${unsendCancel.stderr}\n${unsendCancel.stdout}`,
      ).toBe(0);
      ready = true;
      console.info("P2A 0047 hardening: PASS (real PostgreSQL)");
    },
    { timeout: 180_000 },
  );

  test(
    "priced House Stock persists integer satang and inline close remains idempotent",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const event = `evt-priced-${tag}`;
      const opened = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${sqlLiteral(`G-priced-${tag}`)}, ${sqlLiteral(`U-priced-${tag}`)},
          ${sqlLiteral(event)}, 1000, 'complete document', NULL, NULL,
          '2026-08-03', 'house-stock-priced-1.0.0'
        )::text`,
      );
      const sid = String(opened.session_id);
      const gen = String(opened.session_generation);
      const closeSql = `SELECT public.close_physical_inventory_open_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, ${sqlLiteral(event)}
      )::text`;
      const firstClose = await psqlJson(psqlPath, dbName, closeSql);
      const secondClose = await psqlJson(psqlPath, dbName, closeSql);
      expect(firstClose.idempotent).toBe(false);
      expect(secondClose.idempotent).toBe(true);
      await psqlScalar(psqlPath, dbName, "SELECT pg_sleep(8.1)::text");
      const candidate = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_physical_inventory_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
        )::text`,
      );
      const items = JSON.stringify([{
        staff_sequence: 1,
        raw_text: "1 เขียวมรกต 30.50 บาท\\n1 โล",
        raw_product_description: "เขียวมรกต",
        normalized_product: "เขียวมรกต",
        quantity: 1,
        unit_price_satang: 3050,
        raw_unit: "โล",
        normalized_unit: "โล",
        resolution_status: "ACCEPTED_NORMALIZED",
        reason: null,
      }]);
      const finalized = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.finalize_physical_inventory_session(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${Number(candidate.ingest_revision)}, ${sqlLiteral(String(candidate.ingest_set_hash))},
          '2026-08-03', 'house-stock-priced-1.0.0', '[]'::jsonb,
          ${sqlLiteral(items)}::jsonb, false, NULL
        )::text`,
      );
      expect(finalized.status).toBe("finalized");
      expect(await psqlScalar(
        psqlPath,
        dbName,
        `SELECT unit_price_satang::text FROM public.physical_inventory_items
         WHERE snapshot_id = ${sqlLiteral(String(finalized.snapshot_id))}::uuid`,
      )).toBe("3050");
      expect(await psqlScalar(
        psqlPath,
        dbName,
        `SELECT has_function_privilege(
          'service_role',
          'public.finalize_physical_inventory_session_base(uuid,uuid,bigint,text,date,text,jsonb,jsonb,boolean,text)',
          'EXECUTE'
        )::text`,
      )).toBe("false");
    },
    { timeout: 60_000 },
  );

  test(
    "priced explicit empty snapshot persists with zero items and retry is idempotent",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const event = `evt-empty-${tag}`;
      const opened = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${sqlLiteral(`G-empty-${tag}`)}, ${sqlLiteral(`U-empty-${tag}`)},
          ${sqlLiteral(event)}, 1000, 'ผลไม้คงเหลือในบ้าน\n26/8/69', NULL, NULL,
          '2026-08-26', 'house-stock-priced-1.0.0'
        )::text`,
      );
      const sid = String(opened.session_id);
      const gen = String(opened.session_generation);
      await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`${event}-item`)}, 2000, 'item', '1ไม่มีผลไม้เหลือ', NULL, NULL
        )::text`,
      );
      await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`${event}-close`)}, 3000, 'close', 'จบ', NULL, NULL
        )::text`,
      );
      await psqlScalar(psqlPath, dbName, "SELECT pg_sleep(8.1)::text");
      const candidate = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_physical_inventory_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
        )::text`,
      );
      const finalizeSql = `SELECT public.finalize_physical_inventory_session(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
        ${Number(candidate.ingest_revision)}, ${sqlLiteral(String(candidate.ingest_set_hash))},
        '2026-08-26', 'house-stock-priced-1.0.0',
        '[{"code":"explicit_empty"}]'::jsonb, '[]'::jsonb, false, NULL
      )::text`;
      const finalized = await psqlJson(psqlPath, dbName, finalizeSql);
      expect(finalized.status).toBe("finalized");
      expect(Number(finalized.item_count)).toBe(0);
      expect(await psqlScalar(
        psqlPath,
        dbName,
        `SELECT item_count::text FROM public.physical_inventory_snapshots
         WHERE id = ${sqlLiteral(String(finalized.snapshot_id))}::uuid`,
      )).toBe("0");
      expect(await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_items
         WHERE snapshot_id = ${sqlLiteral(String(finalized.snapshot_id))}::uuid`,
      )).toBe("0");
      expect(await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_items
         WHERE raw_product_description = 'ไม่มีผลไม้เหลือ'`,
      )).toBe("0");
      const retry = await psqlJson(psqlPath, dbName, finalizeSql);
      expect(retry.idempotent).toBe(true);
      expect(retry.snapshot_id).toBe(finalized.snapshot_id);
      expect(await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_snapshots
         WHERE session_id = ${sqlLiteral(sid)}::uuid`,
      )).toBe("1");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: identical header open → one session, other idempotent",
    async () => {
      expect(ready).toBe(true);
      const evt = `evt-conc-open-${randomBytes(3).toString("hex")}`;
      const sql = `SELECT public.open_physical_inventory_session(
        'group', 'G-conc-open', 'U-conc-open', ${sqlLiteral(evt)}, 1000,
        'header', NULL, NULL, NULL, 'test'
      )::text`;
      const [a, b] = await concurrentPsql(psqlPath, dbName, sql, sql);
      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      const openedCount = [ra, rb].filter((r) => r.opened === true).length;
      const idemCount = [ra, rb].filter(
        (r) => r.idempotent === true || r.opened === false,
      ).length;
      expect(openedCount).toBe(1);
      expect(idemCount).toBe(1);
      expect(ra.session_id).toBe(rb.session_id);
      const nSess = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_sessions
         WHERE opened_line_event_id = ${sqlLiteral(evt)}`,
      );
      const nIngest = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_session_ingests
         WHERE line_event_id = ${sqlLiteral(evt)}`,
      );
      expect(nSess).toBe("1");
      expect(nIngest).toBe("1");
      console.info("concurrency identical open: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: identical item event → one ingest, both idempotent success",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${sqlLiteral(`G-conc-item-${tag}`)}, ${sqlLiteral(`U-conc-item-${tag}`)},
          ${sqlLiteral(`evt-conc-item-h-${tag}`)}, 2000, 'header', NULL, NULL, NULL, 'test'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      const evt = `evt-conc-item-${tag}`;
      const sql = `SELECT public.admit_physical_inventory_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
        ${sqlLiteral(evt)}, 2100, 'item', '7แตงโม', NULL, NULL
      )::text`;
      const [a, b] = await concurrentPsql(psqlPath, dbName, sql, sql);
      expect(a.code, `A failed: ${a.stderr || a.stdout}`).toBe(0);
      expect(b.code, `B failed: ${b.stderr || b.stdout}`).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      expect(ra.accepted).toBe(true);
      expect(rb.accepted).toBe(true);
      const inserted = [ra, rb].filter((r) => r.inserted === true).length;
      const dups = [ra, rb].filter((r) => r.reason === "duplicate_event").length;
      expect(inserted).toBe(1);
      expect(dups).toBe(1);
      const n = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_session_ingests
         WHERE line_event_id = ${sqlLiteral(evt)}`,
      );
      expect(n).toBe("1");
      console.info("concurrency identical item: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: admit vs close boundary inversion → no post-boundary in candidate",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${sqlLiteral(`G-conc-inv-${tag}`)}, ${sqlLiteral(`U-conc-inv-${tag}`)},
          ${sqlLiteral(`evt-conc-inv-h-${tag}`)}, 3000, 'header', NULL, NULL, NULL, 'test'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`evt-conc-inv-t1-${tag}`)}, 3100, 'item', 'T1', NULL, NULL
        )::text`,
      );

      const itemSql = `SELECT public.admit_physical_inventory_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
        ${sqlLiteral(`evt-conc-inv-t3-${tag}`)}, 3300, 'item', 'T3', NULL, NULL
      )::text`;
      const closeSql = `SELECT public.admit_physical_inventory_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
        ${sqlLiteral(`evt-conc-inv-close-${tag}`)}, 3200, 'close', 'จบ', NULL, NULL
      )::text`;

      const [itemRes, closeRes] = await concurrentPsql(
        psqlPath,
        dbName,
        itemSql,
        closeSql,
      );

      // One may error (after_close_boundary) if close won the lock first.
      const itemOk = itemRes.code === 0;
      const closeOk = closeRes.code === 0;
      expect(closeOk || itemOk).toBe(true);

      if (closeOk) {
        const close = JSON.parse(closeRes.stdout.trim()) as Record<string, unknown>;
        expect(Number(close.close_event_timestamp_ms)).toBe(3200);
      } else {
        // Close lost somehow — still force close so candidate has a boundary.
        const forced = await psqlJson(
          psqlPath,
          dbName,
          `SELECT public.admit_physical_inventory_event(
            ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
            ${sqlLiteral(`evt-conc-inv-close-${tag}`)}, 3200, 'close', 'จบ', NULL, NULL
          )::text`,
        );
        expect(Number(forced.close_event_timestamp_ms)).toBe(3200);
      }

      if (!itemOk) {
        expect(itemRes.stderr + itemRes.stdout).toContain("after_close_boundary");
      }

      const cand = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_physical_inventory_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
        )::text`,
      );
      const ingests = (cand.ingests as Array<{ line_event_id: string }>) ?? [];
      const t3Id = `evt-conc-inv-t3-${tag}`;
      expect(ingests.some((i) => i.line_event_id === t3Id)).toBe(false);

      // Evidence may or may not exist depending on lock order; either way
      // it must not appear in the authoritative candidate set.
      const evidence = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_session_ingests
         WHERE session_id = ${sqlLiteral(sid)}::uuid
           AND line_event_id = ${sqlLiteral(t3Id)}`,
      );
      if (evidence === "1") {
        expect(Number(cand.close_event_timestamp_ms)).toBe(3200);
      }
      console.info(
        `concurrency admit-vs-close: PASS (2 connections; t3_evidence=${evidence})`,
      );
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: late pre-boundary admit vs finalizer → no partial snapshot",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${sqlLiteral(`G-conc-fin-${tag}`)}, ${sqlLiteral(`U-conc-fin-${tag}`)},
          ${sqlLiteral(`evt-conc-fin-h-${tag}`)}, 4000, 'header', NULL, NULL, CURRENT_DATE, 'test'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`evt-conc-fin-i1-${tag}`)}, 4100, 'item', '1item', NULL, NULL
        )::text`,
      );
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`evt-conc-fin-close-${tag}`)}, 4200, 'close', 'จบ', NULL, NULL
        )::text`,
      );

      // Wait for quiet window so finalize is allowed.
      await Bun.sleep(8100);

      const cand = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_physical_inventory_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
        )::text`,
      );
      const rev = Number(cand.ingest_revision);
      const hash = String(cand.ingest_set_hash);

      // Barrier: hold session row lock in conn1 while conn2 races admit vs finalize.
      // Use a temp SQL file pair with advisory barrier via pg_sleep after lock.
      const tmp = mkdtempSync(join(tmpdir(), "p2a-conc-"));
      const lateSqlPath = join(tmp, "late.sql");
      const finSqlPath = join(tmp, "fin.sql");

      // Conn A: take session lock, sleep briefly, admit late pre-boundary item, commit.
      writeFileSync(
        lateSqlPath,
        `
BEGIN;
SELECT id FROM public.physical_inventory_sessions WHERE id = '${sid}'::uuid FOR UPDATE;
SELECT pg_sleep(0.4);
SELECT public.admit_physical_inventory_event(
  '${sid}'::uuid, '${gen}'::uuid,
  'evt-conc-fin-late-${tag}', 4150, 'item', 'late', NULL, NULL
);
COMMIT;
`,
      );

      // Conn B: sleep so A holds lock first, then finalize with pre-admit candidate.
      writeFileSync(
        finSqlPath,
        `
SELECT pg_sleep(0.15);
SELECT public.finalize_physical_inventory_session(
  '${sid}'::uuid, '${gen}'::uuid, ${rev}::bigint, '${hash}',
  CURRENT_DATE, 'test', '[]'::jsonb,
  '[{"raw_text":"1item","raw_product_description":"item","quantity":"1","raw_unit":"ลูก","resolution_status":"ACCEPTED_RAW"}]'::jsonb,
  false, NULL
);
`,
      );

      const [lateRes, finRes] = await Promise.all([
        runPsql(
          psqlPath,
          ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", lateSqlPath],
          { database: dbName },
        ),
        runPsql(
          psqlPath,
          ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", finSqlPath],
          { database: dbName },
        ),
      ]);

      rmSync(tmp, { recursive: true, force: true });

      // Late admit should succeed (pre-boundary) unless session already terminal.
      const lateOut = lateRes.stderr + lateRes.stdout;
      const finOut = finRes.stderr + finRes.stdout;

      const nSnap = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_snapshots
         WHERE session_id = ${sqlLiteral(sid)}::uuid`,
      );
      const status = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT status FROM public.physical_inventory_sessions
         WHERE id = ${sqlLiteral(sid)}::uuid`,
      );
      const nItems = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT coalesce((
           SELECT count(*)::text FROM public.physical_inventory_items i
           JOIN public.physical_inventory_snapshots s ON s.id = i.snapshot_id
           WHERE s.session_id = ${sqlLiteral(sid)}::uuid
         ), '0')`,
      );

      // Invariant: never a partial snapshot. Either finalized with coherent
      // item_count matching items rows, or not finalized (stale rejected).
      if (nSnap === "1") {
        expect(status).toBe("finalized");
        const itemCount = await psqlScalar(
          psqlPath,
          dbName,
          `SELECT item_count::text FROM public.physical_inventory_snapshots
           WHERE session_id = ${sqlLiteral(sid)}::uuid`,
        );
        expect(nItems).toBe(itemCount);
        const snapHash = await psqlScalar(
          psqlPath,
          dbName,
          `SELECT finalized_ingest_hash FROM public.physical_inventory_snapshots
           WHERE session_id = ${sqlLiteral(sid)}::uuid`,
        );
        const liveHash = await psqlScalar(
          psqlPath,
          dbName,
          `SELECT public.physical_inventory_compute_ingest_set_hash(${sqlLiteral(sid)}::uuid)`,
        );
        // If late admit landed before finalize under lock, hashes must match
        // the persisted set; if finalize won first, late may have failed closed.
        if (lateRes.code === 0 && !lateOut.includes("session_closed")) {
          // Finalize either used updated revision (wouldn't with stale cand)
          // or rejected stale — if snapshot exists with old hash, late must
          // have been rejected or arrived after terminal.
          const lateAdmitted = lateOut.includes("admitted") || lateOut.includes('"inserted": true');
          if (lateAdmitted && status === "finalized") {
            // Late admit then finalize with stale hash must not have produced
            // a snapshot from stale candidate — finalize should have failed.
            // If we have a snapshot, it must match live hash at finalize time.
            // Live hash now includes late item; snap may be pre-late only if
            // finalize won before late — then late hits session_closed.
            expect(
              snapHash === liveHash || finOut.includes("stale_ingest"),
            ).toBe(true);
          }
        }
      } else {
        expect(nSnap).toBe("0");
        // Finalize rejected as stale, or both raced without commit — session not partially written.
        expect(["closing", "failed_closed", "finalized"]).toContain(status);
        if (status === "finalized") {
          throw new Error("finalized without snapshot row");
        }
        expect(finRes.code !== 0 || finOut.includes("stale_ingest")).toBe(true);
      }

      console.info(
        `concurrency late-admit-vs-finalizer: PASS (2 connections; status=${status}, snaps=${nSnap})`,
      );
    },
    { timeout: 120_000 },
  );

  test(
    "REAL concurrency: two finalizers → one immutable snapshot",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${sqlLiteral(`G-conc-2fin-${tag}`)}, ${sqlLiteral(`U-conc-2fin-${tag}`)},
          ${sqlLiteral(`evt-conc-2fin-h-${tag}`)}, 5000, 'header', NULL, NULL, CURRENT_DATE, 'test'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`evt-conc-2fin-i1-${tag}`)}, 5100, 'item', '1item', NULL, NULL
        )::text`,
      );
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`evt-conc-2fin-close-${tag}`)}, 5200, 'close', 'จบ', NULL, NULL
        )::text`,
      );
      await Bun.sleep(8100);

      const cand = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_physical_inventory_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
        )::text`,
      );
      const rev = Number(cand.ingest_revision);
      const hash = String(cand.ingest_set_hash);
      const finSql = `SELECT public.finalize_physical_inventory_session(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, ${rev}::bigint, ${sqlLiteral(hash)},
        CURRENT_DATE, 'test', '[]'::jsonb,
        '[{"raw_text":"1item","raw_product_description":"item","quantity":"1","raw_unit":"ลูก","resolution_status":"ACCEPTED_RAW"}]'::jsonb,
        false, NULL
      )::text`;

      const [a, b] = await concurrentPsql(psqlPath, dbName, finSql, finSql);
      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
      expect(ra.snapshot_id).toBe(rb.snapshot_id);
      const idemCount = [ra, rb].filter((r) => r.idempotent === true).length;
      const firstCount = [ra, rb].filter((r) => r.idempotent === false).length;
      expect(firstCount).toBe(1);
      expect(idemCount).toBe(1);
      const nSnap = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.physical_inventory_snapshots
         WHERE session_id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(nSnap).toBe("1");
      console.info("concurrency dual-finalizer: PASS (2 connections)");
    },
    { timeout: 120_000 },
  );

  test(
    "candidate consistency: ingest around acquisition stays coherent",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${sqlLiteral(`G-cand-${tag}`)}, ${sqlLiteral(`U-cand-${tag}`)},
          ${sqlLiteral(`evt-cand-h-${tag}`)}, 6000, 'header', NULL, NULL, NULL, 'test'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`evt-cand-i1-${tag}`)}, 6100, 'item', '1', NULL, NULL
        )::text`,
      );

      const candSql = `SELECT public.get_physical_inventory_finalize_candidate(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
      )::text`;
      const admitSql = `SELECT public.admit_physical_inventory_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
        ${sqlLiteral(`evt-cand-i2-${tag}`)}, 6200, 'item', '2', NULL, NULL
      )::text`;

      const [candRes, admitRes] = await concurrentPsql(
        psqlPath,
        dbName,
        candSql,
        admitSql,
      );
      expect(candRes.code, candRes.stderr).toBe(0);
      expect(admitRes.code, admitRes.stderr).toBe(0);

      const cand = JSON.parse(candRes.stdout.trim()) as {
        ingest_revision: number;
        ingest_set_hash: string;
        ingests: Array<{ line_event_id: string; ingest_revision: number }>;
      };
      const ids = cand.ingests.map((i) => i.line_event_id);
      const maxRev = cand.ingests.reduce(
        (m, i) => Math.max(m, i.ingest_revision),
        0,
      );
      // Revision metadata must match the returned ingest set (one snapshot).
      expect(cand.ingest_revision).toBe(maxRev);
      expect(ids.includes(`evt-cand-i2-${tag}`) ? ids.length >= 3 : ids.length >= 2).toBe(
        true,
      );

      // Recompute hash from returned rows using same eligibility (no close yet = all).
      // Hash from RPC must equal DB compute at a coherent revision: either pre or post admit.
      const liveHash = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.physical_inventory_compute_ingest_set_hash(${sqlLiteral(sid)}::uuid)`,
      );
      const liveRev = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT ingest_revision::text FROM public.physical_inventory_sessions
         WHERE id = ${sqlLiteral(sid)}::uuid`,
      );
      // Candidate was a coherent snapshot: if it saw i2, hash matches live; if not,
      // its revision is strictly behind live and its hash differs from live.
      if (ids.includes(`evt-cand-i2-${tag}`)) {
        expect(cand.ingest_set_hash).toBe(liveHash);
        expect(String(cand.ingest_revision)).toBe(liveRev);
      } else {
        expect(cand.ingest_revision).toBeLessThan(Number(liveRev));
        expect(cand.ingest_set_hash).not.toBe(liveHash);
      }
      // Internal consistency: hash equals compute over exactly the returned set.
      // (no close boundary → compute includes all session ingests at that rev;
      //  we verify via recount of returned ids vs revision.)
      expect(cand.ingests.every((i) => i.ingest_revision <= cand.ingest_revision)).toBe(
        true,
      );
      console.info("candidate consistency under concurrent ingest: PASS");
    },
    { timeout: 60_000 },
  );

  test(
    "cancel_physical_inventory_close reopens a still-closing session; a stale finalize then fails",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const groupId = sqlLiteral(`G-unsend-${tag}`);
      const senderId = sqlLiteral(`U-unsend-${tag}`);

      const opened = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${groupId}, ${senderId},
          ${sqlLiteral(`evt-unsend-h-${tag}`)}, 1000, 'header', NULL, NULL, NULL, 'test'
        )::text`,
      );
      const sid = String(opened.session_id);
      const gen = String(opened.session_generation);

      // Reproduce the real operator shape: four items exist before the
      // accidentally-sent close.
      for (let i = 1; i <= 4; i += 1) {
        const admitted = await psqlJson(
          psqlPath,
          dbName,
          `SELECT public.admit_physical_inventory_event(
            ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
            ${sqlLiteral(`evt-unsend-item-${i}-${tag}`)}, ${1100 + i * 100},
            'item', ${sqlLiteral(`item ${i}`)}, NULL, NULL
          )::text`,
        );
        expect(admitted.accepted).toBe(true);
      }

      const closeEventId = `evt-unsend-close-${tag}`;
      const closed = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(closeEventId)}, 2000, 'close', 'จบ', NULL, NULL
        )::text`,
      );
      expect(closed.status).toBe("closing");

      // Capture what a finalizer could have read before the unsend wins.
      const staleCandidate = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_physical_inventory_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
        )::text`,
      );

      // Real finalize would still fail here (quiet window not elapsed) — the
      // cancel must win the race deterministically, not by timing luck.
      const canceled = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.cancel_physical_inventory_close(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, ${sqlLiteral(closeEventId)}
        )::text`,
      );
      expect(canceled.canceled).toBe(true);
      expect(canceled.status).toBe("open");

      const reopened = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT status FROM public.physical_inventory_sessions WHERE id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(reopened).toBe("open");
      const boundaryCleared = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT (
           close_event_timestamp_ms IS NULL
           AND close_quiet_until IS NULL
           AND close_deadline_at IS NULL
           AND close_line_event_id IS NULL
         )::text
         FROM public.physical_inventory_sessions WHERE id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(boundaryCleared).toBe("true");

      // The canceled close's own ingest evidence row must still exist, untouched.
      const closeIngestStillPresent = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT (count(*) = 1)::text FROM public.physical_inventory_session_ingests
         WHERE session_id = ${sqlLiteral(sid)}::uuid AND line_event_id = ${sqlLiteral(closeEventId)}
           AND kind = 'close'`,
      );
      expect(closeIngestStillPresent).toBe("true");

      // A following item admits into the SAME session/generation.
      const admitted = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(`evt-unsend-item-5-${tag}`)}, 3000, 'item', 'item 5', NULL, NULL
        )::text`,
      );
      expect(admitted.accepted).toBe(true);
      expect(admitted.status).toBe("open");

      // A later new close finalizes normally after the barrier elapses.
      const secondCloseEventId = `evt-unsend-close2-${tag}`;
      const closedAgain = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(secondCloseEventId)}, 3100, 'close', 'จบ', NULL, NULL
        )::text`,
      );
      expect(closedAgain.status).toBe("closing");

      await psqlScalar(psqlPath, dbName, "SELECT pg_sleep(8.1)::text");
      const candidate = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_physical_inventory_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
        )::text`,
      );
      const candidateIngests = candidate.ingests as Array<{
        line_event_id: string;
        kind: string;
        raw_text: string;
      }>;
      expect(candidateIngests).toHaveLength(7);
      expect(candidateIngests.filter((row) => row.kind === "item")).toHaveLength(5);
      expect(candidateIngests.map((row) => row.line_event_id)).not.toContain(closeEventId);
      expect(candidateIngests.map((row) => row.line_event_id)).toContain(secondCloseEventId);
      expect(candidateIngests.at(-1)?.line_event_id).toBe(secondCloseEventId);

      // A finalizer that captured the first close before the unsend must lose
      // after cancellation/re-close; stale evidence can never terminalize.
      let staleFinalizeError = "";
      try {
        await psqlJson(
          psqlPath,
          dbName,
          `SELECT public.finalize_physical_inventory_session(
            ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
            ${Number(staleCandidate.ingest_revision)},
            ${sqlLiteral(String(staleCandidate.ingest_set_hash))},
            '2026-09-18', 'test', '[]'::jsonb, '[]'::jsonb,
            true, 'stale-probe'
          )::text`,
        );
      } catch (error) {
        staleFinalizeError = error instanceof Error ? error.message : String(error);
      }
      expect(staleFinalizeError).toContain("stale_ingest_revision");

      const finalized = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.finalize_physical_inventory_session(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${Number(candidate.ingest_revision)}, ${sqlLiteral(String(candidate.ingest_set_hash))},
          '2026-09-18', 'test', '[]'::jsonb,
          ${sqlLiteral(JSON.stringify(
            Array.from({ length: 5 }, (_, index) => ({
              staff_sequence: index + 1,
              raw_text: `item ${index + 1}`,
              raw_product_description: `item ${index + 1}`,
              normalized_product: `item ${index + 1}`,
              quantity: 1,
              raw_unit: "หน่วย",
              normalized_unit: "หน่วย",
              resolution_status: "ACCEPTED_RAW",
              reason: null,
            })),
          ))}::jsonb, false, NULL
        )::text`,
      );
      expect(finalized.status).toBe("finalized");
      expect(finalized.item_count).toBe(5);
      const persistedItemCount = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text
         FROM public.physical_inventory_items
         WHERE snapshot_id = ${sqlLiteral(String(finalized.snapshot_id))}::uuid`,
      );
      expect(persistedItemCount).toBe("5");

      // Cancel is a terminal no-op after the replacement close finalized.
      const staleCancel = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.cancel_physical_inventory_close(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, ${sqlLiteral(closeEventId)}
        )::text`,
      );
      expect(staleCancel.canceled).toBe(false);
      expect(staleCancel.reason).toBe("already_terminal");
      expect(staleCancel.status).toBe("finalized");

      console.info("cancel_physical_inventory_close reopen + reclose + finalize: PASS");
    },
    { timeout: 60_000 },
  );

  test(
    "cancel_physical_inventory_close never reopens or mutates an already-finalized session",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const opened = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_physical_inventory_session(
          'group', ${sqlLiteral(`G-term-${tag}`)}, ${sqlLiteral(`U-term-${tag}`)},
          ${sqlLiteral(`evt-term-h-${tag}`)}, 1000, 'header', NULL, NULL, NULL, 'test'
        )::text`,
      );
      const sid = String(opened.session_id);
      const gen = String(opened.session_generation);
      const closeEventId = `evt-term-close-${tag}`;
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_physical_inventory_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${sqlLiteral(closeEventId)}, 2000, 'close', 'จบ', NULL, NULL
        )::text`,
      );
      await psqlScalar(psqlPath, dbName, "SELECT pg_sleep(8.1)::text");
      const candidate = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_physical_inventory_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid
        )::text`,
      );
      const finalized = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.finalize_physical_inventory_session(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid,
          ${Number(candidate.ingest_revision)}, ${sqlLiteral(String(candidate.ingest_set_hash))},
          '2026-09-18', 'test', '[]'::jsonb,
          ${sqlLiteral(JSON.stringify([{
            staff_sequence: 1,
            raw_text: "1",
            raw_product_description: "1",
            normalized_product: "1",
            quantity: 1,
            raw_unit: "หน่วย",
            normalized_unit: "หน่วย",
            resolution_status: "ACCEPTED_RAW",
            reason: null,
          }]))}::jsonb, false, NULL
        )::text`,
      );
      expect(finalized.status).toBe("finalized");
      const snapshotId = String(finalized.snapshot_id);

      const canceled = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.cancel_physical_inventory_close(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, ${sqlLiteral(closeEventId)}
        )::text`,
      );
      expect(canceled.canceled).toBe(false);
      expect(canceled.reason).toBe("already_terminal");
      expect(canceled.status).toBe("finalized");

      const stillFinalized = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT status FROM public.physical_inventory_sessions WHERE id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(stillFinalized).toBe("finalized");
      const snapshotUntouched = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT (status = 'finalized')::text FROM public.physical_inventory_snapshots
         WHERE id = ${sqlLiteral(snapshotId)}::uuid`,
      );
      expect(snapshotUntouched).toBe("true");

      console.info("cancel_physical_inventory_close fail-closed on finalized session: PASS");
    },
    { timeout: 60_000 },
  );

  afterAll(async () => {
    if (dbCreated && psqlPath) {
      await runPsql(psqlPath, [
        "-d",
        "postgres",
        "-c",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
      ]);
      await runPsql(psqlPath, [
        "-d",
        "postgres",
        "-c",
        `DROP DATABASE IF EXISTS ${dbName}`,
      ]);
    }
  });
});

describe.skipIf(pgAvailable)("P2A migration 0047 PostgreSQL unavailable", () => {
  test("explicit SKIP (not a green functional PASS)", () => {
    console.warn(pgSkipReason);
    expect(pgSkipReason).toContain("SKIPPED");
    // Mark as skipped intent: this suite runs only to document SKIP status.
    // It must not claim hardening PASS.
  });
});
