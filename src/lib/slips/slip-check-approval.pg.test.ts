/**
 * PostgreSQL 17: migrations 20261102120000 + 20261102130000 with the real money
 * loaders. One transfer is ONE money row across AI checks, AI approvals, manual
 * entries and manual overrides — never two, and never silently dropped (an
 * entry that is not counted is either superseded by its AI row or pending).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  loadAiVerifiedTransferTotal,
  loadMarketScopedAiVerifiedTransfers,
  loadMarketScopedManualSlipBreakdown,
} from "@/lib/reconciliation";
import {
  reviewManualSlipEntry,
  reviewSlipCheck,
  revokeSlipCheckReview,
  SlipCheckReviewError,
} from "@/lib/slips/check-approval";
import {
  createPgSupabase,
  createSlipTestDb,
  PGHOST,
  PGPASSWORD,
  PGPORT,
  PGUSER,
  probePg,
  PSQL,
  ROOT,
  SLIP_PIPELINE_MIGRATIONS,
  type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

const M0 = "20261102110000_financial_write_stop";
const M1 = "20261102120000_slip_check_approval_link";
const M2 = "20261102130000_manual_slip_entry_review";
const M3 = "20261102140000_slip_review_hardening";
const M4 = "20261102150000_slip_reference_scope";
const M5 = "20261102160000_finalization_claim_order";
const M6 = "20261103100000_slip_reference_claims";
const M7 = "20261103120000_financial_write_guards";
const BASE_MIGRATIONS = [
  ...SLIP_PIPELINE_MIGRATIONS,
  "0027_manual_slip_session.sql",
  "0029_settlement_finalizations.sql",
  "0030_manual_slip_market_key.sql",
  "20260926090000_manual_slip_atomic_append_close.sql",
];
const MARKET = "วัดทุ่งลานนา";
const OTHER_MARKET = "หน้าเซเวน";
const DATE = "2026-10-29";
const RECEIVED = "2026-10-29T12:00:00Z";
const OK_TIME = "2026-10-29T10:00:00Z";
const JULY = "2026-07-29T10:00:00Z"; // ต.ค. read as ก.ค.

const file = (dir: "migrations" | "rollback", name: string) =>
  Bun.file(`${ROOT}/supabase/${dir}/${name}${dir === "rollback" ? ".down" : ""}.sql`).text();

async function freshDb(prefix: string, migrations: string[]): Promise<SlipTestDb> {
  const created = await createSlipTestDb(prefix, BASE_MIGRATIONS);
  // Round binding columns come from the P2E migration, outside this harness.
  await created.query(`ALTER TABLE public.slip_evidences ADD COLUMN IF NOT EXISTS accountability_round_id uuid`);
  await created.query(`ALTER TABLE public.settlement_finalizations ADD COLUMN IF NOT EXISTS accountability_round_id uuid`);
  await created.query(`ALTER TABLE public.manual_slip_sessions ADD COLUMN IF NOT EXISTS accountability_round_id uuid`);
  await created.query(`CREATE TABLE IF NOT EXISTS public.accountability_rounds (id uuid PRIMARY KEY, business_date date NOT NULL)`);
  // Guarded by 20261102110000; Production has it since 0007 (source_id since 0028).
  await created.query(`CREATE TABLE IF NOT EXISTS public.settlement_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id text)`);
  for (const m of migrations) await created.exec(await file("migrations", m));
  // The stop installs paused; resume so the suite tests normal operation.
  if (migrations.includes(M0)) await created.query(`UPDATE public.financial_maintenance SET paused = false`);
  return created;
}

let db: SlipTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supa: any;
let seq = 0;

async function seedCheck(on: SlipTestDb, s: {
  source: string; amount: number; ref: string | null; time: string | null; market?: string; createdAt?: string; round?: string;
}): Promise<string> {
  const id = ++seq;
  const [raw] = await on.query<{ id: string }>(
    `INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, message_id, message_type, payload)
     VALUES ('evt-${id}', 'dest', 'message', 'group', '${s.source}', 'msg-${id}', 'image', '{}'::jsonb) RETURNING id`,
  );
  const [ev] = await on.query<{ id: string }>(
    `INSERT INTO public.slip_evidences (raw_message_id, line_message_id, source_id, source_type, storage_path, sha256, received_at, market_label, market_label_normalized, accountability_round_id)
     VALUES ('${raw.id}', 'msg-${id}', '${s.source}', 'group', 'p/${id}', '${id.toString(16).padStart(64, "b")}', '${RECEIVED}',
             '${s.market ?? MARKET}', '${s.market ?? MARKET}', ${s.round ? `'${s.round}'` : "NULL"}) RETURNING id`,
  );
  const [check] = await on.query<{ id: string }>(
    `INSERT INTO public.slip_checks (evidence_id, status, slip_type, transfer_amount, reference_id, transaction_time, created_at)
     VALUES ('${ev.id}', 'EXTRACTED', 'BANK_SLIP_QR', ${s.amount}, ${s.ref ? `'${s.ref}'` : "NULL"},
             ${s.time ? `'${s.time}'` : "NULL"}, '${s.createdAt ?? `2026-10-29T12:${String(id % 60).padStart(2, "0")}:00Z`}') RETURNING id`,
  );
  return check.id;
}

/**
 * Manual entries through the REAL append RPC, then the session is closed.
 * Entries without reference_id/requires_review are what today's app sends.
 */
