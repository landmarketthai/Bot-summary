import { describe, expect, test } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { prepareAtomicUpsertPayload } from "@/lib/data-quality/inbox";
import { validateProduceEntry } from "./entry-validation";
import { buildProduceReconciliationIssues } from "./reconciliation-issues";

describe("buildProduceReconciliationIssues", () => {
  const parsed = parseWeighSession([
    "ดำ-ตลาด ชั่งคืน 6/10/2569",
    "1.องุ่นแดง120บาท", "3ถุง",
    "1.มังคุด60บาท", "2กิโล",
  ].join("\n"), "2026-10-06");
  const result = validateProduceEntry({
    parsed,
    roundBound: true,
    roundRows: [
      { product_name: "องุ่นแดง", unit: "แพค", quantity: 5, price_per_unit: 120, transaction_type: "เบิก" },
      { product_name: "มังคุด", unit: "โล", quantity: 1, price_per_unit: 60, transaction_type: "เบิก" },
    ],
  });
  const issues = buildProduceReconciliationIssues({
    produceSessionId: "ps-1",
    pendingSessionKey: "key-1",
    pendingSessionGeneration: "gen-1",
    accountabilityRoundId: "round-1",
    parsed,
    reconciliation: result.reconciliation,
  });

  test("records unit mismatch, renumbering and excess return with typed and stored units", () => {
    expect(result.status).toBe("clean");
    expect(issues.map((issue) => issue.category).sort()).toEqual([
      "produce_item_renumbered",
      "produce_return_exceeds_withdrawal",
      "produce_unit_mismatch",
    ]);
    const mismatch = issues.find((issue) => issue.category === "produce_unit_mismatch")!;
    expect(mismatch.technicalContext).toMatchObject({
      produce_session_id: "ps-1", item_number: 1, original_item_number: 1, unit: "ถุง",
      raw_unit: "ถุง", withdrawn_units: ["แพค"], quantity: 3, reason: "unit_not_withdrawn",
    });
    const renumbered = issues.find((issue) => issue.category === "produce_item_renumbered")!;
    expect(renumbered.technicalContext).toMatchObject({
      item_number: 2, original_item_number: 1, unit: "โล", raw_unit: "กิโล", quantity: 2,
    });
  });

  test("is idempotent: the same session yields the same issue keys", () => {
    const again = buildProduceReconciliationIssues({
      produceSessionId: "ps-1", pendingSessionKey: "key-1", pendingSessionGeneration: "gen-1",
      accountabilityRoundId: "round-1", parsed, reconciliation: result.reconciliation,
    });
    const keys = (list: typeof issues) => prepareAtomicUpsertPayload(list).map((row) => row.issue_key).sort();
    expect(keys(again)).toEqual(keys(issues));
    expect(new Set(keys(issues)).size).toBe(issues.length);
    expect(prepareAtomicUpsertPayload(issues).every((row) => row.severity === "ADVISORY")).toBe(true);
  });
});
