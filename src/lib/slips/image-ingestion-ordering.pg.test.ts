/**
 * P0 #2 / #3 (PR #182 cross-check) — ordering of session commands and slip
 * images inside ONE webhook payload, and "no legacy fallback on transient
 * ledger errors", proven on real PostgreSQL 17 through the production
 * WebhookService.processEvents. Only the LINE download, Storage and the OCR
 * provider are simulated.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/image-ingestion-ordering.pg.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WebhookService } from "@/lib/line/webhook-service";
import { SLIP_INGEST_POLICY } from "@/lib/slips/ingest-policy";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";
import { isMissingLedger } from "@/lib/slips/image-ingestion";
import {
  ROOT,
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

interface DownloadPlan { failAlways?: boolean; failFirst?: number; hang?: boolean; calls: number }
let downloadPlan: Map<string, DownloadPlan>;
let replies: string[];
let backgroundTasks: Array<() => Promise<void>>;

const T0 = 1_760_000_000_000;
const HEADER = "น้อย-ราชพฤกษ์ สลิปเงินโอน 16/10/2569";

async function download(messageId: string) {
  const plan = downloadPlan.get(messageId) ?? { calls: 0 };
  downloadPlan.set(messageId, plan);
  plan.calls += 1;
  if (plan.hang) return new Promise<never>(() => {});
  if (plan.failAlways || (plan.failFirst !== undefined && plan.calls <= plan.failFirst)) {
    throw new Error("simulated LINE content 500");
  }
  return { bytes: new TextEncoder().encode(`img:${messageId}`), mimeType: "image/jpeg" };
}

const noGuidedRound = {
  resolve: async () => ({ stage: "idle", reason: "no_session" }),
  findRoundOwner: async () => ({ kind: "none" as const }),
};

function makeWebhook(client: AnySupabase = supa, extra: Record<string, unknown> = {}): WebhookService {
  return new WebhookService(client, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guidedJourneyService: noGuidedRound as any,
    evidenceIngestor: new SlipEvidenceService(supa, download),
    checkProcessor: {
      processEvidence: async (evidenceId: string) => {
        await db.query(
          `INSERT INTO slip_checks (evidence_id, status, slip_type, transfer_amount, transaction_time, reference_id)
           VALUES ('${evidenceId}', 'EXTRACTED', 'BANK_SLIP_QR', 100, '2026-10-16T12:00:00+07', 'REF-${evidenceId}')
           ON CONFLICT (evidence_id) DO NOTHING`,
        );
      },
    },
    scheduleBackgroundTask: (task) => { backgroundTasks.push(task); },
    replyMessage: async (_token: string, text: string) => { replies.push(text); },
    // Production waits out the ledger backoff; tests default to a no-op wait.
    slipRetrySleep: async () => {},
    ...extra,
  });
}

function imageEvent(source: string, n: string | number, ts: number) {
  const id = `evt-${source}-${n}`;
  return {
    type: "message", webhookEventId: id, timestamp: ts, replyToken: `rt-${id}`, mode: "active",
    source: { type: "group", groupId: source, userId: "U-seller" },
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

async function openBatch(source: string, openTs = T0): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name,
                               slip_date, header_text, open_event_ts_ms)
     VALUES ('${source}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569',
             '${HEADER}', ${openTs}) RETURNING id`,
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
  while (backgroundTasks.length > 0) await backgroundTasks.shift()!();
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
const count = async (table: string, where = "TRUE") =>
  Number(await db.scalar(`SELECT count(*) FROM ${table} WHERE ${where}`));
const batchRow = async (id: string) =>
  (await db.query<Record<string, unknown>>(`SELECT * FROM slip_batches WHERE id='${id}'`))[0];

async function finalizeNow(pushes: string[]) {
  return finalizeClosingSlipBatches(supa, async (_to, text) => { pushes.push(text); }, 10, 120);
}

async function makeRetryDue(lineMessageId: string) {
  await db.query(
    `UPDATE slip_image_events SET next_retry_at = now() - interval '1 second' WHERE line_message_id='${lineMessageId}'`,
  );
}

/** supa whose begin_slip_image_attempt misbehaves; everything else is real. */
function flakyBegin(behave: () => unknown): AnySupabase {
  return {
    ...supa,
    rpc: (name: string, args?: Record<string, unknown>) =>
      name === "begin_slip_image_attempt" ? Promise.resolve().then(behave) : supa.rpc(name, args),
  };
}

