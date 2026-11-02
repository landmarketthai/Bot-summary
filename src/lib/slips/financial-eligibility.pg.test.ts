/**
 * PostgreSQL 17: the LINE batch summary and every AI-verified money loader
 * (reconcile / White Sheet / settlement / guided round close all read
 * loadAiVerifiedTransferTotal or loadMarketScopedAiVerifiedTransfers) agree on
 * the same stored slip_checks rows. Replays the P0 batch 5f1b8484 shape with
 * synthetic references.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadAiVerifiedTransferTotal, loadMarketScopedAiVerifiedTransfers } from "@/lib/reconciliation";
import { computeValidationFlags, parseBatchDate } from "@/lib/slips/validation-guard";
import {
  createPgSupabase,
  createSlipTestDb,
  probePg,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

const SOURCE = "G-eligibility";
const MARKET = "วัดทุ่งลานนา";
const BUSINESS_DATE = "2026-10-29";
const RECEIVED = "2026-10-29T12:00:00Z"; // 19:00 Bangkok, inside the 04:00 window

// [id, amount, reference, printed transaction_time, status, created_at]
const SLIPS: Array<[string, number, string | null, string | null, string, string]> = [
  ["s1", 40, "UAT-R1", "2026-07-29T00:15:00Z", "EXTRACTED", "2026-10-29T12:01:00Z"],          // ต.ค. read as ก.ค.
  ["s2", 50, "UAT-R2", "2026-10-29T08:46:31Z", "EXTRACTED", "2026-10-29T12:02:00Z"],
  ["s3", 40, "UAT-R3", "2026-10-29T11:50:00Z", "EXTRACTED", "2026-10-29T12:03:00Z"],
  ["s4", 50, "UAT-R4", "2026-07-29T09:37:00Z", "EXTRACTED", "2026-10-29T12:04:00Z"],          // ก.ค.
  ["s5", 40, null, null, "PARTIAL_EXTRACTED", "2026-10-29T12:05:00Z"],                         // no date, no ref
  ["s4-resend", 50, "UAT-R4", "2026-10-29T09:37:00Z", "EXTRACTED", "2026-10-29T12:30:00Z"],   // same ref, read right
];

let db: SlipTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supa: any;

describe.skipIf(!pgAvailable)("one slip eligibility rule across LINE and money loaders (PG 17)", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_elig");
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
    for (const [id, amount, ref, time, status, createdAt] of SLIPS) {
      const [raw] = await db.query<{ id: string }>(
        `INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, message_id, message_type, payload)
         VALUES ('evt-${id}', 'dest', 'message', 'group', '${SOURCE}', 'msg-${id}', 'image', '{}'::jsonb) RETURNING id`,
      );
      const [ev] = await db.query<{ id: string }>(
        `INSERT INTO public.slip_evidences (raw_message_id, line_message_id, source_id, source_type, storage_path, sha256, received_at, market_label)
         VALUES ('${raw.id}', 'msg-${id}', '${SOURCE}', 'group', 'p/${id}', '${"a".repeat(63)}${id.length}', '${RECEIVED}', '${MARKET}') RETURNING id`,
      );
      await db.query(
        `INSERT INTO public.slip_checks (evidence_id, status, slip_type, transfer_amount, reference_id, transaction_time, created_at)
         VALUES ('${ev.id}', '${status}', 'BANK_SLIP_QR', ${amount}, ${ref ? `'${ref}'` : "NULL"}, ${time ? `'${time}'` : "NULL"}, '${createdAt}')`,
      );
    }
  });
  afterAll(async () => { await db?.drop(); });

  test("reconcile's AI-verified total equals the LINE confirmed total: 90, not 180", async () => {
    const rows = await db.query<{ transfer_amount: string; reference_id: string | null; transaction_time: string | null; status: string }>(
      `SELECT transfer_amount, reference_id, transaction_time, status FROM public.slip_checks ORDER BY created_at`,
    );
    // LINE batch summary over the five originally sent images (the resend is its own batch).
    const batch = rows.slice(0, 5);
    const flags = computeValidationFlags(batch.map((r) => ({
      checkStatus: r.status as "EXTRACTED", slipType: "BANK_SLIP_QR" as const, transferAmount: Number(r.transfer_amount),
      paidAmount: null, transactionTime: r.transaction_time ? new Date(r.transaction_time).toISOString() : null,
      referenceId: r.reference_id,
    })), parseBatchDate("29/10/2569"));
    const lineConfirmed = batch.reduce((s, r, i) => s + (flags[i].flagged ? 0 : Number(r.transfer_amount)), 0);
    expect(lineConfirmed).toBe(90);

    expect(await loadAiVerifiedTransferTotal(supa, SOURCE, BUSINESS_DATE)).toBe(90);
  });

  test("White Sheet / settlement / round-close loader: 90 attributed, misdated winner pending, no double count", async () => {
    const r = await loadMarketScopedAiVerifiedTransfers(supa, SOURCE, BUSINESS_DATE, MARKET, new Set([MARKET]));
    expect(r.attributedTotal).toBe(90);
    // s1 + s4: the global winner for UAT-R4 is the first (misdated) read; the
    // correctly dated resend is its duplicate and is NOT promoted.
    expect(r.pendingDateCount).toBe(2);
    expect(r.pendingDateAmount).toBe(90);
    expect(r.pendingReferenceCount).toBe(1); // s5 (BR-02)
  });
});
