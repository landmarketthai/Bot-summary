/**
 * PR #182 cross-check P0 #1 — finalizer accounting must fail closed.
 *
 * Runs the REAL finalizeSlipBatch / finalizeClosingSlipBatches /
 * finalizeDueSlipBatches / recoverStaleProcessingSlipBatches / recoverSlipBatch
 * against the real migrations on disposable PostgreSQL 17. Only the accounting
 * RPC (slip_batch_image_accounting) is made to fail, by wrapping the adapter's
 * rpc; every assertion reads durable database state.
 *
 * Codex case: 2 images received, 1 attached + OCR ok, 1 failed_permanent, the
 * accounting RPC errors (57014). BEFORE the fix the finalizer sent a summary
 * without the missing notice, wrote status=completed and failed_count=0.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/finalizer-accounting.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { WebhookService } from "@/lib/line/webhook-service";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import {
  finalizeClosingSlipBatches,
  finalizeDueSlipBatches,
  recoverStaleProcessingSlipBatches,
} from "@/lib/slips/batch-finalizer";
import { recoverSlipBatch } from "@/lib/slips/batch-recovery";
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
type AccountingMode = "ok" | "timeout" | "throw" | "malformed" | "missing_fn";

const T0 = 1_760_000_000_000;
const G = "G-accounting";

let db: SlipTestDb;
let storage: FakeStorage;
let supa: AnySupabase; // healthy adapter
let accountingMode: AccountingMode;
let accountingCalls: number;
let flaky: AnySupabase; // same DB, accounting RPC injected to fail per accountingMode
let failedMessageIds: Set<string>;
let backgroundTasks: Array<() => Promise<void>>;

async function download(messageId: string) {
  if (failedMessageIds.has(messageId)) throw new Error("simulated LINE content 500");
  return { bytes: new TextEncoder().encode(`img:${messageId}`), mimeType: "image/jpeg" };
}

const noGuidedRound = {
  resolve: async () => ({ stage: "idle", reason: "no_session" }),
  findRoundOwner: async () => ({ kind: "none" as const }),
};

function makeWebhook(): WebhookService {
  return new WebhookService(supa, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guidedJourneyService: noGuidedRound as any,
    evidenceIngestor: new SlipEvidenceService(supa, download),
    checkProcessor: {
      processEvidence: async (evidenceId: string) => {
        await db.query(
          `INSERT INTO slip_checks (evidence_id, status, slip_type, transfer_amount, transaction_time)
           VALUES ('${evidenceId}', 'EXTRACTED', 'BANK_SLIP_QR', 100, '2026-10-16T12:00:00+07')
           ON CONFLICT (evidence_id) DO NOTHING`,
        );
      },
    },
    scheduleBackgroundTask: (task) => { backgroundTasks.push(task); },
    slipRetrySleep: async () => {}, // backoff is exercised via explicit makeRetryDue/recover in these suites
    replyMessage: async () => {},
  });
}

/** Same database; only slip_batch_image_accounting misbehaves, per accountingMode. */
function makeFlakyClient(base: AnySupabase): AnySupabase {
  return {
    ...base,
    from(table: string) {
      const builder = base.from(table);
      // The harness adapter has no .or(); the window filter is irrelevant for
      // these in-window fixture batches, so the shim leaves the query as is.
      if (typeof builder.or !== "function") builder.or = () => builder;
      return builder;
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      if (name !== "slip_batch_image_accounting") return base.rpc(name, args);
      accountingCalls += 1;
      switch (accountingMode) {
        case "timeout":
          return { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } };
        case "throw":
          throw new Error("fetch failed: network down");
        case "malformed":
          return { data: { received_total: 2, attached: 1 }, error: null }; // partial payload
        case "missing_fn":
          return { data: null, error: { code: "PGRST202", message: "Could not find the function in the schema cache" } };
        default:
          return base.rpc(name, args);
      }
    },
  };
}

function imageEvent(n: number, ts: number) {
  return {
    type: "message",
    webhookEventId: `evt-${G}-${n}`,
    timestamp: ts,
    replyToken: `rt-${G}-${n}`,
    mode: "active",
    source: { type: "group", groupId: G, userId: "U-seller" },
    message: { type: "image", id: `m-${G}-${n}`, contentProvider: { type: "line" } },
  };
}