describe("isMissingLedger: the only legacy-fallback predicate", () => {
  test("replies: only 42883 / PGRST202 qualify", () => {
    expect(isMissingLedger({ code: "42883", message: "function does not exist" })).toBe(true);
    expect(isMissingLedger({ code: "PGRST202", message: "Could not find the function" })).toBe(true);
    for (const code of ["57014", "08006", "08001", "40001", "40P01", "XX000", "P0001", "PGRST301", "PGRST000", "23514", undefined]) {
      expect(isMissingLedger({ code, message: "unexpected rpc begin_slip_image_attempt" })).toBe(false);
    }
  });

  test("throws: only a unit double's 'unexpected rpc <name>' qualifies", () => {
    expect(isMissingLedger(new Error("unexpected rpc: begin_slip_image_attempt"), true)).toBe(true);
    expect(isMissingLedger(new Error("Unexpected RPC begin_slip_image_attempt"), true)).toBe(true);
    for (const message of [
      "fetch failed: ETIMEDOUT",
      "Unexpected token < in JSON at position 0 while reading RPC reply",
      "Unexpected end of JSON input",
      "canceling statement due to statement timeout",
    ]) {
      expect(isMissingLedger(new Error(message), true)).toBe(false);
    }
    expect(isMissingLedger("unexpected rpc x", true)).toBe(false);
    expect(isMissingLedger(null, true)).toBe(false);
  });

  test("the ledger migration has no catch-all exception handler", () => {
    const sql = readFileSync(`${ROOT}/supabase/migrations/20261017100000_slip_image_ingestion_ledger.sql`, "utf8");
    expect(/WHEN\s+OTHERS/i.test(sql)).toBe(false);
  });
});

