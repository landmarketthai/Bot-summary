/**
 * PostgreSQL 17, REAL settlement finalizer (tryFinalizeSettlement → reconcile →
 * money loaders), mock LINE push. One transfer reference may be credited by ONE
 * finalization only, whatever the order of finalizations, reviews, push
 * failures and late claims. "Handed out" = the checked total of every message
 * LINE actually delivered (a retry with the same retry key is not delivered
 * again — LINE answers 409).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { loadAiVerifiedTransferTotal, loadMarketScopedManualSlipBreakdown } from "@/lib/reconciliation";
import { tryFinalizeSettlement } from "@/lib/settlement-finalizer";
import { reviewManualSlipEntry, reviewSlipCheck, SlipCheckReviewError } from "@/lib/slips/check-approval";
import {
  createPgSupabase, createSlipTestDb, PGHOST, PGPASSWORD, PGPORT, PGUSER, probePg, PSQL, ROOT, SLIP_PIPELINE_MIGRATIONS, type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

const STOP = "20261102110000_financial_write_stop";
const MIGRATIONS = [
  STOP, "20261102120000_slip_check_approval_link", "20261102130000_manual_slip_entry_review",
  "20261102140000_slip_review_hardening", "20261102150000_slip_reference_scope",
  "20261102160000_finalization_claim_order", "20261103100000_slip_reference_claims", "20261103120000_financial_write_guards",
];
const MARKET = "วัดทุ่งลานนา";
const DATE = "2026-10-29";
const RECEIVED = "2026-10-29T12:00:00Z";
const OK_TIME = "2026-10-29T10:00:00Z";
const ARTIFACT = process.env.CLAIMS_ARTIFACT;

const file = (name: string) => Bun.file(`${ROOT}/supabase/migrations/${name}.sql`).text();
const RESUME = `UPDATE public.financial_maintenance SET paused = false, reason = NULL, changed_at = now()`;

let db: SlipTestDb;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supa: any;
let seq = 0;

/** Only what the finalizer reads outside the slip pipeline (Production has the full tables/views). */
const FINALIZER_STUBS = `
  ALTER TABLE public.slip_evidences ADD COLUMN IF NOT EXISTS accountability_round_id uuid;
  ALTER TABLE public.settlement_finalizations ADD COLUMN IF NOT EXISTS accountability_round_id uuid;
  ALTER TABLE public.manual_slip_sessions ADD COLUMN IF NOT EXISTS accountability_round_id uuid;
  ALTER TABLE public.transfer_reconciliations ADD COLUMN IF NOT EXISTS accountability_round_id uuid;
  CREATE TABLE IF NOT EXISTS public.accountability_rounds (id uuid PRIMARY KEY, business_date date NOT NULL);
  -- P2E identity: one finalization / reconciliation per (source, day, round), NULL round = legacy day.
  ALTER TABLE public.settlement_finalizations DROP CONSTRAINT IF EXISTS settlement_finalizations_source_id_business_date_key;
  ALTER TABLE public.settlement_finalizations ADD CONSTRAINT sf_scope UNIQUE NULLS NOT DISTINCT (source_id, business_date, accountability_round_id);
  ALTER TABLE public.transfer_reconciliations DROP CONSTRAINT IF EXISTS transfer_reconciliations_source_id_business_date_key;
  ALTER TABLE public.transfer_reconciliations ADD CONSTRAINT tr_scope UNIQUE NULLS NOT DISTINCT (source_id, business_date, accountability_round_id);
  CREATE TABLE public.settlement_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id text, settlement_date date, accountability_round_id uuid,
    money_transfer numeric DEFAULT 0, money_cash numeric DEFAULT 0, expenses numeric DEFAULT 0, labor numeric DEFAULT 0,
    staff_name text DEFAULT '', market_name text, notes text DEFAULT '');
  CREATE TABLE public.produce_transactions (
    transaction_date date, accountability_round_id uuid, staff_name text, market_name text, transaction_type text,
    total_amount numeric, product_name text, unit text, quantity numeric, price_per_unit numeric);
  CREATE TABLE public.pending_sessions (
    source_id text, terminalized boolean, finalization_status text, close_event_timestamp_ms bigint, accountability_round_id uuid);
  CREATE TABLE public.produce_sessions (
    id uuid DEFAULT gen_random_uuid(), session_date date, parser_errors jsonb, raw_message_id uuid, accountability_round_id uuid);
`;

async function seedCheck(s: { source: string; amount: number; ref: string; round?: string; createdAt?: string }): Promise<string> {
  const id = ++seq;
  const [raw] = await db.query<{ id: string }>(
    `INSERT INTO public.raw_messages (line_event_id, destination, event_type, source_type, source_id, message_id, message_type, payload)
     VALUES ('cl-evt-${id}', 'dest', 'message', 'group', '${s.source}', 'cl-msg-${id}', 'image', '{}'::jsonb) RETURNING id`);
  const [ev] = await db.query<{ id: string }>(
    `INSERT INTO public.slip_evidences (raw_message_id, line_message_id, source_id, source_type, storage_path, sha256, received_at, market_label, market_label_normalized, accountability_round_id)
     VALUES ('${raw.id}', 'cl-msg-${id}', '${s.source}', 'group', 'cl/${id}', '${id.toString(16).padStart(64, "c")}', '${RECEIVED}',
             '${MARKET}', '${MARKET}', ${s.round ? `'${s.round}'` : "NULL"}) RETURNING id`);
  const [check] = await db.query<{ id: string }>(
    `INSERT INTO public.slip_checks (evidence_id, status, slip_type, transfer_amount, reference_id, transaction_time, created_at)
     VALUES ('${ev.id}', 'EXTRACTED', 'BANK_SLIP_QR', ${s.amount}, '${s.ref}', '${OK_TIME}', '${s.createdAt ?? new Date().toISOString()}') RETURNING id`);
  return check.id;
}

async function seedManual(source: string, amount: number, ref: string): Promise<string> {
  const [session] = await db.query<{ id: string }>(
    `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key)
     VALUES ('${source}', '${DATE}', 'open', '${MARKET}', 'cl-m-${++seq}') RETURNING id`);
  const r = await supa.rpc("append_manual_slip_entries_atomic", {
    p_session_id: session.id, p_entries: [{ raw_line: `ยอด ${amount}`, amount, reference_id: ref }],
    p_line_message_id: `cl-mmsg-${seq}`, p_line_user_id: "U-op",
  });
  if (r.error) throw new Error(r.error.message);
  await db.query(`UPDATE public.manual_slip_sessions SET status = 'closed', closed_at = now() WHERE id = '${session.id}'`);
  return db.scalar(`SELECT id FROM public.manual_slip_entries WHERE session_id = '${session.id}'`);
}

const entryFor = (source: string, round?: string) => db.query(
  `INSERT INTO public.settlement_entries (source_id, settlement_date, accountability_round_id, market_name)
   VALUES ('${source}', '${DATE}', ${round ? `'${round}'` : "NULL"}, '${MARKET}')`);

const newRound = async () => {
  const id = crypto.randomUUID();
  await db.query(`INSERT INTO public.accountability_rounds (id, business_date) VALUES ('${id}', '${DATE}')`);
  return id;
};

/** Scope total the finalizer reconciled (the number its LINE message carries). */
const snapshot = async (source: string, round?: string) => Number(await db.scalar(
  `SELECT coalesce(checked_slip_total, 0) FROM public.transfer_reconciliations
   WHERE source_id = '${source}' AND business_date = '${DATE}' AND accountability_round_id ${round ? `= '${round}'` : "IS NULL"}`) || 0);