async function openBatch(openTs = T0): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name,
                               slip_date, header_text, open_event_ts_ms)
     VALUES ('${G}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569',
             'น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569', ${openTs}) RETURNING id`,
  );
  return rows[0].id;
}

async function runTasks(): Promise<void> {
  while (backgroundTasks.length > 0) await backgroundTasks.shift()!();
}

async function backdate(batchId: string, seconds: number): Promise<void> {
  await db.query(
    `UPDATE slip_batches SET closing_at = closing_at - interval '${seconds} seconds',
            last_image_at = last_image_at - interval '${seconds} seconds' WHERE id='${batchId}'`,
  );
}

const batchRow = async (id: string) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM slip_batches WHERE id='${id}'`))[0];
const ledgerState = (messageNo: number) =>
  db.scalar(`SELECT state FROM slip_image_events WHERE line_message_id='m-${G}-${messageNo}'`);

/**
 * Codex fixture: 2 images received (LINE order), image 1 attached + OCR ok,
 * image 2 failed_permanent after the full 5-attempt budget; batch is closing,
 * quiet period elapsed. Nothing has been finalized yet.
 */
async function codexFixture(): Promise<string> {
  const batchId = await openBatch();
  failedMessageIds.add(`m-${G}-2`);
  const webhook = makeWebhook();
  for (const [n, ts] of [[1, T0 + 1000], [2, T0 + 2000]] as const) {
    await webhook.processEvents([imageEvent(n, ts)] as never, "dest", { deferOrderedProcessing: true });
  }
  await db.query(
    `UPDATE slip_batches SET status='closing', closing_at=now(), close_event_ts_ms=${T0 + 3000} WHERE id='${batchId}'`,
  );
  await runTasks();
  for (let attempt = 2; attempt <= 6; attempt++) {
    await db.query(
      `UPDATE slip_image_events SET next_retry_at = now() - interval '1 second' WHERE line_message_id='m-${G}-2'`,
    );
    await webhook.recoverSlipIngest();
    await runTasks();
  }
  expect(await ledgerState(1)).toBe("attached");
  expect(await ledgerState(2)).toBe("failed_permanent");
  expect(await db.scalar("SELECT count(*) FROM slip_checks WHERE status='EXTRACTED'")).toBe("1");
  await backdate(batchId, 60);
  return batchId;
}

function expectNothingCertified(row: Record<string, unknown>, pushes: string[]) {
  expect(pushes).toHaveLength(0); // no LINE summary
  expect(row.status).toBe("processing"); // not completed / failed / review_needed
  expect(row.summary_sent_at).toBeNull();
  expect(row.finalized_at).toBeNull();
  expect(Number(row.failed_count ?? 0)).toBe(0); // no fabricated counts either way
}

