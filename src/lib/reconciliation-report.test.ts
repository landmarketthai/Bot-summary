import { describe, expect, it } from "bun:test";
import {
  deriveReconciliationStatus,
  summarizeReconciliationReport,
  filterByStatus,
  rowNeedsReview,
  type ReconciliationReportRow,
  type ReconciliationStatus,
} from "./reconciliation-report";

function row(
  status: ReconciliationStatus,
  overrides: Partial<ReconciliationReportRow> = {},
): ReconciliationReportRow {
  return {
    source_id:                "grp1",
    business_date:            "2026-06-17",
    accountability_round_id:   null,
    market:                   "ตลาดA",
    submitted_transfer_total: 1000,
    ai_verified_total:        800,
    manual_slip_total:        200,
    checked_slip_total:       1000,
    difference:               0,
    status,
    has_open_manual_session:  false,
    ...overrides,
  };
}

describe("deriveReconciliationStatus", () => {
  it("returns pending_review when a manual session is open (highest precedence)", () => {
    expect(
      deriveReconciliationStatus({
        hasReconciliation: true,
        hasOpenManualSession: true,
        difference: 0,
      }),
    ).toBe("pending_review");
  });

  it("returns missing_data when no reconciliation row exists", () => {
    expect(
      deriveReconciliationStatus({
        hasReconciliation: false,
        hasOpenManualSession: false,
        difference: null,
      }),
    ).toBe("missing_data");
  });

  it("returns missing_data when difference is null even if a row exists", () => {
    expect(
      deriveReconciliationStatus({
        hasReconciliation: true,
        hasOpenManualSession: false,
        difference: null,
      }),
    ).toBe("missing_data");
  });

  it("returns matched when difference is zero", () => {
    expect(
      deriveReconciliationStatus({
        hasReconciliation: true,
        hasOpenManualSession: false,
        difference: 0,
      }),
    ).toBe("matched");
  });

  it("treats sub-cent float dust as matched", () => {
    expect(
      deriveReconciliationStatus({
        hasReconciliation: true,
        hasOpenManualSession: false,
        difference: 0.004,
      }),
    ).toBe("matched");
  });

  it("returns transfer_over when submitted exceeds checked (difference > 0)", () => {
    expect(
      deriveReconciliationStatus({
        hasReconciliation: true,
        hasOpenManualSession: false,
        difference: 50,
      }),
    ).toBe("transfer_over");
  });

  it("returns transfer_short when submitted is below checked (difference < 0)", () => {
    expect(
      deriveReconciliationStatus({
        hasReconciliation: true,
        hasOpenManualSession: false,
        difference: -50,
      }),
    ).toBe("transfer_short");
  });
});

describe("rowNeedsReview", () => {
  it("flags every non-matched status", () => {
    expect(rowNeedsReview("matched")).toBe(false);
    expect(rowNeedsReview("transfer_short")).toBe(true);
    expect(rowNeedsReview("transfer_over")).toBe(true);
    expect(rowNeedsReview("pending_review")).toBe(true);
    expect(rowNeedsReview("missing_data")).toBe(true);
  });
});

describe("summarizeReconciliationReport", () => {
  it("sums financials and counts non-matched rows", () => {
    const rows = [
      row("matched"),
      row("transfer_short", { submitted_transfer_total: 500, checked_slip_total: 600, difference: -100 }),
      row("transfer_over",  { submitted_transfer_total: 700, checked_slip_total: 650, difference: 50 }),
    ];
    const s = summarizeReconciliationReport(rows);
    expect(s.submitted_transfer_total).toBe(2200);
    expect(s.checked_slip_total).toBe(2250);
    expect(s.difference_total).toBe(-50);
    expect(s.needs_review_count).toBe(2);
    expect(s.total_count).toBe(3);
  });

  it("treats null financials as 0 without fabricating, but still counts review", () => {
    const rows = [
      row("missing_data", {
        submitted_transfer_total: null,
        ai_verified_total: null,
        manual_slip_total: null,
        checked_slip_total: null,
        difference: null,
      }),
    ];
    const s = summarizeReconciliationReport(rows);
    expect(s.submitted_transfer_total).toBe(0);
    expect(s.checked_slip_total).toBe(0);
    expect(s.difference_total).toBe(0);
    expect(s.needs_review_count).toBe(1);
  });
});

describe("filterByStatus", () => {
  const rows = [
    row("matched"),
    row("transfer_short", { difference: -100 }),
    row("pending_review"),
    row("missing_data"),
  ];

  it("returns all rows when no filter", () => {
    expect(filterByStatus(rows, undefined)).toHaveLength(4);
  });

  it("keeps all non-matched rows for 'exception'", () => {
    expect(filterByStatus(rows, "exception")).toHaveLength(3);
  });

  it("matches an exact status", () => {
    expect(filterByStatus(rows, "pending_review")).toHaveLength(1);
    expect(filterByStatus(rows, "matched")).toHaveLength(1);
  });
});