/** Live recomputation of a scope's checked total (AI + manual), as every report computes it. */
const live = async (source: string, round?: string) =>
  (await loadAiVerifiedTransferTotal(supa, source, DATE, round))
  + (await loadMarketScopedManualSlipBreakdown(supa, source, DATE, MARKET, round)).total;

type Delivery = { source: string; round?: string; checked: number };
let delivered: Delivery[] = [];
const acceptedKeys = new Set<string>();

/** LINE mock: "ok" delivers; "timeout" delivers and then throws (client timed out); a reused retry key is not re-delivered (409). */
function pushFor(source: string, round: string | undefined, mode: "ok" | "timeout" = "ok") {
  return async (_to: string, _text: string, retryKey?: string) => {
    if (!retryKey || !acceptedKeys.has(retryKey)) {
      if (retryKey) acceptedKeys.add(retryKey);
      delivered.push({ source, round, checked: await snapshot(source, round) });
    }
    if (mode === "timeout") throw new Error("LINE push timeout (delivery status unknown)");
  };
}

const finalize = (source: string, round?: string, mode: "ok" | "timeout" = "ok") =>
  tryFinalizeSettlement(supa, source, DATE, pushFor(source, round, mode), round, async () => "complete");

const handedOut = (sources: string[]) =>
  delivered.filter((d) => sources.includes(d.source)).reduce((sum, d) => sum + d.checked, 0);

const credited = async (ref: string) => {
  try {
    return await db.scalar(`SELECT coalesce((SELECT f.source_id || coalesce('/' || f.accountability_round_id, '')
      FROM public.slip_reference_claims c JOIN public.settlement_finalizations f ON f.id = c.finalization_id
      WHERE c.reference_id = '${ref}'), '—')`);
  } catch { return "(no claims table)"; }
};

function report(row: { scenario: string; before: number; expected: number; actual: number; ref: string; owner: string; unchanged: boolean }) {
  const line = `| ${row.scenario} | ${row.before} | ${row.expected} | ${row.actual} | ${row.ref} | ${row.owner} | ${row.unchanged ? "yes" : "NO"} | ${row.actual === row.expected && row.unchanged ? "PASS" : "FAIL"} |\n`;
  if (ARTIFACT) appendFileSync(ARTIFACT, line);
}

const refusal = async (p: Promise<unknown>) => {
  try { await p; return "ok"; } catch (e) { return e instanceof SlipCheckReviewError ? e.code : String(e); }
};

