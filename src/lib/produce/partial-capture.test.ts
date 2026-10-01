import { describe, expect, it } from "bun:test";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { validateProduceEntry } from "./entry-validation";
import {
  buildPartialCaptureReviewReply,
  buildPartialCaptureSavedReply,
  buildProducePartialCapture,
} from "./partial-capture";

function item(
  itemNumber: number,
  productName: string,
  quantity: number,
  price: number,
): WeighSessionItem {
  return {
    item_number: itemNumber,
    item_number_explicit: true,
    product_name: productName,
    price_per_unit: price,
    quantity,
    unit: "แพค",
    section: "ชั่งคืน",
    transaction_type: "คืน",
    pricing_mode: "unit",
    basis_quantity: null,
    basis_unit: null,
    basis_price: null,
  };
}

function session(items: WeighSessionItem[], parseErrors: string[] = []): WeighSession {
  return {
    date: "2026-09-30",
    staff_name: "พี่ดำ",
    sender_name: "เสือ",
    transaction_time: "23:40",
    session_title: "พาซิโอ้",
    session_kind: "main",
    declared_transaction_type: null,
    items,
    parse_errors: parseErrors,
  };
}

describe("Produce partial capture", () => {
  it("stages good return lines while an unknown product waits for review", () => {
    const parsed = session([
      item(1, "มะนาว", 3, 20),
      item(2, "พักผ่อน", 4, 20),
      item(3, "หอมแดง", 5, 20),
    ]);
    const validation = validateProduceEntry({
      parsed,
      roundRows: [],
      // A bound round with no matching withdrawal is exactly the risky return
      // shape: known product names are retained as advisories, unknown names
      // become line-level review.
      roundBound: true,
    });

    expect(validation.status).toBe("review_required");
    expect(validation.reviews).toContainEqual(expect.objectContaining({
      kind: "unknown_product_vocabulary",
      itemNumber: 2,
      productName: "พักผ่อน",
    }));

    const capture = buildProducePartialCapture(parsed, validation, []);
    expect(capture.acceptedCount).toBe(2);
    expect(capture.readableAmount).toBe(240);
    expect(capture.readableAmountCount).toBe(3);
    expect(capture.uncalculatedAmountCount).toBe(0);
    expect(capture.reviewReadableAmount).toBe(80);
    expect(capture.reviewReadableCount).toBe(1);
    expect(capture.acceptedAmount).toBe(160);
    expect(capture.items.map((entry) => [entry.item.item_number, entry.status])).toEqual([
      [1, "accepted"],
      [2, "needs_review"],
      [3, "accepted"],
    ]);

    const saved = buildPartialCaptureSavedReply(capture);
    expect(saved).toContain("✅ รับรายการชั่งคืนแล้ว");
    expect(saved).toContain("1. มะนาว 3 แพค × 20 บาท = 60.00 บาท");
    expect(saved).toContain("2. พักผ่อน 4 แพค × 20 บาท = 80.00 บาท ⚠️ รอตรวจชื่อสินค้า");
    expect(saved).toContain("3. หอมแดง 5 แพค × 20 บาท = 100.00 บาท");
    expect(saved).toContain("ยอดจากรายการที่อ่านได้ทั้งหมด: 240.00 บาท");
    expect(saved).toContain("ยอดที่ตรวจแล้ว: 160.00 บาท");
    expect(saved).toContain("⚠️ รอตรวจ: 80.00 บาท (1 รายการ)");
    expect(saved).toContain("ยอดขาด-เกินจะสรุปหลังแก้รายการที่รอตรวจเรียบร้อย");
    expect(saved).not.toContain("Dictionary");
    expect(saved).not.toContain("Settlement");
    expect(saved).not.toContain("Final");

    const review = buildPartialCaptureReviewReply(capture);
    expect(review).toContain("⚠️ มี 1 รายการที่ต้องแก้");
    expect(review).toContain("ข้อ 2");
    expect(review).toContain("พักผ่อน 20 บาท");
    expect(review).toContain("4 แพค");
    expect(review).toContain("ไม่พบชื่อสินค้า “พักผ่อน”");
    expect(review).toContain("แก้ข้อ 2");
    expect(review).toContain("ลบข้อ 2");
    expect(review).toContain("ตัวอย่างกรณีมีหลายข้อ");
    expect(review).toContain("แก้ข้อ 5");
    expect(review).toContain("ลบข้อ 8");
    expect(review).not.toContain("Dictionary");
  });

  it("keeps parsed good lines when a separate malformed source line cannot be parsed", () => {
    const parsed = session([
      item(1, "มะนาว", 3, 20),
      item(3, "หอมแดง", 5, 20),
    ], ["unrecognized line: \"2.มะเขือยาว 36..1 โล 30 บาท\""]);
    const validation = validateProduceEntry({
      parsed,
      roundRows: [],
      roundBound: false,
    });
    const capture = buildProducePartialCapture(parsed, validation, parsed.parse_errors);

    expect(capture.acceptedCount).toBe(2);
    expect(capture.issues.some((issue) => issue.kind === "parse_error")).toBe(true);
    expect(buildPartialCaptureReviewReply(capture)).toContain("2.มะเขือยาว 36..1 โล 30 บาท");
  });

  it("keeps an 80-item review summary inside LINE's text limit", () => {
    const parsed = session(Array.from({ length: 80 }, (_, index) =>
      item(index + 1, "มะนาว", index + 1, 20)));
    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
    const capture = buildProducePartialCapture(parsed, validation, []);
    const reply = buildPartialCaptureSavedReply(capture);

    expect(reply).toContain("80. มะนาว 80 แพค × 20 บาท = 1,600.00 บาท");
    expect([...reply].length).toBeLessThanOrEqual(5000);
  });
});
