/**
 * PostgreSQL 17: migration 20261102120000 (slip_check_approvals +
 * manual_slip_entries.reference_id) with the real money loaders. One transfer
 * is counted once across AI and manual paths; the cases that still cannot be
 * proven distinct are pinned in reconciliation.test.ts (it.failing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  loadAiVerifiedTransferTotal,
  loadMarketScopedAiVerifiedTransfers,
  loadMarketScopedManualSlipTotal,
} from "@/lib/reconciliation";
import { reviewSlipCheck, revokeSlipCheckReview, SlipCheckReviewError } from "@/lib/slips/check-approval";
import {
  createPgSupabase,
  createSlipTestDb,
  probePg,
  ROOT,
  SLIP_PIPELINE_MIGRATIONS,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

const MIGRATION = "20261102120000_slip_check_approval_link.sql";
const MARKET = "วัดทุ่งลานนา";
const OTHER_MARKET = "หน้าเซเวน";
const DATE = "2026-10-29";
const RECEIVED = "2026-10-29T12:00:00Z";
const OK_TIME = "2026-10-29T10:00:00Z";
const JULY = "2026-07-29T10:00:00Z"; // ต.ค. read as ก.ค.

let db: SlipTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supa: any;
let seq = 0;

async function seedCheck(s: {
  source: string; amount: number; ref: string | null; time: string | null; market?: string; createdAt?: string;
}): Promise<string> {
  const id = ++seq;
  const [raw] = await db.query<{ id: string }>(
    `INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, message_id, message_type, payload)
     VALUES ('evt-${id}', 'dest', 'message', 'group', '${s.source}', 'msg-${id}', 'image', '{}'::jsonb) RETURNING id`,
  );
  const [ev] = await db.query<{ id: string }>(
    `INSERT INTO public.slip_evidences (raw_message_id, line_message_id, source_id, source_type, storage_path, sha256, received_at, market_label, market_label_normalized)
     VALUES ('${raw.id}', 'msg-${id}', '${s.source}', 'group', 'p/${id}', '${id.toString(16).padStart(64, "b")}', '${RECEIVED}',
             '${s.market ?? MARKET}', '${s.market ?? MARKET}') RETURNING id`,
  );
  const [check] = await db.query<{ id: string }>(
    `INSERT INTO public.slip_checks (evidence_id, status, slip_type, transfer_amount, reference_id, transaction_time, created_at)
     VALUES ('${ev.id}', 'EXTRACTED', 'BANK_SLIP_QR', ${s.amount}, ${s.ref ? `'${s.ref}'` : "NULL"},
             ${s.time ? `'${s.time}'` : "NULL"}, '${s.createdAt ?? `2026-10-29T12:${String(id).padStart(2, "0")}:00Z`}') RETURNING id`,
  );
  return check.id;
}

/** A closed manual-slip session for source/market with the given entries. */
async function seedManual(source: string, entries: Array<{ amount: number; ref?: string }>): Promise<void> {
  const [session] = await db.query<{ id: string }>(
    `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key)
     VALUES ('${source}', '${DATE}', 'open', '${MARKET}', 'm-${++seq}') RETURNING id`,
  );
  for (const [i, e] of entries.entries()) {
    await db.query(
      `INSERT INTO public.manual_slip_entries (session_id, sequence_no, raw_line, amount, line_message_id, reference_id)
       VALUES ('${session.id}', ${i}, 'ยอด ${e.amount}', ${e.amount}, 'mmsg-${seq}', ${e.ref ? `'${e.ref}'` : "NULL"})`,
    );
  }
  await db.query(`UPDATE public.manual_slip_sessions SET status = 'closed', closed_at = now() WHERE id = '${session.id}'`);
}

const total = (source: string) => loadAiVerifiedTransferTotal(supa, source, DATE);
// checked_slip_total = AI + manual: the two halves settlement, White Sheet and round close add.
const manualTotal = (source: string) => loadMarketScopedManualSlipTotal(supa, source, DATE, MARKET);
const sqlError = async (statement: string) => {
  try { await db.query(statement); return "no error"; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
const refusalCode = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) { return e instanceof SlipCheckReviewError ? e.code : String(e); }
};

