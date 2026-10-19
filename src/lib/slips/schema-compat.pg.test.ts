/**
 * P1 #7 - schema compatibility and rollback, on real PostgreSQL 17.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/schema-compat.pg.test.ts
 *
 * Deployment contract this suite pins down (docs must say the same):
 *   - The migration is a HARD prerequisite. Deploy order: migration, then app.
 *   - NEW app on the OLD schema: opening a slip session fails loudly and
 *     creates nothing; closing is an explicit error (never "already closing");
 *     images and the finalizer take the explicit legacy path.
 *   - OLD app on the NEW schema: the claim must not stall on ledger rows for
 *     images the old app attached through the legacy path.
 *   - Upgrading with a collecting/closing batch in flight loses nothing.
 *   - Rolling back (supabase/rollback/...down.sql) with in-flight images is
 *     refused unless explicitly forced; once drained, the legacy path finishes
 *     the batch and the ledger table is kept for audit.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { WebhookService } from "@/lib/line/webhook-service";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";
import {
  PGHOST,
  PGPASSWORD,
  PGPORT,
  PGUSER,
  ROOT,
  SLIP_PIPELINE_MIGRATIONS,
  createPgSupabase,
  createSlipTestDb,
  probePg,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

const WIN_PSQL = "C:\\Program Files\\PostgreSQL\\17\\bin\\psql.exe";
const PSQL = existsSync(WIN_PSQL) ? WIN_PSQL : "psql";
const LEDGER_MIGRATION = "20261017100000";
const OLD_SCHEMA = SLIP_PIPELINE_MIGRATIONS.filter((m) => m < `${LEDGER_MIGRATION}`);
const LEDGER_MIGRATIONS = SLIP_PIPELINE_MIGRATIONS.filter((m) => m >= LEDGER_MIGRATION);
const DOWN_SCRIPT = join(ROOT, "supabase", "rollback", "20261017100000_slip_image_ingestion_ledger.down.sql");
const T0 = 1_760_000_000_000;

const noGuidedRound = {
  resolve: async () => ({ stage: "idle", reason: "no_session" }),
  findRoundOwner: async () => ({ kind: "none" as const }),
};

async function runPsql(database: string, sqlText: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([PSQL, "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    cwd: ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
    stdin: new TextEncoder().encode(sqlText),
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

async function applyMigrations(db: SlipTestDb, files: string[]) {
  for (const file of files) {
    const result = await runPsql(db.name, await Bun.file(join(ROOT, "supabase", "migrations", file)).text());
    if (result.code !== 0) throw new Error(`${file}\n${result.stderr}`);
  }
}

const downScript = () => Bun.file(DOWN_SCRIPT).text();

interface Env {
  db: SlipTestDb;
  supa: AnySupabase;
  webhook: WebhookService;
  pushes: string[];
  replies: string[];
  ocrRuns: string[];
  downloads: Map<string, { failFirst?: number; failAlways?: boolean; calls: number }>;
  runTasks(): Promise<void>;
  deliver(events: unknown[], defer?: boolean): Promise<unknown>;
  finalize(quiet?: number, max?: number): Promise<number>;
}

const created: SlipTestDb[] = [];

async function makeEnv(prefix: string, migrations: string[]): Promise<Env> {
  const db = await createSlipTestDb(prefix, migrations);
  created.push(db);
  await db.query("ALTER TABLE slip_batches ADD COLUMN IF NOT EXISTS accountability_round_id uuid");
  const storage = { failUpload: new Set<string>(), uploaded: new Map<string, Uint8Array>() };
  const supa: AnySupabase = createPgSupabase(db, storage);
  const tasks: Array<() => Promise<void>> = [];
  const pushes: string[] = [];
  const replies: string[] = [];
  const ocrRuns: string[] = [];
  const downloads: Env["downloads"] = new Map();

  const webhook = new WebhookService(supa, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guidedJourneyService: noGuidedRound as any,
    evidenceIngestor: new SlipEvidenceService(supa, async (messageId: string) => {
      const plan = downloads.get(messageId) ?? { calls: 0 };
      downloads.set(messageId, plan);
      plan.calls += 1;
      if (plan.failAlways || (plan.failFirst !== undefined && plan.calls <= plan.failFirst)) {
        throw new Error("simulated LINE content 500");
      }
      return { bytes: new TextEncoder().encode(`img:${messageId}`), mimeType: "image/jpeg" };
    }),
    checkProcessor: {
      processEvidence: async (evidenceId: string) => {
        ocrRuns.push(evidenceId);
        await db.query(
          `INSERT INTO slip_checks (evidence_id, status, slip_type, transfer_amount, transaction_time)
           VALUES ('${evidenceId}', 'EXTRACTED', 'BANK_SLIP_QR', 100, '2026-10-16T12:00:00+07')
           ON CONFLICT (evidence_id) DO NOTHING`,
        );
      },
    },
    scheduleBackgroundTask: (task) => { tasks.push(task); },
    slipRetrySleep: async () => {}, // backoff is exercised via explicit makeRetryDue/recover in these suites
    replyMessage: async (_token: string, text: string) => { replies.push(text); },
    replyMessages: async (_token: string, texts: string[]) => { replies.push(...texts); },
  });

  return {
    db, supa, webhook, pushes, replies, ocrRuns, downloads,
    async runTasks() {
      while (tasks.length > 0) await tasks.shift()!();
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    deliver: (events, defer = true) => webhook.processEvents(events as any, "dest", { deferOrderedProcessing: defer }),
    finalize: (quiet = 10, max = 120) =>
      finalizeClosingSlipBatches(supa, async (_to, text) => { pushes.push(text); }, quiet, max),
  };
}

function imageEvent(source: string, n: number, ts: number) {
  return {
    type: "message", webhookEventId: `evt-${source}-${n}`, timestamp: ts, replyToken: `rt-${source}-${n}`,
    mode: "active", source: { type: "group", groupId: source, userId: "U-seller" },
    message: { type: "image", id: `m-${source}-${n}`, contentProvider: { type: "line" } },
  };
}

function textEvent(source: string, id: string, text: string, ts: number) {
  return {
    type: "message", webhookEventId: id, timestamp: ts, replyToken: `rt-${id}`, mode: "active",
    source: { type: "group", groupId: source, userId: "U-seller" },
    message: { type: "text", id: `m-${id}`, text },
  };
}

/** What the pre-migration application did: no LINE-window columns at all. */
async function openLegacyBatch(db: SlipTestDb, source: string): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name, slip_date, header_text)
     VALUES ('${source}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569',
             'น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569') RETURNING id`,
  );
  return rows[0].id;
}

async function openLedgerBatch(db: SlipTestDb, source: string, openTs: number): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name, slip_date, header_text, open_event_ts_ms)
     VALUES ('${source}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569',
             'น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569', ${openTs}) RETURNING id`,
  );
  return rows[0].id;
}

