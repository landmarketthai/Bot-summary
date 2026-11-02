/**
 * PR #10 review finding #4 — the per-slip list must have exactly the scope the
 * reconciliation loaders use, so that a slip shown as อ่านสำเร็จ is one that
 * actually contributes to checked_slip_total.
 *
 * The authoritative window is half-open: startUtc <= t < endUtc.
 */

import { describe, expect, it } from "bun:test";
import { RoundFakeDatabase } from "./test-fake-round-db";
import { buildGuidedRoundReport, loadGuidedSlipRows } from "./round-close";
import { buildRoundStatusMessage } from "./messages";
import { businessDateToUtcRange } from "@/lib/reconciliation";
import { listKnownProduceMarketLabels } from "@/lib/white-sheet";
import { submitSettlementEntryForSource } from "@/lib/settlement/submit-entry";
import type { GuidedJourneyContext } from "./journey";

const SOURCE = "G-1";
const DATE = "2026-07-29";
const MARKET = "วัดทุ่งลานนา";
const OTHER_MARKET = "หน้าเซเวน";

const { startUtc, endUtc } = businessDateToUtcRange(DATE);
const MID_WINDOW = "2026-07-29T05:00:00Z";

const CONTEXT: GuidedJourneyContext = {
  sessionKey: "group:G-1:user:U-op-1",
  sourceId: SOURCE,
  lineUserId: "U-op-1",
  sellerLabel: "กี้",
  marketLabel: MARKET,
  marketLabelNormalized: MARKET,
  businessDate: DATE,
  transactionType: "เบิก",
  sessionGeneration: "gen-1",
};

function baseDb(markets: string[] = [MARKET]): RoundFakeDatabase {
  const db = new RoundFakeDatabase();
  for (const market of markets) {
    db.seedKnownMarket({ sourceId: SOURCE, businessDate: DATE, marketName: market });
  }
  return db;
}

function seedSlip(
  db: RoundFakeDatabase,
  input: {
    id: string;
    market?: string | null;
    normalizedMarket?: string | null;
    amount?: number | null;
    receivedAt?: string;
    transactionTime?: string | null;
    status?: string;
    accountabilityRoundId?: string | null;
    batchId?: string | null;
  },
): void {
  const market = input.market === undefined ? MARKET : input.market;
  db.seed("slip_evidences", [
    {
      id: `ev-${input.id}`,
      source_id: SOURCE,
      market_label: market,
      market_label_normalized:
        input.normalizedMarket === undefined ? market : input.normalizedMarket,
      received_at: input.receivedAt ?? MID_WINDOW,
      accountability_round_id: input.accountabilityRoundId,
      batch_id: input.batchId ?? null,
    },
  ]);
  db.seed("slip_checks", [
    {
      id: input.id,
      evidence_id: `ev-${input.id}`,
      status: input.status ?? "EXTRACTED",
      slip_type: "BANK_SLIP_QR",
      transfer_amount: input.amount === undefined ? 1000 : input.amount,
      reference_id: `ref-${input.id}`,
      transaction_time: input.transactionTime === undefined ? MID_WINDOW : input.transactionTime,
      created_at: MID_WINDOW,
    },
  ]);
}

async function rows(db: RoundFakeDatabase, markets: string[] = [MARKET]) {
  const known = new Set(
    await listKnownProduceMarketLabels(db.asClient(), SOURCE, DATE),
  );
  for (const market of markets) expect(known.has(market)).toBe(true);
  return loadGuidedSlipRows(db.asClient(), CONTEXT, known);
}