describe.skipIf(!pgAvailable)("AI slip approval and manual entries count one transfer once (PG 17)", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_approval", [
      ...SLIP_PIPELINE_MIGRATIONS,
      "0027_manual_slip_session.sql",
      "0029_settlement_finalizations.sql",
      "0030_manual_slip_market_key.sql",
      "20260926090000_manual_slip_atomic_append_close.sql",
    ]);
    // Round binding columns come from the P2E migration, outside this harness.
    await db.query(`ALTER TABLE public.slip_evidences ADD COLUMN accountability_round_id uuid`);
    await db.query(`ALTER TABLE public.settlement_finalizations ADD COLUMN accountability_round_id uuid`);
    await db.exec(await Bun.file(`${ROOT}/supabase/migrations/${MIGRATION}`).text());
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
  });
  afterAll(async () => { await db?.drop(); });

  test("misdated AI slip: pending until approved, then counted ONCE at the approved amount", async () => {
    const check = await seedCheck({ source: "A1", amount: 50, ref: "A1-R", time: JULY });
    expect(await total("A1")).toBe(0);
    await reviewSlipCheck(supa, { checkId: check, decision: "approved", amount: 50, reason: "ภาพจริง 29 ต.ค.", reviewer: "admin-1" });
    expect(await total("A1")).toBe(50);
    const r = await loadMarketScopedAiVerifiedTransfers(supa, "A1", DATE, MARKET, new Set([MARKET]));
    expect(r).toMatchObject({ attributedTotal: 50, approvedCount: 1, pendingDateCount: 0 });
  });

  test("approval replaces manual re-keying: a manual entry carrying the same reference is not counted", async () => {
    const check = await seedCheck({ source: "A2", amount: 50, ref: "A2-R", time: JULY });
    await reviewSlipCheck(supa, { checkId: check, decision: "approved", amount: 50, reason: "ตรวจแล้ว", reviewer: "admin-1" });
    await seedManual("A2", [{ amount: 50, ref: "A2-R" }, { amount: 30 }]);
    const ai = await total("A2");
    const manual = await manualTotal("A2");
    expect(ai).toBe(50);
    expect(manual).toBe(30);   // the 50 with A2-R is the AI row
    expect(ai + manual).toBe(80);
  });

  test("manual entry whose reference matches an automatically counted AI slip is not counted", async () => {
    await seedCheck({ source: "A3", amount: 70, ref: "A3-R", time: OK_TIME });
    await seedManual("A3", [{ amount: 70, ref: " A3-R " }]);
    expect((await total("A3")) + (await manualTotal("A3"))).toBe(70);
  });

  test("rejected AI slip never counts; revoking the decision returns it to the automatic rule", async () => {
    const check = await seedCheck({ source: "A4", amount: 90, ref: "A4-R", time: OK_TIME });
    expect(await total("A4")).toBe(90);
    const { approvalId } = await reviewSlipCheck(supa, { checkId: check, decision: "rejected", reason: "ไม่ใช่ลูกค้าตลาดนี้", reviewer: "admin-2" });
    expect(await total("A4")).toBe(0);
    await revokeSlipCheckReview(supa, { approvalId, revokedBy: "admin-1", reason: "ตรวจซ้ำแล้วถูกต้อง" });
    expect(await total("A4")).toBe(90);
  });

  test("concurrency: two different decisions at once leave exactly one active; same decision twice is idempotent", async () => {
    const check = await seedCheck({ source: "C1", amount: 40, ref: "C1-R", time: JULY });
    const codes = await Promise.all([
      refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "approved", amount: 40, reason: "r1", reviewer: "a" })),
      refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "rejected", reason: "r2", reviewer: "b" })),
    ]);
    expect(codes.sort()).toEqual(["ok", "slip_check_already_reviewed"]);
    expect(await db.scalar(`SELECT count(*) FROM public.slip_check_approvals WHERE slip_check_id = '${check}' AND status = 'active'`)).toBe("1");

    const twin = await seedCheck({ source: "C2", amount: 40, ref: "C2-R", time: JULY });
    const same = () => reviewSlipCheck(supa, { checkId: twin, decision: "approved", amount: 40, reason: "r", reviewer: "a" });
    const results = await Promise.all([same(), same(), same()]);
    expect(new Set(results.map((r) => r.approvalId)).size).toBe(1);
    expect(await total("C2")).toBe(40);
  });

  test("cross-market duplicate: only the global winner can be approved; the second read is refused", async () => {
    const first = await seedCheck({ source: "X1", amount: 60, ref: "X-SAME", time: JULY, createdAt: "2026-10-29T12:00:00Z" });
    const second = await seedCheck({ source: "X1", amount: 60, ref: "X-SAME", time: OK_TIME, market: OTHER_MARKET, createdAt: "2026-10-29T12:30:00Z" });
    expect(await refusalCode(reviewSlipCheck(supa, { checkId: second, decision: "approved", amount: 60, reason: "r", reviewer: "a" })))
      .toBe("slip_check_is_duplicate");
    await reviewSlipCheck(supa, { checkId: first, decision: "approved", amount: 60, reason: "r", reviewer: "a" });
    expect(await total("X1")).toBe(60); // once, never 120
  });

  test("no reference: refused (BR-02 reference resolution comes first)", async () => {
    const check = await seedCheck({ source: "N1", amount: 40, ref: null, time: null });
    expect(await refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "approved", amount: 40, reason: "r", reviewer: "a" })))
      .toBe("slip_check_reference_required");
  });

  test("after the round is finalized: no new decision, no revoke, no manual entry", async () => {
    const check = await seedCheck({ source: "F1", amount: 40, ref: "F1-R", time: JULY });
    const { approvalId } = await reviewSlipCheck(supa, { checkId: check, decision: "approved", amount: 40, reason: "r", reviewer: "a" });
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date) VALUES ('F1', '${DATE}')`);
    expect(await refusalCode(revokeSlipCheckReview(supa, { approvalId, revokedBy: "b", reason: "x" }))).toBe("slip_check_round_finalized");
    const other = await seedCheck({ source: "F1", amount: 10, ref: "F1-R2", time: JULY });
    expect(await refusalCode(reviewSlipCheck(supa, { checkId: other, decision: "approved", amount: 10, reason: "r", reviewer: "a" })))
      .toBe("slip_check_round_finalized");
    await seedManual("F1", []);
    const [closed] = await db.query<{ id: string }>(`SELECT id FROM public.manual_slip_sessions WHERE source_id = 'F1'`);
    const append = await supa.rpc("append_manual_slip_entries_atomic", {
      p_session_id: closed.id, p_entries: [{ raw_line: "ยอด 10", amount: 10 }], p_line_message_id: "late", p_line_user_id: null,
    });
    expect(String(append.error?.message)).toContain("manual_slip_session_not_open");
  });

  test("audit trail is append-only and an approval needs reason, reviewer and amount", async () => {
    const check = await seedCheck({ source: "U1", amount: 40, ref: "U1-R", time: JULY });
    expect(await refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "approved", reason: "", reviewer: "a", amount: 40 }))).toBe("reason_required");
    expect(await refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "approved", reason: "r", reviewer: "a" }))).toBe("amount_required");
    const { approvalId } = await reviewSlipCheck(supa, { checkId: check, decision: "approved", amount: 40, reason: "r", reviewer: "a" });
    expect(await sqlError(`UPDATE public.slip_check_approvals SET approved_amount = 400 WHERE id = '${approvalId}'`)).toContain("slip_check_approval_only_revoke_allowed");
    expect(await sqlError(`DELETE FROM public.slip_check_approvals WHERE id = '${approvalId}'`)).toContain("slip_check_approval_append_only");
  });

  test("legacy manual entries (no reference) are untouched and still counted — never linked by guessing", async () => {
    await seedManual("L1", [{ amount: 25 }, { amount: 35 }]);
    expect(await manualTotal("L1")).toBe(60);
    expect(await db.scalar(`SELECT count(*) FROM public.manual_slip_entries WHERE reference_id IS NOT NULL AND session_id IN (SELECT id FROM public.manual_slip_sessions WHERE source_id = 'L1')`)).toBe("0");
  });

  test("rollback script drops the RPCs and keeps every decision row", async () => {
    const before = await db.scalar(`SELECT count(*) FROM public.slip_check_approvals`);
    await db.exec(await Bun.file(`${ROOT}/supabase/rollback/20261102120000_slip_check_approval_link.down.sql`).text());
    expect(await db.scalar(`SELECT count(*) FROM pg_proc WHERE proname IN ('review_slip_check', 'revoke_slip_check_review')`)).toBe("0");
    expect(await db.scalar(`SELECT count(*) FROM public.slip_check_approvals`)).toBe(before);
    expect(Number(before)).toBeGreaterThan(0);
  });
});