const count = async (db: SlipTestDb, table: string, where = "TRUE") =>
  Number(await db.scalar(`SELECT count(*) FROM ${table} WHERE ${where}`));
const status = (db: SlipTestDb, id: string) => db.scalar(`SELECT status FROM slip_batches WHERE id='${id}'`);
const regclass = (db: SlipTestDb, name: string) => db.scalar(`SELECT to_regclass('public.${name}')::text`);
const regproc = (db: SlipTestDb, name: string) => db.scalar(`SELECT count(*) FROM pg_proc WHERE proname='${name}' AND pronamespace='public'::regnamespace`);
const makeDue = (db: SlipTestDb, messageId: string) =>
  db.query(`UPDATE slip_image_events SET next_retry_at = now() - interval '1 second' WHERE line_message_id='${messageId}'`);

afterAll(async () => {
  for (const db of created) await db.drop().catch(() => {});
}, 60_000);

describe.skipIf(!pgAvailable)("A. NEW application on the PRE-migration schema", () => {
  test("opening a session fails explicitly (retryable, logged) and creates no batch", async () => {
    const env = await makeEnv("compat_a1", OLD_SCHEMA);
    expect(await regclass(env.db, "slip_image_events")).toBe("");

    const results = (await env.deliver([textEvent("G-a1", "evt-open", "น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569", T0)], false)) as Array<{ error?: string; retryable?: boolean }>;

    // Open commands ride the ordered queue (no usable reply token): the explicit
    // failure is the result itself - logged, retryable so LINE redelivers it once
    // the migration is applied - and the user is never told the session opened.
    expect(results).toHaveLength(1);
    expect(results[0].error).toContain("20261017100000");
    expect(results[0].retryable).toBe(true);
    expect(env.replies).toHaveLength(0);
    expect(await count(env.db, "slip_batches")).toBe(0);
  }, 120_000);

  test("images of a legacy-opened session take the explicit legacy path and the finalizer still claims it", async () => {
    const env = await makeEnv("compat_a2", OLD_SCHEMA);
    const G = "G-a2";
    const batchId = await openLegacyBatch(env.db, G);

    for (let i = 1; i <= 3; i++) await env.deliver([imageEvent(G, i, T0 + i * 1000)]);
    await env.runTasks();

    // No ledger exists: legacy attach, nothing silently dropped.
    expect(await regclass(env.db, "slip_image_events")).toBe("");
    expect(await count(env.db, "slip_evidences", `batch_id='${batchId}'`)).toBe(3);
    expect(await count(env.db, "line_webhook_event_queue", "status='processed'")).toBe(3);
    expect(env.ocrRuns).toHaveLength(3);

    // Legacy close (the new close update cannot run here, see the next test).
    await env.db.query(`UPDATE slip_batches SET status='closing', closing_at=now() WHERE id='${batchId}'`);
    expect(await env.finalize(0, 120)).toBe(1); // 4-arg claim 42883 -> 3-arg fallback
    expect(env.pushes).toHaveLength(1);
    expect(env.pushes[0]).toContain("3 รูป");
    expect(await status(env.db, batchId)).not.toBe("closing");
  }, 120_000);

  test("จบสลิป is an explicit error on a schema without close_event_ts_ms, never 'already closing'", async () => {
    const env = await makeEnv("compat_a3", OLD_SCHEMA);
    const G = "G-a3";
    const batchId = await openLegacyBatch(env.db, G);

    await env.deliver([textEvent(G, "evt-close", "จบสลิป", T0 + 5000)], false);

    expect(env.replies.join("\n")).not.toContain("กำลังสรุปสลิปอยู่"); // the ALREADY_CLOSING lie
    expect(env.replies.length).toBeGreaterThan(0); // the operator is told it failed (generic close-error reply)
    expect(await status(env.db, batchId)).toBe("collecting"); // untouched: operator can retry after migrating
  }, 120_000);
});