describe("slip list scope matches the reconciliation scope", () => {
  it("omits a slip attributed to another KNOWN market instead of calling it unclear", async () => {
    const db = baseDb([MARKET, OTHER_MARKET]);
    seedSlip(db, { id: "mine" });
    seedSlip(db, { id: "theirs", market: OTHER_MARKET });

    const list = await rows(db, [MARKET, OTHER_MARKET]);
    expect(list.map((row) => row.checkId)).toEqual(["mine"]);
  });

  it("canonicalizes the raw market label and ignores a stale normalized column", async () => {
    const db = baseDb([MARKET, OTHER_MARKET]);
    seedSlip(db, {
      id: "raw-market",
      market: `  ${MARKET}  `,
      normalizedMarket: OTHER_MARKET,
      amount: 1234,
    });

    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    expect(report.slips).toEqual([
      {
        checkId: "raw-market",
        amount: 1234,
        referenceId: "ref-raw-market",
        status: "verified",
      },
    ]);
    expect(report.totals.checkedSlipTotal).toBe(1234);

    const message = buildRoundStatusMessage({
      sellerLabel: CONTEXT.sellerLabel,
      marketLabel: CONTEXT.marketLabel,
      dateThaiShort: "29/07/2569",
      totals: report.totals,
      slipCounts: [["verified", 1]],
      blockerLines: [],
      closed: false,
    });
    expect(message.text).toContain(
      report.totals.checkedSlipTotal.toLocaleString("en-US"),
    );
  });

  it("still reports an unknown or missing market as ตลาดไม่ชัด", async () => {
    const db = baseDb();
    seedSlip(db, { id: "unknown-market", market: "ตลาดที่ไม่รู้จัก" });
    seedSlip(db, { id: "no-market", market: null });

    const list = await rows(db);
    expect(list.map((row) => [row.checkId, row.status])).toEqual([
      ["unknown-market", "market_unclear"],
      ["no-market", "market_unclear"],
    ]);
  });

  it("includes received_at exactly at the window start", async () => {
    const db = baseDb();
    seedSlip(db, { id: "start", receivedAt: startUtc });
    const list = await rows(db);
    expect(list.map((row) => row.checkId)).toEqual(["start"]);
  });

  it("excludes received_at exactly at the window end", async () => {
    const db = baseDb();
    seedSlip(db, { id: "end", receivedAt: endUtc });
    const list = await rows(db);
    expect(list).toEqual([]);
  });

  it("treats a transaction time exactly at the start as inside", async () => {
    const db = baseDb();
    seedSlip(db, { id: "tx-start", transactionTime: startUtc });
    const list = await rows(db);
    expect(list[0]).toMatchObject({ checkId: "tx-start", status: "verified" });
  });

  it("a slip paid the next morning (past the 04:00 receipt cutoff) is within the shared ±1 day date rule", async () => {
    const db = baseDb();
    seedSlip(db, { id: "tx-end", transactionTime: endUtc });
    const list = await rows(db);
    expect(list[0]).toMatchObject({ checkId: "tx-end", status: "verified" });
  });

  it("two calendar days after the business date is date_mismatch", async () => {
    const db = baseDb();
    seedSlip(db, { id: "tx-late", transactionTime: "2026-07-31T05:00:00Z" });
    const list = await rows(db);
    expect(list[0]).toMatchObject({ checkId: "tx-late", status: "date_mismatch" });
  });

  it("treats a transaction time before the start as outside", async () => {
    const db = baseDb();
    seedSlip(db, { id: "tx-early", transactionTime: "2026-07-27T05:00:00Z" });
    const list = await rows(db);
    expect(list[0]).toMatchObject({ status: "date_mismatch" });
  });
});

