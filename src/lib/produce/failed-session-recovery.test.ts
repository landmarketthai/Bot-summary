import { describe, expect, test } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { classifyRecovery } from "./failed-session-recovery";

const DUPLICATE_NUMBERED_VEG = parseWeighSession([
  "ป้าลี-พาซิโอ้ผัก เบิก 6/10/2569",
  "1.กะหล่ำปลี30บาท", "10หัว",
  "2.ผักกาดขาว20บาท", "8หัว",
  "2.คะน้า40บาท", "5กำ",
].join("\n"));

describe("classifyRecovery (dry run, pure)", () => {
  test("a session refused only for numbering would now recover", () => {
    const result = classifyRecovery({ parsed: DUPLICATE_NUMBERED_VEG, roundRows: [], roundBound: false, alreadyPersisted: false });
    expect(result).toMatchObject({
      verdict: "would_recover", reasons: [], itemCount: 3, totalBaht: 660, renumberedItems: 1, sections: ["vegetable"],
    });
    expect(result.businessFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("never proposes a document that is already persisted", () => {
    expect(classifyRecovery({ parsed: DUPLICATE_NUMBERED_VEG, roundRows: [], roundBound: false, alreadyPersisted: true }).verdict)
      .toBe("already_persisted");
  });

  test("a line with no price stays blocked, with the reason", () => {
    const parsed = parseWeighSession(["ป้าลี-พาซิโอ้ผัก เบิก 6/10/2569", "1.กะหล่ำปลี", "10หัว"].join("\n"));
    const result = classifyRecovery({ parsed, roundRows: [], roundBound: false, alreadyPersisted: false });
    expect(result.verdict).toBe("still_blocked");
    expect(result.reasons.join(" ")).toContain("กะหล่ำปลี");
  });

  test("a return above its withdrawal recovers and is listed for reconciliation", () => {
    const parsed = parseWeighSession(["ป้าลี-พาซิโอ้ผัก ชั่งคืน 6/10/2569", "1.กะหล่ำปลี30บาท", "12หัว"].join("\n"));
    const result = classifyRecovery({
      parsed,
      roundRows: [{ product_name: "กะหล่ำปลี", unit: "หัว", quantity: 10, price_per_unit: 30, transaction_type: "เบิก" }],
      roundBound: true,
      alreadyPersisted: false,
    });
    expect(result.verdict).toBe("would_recover");
    expect(result.reconciliation).toEqual(["return_exceeds_withdrawal"]);
  });
});
