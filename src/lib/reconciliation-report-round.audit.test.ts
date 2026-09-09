import { describe, expect, it } from "bun:test";
import { fetchReconciliationReport } from "./reconciliation-report-service";

function table(rows: unknown[]) {
  const builder = {
    select: () => builder,
    gte: () => builder,
    lte: () => Promise.resolve({ data: rows, error: null }),
  };
  return builder;
}

function client(byTable: Record<string, unknown[]>) {
  return { from: (name: string) => table(byTable[name] ?? []) } as never;
}

const baseRecon = {
  source_id: "grp-a",
  business_date: "2026-09-07",
  ai_verified_total: 100,
  manual_slip_total: 0,
  checked_slip_total: 100,
  submitted_transfer_total: 100,
  difference: 0,
  matched: true,
};

describe("round-aware reconciliation report audit regressions", () => {
  it("keeps two rounds on the same source/date/market independent", async () => {
    const db = client({
      transfer_reconciliations: [
        { ...baseRecon, accountability_round_id: "round-1", submitted_transfer_total: 150, difference: 50, matched: false },
        { ...baseRecon, accountability_round_id: "round-2" },
      ],
      manual_slip_sessions: [
        { source_id: "grp-a", business_date: "2026-09-07", accountability_round_id: "round-1", market_label: "ตลาดเอ", status: "closed" },
        { source_id: "grp-a", business_date: "2026-09-07", accountability_round_id: "round-2", market_label: "ตลาดเอ", status: "closed" },
      ],
      settlement_entries: [],
    });

    const report = await fetchReconciliationReport(db, { fromDate: "2026-09-07", toDate: "2026-09-07" });
    expect(report.rows).toHaveLength(2);
    expect(new Set(report.rows.map((row) => row.accountability_round_id))).toEqual(new Set(["round-1", "round-2"]));
    expect(report.rows.find((row) => row.accountability_round_id === "round-1")?.status).toBe("transfer_over");
    expect(report.rows.find((row) => row.accountability_round_id === "round-2")?.status).toBe("matched");
    expect(report.summary.needs_review_count).toBe(1);
  });

  it("does not collide rounds from different markets", async () => {
    const db = client({
      transfer_reconciliations: [
        { ...baseRecon, accountability_round_id: "round-a" },
        { ...baseRecon, accountability_round_id: "round-b", submitted_transfer_total: 80, difference: -20, matched: false },
      ],
      manual_slip_sessions: [],
      settlement_entries: [
        { source_id: "grp-a", settlement_date: "2026-09-07", accountability_round_id: "round-a", market_name: "ตลาดเอ" },
        { source_id: "grp-a", settlement_date: "2026-09-07", accountability_round_id: "round-b", market_name: "ตลาดบี" },
      ],
    });

    const report = await fetchReconciliationReport(db, { fromDate: "2026-09-07", toDate: "2026-09-07" });
    expect(report.rows).toHaveLength(2);
    expect(report.rows.find((row) => row.accountability_round_id === "round-a")?.market).toBe("ตลาดเอ");
    expect(report.rows.find((row) => row.accountability_round_id === "round-b")?.market).toBe("ตลาดบี");
    expect(report.rows.find((row) => row.accountability_round_id === "round-b")?.status).toBe("transfer_short");
  });
});
