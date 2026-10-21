/**
 * P1 #4 / #5 — cron-only recovery of a whole 25-image batch, on real
 * PostgreSQL 17 with the real migrations, the real WebhookService.recoverSlipIngest,
 * the real SlipCheckService (fenced OCR claim) and finalizeClosingSlipBatches.
 * Only LINE download, Storage and the OCR provider are simulated.
 *
 * Time is simulated by shifting every stored timestamp back (advance()), so a
 * "sweep" is: advance(gap) -> recoverSlipIngest() -> finalizeClosingSlipBatches().
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/cron-cohort-recovery.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { WebhookService } from "@/lib/line/webhook-service";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import { SlipCheckService, type SlipCheckProcessor } from "@/lib/slips/check-service";
import { OpenAiSlipExtractor, type SlipExtractor } from "@/lib/slips/extractor";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";
import { DEFAULT_INGEST_MAX_SECONDS, SLIP_INGEST_POLICY, requiredOcrWaitSeconds } from "@/lib/slips/ingest-policy";
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
let failFirst: Map<string, number>;
let downloads: Map<string, number>;
let backgroundTasks: Array<() => Promise<void>>;
let ocrCalls: number;
let activeDownloads: number;
let maxActiveDownloads: number;
let downloadDelayMs: number;
let activeOcr: number;
let maxActiveOcr: number;
let ocrDelayMs: number;

const T0 = 1_760_000_000_000;
const G = "G-cohort";
const BURST = 25;

async function download(messageId: string) {
  const n = (downloads.get(messageId) ?? 0) + 1;
  downloads.set(messageId, n);
  activeDownloads += 1;
  maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
  try {
    if (downloadDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, downloadDelayMs));
    if (n <= (failFirst.get(messageId) ?? 0)) throw new Error("simulated LINE content 500");
    return { bytes: new TextEncoder().encode(`img:${messageId}`), mimeType: "image/jpeg" };
  } finally {
    activeDownloads -= 1;
  }
}

/** Healthy OCR provider: every slip reads as 100 THB with its own reference. */
const healthyExtractor: SlipExtractor = {
  async extract() {
    ocrCalls += 1;
    activeOcr += 1;
    maxActiveOcr = Math.max(maxActiveOcr, activeOcr);
    try {
      if (ocrDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, ocrDelayMs));
      return {
        slipType: "BANK_SLIP_NO_QR",
        grossAmount: null,
        discountAmount: null,
        paidAmount: null,
        transferAmount: 100,
        referenceId: `REF-${ocrCalls}`,
        transactionTime: "2026-10-16T05:00:00.000Z",
        senderName: "sender",
        receiverName: "receiver",
        receiverAccountTail: "1234",
        paymentChannelText: null,
        headlineTotalAmount: null,
        confidence: 0.95,
      };
    } finally {
      activeOcr -= 1;
    }
  },
};

/** The background OCR worker dies before doing anything. */
const crashedOcr: SlipCheckProcessor = { processEvidence: async () => {} };

const noGuidedRound = {
  resolve: async () => ({ stage: "idle", reason: "no_session" }),
  findRoundOwner: async () => ({ kind: "none" as const }),
};

function makeWebhook(checkProcessor: SlipCheckProcessor): WebhookService {
  return new WebhookService(supa, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guidedJourneyService: noGuidedRound as any,
    evidenceIngestor: new SlipEvidenceService(supa, download),
    checkProcessor,
    scheduleBackgroundTask: (task) => { backgroundTasks.push(task); },
    // In-request retries find the image not yet due (ledger backoff) and stop:
    // every retry below is made by a cron sweep.
    slipRetrySleep: async () => {},
    replyMessage: async () => {},
  });
}

function imageEvent(n: number, ts: number) {
  const id = `evt-${G}-${n}`;
  return {
    type: "message",
    webhookEventId: id,
    timestamp: ts,
    replyToken: `rt-${id}`,
    mode: "active",
    source: { type: "group", groupId: G, userId: "U-seller" },
    message: { type: "image", id: `m-${G}-${n}`, contentProvider: { type: "line" } },
  };
}

async function runTasks(): Promise<void> {
  while (backgroundTasks.length > 0) await backgroundTasks.shift()!();
}

