import { describe, expect, test } from "bun:test";
import { parseWeighSession } from "@/lib/parsers/weigh-session/parser";
import { normalizeProduceCloser, mainCloserRefusal, unclearProduceCloser } from "@/lib/parsers/weigh-session/main-closer";
import { validateProduceEntry, type RoundMasterRow } from "./entry-validation";
import { buildPriceAdvisoryNotification, buildReviewValidationReply } from "./entry-validation-message";

function document(type: string, lines: string[], closer: string) {
  return [`ขวัญ-พาซิโอ้ผลไม้ ${type} 19/10/2569`, ...lines, closer].join("\n");
}
describe("October finalization and data validation", () => {
  test.each(["จบรายกาาชั่งคืน", "จบรายกรชั่งคืน", "จบรายการชั่งคืน"])("safe clear close %s retains the return", (closer) => {
    const parsed = parseWeighSession(document("ชั่งคืน", ["1.มังคุด20บาท", "10โล"], closer));
    expect(parsed.parse_errors).toEqual([]);
    expect(parsed.items).toHaveLength(1);
    expect(normalizeProduceCloser(closer)).toBe("จบรายการชั่งคืน");
    expect(mainCloserRefusal(document("ชั่งคืน", [], ""), closer)).toBeNull();
  });
  test("never changes transaction type or unrelated commands", () => {
    expect(mainCloserRefusal(document("เบิก", [], ""), "จบรายกาาชั่งคืน")?.message).toContain("จบรายการเบิก");
    for (const command of ["ยกเลิกรายการ", "กู้รายการล่าสุด", "จบรายกาาชั่งคืนเพิ่ม", "มังคุดชั่งคืน"]) {
      expect(normalizeProduceCloser(command)).toBe(command);
    }
    expect(unclearProduceCloser("จบรายกาชั่งคืนน")).toBe(true);
  });
  test("two identical papaya lines require content-bound confirmation and retain both amounts", () => {
    const parsed = parseWeighSession(document("เบิก", ["1.มะละกอ16บาท", "30ลูก", "2.มะละกอ16บาท", "30ลูก"], "จบรายการเบิก"));
    const result = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
    expect(result.status).toBe("review_required");
    expect(result.reviews).toMatchObject([{ kind: "suspected_duplicate_item", firstItemNumber: 1, itemNumber: 2 }]);
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items.reduce((sum, item) => sum + item.quantity! * item.price_per_unit, 0)).toBe(960);
    expect(buildReviewValidationReply(result)).toContain("อาจซ้ำ");
    const edited = { ...parsed, items: [parsed.items[0], { ...parsed.items[1], quantity: 31 }] };
    expect(validateProduceEntry({ parsed: edited, roundRows: [], roundBound: false }).digest).not.toBe(result.digest);
  });
  test("an explicit additional withdrawal matching an earlier line is legitimate", () => {
    const parsed = parseWeighSession(document("เบิกเพิ่ม", ["1.มะละกอ16บาท", "30ลูก"], "จบรายการเบิกเพิ่ม"));
    const roundRows: RoundMasterRow[] = [{ product_name: "มะละกอ", quantity: 30, unit: "ลูก", price_per_unit: 16, transaction_type: "เบิก" }];
    expect(validateProduceEntry({ parsed, roundRows, roundBound: true }).status).toBe("clean");
  });
  test("flags both 20-to-40 price changes and 47 returns versus 44 withdrawn, without altering input", () => {
    const parsed = parseWeighSession(document("ชั่งคืน", ["1.มังคุด40บาท", "10โล", "2.มะม่วงจิ้ว40บาท", "10โล", "3.ทับทิม20บาท", "47ลูก"], "จบรายการชั่งคืน"));
    const before = JSON.stringify(parsed);
    const roundRows = parsed.items.map((item) => ({ product_name: item.product_name,
      unit: item.unit, quantity: item.product_name === "ทับทิม" ? 44 : 20,
      price_per_unit: 20, transaction_type: "เบิก" }));
    const result = validateProduceEntry({ parsed, roundRows, roundBound: true });
    expect(result.status).toBe("clean");
    expect(result.advisories.filter((entry) => entry.kind === "price_not_withdrawn")).toHaveLength(2);
    expect(result.advisories).toContainEqual({ kind: "excess_return", severity: "advisory", productName: "ทับทิม", unit: "ลูก", withdrawnQuantity: 44, returnedQuantity: 47 });
    const notification = buildPriceAdvisoryNotification("บันทึกตามที่กรอกแล้ว", result.advisories);
    expect(notification).toContain("เบิก 20 บาท/โล → ชั่งคืน 40 บาท/โล");
    expect(notification).toContain("เบิก 44 ลูก → คืน 47 ลูก");
    expect(JSON.stringify(parsed)).toBe(before);
  });
});
