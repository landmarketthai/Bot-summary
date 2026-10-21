/**
 * P0 — slip image ingestion reliability, proven on real PostgreSQL 17.
 *
 * Production TypeScript (WebhookService, SlipImageIngestionService,
 * SlipEvidenceService, the batch finalizer) runs against the real migrations
 * through a PostgREST-style adapter. Only the LINE download, Storage and OCR
 * provider are simulated. Every assertion reads durable database state.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/image-ingestion.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { WebhookService } from "@/lib/line/webhook-service";
import { bangkokBusinessDateFromTimestamp } from "@/lib/business-date";
import { SlipEvidenceService, buildSlipEvidencePath } from "@/lib/slips/evidence-service";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";
import { DEFAULT_INGEST_MAX_SECONDS } from "@/lib/slips/ingest-policy";
import {
  createPgSupabase,
  createSlipTestDb,
  probePg,
  type FakeStorage,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;

let db: SlipTestDb;
let storage: FakeStorage;
let supa: AnySupabase;

interface DownloadPlan { failFirst?: number; failAlways?: boolean; calls: number }
let downloadPlan: Map<string, DownloadPlan>;
let ocrRuns: string[];
let replies: string[];
let backgroundTasks: Array<() => Promise<void>>;

const T0 = 1_760_000_000_000; // fixed LINE-time origin (ms)

async function download(messageId: string) {
  const plan = downloadPlan.get(messageId) ?? { calls: 0 };
  downloadPlan.set(messageId, plan);
  plan.calls += 1;
  if (plan.failAlways || (plan.failFirst !== undefined && plan.calls <= plan.failFirst)) {
    throw new Error("simulated LINE content 500");
  }
  return { bytes: new TextEncoder().encode(`img:${messageId}`), mimeType: "image/jpeg" };
}

// The guided-menu tables are outside this harness; no guided round owns the open.
const noGuidedRound = {
  resolve: async () => ({ stage: "idle", reason: "no_session" }),
  findRoundOwner: async () => ({ kind: "none" as const }),
};

function makeWebhook(client: AnySupabase = supa): WebhookService {
  return new WebhookService(client, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guidedJourneyService: noGuidedRound as any,
    evidenceIngestor: new SlipEvidenceService(supa, download),
    checkProcessor: {
      // Simulated OCR provider: one read slip of 100 THB per evidence.
      processEvidence: async (evidenceId: string) => {
        ocrRuns.push(evidenceId);
        await db.query(
          `INSERT INTO slip_checks (evidence_id, status, slip_type, transfer_amount, transaction_time)
           VALUES ('${evidenceId}', 'EXTRACTED', 'BANK_SLIP_QR', 100, '2026-10-16T12:00:00+07')
           ON CONFLICT (evidence_id) DO NOTHING`,
        );
      },
    },
    scheduleBackgroundTask: (task) => { backgroundTasks.push(task); },
    slipRetrySleep: async () => {}, // backoff is exercised via explicit makeRetryDue/recover in these suites
    replyMessage: async (_token: string, text: string) => { replies.push(text); },
  });
}

function imageEvent(source: string, n: string | number, ts: number, id = `evt-${source}-${n}`) {
  return {
    type: "message",
    webhookEventId: id,
    timestamp: ts,
    replyToken: `rt-${id}`,
    mode: "active",
    source: { type: "group", groupId: source, userId: "U-seller" },
    message: { type: "image", id: `m-${source}-${n}`, contentProvider: { type: "line" } },
  };
}

function textEvent(source: string, id: string, text: string, ts: number) {
  return {
    type: "message",
    webhookEventId: id,
    timestamp: ts,
    replyToken: `rt-${id}`,
    mode: "active",
    source: { type: "group", groupId: source, userId: "U-seller" },
    message: { type: "text", id: `m-${id}`, text },
  };
}

async function openBatch(source: string, openTs = T0): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name,
                               slip_date, header_text, open_event_ts_ms)
     VALUES ('${source}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569',
             'น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569', ${openTs}) RETURNING id`,
  );
  return rows[0].id;
}

async function closeBatchSql(batchId: string, closeTs: number): Promise<void> {
  await db.query(
    `UPDATE slip_batches SET status='closing', closing_at=now(), close_event_ts_ms=${closeTs} WHERE id='${batchId}'`,
  );
}

async function backdate(batchId: string, seconds: number): Promise<void> {
  await db.query(
    `UPDATE slip_batches SET closing_at = closing_at - interval '${seconds} seconds',
            last_image_at = last_image_at - interval '${seconds} seconds' WHERE id='${batchId}'`,
  );
}

async function runTasks(): Promise<void> {
  while (backgroundTasks.length > 0) {
    const task = backgroundTasks.shift()!;
    await task();
  }
}

async function deliver(service: WebhookService, events: unknown[], defer = true) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return service.processEvents(events as any, "dest", { deferOrderedProcessing: defer });
}

interface LedgerRow { line_message_id: string; state: string; attempts: number; evidence_id: string | null; batch_id: string | null }
const ledger = (batchId?: string) => db.query<LedgerRow>(
  `SELECT line_message_id, state, attempts, evidence_id, batch_id FROM slip_image_events
   ${batchId ? `WHERE batch_id='${batchId}'` : ""} ORDER BY event_ts_ms, line_message_id`,
);
const j = async <T>(sql: string) => JSON.parse(await db.scalar(sql)) as T;
const leaseOf = () => db.scalar("SELECT lease_until FROM slip_image_events");
const count = async (table: string, where = "TRUE") =>
  Number(await db.scalar(`SELECT count(*) FROM ${table} WHERE ${where}`));
const batchRow = async (id: string) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM slip_batches WHERE id='${id}'`))[0];

async function finalizeNow(pushes: string[], quiet = 10, max = 120) {
  return finalizeClosingSlipBatches(supa, async (_to, text) => { pushes.push(text); }, quiet, max);
}

async function makeRetryDue(lineMessageId: string) {
  await db.query(
    `UPDATE slip_image_events SET next_retry_at = now() - interval '1 second' WHERE line_message_id='${lineMessageId}'`,
  );
}

describe.skipIf(!pgAvailable)("P0 slip image ingestion on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_ingest");
    // The real openSession writes this existing production column; the minimal
    // slip-only PG fixture predates the accountability-round migration.
    await db.query("ALTER TABLE slip_batches ADD COLUMN IF NOT EXISTS accountability_round_id uuid");
  }, 120_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  beforeEach(async () => {
    await db.query(
      `TRUNCATE slip_image_events, slip_checks, slip_evidences, slip_batches,
                line_webhook_event_queue, raw_messages CASCADE`,
    );
    storage = { failUpload: new Set(), uploaded: new Map() };
    supa = createPgSupabase(db, storage);
    downloadPlan = new Map();
    ocrRuns = [];
    replies = [];
    backgroundTasks = [];
  });

  // ── 1,2,5,6,9,11,14: the production incident, end to end ────────────────────
  test("25-image burst: delayed workers + close + permanently failing 6th image", async () => {
    const G = "G-incident";
    const batchId = await openBatch(G);
    downloadPlan.set(`m-${G}-6`, { failAlways: true, calls: 0 });
    const webhook = makeWebhook();

    // 25 images received (durable) — workers have NOT run yet.
    const events = Array.from({ length: 25 }, (_, i) => imageEvent(G, i + 1, T0 + 1000 * (i + 1)));
    for (const e of events) await deliver(webhook, [e]);

    expect(await count("raw_messages", "message_type = 'image'")).toBe(25);
    expect(await count("line_webhook_event_queue", "status = 'pending'")).toBe(25);
    const received = await ledger(batchId);
    expect(received).toHaveLength(25);
    expect(received.every((r) => r.state === "received")).toBe(true);
    expect(await count("slip_evidences")).toBe(0);

    // Seller types จบสลิป while all 25 are still pending (close is not queued).
    await closeBatchSql(batchId, T0 + 26_000);

    // Workers are slower than the quiet period AND the 120s OCR cap.
    await backdate(batchId, 200);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(0); // BEFORE the fix: finalized with 0 images
    expect(pushes).toHaveLength(0);
    expect((await batchRow(batchId)).status).toBe("closing");

    // Workers run. Image 6 fails, the other 24 must not be blocked behind it.
    await runTasks();
    expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(25);
    const afterDrain = await ledger(batchId);
    expect(afterDrain.filter((r) => r.state === "attached")).toHaveLength(24);
    const sixth = afterDrain.find((r) => r.line_message_id === `m-${G}-6`)!;
    expect(sixth.state).toBe("retry_pending");
    expect(sixth.attempts).toBe(1);
    expect(sixth.evidence_id).toBeNull();

    // A failed image is never reported as ingested.
    expect(await count("slip_evidences", `line_message_id='m-${G}-6' AND status='DOWNLOAD_FAILED' AND batch_id IS NULL`)).toBe(1);
    expect(await count("raw_messages", `message_id='m-${G}-6' AND is_processed = true`)).toBe(0);
    expect(await count("raw_messages", "message_type='image' AND is_processed = true")).toBe(24);
    const idx = (await db.query<{ batch_index: number }>(
      `SELECT batch_index FROM slip_evidences WHERE batch_id='${batchId}' ORDER BY batch_index`,
    )).map((r) => r.batch_index);
    expect(idx).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect((await batchRow(batchId)).image_count).toBe(24);

    // OCR ran exactly once per attached evidence.
    await runTasks();
    expect(ocrRuns).toHaveLength(24);

    // Still not finalizable: image 6 is waiting on a scheduled retry.
    expect(await finalizeNow(pushes)).toBe(0);

    // Bounded retries: exactly 5 attempts, then explicit permanent failure.
    for (let attempt = 2; attempt <= 6; attempt++) {
      await makeRetryDue(`m-${G}-6`);
      await webhook.recoverSlipIngest();
    }
    const failed = (await ledger(batchId)).find((r) => r.line_message_id === `m-${G}-6`)!;
    expect(failed.state).toBe("failed_permanent");
    expect(failed.attempts).toBe(5);
    expect(downloadPlan.get(`m-${G}-6`)!.calls).toBe(5); // no retry storm past the budget
    await runTasks();

    // Now fully accounted for: 24 attached + 1 permanently failed. The quiet
    // period restarts at the last attach, so let it elapse.
    await backdate(batchId, 30);
    expect(await finalizeNow(pushes)).toBe(1);
    expect(pushes).toHaveLength(1);
    const summary = pushes[0];
    expect(summary).toContain("รับรูปจาก LINE: 25 รูป");
    expect(summary).toContain("เข้าชุดแล้ว: 24 รูป");
    expect(summary).toContain("ยังไม่ครบ: 1 รูป");
    expect(summary).toContain("ยอดนี้ยังไม่ครบ");
    expect(summary).toContain("2,400"); // 24 x 100 — nothing guessed for the 25th
    expect(summary).not.toContain("2,500");

    const final = await batchRow(batchId);
    expect(final.status).toBe("review_needed"); // never "completed" with a missing image
    expect(final.success_count).toBe(24);
    expect(final.failed_count).toBe(1);
    expect(final.summary_sent_at).not.toBeNull();

    // No duplicate LINE summary on a replayed finalizer.
    expect(await finalizeNow(pushes)).toBe(0);
    expect(pushes).toHaveLength(1);

    const accounting = JSON.parse(await db.scalar(`SELECT slip_batch_image_accounting('${batchId}')`));
    expect(accounting).toMatchObject({
      received_total: 25, attached: 24, failed_permanent: 1, waiting: 0, incomplete: 1,
      ocr_complete: 24, ocr_pending: 0,
    });
  }, 120_000);

  // ── 3: temporary failure of the 6th image ───────────────────────────────────
  test("6th image fails once: the other 24 are processed, retry recovers it, batch completes", async () => {
    const G = "G-temp";
    const batchId = await openBatch(G);
    downloadPlan.set(`m-${G}-6`, { failFirst: 1, calls: 0 });
    const webhook = makeWebhook();
    for (let i = 1; i <= 25; i++) await deliver(webhook, [imageEvent(G, i, T0 + 1000 * i)]);
    await closeBatchSql(batchId, T0 + 26_000);
    await runTasks();

    const mid = await ledger(batchId);
    expect(mid.filter((r) => r.state === "attached")).toHaveLength(24);
    expect(mid.find((r) => r.line_message_id === `m-${G}-6`)!.state).toBe("retry_pending");

    await makeRetryDue(`m-${G}-6`);
    const recovered = await webhook.recoverSlipIngest();
    expect(recovered.ledger.attached).toBe(1);
    await runTasks();

    expect((await ledger(batchId)).filter((r) => r.state === "attached")).toHaveLength(25);
    expect(await count("slip_evidences", `batch_id='${batchId}'`)).toBe(25);
    expect(ocrRuns).toHaveLength(25);

    await backdate(batchId, 30);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(1);
    expect(pushes[0]).not.toContain("ยอดนี้ยังไม่ครบ");
    expect(pushes[0]).toContain("2,500");
    expect((await batchRow(batchId)).status).toBe("completed");
  }, 120_000);

  // ── 7: concurrent workers + finalizer race ───────────────────────────────────
  test("concurrent drains and recovery never duplicate evidence, checks or batch indexes", async () => {
    const G = "G-conc";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    for (let i = 1; i <= 25; i++) await deliver(webhook, [imageEvent(G, i, T0 + 1000 * i)]);
    await closeBatchSql(batchId, T0 + 26_000);

    const drain = backgroundTasks.splice(0);
    expect(drain.length).toBeGreaterThan(0);
    const other = makeWebhook();
    await Promise.all([
      ...drain.map((t) => t()),
      ...drain.map((t) => t()),
      other.recoverSlipIngest(),
    ]);
    await runTasks();

    expect(await count("slip_evidences")).toBe(25);
    expect(Number(await db.scalar("SELECT count(DISTINCT line_message_id) FROM slip_evidences"))).toBe(25);
    expect((await ledger(batchId)).filter((r) => r.state === "attached")).toHaveLength(25);
    expect((await batchRow(batchId)).image_count).toBe(25);
    expect(Number(await db.scalar(`SELECT count(DISTINCT batch_index) FROM slip_evidences WHERE batch_id='${batchId}'`))).toBe(25);
    expect(new Set(ocrRuns).size).toBe(ocrRuns.length); // each evidence OCRed once
    expect(await count("slip_checks")).toBe(25);
  }, 120_000);

  test("finalizer race: parallel claims vs late workers lose nothing and finalize at most once", async () => {
    const G = "G-race";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    for (let i = 1; i <= 6; i++) await deliver(webhook, [imageEvent(G, i, T0 + 1000 * i)]);
    await closeBatchSql(batchId, T0 + 10_000);
    await backdate(batchId, 1300); // ingest wait bound exhausted: claim is allowed to win

    const drain = backgroundTasks.splice(0);
    const claims = Array.from({ length: 4 }, () =>
      db.query(`SELECT * FROM claim_closing_slip_batch('${batchId}', 10, 120, 600)`));
    const results = await Promise.all([...claims, ...drain.map((t) => t())]);
    await runTasks();

    const claimed = (results.slice(0, 4) as unknown[][]).filter((rows) => rows.length === 1);
    expect(claimed.length).toBeLessThanOrEqual(1);
    const rows = await ledger(batchId);
    const attached = rows.filter((r) => r.state === "attached").length;
    const late = rows.filter((r) => r.state === "late_after_finalize").length;
    expect(attached + late).toBe(6); // every image has an explicit outcome
    expect(rows.some((r) => ["received", "ingesting"].includes(r.state))).toBe(false);
    expect(await count("slip_evidences", `batch_id='${batchId}'`)).toBe(attached);
  }, 120_000);

  // ── 8: duplicates and redeliveries ──────────────────────────────────────────
  test("webhook redelivery and duplicate LINE message ids create one ledger row, one evidence, one OCR", async () => {
    const G = "G-dup";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    const original = imageEvent(G, 1, T0 + 1000);
    await deliver(webhook, [original]);
    const again = await deliver(webhook, [original]); // LINE redelivery, same webhookEventId
    expect(again[0].status).toBe("duplicate");
    // Same LINE message id under a different webhookEventId (replay).
    await deliver(webhook, [imageEvent(G, 1, T0 + 1000, "evt-replayed-with-new-id")]);
    await runTasks();

    expect(await count("slip_image_events")).toBe(1);
    expect(await count("slip_evidences")).toBe(1);
    expect(ocrRuns).toHaveLength(1);
    expect((await batchRow(batchId)).image_count).toBe(1);
  }, 60_000);

  // ── 9, 13: attribution by LINE time, never by when a worker happens to run ──
  test("images after the close command cannot enter the closed batch; delayed earlier ones can", async () => {
    const G = "G-after-close";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent(G, "before", T0 + 5_000)]);
    await closeBatchSql(batchId, T0 + 10_000);
    // Delivered AFTER the close was processed, but sent BEFORE it (LINE reorder).
    await deliver(webhook, [imageEvent(G, "delayed", T0 + 9_000)]);
    // Sent AFTER the close command.
    await deliver(webhook, [imageEvent(G, "after", T0 + 12_000)]);
    await runTasks();

    const states = Object.fromEntries((await ledger(batchId)).map((r) => [r.line_message_id, r.state]));
    expect(states[`m-${G}-before`]).toBe("attached");
    expect(states[`m-${G}-delayed`]).toBe("attached");
    expect(states[`m-${G}-after`]).toBe("excluded_after_close");
    expect(await count("slip_evidences", `line_message_id='m-${G}-after' AND batch_id IS NOT NULL`)).toBe(0);
    expect(replies.some((r) => r.length > 0)).toBe(true); // late image was told, not silently dropped
    expect((await batchRow(batchId)).image_count).toBe(2);
  }, 60_000);

  test("a late-arriving image sent after close but before delivery of close is excluded at claim time", async () => {
    const G = "G-sweep";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    // Received while the batch is still collecting, but sent after the close.
    await deliver(webhook, [imageEvent(G, "x", T0 + 20_000)]);
    await closeBatchSql(batchId, T0 + 10_000);
    await backdate(batchId, 30);
    const pushes: string[] = [];
    await finalizeNow(pushes);
    expect((await ledger(batchId))[0].state).toBe("excluded_after_close");
    expect(await count("slip_evidences")).toBe(0);
  }, 60_000);

  test("sequential sessions in one group: delayed images stay in the session they were sent in", async () => {
    const G = "G-seq";
    const first = await openBatch(G, T0);
    await closeBatchSql(first, T0 + 10_000);
    const second = await openBatch(G, T0 + 20_000);
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent(G, "a", T0 + 5_000)]);  // sent in session 1, delivered late
    await deliver(webhook, [imageEvent(G, "b", T0 + 15_000)]); // between sessions
    await deliver(webhook, [imageEvent(G, "c", T0 + 25_000)]); // session 2
    await runTasks();

    const byMsg = Object.fromEntries((await ledger()).map((r) => [r.line_message_id, r]));
    expect(byMsg[`m-${G}-a`].batch_id).toBe(first);
    expect(byMsg[`m-${G}-a`].state).toBe("attached");
    expect(byMsg[`m-${G}-b`].batch_id).toBe(first);
    expect(byMsg[`m-${G}-b`].state).toBe("excluded_after_close");
    expect(byMsg[`m-${G}-c`].batch_id).toBe(second);
    expect(byMsg[`m-${G}-c`].state).toBe("attached");
    expect((await batchRow(second)).image_count).toBe(1);
  }, 60_000);

  test("two groups running at once never mix images", async () => {
    const a = await openBatch("G-A");
    const b = await openBatch("G-B");
    const webhook = makeWebhook();
    for (let i = 1; i <= 5; i++) {
      await deliver(webhook, [imageEvent("G-A", i, T0 + 1000 * i), imageEvent("G-B", i, T0 + 1000 * i)]);
    }
    await runTasks();
    expect(await count("slip_evidences", `batch_id='${a}' AND source_id <> 'G-A'`)).toBe(0);
    expect(await count("slip_evidences", `batch_id='${b}' AND source_id <> 'G-B'`)).toBe(0);
    expect((await batchRow(a)).image_count).toBe(5);
    expect((await batchRow(b)).image_count).toBe(5);
  }, 60_000);

  test("an image whose worker only runs after the batch was finalized is recorded as late, not lost", async () => {
    const G = "G-late";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent(G, 1, T0 + 1000)]);
    await closeBatchSql(batchId, T0 + 5_000);
    // Finalizer wins (ingest bound exhausted) before the worker ever ran. The
    // bound is cohort-wide (from the later of close and the last receipt).
    await backdate(batchId, DEFAULT_INGEST_MAX_SECONDS + 100);
    await db.query(`UPDATE slip_image_events SET received_at = received_at - interval '${DEFAULT_INGEST_MAX_SECONDS + 100} seconds'`);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(1);
    expect(pushes[0]).toContain("ยังประมวลผลไม่เสร็จ: 1 รูป");
    expect((await batchRow(batchId)).status).toBe("failed"); // zero attached -> not "completed"
    await runTasks();

    const row = (await ledger(batchId))[0];
    expect(row.state).toBe("late_after_finalize");
    expect(await count("slip_evidences", `batch_id='${batchId}'`)).toBe(0);
    // Queue event was acknowledged, but the loss is explicit in the ledger.
    expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(1);
    const accounting = JSON.parse(await db.scalar(`SELECT slip_batch_image_accounting('${batchId}')`));
    expect(accounting.late_after_finalize).toBe(1);
  }, 60_000);

  // ── bounded waiting ─────────────────────────────────────────────────────────
  test("an event whose queue row died cannot block the batch; it is reported, not waited on forever", async () => {
    const G = "G-dead";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent(G, 1, T0 + 1000)]);
    await closeBatchSql(batchId, T0 + 5_000);
    await backdate(batchId, 30);
    await db.query(
      `UPDATE line_webhook_event_queue SET status='stale', completed_at=now() WHERE source_id='${G}'`,
    );
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(1); // no 10 minute wait for an unprocessable event
    expect(pushes[0]).toContain("ประมวลผลไม่สำเร็จ: 1 รูป");
    expect((await batchRow(batchId)).status).toBe("failed");
  }, 60_000);

  // ── 10: crash recovery ──────────────────────────────────────────────────────
  test("worker crash after storing evidence: lease expiry + sweep attaches once, no duplicates", async () => {
    const G = "G-crash";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent(G, 1, T0 + 1000)]);
    backgroundTasks.length = 0; // the worker "crashes" before the drain ever runs

    // Crashed mid-attempt: lease taken, evidence stored, attach never happened.
    await db.scalar(`SELECT begin_slip_image_attempt('m-${G}-1', 5, 120)`);
    const evidence = new SlipEvidenceService(supa, download);
    const raw = (await db.query<{ id: string }>(`SELECT id FROM raw_messages WHERE message_id='m-${G}-1'`))[0].id;
    const stored = await evidence.ingest({
      rawMessageId: raw, lineMessageId: `m-${G}-1`, sourceId: G, sourceType: "group",
      lineUserId: "U-seller", eventTimestamp: T0 + 1000,
    });
    expect(stored.status).toBe("RECEIVED");
    expect((await ledger(batchId))[0].state).toBe("ingesting");

    // Lease still valid: a competing sweep must not steal it.
    expect((await webhook.recoverSlipIngest()).ledger.due).toBe(0);

    await db.query(`UPDATE slip_image_events SET lease_until = now() - interval '1 second'`);
    const sweep = await webhook.recoverSlipIngest();
    expect(sweep.ledger.attached).toBe(1);
    await runTasks();

    expect(await count("slip_evidences")).toBe(1);
    expect(downloadPlan.get(`m-${G}-1`)!.calls).toBe(1); // stored evidence reused, no re-download
    expect((await batchRow(batchId)).image_count).toBe(1);
    expect(ocrRuns).toHaveLength(1);
    expect(await count("slip_checks")).toBe(1);

    // Replaying the sweep and the queue event again changes nothing.
    await webhook.recoverSlipIngest();
    await runTasks();
    expect(await count("slip_evidences")).toBe(1);
    expect((await batchRow(batchId)).image_count).toBe(1);
    expect(ocrRuns).toHaveLength(1);
  }, 60_000);

  test("expired lease A then claim B: stale A fail/attach cannot touch B's lease", async () => {
    const G = "G-fence";
    const M = `m-${G}-1`;
    const batchId = await openBatch(G);
    await deliver(makeWebhook(), [imageEvent(G, 1, T0 + 1000)]);
    backgroundTasks.length = 0;

    const a = await j<{ claimed: boolean; attempt: number }>(`SELECT begin_slip_image_attempt('${M}', 5, 120)`);
    expect(a.claimed).toBe(true);
    await db.query(`UPDATE slip_image_events SET lease_until = now() - interval '1 second'`);
    const b = await j<{ claimed: boolean; attempt: number }>(`SELECT begin_slip_image_attempt('${M}', 5, 120)`);
    expect(b.claimed).toBe(true);
    expect(b.attempt).toBe(a.attempt + 1);
    const leaseB = await leaseOf();

    // Stale A fails: rejected, B's lease and state untouched.
    const failA = await j<{ outcome: string }>(
      `SELECT fail_slip_image_event('${M}', 'download_failed', ${a.attempt}, 5, false)`);
    expect(failA.outcome).toBe("stale_claim");
    let row = (await ledger(batchId))[0];
    expect(row.state).toBe("ingesting");
    expect(await leaseOf()).toBe(leaseB);

    // Stale A attaches: rejected, nothing attached.
    const evidence = new SlipEvidenceService(supa, download);
    const raw = (await db.query<{ id: string }>(`SELECT id FROM raw_messages WHERE message_id='${M}'`))[0].id;
    const stored = await evidence.ingest({
      rawMessageId: raw, lineMessageId: M, sourceId: G, sourceType: "group",
      lineUserId: "U-seller", eventTimestamp: T0 + 1000,
    });
    const attachA = await j<{ outcome: string }>(
      `SELECT attach_slip_image_event('${M}', '${stored.evidenceId}', ${a.attempt})`);
    expect(attachA.outcome).toBe("stale_claim");
    row = (await ledger(batchId))[0];
    expect(row.state).toBe("ingesting");
    expect((await batchRow(batchId)).image_count).toBe(0);

    // B (current token) attaches; stale A replay afterwards is a no-op.
    const attachB = await j<{ outcome: string }>(
      `SELECT attach_slip_image_event('${M}', '${stored.evidenceId}', ${b.attempt})`);
    expect(attachB.outcome).toBe("attached");
    const replayB = await j<{ outcome: string }>(
      `SELECT attach_slip_image_event('${M}', '${stored.evidenceId}', ${b.attempt})`);
    expect(replayB.outcome).toBe("already_attached");
    const lateA = await j<{ outcome: string }>(
      `SELECT fail_slip_image_event('${M}', 'download_failed', ${a.attempt}, 5, false)`);
    expect(lateA.outcome).toBe("already_resolved");
    expect((await ledger(batchId))[0].state).toBe("attached");
    expect((await batchRow(batchId)).image_count).toBe(1);
  }, 60_000);

  test("default cron recovery re-drives attached evidence whose OCR never started", async () => {
    const batchId = await openBatch("G-ocr-budget");
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent("G-ocr-budget", 1, T0 + 1000)]);
    await runTasks();
    await db.query("DELETE FROM slip_checks");
    await db.query("UPDATE slip_image_events SET resolved_at = now() - interval '2 minutes'");

    const recovered = await webhook.recoverSlipIngest();

    expect(recovered.ocrRedriven).toBe(1);
    expect(await count("slip_checks")).toBe(1);
    expect((await ledger(batchId))[0].state).toBe("attached");
  }, 60_000);

  test("legacy attach followed by ledger reconciliation does not double-count the image", async () => {
    const G = "G-legacy";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent(G, 1, T0 + 1000)]);
    backgroundTasks.length = 0;
    const raw = (await db.query<{ id: string }>(`SELECT id FROM raw_messages WHERE message_id='m-${G}-1'`))[0].id;
    const stored = await new SlipEvidenceService(supa, download).ingest({
      rawMessageId: raw, lineMessageId: `m-${G}-1`, sourceId: G, sourceType: "group",
      lineUserId: "U-seller", eventTimestamp: T0 + 1000,
    });
    // Old code path attached it directly and never touched the ledger.
    await db.scalar(`SELECT attach_evidence_to_slip_batch('${batchId}', '${stored.evidenceId}')`);
    await db.query(`UPDATE line_webhook_event_queue SET status='processed', completed_at=now() WHERE source_id='${G}'`);
    await db.query(`UPDATE slip_image_events SET received_at = now() - interval '2 minutes'`);

    await webhook.recoverSlipIngest();
    expect((await ledger(batchId))[0].state).toBe("attached");
    expect((await batchRow(batchId)).image_count).toBe(1);
  }, 60_000);

  // ── 4: storage failure is explicit, never a silent skip ─────────────────────
  test("permanent storage failure: bounded retries, explicit failed_permanent, neighbours unaffected", async () => {
    const G = "G-store";
    const batchId = await openBatch(G);
    storage.failUpload.add(buildSlipEvidencePath({
      businessDate: bangkokBusinessDateFromTimestamp(T0 + 1000)!,
      sourceId: G,
      lineMessageId: `m-${G}-1`,
    }));
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent(G, 1, T0 + 1000), imageEvent(G, 2, T0 + 2000)]);
    await runTasks();
    expect((await ledger(batchId)).find((r) => r.line_message_id === `m-${G}-2`)!.state).toBe("attached");
    expect((await ledger(batchId)).find((r) => r.line_message_id === `m-${G}-1`)!.state).toBe("retry_pending");

    for (let i = 0; i < 6; i++) {
      await makeRetryDue(`m-${G}-1`);
      await webhook.recoverSlipIngest();
    }
    const failed = (await ledger(batchId)).find((r) => r.line_message_id === `m-${G}-1`)!;
    expect(failed.state).toBe("failed_permanent");
    expect(failed.attempts).toBe(5);
    expect(await count("slip_evidences", `line_message_id='m-${G}-1' AND status='STORAGE_FAILED' AND batch_id IS NULL`)).toBe(1);
    expect(await count("slip_evidences")).toBe(2); // retries reconciled the same row

    await runTasks();
    await closeBatchSql(batchId, T0 + 10_000);
    await backdate(batchId, 30);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(1);
    expect(pushes[0]).toContain("รับรูปจาก LINE: 2 รูป");
    expect(pushes[0]).toContain("ประมวลผลไม่สำเร็จ: 1 รูป");
    expect((await batchRow(batchId)).status).toBe("review_needed");
  }, 60_000);

  test("an image consumed by another flow (white sheet) is not a slip and never blocks the batch", async () => {
    const G = "G-ws";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    await deliver(webhook, [imageEvent(G, "sheet", T0 + 1000)]);
    backgroundTasks.length = 0;
    // The white-sheet branch marks the raw message processed and returns.
    await db.query(`UPDATE raw_messages SET is_processed = true WHERE message_id='m-${G}-sheet'`);
    await db.query(`UPDATE line_webhook_event_queue SET status='processed', completed_at=now() WHERE source_id='${G}'`);
    await closeBatchSql(batchId, T0 + 5_000);
    await backdate(batchId, 30);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(1);
    expect((await ledger(batchId))[0].state).toBe("excluded_not_slip");
    expect(await count("slip_evidences")).toBe(0);
  }, 60_000);

  // ── 4 + close command through the real webhook path ─────────────────────────
  test("จบสลิป records the LINE timestamp of the close command", async () => {
    const G = "G-close-cmd";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    await deliver(webhook, [textEvent(G, "evt-close", "จบสลิป", T0 + 30_000)], false);
    const row = await batchRow(batchId);
    expect(row.status).toBe("closing");
    expect(Number(row.close_event_ts_ms)).toBe(T0 + 30_000);
  }, 60_000);

  // ── P0 #2: one payload [open, image1, image2 (download fails), image3] ──────
  describe.each([
    { name: "deferred drain", defer: true },
    { name: "inline drain", defer: false },
  ])("same webhook payload opens the session and carries its images ($name)", ({ defer }) => {
    test("every image is ledgered, none lost behind the failure, no partial summary completes", async () => {
      const G = `G-same-payload-${defer}`;
      downloadPlan.set(`m-${G}-2`, { failAlways: true, calls: 0 });
      const webhook = makeWebhook();

      await deliver(webhook, [
        textEvent(G, "evt-open", "น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569", T0),
        imageEvent(G, 1, T0 + 1000),
        imageEvent(G, 2, T0 + 2000),
        imageEvent(G, 3, T0 + 3000),
      ], defer);

      if (defer) {
        // Receipts are durable BEFORE the session exists: ledgered as unbound.
        expect(await count("slip_batches")).toBe(0);
        const early = await ledger();
        expect(early).toHaveLength(3);
        expect(early.every((r) => r.state === "unbound" && r.batch_id === null)).toBe(true);
        await runTasks();
      }

      const batchId = await db.scalar(`SELECT id FROM slip_batches WHERE source_id='${G}'`);
      expect(batchId).not.toBe("");
      const rows = await ledger(batchId);
      expect(rows).toHaveLength(3); // all three bound to the session by LINE time
      expect(await count("slip_image_events")).toBe(3);
      const byMsg = Object.fromEntries(rows.map((r) => [r.line_message_id, r]));
      expect(byMsg[`m-${G}-1`].state).toBe("attached");
      expect(byMsg[`m-${G}-2`].state).toBe("retry_pending");
      expect(byMsg[`m-${G}-3`].state).toBe("attached"); // image3 not lost behind image2
      expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(4);
      expect(await count("slip_evidences", `batch_id='${batchId}'`)).toBe(2);
      expect((await batchRow(batchId)).image_count).toBe(2);

      await runTasks();
      await closeBatchSql(batchId, T0 + 10_000);
      await backdate(batchId, 30);
      const pushes: string[] = [];
      expect(await finalizeNow(pushes)).toBe(0); // image2 still owed a retry
      expect((await batchRow(batchId)).status).toBe("closing");

      for (let attempt = 2; attempt <= 5; attempt++) {
        await makeRetryDue(`m-${G}-2`);
        await webhook.recoverSlipIngest();
      }
      await runTasks();
      expect((await ledger(batchId)).find((r) => r.line_message_id === `m-${G}-2`)!.state)
        .toBe("failed_permanent");

      await backdate(batchId, 30);
      expect(await finalizeNow(pushes)).toBe(1);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toContain("รับรูปจาก LINE: 3 รูป");
      expect(pushes[0]).toContain("ยังไม่ครบ: 1 รูป");
      expect(pushes[0]).toContain("ยอดนี้ยังไม่ครบ");
      const final = await batchRow(batchId);
      expect(final.status).toBe("review_needed"); // never "completed" with a missing image
      expect(final.failed_count).toBe(1);
      expect(final.success_count).toBe(2);
    }, 120_000);
  });

  // ── P0 #3a: ledger trigger failure must not leave a ledger-less receipt ─────
  test("ledger trigger insert failure rolls back the whole queue receipt; redelivery then ledgers it", async () => {
    const G = "G-trigger-fail";
    const batchId = await openBatch(G);
    const webhook = makeWebhook();
    const doomed = imageEvent(G, "boom", T0 + 1000);
    await db.query(
      `ALTER TABLE slip_image_events ADD CONSTRAINT zz_boom CHECK (line_message_id <> 'm-${G}-boom')`,
    );
    try {
      const [failed] = await deliver(webhook, [doomed], false);
      expect(failed.status).toBe("error");
      expect(failed.error).toBe("db insert failed");
      expect(failed.retryable).toBe(true);
      // The raw message, the queue row and the ledger row are one transaction.
      expect(await count("raw_messages")).toBe(0);
      expect(await count("line_webhook_event_queue")).toBe(0);
      expect(await count("slip_image_events")).toBe(0);
      expect(await count("slip_evidences")).toBe(0);
    } finally {
      await db.query("ALTER TABLE slip_image_events DROP CONSTRAINT zz_boom");
    }

    // LINE redelivers the same webhookEventId: now it is received WITH a ledger row.
    await deliver(webhook, [doomed]);
    await runTasks();
    const rows = await ledger(batchId);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("attached");
    expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(1);
  }, 60_000);

  // ── P0 #3b: begin RPC error/timeout never falls back to the legacy path ─────
  describe.each([
    {
      name: "returned timeout error",
      fail: () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }),
    },
    {
      name: "thrown network error",
      fail: () => { throw new Error("fetch failed: ETIMEDOUT"); },
    },
  ])("begin_slip_image_attempt $name", ({ fail }) => {
    test("an image sent after close is never legacy-attached to a newer open session", async () => {
      const G = "G-begin-timeout";
      const first = await openBatch(G, T0);
      await closeBatchSql(first, T0 + 10_000);
      const second = await openBatch(G, T0 + 20_000); // collecting: what the legacy path would hijack
      const flaky = {
        ...supa,
        rpc: (name: string, args?: Record<string, unknown>) =>
          name === "begin_slip_image_attempt" ? Promise.resolve().then(fail) : supa.rpc(name, args),
      };
      const webhook = makeWebhook(flaky);

      // Sent after the first session closed and before the second opened.
      const [outage] = await deliver(webhook, [imageEvent(G, "between", T0 + 15_000)], false);
      expect(outage.status).toBe("error");
      expect(outage.retryable).toBe(true);
      expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(0);
      expect(await count("slip_evidences")).toBe(0);
      expect((await batchRow(second)).image_count).toBe(0);

      // Outage over: redelivery resolves it from the ledger, still not into the new session.
      await deliver(makeWebhook(), [imageEvent(G, "between", T0 + 15_000)], false);
      await runTasks();
      const rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0].batch_id).toBe(first);
      expect(rows[0].state).toBe("excluded_after_close");
      expect(await count("slip_evidences", `batch_id='${second}'`)).toBe(0);
      expect((await batchRow(second)).image_count).toBe(0);
    }, 60_000);
  });
});