describe.skipIf(!pgAvailable)("B. upgrade OLD -> NEW with a closing batch in flight", () => {
  test("legacy-attached images and a queued image are all accounted for after the migration is applied", async () => {
    const env = await makeEnv("compat_b1", OLD_SCHEMA);
    const G = "G-b1";
    const batchId = await openLegacyBatch(env.db, G);

    // Real wall-clock LINE times: the claim reconciles by window [created_at-15s, closing_at].
    await env.deliver([imageEvent(G, 1, Date.now())]);
    await env.runTasks();
    await env.deliver([imageEvent(G, 2, Date.now())]);
    await env.runTasks();
    await env.deliver([imageEvent(G, 3, Date.now())]); // queued, worker has not run yet
    expect(await count(env.db, "line_webhook_event_queue", "status='pending'")).toBe(1);
    expect(await count(env.db, "slip_evidences", `batch_id='${batchId}'`)).toBe(2);

    await env.db.query(`UPDATE slip_batches SET status='closing', closing_at=now() WHERE id='${batchId}'`);

    // ---- deploy: apply the migration while the batch is closing ----
    await applyMigrations(env.db, LEDGER_MIGRATIONS);
    expect(await regclass(env.db, "slip_image_events")).toBe("slip_image_events");

    // The finalizer must see the still-queued image and wait for it.
    expect(await env.finalize(0, 120)).toBe(0);
    expect(env.pushes).toHaveLength(0);
    const rows = await env.db.query<{ line_message_id: string; state: string }>(
      `SELECT line_message_id, state FROM slip_image_events WHERE batch_id='${batchId}' ORDER BY line_message_id`,
    );
    expect(rows.map((r) => r.state)).toEqual(["attached", "attached", "received"]);

    // The queued image is now ingested by the new code through the ledger.
    await env.webhook.recoverSlipIngest();
    await env.runTasks();
    expect(await count(env.db, "slip_evidences", `batch_id='${batchId}'`)).toBe(3);

    expect(await env.finalize(0, 120)).toBe(1);
    expect(env.pushes).toHaveLength(1);
    expect(env.pushes[0]).toContain("3 รูป");
    expect(env.pushes[0]).not.toContain("ยอดนี้ยังไม่ครบ");
  }, 180_000);
});