/** Simulated passage of `seconds`: every stored instant moves into the past. */
async function advance(seconds: number): Promise<void> {
  const iv = `interval '${seconds} seconds'`;
  await db.query(`UPDATE slip_image_events SET received_at = received_at - ${iv},
      next_retry_at = next_retry_at - ${iv}, lease_until = lease_until - ${iv}, resolved_at = resolved_at - ${iv}`);
  await db.query(`UPDATE slip_batches SET created_at = created_at - ${iv},
      closing_at = closing_at - ${iv}, last_image_at = last_image_at - ${iv}`);
  await db.query(`UPDATE slip_checks SET lease_until = lease_until - ${iv}`);
  await db.query(`UPDATE line_webhook_event_queue SET received_at = received_at - ${iv}`);
}

async function openAndReceive(webhook: WebhookService, burst = BURST): Promise<string> {
  const batchId = (await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name,
                               slip_date, header_text, open_event_ts_ms)
     VALUES ('${G}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569',
             'น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569', ${T0}) RETURNING id`,
  ))[0].id;
  for (let i = 1; i <= burst; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await webhook.processEvents([imageEvent(i, T0 + 1000 * i)] as any, "dest", { deferOrderedProcessing: true });
  }
  await runTasks(); // the receipts' own workers: attempt 1 of every image
  await db.query(
    `UPDATE slip_batches SET status='closing', closing_at=now(), close_event_ts_ms=${T0 + 30_000} WHERE id='${batchId}'`,
  );
  return batchId;
}

const finalizeNow = (pushes: string[]) =>
  finalizeClosingSlipBatches(supa, async (_to, text) => { pushes.push(text); }, 10, 120);
const batchRow = async (id: string) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM slip_batches WHERE id='${id}'`))[0];
const count = async (table: string, where = "TRUE") =>
  Number(await db.scalar(`SELECT count(*) FROM ${table} WHERE ${where}`));
const attempts = async () =>
  (await db.query<{ attempts: number }>(`SELECT attempts FROM slip_image_events ORDER BY event_ts_ms`))
    .map((r) => Number(r.attempts));

