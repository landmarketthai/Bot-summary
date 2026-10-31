/**
 * P0 slip image ordering: the LINE summary's #N must be the N-th image sent in
 * LINE, and the amount / reason on that line must come from that image's own
 * evidence — whatever order download retries and OCR complete in. Proven on
 * real PostgreSQL 17 through the production WebhookService; only the LINE
 * download, Storage and the OCR provider are simulated.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test ./src/lib/slips/image-sequence.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { WebhookService } from "@/lib/line/webhook-service";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";
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
let failures: Map<string, { failFirst: number; calls: number }>;
let backgroundTasks: Array<() => Promise<void>>;

const T0 = 1_760_000_000_000;
const HEADER = "น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569";

const msgId = (source: string, n: number) => `m-${source}-${String(n).padStart(3, "0")}`;
/** Each image's own amount (market B is +1000), so a #N line proves its evidence. */
const amountOf = (n: number, source = "") => 1000 + n + (source === "G-mkt-b" ? 1000 : 0);

async function download(messageId: string) {
  const plan = failures.get(messageId);
  if (plan) {
    plan.calls += 1;
    if (plan.calls <= plan.failFirst) throw new Error("simulated LINE content 500");
  }
  return { bytes: new TextEncoder().encode(`img:${messageId}`), mimeType: "image/jpeg" };
}

const noGuidedRound = {
  resolve: async () => ({ stage: "idle", reason: "no_session" }),
  findRoundOwner: async () => ({ kind: "none" as const }),
};

/** OCR result keyed by the evidence's own LINE message: amount = 1000 + n. */
async function ocr(evidenceId: string) {
  const id = await db.scalar(`SELECT line_message_id FROM slip_evidences WHERE id='${evidenceId}'`);
  const n = Number(id.split("-").pop());
  const source = id.slice(2, id.lastIndexOf("-"));
  const time = n === 20 ? "NULL" : n === 25 ? "'2026-10-10T12:00:00+07'" : "'2026-10-16T12:00:00+07'";
  await db.query(
    `INSERT INTO slip_checks (evidence_id, status, slip_type, transfer_amount, transaction_time)
     VALUES ('${evidenceId}', 'EXTRACTED', 'BANK_SLIP_QR', ${amountOf(n, source)}, ${time})
     ON CONFLICT (evidence_id) DO NOTHING`,
  );
}

function makeWebhook(): WebhookService {
  return new WebhookService(supa, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guidedJourneyService: noGuidedRound as any,
    evidenceIngestor: new SlipEvidenceService(supa, download),
    checkProcessor: { processEvidence: ocr },
    scheduleBackgroundTask: (task) => { backgroundTasks.push(task); },
    replyMessage: async () => {},
    slipRetrySleep: async () => {},
  });
}

function imageEvent(source: string, n: number, ts: number) {
  const id = `evt-${source}-${n}`;
  return {
    type: "message", webhookEventId: id, timestamp: ts, replyToken: `rt-${id}`, mode: "active",
    source: { type: "group", groupId: source, userId: "U-seller" },
    message: { type: "image", id: msgId(source, n), contentProvider: { type: "line" } },
  };
}

function textEvent(source: string, id: string, text: string, ts: number) {
  return {
    type: "message", webhookEventId: `${source}-${id}`, timestamp: ts, replyToken: `rt-${source}-${id}`, mode: "active",
    source: { type: "group", groupId: source, userId: "U-seller" },
    message: { type: "text", id: `m-${source}-${id}`, text },
  };
}

/** Background work runs newest-first, so OCR completes in reverse LINE order. */
async function runTasksNewestFirst(): Promise<void> {
  while (backgroundTasks.length > 0) await backgroundTasks.pop()!();
}