async function seedManual(
  source: string,
  entries: Array<{ amount: number; reference_id?: string; requires_review?: boolean }>,
): Promise<string[]> {
  const [session] = await db.query<{ id: string }>(
    `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key)
     VALUES ('${source}', '${DATE}', 'open', '${MARKET}', 'm-${++seq}') RETURNING id`,
  );
  const r = await supa.rpc("append_manual_slip_entries_atomic", {
    p_session_id: session.id,
    p_entries: entries.map((e) => ({ raw_line: `ยอด ${e.amount}`, ...e })),
    p_line_message_id: `mmsg-${seq}`,
    p_line_user_id: "U-op",
  });
  if (r.error) throw new Error(r.error.message);
  await db.query(`UPDATE public.manual_slip_sessions SET status = 'closed', closed_at = now() WHERE id = '${session.id}'`);
  const rows = await db.query<{ id: string }>(`SELECT id FROM public.manual_slip_entries WHERE session_id = '${session.id}' ORDER BY sequence_no`);
  return rows.map((row) => row.id);
}

const ai = (source: string) => loadAiVerifiedTransferTotal(supa, source, DATE);
const manual = (source: string) => loadMarketScopedManualSlipBreakdown(supa, source, DATE, MARKET);
const checked = async (source: string) => (await ai(source)) + (await manual(source)).total;
const refusalCode = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) { return e instanceof SlipCheckReviewError ? e.code : String(e); }
};
const sqlError = async (statement: string) => {
  try { await db.query(statement); return "no error"; } catch (e) { return e instanceof Error ? e.message : String(e); }
};
const approveAi = (checkId: string, amount: number) =>
  reviewSlipCheck(supa, { checkId, decision: "approved", amount, reason: "ภาพจริงวันที่ถูก", reviewer: "admin-1" });

