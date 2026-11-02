import { describe, expect, test } from "bun:test";
import { aggregateGloballyAcceptedVerifiedTransfers, type VerifiedTransferCheckRow } from "@/lib/reconciliation";
import { slipDateIneligibility } from "@/lib/slips/financial-eligibility";
import { computeValidationFlags, parseBatchDate } from "@/lib/slips/validation-guard";

const BUSINESS_DATE = "2026-10-29";

describe("shared slip date rule", () => {
  test.each([
    ["2026-10-29T10:15:00.000Z", null, "same day"],
    ["2026-10-29T20:30:00.000Z", null, "03:30 Bangkok next day, before the 04:00 cutoff"],
    ["2026-10-30T10:00:00.000Z", null, "next calendar day (tolerance 1)"],
    ["2026-10-27T23:00:00.000Z", null, "06:00 Bangkok 28 Oct, the day before"],
    ["2026-10-27T10:00:00.000Z", "date_out_of_round", "two days before"],
    ["2026-07-29T00:15:00.000Z", "date_out_of_round", "P0 #1: ต.ค. read as ก.ค."],
    ["2026-09-29T11:02:00.000Z", "date_out_of_round", "P0 #6: read as ก.ย."],
    [null, "missing_transaction_time", "no printed date/time"],
    ["not-a-date", "invalid_transaction_time", "unparseable"],
  ] as const)("%s → %s (%s)", (time, expected) => {
    expect(slipDateIneligibility(time, BUSINESS_DATE)).toBe(expected);
  });

  test("receipt time plays no part: a correct slip sent days late stays eligible", () => {
    // The rule only reads the printed transaction time; round binding decides scope.
    expect(slipDateIneligibility("2026-10-29T10:15:00.000Z", BUSINESS_DATE)).toBeNull();
  });
});

// One fixture, both paths: whatever the LINE summary leaves pending must not be
// in the AI-verified total that reconciliation, White Sheet, settlement and
// round close all read from aggregateGloballyAcceptedVerifiedTransfers.
type Slip = { id: string; amount: number; ref: string | null; time: string | null };
const P0_BANK_SLIPS: Slip[] = [
  { id: "1", amount: 40, ref: "R1", time: "2026-07-29T00:15:00.000Z" }, // wrong month
  { id: "2", amount: 50, ref: "R2", time: "2026-10-29T08:46:31.000Z" },
  { id: "3", amount: 40, ref: "R3", time: "2026-10-29T11:50:00.000Z" },
  { id: "4", amount: 50, ref: "R4", time: "2026-07-29T09:37:00.000Z" }, // wrong month
  { id: "5", amount: 40, ref: null, time: null },                         // no date, no reference
];

function lineConfirmed(slips: Slip[]): number {
  const flags = computeValidationFlags(slips.map((s) => ({
    checkStatus: "EXTRACTED" as const, slipType: "BANK_SLIP_QR" as const, transferAmount: s.amount,
    paidAmount: null, transactionTime: s.time, referenceId: s.ref,
  })), parseBatchDate("29/10/2569"));
  return slips.reduce((sum, s, i) => sum + (flags[i].flagged ? 0 : s.amount), 0);
}

function reconciliationTotal(slips: Slip[], winners = new Set(slips.map((s) => s.id))) {
  const rows: VerifiedTransferCheckRow[] = slips.map((s) => ({
    id: s.id, evidence_id: `ev-${s.id}`, transfer_amount: s.amount, reference_id: s.ref,
    created_at: "2026-10-29T12:00:00Z", date_ineligibility: slipDateIneligibility(s.time, BUSINESS_DATE),
  }));
  return aggregateGloballyAcceptedVerifiedTransfers(rows, new Map(), winners);
}

describe("LINE summary and reconciliation agree (P0 batch 5f1b8484, bank slips)", () => {
  test("both confirm 90; the misdated 90 and the undated 40 are pending in both", () => {
    expect(lineConfirmed(P0_BANK_SLIPS)).toBe(90);
    const recon = reconciliationTotal(P0_BANK_SLIPS);
    expect(recon.attributedTotal).toBe(90);          // before the shared rule: 180
    expect(recon.pendingDateCount).toBe(2);          // #1, #4
    expect(recon.pendingDateAmount).toBe(90);
    expect(recon.pendingReferenceCount).toBe(1);     // #5 (BR-02)
  });

  test("a confirmed slip without a reference is pending in BOTH paths", () => {
    const slip: Slip[] = [{ id: "x", amount: 70, ref: null, time: "2026-10-29T10:00:00.000Z" }];
    expect(lineConfirmed(slip)).toBe(0);
    expect(reconciliationTotal(slip).attributedTotal).toBe(0);
  });
});

describe("global duplicate winner with a bad date", () => {
  test("first read misdated, later read of the same reference correct: counted zero times, never twice", () => {
    const first: Slip = { id: "first", amount: 50, ref: "SAME", time: "2026-07-29T09:37:00.000Z" };
    const later: Slip = { id: "later", amount: 50, ref: "SAME", time: "2026-10-29T09:37:00.000Z" };
    // Global winner = earliest verified check (unchanged); the later read is a duplicate.
    const recon = reconciliationTotal([first, later], new Set(["first"]));
    expect(recon.attributedTotal).toBe(0);
    expect(recon.pendingDateCount).toBe(1);
    expect(recon.pendingDateAmount).toBe(50);
  });

  test("winner correct, later duplicate misdated: counted once", () => {
    const first: Slip = { id: "first", amount: 50, ref: "SAME", time: "2026-10-29T09:37:00.000Z" };
    const later: Slip = { id: "later", amount: 50, ref: "SAME", time: "2026-07-29T09:37:00.000Z" };
    const recon = reconciliationTotal([first, later], new Set(["first"]));
    expect(recon.attributedTotal).toBe(50);
    expect(recon.pendingDateCount).toBe(0);
  });
});
