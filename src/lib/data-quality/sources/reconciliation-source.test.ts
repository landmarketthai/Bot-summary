import { describe, expect, it } from "bun:test";
import type { ReconciliationReportRow } from "@/lib/reconciliation-report";
import { reconciliationRowsToCandidates } from "./reconciliation-source";

function row(overrides: Partial<ReconciliationReportRow>): ReconciliationReportRow {
  return {
    source_id: "source-1",
    business_date: "2026-08-25",
    accountability_round_id:   null,
    market: "ตลาดเช้า",
    submitted_transfer_total: 1000,
    ai_verified_total: 900,
    manual_slip_total: 0,
    checked_slip_total: 900,
    difference: 100,
    status: "matched",
    has_open_manual_session: false,
    ...overrides,
  };
}

describe("reconciliationRowsToCandidates", () => {
  it("matched rows produce no candidate", () => {
    expect(reconciliationRowsToCandidates([row({ status: "matched", difference: 0 })])).toHaveLength(0);
  });

  it("transfer_short / transfer_over map to financial_reconciliation_mismatch (CRITICAL category)", () => {
    const candidates = reconciliationRowsToCandidates([
      row({ status: "transfer_short", difference: -50 }),
      row({ status: "transfer_over", difference: 50, source_id: "source-2" }),
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.category === "financial_reconciliation_mismatch")).toBe(true);
  });

  it("pending_review / missing_data map to financial_evidence_incomplete", () => {
    const candidates = reconciliationRowsToCandidates([
      row({ status: "pending_review", has_open_manual_session: true }),
      row({ status: "missing_data", source_id: "source-2", difference: null }),
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.category === "financial_evidence_incomplete")).toBe(true);
  });

  it("uses source_id as the entity ref so the same source/date always keys the same way", () => {
    const candidates = reconciliationRowsToCandidates([row({ status: "transfer_short", source_id: "abc" })]);
    expect(candidates[0].entityRefs).toEqual(["abc"]);
    expect(candidates[0].businessDate).toBe("2026-08-25");
  });

  it("never puts raw amounts-as-secrets anywhere odd — technicalContext carries only display-safe fields", () => {
    const [candidate] = reconciliationRowsToCandidates([row({ status: "transfer_short" })]);
    expect(candidate.technicalContext).toEqual({
      reconciliationStatus: "transfer_short",
      market: "ตลาดเช้า",
      submittedTransferTotal: 1000,
      checkedSlipTotal: 900,
      difference: 100,
      hasOpenManualSession: false,
    });
  });
});