describe.skipIf(!pgAvailable)("one transfer, one money row across AI and manual (PG 17)", () => {
  beforeAll(async () => {
    db = await freshDb("slip_approval", [M0, M1, M2, M3, M4, M5, M6, M7]);
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
  }, 120_000);
  afterAll(async () => { await db?.drop(); });

  // ── AI approvals ───────────────────────────────────────────────────────────
  test("misdated AI slip: pending until approved, then counted ONCE at the approved amount", async () => {
    const check = await seedCheck(db, { source: "A1", amount: 50, ref: "A1-R", time: JULY });
    expect(await ai("A1")).toBe(0);
    await approveAi(check, 50);
    expect(await ai("A1")).toBe(50);
    expect(await loadMarketScopedAiVerifiedTransfers(supa, "A1", DATE, MARKET, new Set([MARKET])))
      .toMatchObject({ attributedTotal: 50, approvedCount: 1, pendingDateCount: 0 });
  });

  test("approved AI + manual entry with the same reference: the manual entry is superseded (50, not 100)", async () => {
    const check = await seedCheck(db, { source: "A2", amount: 50, ref: "A2-R", time: JULY });
    await approveAi(check, 50);
    await seedManual("A2", [{ amount: 50, reference_id: "A2-R" }, { amount: 30 }]);
    expect(await manual("A2")).toMatchObject({ total: 30, supersededCount: 1, pendingCount: 0 });
    expect(await checked("A2")).toBe(80);
  });

  test("AI REJECTED + manual entry with the same reference: pending (not lost, not doubled) until an override", async () => {
    const check = await seedCheck(db, { source: "R1", amount: 60, ref: "R1-R", time: OK_TIME });
    await reviewSlipCheck(supa, { checkId: check, decision: "rejected", reason: "AI อ่านผิดตลาด", reviewer: "admin-1" });
    const [entry] = await seedManual("R1", [{ amount: 60, reference_id: "R1-R" }]);
    expect(await ai("R1")).toBe(0);
    expect(await manual("R1")).toMatchObject({ total: 0, pendingCount: 1, pendingAmount: 60 });
    await reviewManualSlipEntry(supa, { entryId: entry, decision: "approved", amount: 60, reason: "สลิปจริงของตลาดนี้", reviewer: "admin-2" });
    expect(await checked("R1")).toBe(60); // once: AI rejected, manual override approved
  });

  test("manual override of an entry whose AI check is live is refused (approve the AI check instead)", async () => {
    await seedCheck(db, { source: "R2", amount: 70, ref: "R2-R", time: OK_TIME });
    const [entry] = await seedManual("R2", [{ amount: 70, reference_id: "R2-R" }]);
    expect(await refusalCode(reviewManualSlipEntry(supa, { entryId: entry, decision: "approved", amount: 70, reason: "r", reviewer: "a" })))
      .toBe("manual_entry_is_ai_slip");
    expect(await checked("R2")).toBe(70);
  });

  test("AI approved then revoked: back to the automatic rule; the referenced manual entry stays superseded", async () => {
    const check = await seedCheck(db, { source: "V1", amount: 40, ref: "V1-R", time: JULY });
    const { approvalId } = await approveAi(check, 40);
    await seedManual("V1", [{ amount: 40, reference_id: "V1-R" }]);
    expect(await checked("V1")).toBe(40);
    await revokeSlipCheckReview(supa, { approvalId, revokedBy: "admin-2", reason: "ตรวจซ้ำ" });
    expect(await ai("V1")).toBe(0);                             // misdated again → pending AI
    expect(await manual("V1")).toMatchObject({ total: 0, supersededCount: 1 });
    expect((await loadMarketScopedAiVerifiedTransfers(supa, "V1", DATE, MARKET, new Set([MARKET]))).pendingDateCount).toBe(1);
  });

  test("manual entry first, AI read of the same reference later: the earlier manual entry keeps the money", async () => {
    await seedManual("O1", [{ amount: 70, reference_id: "O1-R" }]);
    expect(await checked("O1")).toBe(70);                       // manual only
    const later = await seedCheck(db, { source: "O1", amount: 70, ref: "O1-R", time: OK_TIME, createdAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await ai("O1")).toBe(0);                             // never moved to the later AI read
    expect((await loadMarketScopedAiVerifiedTransfers(supa, "O1", DATE, MARKET, new Set([MARKET]))).supersededByManualCount).toBe(1);
    expect(await manual("O1")).toMatchObject({ total: 70, supersededCount: 0 });
    expect(await checked("O1")).toBe(70);                       // still once
    expect(await refusalCode(approveAi(later, 70))).toBe("slip_check_superseded_by_manual");
  });

  test("AI first, manual later: the AI read keeps the money; a different manual amount is a pending conflict", async () => {
    await seedCheck(db, { source: "O2", amount: 70, ref: "O2-R", time: OK_TIME });
    await seedManual("O2", [{ amount: 700, reference_id: "O2-R" }]);
    expect(await ai("O2")).toBe(70);
    expect(await manual("O2")).toMatchObject({ total: 0, pendingCount: 1, pendingAmount: 700, supersededCount: 0 });
  });

  test("a wallet read (no transfer amount) never swallows a manual entry of its reference", async () => {
    await seedCheck(db, { source: "W1", amount: 0, ref: "W1-R", time: OK_TIME });
    await db.query(`UPDATE public.slip_checks SET transfer_amount = NULL, slip_type = 'GWALLET', gross_amount = 70 WHERE reference_id = 'W1-R'`);
    const [entry] = await seedManual("W1", [{ amount: 70, reference_id: "W1-R" }]);
    expect(await checked("W1")).toBe(70);                       // counted, not superseded by a non-bank read
    expect((await reviewManualSlipEntry(supa, { entryId: entry, decision: "approved", amount: 70, reason: "G-Wallet", reviewer: "a" })).already).toBe(false);
  });

  test("same amount and date, different references: two transfers, both counted", async () => {
    await seedCheck(db, { source: "D1", amount: 50, ref: "D1-A", time: OK_TIME });
    await seedCheck(db, { source: "D1", amount: 50, ref: "D1-B", time: OK_TIME });
    await seedManual("D1", [{ amount: 50, reference_id: "D1-C" }]);
    expect(await checked("D1")).toBe(150);
  });

  test("rejected AI slip never counts; revoking returns it to the automatic rule", async () => {
    const check = await seedCheck(db, { source: "A4", amount: 90, ref: "A4-R", time: OK_TIME });
    const { approvalId } = await reviewSlipCheck(supa, { checkId: check, decision: "rejected", reason: "ไม่ใช่ลูกค้าตลาดนี้", reviewer: "admin-2" });
    expect(await ai("A4")).toBe(0);
    await revokeSlipCheckReview(supa, { approvalId, revokedBy: "admin-1", reason: "ถูกต้อง" });
    expect(await ai("A4")).toBe(90);
  });

  // ── unreferenced manual entries ────────────────────────────────────────────
  test("new flow: an unreferenced entry is pending until an authorized override; legacy grammar is unchanged", async () => {
    const [newFlow, legacy] = await seedManual("U1", [{ amount: 25, requires_review: true }, { amount: 35 }]);
    expect(await manual("U1")).toMatchObject({ total: 35, pendingCount: 1, pendingAmount: 25 });
    expect(await db.scalar(`SELECT requires_review FROM public.manual_slip_entries WHERE id = '${legacy}'`)).toBe("false");
    await reviewManualSlipEntry(supa, { entryId: newFlow, decision: "approved", amount: 25, reason: "สลิปกระดาษ ไม่มีภาพ", reviewer: "admin-1" });
    expect(await manual("U1")).toMatchObject({ total: 60, pendingCount: 0 });
    const [rejected] = await seedManual("U2", [{ amount: 15, requires_review: true }]);
    await reviewManualSlipEntry(supa, { entryId: rejected, decision: "rejected", reason: "ซ้ำกับสลิป AI #3", reviewer: "admin-1" });
    expect(await manual("U2")).toMatchObject({ total: 0, pendingCount: 0 });
  });

  // ── concurrency ────────────────────────────────────────────────────────────
  test("concurrency: two different decisions at once leave exactly one active; identical retries are idempotent", async () => {
    const check = await seedCheck(db, { source: "C1", amount: 40, ref: "C1-R", time: JULY });
    const codes = await Promise.all([
      refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "approved", amount: 40, reason: "r1", reviewer: "a" })),
      refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "rejected", reason: "r2", reviewer: "b" })),
    ]);
    expect(codes.sort()).toEqual(["ok", "slip_check_already_reviewed"]);
    expect(await db.scalar(`SELECT count(*) FROM public.slip_check_approvals WHERE slip_check_id = '${check}' AND status = 'active'`)).toBe("1");

    const twin = await seedCheck(db, { source: "C2", amount: 40, ref: "C2-R", time: JULY });
    const results = await Promise.all([approveAi(twin, 40), approveAi(twin, 40), approveAi(twin, 40)]);
    expect(new Set(results.map((r) => r.approvalId)).size).toBe(1);
    expect(await ai("C2")).toBe(40);
  });

  test("close race: a review waiting behind an in-flight finalization sees it and refuses", async () => {
    const check = await seedCheck(db, { source: "Z1", amount: 40, ref: "Z1-R", time: JULY });
    // Hold an uncommitted finalization for Z1/DATE in another backend.
    const holder = Bun.spawn([PSQL, "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: db.name, PGAPPNAME: "finalize-holder" },
      stdin: new TextEncoder().encode(
        `BEGIN; INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('Z1', '${DATE}', 'sending'); SELECT pg_sleep(1.5); COMMIT;`,
      ),
      stdout: "pipe", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      if (await db.scalar(`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'finalize-holder' AND query LIKE '%pg_sleep%'`) === "1") break;
      await Bun.sleep(20);
    }
    const started = Date.now();
    const code = await refusalCode(approveAi(check, 40));
    expect(await holder.exited).toBe(0);
    expect(code).toBe("slip_check_round_finalized");      // never an approval after the close
    expect(Date.now() - started).toBeGreaterThan(500);     // it waited for the finalization's lock
    expect(await db.scalar(`SELECT count(*) FROM public.slip_check_approvals WHERE slip_check_id = '${check}'`)).toBe("0");
  });

  // ── refusals and audit ─────────────────────────────────────────────────────
  test("cross-market duplicate: only the global winner can be approved", async () => {
    const first = await seedCheck(db, { source: "X1", amount: 60, ref: "X-SAME", time: JULY, createdAt: "2026-10-29T12:00:00Z" });
    const second = await seedCheck(db, { source: "X1", amount: 60, ref: "X-SAME", time: OK_TIME, market: OTHER_MARKET, createdAt: "2026-10-29T12:30:00Z" });
    expect(await refusalCode(approveAi(second, 60))).toBe("slip_check_is_duplicate");
    await approveAi(first, 60);
    expect(await ai("X1")).toBe(60);
  });

  test("no reference: AI approval refused (BR-02 first)", async () => {
    const check = await seedCheck(db, { source: "N1", amount: 40, ref: null, time: null });
    expect(await refusalCode(approveAi(check, 40))).toBe("slip_check_reference_required");
  });

  test("after finalization: no review, no revoke, no manual override, no manual entry", async () => {
    const check = await seedCheck(db, { source: "F1", amount: 40, ref: "F1-R", time: JULY });
    const { approvalId } = await approveAi(check, 40);
    const [entry] = await seedManual("F1", [{ amount: 10, requires_review: true }]);
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('F1', '${DATE}', 'sent')`);
    expect(await refusalCode(revokeSlipCheckReview(supa, { approvalId, revokedBy: "b", reason: "x" }))).toBe("slip_check_round_finalized");
    const other = await seedCheck(db, { source: "F1", amount: 10, ref: "F1-R2", time: JULY });
    expect(await refusalCode(approveAi(other, 10))).toBe("slip_check_round_finalized");
    expect(await refusalCode(reviewManualSlipEntry(supa, { entryId: entry, decision: "approved", amount: 10, reason: "r", reviewer: "a" })))
      .toBe("slip_check_round_finalized");
    const [closed] = await db.query<{ id: string }>(`SELECT id FROM public.manual_slip_sessions WHERE source_id = 'F1'`);
    const append = await supa.rpc("append_manual_slip_entries_atomic", {
      p_session_id: closed.id, p_entries: [{ raw_line: "ยอด 10", amount: 10 }], p_line_message_id: "late", p_line_user_id: null,
    });
    expect(String(append.error?.message)).toContain("manual_slip_session_not_open");
  });

  test("audit trail: append-only, reason/reviewer/amount required; anon/authenticated cannot call or read", async () => {
    const check = await seedCheck(db, { source: "P1", amount: 40, ref: "P1-R", time: JULY });
    expect(await refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "approved", reason: "", reviewer: "a", amount: 40 }))).toBe("reason_required");
    expect(await refusalCode(reviewSlipCheck(supa, { checkId: check, decision: "approved", reason: "r", reviewer: "a" }))).toBe("amount_required");
    const { approvalId } = await approveAi(check, 40);
    expect(await sqlError(`UPDATE public.slip_check_approvals SET approved_amount = 400 WHERE id = '${approvalId}'`)).toContain("slip_check_approval_only_revoke_allowed");
    expect(await sqlError(`DELETE FROM public.slip_check_approvals WHERE id = '${approvalId}'`)).toContain("slip_check_approval_append_only");
    const privileges = await db.query<{ role: string; ok: boolean }>(
      `SELECT r AS role,
              has_function_privilege(r, 'public.review_slip_check(uuid,text,numeric,text,text)', 'EXECUTE')
              OR has_function_privilege(r, 'public.review_manual_slip_entry(uuid,text,numeric,text,text)', 'EXECUTE')
              OR has_function_privilege(r, 'public.revoke_slip_check_review(uuid,text,text)', 'EXECUTE')
              OR has_table_privilege(r, 'public.slip_check_approvals', 'SELECT') AS ok
       FROM unnest(ARRAY['anon', 'authenticated']) r`,
    );
    expect(privileges.every((p) => p.ok === false)).toBe(true);
  });

  test("legacy manual entries are untouched and counted — never linked by guessing", async () => {
    await seedManual("L1", [{ amount: 25 }, { amount: 35 }]);
    expect(await manual("L1")).toMatchObject({ total: 60, pendingCount: 0, supersededCount: 0 });
  });

  // ── review hardening (20261102140000) ──────────────────────────────────────
  test("a finalized round never changes: a later AI read of a counted manual reference is not counted anywhere", async () => {
    const [entry] = await seedManual("FR", [{ amount: 500, reference_id: "FR-R" }]);
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('FR', '${DATE}', 'sent')`);
    expect(await checked("FR")).toBe(500);
    // The same transfer read by the AI the next day, in another source/round.
    const next = await seedCheck(db, { source: "FR2", amount: 500, ref: "FR-R", time: OK_TIME, createdAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await checked("FR")).toBe(500);                      // finalized round unchanged
    expect(await ai("FR2")).toBe(0);                            // and not counted a second time
    expect(await refusalCode(approveAi(next, 500))).toBe("slip_check_superseded_by_manual");
    expect(entry).toBeTruthy();
  });

  test("only a handed-out finalization blocks reviews: failed does not, sending/sent/ambiguous do", async () => {
    for (const [source, status, expected] of [
      ["S-FAIL", "failed", "ok"], ["S-SEND", "sending", "slip_check_round_finalized"],
      ["S-SENT", "sent", "slip_check_round_finalized"], ["S-AMB", "ambiguous", "slip_check_round_finalized"],
    ] as const) {
      const check = await seedCheck(db, { source, amount: 40, ref: `${source}-R`, time: JULY });
      await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('${source}', '${DATE}', '${status}')`);
      expect(await refusalCode(approveAi(check, 40))).toBe(expected);
    }
  });

  test("the failed → sending re-claim takes the money-close lock too", async () => {
    const check = await seedCheck(db, { source: "RC", amount: 40, ref: "RC-R", time: JULY });
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('RC', '${DATE}', 'failed')`);
    const holder = Bun.spawn([PSQL, "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: db.name, PGAPPNAME: "reclaim-holder" },
      stdin: new TextEncoder().encode(
        `BEGIN; UPDATE public.settlement_finalizations SET status = 'sending' WHERE source_id = 'RC'; SELECT pg_sleep(1.5); COMMIT;`,
      ),
      stdout: "pipe", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      if (await db.scalar(`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'reclaim-holder' AND query LIKE '%pg_sleep%'`) === "1") break;
      await Bun.sleep(20);
    }
    const code = await refusalCode(approveAi(check, 40));
    expect(await holder.exited).toBe(0);
    expect(code).toBe("slip_check_round_finalized");
  });

  test("a legacy day-level finalization (no round) also closes reviews of round-bound slips of that day", async () => {
    const round = "30000000-0000-4000-8000-000000000001";
    await db.query(`INSERT INTO public.accountability_rounds (id, business_date) VALUES ('${round}', '${DATE}')`);
    const check = await seedCheck(db, { source: "LG", amount: 40, ref: "LG-R", time: JULY, round });
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('LG', '${DATE}', 'sent')`);
    expect(await refusalCode(approveAi(check, 40))).toBe("slip_check_round_finalized");
  });

  test("an identical retry after finalization returns the existing decision (idempotent)", async () => {
    const check = await seedCheck(db, { source: "IR", amount: 40, ref: "IR-R", time: JULY });
    const first = await approveAi(check, 40);
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('IR', '${DATE}', 'sent')`);
    expect(await approveAi(check, 40)).toEqual({ approvalId: first.approvalId, already: true });
  });

  test("revoke never moves money to another row: refused while the other path claims the reference", async () => {
    const check = await seedCheck(db, { source: "RV", amount: 60, ref: "RV-R", time: OK_TIME });
    const rejection = await reviewSlipCheck(supa, { checkId: check, decision: "rejected", reason: "ผิดตลาด", reviewer: "a" });
    const [entry] = await seedManual("RV", [{ amount: 60, reference_id: "RV-R" }]);
    const override = await reviewManualSlipEntry(supa, { entryId: entry, decision: "approved", amount: 60, reason: "จริง", reviewer: "b" });
    expect(await checked("RV")).toBe(60);
    expect(await refusalCode(revokeSlipCheckReview(supa, { approvalId: rejection.approvalId, revokedBy: "c", reason: "x" })))
      .toBe("slip_check_review_has_dependents");
    // The manual override can be revoked: the AI read stays rejected, nothing else takes the money.
    await revokeSlipCheckReview(supa, { approvalId: override.approvalId, revokedBy: "c", reason: "ตรวจใหม่" });
    expect(await manual("RV")).toMatchObject({ total: 0, pendingCount: 1 });
  });

  test("BR-02: a reference that already has a reviewed slip cannot be given to another check", async () => {
    const reviewed = await seedCheck(db, { source: "BR", amount: 40, ref: "BR-R", time: JULY });
    await approveAi(reviewed, 40);
    const earlier = await seedCheck(db, { source: "BR", amount: 40, ref: null, time: OK_TIME, createdAt: "2026-10-29T11:00:00Z" });
    const { resolveSlipCheckReference, ReferenceResolutionError } = await import("@/lib/slips/reference-resolution");
    await expect(resolveSlipCheckReference(supa, { checkId: earlier, referenceId: "BR-R", actor: "admin" }))
      .rejects.toBeInstanceOf(ReferenceResolutionError);
    expect(await ai("BR")).toBe(40);
  });

  // ── re-review fixes (20261102150000 + containment) ─────────────────────────
  test("normalization: a manual reference typed with spaces / no-break space matches the AI read", async () => {
    await seedCheck(db, { source: "NM", amount: 45, ref: "NM01234567", time: OK_TIME });
    await seedManual("NM", [{ amount: 45, reference_id: "NM0123 4567 " }]);
    expect(await db.scalar(`SELECT reference_id FROM public.manual_slip_entries WHERE reference_id LIKE 'NM%'`)).toBe("NM01234567");
    expect(await checked("NM")).toBe(45);
  });

  test("the SQL and TypeScript normalizers remove exactly the same characters (no ctype dependence)", async () => {
    const { normalizeSlipReference } = await import("@/lib/slips/reference-ownership");
    const codePoints = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x180e, 0x2000, 0x200a, 0x200b, 0x200d,
      0x200e, 0x2028, 0x2029, 0x202f, 0x205f, 0x2060, 0x3000, 0xfeff];
    for (const cp of codePoints) {
      const raw = `A${String.fromCodePoint(cp)}B`;
      const sql = await db.scalar(
        `SELECT public.normalize_slip_reference(convert_from(decode('${Buffer.from(raw).toString("hex")}', 'hex'), 'UTF8'))`);
      expect({ cp, sql }).toEqual({ cp, sql: normalizeSlipReference(raw)! });
    }
  });

  test("a legacy day-level finalization of the RECEIPT day closes reviews of a round-bound slip of another business day", async () => {
    const round = "30000000-0000-4000-8000-000000000002";
    await db.query(`INSERT INTO public.accountability_rounds (id, business_date) VALUES ('${round}', '2026-10-28')`);
    const check = await seedCheck(db, { source: "RD", amount: 40, ref: "RD-R", time: JULY, round }); // received on ${DATE}
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('RD', '${DATE}', 'sent')`);
    expect(await refusalCode(approveAi(check, 40))).toBe("slip_check_round_finalized");
  });

  test("BR-02: a reference that already belongs to another slip (reviewed or not) is refused", async () => {
    await seedCheck(db, { source: "BX", amount: 40, ref: "BX-R", time: OK_TIME });
    const pending = await seedCheck(db, { source: "BX", amount: 40, ref: null, time: OK_TIME, createdAt: "2026-10-29T11:00:00Z" });
    const { resolveSlipCheckReference, ReferenceResolutionError } = await import("@/lib/slips/reference-resolution");
    let refused: unknown = null;
    try { await resolveSlipCheckReference(supa, { checkId: pending, referenceId: "BX-R", actor: "admin" }); } catch (e) { refused = e; }
    expect(refused).toBeInstanceOf(ReferenceResolutionError);
    expect(await ai("BX")).toBe(40);
  });

  test("decisions are written only through the review RPCs (service_role has no direct write)", async () => {
    const rows = await db.query<{ p: string; ok: boolean }>(
      `SELECT p, has_table_privilege('service_role', 'public.slip_check_approvals', p) AS ok
       FROM unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p`,
    );
    expect(rows.every((r) => r.ok === false)).toBe(true);
  });

  // ── claim order (20261102160000) — third review ────────────────────────────
  const finalize = (source: string) =>
    db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('${source}', '${DATE}', 'sending')`);
  const setStatus = (source: string, status: string) =>
    db.query(`UPDATE public.settlement_finalizations SET status = '${status}' WHERE source_id = '${source}'`);

  test("money_claimed_at: stamped by the database on entering a handed-out status, kept on sent and stale re-claim, cleared on failed", async () => {
    const at = () => db.scalar(`SELECT coalesce(money_claimed_at::text, 'null') FROM public.settlement_finalizations WHERE source_id = 'ST'`);
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status, claimed_at, money_claimed_at)
                    VALUES ('ST', '${DATE}', 'sending', '2020-01-01', '2020-01-01')`);
    const t1 = await at();
    expect(t1.startsWith("2020")).toBe(false);
    await setStatus("ST", "sent");
    expect(await at()).toBe(t1);
    await db.query(`UPDATE public.settlement_finalizations SET claimed_at = now() WHERE source_id = 'ST'`); // stale re-claim shape
    expect(await at()).toBe(t1);
    await setStatus("ST", "failed");
    expect(await at()).toBe("null");
    await setStatus("ST", "sending");
    expect(await db.scalar(`SELECT (money_claimed_at > '${t1}'::timestamptz)::text FROM public.settlement_finalizations WHERE source_id = 'ST'`)).toBe("true");
  });

  test("claims are serialized: a claim waits for another scope's uncommitted claim and is stamped after it", async () => {
    const holder = Bun.spawn([PSQL, "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: db.name, PGAPPNAME: "claim-holder" },
      stdin: new TextEncoder().encode(
        `BEGIN; INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('SQ-1', '${DATE}', 'sending'); SELECT pg_sleep(1.5); COMMIT;`,
      ),
      stdout: "pipe", stderr: "pipe",
    });
    for (let i = 0; i < 100; i++) {
      if (await db.scalar(`SELECT count(*) FROM pg_stat_activity WHERE application_name = 'claim-holder' AND query LIKE '%pg_sleep%'`) === "1") break;
      await Bun.sleep(20);
    }
    const started = Date.now();
    await finalize("SQ-2");
    const waited = Date.now() - started;
    expect(await holder.exited).toBe(0);
    expect(waited).toBeGreaterThan(500);
    expect(await db.scalar(
      `SELECT ((SELECT money_claimed_at FROM public.settlement_finalizations WHERE source_id = 'SQ-2')
             > (SELECT money_claimed_at FROM public.settlement_finalizations WHERE source_id = 'SQ-1'))::text`,
    )).toBe("true");
  });

  test("migrations 20261102140000 to 20261103120000 re-apply cleanly (idempotent)", async () => {
    await db.exec(await file("migrations", M0));
    expect(await db.scalar(`SELECT paused::text FROM public.financial_maintenance`)).toBe("false"); // an existing switch is kept
    await db.exec(await file("migrations", M3));
    await db.exec(await file("migrations", M4));
    await db.exec(await file("migrations", M5));
    await db.exec(await file("migrations", M6));
    await db.exec(await file("migrations", M7));
    expect(await manual("L1")).toMatchObject({ total: 60 });
  });

  test("rollback (M7, M6, M5, M4, M3, M2, M1) drops the RPCs, restores the old append RPC and keeps every financial row", async () => {
    const decisions = await db.scalar(`SELECT count(*) FROM public.slip_check_approvals`);
    const entries = await db.scalar(`SELECT count(*) FROM public.manual_slip_entries`);
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('RB-CL', '${DATE}', 'sending')`);
    const finalization = await db.scalar(`SELECT id FROM public.settlement_finalizations WHERE source_id = 'RB-CL'`);
    const check = await seedCheck(db, { source: "RB-CL", amount: 9, ref: "RB-CL-R", time: OK_TIME });
    await supa.rpc("claim_slip_references", { p_finalization_id: finalization, p_claims: [{ reference_id: "RB-CL-R", slip_check_id: check, amount: 9 }] });
    const credits = await db.scalar(`SELECT count(*) FROM public.slip_reference_claims`);
    expect(Number(credits)).toBeGreaterThan(0);
    const stamped = await db.scalar(`SELECT count(money_claimed_at) FROM public.settlement_finalizations`);
    await db.exec(await file("rollback", M7));
    expect(await db.scalar(`SELECT count(*) FROM pg_trigger WHERE tgname IN ('manual_slip_sessions_scope_guard', 'manual_slip_entries_scope_guard', 'slip_check_approvals_maintenance_guard')`)).toBe("0");
    expect(await db.scalar(`SELECT has_table_privilege('service_role', 'public.manual_slip_sessions', 'UPDATE')::text`)).toBe("true");
    expect(await db.scalar(`SELECT has_table_privilege('service_role', 'public.manual_slip_entries', 'INSERT')::text`)).toBe("true");
    await db.exec(await file("rollback", M6));
    expect(await db.scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'claim_slip_references'`)).toBe("0");
    expect(await db.scalar(`SELECT count(*) FROM public.slip_reference_claims`)).toBe(credits);
    await db.exec(await file("rollback", M5));
    expect(await db.scalar(`SELECT (prosrc LIKE '%claim-order%')::text FROM pg_proc WHERE proname = 'lock_settlement_finalization_money'`)).toBe("false");
    expect(await db.scalar(`SELECT count(money_claimed_at) FROM public.settlement_finalizations`)).toBe(stamped);
    await db.exec(await file("rollback", M4));
    expect(await db.scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'normalize_slip_reference'`)).toBe("0");
    await db.exec(await file("rollback", M3));
    expect(await db.scalar(`SELECT count(*) FROM pg_proc WHERE proname IN ('lock_money_close_scope', 'manual_entry_claims_reference')`)).toBe("0");
    await db.exec(await file("rollback", M2));
    await db.exec(await file("rollback", M1));
    expect(await db.scalar(`SELECT count(*) FROM pg_proc WHERE proname IN ('review_slip_check', 'review_manual_slip_entry', 'revoke_slip_check_review', 'lock_money_close')`)).toBe("0");
    expect(await db.scalar(`SELECT count(*) FROM pg_trigger WHERE tgname = 'settlement_finalizations_money_close_lock'`)).toBe("0");
    expect(await db.scalar(`SELECT count(*) FROM public.slip_check_approvals`)).toBe(decisions);
    expect(await db.scalar(`SELECT count(*) FROM public.manual_slip_entries`)).toBe(entries);
    expect(await db.scalar(`SELECT count(*) FROM public.slip_reference_claims`)).toBe(credits);
    expect(Number(decisions)).toBeGreaterThan(0);
    await seedManual("RB", [{ amount: 12, reference_id: "ignored-by-old-rpc" }]);
    expect(await db.scalar(`SELECT count(*) FROM public.manual_slip_entries WHERE reference_id = 'ignored-by-old-rpc'`)).toBe("0");
    // The stop cannot be removed while credits exist: old code would recount them.
    const stopDown = await db.exec(await file("rollback", M0)).then(() => "dropped", (e: Error) => e.message);
    expect(stopDown).toContain("financial_stop_rollback_refused");
    expect(await db.scalar(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%_financial_stop'`)).toBe("5");
  });
});

