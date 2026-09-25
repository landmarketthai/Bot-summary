/**
 * Real PostgreSQL harness for P2B purchase-capture Slice A migration.
 *
 * - Creates a disposable DB, applies bootstrap + Slice A migration + open-event
 *   lock migration + hardening SQL via psql, mirroring
 *   src/lib/physical-inventory/migration-0047.pg.test.ts.
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
const OPEN_EVENT_LOCK = join(
  REPO_ROOT,
  "supabase",
  "migrations",
  "20260925100000_purchase_capture_open_event_lock.sql",
);
const HARDENING = join(
  REPO_ROOT,
  "supabase",
  "tests",
  "purchase_capture_slice_a_hardening.sql",
);

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

/**
 * A psql connection driven over stdin and tagged with application_name, so a
 * test can hold a transaction open between steps and watch the connection in
 * pg_stat_activity.
 */
function psqlSession(psql: string, database: string, appName: string) {
  const proc = Bun.spawn([psql, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-d", database], {
    cwd: REPO_ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database, PGAPPNAME: appName },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const done: Promise<PsqlResult> = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }));
  return {
    send(sql: string) {
      proc.stdin.write(`${sql}\n`);
      proc.stdin.flush();
    },
    /** Closes stdin; psql exits, rolling back any transaction left open. */
    end(): Promise<PsqlResult> {
      proc.stdin.end();
      return done;
    },
  };
}

async function waitForActivity(
  psql: string,
  database: string,
  appName: string,
  condition: string,
): Promise<void> {
  const sql = `SELECT count(*)::text FROM pg_stat_activity
    WHERE datname = ${sqlLiteral(database)} AND application_name = ${sqlLiteral(appName)} AND ${condition}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if ((await psqlScalar(psql, database, sql)) === "1") return;
    await Bun.sleep(25);
  }
  throw new Error(`${appName} never reached: ${condition}`);
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
      expect(existsSync(OPEN_EVENT_LOCK)).toBe(true);
      expect(existsSync(HARDENING)).toBe(true);

      const create = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`]);
      expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
      dbCreated = true;

      const boot = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", BOOTSTRAP], { database: dbName });
      expect(boot.code, `bootstrap failed:\n${boot.stderr}\n${boot.stdout}`).toBe(0);

      const mig = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", MIGRATION], { database: dbName });
      expect(mig.code, `Slice A migration failed:\n${mig.stderr}\n${mig.stdout}`).toBe(0);

      expect(
        await psqlScalar(
          psqlPath,
          dbName,
          `SELECT public.purchase_capture_compute_ingest_set_hash(
             '00000000-0000-4000-8000-000000000001'::uuid
           )`,
        ),
      ).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");

      const lock = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", OPEN_EVENT_LOCK], { database: dbName });
      expect(lock.code, `open-event lock migration failed:\n${lock.stderr}\n${lock.stdout}`).toBe(0);

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
    "REAL concurrency (forced interleaving): conflicting duplicate open whose lookups straddle the winner's commit → line_event_conflict",
    async () => {
      // The test above only hits this window by luck (pg-tests run #242).
      // Here it is forced: B's header-ingest lookup runs before A commits and
      // its session lookup after, which used to accept B on source/sender alone.
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const evt = `evt-straddle-open-${tag}`;
      const open = (event: string, id: string, text: string) =>
        `SELECT public.open_purchase_capture_session(
          'group', ${sqlLiteral(`G-${id}`)}, ${sqlLiteral(`U-${id}`)}, ${sqlLiteral(event)}, 1000, ${sqlLiteral(text)}
        )::text;`;
      const appA = `pc-straddle-a-${tag}`;
      const appB = `pc-straddle-b-${tag}`;
      const appLock = `pc-straddle-lock-${tag}`;
      const a = psqlSession(psqlPath, dbName, appA);
      const b = psqlSession(psqlPath, dbName, appB);
      const locker = psqlSession(psqlPath, dbName, appLock);
      const finish = () => Promise.all([a.end(), b.end(), locker.end()]);

      try {
        // B compiles the function and caches its plans first, so its real call
        // takes no purchase_capture_sessions lock before its session lookup.
        b.send(`BEGIN;\n${open(`evt-straddle-warm-${tag}`, `straddle-warm-${tag}`, "warm")}\nROLLBACK;\nSELECT 'warm-done';`);
        await waitForActivity(psqlPath, dbName, appB, "state = 'idle' AND query LIKE '%warm-done%'");

        a.send(`BEGIN;\n${open(evt, `straddle-${tag}`, "text A")}`);
        await waitForActivity(psqlPath, dbName, appA, "state = 'idle in transaction'");

        // Queued behind A, this parks anything that next touches
        // purchase_capture_sessions until A commits, then lets it go.
        locker.send("BEGIN;\nLOCK TABLE public.purchase_capture_sessions IN ACCESS EXCLUSIVE MODE;\nROLLBACK;");
        await waitForActivity(psqlPath, dbName, appLock, "wait_event_type = 'Lock'");

        b.send(open(evt, `straddle-${tag}`, "text B (conflicting)"));
        await waitForActivity(psqlPath, dbName, appB, "wait_event_type = 'Lock'");

        a.send("COMMIT;");
      } catch (err) {
        await finish(); // an uncommitted A rolls back, so later tests are not blocked
        throw err;
      }
      const [ra, rb, rl] = await finish();

      expect(ra.code, ra.stderr).toBe(0);
      expect((JSON.parse(ra.stdout.trim()) as Record<string, unknown>).opened).toBe(true);
      expect(rl.code, rl.stderr).toBe(0);
      expect(rb.code, `conflicting open was accepted: ${rb.stdout.trim().split(/\r?\n/).pop()}`).not.toBe(0);
      expect(rb.stderr).toContain("line_event_conflict");
      expect(
        await psqlScalar(
          psqlPath,
          dbName,
          `SELECT string_agg(raw_text, ',') FROM public.purchase_capture_session_ingests WHERE line_event_id = ${sqlLiteral(evt)}`,
        ),
      ).toBe("text A");
      console.info("forced-interleaving conflicting duplicate open: PASS (3 connections)");
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
