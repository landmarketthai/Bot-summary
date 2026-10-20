/**
 * Full rollback sequence, end to end, on ONE disposable PostgreSQL 17 database
 * holding all three PR #182 migrations. Order under test (release gate §3):
 *
 *   0. forward state: ledger live, alert active (fake LINE push), a batch with
 *      one permanently failed image has paged once
 *   1. disable the alert flag      -> no read, no claim, no send
 *   2. alert down migration        -> alert surface gone, ledger untouched;
 *                                     a mistakenly re-enabled flag fails closed
 *   3. drain the ledger            -> ledger down REFUSED while an image of an
 *                                     open batch is in flight; then drained
 *   4. ledger down migration       -> pre-migration shape, audit data kept,
 *                                     finalized batches byte-identical
 *   5. legacy path resumes         -> new session, images, close, one summary
 *   6. both down scripts re-run    -> no-op
 *
 * The application cannot be swapped for the pre-PR binary inside a test, so
 * step 5 uses the current code on the rolled-back schema: images take the
 * explicit legacy path (ledger functions absent) and the finalizer takes the
 * 3-argument claim. A session is opened the way the pre-migration app did.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/full-rollback-sequence.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { WebhookService } from "@/lib/line/webhook-service";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";
import { handleSlipLedgerAlert } from "@/app/api/cron/slip-ledger-alert/handler";
import {
  PGHOST, PGPASSWORD, PGPORT, PGUSER, ROOT,
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
const ALERT_DOWN = join(ROOT, "supabase", "rollback", "20261019120000_slip_ingest_health_alert.down.sql");
const LEDGER_DOWN = join(ROOT, "supabase", "rollback", "20261017100000_slip_image_ingestion_ledger.down.sql");
const ALERT_TARGET = `C${"a".repeat(32)}`;
const T0 = 1_760_000_000_000;

async function runPsql(database: string, sqlText: string) {
  const proc = Bun.spawn([PSQL, "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    cwd: ROOT,
    env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: database },
    stdin: new TextEncoder().encode(sqlText),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { code, stdout, stderr };
}

const imageEvent = (g: string, n: number, ts: number) => ({
  type: "message", webhookEventId: `evt-${g}-${n}`, timestamp: ts, replyToken: `rt-${g}-${n}`,
  mode: "active", source: { type: "group", groupId: g, userId: "U-seller" },
  message: { type: "image", id: `m-${g}-${n}`, contentProvider: { type: "line" } },
});

describe.skipIf(!pgAvailable)("full rollback sequence: alert off -> alert down -> drain -> ledger down -> legacy", () => {
  let db: SlipTestDb;
  let supa: AnySupabase;
  let webhook: WebhookService;
  const tasks: Array<() => Promise<void>> = [];
  const summaries: string[] = [];
  const alertPushes: string[] = [];
  const downloads = new Map<string, { failAlways?: boolean; failFirst?: number; calls: number }>();
  const savedEnv: Record<string, string | undefined> = {};
  let firstBatch = "";
  let finalizedSnapshot = "";

  const runTasks = async () => { while (tasks.length) await tasks.shift()!(); };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deliver = (events: unknown[]) => webhook.processEvents(events as any, "dest", { deferOrderedProcessing: true });
  const finalize = () => finalizeClosingSlipBatches(supa, async (_to, text) => { summaries.push(text); }, 0, 120);
  const count = async (table: string, where = "TRUE") => Number(await db.scalar(`SELECT count(*) FROM ${table} WHERE ${where}`));
  const fnCount = (name: string) => db.scalar(`SELECT count(*) FROM pg_proc WHERE proname='${name}' AND pronamespace='public'::regnamespace`);
  const alert = async () => {
    const res = await handleSlipLedgerAlert(
      new NextRequest("http://localhost/api/cron/slip-ledger-alert", { headers: { authorization: "Bearer rollback-cron" } }),
      { getClient: () => supa, push: async (_t, text) => { alertPushes.push(text); return { status: "delivered" }; } },
    );
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const openLedgerBatch = async (g: string, openTs: number) => (await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name, slip_date, header_text, open_event_ts_ms)
     VALUES ('${g}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569', 'น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569', ${openTs})
     RETURNING id`))[0].id;
  const close = (id: string, ts: number) =>
    db.query(`UPDATE slip_batches SET status='closing', closing_at=now() - interval '30 seconds', close_event_ts_ms=${ts} WHERE id='${id}'`);
  const snapshot = (id: string) => db.scalar(
    `SELECT jsonb_build_object(
       'batch', (SELECT to_jsonb(b) - 'updated_at' - 'open_event_ts_ms' - 'close_event_ts_ms' FROM slip_batches b WHERE id='${id}'),
       'evidences', (SELECT jsonb_agg(to_jsonb(e) - 'updated_at' ORDER BY e.batch_index) FROM slip_evidences e WHERE batch_id='${id}'),
       'checks', (SELECT jsonb_agg(to_jsonb(c) - 'updated_at' ORDER BY c.evidence_id) FROM slip_checks c JOIN slip_evidences e ON e.id=c.evidence_id WHERE e.batch_id='${id}'))`,
  );

  beforeAll(async () => {
    for (const k of ["CRON_SECRET", "SLIP_LEDGER_ALERT_ENABLED", "SLIP_LEDGER_ALERT_LINE_TARGET", "LINE_CHANNEL_ACCESS_TOKEN"]) savedEnv[k] = process.env[k];
    process.env.CRON_SECRET = "rollback-cron";
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "fake-test-token";
    db = await createSlipTestDb("slip_full_rollback");
    await db.query("ALTER TABLE slip_batches ADD COLUMN IF NOT EXISTS accountability_round_id uuid");
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
    webhook = new WebhookService(supa, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      guidedJourneyService: { resolve: async () => ({ stage: "idle", reason: "no_session" }), findRoundOwner: async () => ({ kind: "none" }) } as any,
      evidenceIngestor: new SlipEvidenceService(supa, async (id: string) => {
        const plan = downloads.get(id) ?? { calls: 0 };
        downloads.set(id, plan);
        plan.calls += 1;
        if (plan.failAlways || (plan.failFirst !== undefined && plan.calls <= plan.failFirst)) throw new Error("simulated LINE content 500");
        return { bytes: new TextEncoder().encode(`img:${id}`), mimeType: "image/jpeg" };
      }),
      checkProcessor: {
        processEvidence: async (evidenceId: string) => {
          await db.query(`INSERT INTO slip_checks (evidence_id, status, slip_type, transfer_amount, transaction_time, reference_id)
            VALUES ('${evidenceId}', 'EXTRACTED', 'BANK_SLIP_QR', 100, '2026-10-16T12:00:00+07', 'REF-${evidenceId}') ON CONFLICT (evidence_id) DO NOTHING`);
        },
      },
      scheduleBackgroundTask: (task) => { tasks.push(task); },
      slipRetrySleep: async () => {},
      replyMessage: async () => {},
      replyMessages: async () => {},
    });
  }, 180_000);

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (db) await db.drop();
  }, 60_000);

  test("0. forward state: one batch finalized incomplete, the permanent loss paged exactly once", async () => {
    const G = "G-rb-1";
    firstBatch = await openLedgerBatch(G, T0);
    downloads.set(`m-${G}-2`, { failAlways: true, calls: 0 });
    for (let i = 1; i <= 3; i++) await deliver([imageEvent(G, i, T0 + i * 1000)]);
    await runTasks();
    for (let i = 0; i < 6; i++) {
      await db.query(`UPDATE slip_image_events SET next_retry_at = now() - interval '1 second' WHERE line_message_id='m-${G}-2'`);
      await webhook.recoverSlipIngest();
      await runTasks();
    }
    expect(await db.scalar(`SELECT state FROM slip_image_events WHERE line_message_id='m-${G}-2'`)).toBe("failed_permanent");
    await close(firstBatch, T0 + 10_000);
    await db.query(`UPDATE slip_batches SET last_image_at = now() - interval '30 seconds' WHERE id='${firstBatch}'`);
    expect(await finalize()).toBe(1);
    expect(summaries[0]).toContain("ยังไม่ครบ: 1 รูป");
    expect(await db.scalar(`SELECT status FROM slip_batches WHERE id='${firstBatch}'`)).toBe("review_needed");
    finalizedSnapshot = await snapshot(firstBatch);

    process.env.SLIP_LEDGER_ALERT_ENABLED = "true";
    process.env.SLIP_LEDGER_ALERT_LINE_TARGET = ALERT_TARGET;
    const paged = await alert();
    expect(paged.status).toBe(200);
    expect(alertPushes).toHaveLength(1);
    const again = await alert();
    expect(again.status).toBe(200);
    expect(alertPushes).toHaveLength(1); // durable de-duplication
  }, 240_000);

  test("1. disable the alert flag first: no SQL read, no claim, no send", async () => {
    const before = await db.scalar("SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY recipient_key), '[]') FROM slip_ingest_alert_states s");
    delete process.env.SLIP_LEDGER_ALERT_ENABLED;
    const res = await alert();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "disabled", sent: false });
    expect(alertPushes).toHaveLength(1);
    expect(await db.scalar("SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY recipient_key), '[]') FROM slip_ingest_alert_states s")).toBe(before);
  }, 60_000);

  test("2. alert down migration: alert surface gone, ledger intact, a re-enabled flag fails closed", async () => {
    const down = await runPsql(db.name, await Bun.file(ALERT_DOWN).text());
    expect(down.code, down.stderr).toBe(0);
    expect(await db.scalar("SELECT to_regclass('public.slip_ingest_alert_states') IS NULL")).toBe("true");
    for (const fn of ["claim_slip_ingest_health_alert", "complete_slip_ingest_health_alert", "slip_ingest_alert_health"]) {
      expect(await fnCount(fn)).toBe("0");
    }
    expect(await fnCount("begin_slip_image_attempt")).toBe("1");
    expect(await count("pg_trigger", "tgname='trg_capture_slip_image_event'")).toBe(1);

    process.env.SLIP_LEDGER_ALERT_ENABLED = "true"; // operator mistake
    const res = await alert();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ sent: false });
    expect(alertPushes).toHaveLength(1);
    delete process.env.SLIP_LEDGER_ALERT_ENABLED;
  }, 60_000);

  test("3. ledger down is refused while an image of an open batch is in flight, then drained", async () => {
    const G = "G-rb-2";
    const batch = await openLedgerBatch(G, T0 + 100_000);
    downloads.set(`m-${G}-2`, { failFirst: 1, calls: 0 });
    for (let i = 1; i <= 2; i++) await deliver([imageEvent(G, i, T0 + 100_000 + i * 1000)]);
    await runTasks();
    expect(await db.scalar(`SELECT state FROM slip_image_events WHERE line_message_id='m-${G}-2'`)).toBe("retry_pending");

    const refused = await runPsql(db.name, await Bun.file(LEDGER_DOWN).text());
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("slip rollback refused");
    expect(await fnCount("begin_slip_image_attempt")).toBe("1"); // single transaction: nothing dropped

    await db.query(`UPDATE slip_image_events SET next_retry_at = now() - interval '1 second' WHERE line_message_id='m-${G}-2'`);
    await webhook.recoverSlipIngest();
    await runTasks();
    expect(await count("slip_image_events", `batch_id='${batch}' AND state='attached'`)).toBe(2);
    await close(batch, T0 + 110_000);
    await db.query(`UPDATE slip_batches SET last_image_at = now() - interval '30 seconds' WHERE id='${batch}'`);
    expect(await finalize()).toBe(1);
    expect(summaries.at(-1)).not.toContain("ยังไม่ครบ");
    expect(await db.scalar(`SELECT status FROM slip_batches WHERE id='${batch}'`)).toBe("completed");
  }, 240_000);

  test("4. ledger down: pre-migration shape, ledger audit kept, finalized money untouched", async () => {
    const ledgerRows = await count("slip_image_events");
    const down = await runPsql(db.name, await Bun.file(LEDGER_DOWN).text());
    expect(down.code, down.stderr).toBe(0);

    for (const fn of ["begin_slip_image_attempt", "attach_slip_image_event", "fail_slip_image_event",
      "slip_batch_image_accounting", "capture_slip_image_event", "bind_unbound_slip_image_events", "receive_line_webhook_payload"]) {
      expect(await fnCount(fn)).toBe("0");
    }
    expect(await count("pg_trigger", "tgname IN ('trg_capture_slip_image_event','trg_bind_unbound_slip_image_events')")).toBe(0);
    expect(await count("information_schema.columns",
      "table_name='slip_batches' AND column_name IN ('open_event_ts_ms','close_event_ts_ms')")).toBe(0);
    const claimArgs = await db.query<{ n: number }>(
      "SELECT pronargs AS n FROM pg_proc WHERE proname='claim_closing_slip_batch' AND pronamespace='public'::regnamespace");
    expect(claimArgs.map((r) => Number(r.n))).toEqual([3]);
    expect(await count("slip_image_events")).toBe(ledgerRows); // audit kept
    expect(await count("slip_batches_rollback_audit")).toBeGreaterThanOrEqual(2);
    expect(await fnCount("claim_slip_check")).toBe("1"); // OCR fencing stays (no mixed workers)
    expect(await snapshot(firstBatch)).toBe(finalizedSnapshot);
  }, 120_000);

  test("5. legacy path resumes: new session, images, close, exactly one complete summary", async () => {
    const G = "G-rb-3";
    const before = summaries.length;
    const batch = (await db.query<{ id: string }>(
      `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name, slip_date, header_text)
       VALUES ('${G}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569', 'น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569') RETURNING id`))[0].id;
    for (let i = 1; i <= 3; i++) await deliver([imageEvent(G, i, T0 + 200_000 + i * 1000)]);
    await runTasks();
    expect(await count("slip_evidences", `batch_id='${batch}'`)).toBe(3);
    expect(await count("slip_image_events", `source_id='${G}'`)).toBe(0); // no ledger writes after rollback

    await db.query(`UPDATE slip_batches SET status='closing', closing_at=now() - interval '30 seconds', last_image_at=now() - interval '30 seconds' WHERE id='${batch}'`);
    expect(await finalize()).toBe(1);
    expect(summaries).toHaveLength(before + 1);
    expect(summaries.at(-1)).toContain("รับทั้งหมด: 3 รูป");
    expect(await finalize()).toBe(0); // no duplicate summary
    expect(summaries).toHaveLength(before + 1);
  }, 120_000);

  test("6. re-running both down scripts is a no-op", async () => {
    for (const file of [ALERT_DOWN, LEDGER_DOWN]) {
      const again = await runPsql(db.name, await Bun.file(file).text());
      expect(again.code, again.stderr).toBe(0);
    }
    expect(await snapshot(firstBatch)).toBe(finalizedSnapshot);
  }, 60_000);
});
