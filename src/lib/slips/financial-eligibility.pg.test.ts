/**
 * PostgreSQL 17: the LINE batch summary and every AI-verified money loader
 * (reconcile / White Sheet / settlement / guided round close all read
 * loadAiVerifiedTransferTotal or loadMarketScopedAiVerifiedTransfers) agree on
 * the same stored slip_checks rows. Replays the P0 batch 5f1b8484 shape with
 * synthetic references, plus the outlier and cross-market duplicate cases.
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

const MARKET = "วัดทุ่งลานนา";
const OTHER_MARKET = "หน้าเซเวน";
const BUSINESS_DATE = "2026-10-29";
const RECEIVED = "2026-10-29T12:00:00Z"; // 19:00 Bangkok, inside the 04:00 window
const OK_TIME = "2026-10-29T10:00:00Z";

let db: SlipTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supa: any;
let seq = 0;

async function seedSlip(s: {
  source: string; amount: number; ref: string | null; time: string | null;
  status?: string; createdAt?: string; market?: string; batchId?: string;
}): Promise<void> {
  const id = `s${++seq}`;
  const [raw] = await db.query<{ id: string }>(
    `INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, message_id, message_type, payload)
     VALUES ('evt-${id}', 'dest', 'message', 'group', '${s.source}', 'msg-${id}', 'image', '{}'::jsonb) RETURNING id`,
  );
  const [ev] = await db.query<{ id: string }>(
    `INSERT INTO public.slip_evidences (raw_message_id, line_message_id, source_id, source_type, storage_path, sha256, received_at, market_label, market_label_normalized, batch_id)
     VALUES ('${raw.id}', 'msg-${id}', '${s.source}', 'group', 'p/${id}', '${seq.toString(16).padStart(64, "a")}', '${RECEIVED}',
             '${s.market ?? MARKET}', '${s.market ?? MARKET}', ${s.batchId ? `'${s.batchId}'` : "NULL"}) RETURNING id`,
  );
  await db.query(
    `INSERT INTO public.slip_checks (evidence_id, status, slip_type, transfer_amount, reference_id, transaction_time, created_at)
     VALUES ('${ev.id}', '${s.status ?? "EXTRACTED"}', 'BANK_SLIP_QR', ${s.amount}, ${s.ref ? `'${s.ref}'` : "NULL"},
             ${s.time ? `'${s.time}'` : "NULL"}, '${s.createdAt ?? `2026-10-29T12:${String(seq).padStart(2, "0")}:00Z`}')`,
  );
}

async function newBatch(source: string): Promise<string> {
  const [batch] = await db.query<{ id: string }>(
    `INSERT INTO public.slip_batches (source_id) VALUES ('${source}') RETURNING id`,
  );
  return batch.id;
}

describe.skipIf(!pgAvailable)("one slip eligibility rule across LINE and money loaders (PG 17)", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_elig");
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
    // The audit SQL joins the round binding; the slip harness schema predates it.
    await db.query(`CREATE TABLE public.accountability_rounds (id uuid PRIMARY KEY, business_date date NOT NULL)`);
    await db.query(`ALTER TABLE public.slip_evidences ADD COLUMN accountability_round_id uuid`);

    // P0 batch shape (source P0).
    await seedSlip({ source: "P0", amount: 40, ref: "UAT-R1", time: "2026-07-29T00:15:00Z" }); // ต.ค. read as ก.ค.
    await seedSlip({ source: "P0", amount: 50, ref: "UAT-R2", time: "2026-10-29T08:46:31Z" });
    await seedSlip({ source: "P0", amount: 40, ref: "UAT-R3", time: "2026-10-29T11:50:00Z" });
    await seedSlip({ source: "P0", amount: 50, ref: "UAT-R4", time: "2026-07-29T09:37:00Z" }); // ก.ค.
    await seedSlip({ source: "P0", amount: 40, ref: null, time: null, status: "PARTIAL_EXTRACTED" });
    await seedSlip({ source: "P0", amount: 50, ref: "UAT-R4", time: "2026-10-29T09:37:00Z", createdAt: "2026-10-29T13:30:00Z" }); // resend

    // Outlier batch (source OUT): 4 × 100 + one 50,000 → the LINE guard suspends 50,000.
    const batch = await newBatch("OUT");
    for (const [i, amount] of [100, 100, 100, 100, 50000].entries()) {
      await seedSlip({ source: "OUT", amount, ref: `OUT-${i}`, time: OK_TIME, batchId: batch });
    }

    // Cross-market duplicate (source DUP): the same reference read in two markets.
    await seedSlip({ source: "DUP", amount: 300, ref: "SAME-REF", time: OK_TIME, market: MARKET, createdAt: "2026-10-29T12:00:00Z" });
    await seedSlip({ source: "DUP", amount: 300, ref: "SAME-REF", time: OK_TIME, market: OTHER_MARKET, createdAt: "2026-10-29T12:05:00Z" });
  });
  afterAll(async () => { await db?.drop(); });

  test("P0: reconcile's AI-verified total equals the LINE confirmed total: 90, not 180", async () => {
    const rows = await db.query<{ transfer_amount: string; reference_id: string | null; transaction_time: string | null; status: string }>(
      `SELECT c.transfer_amount, c.reference_id, c.transaction_time, c.status
       FROM public.slip_checks c JOIN public.slip_evidences e ON e.id = c.evidence_id
       WHERE e.source_id = 'P0' ORDER BY c.created_at LIMIT 5`,
    );
    const flags = computeValidationFlags(rows.map((r) => ({
      checkStatus: r.status as "EXTRACTED", slipType: "BANK_SLIP_QR" as const, transferAmount: Number(r.transfer_amount),
      paidAmount: null, transactionTime: r.transaction_time ? new Date(r.transaction_time).toISOString() : null,
      referenceId: r.reference_id,
    })), parseBatchDate("29/10/2569"));
    const lineConfirmed = rows.reduce((s, r, i) => s + (flags[i].flagged ? 0 : Number(r.transfer_amount)), 0);
    expect(lineConfirmed).toBe(90);
    expect(await loadAiVerifiedTransferTotal(supa, "P0", BUSINESS_DATE)).toBe(90);
  });

  test("P0: market-scoped loader: misdated global winner pending, correct resend NOT promoted, no double count", async () => {
    const r = await loadMarketScopedAiVerifiedTransfers(supa, "P0", BUSINESS_DATE, MARKET, new Set([MARKET]));
    expect(r.attributedTotal).toBe(90);
    expect(r.pendingDateCount).toBe(2);
    expect(r.pendingDateAmount).toBe(90);
    expect(r.pendingReferenceCount).toBe(1);
  });

  test("outlier: the amount the LINE batch summary suspends is not in the money total", async () => {
    const r = await loadMarketScopedAiVerifiedTransfers(supa, "OUT", BUSINESS_DATE, MARKET, new Set([MARKET]));
    expect(r.attributedTotal).toBe(400);
    expect(r.pendingOutlierCount).toBe(1);
    expect(r.pendingOutlierAmount).toBe(50000);
    expect(await loadAiVerifiedTransferTotal(supa, "OUT", BUSINESS_DATE)).toBe(400);
  });

  test("cross-market duplicate: one reference is counted once, in the market that read it first", async () => {
    const known = new Set([MARKET, OTHER_MARKET]);
    const mine = await loadMarketScopedAiVerifiedTransfers(supa, "DUP", BUSINESS_DATE, MARKET, known);
    const theirs = await loadMarketScopedAiVerifiedTransfers(supa, "DUP", BUSINESS_DATE, OTHER_MARKET, known);
    expect(mine.attributedTotal + theirs.attributedTotal).toBe(300);
    expect(mine.attributedTotal).toBe(300);
    expect(await loadAiVerifiedTransferTotal(supa, "DUP", BUSINESS_DATE)).toBe(300);
  });

  test("historical audit SQL (docs/sql) on the same rows: P0 180 → 90, outlier 50,000 excluded, duplicate once", async () => {
    const script = await Bun.file(`${import.meta.dir}/../../../docs/sql/slip-eligibility-historical-audit.sql`).text();
    const statements = script.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter((s) => /^WITH/i.test(s));
    expect(statements.length).toBe(2);
    const rows = await db.query<Record<string, string>>(statements[0]);
    const byMarket = Object.fromEntries(rows.map((r) => [r.market, r]));
    // All three sources land on 2026-10-29 in MARKET (+ OTHER_MARKET for the duplicate read).
    const m = byMarket[MARKET];
    expect(Number(m.counted_before_amount)).toBe(180 + 50400 + 300);
    expect(Number(m.counted_after_amount)).toBe(90 + 400 + 300);
    expect(Number(m.excluded_wrong_date_amount)).toBe(90);
    expect(Number(m.excluded_outlier_amount)).toBe(50000);
    expect(Number(m.pending_no_reference_n_unchanged)).toBe(1);
    expect(Number(m.duplicate_reads_n_unchanged)).toBe(1);
    expect(Number(byMarket[OTHER_MARKET].counted_before_amount)).toBe(0);
    expect(Object.keys(rows[0])).not.toContain("reference_id");
  });
});
