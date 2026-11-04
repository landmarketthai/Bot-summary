/**
 * P2C Slice C5 — end-to-end integration proof, real PostgreSQL, SQL-level.
 *
 * This is the authoritative money/stock correctness evidence for the confirm
 * -> post -> complete pipeline added in
 * supabase/migrations/20260805160000_purchase_capture_confirm_post.sql, built
 * on top of 0052 (purchase_receipts), 0053 (inventory_movements), and the
 * Slice A/B session/draft/outbox migrations. Every assertion here reads REAL
 * rows from a disposable database — nothing here is asserted against a mock.
 *
 * Harness (psql resolution, probeConnection, REQUIRE_POSTGRES_TESTS hard-fail,
 * describe.skipIf, temp DB naming, fixture list/order, psqlScalar, sqlLiteral,
 * spawnPsqlScript, the advisory-lock race harness) is copied verbatim from
 * migration-slice-c.pg.test.ts — see that file for the harness's own commentary.
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
  console.warn(`Purchase capture Slice C2 integration PG tests SKIPPED: PostgreSQL unavailable (${probe.detail})`);
}

if (REQUIRE_POSTGRES_TESTS && !pgAvailable) {
  throw new Error(
    `PostgreSQL tests are required but unavailable at ${PGHOST}:${PGPORT}: ${probe.detail}`,
  );
}

describe.skipIf(!pgAvailable)("Purchase capture Slice C2 end-to-end integration (real PostgreSQL)", () => {
  const dbName = `pc_slice_c2_${randomBytes(4).toString("hex")}`;
  const psqlPath = resolvedPsql as string;
  let dbCreated = false;
  let ready = false;

  async function psqlScalar(sql: string): Promise<string> {
    const r = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", sql], { database: dbName });
    if (r.code !== 0) throw new Error(`psqlScalar failed: ${r.stderr || r.stdout}\nSQL: ${sql}`);
    return (r.stdout || "").trim();
  }

  /** Runs a SQL statement and returns { ok, message } instead of throwing — for refusal assertions. */
  async function psqlExpectError(sql: string): Promise<{ ok: boolean; message: string }> {
    const r = await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", dbName, "-tAc", sql], { database: dbName });
    if (r.code === 0) return { ok: true, message: (r.stdout || "").trim() };
    return { ok: false, message: (r.stderr || r.stdout || "").trim() };
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

  /**
   * A product_key unique to `tag` — supabase/tests/purchase_capture_slice_c_hardening.sql
   * (run once during bootstrap) and other scenarios in this file all post
   * movements for generic keys, so a shared product_key would make any
   * absolute-balance assertion contaminated by unrelated rows. Every balance
   * assertion in this file therefore reads back its OWN tag-scoped product.
   */
  function standardItemJson(productKey: string): string {
    return `[{"product_key":${JSON.stringify(productKey)},"raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":"10"}]`;
  }

  /** Four items, each carrying exactly one distinct blocking-blocker defect. */
  const BLOCKER_ITEMS = `[
    {"product_key":"unresolved:product:x","raw_product_text":"x","product_identity_status":"UNRESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":"10"},
    {"product_key":"p","raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"unresolved:unit:y","raw_unit":"y","unit_identity_status":"UNRESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":"10"},
    {"product_key":"p","raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_status":"UNRESOLVED","price_unit_text":"box","unit_cost":"10"},
    {"product_key":"p","raw_product_text":"p","product_identity_status":"RESOLVED","quantity":"1","unit_key":"kg","raw_unit":"kg","unit_identity_status":"RESOLVED","price_unit_status":"NOT_APPLICABLE","unit_cost":null}
  ]`;

  /**
   * Walks the REAL pipeline from a fresh header to a session sitting at
   * awaiting_confirmation with a bound, unblocked, single-item (by default)
   * draft. Amortises the 9s quiet-window sleep across every assertion built
   * on top of the returned session.
   */
  async function setupAwaiting(tag: string, itemsJson: string = standardItemJson(`p-${tag}`)) {
    const evt = `evt-c2-${tag}-open`;
    const sourceId = `G-c2-${tag}`;
    const sender = `U-c2-${tag}`;
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
        ${sqlLiteral(`evt-c2-${tag}-close`)}, 200100, 'close', 'ปิดซื้อ 1 รายการ', NULL, NULL
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
        '${itemsJson.replace(/'/g, "''")}'::jsonb,
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

  /**
   * Extends setupAwaiting all the way through begin_ -> confirm_ -> post_ ->
   * complete_, so the session lands 'posted' with a real movement bound to
   * real MAIN stock. `postedTexts` lets a caller control the outbox part
   * count (default: one part; scenario 8 needs two).
   */
  async function setupPostedReady(tag: string, postedTexts: string[] = ["posted text"]) {
    const s = await setupAwaiting(tag);
    await psqlScalar(
      `SELECT public.begin_purchase_capture_confirmation(
        ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
        ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
        'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
      )::text`,
    );
    await psqlScalar(
      `SELECT public.confirm_purchase_receipt(
        ${sqlLiteral(s.receiptId)}::uuid, ${sqlLiteral(`confirm-${tag}`)}, ${s.draftRevision}::bigint, 'actor-c2'
      )::text`,
    );
    const postJson = JSON.parse(
      await psqlScalar(`SELECT public.post_purchase_receipt_inventory_movement(${sqlLiteral(s.receiptId)}::uuid, 'actor-c2')::text`),
    ) as Record<string, unknown>;
    const movementId = String(postJson.movement_id);
    const textsLiteral = `ARRAY[${postedTexts.map((t) => sqlLiteral(t)).join(",")}]`;
    await psqlScalar(
      `SELECT public.complete_purchase_capture_posting(
        ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
        ${sqlLiteral(movementId)}::uuid, ${textsLiteral}, 'actor-c2'
      )::text`,
    );
    return { ...s, movementId };
  }

  const RACE_ADVISORY_LOCK = 918051700;

  async function raceReplaceWinsFirst(s: Awaited<ReturnType<typeof setupAwaiting>>, gateKey: string) {
    await ensureRaceGateTable();
    await psqlScalar(`INSERT INTO public.pc_race_gate (k, phase) VALUES (${sqlLiteral(gateKey)}, 'idle')`);

    const itemsBefore = await psqlScalar(
      `SELECT coalesce(jsonb_agg(jsonb_build_object('quantity', trim_scale(quantity)::text) ORDER BY item_ordinal), '[]'::jsonb)::text
       FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`,
    );

    const holderMarker = `RACE_C2_REPLACE_HOLDER_${gateKey}`;
    const challengerMarker = `RACE_C2_REPLACE_CHALLENGER_${gateKey}`;

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
      `SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
    )).toBe("t");
    const itemsAfter = await psqlScalar(
      `SELECT coalesce(jsonb_agg(jsonb_build_object('quantity', trim_scale(quantity)::text) ORDER BY item_ordinal), '[]'::jsonb)::text
       FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`,
    );
    expect(itemsAfter).not.toBe(itemsBefore);
    expect(itemsAfter).toContain('"quantity": "2"');
  }

  async function raceBeginWinsFirst(s: Awaited<ReturnType<typeof setupAwaiting>>, gateKey: string) {
    await ensureRaceGateTable();
    await psqlScalar(`INSERT INTO public.pc_race_gate (k, phase) VALUES (${sqlLiteral(gateKey)}, 'idle')`);

    const snapshotBefore = await psqlScalar(
      `SELECT coalesce(jsonb_agg(jsonb_build_object(
          'ordinal', item_ordinal,
          'quantity', trim_scale(quantity)::text
        ) ORDER BY item_ordinal), '[]'::jsonb)::text
       FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`,
    );

    const holderMarker = `RACE_C2_BEGIN_HOLDER_${gateKey}`;
    const challengerMarker = `RACE_C2_BEGIN_CHALLENGER_${gateKey}`;

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
      `SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
    )).toBe("t");

    const snapshotAfter = await psqlScalar(
      `SELECT coalesce(jsonb_agg(jsonb_build_object(
          'ordinal', item_ordinal,
          'quantity', trim_scale(quantity)::text
        ) ORDER BY item_ordinal), '[]'::jsonb)::text
       FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`,
    );
    expect(snapshotAfter).toBe(snapshotBefore);
  }

  // ── Bootstrap ────────────────────────────────────────────────────────────

  test(
    "bootstrap + 0052 + Slice A/B + 0053 + Slice C + hardening PASS on a disposable DB",
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
      console.info("Purchase capture Slice C2 integration bootstrap: PASS (real PostgreSQL)");
    },
    { timeout: 300_000 },
  );

  // ── Scenario 1 + 2: ordinary flow, then no double movement / no double MAIN balance ──

  test(
    "ordinary successful flow posts exactly once, THEN a second full run never double-posts or double-credits MAIN",
    async () => {
      expect(ready).toBe(true);
      const tag = `s12-${randomBytes(3).toString("hex")}`;
      const s = await setupPostedReady(tag);

      // Scenario 1 — real rows, not mocks.
      expect(await psqlScalar(
        `SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
      )).toBe("posted");
      expect(await psqlScalar(
        `SELECT movement_id::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
      )).toBe(s.movementId);

      const movementRows = await psqlScalar(
        `SELECT count(*)::text FROM public.inventory_movements
          WHERE source_document_type = 'purchase_receipt' AND source_document_id = ${sqlLiteral(s.receiptId)}::uuid
            AND movement_type = 'PURCHASE_RECEIPT'`,
      );
      expect(movementRows, "exactly one PURCHASE_RECEIPT movement for the receipt").toBe("1");

      const lineLocations = await psqlScalar(
        `SELECT string_agg(DISTINCT location_code, ',') FROM public.inventory_movement_lines WHERE movement_id = ${sqlLiteral(s.movementId)}::uuid`,
      );
      expect(lineLocations).toBe("MAIN");

      const productKey = `p-${tag}`;
      const balanceJson = JSON.parse(
        await psqlScalar(`SELECT public.get_inventory_balances(p_location_code => 'MAIN', p_product_key => ${sqlLiteral(productKey)}, p_unit_key => 'kg')::text`),
      ) as { balances: Array<{ quantity_balance: string }> };
      expect(balanceJson.balances).toHaveLength(1);
      expect(balanceJson.balances[0]?.quantity_balance).toBe("1.000000");

      const notificationCount = await psqlScalar(
        `SELECT count(*)::text FROM public.purchase_capture_notifications
          WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid
            AND notification_kind = 'posted_success' AND notification_version = ${sqlLiteral(s.movementId)}`,
      );
      expect(notificationCount).toBe("1");

      // Scenario 2 — THE most important assertion in this slice: re-running
      // confirm -> post -> complete a SECOND time against the SAME inputs
      // must not create a second movement or move the MAIN balance again.
      await psqlScalar(
        `SELECT public.confirm_purchase_receipt(${sqlLiteral(s.receiptId)}::uuid, ${sqlLiteral(`confirm-${tag}`)}, ${s.draftRevision}::bigint, 'actor-c2')::text`,
      );
      const secondPost = JSON.parse(
        await psqlScalar(`SELECT public.post_purchase_receipt_inventory_movement(${sqlLiteral(s.receiptId)}::uuid, 'actor-c2')::text`),
      ) as { movement_id: string; replayed: boolean };
      expect(secondPost.replayed).toBe(true);
      expect(secondPost.movement_id).toBe(s.movementId);
      await psqlScalar(
        `SELECT public.complete_purchase_capture_posting(
          ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
          ${sqlLiteral(s.movementId)}::uuid, ARRAY['posted text'], 'actor-c2'
        )::text`,
      );

      const movementRowsAfterRerun = await psqlScalar(
        `SELECT count(*)::text FROM public.inventory_movements
          WHERE source_document_type = 'purchase_receipt' AND source_document_id = ${sqlLiteral(s.receiptId)}::uuid
            AND movement_type = 'PURCHASE_RECEIPT'`,
      );
      expect(movementRowsAfterRerun, "NO SECOND MOVEMENT after re-running the whole chain").toBe("1");

      const movementIdAfterRerun = await psqlScalar(
        `SELECT movement_id::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
      );
      expect(movementIdAfterRerun, "movement id unchanged after re-running the whole chain").toBe(s.movementId);

      const balanceAfterRerun = JSON.parse(
        await psqlScalar(`SELECT public.get_inventory_balances(p_location_code => 'MAIN', p_product_key => ${sqlLiteral(productKey)}, p_unit_key => 'kg')::text`),
      ) as { balances: Array<{ quantity_balance: string }> };
      expect(
        balanceAfterRerun.balances[0]?.quantity_balance,
        "NO SECOND MAIN BALANCE INCREASE after re-running the whole chain",
      ).toBe("1.000000");
    },
    { timeout: 60_000 },
  );

  // ── Scenario 3: crash/retry at every transaction boundary ─────────────────

  test(
    "crash simulated after every transaction boundary — resume from the documented recovery entry point recovers to exactly one movement",
    async () => {
      expect(ready).toBe(true);
      const tagPrefix = randomBytes(3).toString("hex");

      // Crash after begin_ (session 'confirming', receipt still draft) -> resume confirm/post/complete.
      {
        const tag = `s3a-${tagPrefix}`;
        const s = await setupAwaiting(tag);
        await psqlScalar(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
            'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
          )::text`,
        );
        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("confirming");
        expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(s.receiptId)}::uuid`)).toBe("draft");

        // -- crash simulated: nothing else called --
        // resume:
        await psqlScalar(
          `SELECT public.confirm_purchase_receipt(${sqlLiteral(s.receiptId)}::uuid, ${sqlLiteral(`confirm-${tag}`)}, ${s.draftRevision}::bigint, 'actor-c2')::text`,
        );
        const post = JSON.parse(
          await psqlScalar(`SELECT public.post_purchase_receipt_inventory_movement(${sqlLiteral(s.receiptId)}::uuid, 'actor-c2')::text`),
        ) as { movement_id: string };
        await psqlScalar(
          `SELECT public.complete_purchase_capture_posting(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(post.movement_id)}::uuid, ARRAY['posted'], 'actor-c2'
          )::text`,
        );
        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("posted");
        expect(await psqlScalar(
          `SELECT count(*)::text FROM public.inventory_movements WHERE source_document_id = ${sqlLiteral(s.receiptId)}::uuid`,
        )).toBe("1");
      }

      // Crash after confirm (receipt 'confirmed', no movement) -> resume post/complete.
      {
        const tag = `s3b-${tagPrefix}`;
        const s = await setupAwaiting(tag);
        await psqlScalar(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
            'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
          )::text`,
        );
        await psqlScalar(
          `SELECT public.confirm_purchase_receipt(${sqlLiteral(s.receiptId)}::uuid, ${sqlLiteral(`confirm-${tag}`)}, ${s.draftRevision}::bigint, 'actor-c2')::text`,
        );
        expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(s.receiptId)}::uuid`)).toBe("confirmed");
        expect(await psqlScalar(
          `SELECT count(*)::text FROM public.inventory_movements WHERE source_document_id = ${sqlLiteral(s.receiptId)}::uuid`,
        )).toBe("0");

        // -- crash simulated: post_/complete_ not called yet --
        const post = JSON.parse(
          await psqlScalar(`SELECT public.post_purchase_receipt_inventory_movement(${sqlLiteral(s.receiptId)}::uuid, 'actor-c2')::text`),
        ) as { movement_id: string };
        await psqlScalar(
          `SELECT public.complete_purchase_capture_posting(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(post.movement_id)}::uuid, ARRAY['posted'], 'actor-c2'
          )::text`,
        );
        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("posted");
      }

      // Crash after post (movement exists, session still 'confirming', movement_id NULL)
      // -> re-posting replays the SAME movement id -> resume complete_.
      {
        const tag = `s3c-${tagPrefix}`;
        const s = await setupAwaiting(tag);
        await psqlScalar(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
            'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
          )::text`,
        );
        await psqlScalar(
          `SELECT public.confirm_purchase_receipt(${sqlLiteral(s.receiptId)}::uuid, ${sqlLiteral(`confirm-${tag}`)}, ${s.draftRevision}::bigint, 'actor-c2')::text`,
        );
        const post1 = JSON.parse(
          await psqlScalar(`SELECT public.post_purchase_receipt_inventory_movement(${sqlLiteral(s.receiptId)}::uuid, 'actor-c2')::text`),
        ) as { movement_id: string };

        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("confirming");
        expect(await psqlScalar(`SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("t");
        expect(await psqlScalar(
          `SELECT count(*)::text FROM public.inventory_movements WHERE source_document_id = ${sqlLiteral(s.receiptId)}::uuid`,
        )).toBe("1");

        // -- crash simulated: complete_ not called yet --
        // resume: re-running post_ replays the SAME movement id.
        const post2 = JSON.parse(
          await psqlScalar(`SELECT public.post_purchase_receipt_inventory_movement(${sqlLiteral(s.receiptId)}::uuid, 'actor-c2')::text`),
        ) as { movement_id: string; replayed: boolean };
        expect(post2.replayed).toBe(true);
        expect(post2.movement_id).toBe(post1.movement_id);
        expect(await psqlScalar(
          `SELECT count(*)::text FROM public.inventory_movements WHERE source_document_id = ${sqlLiteral(s.receiptId)}::uuid`,
        )).toBe("1");

        await psqlScalar(
          `SELECT public.complete_purchase_capture_posting(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(post1.movement_id)}::uuid, ARRAY['posted'], 'actor-c2'
          )::text`,
        );
        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("posted");

        // Crash after complete_ (session 'posted', parts exist, undelivered)
        // -> re-running complete_ with the same movement id and byte-identical
        // texts is an idempotent replay: same part ids/retry_keys, no new parts.
        const partsBefore = JSON.parse(
          await psqlScalar(
            `SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'retry_key', retry_key) ORDER BY part_index), '[]'::jsonb)::text
             FROM public.purchase_capture_notifications
             WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid AND notification_kind = 'posted_success' AND notification_version = ${sqlLiteral(post1.movement_id)}`,
          ),
        ) as Array<{ id: string; retry_key: string }>;
        expect(partsBefore.length).toBeGreaterThan(0);

        const replay = JSON.parse(
          await psqlScalar(
            `SELECT public.complete_purchase_capture_posting(
              ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
              ${sqlLiteral(post1.movement_id)}::uuid, ARRAY['posted'], 'actor-c2'
            )::text`,
          ),
        ) as { idempotent: boolean };
        expect(replay.idempotent, "re-running complete_ with the same movement id and byte-identical texts is idempotent").toBe(true);

        const partsAfter = JSON.parse(
          await psqlScalar(
            `SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'retry_key', retry_key) ORDER BY part_index), '[]'::jsonb)::text
             FROM public.purchase_capture_notifications
             WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid AND notification_kind = 'posted_success' AND notification_version = ${sqlLiteral(post1.movement_id)}`,
          ),
        ) as Array<{ id: string; retry_key: string }>;
        expect(partsAfter).toEqual(partsBefore);
      }
    },
    { timeout: 90_000 },
  );

  // ── Scenario 4: begin_ refusals ─────────────────────────────────────────

  test(
    "begin_purchase_capture_confirmation refuses every documented case, leaving the session untouched and creating no movement/confirmation",
    async () => {
      expect(ready).toBe(true);
      const tag = `s4-${randomBytes(3).toString("hex")}`;
      const s = await setupAwaiting(tag);

      async function assertUntouched() {
        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("awaiting_confirmation");
        expect(await psqlScalar(`SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("t");
        expect(await psqlScalar(
          `SELECT count(*)::text FROM public.inventory_movements WHERE source_document_id = ${sqlLiteral(s.receiptId)}::uuid`,
        )).toBe("0");
      }

      // ownership mismatch (wrong sender)
      {
        const r = await psqlExpectError(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
            'group', ${sqlLiteral(s.sourceId)}, 'U-someone-else', 'actor-c2'
          )::text`,
        );
        expect(r.ok).toBe(false);
        expect(r.message).toContain("ownership_mismatch");
        expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(s.receiptId)}::uuid`)).toBe("draft");
        await assertUntouched();
      }

      // generation conflict
      {
        const r = await psqlExpectError(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, gen_random_uuid(),
            ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
            'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
          )::text`,
        );
        expect(r.ok).toBe(false);
        expect(r.message).toContain("generation_conflict");
        expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(s.receiptId)}::uuid`)).toBe("draft");
        await assertUntouched();
      }

      // stale revision (wrong expected draft_revision)
      {
        const r = await psqlExpectError(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(s.receiptId)}::uuid, 999999::bigint,
            'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
          )::text`,
        );
        expect(r.ok).toBe(false);
        expect(r.message).toContain("stale_revision");
        expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(s.receiptId)}::uuid`)).toBe("draft");
        await assertUntouched();
      }

      // receipt binding mismatch: point the session at a SECOND receipt whose
      // document_key differs from the session's opened_line_event_id (direct
      // row manipulation — document_key is trigger-immutable once set, so a
      // mismatch can only be produced by attaching a foreign receipt).
      {
        const otherReceiptId = await psqlScalar(
          `SELECT (public.upsert_purchase_receipt_draft(
            'line-text', ${sqlLiteral(`evt-c2-${tag}-other`)}, 'p2b-slice-a-v1', '2026-07-29',
            '${standardItemJson(`p-${tag}-other`)}'::jsonb,
            p_source_type => 'group', p_source_id => ${sqlLiteral(s.sourceId)}, p_sender_line_user_id => ${sqlLiteral(s.sender)}
          )->>'receipt_id')`,
        );
        await psqlScalar(
          `UPDATE public.purchase_capture_sessions
             SET receipt_id = ${sqlLiteral(otherReceiptId)}::uuid, draft_revision = ${s.draftRevision}::bigint
           WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
        );
        const r = await psqlExpectError(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(otherReceiptId)}::uuid, ${s.draftRevision}::bigint,
            'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
          )::text`,
        );
        expect(r.ok).toBe(false);
        expect(r.message).toContain("receipt_binding_mismatch");
        expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(otherReceiptId)}::uuid`)).toBe("draft");
        // restore original binding for the remaining sub-cases sharing this session
        await psqlScalar(
          `UPDATE public.purchase_capture_sessions
             SET receipt_id = ${sqlLiteral(s.receiptId)}::uuid, draft_revision = ${s.draftRevision}::bigint
           WHERE id = ${sqlLiteral(s.sessionId)}::uuid`,
        );
        await assertUntouched();
      }

      // empty receipt: delete every item row directly (bypassing app logic)
      // so the receipt itself is genuinely empty for begin_'s own check.
      {
        await psqlScalar(`DELETE FROM public.purchase_receipt_items WHERE receipt_id = ${sqlLiteral(s.receiptId)}::uuid`);
        const r = await psqlExpectError(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
            'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
          )::text`,
        );
        expect(r.ok).toBe(false);
        expect(r.message).toContain("empty_receipt");
        expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(s.receiptId)}::uuid`)).toBe("draft");
        await assertUntouched();
      }

      // Blocking blockers — one item per code, all four raised together from a
      // single draft: blocked product identity, blocked unit identity,
      // unresolved price unit, missing unit cost.
      {
        const blockerTag = `s4-blk-${randomBytes(3).toString("hex")}`;
        const blk = await setupAwaiting(blockerTag, BLOCKER_ITEMS);
        const r = await psqlExpectError(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(blk.sessionId)}::uuid, ${sqlLiteral(blk.sessionGeneration)}::uuid,
            ${sqlLiteral(blk.receiptId)}::uuid, ${blk.draftRevision}::bigint,
            'group', ${sqlLiteral(blk.sourceId)}, ${sqlLiteral(blk.sender)}, 'actor-c2'
          )::text`,
        );
        expect(r.ok).toBe(false);
        expect(r.message).toContain("blocking_blocker_present");
        expect(r.message).toContain("UNRESOLVED_PRODUCT_IDENTITY");
        expect(r.message).toContain("UNRESOLVED_UNIT_IDENTITY");
        expect(r.message).toContain("UNRESOLVED_PRICE_UNIT");
        expect(r.message).toContain("MISSING_UNIT_COST");
        expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(blk.receiptId)}::uuid`)).toBe("draft");
        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(blk.sessionId)}::uuid`)).toBe("awaiting_confirmation");
        expect(await psqlScalar(
          `SELECT count(*)::text FROM public.inventory_movements WHERE source_document_id = ${sqlLiteral(blk.receiptId)}::uuid`,
        )).toBe("0");
      }
    },
    { timeout: 60_000 },
  );

  // ── Scenario 5: complete_ refusals ──────────────────────────────────────

  test(
    "complete_purchase_capture_posting refuses a foreign movement id, a mismatched posted replay, and a payload identity conflict",
    async () => {
      expect(ready).toBe(true);
      const tag = `s5-${randomBytes(3).toString("hex")}`;

      // wrong/foreign movement id while 'confirming' -> invalid_movement.
      {
        const s = await setupAwaiting(`${tag}-im`);
        await psqlScalar(
          `SELECT public.begin_purchase_capture_confirmation(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
            'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
          )::text`,
        );
        await psqlScalar(
          `SELECT public.confirm_purchase_receipt(${sqlLiteral(s.receiptId)}::uuid, ${sqlLiteral(`confirm-${tag}-im`)}, ${s.draftRevision}::bigint, 'actor-c2')::text`,
        );
        const r = await psqlExpectError(
          `SELECT public.complete_purchase_capture_posting(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            gen_random_uuid(), ARRAY['x'], 'actor-c2'
          )::text`,
        );
        expect(r.ok).toBe(false);
        expect(r.message).toContain("invalid_movement");
        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("confirming");
        expect(await psqlScalar(`SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("t");
      }

      // already-posted with a DIFFERENT movement id -> invalid_state; same
      // movement id but DIFFERENT payload texts -> notification_identity_conflict,
      // session still posted with its original parts intact (rolled back).
      {
        const s = await setupPostedReady(`${tag}-posted`);

        const originalParts = JSON.parse(
          await psqlScalar(
            `SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'payload_text', payload_text) ORDER BY part_index), '[]'::jsonb)::text
             FROM public.purchase_capture_notifications
             WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid AND notification_kind = 'posted_success' AND notification_version = ${sqlLiteral(s.movementId)}`,
          ),
        );

        const wrongMovement = await psqlExpectError(
          `SELECT public.complete_purchase_capture_posting(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            gen_random_uuid(), ARRAY['x'], 'actor-c2'
          )::text`,
        );
        expect(wrongMovement.ok).toBe(false);
        expect(wrongMovement.message).toContain("invalid_state");

        const conflicting = await psqlExpectError(
          `SELECT public.complete_purchase_capture_posting(
            ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
            ${sqlLiteral(s.movementId)}::uuid, ARRAY['a completely different text'], 'actor-c2'
          )::text`,
        );
        expect(conflicting.ok).toBe(false);
        expect(conflicting.message).toContain("notification_identity_conflict");

        expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("posted");
        expect(await psqlScalar(`SELECT movement_id::text FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe(s.movementId);
        const partsAfter = JSON.parse(
          await psqlScalar(
            `SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'payload_text', payload_text) ORDER BY part_index), '[]'::jsonb)::text
             FROM public.purchase_capture_notifications
             WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid AND notification_kind = 'posted_success' AND notification_version = ${sqlLiteral(s.movementId)}`,
          ),
        );
        expect(partsAfter).toEqual(originalParts);
      }
    },
    { timeout: 60_000 },
  );

  // ── Scenario 6: cancellation before confirmation ────────────────────────

  test(
    "cancel_purchase_capture_session before confirmation makes begin_ refuse invalid_state, with no movement and no confirmation",
    async () => {
      expect(ready).toBe(true);
      const tag = `s6-${randomBytes(3).toString("hex")}`;
      const s = await setupAwaiting(tag);

      await psqlScalar(
        `SELECT public.cancel_purchase_capture_session(
          ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
          'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}
        )::text`,
      );
      expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("cancelled");

      const r = await psqlExpectError(
        `SELECT public.begin_purchase_capture_confirmation(
          ${sqlLiteral(s.sessionId)}::uuid, ${sqlLiteral(s.sessionGeneration)}::uuid,
          ${sqlLiteral(s.receiptId)}::uuid, ${s.draftRevision}::bigint,
          'group', ${sqlLiteral(s.sourceId)}, ${sqlLiteral(s.sender)}, 'actor-c2'
        )::text`,
      );
      expect(r.ok).toBe(false);
      expect(r.message).toContain("invalid_state");

      expect(await psqlScalar(`SELECT status FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("cancelled");
      expect(await psqlScalar(`SELECT movement_id IS NULL FROM public.purchase_capture_sessions WHERE id = ${sqlLiteral(s.sessionId)}::uuid`)).toBe("t");
      expect(await psqlScalar(`SELECT status FROM public.purchase_receipts WHERE id = ${sqlLiteral(s.receiptId)}::uuid`)).toBe("draft");
      expect(await psqlScalar(
        `SELECT count(*)::text FROM public.inventory_movements WHERE source_document_id = ${sqlLiteral(s.receiptId)}::uuid`,
      )).toBe("0");
    },
    { timeout: 60_000 },
  );

  // ── Scenario 7: confirm vs recheck race — real lock-ordering proof ──────

  test(
    "deterministic concurrency: replace wins first — begin_ refuses stale_revision",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const s = await setupAwaiting(`s7-replace-${tag}`);
      await raceReplaceWinsFirst(s, `c2-replace-wins-${tag}`);
    },
    { timeout: 120_000 },
  );

  test(
    "deterministic concurrency: begin_ wins first — replace refuses invalid_state",
    async () => {
      expect(ready).toBe(true);
      const tag = randomBytes(3).toString("hex");
      const s = await setupAwaiting(`s7-begin-${tag}`);
      await raceBeginWinsFirst(s, `c2-begin-wins-${tag}`);
    },
    { timeout: 120_000 },
  );

  // ── Scenario 8: posted-success partial delivery ─────────────────────────

  test(
    "posted_success partial delivery: claim only ever returns the missing part, never re-sends a delivered one, and nothing is time-abandoned",
    async () => {
      expect(ready).toBe(true);
      const tag = `s8-${randomBytes(3).toString("hex")}`;
      const s = await setupPostedReady(tag, ["posted part 0", "posted part 1"]);

      const partCount = await psqlScalar(
        `SELECT count(*)::text FROM public.purchase_capture_notifications
          WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid AND notification_kind = 'posted_success' AND notification_version = ${sqlLiteral(s.movementId)}`,
      );
      expect(partCount, "setup produced exactly two posted_success parts").toBe("2");

      const part0Id = await psqlScalar(
        `SELECT id::text FROM public.purchase_capture_notifications
          WHERE session_id = ${sqlLiteral(s.sessionId)}::uuid AND notification_kind = 'posted_success'
            AND notification_version = ${sqlLiteral(s.movementId)} AND part_index = 0`,
      );
      // Mark part 0 delivered directly (setup for this assertion, not the
      // behavior under test).
      await psqlScalar(
        `UPDATE public.purchase_capture_notifications
           SET delivery_status = 'delivered', delivered_at = now()
         WHERE id = ${sqlLiteral(part0Id)}::uuid`,
      );

      const claim = JSON.parse(
        await psqlScalar(
          `SELECT public.claim_next_purchase_capture_notification_part(
            ${sqlLiteral(s.sessionId)}::uuid, 'posted_success', ${sqlLiteral(s.movementId)}, 60
          )::text`,
        ),
      ) as { claimed: boolean; part_index: number; id: string; claim_token: string };
      expect(claim.claimed, "claim returns the still-undelivered part").toBe(true);
      expect(claim.part_index, "never re-claims the already-delivered part 0").toBe(1);

      await psqlScalar(
        `SELECT public.mark_purchase_capture_notification_part_delivered(${sqlLiteral(claim.id)}::uuid, ${sqlLiteral(claim.claim_token)}::uuid)::text`,
      );

      const exhausted = JSON.parse(
        await psqlScalar(
          `SELECT public.claim_next_purchase_capture_notification_part(
            ${sqlLiteral(s.sessionId)}::uuid, 'posted_success', ${sqlLiteral(s.movementId)}, 60
          )::text`,
        ),
      ) as { claimed: boolean; reason?: string };
      expect(exhausted.claimed).toBe(false);
      expect(exhausted.reason).toBe("nothing_eligible");

      // No 24-hour-style (or any) time-based abandonment column exists on the
      // outbox table — the only time-bearing column is the claim lease itself.
      const columns = await psqlScalar(
        `SELECT string_agg(column_name, ',') FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'purchase_capture_notifications'`,
      );
      expect(columns).not.toMatch(/abandon|expired_at|stale_after/i);
      expect(columns).toContain("claim_expires_at");
    },
    { timeout: 60_000 },
  );

  afterAll(async () => {
    if (!dbCreated) return;
    await runPsql(psqlPath, ["-v", "ON_ERROR_STOP=1", "-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`]);
  });
});