describe.skipIf(!pgAvailable)("C. OLD application on the NEW schema", () => {
  test("images the old app attached through the legacy path do not stall the closing claim", async () => {
    const env = await makeEnv("compat_c1", SLIP_PIPELINE_MIGRATIONS);
    const G = "G-c1";
    // The old app opens sessions without the LINE-window columns.
    const batchId = await openLegacyBatch(env.db, G);

    // Receipt creates ledger rows through the queue trigger (the old app cannot avoid it).
    for (let i = 1; i <= 2; i++) await env.deliver([imageEvent(G, i, Date.now())]);
    expect(await count(env.db, "slip_image_events")).toBe(2);

    // The old worker: download, store, attach through attach_evidence_to_slip_batch. Never the ledger.
    for (let i = 1; i <= 2; i++) {
      const msg = `m-${G}-${i}`;
      const ev = await env.db.scalar(
        `INSERT INTO slip_evidences (raw_message_id, line_message_id, source_id, source_type, line_user_id,
                                     storage_bucket, storage_path, mime_type, byte_size, sha256, status)
         SELECT r.id, r.message_id, '${G}', 'group', 'U-seller', 'slip-evidence', 'slips/${msg}.jpg',
                'image/jpeg', 3, md5('${msg}') || md5('${msg}x'), 'RECEIVED'
           FROM raw_messages r WHERE r.message_id='${msg}' RETURNING id`,
      );
      await env.db.query(`SELECT attach_evidence_to_slip_batch('${batchId}', '${ev}')`);
      await env.db.query(
        `INSERT INTO slip_checks (evidence_id, status, slip_type, transfer_amount, transaction_time)
         VALUES ('${ev}', 'EXTRACTED', 'BANK_SLIP_QR', 100, '2026-10-16T12:00:00+07')`,
      );
      await env.db.query(`UPDATE raw_messages SET is_processed = true WHERE message_id='${msg}'`);
    }
    await env.db.query(`UPDATE line_webhook_event_queue SET status='processed' WHERE source_id='${G}'`);
    await env.db.query(`UPDATE slip_batches SET status='closing', closing_at=now() WHERE id='${batchId}'`);

    // The old finalizer calls the claim with three arguments.
    const claim = await env.supa.rpc("claim_closing_slip_batch", {
      p_batch_id: batchId, p_quiet_seconds: 0, p_max_seconds: 120,
    });
    expect(claim.error).toBeNull();
    expect(claim.data).toHaveLength(1); // not "wait for the 600 s ingest bound"
    expect(await status(env.db, batchId)).toBe("processing");
  }, 120_000);
});

