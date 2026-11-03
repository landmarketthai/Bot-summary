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
  createPgSupabase, createSlipTestDb, probePg, ROOT, SLIP_PIPELINE_MIGRATIONS, type SlipTestDb,
} from "@/lib/slips/testing/pg-slip-harness";

const pgAvailable = await probePg();
if (!pgAvailable && process.env.SLIP_INGEST_REQUIRE === "1") {
  throw new Error("SLIP_INGEST_REQUIRE=1 but PostgreSQL 17 harness unavailable");
}

const MIGRATIONS = [
  "20261102120000_slip_check_approval_link", "20261102130000_manual_slip_entry_review",
  "20261102140000_slip_review_hardening", "20261102150000_slip_reference_scope",
  "20261102160000_finalization_claim_order", "20261103100000_slip_reference_claims",
];
const MARKET = "วัดทุ่งลานนา";
const DATE = "2026-10-29";
const RECEIVED = "2026-10-29T12:00:00Z";
const OK_TIME = "2026-10-29T10:00:00Z";
const ARTIFACT = process.env.CLAIMS_ARTIFACT;

const file = (name: string) => Bun.file(`${ROOT}/supabase/migrations/${name}.sql`).text();

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
    // CLAIMS_BASELINE=1 reproduces the findings on the schema before 20261103100000.
    for (const m of process.env.CLAIMS_BASELINE === "1" ? MIGRATIONS.slice(0, -1) : MIGRATIONS) await db.exec(await file(m));
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