async function deliver(service: WebhookService, events: unknown[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return service.processEvents(events as any, "dest", { deferOrderedProcessing: true });
}

const batchIdOf = (source: string) => db.scalar(`SELECT id FROM slip_batches WHERE source_id='${source}'`);

async function finalizeNow(pushes: string[]) {
  await db.query(
    `UPDATE slip_batches SET closing_at = closing_at - interval '60 seconds',
            last_image_at = last_image_at - interval '60 seconds' WHERE status='closing'`,
  );
  return finalizeClosingSlipBatches(supa, async (_to, text) => { pushes.push(text); }, 10, 120);
}

/** One recovery sweep with the given images' backoff already elapsed (cron retry). */
async function retryDue(webhook: WebhookService, lineMessageIds: string[]) {
  await db.query(
    `UPDATE slip_image_events SET next_retry_at = now() - interval '1 second'
      WHERE line_message_id IN (${lineMessageIds.map((id) => `'${id}'`).join(",")})`,
  );
  await webhook.recoverSlipIngest();
  await runTasksNewestFirst();
}

describe.skipIf(!pgAvailable)("slip summary #N = LINE send order on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_seq");
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
    failures = new Map();
    backgroundTasks = [];
  });

  test("30 images: retries attach late, OCR finishes in reverse, one image fails, payload redelivered, close while pending", async () => {
    const G = "G-seq30";
    for (const n of [3, 7, 12]) failures.set(msgId(G, n), { failFirst: 1, calls: 0 });
    failures.set(msgId(G, 15), { failFirst: 99, calls: 0 });
    const webhook = makeWebhook();
    const events = [
      textEvent(G, "open", HEADER, T0),
      ...Array.from({ length: 30 }, (_, i) => imageEvent(G, i + 1, T0 + 1000 * (i + 1))),
      textEvent(G, "close", "จบสลิป", T0 + 31_000),
    ];

    await deliver(webhook, events);
    await deliver(webhook, events); // LINE redelivery of the same payload
    await runTasksNewestFirst();

    const batchId = await batchIdOf(G);
    expect(await db.scalar(`SELECT count(*) FROM slip_image_events WHERE batch_id='${batchId}'`)).toBe("30");
    expect(await db.scalar(`SELECT count(*) FROM slip_evidences WHERE batch_id='${batchId}'`)).toBe("26");

    // Close arrived while 3, 7, 12 and 15 are still owed retries: no summary yet.
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(0);
    await retryDue(webhook, [3, 7, 12, 15].map((n) => msgId(G, n)));
    expect(await db.scalar(`SELECT count(*) FROM slip_evidences WHERE batch_id='${batchId}'`)).toBe("29");
    // The old #N: retried images were numbered after images sent later.
    const lateIndex = Number(await db.scalar(
      `SELECT batch_index FROM slip_evidences WHERE line_message_id='${msgId(G, 3)}'`,
    ));
    expect(lateIndex).toBeGreaterThan(3);

    expect(await finalizeNow(pushes)).toBe(0);
    for (let i = 0; i < 5; i++) await retryDue(webhook, [msgId(G, 15)]);
    expect(await db.scalar(`SELECT state FROM slip_image_events WHERE line_message_id='${msgId(G, 15)}'`))
      .toBe("failed_permanent");

    expect(await finalizeNow(pushes)).toBe(1);
    expect(pushes).toHaveLength(1);
    const text = pushes[0];

    for (let n = 1; n <= 30; n++) {
      if (n === 15) expect(text).toContain("#15 รูปเข้าระบบไม่สำเร็จ");
      else if (n === 20) expect(text).toContain("#20 ไม่พบวันที่รายการ");
      else if (n === 25) expect(text).toContain("#25 วันที่รายการไม่ตรงกับรอบ");
      else expect(text).toContain(`#${n} เช็คได้ ${amountOf(n).toLocaleString("th-TH")} บาท`);
    }
    expect(text.match(/^#\d+ /gm)).toHaveLength(30); // every image listed exactly once
    expect(text).toContain("รับทั้งหมด: 30 รูป");
    expect(text).toContain("อ่านครบ: 27 รูป");
    // Closing exceeded its max wait here, so the timeout layout splits the 3:
    expect(text).toContain("รอตรวจมือ: 2 รูป");
    expect(text).toContain("ยังไม่เข้าระบบ: 1 รูป");
    expect(text).toContain("รับรูปจาก LINE: 30 รูป");
    expect(text).toContain("ยังไม่ครบ: 1 รูป");
    expect(text).not.toContain("ยืนยันลำดับจาก LINE ไม่ได้");
    const trustedTotal = Array.from({ length: 30 }, (_, i) => i + 1)
      .filter((n) => ![15, 20, 25].includes(n))
      .reduce((sum, n) => sum + amountOf(n), 0);
    expect(text).toContain(`ยอดรวมที่อ่านได้: ${trustedTotal.toLocaleString("th-TH")} บาท`);

    const batch = (await db.query<Record<string, unknown>>(`SELECT * FROM slip_batches WHERE id='${batchId}'`))[0];
    expect(batch.status).toBe("review_needed");
    expect(batch.success_count).toBe(27);
    expect(batch.failed_count).toBe(3);

    // Report generation is idempotent: a second sweep sends nothing.
    expect(await finalizeNow(pushes)).toBe(0);
    expect(pushes).toHaveLength(1);
  }, 240_000);

  test("two markets uploading at the same time are numbered independently", async () => {
    const A = "G-mkt-a";
    const B = "G-mkt-b";
    failures.set(msgId(A, 1), { failFirst: 1, calls: 0 });
    const webhook = makeWebhook();
    const events = [
      textEvent(A, "open", HEADER, T0),
      textEvent(B, "open", HEADER, T0 + 100),
      ...Array.from({ length: 5 }, (_, i) => [
        imageEvent(A, i + 1, T0 + 1000 * (i + 1)),
        imageEvent(B, i + 1, T0 + 1000 * (i + 1) + 500),
      ]).flat(),
      textEvent(A, "close", "จบสลิป", T0 + 10_000),
      textEvent(B, "close", "จบสลิป", T0 + 10_500),
    ];

    await deliver(webhook, events);
    await runTasksNewestFirst();
    await retryDue(webhook, [msgId(A, 1)]);

    const sent: Array<{ to: string; text: string }> = [];
    await db.query(
      `UPDATE slip_batches SET closing_at = closing_at - interval '60 seconds',
              last_image_at = last_image_at - interval '60 seconds' WHERE status='closing'`,
    );
    expect(await finalizeClosingSlipBatches(supa, async (to, text) => { sent.push({ to, text }); }, 10, 120)).toBe(2);
    for (const source of [A, B]) {
      const text = sent.find((s) => s.to === source)!.text;
      expect(text).toContain("รับทั้งหมด: 5 รูป");
      for (let n = 1; n <= 5; n++) {
        expect(text).toContain(`#${n} เช็คได้ ${amountOf(n, source).toLocaleString("th-TH")} บาท`);
      }
      expect(text.match(/^#\d+ /gm)).toHaveLength(5);
    }
  }, 120_000);
});