describe.skipIf(!pgAvailable)("D. rollback protocol", () => {
  async function inFlightEnv(prefix: string, failAlways: boolean) {
    const env = await makeEnv(prefix, SLIP_PIPELINE_MIGRATIONS);
    const G = `G-${prefix}`;
    const batchId = await openLedgerBatch(env.db, G, T0);
    env.downloads.set(`m-${G}-3`, failAlways ? { failAlways: true, calls: 0 } : { failFirst: 1, calls: 0 });
    for (let i = 1; i <= 3; i++) await env.deliver([imageEvent(G, i, T0 + i * 1000)]);
    await env.runTasks();
    return { env, G, batchId };
  }

  test("refuses while an image of an open batch is still in flight, and changes nothing", async () => {
    const { env, G, batchId } = await inFlightEnv("compat_d1", false);
    const state = await env.db.scalar(`SELECT state FROM slip_image_events WHERE line_message_id='m-${G}-3'`);
    expect(state).toBe("retry_pending");
    await env.db.query(`UPDATE slip_batches SET status='closing', closing_at=now(), close_event_ts_ms=${T0 + 10_000} WHERE id='${batchId}'`);

    const result = await runPsql(env.db.name, await downScript());
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("slip rollback refused");
    expect(result.stderr).toContain("1 in-flight");

    // Single transaction: nothing was dropped.
    expect(await regproc(env.db, "begin_slip_image_attempt")).toBe("1");
    expect(await count(env.db, "pg_trigger", "tgname='trg_capture_slip_image_event'")).toBe(1);
    expect(await regclass(env.db, "slip_image_events_rollback_audit")).toBe("");
  }, 180_000);

  test("after draining, rollback leaves the legacy path able to finish the in-flight batch with no data loss", async () => {
    const { env, G, batchId } = await inFlightEnv("compat_d2", false);
    await env.db.query(`UPDATE slip_batches SET status='closing', closing_at=now(), close_event_ts_ms=${T0 + 10_000} WHERE id='${batchId}'`);
    expect(await env.finalize(0, 120)).toBe(0); // image 3 still owed a retry

    // Drain: the cron retry succeeds and the image joins the batch.
    await makeDue(env.db, `m-${G}-3`);
    await env.webhook.recoverSlipIngest();
    await env.runTasks();
    expect(await count(env.db, "slip_image_events", "state='attached'")).toBe(3);

    const down = await runPsql(env.db.name, await downScript());
    expect(down.stderr + down.stdout).not.toContain("ERROR");
    expect(down.code).toBe(0);
    expect(await env.db.scalar("SELECT has_table_privilege('anon', 'slip_batches_rollback_audit', 'SELECT')")).toBe("false");
    expect(await env.db.scalar("SELECT relrowsecurity FROM pg_class WHERE oid='slip_batches_rollback_audit'::regclass")).toBe("true");

    // Ledger audit data kept; every ledger entry point gone; columns kept.
    expect(await count(env.db, "slip_image_events")).toBe(3);
    expect(await count(env.db, "slip_image_events", "state='attached'")).toBe(3);
    for (const fn of ["begin_slip_image_attempt", "attach_slip_image_event", "fail_slip_image_event",
      "slip_batch_image_accounting", "capture_slip_image_event", "bind_unbound_slip_image_events"]) {
      expect(await regproc(env.db, fn)).toBe("0");
    }
    expect(await count(env.db, "pg_trigger", "tgname IN ('trg_capture_slip_image_event','trg_bind_unbound_slip_image_events')")).toBe(0);
    // Pre-migration shape restored; the per-batch LINE times are archived, not lost.
    expect(await count(env.db, "information_schema.columns",
      "table_name='slip_batches' AND column_name IN ('open_event_ts_ms','close_event_ts_ms')")).toBe(0);
    expect(await env.db.scalar(
      `SELECT close_event_ts_ms FROM slip_batches_rollback_audit WHERE batch_id='${batchId}'`,
    )).toBe(String(T0 + 10_000));
    // Exactly the 3-argument claim remains.
    const claimSigs = await env.db.query<{ n: number }>(
      `SELECT pronargs AS n FROM pg_proc WHERE proname='claim_closing_slip_batch' AND pronamespace='public'::regnamespace`,
    );
    expect(claimSigs.map((r) => Number(r.n))).toEqual([3]);

    // Old path: finalization works (new finalizer falls back to the 3-argument claim).
    expect(await env.finalize(0, 120)).toBe(1);
    expect(env.pushes).toHaveLength(1);
    expect(env.pushes[0]).toContain("3 รูป");
    expect(await count(env.db, "slip_evidences", `batch_id='${batchId}'`)).toBe(3);

    // New queue receipts no longer touch the ledger.
    await env.deliver([imageEvent(G, 9, T0 + 50_000)]);
    expect(await count(env.db, "slip_image_events")).toBe(3);

    // Re-running the script is a no-op, not an error.
    const again = await runPsql(env.db.name, await downScript());
    expect(again.code).toBe(0);
  }, 240_000);

  test("operator override records the in-flight image instead of losing it silently", async () => {
    const { env, G, batchId } = await inFlightEnv("compat_d3", true);
    await env.db.query(`UPDATE slip_batches SET status='closing', closing_at=now(), close_event_ts_ms=${T0 + 10_000} WHERE id='${batchId}'`);

    const forced = await runPsql(
      env.db.name,
      `SET slip_rollback.allow_inflight = 'on';\n${await downScript()}`,
    );
    expect(forced.code).toBe(0);
    expect(await env.db.scalar("SELECT has_table_privilege('authenticated', 'slip_image_events_rollback_audit', 'SELECT')")).toBe("false");
    expect(await env.db.scalar("SELECT relrowsecurity FROM pg_class WHERE oid='slip_image_events_rollback_audit'::regclass")).toBe("true");
    expect(forced.stderr).toContain("recorded in public.slip_image_events_rollback_audit");

    const audit = await env.db.query<{ line_message_id: string; state: string }>(
      "SELECT line_message_id, state FROM slip_image_events_rollback_audit",
    );
    expect(audit).toEqual([{ line_message_id: `m-${G}-3`, state: "retry_pending" }]);

    // The legacy path finishes with the two attached images; the missing one is identifiable from the audit.
    expect(await env.finalize(0, 120)).toBe(1);
    expect(env.pushes[0]).toContain("2 รูป");
    expect(await count(env.db, "slip_evidences", `batch_id='${batchId}'`)).toBe(2);
  }, 180_000);
});