describe.skipIf(!pgAvailable)("one credited owner per transfer reference — real finalizer (PG 17)", () => {
  beforeAll(async () => {
    db = await createSlipTestDb("slip_claims", [
      ...SLIP_PIPELINE_MIGRATIONS, "0027_manual_slip_session.sql", "0029_settlement_finalizations.sql",
      "0030_manual_slip_market_key.sql", "20260926090000_manual_slip_atomic_append_close.sql",
    ]);
    await db.exec(FINALIZER_STUBS);
    // CLAIMS_BASELINE=1 reproduces the findings on the schema before 20261103100000 (no credits, no guards).
    for (const m of process.env.CLAIMS_BASELINE === "1" ? MIGRATIONS.slice(0, -2) : MIGRATIONS) await db.exec(await file(m));
    await db.query(RESUME); // the stop installs paused; these suites test normal operation
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
    if (ARTIFACT) writeFileSync(ARTIFACT,
      "| Scenario | Before | Expected handed out | Actual handed out | Reference | Credited owner | Finalized totals unchanged | Result |\n|---|---|---|---|---|---|---|---|\n");
  }, 120_000);
  afterAll(async () => { await db?.drop(); });

  test("P1-1: a late AI read bound to a round of an already-finalized day cannot take a transfer another market credited", async () => {
    delivered = [];
    await entryFor("P11-S");
    expect(await finalize("P11-S")).toBe("finalized");          // legacy day-level settlement, R not yet seen
    await seedManual("P11-CA", 70, "P11-R");
    await entryFor("P11-CA");
    expect(await finalize("P11-CA")).toBe("finalized");          // CA credits ฿70
    const caSent = await snapshot("P11-CA");
    const rb = await newRound();
    await seedCheck({ source: "P11-S", amount: 70, ref: "P11-R", round: rb, createdAt: new Date(Date.now() + 60_000).toISOString() });
    await entryFor("P11-S", rb);
    expect(await finalize("P11-S", rb)).toBe("finalized");
    const actual = handedOut(["P11-S", "P11-CA"]);
    const unchanged = (await live("P11-CA")) === caSent;
    report({ scenario: "P1-1 late claim vs legacy day stamp", before: 0, expected: 70, actual, ref: "P11-R", owner: await credited("P11-R"), unchanged });
    expect({ actual, unchanged }).toEqual({ actual: 70, unchanged: true });
  });

  test("P1-2: a LINE push timeout after delivery keeps the credit; another market cannot credit the same transfer", async () => {
    delivered = [];
    await seedManual("P12-CA", 70, "P12-R");                       // keyed first
    await seedCheck({ source: "P12-CB", amount: 70, ref: "P12-R", createdAt: new Date(Date.now() + 60_000).toISOString() });
    await entryFor("P12-CB");
    expect(await finalize("P12-CB", undefined, "timeout")).toBe("failed"); // LINE delivered, client timed out
    await entryFor("P12-CA");
    expect(await finalize("P12-CA")).toBe("finalized");
    expect(await finalize("P12-CB")).toBe("finalized");          // retry, same retry key: not re-delivered
    const actual = handedOut(["P12-CA", "P12-CB"]);
    const unchanged = (await live("P12-CB")) === delivered.find((d) => d.source === "P12-CB")!.checked;
    report({ scenario: "P1-2 push timeout then retry", before: 0, expected: 70, actual, ref: "P12-R", owner: await credited("P12-R"), unchanged });
    expect({ actual, unchanged }).toEqual({ actual: 70, unchanged: true });
  });

  test("P1-2b: the OWNER's push times out after delivery: its credit survives, the other market counts 0, the retry re-sends the same total", async () => {
    delivered = [];
    await seedCheck({ source: "P2B-CB", amount: 70, ref: "P2B-R", createdAt: new Date(Date.now() - 60_000).toISOString() }); // AI first
    await seedManual("P2B-CA", 70, "P2B-R");
    await entryFor("P2B-CB");
    expect(await finalize("P2B-CB", undefined, "timeout")).toBe("failed");
    expect(await db.scalar(`SELECT status FROM public.settlement_finalizations WHERE source_id = 'P2B-CB'`)).toBe("failed");
    expect(await credited("P2B-R")).toBe("P2B-CB");               // not erased by the failure
    await entryFor("P2B-CA");
    expect(await finalize("P2B-CA")).toBe("finalized");
    expect(await finalize("P2B-CB")).toBe("finalized");
    const actual = handedOut(["P2B-CA", "P2B-CB"]);
    const unchanged = (await live("P2B-CB")) === 70 && (await snapshot("P2B-CB")) === 70;
    report({ scenario: "P1-2b owner push timeout, credit kept", before: 0, expected: 70, actual, ref: "P2B-R", owner: await credited("P2B-R"), unchanged });
    expect({ actual, unchanged, ca: await live("P2B-CA") }).toEqual({ actual: 70, unchanged: true, ca: 0 });
  });

  test("P1-3: rejecting an open AI read cannot let a second manual entry credit a transfer a finalized market credited", async () => {
    delivered = [];
    await seedManual("P13-CA", 70, "P13-R");                       // M1
    const aiRead = await seedCheck({ source: "P13-Z", amount: 70, ref: "P13-R", createdAt: new Date(Date.now() + 60_000).toISOString() });
    const m2 = await seedManual("P13-CC", 70, "P13-R");             // M2
    await entryFor("P13-CA");
    expect(await finalize("P13-CA")).toBe("finalized");
    const caSent = await snapshot("P13-CA");
    await reviewSlipCheck(supa, { checkId: aiRead, decision: "rejected", reason: "ผิดตลาด", reviewer: "a" }).catch(() => undefined);
    const approval = await refusal(reviewManualSlipEntry(supa, { entryId: m2, decision: "approved", amount: 70, reason: "จริง", reviewer: "b" }));
    await entryFor("P13-CC");
    expect(await finalize("P13-CC")).toBe("finalized");
    const actual = handedOut(["P13-CA", "P13-CC", "P13-Z"]);
    const unchanged = (await live("P13-CA")) === caSent;
    report({ scenario: `P1-3 reject AI then approve M2 (approval: ${approval})`, before: 0, expected: 70, actual, ref: "P13-R", owner: await credited("P13-R"), unchanged });
    expect({ actual, unchanged }).toEqual({ actual: 70, unchanged: true });
    expect(approval).not.toBe("ok");                               // approve respects the credit
  });

  test("cross-market duplicate, AI first: the AI market credits it; the manual market's later finalization counts 0", async () => {
    delivered = [];
    await seedCheck({ source: "XA-B", amount: 55, ref: "XA-R", createdAt: new Date(Date.now() - 60_000).toISOString() });
    await seedManual("XA-A", 55, "XA-R");
    await entryFor("XA-A");
    expect(await finalize("XA-A")).toBe("finalized");            // manual market first: preview gives the AI read
    await entryFor("XA-B");
    expect(await finalize("XA-B")).toBe("finalized");
    const actual = handedOut(["XA-A", "XA-B"]);
    const owner = await credited("XA-R");
    report({ scenario: "cross-market AI vs manual (AI earlier)", before: 0, expected: 55, actual, ref: "XA-R", owner, unchanged: (await live("XA-A")) === 0 });
    expect({ actual, owner }).toEqual({ actual: 55, owner: "XA-B" });
  });

  test("two finalizations credit the same reference at the same moment: exactly one wins, the other gets its claim back", async () => {
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('CC-1', '${DATE}', 'sending'), ('CC-2', '${DATE}', 'sending')`);
    const f1 = await db.scalar(`SELECT id FROM public.settlement_finalizations WHERE source_id = 'CC-1'`);
    const f2 = await db.scalar(`SELECT id FROM public.settlement_finalizations WHERE source_id = 'CC-2'`);
    const c1 = await seedCheck({ source: "CC-1", amount: 33, ref: "CC-R" });
    const c2 = await seedCheck({ source: "CC-2", amount: 33, ref: "CC-R" });
    const [a, b] = await Promise.all([
      supa.rpc("claim_slip_references", { p_finalization_id: f1, p_claims: [{ reference_id: "CC-R", slip_check_id: c1, amount: 33 }] }),
      supa.rpc("claim_slip_references", { p_finalization_id: f2, p_claims: [{ reference_id: "CC-R", slip_check_id: c2, amount: 33 }] }),
    ]);
    expect(a.error ?? b.error).toBeNull();
    expect(await db.scalar(`SELECT count(*) FROM public.slip_reference_claims WHERE reference_id = 'CC-R'`)).toBe("1");
    expect(a.data[0].finalization_id).toBe(b.data[0].finalization_id); // both see the one winner
    report({ scenario: "concurrent credit of one reference", before: 0, expected: 1, actual: 1, ref: "CC-R", owner: await credited("CC-R"), unchanged: true });
  });

  test("reviews respect a credit: reject, approve and revoke on another row of a credited reference are refused", async () => {
    const aiRead = await seedCheck({ source: "RV-Z", amount: 44, ref: "RV-R", createdAt: new Date(Date.now() + 60_000).toISOString() });
    const approval = await reviewSlipCheck(supa, { checkId: aiRead, decision: "approved", amount: 44, reason: "ภาพจริง", reviewer: "a" });
    await seedManual("RV-A", 44, "RV-R");                          // earlier? no: later than the AI read's approval, but keyed before its createdAt
    await entryFor("RV-A");
    expect(await finalize("RV-A")).toBe("finalized");
    expect(await credited("RV-R")).toBe("RV-A");
    const { revokeSlipCheckReview } = await import("@/lib/slips/check-approval");
    expect(await refusal(revokeSlipCheckReview(supa, { approvalId: approval.approvalId, revokedBy: "b", reason: "ตรวจใหม่" }))).toBe("slip_reference_credited");
    const other = await seedCheck({ source: "RV-Y", amount: 44, ref: "RV-R" });
    expect(await refusal(reviewSlipCheck(supa, { checkId: other, decision: "rejected", reason: "ซ้ำ", reviewer: "a" }))).toBe("slip_reference_credited");
    expect(await live("RV-A")).toBe(44);
  });

  test("a manual session closed AFTER another market credited the reference never counts it", async () => {
    delivered = [];
    const [session] = await db.query<{ id: string }>(
      `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('SC-B', '${DATE}', 'open', '${MARKET}', 'sc-b') RETURNING id`);
    await supa.rpc("append_manual_slip_entries_atomic", {
      p_session_id: session.id, p_entries: [{ raw_line: "ยอด 61", amount: 61, reference_id: "SC-R" }], p_line_message_id: "sc-b-1", p_line_user_id: null });
    await seedCheck({ source: "SC-A", amount: 61, ref: "SC-R", createdAt: new Date(Date.now() + 60_000).toISOString() });
    await entryFor("SC-A");
    expect(await finalize("SC-A")).toBe("finalized");            // the earlier manual entry is still open: AI credited
    await db.query(`UPDATE public.manual_slip_sessions SET status = 'closed', closed_at = now() WHERE id = '${session.id}'`);
    await entryFor("SC-B");
    expect(await finalize("SC-B")).toBe("finalized");
    const actual = handedOut(["SC-A", "SC-B"]);
    report({ scenario: "manual session closed after settlement", before: 0, expected: 61, actual, ref: "SC-R", owner: await credited("SC-R"), unchanged: (await live("SC-A")) === 61 });
    expect({ actual, sa: await live("SC-A"), sb: await live("SC-B") }).toEqual({ actual: 61, sa: 61, sb: 0 });
  });

  test("a late image into an already-settled scope is pending, never counted; the settled total does not move", async () => {
    delivered = [];
    await seedCheck({ source: "LT-A", amount: 20, ref: "LT-R1" });
    await entryFor("LT-A");
    expect(await finalize("LT-A")).toBe("finalized");
    await seedCheck({ source: "LT-A", amount: 25, ref: "LT-R2" });   // arrives after the settlement
    report({ scenario: "late image after settlement", before: 20, expected: 20, actual: await live("LT-A"), ref: "LT-R2", owner: await credited("LT-R2"), unchanged: (await live("LT-A")) === 20 });
    expect(await live("LT-A")).toBe(20);
    expect(await credited("LT-R2")).toBe("—");
  });

  test("repeated processing of the same finalization: delivered once, credits unchanged", async () => {
    delivered = [];
    await seedCheck({ source: "RP-A", amount: 15, ref: "RP-R" });
    await entryFor("RP-A");
    expect(await finalize("RP-A")).toBe("finalized");
    const credits = await db.scalar(`SELECT count(*) FROM public.slip_reference_claims`);
    expect(await finalize("RP-A")).toBe("already_done");
    expect(delivered.length).toBe(1);
    expect(await db.scalar(`SELECT count(*) FROM public.slip_reference_claims`)).toBe(credits);
  });

  test("an unreferenced manual entry is never matched by amount: it counts on its own and is never credited", async () => {
    delivered = [];
    const [session] = await db.query<{ id: string }>(
      `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('NR-A', '${DATE}', 'open', '${MARKET}', 'nr-a') RETURNING id`);
    await supa.rpc("append_manual_slip_entries_atomic", {
      p_session_id: session.id, p_entries: [{ raw_line: "ยอด 70", amount: 70 }], p_line_message_id: "nr-a-1", p_line_user_id: null });
    await db.query(`UPDATE public.manual_slip_sessions SET status = 'closed', closed_at = now() WHERE id = '${session.id}'`);
    await seedCheck({ source: "NR-A", amount: 70, ref: "NR-R" });
    await entryFor("NR-A");
    expect(await finalize("NR-A")).toBe("finalized");
    expect(handedOut(["NR-A"])).toBe(140);                        // two rows, two identities (documented limit)
    expect(await db.scalar(`SELECT count(*) FROM public.slip_reference_claims c JOIN public.manual_slip_entries e ON e.id = c.manual_entry_id WHERE e.session_id = '${session.id}'`)).toBe("0");
  });

  test("round 5 (A): a credit counts only in its own finalization's scope — the round view of the same day never counts it again", async () => {
    delivered = [];
    const r = await newRound();
    await seedCheck({ source: "OV-S", amount: 70, ref: "OV-R", round: r });
    await entryFor("OV-S");
    expect(await finalize("OV-S")).toBe("finalized");            // legacy day finalization credits OV-R (receipt window)
    await entryFor("OV-S", r);
    expect(await finalize("OV-S", r)).toBe("finalized");         // round finalization of the same evidence
    const actual = handedOut(["OV-S"]);
    report({ scenario: "round 5 A: day view vs round view overlap", before: 0, expected: 70, actual, ref: "OV-R", owner: await credited("OV-R"), unchanged: (await live("OV-S")) === 70 });
    expect({ actual, day: await live("OV-S"), round: await live("OV-S", r) }).toEqual({ actual: 70, day: 70, round: 0 });
  });

  test("round 5 (B): a retry after a delivered-then-failed push adds no credit; a new image stays late", async () => {
    delivered = [];
    await seedCheck({ source: "RT-S", amount: 70, ref: "RT-X" });
    await entryFor("RT-S");
    expect(await finalize("RT-S", undefined, "timeout")).toBe("failed");
    await seedCheck({ source: "RT-S", amount: 50, ref: "RT-Y" });   // arrives while the row is failed
    expect(await finalize("RT-S")).toBe("finalized");              // same retry key: not re-delivered
    const actual = handedOut(["RT-S"]);
    report({ scenario: "round 5 B: retry after delivered push", before: 70, expected: 70, actual, ref: "RT-Y", owner: await credited("RT-Y"), unchanged: (await snapshot("RT-S")) === 70 });
    expect({ actual, snapshot: await snapshot("RT-S"), y: await credited("RT-Y") }).toEqual({ actual: 70, snapshot: 70, y: "—" });
  });

  test("round 6: a no-round retry never re-claims another round's failed row (it would send the day's credits twice)", async () => {
    delivered = [];
    const r = await newRound();
    await seedCheck({ source: "XR-S", amount: 70, ref: "XR-R", round: r });
    await entryFor("XR-S", r);                                      // the only settlement entry: round R
    expect(await finalize("XR-S")).toBe("finalized");              // no-round call: NULL-round row credits XR-R
    expect(await finalize("XR-S", r, "timeout")).toBe("failed");   // R row fails (its view: XR-R elsewhere)
    expect(await finalize("XR-S")).toBe("already_done");           // must not grab R's failed row
    const actual = handedOut(["XR-S"]);
    report({ scenario: "round 6: no-round retry vs another round's failed row", before: 70, expected: 70, actual, ref: "XR-R", owner: await credited("XR-R"), unchanged: (await snapshot("XR-S")) === 70 });
    expect({ actual, rStatus: await db.scalar(`SELECT status FROM public.settlement_finalizations WHERE source_id = 'XR-S' AND accountability_round_id = '${r}'`) })
      .toEqual({ actual: 70, rStatus: "failed" });
  });

  test("the credit ledger is append-only and not writable by API roles", async () => {
    const err = async (sql: string) => { try { await db.query(sql); return "no error"; } catch (e) { return e instanceof Error ? e.message : String(e); } };
    expect(await err(`UPDATE public.slip_reference_claims SET amount = 1`)).toContain("slip_reference_claims_append_only");
    expect(await err(`DELETE FROM public.slip_reference_claims`)).toContain("slip_reference_claims_append_only");
    const rows = await db.query<{ ok: boolean }>(
      `SELECT has_table_privilege(r, 'public.slip_reference_claims', 'INSERT') AS ok FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) r`);
    expect(rows.every((r) => r.ok === false)).toBe(true);
  });
});

/** Release gates (20261103120000 + fail-closed finalizer): run on their own database. */
describe.skipIf(!pgAvailable || process.env.CLAIMS_BASELINE === "1")("release gates — fail-closed schema, settled scopes, maintenance stop (PG 17)", () => {
  const freshGateDb = async (migrations: string[]) => {
    const created = await createSlipTestDb("slip_gates", [
      ...SLIP_PIPELINE_MIGRATIONS, "0027_manual_slip_session.sql", "0029_settlement_finalizations.sql",
      "0030_manual_slip_market_key.sql", "20260926090000_manual_slip_atomic_append_close.sql",
    ]);
    await created.exec(FINALIZER_STUBS);
    for (const m of migrations) await created.exec(await file(m));
    if (migrations.includes(STOP)) await created.query(RESUME);
    return created;
  };
  const pause = (on: boolean) => db.query(`UPDATE public.financial_maintenance SET paused = ${on}, reason = 'rehearsal', changed_at = now()`);
  const sqlError = async (statement: string) => {
    try { await db.query(statement); return "no error"; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };
  afterAll(async () => { await db?.drop(); });

  test("P0-A: new code on a schema WITHOUT the credit RPC never settles; after the migration the retry credits once", async () => {
    db = await freshGateDb(MIGRATIONS.slice(0, -2));               // M1–M5 only
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
    delivered = [];
    const [session] = await db.query<{ id: string }>(
      `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('NA-B', '${DATE}', 'open', '${MARKET}', 'na-b') RETURNING id`);
    await supa.rpc("append_manual_slip_entries_atomic", {
      p_session_id: session.id, p_entries: [{ raw_line: "ยอด 70", amount: 70, reference_id: "NA-R" }], p_line_message_id: "na-b-1", p_line_user_id: null });
    await seedCheck({ source: "NA-A", amount: 70, ref: "NA-R", createdAt: new Date(Date.now() + 60_000).toISOString() });
    await entryFor("NA-A");
    expect(await finalize("NA-A")).toBe("failed");                 // fail closed: nothing pushed
    await db.query(`UPDATE public.manual_slip_sessions SET status = 'closed', closed_at = now() WHERE id = '${session.id}'`);
    await entryFor("NA-B");
    expect(await finalize("NA-B")).toBe("failed");
    expect(delivered).toEqual([]);
    expect(await db.scalar(`SELECT string_agg(status, ',' ORDER BY source_id) FROM public.settlement_finalizations`)).toBe("failed,failed");
    // Schema installed: the pending settlements recover.
    for (const m of MIGRATIONS.slice(-2)) await db.exec(await file(m));
    expect(await finalize("NA-A")).toBe("finalized");
    expect(await finalize("NA-B")).toBe("finalized");
    const actual = handedOut(["NA-A", "NA-B"]);
    report({ scenario: "P0-A no credit RPC: fail closed, then recover", before: 0, expected: 70, actual, ref: "NA-R", owner: await credited("NA-R"), unchanged: true });
    expect({ actual, owner: await credited("NA-R") }).toEqual({ actual: 70, owner: "NA-B" });
    await db.drop();
  }, 120_000);

  test("P0-B: a settled scope takes no new manual money — LINE service, RPC and direct SQL are all refused", async () => {
    db = await freshGateDb(MIGRATIONS);
    supa = createPgSupabase(db, { failUpload: new Set(), uploaded: new Map() });
    delivered = [];
    await seedCheck({ source: "MD-A", amount: 70, ref: "MD-R" });
    await entryFor("MD-A");
    expect(await finalize("MD-A")).toBe("finalized");
    const { ManualSlipSessionService } = await import("@/lib/line/manual-slip-session-service");
    const svc = new ManualSlipSessionService(supa);
    const viaLine = await svc.openSession({ sourceId: "MD-A", businessDate: DATE, marketKey: "md-late", marketLabel: MARKET, lineUserId: "U", lineMessageId: "md-1" })
      .then(() => "opened", (e: Error) => e.message);
    expect(viaLine).toContain("manual_slip_scope_settled");
    expect(await sqlError(`INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('MD-A', '${DATE}', 'closed', '${MARKET}', 'md-sql')`))
      .toContain("manual_slip_scope_settled");
    // A session of another round of the same day is also covered by the day-level settlement.
    const r = await newRound();
    expect(await sqlError(`INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key, accountability_round_id) VALUES ('MD-A', '${DATE}', 'open', '${MARKET}', 'md-r', '${r}')`))
      .toContain("manual_slip_scope_settled");
    const live70 = await live("MD-A");
    report({ scenario: "P0-B late manual ฿30 after settlement", before: 70, expected: 70, actual: live70, ref: "—", owner: "refused", unchanged: live70 === 70 });
    expect(live70).toBe(70);
    // A failed settlement that already recorded credits is settled too (its retry re-sends them).
    await seedCheck({ source: "MD-F", amount: 40, ref: "MD-FR" });
    await entryFor("MD-F");
    expect(await finalize("MD-F", undefined, "timeout")).toBe("failed");
    expect(await sqlError(`INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('MD-F', '${DATE}', 'open', '${MARKET}', 'md-f')`))
      .toContain("manual_slip_scope_settled");
    // An open scope still accepts manual slips (legacy capture unchanged before settlement).
    const ok = await svc.openSession({ sourceId: "MD-OPEN", businessDate: DATE, marketKey: "md-open", marketLabel: MARKET, lineUserId: "U", lineMessageId: "md-2" });
    expect(ok.opened).toBe(true);
    await svc.appendEntries({ sessionId: ok.session!.id, entries: [{ rawLine: "ยอด 30", amount: 30 }], lineMessageId: "md-3", lineUserId: "U" });
    expect((await svc.closeSession({ sessionId: ok.session!.id, lineUserId: "U", lineMessageId: "md-4" })).total).toBe(30);
  }, 120_000);

  test("P0-C: maintenance stop — no settlement, credit, review or manual capture commits; ingestion is kept; resume settles once", async () => {
    delivered = [];
    await seedCheck({ source: "MT-A", amount: 70, ref: "MT-R" });
    await entryFor("MT-A");
    // An in-flight settlement claimed before the stop, not yet credited.
    await db.query(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('MT-FLY', '${DATE}', 'sending')`);
    await pause(true);
    const stopped = await finalize("MT-A").then((r) => r, (e: Error) => e.message);
    expect(String(stopped)).toContain("financial_maintenance");
    const inFlight = await db.scalar(`SELECT id FROM public.settlement_finalizations WHERE source_id = 'MT-FLY'`);
    const claim = await supa.rpc("claim_slip_references", { p_finalization_id: inFlight, p_claims: [] });
    expect(String(claim.error?.message)).toContain("financial_maintenance");
    expect(await sqlError(`UPDATE public.settlement_finalizations SET status = 'failed' WHERE source_id = 'MT-FLY'`)).toBe("no error"); // its outcome can still be recorded
    const aiRead = await seedCheck({ source: "MT-B", amount: 9, ref: "MT-B-R" });                     // ingestion keeps working
    expect(await refusal(reviewSlipCheck(supa, { checkId: aiRead, decision: "rejected", reason: "x", reviewer: "a" }))).toContain("financial_maintenance");
    expect(await sqlError(`INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('MT-M', '${DATE}', 'open', '${MARKET}', 'mt-m')`))
      .toContain("financial_maintenance");
    expect(await db.scalar(`SELECT count(*) FROM public.slip_reference_claims WHERE reference_id LIKE 'MT-%'`)).toBe("0");
    expect(await db.scalar(`SELECT count(*) FROM public.settlement_finalizations WHERE source_id = 'MT-A'`)).toBe("0");
    expect(delivered).toEqual([]);
    await pause(false);
    expect(await finalize("MT-A")).toBe("finalized");
    const actual = handedOut(["MT-A"]);
    report({ scenario: "P0-C maintenance stop then resume", before: 0, expected: 70, actual, ref: "MT-R", owner: await credited("MT-R"), unchanged: true });
    expect({ actual, owner: await credited("MT-R") }).toEqual({ actual: 70, owner: "MT-A" });
  }, 120_000);

  test("exception register (read-only SQL) runs and lists exactly the settlement an operator must explain", async () => {
    // Header comments carry a sample SET with a semicolon; the query itself is one statement.
    const register = (await Bun.file(`${ROOT}/docs/sql/slip-money-exception-register.sql`).text()).replace(/^--.*$/gm, "");
    await db.query(`SET register.from_day = '2026-10-01'`);
    const rows = await db.query<{ check_name: string; source_id: string }>(register);
    // MD-F: credits recorded, then the push failed — the only open exception here.
    expect(rows.map((r) => `${r.check_name}|${r.source_id}`)).toEqual(["E1 credited_not_delivered|MD-F"]);
  });
});

