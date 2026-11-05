/**
 * Real PostgreSQL proof for slip cancellation (not an RPC mock).
 * Runs ONLY against disposable loopback PG17 via the guarded slip harness.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createSlipTestDb,
  probePg,
  SLIP_PIPELINE_MIGRATIONS,
  type SlipTestDb,
} from "./testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

const OPEN_TS = 1_760_000_000_000;
const SOURCE = "G-slip-cancel-pg";
let db: SlipTestDb;

async function openBatch(owner = "U-owner") {
  const rows = await db.query<{ id: string }>(
    `INSERT INTO slip_batches (source_id, source_type, sender_id, seller_name, market_name,
      slip_date, header_text, status, open_event_ts_ms)
     VALUES ('${SOURCE}', 'group', '${owner}', 'seller', 'market',
      '5/11/2569', 'seller market สลิปเงินโอน 5/11/2569',
      'collecting', ${OPEN_TS}) RETURNING id`,
  );
  return rows[0].id;
}

async function seedExtractedSlip(batchId: string) {
  const raw = await db.query<{ id: string }>(
    `INSERT INTO raw_messages (line_event_id, destination, event_type,
       source_type, source_id, user_id, message_id, message_type, raw_text, payload)
     VALUES ('evt-pg-cancel-fixture', 'dest', 'message', 'group',
       '${SOURCE}', 'U-owner', 'msg-pg-cancel-fixture', 'text', 'fixture', '{}'::jsonb)
     RETURNING id`,
  );
  const evidences = await db.query<{ id: string }>(
    `INSERT INTO slip_evidences (raw_message_id, line_message_id,
      source_id, source_type, line_user_id, storage_path, sha256, status, batch_id)
     VALUES ('${raw[0].id}', 'msg-pg-cancel-fixture', '${SOURCE}', 'group',
       'U-owner', 'slips/fixture.jpg', repeat('a',64), 'RECEIVED', '${batchId}')
     RETURNING id`,
  );
  await db.query(
    `INSERT INTO slip_checks (evidence_id, status, slip_type,
      transfer_amount, reference_id)
     VALUES ('${evidences[0].id}', 'EXTRACTED', 'BANK_SLIP_NO_QR',
      100, 'REFERENCE-PG-CANCEL')`,
  );
  return evidences[0].id;
}

describe.skipIf(!pgAvailable)("slip cancellation in real PostgreSQL", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_cancel", [
      ...SLIP_PIPELINE_MIGRATIONS,
      "20261105090000_cancel_slip_session.sql",
    ]);
  }, 120_000);
  afterAll(async () => {
    if (db) await db.drop();
  }, 60_000);
  beforeEach(async () => {
    await db.query(
      "TRUNCATE slip_image_events, slip_checks, slip_evidences, slip_batches, line_webhook_event_queue, raw_messages CASCADE",
    );
  });

  test("atomically cancels, de-verifies totals, retains raw evidence and blocks late OCR re-verification", async () => {
    const batchId = await openBatch();
    const evidenceId = await seedExtractedSlip(batchId);

    expect(await db.scalar(
      "SELECT count(*) FROM slip_checks WHERE status = 'EXTRACTED'",
    )).toBe("1");

    const outcome = await db.scalar(
      `SELECT cancel_collecting_slip_batch('${SOURCE}', 'U-owner', ${OPEN_TS + 3000})`,
    );
    expect(outcome).toBe("cancelled");
    const batch = (await db.query<{ status: string; close_event_ts_ms: string }>(
      `SELECT status, close_event_ts_ms FROM slip_batches WHERE id='${batchId}'`,
    ))[0];
    expect(batch.status).toBe("cancelled");
    expect(Number(batch.close_event_ts_ms)).toBe(OPEN_TS + 3000);

    const original = await db.query<{
      status: string; transfer_amount: string; reference_id: string;
      extracted_json: { cancelled_batch_original_status: string };
    }>(`SELECT status,transfer_amount,reference_id,extracted_json
       FROM slip_checks WHERE evidence_id='${evidenceId}'`);
    expect(original[0].status).toBe("NEED_REVIEW");
    expect(Number(original[0].transfer_amount)).toBe(100);
    expect(original[0].reference_id).toBe("REFERENCE-PG-CANCEL");
    expect(original[0].extracted_json.cancelled_batch_original_status).toBe("EXTRACTED");

    await db.query(
      `UPDATE slip_checks SET status='EXTRACTED' WHERE evidence_id='${evidenceId}'`,
    );
    expect(await db.scalar(
      `SELECT status FROM slip_checks WHERE evidence_id='${evidenceId}'`,
    )).toBe("NEED_REVIEW");
    expect(await db.scalar(
      `SELECT count(*) FROM slip_evidences WHERE id='${evidenceId}'`,
    )).toBe("1");

    // Old image timestamps must remain in the cancelled batch's window,
    // even after the operator creates a replacement batch for this source.
    const replacement = await openBatch();
    await db.query(
      `UPDATE slip_batches SET open_event_ts_ms=${OPEN_TS + 4000} WHERE id='${replacement}'`,
    );
    const attribution = (await db.query<{ batch_id: string; state: string }>(
      `SELECT * FROM resolve_slip_image_batch('${SOURCE}', ${OPEN_TS + 2000})`,
    ))[0];
    expect(attribution.batch_id).toBe(batchId);
    expect(attribution.state).toBe("late_after_finalize");
  });

  test("wrong sender cannot cancel and cannot alter verified checks", async () => {
    const batchId = await openBatch();
    await seedExtractedSlip(batchId);
    expect(await db.scalar(
      `SELECT cancel_collecting_slip_batch('${SOURCE}', 'U-other', ${OPEN_TS + 3000})`,
    )).toBe("not_owner");
    expect(await db.scalar(
      `SELECT status FROM slip_batches WHERE id='${batchId}'`,
    )).toBe("collecting");
    expect(await db.scalar(
      "SELECT status FROM slip_checks LIMIT 1",
    )).toBe("EXTRACTED");
  });

  test("already-closing batch cannot be cancelled", async () => {
    const batchId = await openBatch();
    await db.query(`UPDATE slip_batches SET status='closing' WHERE id='${batchId}'`);
    expect(await db.scalar(
      `SELECT cancel_collecting_slip_batch('${SOURCE}', 'U-owner', ${OPEN_TS + 3000})`,
    )).toBe("already_closing");
    expect(await db.scalar(
      `SELECT status FROM slip_batches WHERE id='${batchId}'`,
    )).toBe("closing");
  });

  test("no active batch is a no-op; only service_role can invoke the RPC", async () => {
    expect(await db.scalar(
      `SELECT cancel_collecting_slip_batch('${SOURCE}', 'U-owner', ${OPEN_TS + 3000})`,
    )).toBe("no_active");
    const grants = (await db.query<{
      service: boolean; anon: boolean; authenticated: boolean;
    }>(`SELECT
       has_function_privilege('service_role','public.cancel_collecting_slip_batch(text,text,bigint)','EXECUTE') AS service,
       has_function_privilege('anon','public.cancel_collecting_slip_batch(text,text,bigint)','EXECUTE') AS anon,
       has_function_privilege('authenticated','public.cancel_collecting_slip_batch(text,text,bigint)','EXECUTE') AS authenticated`))[0];
    expect(grants.service).toBe(true);
    expect(grants.anon).toBe(false);
    expect(grants.authenticated).toBe(false);
  });
});