describe.skipIf(!pgAvailable)("E. service_role closing-claim privileges", () => {
  test("service_role executes the complete migrated closing claim, but client roles cannot call its helper", async () => {
    const env = await makeEnv("compat_e1_role", SLIP_PIPELINE_MIGRATIONS);
    const G = "G-privilege-check";
    const batchId = await openLedgerBatch(env.db, G, T0);

    // Exercise the real receipt trigger and claim's timestamp reconciliation,
    // not only an ACL query or a claim against an empty batch.
    await env.deliver([imageEvent(G, 1, T0 + 1000)]);
    await env.runTasks();
    expect(await count(env.db, "slip_evidences", `batch_id='${batchId}'`)).toBe(1);
    await env.db.query(
      `UPDATE slip_batches SET status='closing',
         closing_at=now()-interval '60 seconds',
         last_image_at=now()-interval '60 seconds',
         close_event_ts_ms=${T0 + 5000}
       WHERE id='${batchId}'`,
    );

    // Only this disposable test DB: mirror Supabase backend table access.
    // Do not change shared cluster roles or Production privileges.
    await env.db.query("GRANT USAGE ON SCHEMA public TO service_role");
    await env.db.query("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role");
    await env.db.query(`DO $$
      DECLARE r record;
      BEGIN
        FOR r IN SELECT relname FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relrowsecurity
        LOOP
          EXECUTE format(
            'CREATE POLICY compat_e1_service_access ON public.%I TO service_role USING (true) WITH CHECK (true)',
            r.relname
          );
        END LOOP;
      END $$`);

    const rows = await env.db.sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE service_role");
      return await tx.unsafe(
        `SELECT * FROM public.claim_closing_slip_batch('${batchId}', 10, 120, 2160)`,
      );
    });

    expect(rows).toHaveLength(1);
    expect(await status(env.db, batchId)).toBe("processing");
    expect(await env.db.scalar(
      "SELECT has_function_privilege('service_role', 'public.slip_image_event_ts(jsonb,timestamptz)', 'EXECUTE')",
    )).toBe("true");
    for (const client of ["anon", "authenticated"]) {
      expect(await env.db.scalar(
        `SELECT has_function_privilege('${client}', 'public.slip_image_event_ts(jsonb,timestamptz)', 'EXECUTE')`,
      )).toBe("false");
    }
  }, 120_000);
});