describe.skipIf(!pgAvailable)("P1 cron-only cohort recovery on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("cron_cohort");
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
    failFirst = new Map();
    downloads = new Map();
    backgroundTasks = [];
    ocrCalls = 0;
    activeDownloads = 0;
    maxActiveDownloads = 0;
    downloadDelayMs = 0;
    activeOcr = 0;
    maxActiveOcr = 0;
    ocrDelayMs = 0;
  });

  // ── P1 #4 ───────────────────────────────────────────────────────────────────
  test("25 attached, OCR worker crashed (13 before claim, 12 holding a lease): never finalized past recoverable OCR; sweeps read all 25", async () => {
    const batchId = await openAndReceive(makeWebhook(crashedOcr));
    expect(await count("slip_image_events", "state='attached'")).toBe(BURST);
    expect(await count("slip_checks")).toBe(0);
    // 12 workers died AFTER claiming the check (PROCESSING, 300 s lease).
    await db.query(
      `SELECT claim_slip_check(se.id, 300) FROM slip_evidences se WHERE se.batch_index <= 12`,
    );

    // Past the 120 s close cap and the quiet period: before the fix this claim
    // finalized review_needed with 25 slips unread.
    await advance(200);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(0);
    expect((await batchRow(batchId)).status).toBe("closing");

    // OCR is healthy again. Cron sweeps every 5 min: recovery, then finalizer.
    const webhook = makeWebhook(new SlipCheckService(supa, healthyExtractor, async () => {}));
    const redriven: number[] = [];
    for (let sweep = 1; sweep <= 4 && pushes.length === 0; sweep++) {
      await advance(300);
      const recovered = await webhook.recoverSlipIngest();
      redriven.push(recovered.ocrRedriven);
      await runTasks();
      const finalized = await finalizeNow(pushes);
      const terminal = await count("slip_checks", "status <> 'PROCESSING'");
      // The batch is claimed only once nothing recoverable is left.
      expect(finalized).toBe(terminal === BURST ? 1 : 0);
    }
    // Healthy OCR: one sweep's lanes drain the whole fair list (slow OCR gets
    // at least ocrLanes per sweep; requiredOcrWaitSeconds is sized for that).
    expect(redriven).toEqual([BURST]);
    expect(await count("slip_checks", "status = 'EXTRACTED'")).toBe(BURST);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("2,500");
    expect(pushes[0]).not.toContain("ยังไม่ครบ");
    const final = await batchRow(batchId);
    expect(final.status).toBe("completed");
    expect(final.success_count).toBe(BURST);
    expect(final.failed_count).toBe(0);
  }, 120_000);

  test("OCR never recovers: the wait is bounded (requiredOcrWaitSeconds) and then the batch goes to review, never completed", async () => {
    const batchId = await openAndReceive(makeWebhook(crashedOcr));
    const webhook = makeWebhook(crashedOcr);
    const wait = requiredOcrWaitSeconds(BURST);
    const pushes: string[] = [];

    await advance(wait - 60);
    await webhook.recoverSlipIngest();
    expect(await finalizeNow(pushes)).toBe(0); // still inside the bounded OCR wait

    await advance(120);
    expect(await finalizeNow(pushes)).toBe(1);
    const final = await batchRow(batchId);
    expect(final.status).toBe("failed"); // zero verified slips, never "completed"
    expect(final.success_count).toBe(0);
    expect(pushes[0]).not.toContain("2,500");
  }, 120_000);

  test("representative 25-image capacity: 25 ingest lanes, 10 OCR lanes, 429 Retry-After backpressure, all accounted", async () => {
    // Receipt workers encounter a provider error once. Recovery, not an
    // in-request retry, must safely resume the entire cohort.
    for (let i = 1; i <= BURST; i++) failFirst.set(`m-${G}-${i}`, 1);
    const batchId = await openAndReceive(makeWebhook(crashedOcr));
    expect(await count("slip_image_events", "state='retry_pending'")).toBe(BURST);
    expect(await finalizeNow([])).toBe(0);
    expect((await batchRow(batchId)).status).toBe("closing");

    const heapStart = process.memoryUsage().heapUsed;
    let peakHeap = heapStart;
    const startedAt = performance.now();

    // Mocked LINE download + local Storage/PG. The 25-lane cron sweep should
    // have all 25 provider calls in flight, but never more.
    downloadDelayMs = 15;
    await advance(300);
    const ingestRun = await makeWebhook(crashedOcr).recoverSlipIngest();
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    expect(ingestRun.ledger).toMatchObject({ due: BURST, attached: BURST });
    expect(maxActiveDownloads).toBe(SLIP_INGEST_POLICY.cron.ingestLanes);
    expect(maxActiveDownloads).toBeLessThanOrEqual(25);
    await runTasks(); // simulated crashed OCR tasks do no durable work
    expect(await count("slip_image_events", "state='attached'")).toBe(BURST);
    expect(await count("slip_checks")).toBe(0);
    expect(await finalizeNow([])).toBe(0); // attached is not falsely "completed" before OCR

    // Real OpenAiSlipExtractor control flow, but a fully local fake fetch:
    // every image receives one 429 with Retry-After: 3, then succeeds. Sleep
    // records the requested backpressure but waits only 2 ms in this test.
    const providerAttempts = new Map<string, number>();
    const requestedSleeps: number[] = [];
    let activeProviderCalls = 0;
    let maxActiveProviderCalls = 0;
    const providerFetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        input: Array<{ content: Array<{ type: string; image_url?: string }> }>;
      };
      const uri = body.input[0].content.find((part) => part.type === "input_image")?.image_url ?? "";
      const encoded = uri.split(",", 2)[1] ?? "";
      const imageId = Buffer.from(encoded, "base64").toString("utf8");
      const attempt = (providerAttempts.get(imageId) ?? 0) + 1;
      providerAttempts.set(imageId, attempt);
      activeProviderCalls += 1;
      maxActiveProviderCalls = Math.max(maxActiveProviderCalls, activeProviderCalls);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      try {
        await new Promise((resolve) => setTimeout(resolve, 8));
        if (attempt === 1) {
          return new Response("simulated quota", {
            status: 429,
            headers: { "Retry-After": "3" },
          });
        }
        return new Response(JSON.stringify({
          output: [{ content: [{ type: "output_text", text: JSON.stringify({
            slip_type: "BANK_SLIP_NO_QR",
            gross_amount: null,
            discount_amount: null,
            paid_amount: null,
            transfer_amount: 100,
            reference_id: `REF-${imageId}`,
            transaction_time: "2026-10-16T05:00:00.000Z",
            sender_name: "sender",
            receiver_name: "receiver",
            receiver_account_tail: "1234",
            confidence: 0.95,
          }) }] }],
        }), { status: 200 });
      } finally {
        activeProviderCalls -= 1;
      }
    }, { preconnect: fetch.preconnect }) as typeof fetch;
    const extractor = new OpenAiSlipExtractor(
      "local-test-key",
      "local-test-model",
      providerFetch,
      async (ms) => {
        requestedSleeps.push(ms);
        await new Promise((resolve) => setTimeout(resolve, 2));
      },
    );
    const checks = new SlipCheckService(supa, extractor, async () => {});

    await advance(120); // missing checks are now eligible for OCR redrive
    const ocrRun = await makeWebhook(checks).recoverSlipIngest();
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    expect(ocrRun.ocrRedriven).toBe(BURST);
    expect(maxActiveProviderCalls).toBe(SLIP_INGEST_POLICY.cron.ocrLanes);
    expect(maxActiveProviderCalls).toBeLessThanOrEqual(10);
    expect(providerAttempts.size).toBe(BURST);
    expect([...providerAttempts.values()]).toEqual(Array(BURST).fill(2));
    expect(requestedSleeps).toEqual(Array(BURST).fill(3_000));

    const accounting = (await supa.rpc("slip_batch_image_accounting", { p_batch_id: batchId })).data as {
      received_total: number; attached: number; ocr_complete: number; incomplete: number;
    };
    expect(accounting).toMatchObject({
      received_total: BURST,
      attached: BURST,
      ocr_complete: BURST,
      incomplete: 0,
    });
    expect(await count("slip_checks", "status='EXTRACTED'")).toBe(BURST);

    const pushes: string[] = [];
    await advance(60);
    expect(await finalizeNow(pushes)).toBe(1);
    const final = await batchRow(batchId);
    expect(final.status).toBe("completed");
    expect(final.success_count).toBe(BURST);
    expect(final.failed_count).toBe(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).not.toContain("ยังไม่ครบ");

    const elapsedMs = Math.round(performance.now() - startedAt);
    const heapEnd = process.memoryUsage().heapUsed;
    console.log("SLIP_CAPACITY_OBSERVATION", JSON.stringify({
      simulatedImages: BURST,
      maxParallelIngest: maxActiveDownloads,
      maxParallelOcrProviderCalls: maxActiveProviderCalls,
      provider429Responses: BURST,
      retryAfterRequestedMs: 3_000,
      elapsedMs,
      heapStartBytes: heapStart,
      peakHeapBytes: peakHeap,
      heapEndBytes: heapEnd,
      peakHeapDeltaBytes: Math.max(0, peakHeap - heapStart),
      providers: "mock LINE/OCR/Storage; disposable localhost PostgreSQL",
    }));
    expect(elapsedMs).toBeLessThan(30_000);
    expect(peakHeap).toBeGreaterThan(0);
  }, 180_000);

  // ── P1 #5 ───────────────────────────────────────────────────────────────────
  for (const gap of [SLIP_INGEST_POLICY.cron.periodSeconds, SLIP_INGEST_POLICY.cron.periodSeconds + SLIP_INGEST_POLICY.cron.assumedMaxDelaySeconds]) {
    test(`burst of 25, every image fails 4 times then succeeds, cron every ${gap} s, no in-request retries: all 25 attach, nothing closes early`, async () => {
      for (let i = 1; i <= BURST; i++) failFirst.set(`m-${G}-${i}`, 4);
      const healthy = new SlipCheckService(supa, healthyExtractor, async () => {});
      const webhook = makeWebhook(healthy);
      const batchId = await openAndReceive(webhook);
      expect(await attempts()).toEqual(Array(BURST).fill(1));

      const pushes: string[] = [];
      let elapsed = 0;
      for (let sweep = 1; sweep <= 4; sweep++) {
        await advance(gap);
        elapsed += gap;
        await webhook.recoverSlipIngest();
        await runTasks();
        // Fair list + lanes: the WHOLE burst advances one attempt per sweep
        // (before: 10 oldest per sweep, 15 left at attempt 1).
        expect(await attempts()).toEqual(Array(BURST).fill(sweep + 1));
        const attached = await count("slip_image_events", "state='attached'");
        expect(attached).toBe(sweep === 4 ? BURST : 0);
        if (sweep < 4) {
          expect(await finalizeNow(pushes)).toBe(0); // images in flight: no claim
          expect((await batchRow(batchId)).status).toBe("closing");
        }
      }
      expect(elapsed).toBeLessThan(DEFAULT_INGEST_MAX_SECONDS);

      await advance(60);
      expect(await finalizeNow(pushes)).toBe(1);
      expect(pushes[0]).toContain("2,500");
      expect(pushes[0]).not.toContain("ยังไม่ครบ");
      const final = await batchRow(batchId);
      expect(final.status).toBe("completed");
      expect(final.success_count).toBe(BURST);
      expect([...downloads.values()].every((n) => n === 5)).toBe(true);
    }, 180_000);
  }

  test("26-image burst with every recovery sweep skipped expires visibly incomplete, never completed", async () => {
    const aboveDesignBurst = SLIP_INGEST_POLICY.designBurstImages + 1;
    // Keep one verified neighbour so the terminal state is review_needed;
    // every other receipt remains durable retry_pending when all sweeps vanish.
    for (let i = 2; i <= aboveDesignBurst; i++) failFirst.set(`m-${G}-${i}`, 99);
    const healthy = new SlipCheckService(supa, healthyExtractor, async () => {});
    const batchId = await openAndReceive(makeWebhook(healthy), aboveDesignBurst);
    expect(await count("slip_image_events")).toBe(aboveDesignBurst);
    expect(await count("slip_image_events", "state='attached'")).toBe(1);
    expect(await count("slip_image_events", "state='retry_pending'")).toBe(aboveDesignBurst - 1);

    // No recoverSlipIngest call at all: model an outage/skipped scheduler past
    // the approved 36-minute cutoff, then force the honest incomplete summary.
    await advance(DEFAULT_INGEST_MAX_SECONDS + 60);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(1);
    const final = await batchRow(batchId);
    expect(final.status).toBe("review_needed");
    expect(final.success_count).toBe(1);
    expect(final.failed_count).toBe(aboveDesignBurst - 1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(`ยังไม่ครบ: ${aboveDesignBurst - 1} รูป`);
    expect(pushes[0]).not.toContain("2,600");

    const accounting = (await supa.rpc("slip_batch_image_accounting", { p_batch_id: batchId })).data as {
      received_total: number; attached: number; ocr_complete: number; incomplete: number;
    };
    expect(accounting).toMatchObject({
      received_total: aboveDesignBurst,
      attached: 1,
      ocr_complete: 1,
      incomplete: aboveDesignBurst - 1,
    });
  }, 180_000);

  test("ingest cutoff is cohort-wide: a receipt reaching the ledger late gets the full wait from its receipt", async () => {
    failFirst.set(`m-${G}-25`, 99); // still in flight (retry_pending), never attached
    const batchId = await openAndReceive(makeWebhook(new SlipCheckService(supa, healthyExtractor, async () => {})));
    expect(await count("slip_image_events", "state='retry_pending'")).toBe(1);
    await advance(DEFAULT_INGEST_MAX_SECONDS + 60);
    // ...and its receipt only reached the ledger now (late delivery / reconciliation).
    await db.query(`UPDATE slip_image_events SET received_at = now(), next_retry_at = now() + interval '1 day'
                     WHERE line_message_id='m-${G}-25'`);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(0); // close was long ago, the late receipt was not
    await advance(DEFAULT_INGEST_MAX_SECONDS);
    expect(await finalizeNow(pushes)).toBe(1);
    expect(pushes[0]).toContain("ยังไม่ครบ");
    expect((await batchRow(batchId)).status).not.toBe("completed");
  }, 120_000);
});
