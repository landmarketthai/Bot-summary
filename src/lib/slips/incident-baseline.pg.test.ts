/**
 * BEFORE-the-fix characterization of the Production incident
 * (batch d3ed6db7-822b-43fd-9fd0-06609a771a93: 25 images, 5 attached).
 *
 * Runs the pre-fix schema (no slip_image_events ledger) so the application
 * takes its legacy path, then replays the incident timeline. It documents the
 * verified root cause; image-ingestion.pg.test.ts proves the fixed behavior.
 *
 *   ALLOW_DISPOSABLE_POSTGRES_TESTS=1 PGPASSWORD=postgres bun test src/lib/slips/incident-baseline.pg.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WebhookService } from "@/lib/line/webhook-service";
import { SlipEvidenceService } from "@/lib/slips/evidence-service";
import { finalizeClosingSlipBatches } from "@/lib/slips/batch-finalizer";
import {
  SLIP_PIPELINE_MIGRATIONS,
  createPgSupabase,
  createSlipTestDb,
  probePg,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabase = any;
const T0 = 1_760_000_000_000;
const G = "G-incident-baseline";

describe.skipIf(!pgAvailable)("incident baseline (pre-fix schema, legacy path)", () => {
  let db: SlipTestDb;

  beforeAll(async () => {
    db = await createSlipTestDb(
      "slip_base",
      SLIP_PIPELINE_MIGRATIONS.filter((m) => !m.includes("slip_image_ingestion_ledger")),
    );
  }, 120_000);

  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);

  test("one failing image blocks the rest, the finalizer ignores them, and late images are acked as lost", async () => {
    const supa: AnySupabase = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
    const calls = new Map<string, number>();
    const download = async (id: string) => {
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (id === `m-${G}-6`) throw new Error("simulated LINE content 500");
      return { bytes: new TextEncoder().encode(`img:${id}`), mimeType: "image/jpeg" };
    };
    const webhook = new WebhookService(supa, {
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
      replyMessage: async () => {},
    });

    const batchId = (await db.query<{ id: string }>(
      `INSERT INTO slip_batches (source_id, source_type, sender_id, status, seller_name, market_name, slip_date)
       VALUES ('${G}', 'group', 'U-seller', 'collecting', 'น้อย', 'ราชพฤกษ์', '16/10/2569') RETURNING id`,
    ))[0].id;

    const events = Array.from({ length: 25 }, (_, i) => ({
      type: "message",
      webhookEventId: `evt-${G}-${i + 1}`,
      timestamp: T0 + 1000 * (i + 1),
      replyToken: `rt-${i + 1}`,
      mode: "active",
      source: { type: "group", groupId: G, userId: "U-seller" },
      message: { type: "image", id: `m-${G}-${i + 1}`, contentProvider: { type: "line" } },
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await webhook.processEvents(events as any, "dest", { deferOrderedProcessing: false });

    // Head-of-line: images 1-5 attached, image 6 failed and stopped the drain.
    expect(await db.scalar(`SELECT count(*) FROM slip_evidences WHERE batch_id='${batchId}'`)).toBe("5");
    expect(await db.scalar("SELECT count(*) FROM line_webhook_event_queue WHERE status='pending'")).toBe("20");
    expect(await db.scalar(`SELECT status FROM slip_evidences WHERE line_message_id='m-${G}-6'`)).toBe("DOWNLOAD_FAILED");

    // จบสลิป is not queued: it runs immediately and the batch goes to closing.
    await db.query(`UPDATE slip_batches SET status='closing', closing_at=now() WHERE id='${batchId}'`);
    await db.query(
      `UPDATE slip_batches SET closing_at = closing_at - interval '60 seconds', last_image_at = last_image_at - interval '60 seconds' WHERE id='${batchId}'`,
    );
    // Retry sweeps keep failing on image 6 (it is still first in the queue).
    for (let i = 0; i < 3; i++) await webhook.recoverPendingOrderedEvents(5);
    expect(await db.scalar("SELECT count(*) FROM line_webhook_event_queue WHERE status='pending'")).toBe("20");

    // The OLD finalizer claim sees only the 5 attached evidences and fires.
    const pushes: string[] = [];
    const oldClaim = async (client: AnySupabase, id: string, quiet: number, max: number) => {
      const { data } = await client.rpc("claim_closing_slip_batch", {
        p_batch_id: id, p_quiet_seconds: quiet, p_max_seconds: max,
      });
      const row = (data as Array<{ claimed_id: string; claimed_source_id: string; was_timeout: boolean }>)[0];
      return row ? { id: row.claimed_id, source_id: row.claimed_source_id, wasTimeout: row.was_timeout } : null;
    };
    const claimed = await finalizeClosingSlipBatches(
      supa, async (_to, text) => { pushes.push(text); }, 10, 120, undefined, oldClaim,
    );
    expect(claimed).toBe(1);
    expect(pushes[0]).toContain("รับทั้งหมด: 5 รูป"); // the seller is told 5, not 25
    expect(pushes[0]).toContain("ยอดรวมที่อ่านได้: 500 บาท"); // looks complete, is not
    expect(pushes[0]).not.toContain("ยังไม่ครบ");

    // Once the batch left 'closing', the remaining queue events find no active
    // session and are acknowledged as processed without ever being downloaded.
    for (let i = 0; i < 6; i++) await webhook.recoverPendingOrderedEvents(5);
    expect(await db.scalar("SELECT count(*) FROM line_webhook_event_queue WHERE status='processed'")).toBe("25");
    expect(await db.scalar("SELECT count(*) FROM slip_evidences")).toBe("6"); // 5 + the failed one
    expect(await db.scalar("SELECT count(*) FROM raw_messages WHERE message_type='image' AND is_processed=true")).toBe("5");
    // 19 images: processed in the queue, no evidence, no trace of the loss.
    expect(await db.scalar(
      `SELECT count(*) FROM raw_messages r WHERE r.message_type='image'
        AND NOT EXISTS (SELECT 1 FROM slip_evidences e WHERE e.raw_message_id = r.id)`,
    )).toBe("19");
  }, 120_000);
});