describe.skipIf(!pgAvailable)("P0 #2/#3 ordering + no permissive fallback on PostgreSQL 17", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_order");
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
    replies = [];
    backgroundTasks = [];
  });

  // ── P0 #2: [open, img1..img25 (img13 fails), close] in ONE payload ──────────
  describe.each([
    { name: "deferred drain", defer: true },
    { name: "inline drain", defer: false },
  ])("one payload [open, 25 images, close] with a failing middle image ($name)", ({ defer }) => {
    test("session opens first, all 25 are ledgered to it, close waits for them, summary is never 'completed'", async () => {
      const G = `G-p25-${defer}`;
      downloadPlan.set(`m-${G}-13`, { failAlways: true, calls: 0 });
      const webhook = makeWebhook();
      const events = [
        textEvent(G, "evt-open", HEADER, T0),
        ...Array.from({ length: 25 }, (_, i) => imageEvent(G, i + 1, T0 + 1000 * (i + 1))),
        textEvent(G, "evt-close", "จบสลิป", T0 + 26_000),
      ];

      const results = await deliver(webhook, events, defer);

      if (defer) {
        // Nothing processed yet, but EVERY image receipt is already durable.
        expect(await count("slip_batches")).toBe(0);
        const early = await ledger();
        expect(early).toHaveLength(25);
        expect(early.every((r) => r.state === "unbound" && r.batch_id === null)).toBe(true);
        expect(await count("line_webhook_event_queue", "status = 'pending'")).toBe(27); // open + close are ordered too
        await runTasks();
      } else {
        expect(results.every((r) => r.status === "saved")).toBe(true);
      }

      expect(await count("slip_batches", `source_id='${G}'`)).toBe(1);
      const batchId = await db.scalar(`SELECT id FROM slip_batches WHERE source_id='${G}'`);
      const batch = await batchRow(batchId);
      expect(batch.status).toBe("closing");
      expect(Number(batch.open_event_ts_ms)).toBe(T0);
      expect(Number(batch.close_event_ts_ms)).toBe(T0 + 26_000);

      // processSlipOpen ran before any image and its reply was still delivered.
      expect(replies[0]).toContain("เปิดชุดสลิปเงินโอนแล้ว");
      expect(replies.some((r) => r.includes("รับรูปหลักฐานแล้ว"))).toBe(true);
      expect(replies.some((r) => r.includes("รับคำสั่งจบชุดแล้ว"))).toBe(true);
      expect(replies.indexOf(replies.find((r) => r.includes("รับคำสั่งจบชุดแล้ว"))!))
        .toBeGreaterThan(replies.findIndex((r) => r.includes("รับรูปหลักฐานแล้ว")));

      const rows = await ledger(batchId);
      expect(rows).toHaveLength(25);
      expect(await count("slip_image_events")).toBe(25);
      expect(rows.filter((r) => r.state === "attached")).toHaveLength(24);
      expect(rows.find((r) => r.line_message_id === `m-${G}-13`)!.state).toBe("retry_pending");
      expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(27);
      expect((await batchRow(batchId)).image_count).toBe(24);

      // Close happened but the batch must wait for the owed retry.
      await runTasks();
      await backdate(batchId, 30);
      const pushes: string[] = [];
      expect(await finalizeNow(pushes)).toBe(0);
      expect((await batchRow(batchId)).status).toBe("closing");

      for (let attempt = 2; attempt <= 5; attempt++) {
        await makeRetryDue(`m-${G}-13`);
        await webhook.recoverSlipIngest();
      }
      await runTasks();
      expect((await ledger(batchId)).find((r) => r.line_message_id === `m-${G}-13`)!.state)
        .toBe("failed_permanent");

      await backdate(batchId, 30);
      expect(await finalizeNow(pushes)).toBe(1);
      expect(pushes).toHaveLength(1);
      expect(pushes[0]).toContain("รับรูปจาก LINE: 25 รูป");
      expect(pushes[0]).toContain("ยังไม่ครบ: 1 รูป");
      const final = await batchRow(batchId);
      expect(final.status).toBe("review_needed");
      expect(final.success_count).toBe(24);
      expect(final.failed_count).toBe(1);
    }, 180_000);
  });

  // ── P0 #2: an image sent BEFORE the open command is not this session's ──────
  describe.each([
    { name: "deferred drain", defer: true },
    { name: "inline drain", defer: false },
  ])("image with an earlier LINE timestamp than the open command ($name)", ({ defer }) => {
    test("same payload [early image, open, image]: early one is never attributed to the later session", async () => {
      const G = `G-early-${defer}`;
      const webhook = makeWebhook();
      await deliver(webhook, [
        imageEvent(G, "early", T0 - 5000),
        textEvent(G, "evt-open", HEADER, T0),
        imageEvent(G, 1, T0 + 1000),
      ], defer);
      if (defer) await runTasks();

      const batchId = await db.scalar(`SELECT id FROM slip_batches WHERE source_id='${G}'`);
      const rows = await ledger();
      expect(rows).toHaveLength(2);
      const early = rows.find((r) => r.line_message_id === `m-${G}-early`)!;
      expect(early.state).toBe("no_session");
      expect(early.batch_id).toBeNull();
      expect(early.evidence_id).toBeNull();
      const inside = rows.find((r) => r.line_message_id === `m-${G}-1`)!;
      expect(inside.state).toBe("attached");
      expect(inside.batch_id).toBe(batchId);
      expect((await batchRow(batchId)).image_count).toBe(1);
      expect(await count("slip_evidences", `line_message_id='m-${G}-early'`)).toBe(0);
    }, 60_000);

    test("same payload [open, early image]: processed after the open, still not attributed", async () => {
      const G = `G-early2-${defer}`;
      const webhook = makeWebhook();
      await deliver(webhook, [
        textEvent(G, "evt-open", HEADER, T0),
        imageEvent(G, "early", T0 - 5000),
      ], defer);
      if (defer) await runTasks();

      const batchId = await db.scalar(`SELECT id FROM slip_batches WHERE source_id='${G}'`);
      const rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe("no_session");
      expect(rows[0].batch_id).toBeNull();
      expect((await batchRow(batchId)).image_count).toBe(0);
      expect(await count("slip_evidences")).toBe(0);
    }, 60_000);

    test("early image stays unattributed even when a LATER session opens afterwards", async () => {
      const G = `G-early3-${defer}`;
      const webhook = makeWebhook();
      await deliver(webhook, [imageEvent(G, "early", T0 - 5000)], defer);
      if (defer) await runTasks();
      await deliver(webhook, [textEvent(G, "evt-open", HEADER, T0)], defer);
      if (defer) await runTasks();

      const rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe("no_session");
      expect(rows[0].batch_id).toBeNull();
      expect(await count("slip_evidences")).toBe(0);
    }, 60_000);
  });

  // ── P0 #3 (a): ledger failure inside a multi-event payload ──────────────────
  test("ledger insert failure on the middle image rolls back the whole ordered payload; redelivery completes the set", async () => {
    const G = "G-mid-boom";
    const webhook = makeWebhook();
    const payload = [
      textEvent(G, "evt-open", HEADER, T0),
      imageEvent(G, 1, T0 + 1000),
      imageEvent(G, 2, T0 + 2000),
      imageEvent(G, 3, T0 + 3000),
    ];
    await db.query(
      `ALTER TABLE slip_image_events ADD CONSTRAINT zz_boom CHECK (line_message_id <> 'm-${G}-2')`,
    );
    try {
      const results = await deliver(webhook, payload, false);
      expect(results.slice(1).every((result) => result.status === "error" && result.retryable)).toBe(true);
      expect(await count("raw_messages")).toBe(1); // safe open prefix only
      expect(await count("line_webhook_event_queue")).toBe(1);
      expect(await count("slip_image_events")).toBe(0);
    } finally {
      await db.query("ALTER TABLE slip_image_events DROP CONSTRAINT zz_boom");
    }

    // LINE redelivers the whole payload: others are duplicates, img2 is now ledgered.
    const again = await deliver(webhook, payload, false);
    expect(again.filter((r) => r.status === "duplicate")).toHaveLength(1);
    const batchId = await db.scalar(`SELECT id FROM slip_batches WHERE source_id='${G}'`);
    const rows = await ledger(batchId);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.state === "attached")).toBe(true);
    expect((await batchRow(batchId)).image_count).toBe(3);
    expect(await count("line_webhook_event_queue", "status <> 'processed'")).toBe(0);
  }, 60_000);

  test("[open, 25 images, close] receipt failure cannot be finalized before delayed redelivery", async () => {
    const G = "G-atomic-close";
    const webhook = makeWebhook();
    const payload = [
      textEvent(G, "evt-open", HEADER, T0),
      ...Array.from({ length: 25 }, (_, i) => imageEvent(G, i + 1, T0 + 1000 * (i + 1))),
      textEvent(G, "evt-close", "จบสลิป", T0 + 26_000),
    ];
    await db.query(
      `ALTER TABLE slip_image_events ADD CONSTRAINT zz_atomic_close_boom
       CHECK (line_message_id <> 'm-${G}-6')`,
    );
    try {
      const failed = await deliver(webhook, payload, true);
      expect(failed.slice(1).every((result) => result.status === "error" && result.retryable)).toBe(true);
      expect(backgroundTasks).toHaveLength(1);
      expect(await count("raw_messages")).toBe(1); // open is a safe prefix
      expect(await count("line_webhook_event_queue")).toBe(1);
      expect(await count("slip_image_events")).toBe(0);
      await runTasks();
      expect(await count("slip_batches", `source_id='${G}' AND status='collecting'`)).toBe(1);
      expect(await finalizeNow([])).toBe(0);
    } finally {
      await db.query("ALTER TABLE slip_image_events DROP CONSTRAINT zz_atomic_close_boom");
    }

    await deliver(webhook, payload, true);
    await runTasks();
    const batchId = await db.scalar(`SELECT id FROM slip_batches WHERE source_id='${G}'`);
    expect(await count("slip_image_events", `batch_id='${batchId}' AND state='attached'`)).toBe(25);
    await backdate(batchId, 1300);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(1);
    expect((await batchRow(batchId)).status).toBe("completed");
    expect((await batchRow(batchId)).image_count).toBe(25);
    expect(pushes.join("\n")).toContain("2,500");
  }, 120_000);

  test("concurrent redelivery of one same-source payload leaves one complete processable set", async () => {
    const G = "G-atomic-concurrent";
    const payload = [
      textEvent(G, "evt-open", HEADER, T0),
      imageEvent(G, 1, T0 + 1000),
      imageEvent(G, 2, T0 + 2000),
      textEvent(G, "evt-close", "จบสลิป", T0 + 3000),
    ];
    const deliveries = await Promise.all([
      deliver(makeWebhook(), payload, true),
      deliver(makeWebhook(), payload, true),
    ]);
    expect(deliveries.flat()).toHaveLength(8);
    expect(await count("raw_messages")).toBe(4);
    expect(await count("line_webhook_event_queue")).toBe(4);
    expect(await count("slip_image_events")).toBe(2);

    await runTasks();
    expect(await count("slip_batches", `source_id='${G}'`)).toBe(1);
    const batchId = await db.scalar(`SELECT id FROM slip_batches WHERE source_id='${G}'`);
    expect(await count("slip_image_events", `batch_id='${batchId}' AND state='attached'`)).toBe(2);
    expect(await count("line_webhook_event_queue", "status <> 'processed'")).toBe(0);
  }, 120_000);

  test("missing internal receive trigger helper fails closed across redelivery and close", async () => {
    const G = "G-missing-receive-helper";
    const webhook = makeWebhook();
    await deliver(webhook, [
      textEvent(G, "evt-open", HEADER, T0),
      imageEvent(G, 1, T0 + 1000),
    ], true);
    await runTasks();
    const batchId = await db.scalar(`SELECT id FROM slip_batches WHERE source_id='${G}'`);

    await db.query(
      "ALTER FUNCTION public.resolve_slip_image_batch(text,bigint) RENAME TO review_missing_resolve_slip_image_batch",
    );
    try {
      const received = await deliver(webhook, [
        imageEvent(G, 2, T0 + 2000),
        textEvent(G, "evt-close", "จบสลิป", T0 + 3000),
      ], true);
      expect(received.every((result) => result.status === "saved")).toBe(true);
      await runTasks();
      expect(await count("raw_messages", `message_id='m-${G}-2'`)).toBe(1);
      expect(await count("raw_messages", "line_event_id='evt-close'")).toBe(1);
      expect(await count("slip_image_events", `line_message_id='m-${G}-2' AND state='unbound'`)).toBe(1);
      expect(await count("line_webhook_event_queue", "line_event_id='evt-close' AND status='pending'")).toBe(1);

      const [redelivery] = await deliver(webhook, [imageEvent(G, 2, T0 + 2000)], true);
      expect(redelivery.status).toBe("duplicate");
      await runTasks();
      expect(await count("raw_messages", `message_id='m-${G}-2'`)).toBe(1);
      expect(await finalizeNow([])).toBe(0);
      expect((await batchRow(batchId)).status).toBe("collecting");
      expect((await batchRow(batchId)).image_count).toBe(1);
    } finally {
      await db.query(
        "ALTER FUNCTION public.review_missing_resolve_slip_image_batch(text,bigint) RENAME TO resolve_slip_image_batch",
      );
    }

    await deliver(webhook, [
      imageEvent(G, 2, T0 + 2000),
      textEvent(G, "evt-close", "จบสลิป", T0 + 3000),
    ], true);
    await runTasks();
    await backdate(batchId, 1300);
    const pushes: string[] = [];
    expect(await finalizeNow(pushes)).toBe(1);
    const done = await batchRow(batchId);
    expect(done.status).toBe("completed");
    expect(done.image_count).toBe(2);
    expect(done.success_count).toBe(2);
    expect(pushes.join("\n")).toContain("200");
  }, 120_000);

  // ── P0 #3 (b): begin errors keep the image pending; recovery then succeeds ──
  describe.each([
    { name: "57014 statement timeout reply", behave: () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }) },
    { name: "08006 connection failure reply", behave: () => ({ data: null, error: { code: "08006", message: "connection failure" } }) },
    { name: "malformed reply (no error, no claimed flag)", behave: () => ({ data: null, error: null }) },
    { name: "thrown network error", behave: () => { throw new Error("fetch failed: ETIMEDOUT"); } },
    { name: "thrown 'Unexpected token' JSON error", behave: () => { throw new Error("Unexpected token < in JSON at position 0 (rpc)"); } },
  ])("begin_slip_image_attempt: $name", ({ behave }) => {
    test("image stays pending in the queue (not legacy-attached, not acknowledged); recovery attaches it later", async () => {
      const G = "G-begin-err";
      const batchId = await openBatch(G); // collecting: exactly what the legacy path would attach to
      const [outage] = await deliver(makeWebhook(flakyBegin(behave)), [imageEvent(G, 1, T0 + 1000)], false);

      expect(outage.status).toBe("error");
      expect(outage.retryable).toBe(true);
      expect(await count("line_webhook_event_queue", "status = 'pending'")).toBe(1);
      expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(0);
      expect(await count("slip_evidences")).toBe(0);
      expect(await count("raw_messages", "is_processed = true")).toBe(0);
      expect((await batchRow(batchId)).image_count).toBe(0);
      const during = await ledger(batchId);
      expect(during).toHaveLength(1);
      expect(during[0].state).toBe("received");
      expect(during[0].attempts).toBe(0);

      // Outage over: the cron recovery drains the queue.
      await makeWebhook().recoverSlipIngest();
      await runTasks();
      const after = await ledger(batchId);
      expect(after[0].state).toBe("attached");
      expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(1);
      expect((await batchRow(batchId)).image_count).toBe(1);
    }, 60_000);
  });

  // ── P0 #3 (c): post-close image + begin timeout never joins any batch ──────
  test("image sent after close + begin timeout: never attached to the closing batch; later resolved as excluded_after_close", async () => {
    const G = "G-post-close";
    const batchId = await openBatch(G);
    await closeBatchSql(batchId, T0 + 10_000);
    const timeout = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });

    const [outage] = await deliver(makeWebhook(flakyBegin(timeout)), [imageEvent(G, "late", T0 + 15_000)], false);
    expect(outage.status).toBe("error");
    expect(await count("slip_evidences")).toBe(0);
    expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(0);
    expect((await batchRow(batchId)).image_count).toBe(0);

    await makeWebhook().recoverSlipIngest();
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("excluded_after_close");
    expect(rows[0].batch_id).toBe(batchId);
    expect(await count("slip_evidences")).toBe(0);
    expect((await batchRow(batchId)).image_count).toBe(0);
    expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(1);
  }, 60_000);

  // ── P0 #3 (d): legacy path ONLY when the ledger function is verifiably absent
  describe.each([
    { name: "42883 undefined_function reply", behave: () => ({ data: null, error: { code: "42883", message: "function begin_slip_image_attempt does not exist" } }) },
    { name: "PGRST202 function-not-found reply", behave: () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } }) },
    { name: "unit double throwing 'unexpected rpc'", behave: () => { throw new Error("unexpected rpc: begin_slip_image_attempt"); } },
  ])("missing ledger RPC on migrated schema: $name", ({ behave }) => {
    test("keeps a post-close image pending without bypassing the ledger", async () => {
      const G = "G-legacy-ok";
      const batchId = await openBatch(G);
      await closeBatchSql(batchId, T0 + 500);
      const [res] = await deliver(makeWebhook(flakyBegin(behave)), [imageEvent(G, 1, T0 + 1000)], false);
      expect(res.status).toBe("error");
      expect(res.retryable).toBe(true);
      expect(await count("line_webhook_event_queue", "status = 'pending'")).toBe(1);
      expect(await count("slip_evidences")).toBe(0);
      expect((await batchRow(batchId)).image_count).toBe(0);
    }, 60_000);
  });

  // ── P1 #5: in-request retry, fenced by the ledger ───────────────────────────
  test("in-request retry: an image failing on attempt 1 is attached by the same request, no cron", async () => {
    const G = "G-inreq";
    const batchId = await openBatch(G);
    downloadPlan.set(`m-${G}-1`, { failFirst: 1, calls: 0 });
    const M = `m-${G}-1`;
    // Waiting out the backoff == the retry becoming due.
    const webhook = makeWebhook(supa, { slipRetrySleep: async () => { await makeRetryDue(M); } });

    await deliver(webhook, [imageEvent(G, 1, T0 + 1000)], false);
    expect((await ledger(batchId))[0].state).toBe("retry_pending");
    expect(backgroundTasks.length).toBeGreaterThan(0); // the retry is its own task

    await runTasks(); // no recoverSlipIngest anywhere
    const row = (await ledger(batchId))[0];
    expect(row.state).toBe("attached");
    expect(row.attempts).toBe(2);
    expect(downloadPlan.get(M)!.calls).toBe(2);
    expect(await count("slip_evidences", `batch_id='${batchId}'`)).toBe(1);
    expect((await batchRow(batchId)).image_count).toBe(1);
    expect(await count("line_webhook_event_queue", "status = 'processed'")).toBe(1);
  }, 60_000);

  test("in-request retry racing a cron recoverSlipIngest never duplicates evidence or batch_index", async () => {
    const G = "G-inreq-race";
    const batchId = await openBatch(G);
    const msgs = [1, 2, 3].map((n) => `m-${G}-${n}`);
    for (const m of msgs) downloadPlan.set(m, { failFirst: 1, calls: 0 });
    const webhook = makeWebhook(supa, {
      slipRetrySleep: async () => { for (const m of msgs) await makeRetryDue(m); },
    });
    await deliver(webhook, [1, 2, 3].map((n) => imageEvent(G, n, T0 + 1000 * n)), false);
    expect((await ledger(batchId)).every((r) => r.state === "retry_pending")).toBe(true);

    for (const m of msgs) await makeRetryDue(m);
    const cron = makeWebhook(supa);
    await Promise.all([runTasks(), cron.recoverSlipIngest(), cron.recoverSlipIngest()]);
    await runTasks();

    const rows = await ledger(batchId);
    expect(rows.every((r) => r.state === "attached")).toBe(true);
    expect(await count("slip_evidences", `batch_id='${batchId}'`)).toBe(3);
    const idx = (await db.query<{ batch_index: number }>(
      `SELECT batch_index FROM slip_evidences WHERE batch_id='${batchId}' ORDER BY batch_index`,
    )).map((r) => r.batch_index);
    expect(idx).toEqual([1, 2, 3]);
    expect((await batchRow(batchId)).image_count).toBe(3);
  }, 60_000);

  // ── P1 #8: recovery honours its budget even with hanging providers ──────────
  test("recoverSlipIngest returns within its budget while download and OCR hang", async () => {
    const io = SLIP_INGEST_POLICY.io;
    const saved = { ...io };
    io.lineDownloadTimeoutMs = 200;
    io.storageUploadTimeoutMs = 200;
    io.dbSlackMs = 100;
    io.ocrJobTimeoutMs = 300;
    try {
      const G = "G-hang";
      const batchId = await openBatch(G);
      downloadPlan.set(`m-${G}-2`, { hang: true, calls: 0 });
      const hangingOcr = { processEvidence: () => new Promise<void>(() => {}) };
      const webhook = makeWebhook(supa, {
        evidenceIngestor: new SlipEvidenceService(supa, download, { downloadMs: 200, uploadMs: 200 }),
        checkProcessor: hangingOcr,
      });
      await deliver(webhook, [imageEvent(G, 1, T0 + 1000), imageEvent(G, 2, T0 + 2000)], false);
      backgroundTasks.length = 0; // OCR never ran: image 1 has no check
      await db.query(`UPDATE slip_image_events SET resolved_at = now() - interval '5 minutes' WHERE state='attached'`);
      await makeRetryDue(`m-${G}-2`);

      const budgetMs = 1500;
      const started = Date.now();
      const summary = await webhook.recoverSlipIngest({ budgetMs });
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(budgetMs + 400);
      expect(downloadPlan.get(`m-${G}-2`)!.calls).toBeGreaterThanOrEqual(2); // it did try, and was cut off
      expect(summary.ocrRedriven).toBe(1); // the hung OCR job was abandoned at its cap
      expect((await ledger(batchId)).find((r) => r.line_message_id === `m-${G}-2`)!.state)
        .not.toBe("attached");
    } finally {
      Object.assign(io, saved);
    }
  }, 30_000);

  test("recoverSlipIngest does not START an attempt or OCR job that cannot finish inside the budget", async () => {
    const G = "G-nostart";
    await openBatch(G);
    const webhook = makeWebhook();
    downloadPlan.set(`m-${G}-1`, { failFirst: 1, calls: 0 });
    await deliver(webhook, [imageEvent(G, 1, T0 + 1000)], false);
    await makeRetryDue(`m-${G}-1`);
    const before = downloadPlan.get(`m-${G}-1`)!.calls;
    // Default worst case (20 s) does not fit a 5 s budget: nothing may start.
    await webhook.recoverSlipIngest({ budgetMs: 5_000 });
    expect(downloadPlan.get(`m-${G}-1`)!.calls).toBe(before);
    expect((await ledger())[0].state).toBe("retry_pending");
  }, 30_000);
});