describe.skipIf(!pgAvailable)("finalizer accounting fails closed (PR182 P0 #1) on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_acct");
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
    accountingMode = "ok";
    accountingCalls = 0;
    flaky = makeFlakyClient(supa);
    failedMessageIds = new Set();
    backgroundTasks = [];
  });

  for (const mode of ["timeout", "throw", "malformed", "missing_fn"] as const) {
    test(`Codex case, accounting ${mode}: no summary, stays processing; next healthy sweep sends ONE summary with the missing notice`, async () => {
      const batchId = await codexFixture();
      const pushes: string[] = [];
      const push = async (_to: string, text: string) => { pushes.push(text); };

      // 1. Closing finalizer claims the batch, accounting is unavailable.
      accountingMode = mode;
      const finalized = await finalizeClosingSlipBatches(flaky, push, 10, 120);
      expect(finalized).toBe(0);
      expect(accountingCalls).toBeGreaterThan(0);
      expectNothingCertified(await batchRow(batchId), pushes);

      // 2. Recovery sweep while accounting is still down: still nothing certified,
      //    and the failure is VISIBLE in the run result.
      const failingRun = await recoverStaleProcessingSlipBatches(flaky, push, -1);
      expect(failingRun.accountingUnavailable).toBe(1);
      expect(failingRun.failed).toBe(1);
      expect(failingRun.recovered).toBe(0);
      expectNothingCertified(await batchRow(batchId), pushes);

      // Manual recover route path also fails closed.
      const manual = await recoverSlipBatch(flaky, batchId, push);
      expect(manual.ok).toBe(false);
      expect(manual.result).toBe("delivery_failed");
      expectNothingCertified(await batchRow(batchId), pushes);

      // 3. Accounting healthy again: exactly one summary, with the missing notice.
      accountingMode = "ok";
      const healthyRun = await recoverStaleProcessingSlipBatches(flaky, push, -1);
      expect(healthyRun.recovered).toBe(1);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toContain("ยอดนี้ยังไม่ครบ");
      expect(pushes[0]).toContain("รับรูปจาก LINE: 2 รูป");
      expect(pushes[0]).toContain("เข้าชุดแล้ว: 1 รูป");
      expect(pushes[0]).toContain("ยังไม่ครบ: 1 รูป");
      expect(pushes[0]).toContain("100"); // the one read slip, nothing invented for the lost one

      const final = await batchRow(batchId);
      expect(final.status).toBe("review_needed"); // never completed with a missing image
      expect(final.success_count).toBe(1);
      expect(final.failed_count).toBe(1); // missing image counted, not zero
      expect(final.summary_sent_at).not.toBeNull();

      // Replay: idempotent, no second summary.
      const replay = await recoverStaleProcessingSlipBatches(flaky, push, -1);
      expect(replay.due).toBe(0);
      expect(pushes).toHaveLength(1);
    }, 120_000);
  }

  test("accounting recovered between claim and retry via finalizeClosingSlipBatches alone (control: healthy path)", async () => {
    const batchId = await codexFixture();
    const pushes: string[] = [];
    const finalized = await finalizeClosingSlipBatches(flaky, async (_t, text) => { pushes.push(text); }, 10, 120);
    expect(finalized).toBe(1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("ยังไม่ครบ: 1 รูป");
    const final = await batchRow(batchId);
    expect(final.status).toBe("review_needed");
    expect(final.failed_count).toBe(1);
  }, 120_000);

  test("every image failed permanently (zero evidences) + accounting down: no 'no images' summary, status untouched", async () => {
    const batchId = await openBatch();
    failedMessageIds.add(`m-${G}-1`);
    const webhook = makeWebhook();
    await webhook.processEvents([imageEvent(1, T0 + 1000)] as never, "dest", { deferOrderedProcessing: true });
    await db.query(
      `UPDATE slip_batches SET status='closing', closing_at=now(), close_event_ts_ms=${T0 + 3000} WHERE id='${batchId}'`,
    );
    await runTasks();
    for (let attempt = 2; attempt <= 6; attempt++) {
      await db.query(`UPDATE slip_image_events SET next_retry_at = now() - interval '1 second'`);
      await webhook.recoverSlipIngest();
      await runTasks();
    }
    expect(await ledgerState(1)).toBe("failed_permanent");
    await backdate(batchId, 60);

    const pushes: string[] = [];
    const push = async (_to: string, text: string) => { pushes.push(text); };
    accountingMode = "timeout";
    await finalizeClosingSlipBatches(flaky, push, 10, 120);
    expectNothingCertified(await batchRow(batchId), pushes);

    accountingMode = "ok";
    await recoverStaleProcessingSlipBatches(flaky, push, -1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("บันทึกเข้าชุดไม่สำเร็จ");
    expect(pushes[0]).toContain("ยังไม่ครบ: 1 รูป");
    const final = await batchRow(batchId);
    expect(final.status).toBe("failed"); // zero attached: failed, never completed / zero baht "ok"
    expect(final.summary_sent_at).not.toBeNull();
  }, 120_000);

  test("abandoned collecting batch with an in-flight image: never completed; failing accounting leaves it processing", async () => {
    const batchId = await openBatch();
    failedMessageIds.add(`m-${G}-2`);
    const webhook = makeWebhook();
    for (const [n, ts] of [[1, T0 + 1000], [2, T0 + 2000]] as const) {
      await webhook.processEvents([imageEvent(n, ts)] as never, "dest", { deferOrderedProcessing: true });
    }
    await runTasks(); // image 1 attached; image 2 retry_pending (in flight)
    expect(await ledgerState(1)).toBe("attached");
    expect(await ledgerState(2)).toBe("retry_pending");
    // Idle past the abandonment window (batch never closed by the user).
    await db.query(`UPDATE slip_batches SET last_image_at = now() - interval '3 hours' WHERE id='${batchId}'`);

    const pushes: string[] = [];
    const push = async (_to: string, text: string) => { pushes.push(text); };

    // Accounting down: finalizeDueSlipBatches claims (collecting->processing) but certifies nothing,
    // and does not throw / block other batches.
    accountingMode = "timeout";
    await finalizeDueSlipBatches(flaky, push, 60);
    expectNothingCertified(await batchRow(batchId), pushes);

    // Healthy: summary states the gap; in-flight image makes the batch review_needed, never completed.
    accountingMode = "ok";
    await recoverStaleProcessingSlipBatches(flaky, push, -1);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("ยอดนี้ยังไม่ครบ");
    expect(pushes[0]).toContain("ยังประมวลผลไม่เสร็จ: 1 รูป");
    const final = await batchRow(batchId);
    expect(final.status).toBe("review_needed");
    expect(final.failed_count).toBe(1);
  }, 120_000);
});