describe.skipIf(!pgAvailable)("app code and schema at different versions (PG 17)", () => {
  test("new code on a schema WITHOUT the migrations: no decisions, manual entries counted as today", async () => {
    const old = await freshDb("slip_skew0", []);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client: any = createPgSupabase(old, { failUpload: new Set(), uploaded: new Map() });
      await seedCheck(old, { source: "S0", amount: 40, ref: "S0-R", time: OK_TIME });
      const [session] = await old.query<{ id: string }>(
        `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key)
         VALUES ('S0', '${DATE}', 'open', '${MARKET}', 'k') RETURNING id`,
      );
      await old.query(`INSERT INTO public.manual_slip_entries (session_id, sequence_no, raw_line, amount, line_message_id) VALUES ('${session.id}', 0, 'ยอด 20', 20, 'm0')`);
      await old.query(`UPDATE public.manual_slip_sessions SET status = 'closed' WHERE id = '${session.id}'`);
      expect(await loadAiVerifiedTransferTotal(client, "S0", DATE)).toBe(40);
      expect(await loadMarketScopedManualSlipBreakdown(client, "S0", DATE, MARKET)).toMatchObject({ total: 20 });
    } finally {
      await old.drop();
    }
  }, 60_000);

  test("new code with only the first migration: references honoured, review flag absent = counted", async () => {
    const mid = await freshDb("slip_skew1", [M1]);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client: any = createPgSupabase(mid, { failUpload: new Set(), uploaded: new Map() });
      await seedCheck(mid, { source: "S1", amount: 40, ref: "S1-R", time: OK_TIME });
      const [session] = await mid.query<{ id: string }>(
        `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key)
         VALUES ('S1', '${DATE}', 'open', '${MARKET}', 'k') RETURNING id`,
      );
      await mid.query(`INSERT INTO public.manual_slip_entries (session_id, sequence_no, raw_line, amount, line_message_id, reference_id)
                       VALUES ('${session.id}', 0, 'ยอด 40', 40, 'm1', 'S1-R'), ('${session.id}', 1, 'ยอด 5', 5, 'm1', NULL)`);
      await mid.query(`UPDATE public.manual_slip_sessions SET status = 'closed' WHERE id = '${session.id}'`);
      expect(await loadAiVerifiedTransferTotal(client, "S1", DATE)).toBe(40);
      expect(await loadMarketScopedManualSlipBreakdown(client, "S1", DATE, MARKET)).toMatchObject({ total: 5, supersededCount: 1 });
    } finally {
      await mid.drop();
    }
  }, 60_000);
});