/**
 * Release blockers, round 7 (each test builds and drops its own database):
 * the stop exists before M1 and starts paused (P0-1); it is a lock, not a
 * read (P0-2); manual slips are immutable for service_role (P1-3); the
 * exception register has no false negatives (P1-4); the pilot allowlist
 * isolates one source at the database (P1-6).
 */
describe.skipIf(!pgAvailable || process.env.CLAIMS_BASELINE === "1")("release blockers — pre-M1 stop, locked stop, immutable manual slips, register, pilot scope (PG 17)", () => {
  const gateDb = async (migrations: string[]) => {
    const created = await createSlipTestDb("slip_stop", [
      ...SLIP_PIPELINE_MIGRATIONS, "0027_manual_slip_session.sql", "0029_settlement_finalizations.sql",
      "0030_manual_slip_market_key.sql", "20260926090000_manual_slip_atomic_append_close.sql",
    ]);
    await created.exec(FINALIZER_STUBS);
    for (const m of migrations) await created.exec(await file(m));
    db = created;
    supa = createPgSupabase(created, { failUpload: new Set(), uploaded: new Map() });
    delivered = [];
  };
  const sqlError = async (statement: string) => {
    try { await db.query(statement); return "no error"; } catch (e) { return e instanceof Error ? e.message : String(e); }
  };
  const outcome = (p: Promise<unknown>) => p.then((r) => String(r), (e: Error) => e.message);
  const openSession = (source: string, key: string) => db.query<{ id: string }>(
    `INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key)
     VALUES ('${source}', '${DATE}', 'open', '${MARKET}', '${key}') RETURNING id`);

  /** A psql backend driven over stdin, so two transactions interleave in a fixed order. */
  const backend = (app: string) => {
    const proc = Bun.spawn([PSQL, "-X", "-q", "-tA"], {
      env: { ...process.env, PGHOST, PGUSER, PGPASSWORD, PGPORT, PGDATABASE: db.name, PGAPPNAME: app },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    return {
      send(statement: string) { proc.stdin.write(`${statement}\n`); proc.stdin.flush(); },
      async close() {
        proc.stdin.end();
        const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
        await proc.exited;
        return `${out}${err}`;
      },
    };
  };
  /** Polls the backend's state; the 10 s ceiling only bounds a failure, the order itself is state-driven. */
  const reaches = async (app: string, want: "idle in transaction" | "Lock") => {
    for (let i = 0; i < 500; i++) {
      const [row] = await db.query<{ state: string; wait: string | null }>(
        `SELECT state, wait_event_type AS wait FROM pg_stat_activity WHERE application_name = '${app}'`);
      if (row && (want === "Lock" ? row.wait === "Lock" : row.state === want)) return true;
      await Bun.sleep(20);
    }
    return false;
  };

  test("P0-1: the stop is installed before M1 and starts paused — no code version commits money while M1–M7 apply; resume settles once", async () => {
    await gateDb([]);                                                   // Production today: no money migrations
    try {
      // Before the window: a slip, an entry, an open manual session (old code at work).
      await seedCheck({ source: "PM-A", amount: 70, ref: "PM-R" });
      await entryFor("PM-A");
      const [open] = await openSession("PM-M", "pm-m");
      await db.exec(await file(STOP));
      expect(await db.scalar(`SELECT paused::text FROM public.financial_maintenance`)).toBe("true");
      // Every money write the deployed code makes is refused by the database.
      const refused = {
        legacyEntry: await sqlError(`INSERT INTO public.settlement_entries (settlement_date, market_name) VALUES ('${DATE}', '${MARKET}')`),
        sourceEntry: await sqlError(`INSERT INTO public.settlement_entries (source_id, settlement_date, market_name) VALUES ('PM-A', '${DATE}', '${MARKET}')`),
        entryEdit: await sqlError(`UPDATE public.settlement_entries SET money_transfer = 140 WHERE source_id = 'PM-A'`),
        reconciliation: await sqlError(`INSERT INTO public.transfer_reconciliations (source_id, business_date) VALUES ('PM-A', '${DATE}')`),
        finalization: await sqlError(`INSERT INTO public.settlement_finalizations (source_id, business_date, status) VALUES ('PM-A', '${DATE}', 'sending')`),
        manualOpen: await sqlError(`INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('PM-B', '${DATE}', 'open', '${MARKET}', 'pm-b')`),
        manualAppend: String((await supa.rpc("append_manual_slip_entries_atomic", {
          p_session_id: open.id, p_entries: [{ raw_line: "ยอด 70", amount: 70 }], p_line_message_id: "pm-1", p_line_user_id: "U" })).error?.message),
        manualClose: String((await supa.rpc("close_manual_slip_session_atomic", {
          p_session_id: open.id, p_line_user_id: "U", p_line_message_id: "pm-2" })).error?.message),
        settlement: await outcome(finalize("PM-A")),
      };
      for (const [writer, message] of Object.entries(refused)) expect(`${writer}: ${message}`).toContain("financial_maintenance");
      await seedCheck({ source: "PM-B", amount: 9, ref: "PM-B-R" });   // evidence ingestion keeps working
      // M1–M7 apply while stopped (DDL only); the stop holds across them.
      for (const m of MIGRATIONS.slice(1)) await db.exec(await file(m));
      expect(await outcome(finalize("PM-A"))).toContain("financial_maintenance");
      expect(delivered).toEqual([]);
      expect(await db.scalar(`SELECT count(*) FROM public.settlement_finalizations`)).toBe("0");
      expect(await db.scalar(`SELECT count(*) FROM public.transfer_reconciliations`)).toBe("0");
      expect(await db.scalar(`SELECT count(*) FROM public.manual_slip_entries`)).toBe("0");
      // Resume once the deploy is verified: one settlement, the credited total.
      await db.query(RESUME);
      expect(await finalize("PM-A")).toBe("finalized");
      const actual = handedOut(["PM-A"]);
      report({ scenario: "P0-1 stop before M1, migrate, resume", before: 0, expected: 70, actual, ref: "PM-R", owner: await credited("PM-R"), unchanged: true });
      expect({ actual, owner: await credited("PM-R") }).toEqual({ actual: 70, owner: "PM-A" });
    } finally { await db.drop(); }
  }, 180_000);

  test("P0-2: the stop is a lock — a pause waits for writes in progress, and a write behind a pause is refused", async () => {
    await gateDb(MIGRATIONS);
    try {
      await db.query(RESUME);
      // (a) A write is in progress; the pause must wait for it (a plain read would not).
      const writer = backend("stop-writer");
      const pauser = backend("stop-pauser");
      writer.send(`BEGIN; INSERT INTO public.settlement_entries (source_id, settlement_date, market_name) VALUES ('LK-A', '${DATE}', 'w1');`);
      expect(await reaches("stop-writer", "idle in transaction")).toBe(true);
      pauser.send(`UPDATE public.financial_maintenance SET paused = true, reason = 'race';`);
      expect(await reaches("stop-pauser", "Lock")).toBe(true);
      // The same transaction writes again while the pause is queued: no deadlock, it commits.
      writer.send(`INSERT INTO public.transfer_reconciliations (source_id, business_date) VALUES ('LK-A', '${DATE}'); COMMIT;`);
      expect(await writer.close()).not.toContain("ERROR");
      expect(await pauser.close()).not.toContain("ERROR");
      expect(await db.scalar(`SELECT paused::text FROM public.financial_maintenance`)).toBe("true");
      expect(await db.scalar(`SELECT count(*) FROM public.settlement_entries WHERE source_id = 'LK-A'`)).toBe("1");
      expect(await db.scalar(`SELECT count(*) FROM public.transfer_reconciliations WHERE source_id = 'LK-A'`)).toBe("1");
      // When the pause returned, nothing was in progress; anything later is refused.
      expect(await sqlError(`INSERT INTO public.settlement_entries (source_id, settlement_date, market_name) VALUES ('LK-A', '${DATE}', 'late')`))
        .toContain("financial_maintenance");

      // (b) The pause is in progress (not committed); a write must wait and then be refused.
      await db.query(RESUME);
      const pauser2 = backend("stop-pauser-2");
      const writer2 = backend("stop-writer-2");
      pauser2.send(`BEGIN; UPDATE public.financial_maintenance SET paused = true, reason = 'race';`);
      expect(await reaches("stop-pauser-2", "idle in transaction")).toBe(true);
      // The legacy /api/settlement path (no source_id) upserts settlement_entries and returns on
      // its error BEFORE notify_line, so this refused write means no LINE message.
      writer2.send(`INSERT INTO public.settlement_entries (settlement_date, market_name) VALUES ('${DATE}', 'legacy-no-source');`);
      expect(await reaches("stop-writer-2", "Lock")).toBe(true);
      pauser2.send(`COMMIT;`);
      expect(await pauser2.close()).not.toContain("ERROR");
      expect(await writer2.close()).toContain("financial_maintenance");
      expect(await db.scalar(`SELECT count(*) FROM public.settlement_entries WHERE market_name = 'legacy-no-source'`)).toBe("0");
    } finally { await db.drop(); }
  }, 120_000);

  test("P0-2b: review entry points check stop before taking money-close locks; outcomes may still finish", async () => {
    await gateDb(MIGRATIONS);
    try {
      await db.query(RESUME);
      const checkId = await seedCheck({ source: "LK-REVIEW", amount: 70, ref: "LK-R" });
      const entryId = await seedManual("LK-REVIEW", 30, "LK-M");
      await db.query(`UPDATE public.financial_maintenance SET paused = true`);
      // Review RPCs call these entry points before writing an approval row.
      // A stop must therefore be held BEFORE they take the advisory scope lock.
      expect(await sqlError(`SELECT public.assert_slip_check_round_open('${checkId}')`))
        .toContain("financial_maintenance");
      expect(await sqlError(`SELECT public.assert_manual_entry_round_open('${entryId}')`))
        .toContain("financial_maintenance");
      await db.query(RESUME);
      await db.query(`UPDATE public.financial_maintenance SET pilot_sources = ARRAY['LK-PILOT']`);
      expect(await sqlError(`SELECT public.assert_slip_check_round_open('${checkId}')`))
        .toContain("financial_maintenance_pilot_scope");
      expect(await sqlError(`SELECT public.assert_manual_entry_round_open('${entryId}')`))
        .toContain("financial_maintenance_pilot_scope");
      await db.query(`UPDATE public.financial_maintenance SET pilot_sources = NULL`);
      expect(await sqlError(`SELECT public.assert_slip_check_round_open('${checkId}')`))
        .toBe("no error");
    } finally { await db.drop(); }
  }, 120_000);

  test("P1-3: service_role cannot UPDATE, DELETE or TRUNCATE manual slips; open → append → close still works", async () => {
    await gateDb(MIGRATIONS.slice(0, -1));
    try {
      // Supabase grants service_role table writes before M7; M7 narrows them.
      await db.query(`GRANT USAGE ON SCHEMA public TO service_role`);
      await db.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO service_role`);
      await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.manual_slip_sessions, public.manual_slip_entries TO service_role`);
      await db.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role`);
      await db.exec(await file(MIGRATIONS.at(-1)!));
      await db.query(RESUME);
      const asService = (statement: string) => db.exec(`SET ROLE service_role;\n${statement};`).then(() => "no error", (e: Error) => e.message);

      expect(await db.scalar(`SELECT has_table_privilege('service_role', 'public.manual_slip_sessions', 'INSERT')::text`)).toBe("true");
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) {
        expect(await db.scalar(`SELECT has_table_privilege('service_role', 'public.manual_slip_sessions', '${privilege}')::text`)).toBe("false");
      }
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        expect(await db.scalar(`SELECT has_table_privilege('service_role', 'public.manual_slip_entries', '${privilege}')::text`)).toBe("false");
      }

      await seedManual("IM-A", 70, "IM-R");
      await entryFor("IM-A");
      expect(await finalize("IM-A")).toBe("finalized");
      const entry = await db.scalar(`SELECT m.id FROM public.manual_slip_entries m JOIN public.manual_slip_sessions s ON s.id = m.session_id WHERE s.source_id = 'IM-A'`);
      const attempts = {
        editAmount: await asService(`UPDATE public.manual_slip_entries SET amount = 999 WHERE id = '${entry}'`),
        dropReference: await asService(`UPDATE public.manual_slip_entries SET reference_id = NULL WHERE id = '${entry}'`),
        deleteEntry: await asService(`DELETE FROM public.manual_slip_entries WHERE id = '${entry}'`),
        reopen: await asService(`UPDATE public.manual_slip_sessions SET status = 'open', closed_at = NULL WHERE source_id = 'IM-A'`),
        moveDay: await asService(`UPDATE public.manual_slip_sessions SET business_date = business_date + 1 WHERE source_id = 'IM-A'`),
        deleteSession: await asService(`DELETE FROM public.manual_slip_sessions WHERE source_id = 'IM-A'`),
      };
      for (const [attempt, message] of Object.entries(attempts)) expect(`${attempt}: ${message}`).toContain("permission denied");
      expect(await asService(`TRUNCATE public.manual_slip_entries`)).toContain("permission denied");
      // Owner/direct SQL is still stopped by the immutable trigger.
      expect(await sqlError(`TRUNCATE public.manual_slip_entries, public.manual_slip_sessions CASCADE`)).toContain("manual_slip_immutable");
      expect(await asService(`INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('IM-A', '${DATE}', 'open', '${MARKET}', 'im-late')`))
        .toContain("manual_slip_scope_settled");
      const liveAfter = await live("IM-A");
      report({ scenario: "P1-3 service_role edits a settled manual slip", before: 70, expected: 70, actual: liveAfter, ref: "IM-R", owner: await credited("IM-R"), unchanged: liveAfter === 70 });
      expect({ live: liveAfter, stored: await snapshot("IM-A"), amount: await db.scalar(`SELECT amount FROM public.manual_slip_entries WHERE id = '${entry}'`) })
        .toEqual({ live: 70, stored: 70, amount: "70.00" });

      // Legitimate capture as service_role in an open scope: open, append, close.
      expect(await asService(`INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('IM-OPEN', '${DATE}', 'open', '${MARKET}', 'im-open')`)).toBe("no error");
      const sessionId = await db.scalar(`SELECT id FROM public.manual_slip_sessions WHERE source_id = 'IM-OPEN'`);
      // Even an owner-level direct SQL write may not silently mutate an open
      // session. The only legal UPDATE is the atomic open -> closed transition.
      expect(await sqlError(`UPDATE public.manual_slip_sessions SET market_label = 'tampered' WHERE id = '${sessionId}'`))
        .toContain("manual_slip_immutable");
      expect(await asService(`SELECT public.append_manual_slip_entries_atomic('${sessionId}', '[{"raw_line":"ยอด 30","amount":30}]'::jsonb, 'im-3', 'U')`)).toBe("no error");
      expect(await asService(`UPDATE public.manual_slip_entries SET amount = 1 WHERE session_id = '${sessionId}'`)).toContain("permission denied");
      expect(await asService(`SELECT public.close_manual_slip_session_atomic('${sessionId}', 'U', 'im-4')`)).toBe("no error");
      expect(await live("IM-OPEN")).toBe(30);
    } finally { await db.drop(); }
  }, 120_000);

  test("P1-4: exception register — every check E1..E7 lists its positive case and not its negative twin", async () => {
    await gateDb(MIGRATIONS);
    try {
      await db.query(RESUME);
      const register = (await Bun.file(`${ROOT}/docs/sql/slip-money-exception-register.sql`).text()).replace(/^--.*$/gm, "");
      const run = async (cutover?: string) => {
        const conn = await db.sql.reserve();
        try {
          await conn.unsafe(`SET register.from_day = '2026-10-01'`);
          await conn.unsafe(`SET register.cutover_at = '${cutover ?? ""}'`);
          const rows = (await conn.unsafe(register)) as unknown as Array<{ check_name: string; source_id: string }>;
          return rows.map((r) => `${r.check_name.slice(0, 2)}|${r.source_id}`);
        } finally { conn.release(); }
      };
      // E2 with NO credit anywhere yet (the old min(created_at) was NULL and hid it).
      await db.exec(`SET session_replication_role = replica;
        INSERT INTO public.settlement_finalizations (source_id, business_date, status, claimed_at, message_sent_at)
        VALUES ('E2-P', '${DATE}', 'sent', now(), now()), ('E2-N', '${DATE}', 'sent', now() - interval '2 hours', now() - interval '2 hours');`);
      expect(await run()).toEqual(["E2|E2-N", "E2|E2-P"]);             // no cutover given: nothing hidden
      const cutover = await db.scalar(`SELECT (now() - interval '1 hour')::text`);
      expect(await run(cutover)).toEqual(["E2|E2-P"]);                // E2-N was sent before the release

      await seedCheck({ source: "E4-P", amount: 70, ref: "E4LATE" });
      const e4Own = await seedCheck({ source: "E4-N", amount: 70, ref: "E4OWN" });
      const e5Split = await seedCheck({ source: "E5-P", amount: 70, ref: "E5SPLIT", round: await newRound() });
      const e5Day = await seedCheck({ source: "E5-N", amount: 70, ref: "E5DAY" });
      // Seeded as legacy / defective history (triggers off): exactly what the register must catch.
      await db.exec(`SET session_replication_role = replica;
        INSERT INTO public.settlement_finalizations (source_id, business_date, status, claimed_at, message_sent_at, claims_recorded_at)
        SELECT v.source, '${DATE}', v.status, now() - interval '1 hour', CASE WHEN v.status = 'sent' THEN now() END, now() - interval '1 hour'
        FROM (VALUES ('E1-P', 'failed'), ('E1-N', 'sent'), ('E3-P', 'sent'), ('E3-N', 'sent'), ('E4-P', 'sent'), ('E4-N', 'sent'),
                     ('E5-P', 'sent'), ('E5-N', 'sent'), ('E6-P', 'failed'), ('E6-N', 'failed'), ('E7-P', 'sent'), ('E7-N', 'sent'))
             AS v(source, status);
        INSERT INTO public.slip_reference_claims (reference_id, finalization_id, slip_check_id, manual_entry_id, amount)
        SELECT v.ref, f.id, v.chk::uuid, CASE WHEN v.chk IS NULL THEN gen_random_uuid() END, v.amount
        FROM (VALUES ('E1P', 'E1-P', NULL, 70), ('E1N', 'E1-N', NULL, 70), ('E3P', 'E3-P', NULL, 100), ('E3N', 'E3-N', NULL, 70),
                     ('E4OWN', 'E4-N', '${e4Own}', 70), ('E5SPLIT', 'E5-P', '${e5Split}', 70), ('E5DAY', 'E5-N', '${e5Day}', 70),
                     ('E6P', 'E6-P', NULL, 70), ('E6N', 'E6-N', NULL, 70), ('E7P', 'E7-P', NULL, 70), ('E7N', 'E7-N', NULL, 70))
             AS v(ref, source, chk, amount)
        JOIN public.settlement_finalizations f ON f.source_id = v.source;
        INSERT INTO public.transfer_reconciliations (source_id, business_date, checked_slip_total) VALUES
          ('E3-P', '${DATE}', 70), ('E3-N', '${DATE}', 70), ('E7-P', '${DATE}', 100), ('E7-N', '${DATE}', 100);
        INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key, closed_at) VALUES
          ('E6-P', '${DATE}', 'closed', '${MARKET}', 'e6p', now()), ('E6-N', '${DATE}', 'closed', '${MARKET}', 'e6n', now()),
          ('E7-N', '${DATE}', 'closed', '${MARKET}', 'e7n', now() - interval '3 hours');
        INSERT INTO public.manual_slip_entries (session_id, sequence_no, raw_line, amount, line_message_id, created_at)
        SELECT s.id, 1, 'ยอด', v.amount, 'reg-' || v.source, v.created_at
        FROM (VALUES ('E6-P', 5, now()), ('E6-N', 5, now() - interval '2 hours'), ('E7-N', 30, now() - interval '3 hours'))
             AS v(source, amount, created_at)
        JOIN public.manual_slip_sessions s ON s.source_id = v.source;`);
      expect(await run(cutover)).toEqual([
        "E1|E1-P", "E1|E6-N", "E1|E6-P",   // credited, not delivered (the E6 twins are failed-but-credited)
        "E2|E2-P",
        "E3|E3-P",
        "E4|E4-P",
        "E5|E5-P",
        "E6|E6-P",                          // the failed-but-credited scope the old status filter missed
        "E7|E3-P", "E7|E7-P",               // E3-P also differs from its stored total (100 credited vs 70)
      ]);
    } finally { await db.drop(); }
  }, 120_000);

  test("P1-6: the pilot allowlist isolates one source at the database; clearing it releases the others", async () => {
    await gateDb(MIGRATIONS);
    try {
      await db.query(RESUME);
      await seedCheck({ source: "PL-A", amount: 70, ref: "PL-AR" });
      const other = await seedCheck({ source: "PL-B", amount: 40, ref: "PL-BR" });
      await entryFor("PL-A");
      await entryFor("PL-B");
      // Pilot window: only PL-A may write money.
      await db.query(`UPDATE public.financial_maintenance SET paused = false, pilot_sources = ARRAY['PL-A'], reason = 'pilot'`);
      expect(await finalize("PL-A")).toBe("finalized");
      const blocked = {
        settlement: await outcome(finalize("PL-B")),
        legacyEntry: await sqlError(`INSERT INTO public.settlement_entries (settlement_date, market_name) VALUES ('${DATE}', 'legacy')`),
        manual: await sqlError(`INSERT INTO public.manual_slip_sessions (source_id, business_date, status, market_label, market_key) VALUES ('PL-B', '${DATE}', 'open', '${MARKET}', 'pl-b')`),
        review: await refusal(reviewSlipCheck(supa, { checkId: other, decision: "rejected", reason: "x", reviewer: "a" })),
        moveIntoPilot: await sqlError(`UPDATE public.settlement_entries SET source_id = 'PL-A' WHERE source_id = 'PL-B'`),
      };
      for (const [writer, message] of Object.entries(blocked)) expect(`${writer}: ${message}`).toContain("financial_maintenance");
      expect(handedOut(["PL-B"])).toBe(0);
      expect(await db.scalar(`SELECT count(*) FROM public.settlement_finalizations WHERE source_id = 'PL-B'`)).toBe("0");
      await db.query(`UPDATE public.financial_maintenance SET pilot_sources = NULL, reason = NULL`);
      expect(await finalize("PL-B")).toBe("finalized");
      const actual = handedOut(["PL-A", "PL-B"]);
      report({ scenario: "P1-6 pilot allowlist, then release", before: 0, expected: 110, actual, ref: "PL-AR/PL-BR", owner: `${await credited("PL-AR")},${await credited("PL-BR")}`, unchanged: true });
      expect(actual).toBe(110);
    } finally { await db.drop(); }
  }, 120_000);
});