describe("every verified row is inside the authoritative total", () => {
  const ROUND = "20000000-0000-4000-8000-000000000001";
  const sum = (slips: Array<{ status: string; amount: number | null }>) =>
    slips.filter((s) => s.status === "verified").reduce((t, s) => t + (s.amount ?? 0), 0);

  it("a late image bound to the round is listed AND counted (rows == money)", async () => {
    const db = baseDb();
    seedSlip(db, { id: "on-time", amount: 400, accountabilityRoundId: ROUND });
    // Arrived the next afternoon, after the 04:00 receipt window, but bound to this round.
    seedSlip(db, { id: "late", amount: 600, receivedAt: "2026-07-30T08:00:00Z", accountabilityRoundId: ROUND });

    const report = await buildGuidedRoundReport(db.asClient(), { ...CONTEXT, accountabilityRoundId: ROUND }, true);
    expect(report.slips.map((s) => [s.checkId, s.status])).toEqual([["on-time", "verified"], ["late", "verified"]]);
    expect(report.totals.aiVerifiedTotal).toBe(1000);
    expect(sum(report.slips)).toBe(report.totals.aiVerifiedTotal);
  });

  it("the LINE batch outlier (>= 5 slips, >= 5,000 and >= 10x median) is manual review and not counted", async () => {
    const db = baseDb();
    for (const [id, amount] of [["a", 100], ["b", 100], ["c", 100], ["d", 100], ["big", 50000]] as const) {
      seedSlip(db, { id, amount, batchId: "batch-1" });
    }
    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    expect(report.slips.find((s) => s.checkId === "big")?.status).toBe("excluded");
    expect(report.blockers).not.toContain("ocr_pending"); // #193 regression: an outlier must not deadlock the close
    expect(report.totals.aiVerifiedTotal).toBe(400);
    expect(sum(report.slips)).toBe(report.totals.aiVerifiedTotal);
  });

  it("a verified slip with no transfer amount (wallet) is listed as excluded (not counted, not blocking)", async () => {
    const db = baseDb();
    seedSlip(db, { id: "bank", amount: 300 });
    seedSlip(db, { id: "wallet", amount: null });
    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    expect(report.slips.find((s) => s.checkId === "wallet")?.status).toBe("excluded");
    expect(report.blockers).not.toContain("ocr_pending"); // #193 regression: a wallet slip must not deadlock the close
    expect(report.totals.aiVerifiedTotal).toBe(300);
  });

it("approved AI slip is verified at the approved amount; rejected is excluded; rows equal the money total", async () => {    const db = baseDb();    for (const [id, amount] of [["a", 100], ["b", 100], ["c", 100], ["d", 100], ["big", 50000]] as const) {      seedSlip(db, { id, amount, batchId: "batch-1" });    }    seedSlip(db, { id: "wrong", amount: 70 });    db.seed("slip_check_approvals", [      { id: "ap-1", slip_check_id: "big", decision: "approved", approved_amount: 500, status: "active" },      { id: "ap-2", slip_check_id: "wrong", decision: "rejected", approved_amount: null, status: "active" },    ]);    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);    const byId = Object.fromEntries(report.slips.map((s) => [s.checkId, [s.status, s.amount]]));    expect(byId.big).toEqual(["verified", 500]);    expect(byId.wrong).toEqual(["excluded", 70]);    expect(report.totals.aiVerifiedTotal).toBe(900);    expect(sum(report.slips)).toBe(report.totals.aiVerifiedTotal);    expect(report.blockers).not.toContain("ocr_pending");  });
  it("sums exactly the amounts of the verified rows", async () => {
    const db = baseDb([MARKET, OTHER_MARKET]);
    seedSlip(db, { id: "a", amount: 8000 });
    seedSlip(db, { id: "b", amount: 4000 });
    // None of these may reach the total.
    seedSlip(db, { id: "other-market", market: OTHER_MARKET, amount: 999 });
    seedSlip(db, { id: "unknown-market", market: "ไม่รู้จัก", amount: 777 });
    seedSlip(db, { id: "after-window", receivedAt: endUtc, amount: 555 });
    seedSlip(db, { id: "needs-review", status: "NEED_REVIEW", amount: 333 });

    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    const verified = report.slips.filter((row) => row.status === "verified");
    const verifiedSum = verified.reduce((sum, row) => sum + (row.amount ?? 0), 0);

    expect(verified.map((row) => row.checkId).sort()).toEqual(["a", "b"]);
    expect(verifiedSum).toBe(12000);
    // The authoritative loader agrees with what the operator was shown.
    expect(report.totals.aiVerifiedTotal).toBe(12000);
    expect(report.totals.checkedSlipTotal).toBe(12000);
    // And nothing verified is missing from the total.
    expect(report.totals.checkedSlipTotal).toBe(verifiedSum);
  });

  it("never lists another market's slip in this round's report", async () => {
    const db = baseDb([MARKET, OTHER_MARKET]);
    seedSlip(db, { id: "theirs", market: OTHER_MARKET, amount: 5000 });

    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    expect(report.slips).toEqual([]);
    expect(report.totals.aiVerifiedTotal).toBe(0);
    // Another market's slip is skipped by the loader, not counted as unresolved,
    // so it raises no attribution blocker for this round either.
    expect(report.blockers).not.toContain("attribution_ambiguous");
  });

  it("excludes date_mismatch and missing-date slips from the total, exactly as the rows say", async () => {
    const db = baseDb();
    seedSlip(db, { id: "ok", amount: 700 });
    seedSlip(db, { id: "wrong-month", amount: 1500, transactionTime: "2026-06-29T05:00:00Z" });
    seedSlip(db, { id: "no-date", amount: 300, transactionTime: null });

    const report = await buildGuidedRoundReport(db.asClient(), CONTEXT, true);
    const byId = Object.fromEntries(report.slips.map((s) => [s.checkId, s.status]));
    expect(byId).toEqual({ ok: "verified", "wrong-month": "date_mismatch", "no-date": "excluded" });
    expect(report.blockers).not.toContain("ocr_pending");
    // Shared rule (slips/financial-eligibility.ts): only the verified row is money.
    expect(report.totals.aiVerifiedTotal).toBe(700);
  });

  it("keeps same-description round A and B slip/settlement totals isolated", async () => {
    const db = baseDb();
    const roundA = "10000000-0000-4000-8000-000000000001";
    const roundB = "10000000-0000-4000-8000-000000000002";
    seedSlip(db, { id: "round-a", amount: 1000, accountabilityRoundId: roundA });
    seedSlip(db, { id: "round-b", amount: 2000, accountabilityRoundId: roundB });
    const values = {
      settlement_date: DATE,
      settlement_time: "",
      staff_name: CONTEXT.sellerLabel,
      market_name: CONTEXT.marketLabel,
      money_cash: 0,
      expenses: 0,
      labor: 0,
      notes: "",
    };
    const savedA = await submitSettlementEntryForSource(
      db.asClient(), SOURCE, { ...values, money_transfer: 1000 },
      { finalize: false, accountabilityRoundId: roundA },
    );
    const savedB = await submitSettlementEntryForSource(
      db.asClient(), SOURCE, { ...values, money_transfer: 2000 },
      { finalize: false, accountabilityRoundId: roundB },
    );
    expect([savedA.status, savedB.status]).toEqual(["saved", "saved"]);
    expect(db.tables.settlement_entries).toHaveLength(2);
    expect(db.tables.transfer_reconciliations).toHaveLength(2);

    const reportA = await buildGuidedRoundReport(
      db.asClient(),
      { ...CONTEXT, accountabilityRoundId: roundA },
      true,
    );
    const reportB = await buildGuidedRoundReport(
      db.asClient(),
      { ...CONTEXT, accountabilityRoundId: roundB },
      true,
    );

    expect(reportA.slips.map((row) => row.checkId)).toEqual(["round-a"]);
    expect(reportA.totals).toMatchObject({ checkedSlipTotal: 1000, submittedTransferTotal: 1000 });
    expect(reportB.slips.map((row) => row.checkId)).toEqual(["round-b"]);
    expect(reportB.totals).toMatchObject({ checkedSlipTotal: 2000, submittedTransferTotal: 2000 });
  });
});
