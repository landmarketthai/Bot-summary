/**
 * Real PostgreSQL harness for P2B/P2C purchase-capture Slice C1 migration.
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
const PRE_0053 = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_c_pre_0053.sql");
const POST_0053 = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_c_post_0053.sql");
const MIGRATION_0052 = join(REPO_ROOT, "supabase", "migrations", "20260729084558_purchase_receipt_persistence.sql");
const MIGRATION_0053 = join(REPO_ROOT, "supabase", "migrations", "20260729172613_inventory_movement_ledger.sql");
const MIGRATION_A = join(REPO_ROOT, "supabase", "migrations", "20260805130000_purchase_capture_sessions.sql");
const MIGRATION_B = join(REPO_ROOT, "supabase", "migrations", "20260805140000_purchase_capture_draft_finalization.sql");
const MIGRATION_HARDENING = join(REPO_ROOT, "supabase", "migrations", "20260805150000_purchase_capture_slice_b_contract_hardening.sql");
const MIGRATION_C = join(REPO_ROOT, "supabase", "migrations", "20260805160000_purchase_capture_confirm_post.sql");
const OPEN_REPLAY_FIX = join(REPO_ROOT, "supabase", "migrations", "20261104090000_purchase_capture_open_replay_race.sql");
const HARDENING_C = join(REPO_ROOT, "supabase", "tests", "purchase_capture_slice_c_hardening.sql");

const ALL_FIXTURES = [
  BOOTSTRAP,
  PRE_0053,
  POST_0053,
  MIGRATION_0052,
  MIGRATION_A,
  MIGRATION_B,
  MIGRATION_HARDENING,
  MIGRATION_0053,
  MIGRATION_C,
  OPEN_REPLAY_FIX,
  HARDENING_C,
];

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

function spawnPsqlScript(psql: string, database: string, script: string, marker: string) {
  const proc = Bun.spawn([psql, "-v", "ON_ERROR_STOP=1", "-d", database, "-c", `/* ${marker} */ ${script}`], {
    cwd: REPO_ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = (async () => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  })();
  return { proc, result, marker };
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

const resolvedPsql = resolvePsql();
const probe = resolvedPsql
  ? await probeConnection(resolvedPsql)
  : { ok: false, detail: "psql binary not found" };

const pgAvailable = Boolean(resolvedPsql && probe.ok);

if (!pgAvailable) {
  console.warn(`Purchase capture Slice C PG tests SKIPPED: PostgreSQL unavailable (${probe.detail})`);
}

if (REQUIRE_POSTGRES_TESTS && !pgAvailable) {
  throw new Error(
    `PostgreSQL tests are required but unavailable at ${PGHOST}:${PGPORT}: ${probe.detail}`,
  );
}

describe.skipIf(!pgAvailable)("Purchase capture Slice C1 migration PostgreSQL hardening", () => {
  const dbName = `pc_slice_c_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;
  let ready = false;

  async function psqlScalar(sql: string): Promise<string> {
    const r = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", sql], { database: dbName });
    if (r.code !== 0) throw new Error(`psqlScalar failed: ${r.stderr || r.stdout}\nSQL: ${sql}`);
    return (r.stdout || "").trim();
  }

  async function pollUntil(label: string, sql: string, expected: string, timeoutMs = 30_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = await psqlScalar(sql);
      if (value === expected) return;
      await Bun.sleep(50);
    }
    throw new Error(`pollUntil timeout (${label}): wanted ${expected} from ${sql}`);
  }

  async function ensureRaceGateTable(): Promise<void> {
    await psqlScalar(`
      CREATE TABLE IF NOT EXISTS public.pc_race_gate (
        k text PRIMARY KEY,
        phase text NOT NULL DEFAULT 'idle'
      )`);
  }

  async function setupAwaiting(tag: string) {
    const evt = `evt-ts-${tag}-open`;
    const sourceId = `G-ts-${tag}`;
    const sender = `U-ts-${tag}`;
    const open = JSON.parse(await psqlScalar(
      `SELECT public.open_purchase_capture_session(
        'group', ${sqlLiteral(sourceId)}, ${sqlLiteral(sender)},
        ${sqlLiteral(evt)}, 200000, 'header'
      )::text`,
    )) as Record<string, unknown>;
    const sessionId = String(open.session_id);
    const sessionGeneration = String(open.session_generation);
    await psqlScalar(
      `SELECT public.admit_purchase_capture_event(
        ${sqlLiteral(sessionId)}::uuid, ${sqlLiteral(sessionGeneration)}::uuid,
        'group', ${sqlLiteral(sourceId)}, ${sqlLiteral(sender)},
        ${sqlLiteral(`evt-ts-${tag}-close`)}, 200100, 'close', 'ปิดซื้อ 1 รายการ', NULL, NULL
      )::text`,
    );
    await psqlScalar("SELECT pg_sleep(9)::text");
    const rev = await psqlScalar(
      `SELECT ingest_revision::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(sessionId)}::uuid`,
    );
    const hash = await psqlScalar(
      `SELECT public.purchase_capture_compute_ingest_set_hash(${sqlLiteral(sessionId)}::uuid)`,
    );
    const receiptId = await psqlScalar(
      `SELECT (public.upsert_purchase_receipt_draft(
        'line-text', ${sqlLiteral(evt)}, 'p2b-slice-a-v1', '2026-07-29',
        '[{"product_key":"p","raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":"10"}]'::jsonb,
        p_source_type => 'group', p_source_id => ${sqlLiteral(sourceId)}, p_sender_line_user_id => ${sqlLiteral(sender)}
      )->>'receipt_id')`,
    );
    const draftRevision = await psqlScalar(
      `SELECT draft_revision::text FROM public.purchase_receipts WHERE id = ${sqlLiteral(receiptId)}::uuid`,
    );
    await psqlScalar(
      `SELECT public.finalize_purchase_capture_session(
        ${sqlLiteral(sessionId)}::uuid, ${sqlLiteral(sessionGeneration)}::uuid,
        'group', ${sqlLiteral(sourceId)}, ${sqlLiteral(sender)},
        ${rev}::bigint, ${sqlLiteral(hash)}, 'success',
        ${sqlLiteral(receiptId)}::uuid, ${draftRevision}::bigint,
        ARRAY['preview'], NULL
      )::text`,
    );
    return {
      sessionId,
      sessionGeneration,
      receiptId,
      draftRevision,
      sourceId,
      sender,
      openedLineEventId: evt,
    };
  }

  const RACE_ADVISORY_LOCK = 918051600;

  async function raceReplaceWinsFirst(s: Awaited<ReturnType<typeof setupAwaiting>>, gateKey: string) {
    await ensureRaceGateTable();
    await psqlScalar(`INSERT INTO public.pc_race_gate (k, phase) VALUES (${sqlLiteral(gateKey)}, 'idle')`);

    const itemsBefore = await psqlScalar(
      `SELECT coalesce(jsonb_agg(jsonb_build_object('quantity', trim_scale(quantity)::text) ORDER BY item_ordinal), '[]'::jsonb)::text
       FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`,
    );

    const holderMarker = `RACE_REPLACE_HOLDER_${gateKey}`;
    const challengerMarker = `RACE_REPLACE_CHALLENGER_${gateKey}`;

    const holderScript = `
      BEGIN;
      SELECT id FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid FOR UPDATE;
      SELECT pg_advisory_xact_lock(${RACE_ADVISORY_LOCK});
      DO $race$
      BEGIN
        LOOP
          EXIT WHEN (SELECT phase FROM public.pc_race_gate WHERE k = ${sqlLiteral(gateKey)}) = 'release';
          PERFORM pg_sleep(0.05);
        END LOOP;
      END $race$;
      SELECT public.replace_purchase_capture_draft(
        ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
        ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
        'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)},
        jsonb_build_object(
          'document_namespace','line-text',
          'document_key',${sqlLiteral(s.openedLineEventId)},
          'contract_version','p2b-slice-a-v1',
          'business_date','2026-07-29',
          'items', jsonb_build_array(jsonb_build_object(
            'product_key','p','raw_product_text','p','product_identity_status','RESOLVED',
            'quantity','2','unit_key','kg','raw_unit','kg','unit_identity_status','RESOLVED',
            'price_unit_status','NOT_APPLICABLE','unit_cost','20'
          ))
        ),
        ARRAY['race replace preview']
      );
      COMMIT;`;

    const challengerScript = `
      SELECT public.begin_purchase_capture_confirmation(
        ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
        ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
        'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, NULL
      );`;

    const holder = spawnPsqlScript(psqlPath, dbName, holderScript, holderMarker);
    await pollUntil(
      "holder session lock",
      `SELECT count(*)::text FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.classid = 0 AND l.objid = ${RACE_ADVISORY_LOCK}
          AND l.granted AND a.query LIKE '%${holderMarker.replace(/'/g, "''")}%'`,
      "1",
    );

    const challenger = spawnPsqlScript(psqlPath, dbName, challengerScript, challengerMarker);
    await pollUntil(
      "challenger blocked",
      `SELECT count(*)::text FROM pg_stat_activity a
         JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
        WHERE a.wait_event_type = 'Lock' AND a.query LIKE '%${challengerMarker.replace(/'/g, "''")}%'`,
      "1",
    );

    await psqlScalar(`UPDATE public.pc_race_gate SET phase = 'release' WHERE k = ${sqlLiteral(gateKey)}`);

    const [holderResult, challengerResult] = await Promise.all([holder.result, challenger.result]);
    expect(holderResult.code, `holder failed: ${holderResult.stderr}${holderResult.stdout}`).toBe(0);
    expect(challengerResult.code, `challenger should fail: ${challengerResult.stderr}${challengerResult.stdout}`).not.toBe(0);
    expect((challengerResult.stderr + challengerResult.stdout).toLowerCase()).toMatch(/stale_revision|invalid_state/);

    expect(await psqlScalar(
      `SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
    )).toBe("awaiting_confirmation");
    expect(await psqlScalar(
      `SELECT count(*)::text FROM public.purchase_capture_lifecycle_events
        WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid AND event = 'confirming'`,
    )).toBe("0");
    expect(await psqlScalar(
      `SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
    )).toBe("t");
    const itemsAfter = await psqlScalar(
      `SELECT coalesce(jsonb_agg(jsonb_build_object('quantity', trim_scale(quantity)::text) ORDER BY item_ordinal), '[]'::jsonb)::text
       FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`,
    );
    expect(itemsAfter).not.toBe(itemsBefore);
    expect(itemsAfter).toContain('"quantity": "2"');
    expect(await psqlScalar(
      `SELECT draft_revision::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
    )).not.toBe(s.draftRevision);
  }

  async function raceBeginWinsFirst(s: Awaited<ReturnType<typeof setupAwaiting>>, gateKey: string) {
    await ensureRaceGateTable();
    await psqlScalar(`INSERT INTO public.pc_race_gate (k, phase) VALUES (${sqlLiteral(gateKey)}, 'idle')`);

    const snapshotBefore = await psqlScalar(
      `SELECT coalesce(jsonb_agg(jsonb_build_object(
          'ordinal', item_ordinal,
          'product_key', product_key,
          'quantity', trim_scale(quantity)::text,
          'unit_cost', trim_scale(unit_cost)::text
        ) ORDER BY item_ordinal), '[]'::jsonb)::text
       FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`,
    );

    const holderMarker = `RACE_BEGIN_HOLDER_${gateKey}`;
    const challengerMarker = `RACE_BEGIN_CHALLENGER_${gateKey}`;

    const holderScript = `
      BEGIN;
      SELECT id FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid FOR UPDATE;
      SELECT pg_advisory_xact_lock(${RACE_ADVISORY_LOCK});
      DO $race$
      BEGIN
        LOOP
          EXIT WHEN (SELECT phase FROM public.pc_race_gate WHERE k = ${sqlLiteral(gateKey)}) = 'release';
          PERFORM pg_sleep(0.05);
        END LOOP;
      END $race$;
      SELECT public.begin_purchase_capture_confirmation(
        ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
        ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
        'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, NULL
      );
      COMMIT;`;

    const challengerScript = `
      SELECT public.replace_purchase_capture_draft(
        ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
        ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
        'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)},
        jsonb_build_object(
          'document_namespace','line-text',
          'document_key',${sqlLiteral(s.openedLineEventId)},
          'contract_version','p2b-slice-a-v1',
          'business_date','2026-07-29',
          'items', jsonb_build_array(jsonb_build_object(
            'product_key','p','raw_product_text','p','product_identity_status','RESOLVED',
            'quantity','99','unit_key','kg','raw_unit','kg','unit_identity_status','RESOLVED',
            'price_unit_status','NOT_APPLICABLE','unit_cost','99'
          ))
        ),
        ARRAY['race blocked replace']
      );`;

    const holder = spawnPsqlScript(psqlPath, dbName, holderScript, holderMarker);
    await pollUntil(
      "holder session lock",
      `SELECT count(*)::text FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.classid = 0 AND l.objid = ${RACE_ADVISORY_LOCK}
          AND l.granted AND a.query LIKE '%${holderMarker.replace(/'/g, "''")}%'`,
      "1",
    );

    const challenger = spawnPsqlScript(psqlPath, dbName, challengerScript, challengerMarker);
    await pollUntil(
      "challenger blocked",
      `SELECT count(*)::text FROM pg_stat_activity a
         JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
        WHERE a.wait_event_type = 'Lock' AND a.query LIKE '%${challengerMarker.replace(/'/g, "''")}%'`,
      "1",
    );

    await psqlScalar(`UPDATE public.pc_race_gate SET phase = 'release' WHERE k = ${sqlLiteral(gateKey)}`);

    const [holderResult, challengerResult] = await Promise.all([holder.result, challenger.result]);
    expect(holderResult.code, `holder begin failed: ${holderResult.stderr}${holderResult.stdout}`).toBe(0);
    expect(challengerResult.code, `replace must fail: ${challengerResult.stderr}${challengerResult.stdout}`).not.toBe(0);
    expect((challengerResult.stderr + challengerResult.stdout).toLowerCase()).toContain("invalid_state");

    expect(await psqlScalar(
      `SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
    )).toBe("confirming");
    expect(await psqlScalar(
      `SELECT count(*)::text FROM public.purchase_capture_lifecycle_events
        WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid AND event = 'confirming'`,
    )).toBe("1");
    expect(await psqlScalar(
      `SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
    )).toBe("t");

    const snapshotAfter = await psqlScalar(
      `SELECT coalesce(jsonb_agg(jsonb_build_object(
          'ordinal', item_ordinal,
          'product_key', product_key,
          'quantity', trim_scale(quantity)::text,
          'unit_cost', trim_scale(unit_cost)::text
        ) ORDER BY item_ordinal), '[]'::jsonb)::text
       FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`,
    );
    expect(snapshotAfter).toBe(snapshotBefore);
  }

  test(
    "bootstrap + 0052 + Slice A/B + 0053 + Slice C + hardening PASS on disposable DB",
    async () => {
      for (const file of ALL_FIXTURES) {
        expect(existsSync(file), `missing ${file}`).toBe(true);
      }

      const create = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `CREATE DATABASE ${dbName}`]);
      expect(create.code, `CREATE DATABASE failed: ${create.stderr}`).toBe(0);
      dbCreated = true;

      for (const file of [BOOTSTRAP, MIGRATION_0052, MIGRATION_A, MIGRATION_B, MIGRATION_HARDENING, PRE_0053, MIGRATION_0053, POST_0053, MIGRATION_C, OPEN_REPLAY_FIX]) {
        const result = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", file], { database: dbName });
        expect(result.code, `${file} failed:\n${result.stderr}\n${result.stdout}`).toBe(0);
      }

      const hard = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-f", HARDENING_C], { database: dbName });
      expect(hard.code, `hardening failed:\n${hard.stderr}\n${hard.stdout}`).toBe(0);
      expect(hard.stderr + hard.stdout).toContain("purchase_capture_slice_c_hardening PASS");
      ready = true;
      console.info("Purchase capture Slice C1 hardening: PASS (real PostgreSQL)");
    },
    { timeout: 300_000 },
  );

  test(
    "deterministic concurrency: replace wins — begin refuses stale_revision",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const s = await setupAwaiting(`race-replace-${tag}`);
      await raceReplaceWinsFirst(s, `replace-wins-${tag}`);
    },
    { timeout: 120_000 },
  );

  test(
    "deterministic concurrency: begin wins — replace refuses invalid_state",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const s = await setupAwaiting(`race-begin-${tag}`);
      await raceBeginWinsFirst(s, `begin-wins-${tag}`);
    },
    { timeout: 120_000 },
  );

  afterAll(async () => {
    if (!dbCreated) return;
    await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`]);
  });
});
