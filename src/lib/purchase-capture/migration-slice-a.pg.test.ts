/**
 * Real PostgreSQL harness for P2B purchase-capture Slice A migration.
 *
 * - Creates a disposable DB, applies bootstrap + Slice A migration + hardening
 *   SQL via psql, mirroring src/lib/physical-inventory/migration-0047.pg.test.ts.
 * - Runs REAL multi-connection concurrency cases (≥2 independent psql processes).
 * - SKIPs (not a green functional PASS) when psql/connection is unavailable, UNLESS
 *   REQUIRE_POSTGRES_TESTS=1 is set, in which case an unavailable PostgreSQL
 *   connection is a hard FAIL — CI must not report green without actually
 *   running this suite.
 *
 * Env: PGPASSWORD=postgres (default), PGHOST=localhost, PGUSER=postgres,
 *      REQUIRE_POSTGRES_TESTS=1 (CI-only; unset for ordinary local dev runs)
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
const BOOTSTRAP = join(
  REPO_ROOT,
  "supabase",
  "tests",
  "purchase_capture_slice_a_bootstrap.sql",
);
const MIGRATION = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260805130000_purchase_capture_sessions.sql",
);
const HARDENING = join(
  REPO_ROOT,
  "supabase",
  "tests",
  "purchase_capture_slice_a_hardening.sql",
);
const OPEN_REPLAY_FIX = join(REPO_ROOT, "supabase", "migrations", "20261104090000_purchase_capture_open_replay_race.sql");

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

function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function psqlScalar(psql: string, database: string, sql: string): Promise<string> {
  const r = await runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sql], { database });
  if (r.code !== 0) throw new Error(`psqlScalar failed: ${r.stderr || r.stdout}\nSQL: ${sql}`);
  return (r.stdout || "").trim();
}

async function psqlJson(psql: string, database: string, sql: string): Promise<Record<string, unknown>> {
  return JSON.parse(await psqlScalar(psql, database, sql)) as Record<string, unknown>;
}

/** Two independent psql processes (two DB connections). */
async function concurrentPsql(
  psql: string,
  database: string,
  sqlA: string,
  sqlB: string,
): Promise<[PsqlResult, PsqlResult]> {
  return Promise.all([
    runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sqlA], { database }),
    runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", sqlB], { database }),
  ]);
}

/** Gate inside the first SELECT so it misses a winner committed during its snapshot. */
async function snapshotGapPsql(
  psql: string,
  database: string,
  winnerSql: string,
  replaySql: string,
): Promise<[PsqlResult, PsqlResult]> {
  const definition = await psqlScalar(psql, database,
    "SELECT pg_get_functiondef('public.open_purchase_capture_session(text,text,text,text,bigint,text,text,uuid)'::regprocedure)");
  const gate = randomBytes(3).readUIntBE(0, 3);
  // Temporarily remove the event-level lock only inside this disposable DB to
  // force the snapshot race and verify the independent full-fingerprint fallback.
  const unlocked = definition.replace(
    /PERFORM pg_advisory_xact_lock\(\s*hashtextextended\('purchase-capture-open:' \|\| v_event,\s*0\)\s*\);/,
    "",
  );
  expect(unlocked).not.toBe(definition);
  const gated = unlocked.replace("WHERE line_event_id = v_event;",
    `WHERE line_event_id = v_event AND (SELECT true FROM pg_advisory_xact_lock(195, ${gate}));`);
  expect(gated).not.toBe(unlocked);
  await psqlScalar(psql, database, gated);

  const holder = Bun.spawn([psql, "-XqAt", "-v", "ON_ERROR_STOP=1", "-d", database], {
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const holderResult = Promise.all([
    new Response(holder.stdout).text(), new Response(holder.stderr).text(), holder.exited,
  ]).then(([stdout, stderr, code]) => ({ stdout, stderr, code }));
  let replay: Promise<PsqlResult> | undefined;
  async function waitForGate(granted: boolean) {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const found = await psqlScalar(psql, database, `SELECT EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 195 AND objid = ${gate}
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND granted = ${granted})`);
      if (found === "t") return;
      await Bun.sleep(20);
    }
    throw new Error(`snapshot gap gate timed out (granted=${granted})`);
  }
  try {
    holder.stdin.write(`BEGIN; SELECT pg_advisory_xact_lock(195, ${gate}); ${winnerSql};\n`);
    await holder.stdin.flush();
    await waitForGate(true);
    replay = runPsql(psql, ["-v", "ON_ERROR_STOP=1", "-d", database, "-tAc", replaySql], { database });
    await waitForGate(false);
  } finally {
    try {
      holder.stdin.write("COMMIT;\n");
      holder.stdin.end();
      await holderResult;
      await replay;
    } finally {
      // Restore the protected RPC even if the test harness or replay fails.
      await psqlScalar(psql, database, definition);
    }
  }
  return [await holderResult, await replay!];
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
  console.warn(`Purchase capture Slice A PG tests ${pgSkipReason}`);
}

if (REQUIRE_POSTGRES_TESTS && !pgAvailable) {
  throw new Error(
    `PostgreSQL tests are required but unavailable at ${PGHOST}:${PGPORT}: ${probe.detail}`,
  );
}

describe.skipIf(!pgAvailable)("Purchase capture Slice A migration PostgreSQL hardening", () => {
  const dbName = `pc_slice_a_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;
  let ready = false;

  test(
    "bootstrap + Slice A migration + hardening PASS on disposable DB",
    async () => {
      expect(existsSync(BOOTSTRAP)).toBe(true);
      expect(existsSync(MIGRATION)).toBe(true);
      expect(existsSync(OPEN_REPLAY_FIX)).toBe(true);
      expect(existsSync(HARDENING)).toBe(true);

      const create = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`]);
      expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
      dbCreated = true;

      const boot = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", BOOTSTRAP], { database: dbName });
      expect(boot.code, `bootstrap failed:\n${boot.stderr}\n${boot.stdout}`).toBe(0);

      const mig = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", MIGRATION], { database: dbName });
      expect(mig.code, `Slice A migration failed:\n${mig.stderr}\n${mig.stdout}`).toBe(0);

      const originalDefinition = await psqlScalar(psqlPath, dbName,
        "SELECT pg_get_functiondef('public.open_purchase_capture_session(text,text,text,text,bigint,text,text,uuid)'::regprocedure)");
      const fix = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", OPEN_REPLAY_FIX], { database: dbName });
      expect(fix.code, `open replay fix failed: ${fix.stderr}`).toBe(0);
      expect(await psqlScalar(psqlPath, dbName,
        "SELECT pg_get_functiondef('public.open_purchase_capture_session(text,text,text,text,bigint,text,text,uuid)'::regprocedure)"),
      ).not.toBe(originalDefinition);
      for (const role of ["anon", "authenticated"]) {
        expect(await psqlScalar(psqlPath, dbName,
          `SELECT has_function_privilege('${role}', 'public.open_purchase_capture_session(text,text,text,text,bigint,text,text,uuid)', 'EXECUTE')::text`))
          .toBe("false");
      }
      expect(await psqlScalar(psqlPath, dbName,
        "SELECT has_function_privilege('service_role', 'public.open_purchase_capture_session(text,text,text,text,bigint,text,text,uuid)', 'EXECUTE')::text"))
        .toBe("true");

      expect(
        await psqlScalar(
          psqlPath,
          dbName,
          `SELECT public.purchase_capture_compute_ingest_set_hash(
             '00000000-0000-4000-8000-000000000001'::uuid
           )`,
        ),
      ).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

      const hard = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", HARDENING], { database: dbName });
      expect(hard.code, `hardening failed:\n${hard.stderr}\n${hard.stdout}`).toBe(0);
      expect(hard.stderr + hard.stdout).toContain("purchase_capture_slice_a_hardening PASS");
      ready = true;
      console.info("Purchase capture Slice A hardening: PASS (real PostgreSQL)");
    },
    { timeout: 180_000 },
  );

  test(
    "REAL concurrency: two concurrent item admissions → both admitted, no lost update",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const source = `G-conc-item-${tag}`;
      const sender = `U-conc-item-${tag}`;
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
          ${sqlLiteral(`evt-conc-item-h-${tag}`)}, 2000, 'header'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);

      const sqlA = `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
        ${sqlLiteral(`evt-conc-item-a-${tag}`)}, 2100, 'item', 'item A', NULL, NULL
      )::text`;
      const sqlB = `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
        ${sqlLiteral(`evt-conc-item-b-${tag}`)}, 2101, 'item', 'item B', NULL, NULL
      )::text`;

      const [a, b] = await concurrentPsql(psqlPath, dbName, sqlA, sqlB);
      expect(a.code, `A failed: ${a.stderr || a.stdout}`).toBe(0);
      expect(b.code, `B failed: ${b.stderr || b.stdout}`).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      expect(ra.inserted).toBe(true);
      expect(rb.inserted).toBe(true);

      const n = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.purchase_capture_session_ingests WHERE session_id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(n).toBe("3"); // header + item A + item B
      const rev = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT ingest_revision::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(rev).toBe("3"); // no lost update: both concurrent admits counted
      const distinctOrdinals = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(DISTINCT ingest_ordinal)::text FROM public.purchase_capture_session_ingests WHERE session_id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(distinctOrdinals).toBe("3"); // no ordinal collision between the two concurrent admits
      console.info("concurrency two concurrent item admits: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: item admit vs close boundary inversion → no post-boundary item in candidate",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const source = `G-conc-inv-${tag}`;
      const sender = `U-conc-inv-${tag}`;
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
          ${sqlLiteral(`evt-conc-inv-h-${tag}`)}, 3000, 'header'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_purchase_capture_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
          ${sqlLiteral(`evt-conc-inv-t1-${tag}`)}, 3100, 'item', 'T1', NULL, NULL
        )::text`,
      );

      // T3's own timestamp (3300) is AFTER the close boundary T2 (3200) will
      // set — a race where the still-in-flight item request loses to close.
      const itemSql = `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
        ${sqlLiteral(`evt-conc-inv-t3-${tag}`)}, 3300, 'item', 'T3', NULL, NULL
      )::text`;
      const closeSql = `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
        ${sqlLiteral(`evt-conc-inv-close-${tag}`)}, 3200, 'close', 'ปิดซื้อ 1 รายการ', NULL, NULL
      )::text`;

      const [itemRes, closeRes] = await concurrentPsql(psqlPath, dbName, itemSql, closeSql);

      const itemOk = itemRes.code === 0;
      const closeOk = closeRes.code === 0;
      expect(closeOk || itemOk).toBe(true);

      if (!itemOk) {
        expect(itemRes.stderr + itemRes.stdout).toContain("after_close_boundary");
      }
      if (!closeOk) {
        // Close should not lose to a later-timestamped item under this ordering;
        // if it did, force it so the candidate has a boundary to assert against.
        await psqlScalar(psqlPath, dbName, closeSql);
      }

      const cand = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.get_purchase_capture_finalize_candidate(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)}
        )::text`,
      );
      const ingests = (cand.ingests as Array<{ line_event_id: string }>) ?? [];
      const t3Id = `evt-conc-inv-t3-${tag}`;
      // Whether or not T3's evidence row landed, the authoritative candidate
      // set never includes a post-boundary item.
      expect(ingests.some((i) => i.line_event_id === t3Id)).toBe(false);
      expect(cand.ingest_set_hash).toBe(
        await psqlScalar(
          psqlPath,
          dbName,
          `SELECT public.purchase_capture_compute_ingest_set_hash(${sqlLiteral(sid)}::uuid)`,
        ),
      );
      console.info("concurrency admit-vs-close inversion: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: two concurrent opens, same source+sender, different events → one active session",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const sqlA = `SELECT public.open_purchase_capture_session(
        'group', ${sqlLiteral(`G-conc-open-${tag}`)}, ${sqlLiteral(`U-conc-open-${tag}`)},
        ${sqlLiteral(`evt-conc-open-a-${tag}`)}, 1000, 'header A'
      )::text`;
      const sqlB = `SELECT public.open_purchase_capture_session(
        'group', ${sqlLiteral(`G-conc-open-${tag}`)}, ${sqlLiteral(`U-conc-open-${tag}`)},
        ${sqlLiteral(`evt-conc-open-b-${tag}`)}, 1001, 'header B'
      )::text`;
      const [a, b] = await concurrentPsql(psqlPath, dbName, sqlA, sqlB);
      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      const openedCount = [ra, rb].filter((r) => r.opened === true).length;
      const alreadyOpenCount = [ra, rb].filter((r) => r.reason === "already_open").length;
      expect(openedCount).toBe(1);
      expect(alreadyOpenCount).toBe(1);

      const nActive = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.purchase_capture_sessions
         WHERE source_id = ${sqlLiteral(`G-conc-open-${tag}`)}
           AND sender_line_user_id = ${sqlLiteral(`U-conc-open-${tag}`)}
           AND status IN ('open', 'closing')`,
      );
      expect(nActive).toBe("1");
      console.info("concurrency two concurrent opens: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: concurrent identical duplicate open → one insert, one idempotent replay",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const evt = `evt-conc-dup-open-${tag}`;
      const sqlSame = `SELECT public.open_purchase_capture_session(
        'group', ${sqlLiteral(`G-conc-dup-${tag}`)}, ${sqlLiteral(`U-conc-dup-${tag}`)},
        ${sqlLiteral(evt)}, 1000, 'identical header text'
      )::text`;
      const [a, b] = await concurrentPsql(psqlPath, dbName, sqlSame, sqlSame);
      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      const openedCount = [ra, rb].filter((r) => r.opened === true).length;
      const idempotentCount = [ra, rb].filter((r) => r.idempotent === true).length;
      expect(openedCount).toBe(1);
      expect(idempotentCount).toBe(1);
      expect(ra.session_id).toBe(rb.session_id);
      const n = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.purchase_capture_session_ingests WHERE line_event_id = ${sqlLiteral(evt)}`,
      );
      expect(n).toBe("1");
      console.info("concurrency identical duplicate open: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: concurrent conflicting duplicate open (different raw_text) → one insert, one line_event_conflict",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const evt = `evt-conc-conflict-open-${tag}`;
      const source = `G-conc-conflict-${tag}`;
      const sender = `U-conc-conflict-${tag}`;
      const sqlA = `SELECT public.open_purchase_capture_session(
        'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)}, ${sqlLiteral(evt)}, 1000, 'text A'
      )::text`;
      const sqlB = `SELECT public.open_purchase_capture_session(
        'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)}, ${sqlLiteral(evt)}, 1000, 'text B (conflicting)'
      )::text`;
      const [a, b] = await concurrentPsql(psqlPath, dbName, sqlA, sqlB);
      const results = [a, b];
      const succeeded = results.filter((r) => r.code === 0);
      const failed = results.filter((r) => r.code !== 0);
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(failed[0]!.stderr + failed[0]!.stdout).toContain("line_event_conflict");

      const n = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.purchase_capture_session_ingests WHERE line_event_id = ${sqlLiteral(evt)}`,
      );
      expect(n).toBe("1"); // exactly the winner's content, never both, never neither
      console.info("concurrency conflicting duplicate open: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: concurrent identical duplicate admit → one insert, one idempotent replay",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const source = `G-conc-dup-admit-${tag}`;
      const sender = `U-conc-dup-admit-${tag}`;
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)}, ${sqlLiteral(`evt-conc-dup-admit-h-${tag}`)}, 2000, 'header'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      const evt = `evt-conc-dup-admit-item-${tag}`;
      const sqlSame = `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
        ${sqlLiteral(evt)}, 2100, 'item', 'identical item text', NULL, NULL
      )::text`;
      const [a, b] = await concurrentPsql(psqlPath, dbName, sqlSame, sqlSame);
      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      const insertedCount = [ra, rb].filter((r) => r.inserted === true).length;
      const dupCount = [ra, rb].filter((r) => r.reason === "duplicate_event").length;
      expect(insertedCount).toBe(1);
      expect(dupCount).toBe(1);
      const n = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.purchase_capture_session_ingests WHERE line_event_id = ${sqlLiteral(evt)}`,
      );
      expect(n).toBe("1");
      console.info("concurrency identical duplicate admit: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: concurrent conflicting duplicate admit (different raw_text) → one insert, one line_event_conflict",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const source = `G-conc-conflict-admit-${tag}`;
      const sender = `U-conc-conflict-admit-${tag}`;
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)}, ${sqlLiteral(`evt-conc-conflict-admit-h-${tag}`)}, 2000, 'header'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      const evt = `evt-conc-conflict-admit-item-${tag}`;
      const sqlA = `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
        ${sqlLiteral(evt)}, 2100, 'item', 'text A', NULL, NULL
      )::text`;
      const sqlB = `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
        ${sqlLiteral(evt)}, 2100, 'item', 'text B (conflicting)', NULL, NULL
      )::text`;
      const [a, b] = await concurrentPsql(psqlPath, dbName, sqlA, sqlB);
      const results = [a, b];
      const succeeded = results.filter((r) => r.code === 0);
      const failed = results.filter((r) => r.code !== 0);
      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(failed[0]!.stderr + failed[0]!.stdout).toContain("line_event_conflict");

      const n = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.purchase_capture_session_ingests WHERE line_event_id = ${sqlLiteral(evt)}`,
      );
      expect(n).toBe("1");
      console.info("concurrency conflicting duplicate admit: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "REAL concurrency: redelivered close_purchase_capture_open_event → idempotent, boundary unchanged",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const evt = `evt-conc-close-${tag}`;
      const source = `G-conc-close-${tag}`;
      const sender = `U-conc-close-${tag}`;
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
          ${sqlLiteral(evt)}, 4000, 'complete one-message document'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      const closeSql = `SELECT public.close_purchase_capture_open_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)}, ${sqlLiteral(evt)}
      )::text`;

      const [a, b] = await concurrentPsql(psqlPath, dbName, closeSql, closeSql);
      expect(a.code, a.stderr).toBe(0);
      expect(b.code, b.stderr).toBe(0);
      const ra = JSON.parse(a.stdout.trim()) as Record<string, unknown>;
      const rb = JSON.parse(b.stdout.trim()) as Record<string, unknown>;
      const notIdempotentCount = [ra, rb].filter((r) => r.idempotent === false).length;
      const idempotentCount = [ra, rb].filter((r) => r.idempotent === true).length;
      expect(notIdempotentCount).toBe(1);
      expect(idempotentCount).toBe(1);

      const n = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT count(*)::text FROM public.purchase_capture_session_ingests WHERE session_id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(n).toBe("1"); // still exactly one ingest row for the whole one-message document
      const boundaryMs = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT close_event_timestamp_ms::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(sid)}::uuid`,
      );
      expect(boundaryMs).toBe("4000");
      console.info("concurrency redelivered inline close: PASS (2 connections)");
    },
    { timeout: 60_000 },
  );

  test(
    "candidate consistency: ingest around acquisition stays coherent",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const source = `G-cand-${tag}`;
      const sender = `U-cand-${tag}`;
      const open = await psqlJson(
        psqlPath,
        dbName,
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
          ${sqlLiteral(`evt-cand-h-${tag}`)}, 6000, 'header'
        )::text`,
      );
      const sid = String(open.session_id);
      const gen = String(open.session_generation);
      await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.admit_purchase_capture_event(
          ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
          ${sqlLiteral(`evt-cand-i1-${tag}`)}, 6100, 'item', '1', NULL, NULL
        )::text`,
      );

      const candSql = `SELECT public.get_purchase_capture_finalize_candidate(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)}
      )::text`;
      const admitSql = `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sid)}::uuid, ${sqlLiteral(gen)}::uuid, 'group', ${sqlLiteral(source)}, ${sqlLiteral(sender)},
        ${sqlLiteral(`evt-cand-i2-${tag}`)}, 6200, 'item', '2', NULL, NULL
      )::text`;

      const [candRes, admitRes] = await concurrentPsql(psqlPath, dbName, candSql, admitSql);
      expect(candRes.code, candRes.stderr).toBe(0);
      expect(admitRes.code, admitRes.stderr).toBe(0);

      const cand = JSON.parse(candRes.stdout.trim()) as {
        ingest_revision: number;
        ingest_set_hash: string;
        ingests: Array<{ line_event_id: string; ingest_ordinal: number }>;
      };
      const ids = cand.ingests.map((i) => i.line_event_id);

      const liveHash = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT public.purchase_capture_compute_ingest_set_hash(${sqlLiteral(sid)}::uuid)`,
      );
      const liveRev = await psqlScalar(
        psqlPath,
        dbName,
        `SELECT ingest_revision::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(sid)}::uuid`,
      );
      if (ids.includes(`evt-cand-i2-${tag}`)) {
        expect(cand.ingest_set_hash).toBe(liveHash);
        expect(String(cand.ingest_revision)).toBe(liveRev);
      } else {
        expect(cand.ingest_revision).toBeLessThan(Number(liveRev));
        expect(cand.ingest_set_hash).not.toBe(liveHash);
      }
      expect(cand.ingests.every((i) => i.ingest_ordinal <= cand.ingest_revision)).toBe(true);
      console.info("candidate consistency under concurrent ingest: PASS");
    },
    { timeout: 60_000 },
  );

  for (const identical of [false, true]) {
    test(`snapshot gap: ${identical ? "identical" : "conflicting"} open committed after first ingest snapshot`, async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const evt = `evt-snapshot-${tag}`;
      const openSql = (text: string) => `SELECT public.open_purchase_capture_session(
        'group', 'G-snapshot-${tag}', 'U-snapshot-${tag}', ${sqlLiteral(evt)}, 1000, ${sqlLiteral(text)}
      )::text`;
      const [winner, replay] = await snapshotGapPsql(psqlPath, dbName, openSql("text A"),
        openSql(identical ? "text A" : "text B"));
      expect(winner.code, winner.stderr).toBe(0);
      const opened = JSON.parse(winner.stdout.trim()) as Record<string, unknown>;
      expect(opened.opened).toBe(true);
      if (identical) {
        expect(replay.code, replay.stderr).toBe(0);
        const duplicate = JSON.parse(replay.stdout.trim()) as Record<string, unknown>;
        expect(duplicate.reason).toBe("duplicate_open_event");
        expect(duplicate.idempotent).toBe(true);
        expect(duplicate.session_id).toBe(opened.session_id);
      } else {
        expect(replay.code).not.toBe(0);
        expect(replay.stderr + replay.stdout).toContain("line_event_conflict");
      }
      expect(await psqlScalar(psqlPath, dbName,
        `SELECT count(*)::text FROM public.purchase_capture_session_ingests WHERE line_event_id = ${sqlLiteral(evt)}`)).toBe("1");
      expect(await psqlScalar(psqlPath, dbName,
        `SELECT raw_text FROM public.purchase_capture_session_ingests WHERE line_event_id = ${sqlLiteral(evt)}`)).toBe("text A");
      expect(await psqlScalar(psqlPath, dbName,
        `SELECT ingest_revision::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(String(opened.session_id))}::uuid`)).toBe("1");
    }, { timeout: 60_000 });
  }

  afterAll(async () => {
    if (dbCreated && psqlPath) {
      await runPsql(psqlPath, [
        "-d",
        "postgres",
        "-c",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`,
      ]);
      await runPsql(psqlPath, ["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${dbName}`]);
    }
  });
});
