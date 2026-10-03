import { describe, expect, it } from "bun:test";
import type { WeighSession, WeighSessionItem } from "@/lib/parsers/weigh-session/types";
import { validateProduceEntry } from "./entry-validation";
import {
  buildPartialCaptureReviewReply,
  buildPartialCaptureSavedReply,
  buildPartialCaptureSavedReplyWithin,
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
      // shape. Every line is retained; the unknown name is an advisory that
      // still surfaces as a line-level ⚠️ รอตรวจชื่อสินค้า marker.
      roundBound: true,
    });

    expect(validation.status).toBe("clean");
    expect(validation.reviews).toEqual([]);
    expect(validation.advisories).toContainEqual(expect.objectContaining({
      kind: "unknown_product_vocabulary",
      severity: "advisory",
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

    // Advisory, not a correction: the name is never listed as "ต้องแก้".
    expect(buildPartialCaptureReviewReply(capture)).not.toContain("พักผ่อน");
  });

  it("lists only real corrections in the review reply, never an advisory name marker", () => {
    const parsed = session([
      item(1, "พักผ่อน", 4, 20),
      item(3, "หอมแดง", 5, 20),
    ], ["unrecognized line: \"2.มะเขือยาว 36..1 โล 30 บาท\""]);
    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
    const capture = buildProducePartialCapture(parsed, validation, parsed.parse_errors);

    expect(capture.items.find((entry) => entry.item.item_number === 1)?.issueKinds)
      .toEqual(["unknown_product_vocabulary"]);
    const review = buildPartialCaptureReviewReply(capture);
    expect(review).toContain("⚠️ มี 1 รายการที่ต้องแก้");
    expect(review).toContain("2.มะเขือยาว 36..1 โล 30 บาท");
    expect(review).toContain("แก้ข้อ 2");
    expect(review).toContain("ลบข้อ 2");
    expect(review).toContain("ตัวอย่างกรณีมีหลายข้อ");
    expect(review).not.toContain("พักผ่อน");
    expect(review).not.toContain("ไม่พบชื่อสินค้า");
    expect(review).not.toContain("Dictionary");
    // The saved receipt still marks it for a human name check.
    expect(buildPartialCaptureSavedReply(capture))
      .toContain("1. พักผ่อน 4 แพค × 20 บาท = 80.00 บาท ⚠️ รอตรวจชื่อสินค้า");
  });

  it("never lets 25 advisory names hide a real parse error from the top-ten list", () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      item(index + 1, `สินค้าทดลองไม่มีในระบบ${index + 1}`, 1, 20));
    const parsed = session(items, ["unrecognized line: \"26.มะเขือยาว 36..1 โล 30 บาท\""]);
    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
    const capture = buildProducePartialCapture(parsed, validation, parsed.parse_errors);

    const review = buildPartialCaptureReviewReply(capture);
    expect(review).toContain("⚠️ มี 1 รายการที่ต้องแก้");
    expect(review).toContain("26.มะเขือยาว 36..1 โล 30 บาท");
    expect(review).not.toContain("และอีก");
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

  it("116 readable lines with 25 unknown names: clean validation, every line counted, 25 review markers", () => {
    const unknownAt = new Set(Array.from({ length: 25 }, (_, index) => 4 + index * 4));
    const parsed = session(Array.from({ length: 116 }, (_, index) => {
      const number = index + 1;
      return unknownAt.has(number)
        ? item(number, `สินค้าทดลองไม่มีในระบบ${number}`, 2, 10)
        : item(number, "มะนาว", 1, 20);
    }));

    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
    expect(validation.status).toBe("clean");
    expect(validation.blocking).toEqual([]);
    expect(validation.reviews).toEqual([]);
    const vocabulary = validation.advisories.filter((entry) => entry.kind === "unknown_product_vocabulary");
    expect(vocabulary).toHaveLength(25);
    // Kept exactly as entered: nothing guessed or substituted.
    expect(vocabulary.map((entry) => entry.productName))
      .toEqual([...unknownAt].map((number) => `สินค้าทดลองไม่มีในระบบ${number}`));

    const capture = buildProducePartialCapture(parsed, validation, []);
    expect(capture.items).toHaveLength(116);
    expect(capture.readableAmountCount).toBe(116);
    expect(capture.uncalculatedAmountCount).toBe(0);
    expect(capture.readableAmount).toBe(91 * 20 + 25 * 20);
    expect(capture.acceptedCount).toBe(91);
    expect(capture.acceptedAmount).toBe(91 * 20);
    expect(capture.reviewReadableCount).toBe(25);
    expect(capture.reviewReadableAmount).toBe(25 * 20);

    const saved = buildPartialCaptureSavedReply(capture);
    expect(saved.match(/⚠️ รอตรวจชื่อสินค้า/g)).toHaveLength(25);
    expect(saved).toContain("116. มะนาว 1 แพค × 20 บาท = 20.00 บาท");
    expect(saved).toContain("ยอดจากรายการที่อ่านได้ทั้งหมด: 2,320.00 บาท");
    expect(saved).toContain("ยอดที่ตรวจแล้ว: 1,820.00 บาท");
    expect(saved).toContain("⚠️ รอตรวจ: 500.00 บาท (25 รายการ)");
  });

  it("marks every line that repeats an unknown name, so none is counted as checked", () => {
    const parsed = session([
      item(1, "พักผ่อน", 1, 20),
      item(2, "มะนาว", 1, 20),
      item(3, "พักผ่อน", 2, 20),
    ]);
    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
    // Validation reports the spelling once, at its first line …
    expect(validation.advisories.filter((entry) => entry.kind === "unknown_product_vocabulary")
      .map((entry) => entry.itemNumber)).toEqual([1]);

    // … but both lines carrying it are still unchecked money.
    const capture = buildProducePartialCapture(parsed, validation, []);
    expect(capture.items.map((entry) => entry.status)).toEqual(["needs_review", "accepted", "needs_review"]);
    expect(capture.acceptedAmount).toBe(20);
    expect(capture.reviewReadableAmount).toBe(60);
  });

  it("shortens only the line list, never the totals, when a receipt must fit a budget", () => {
    const parsed = session(Array.from({ length: 300 }, (_, index) =>
      item(index + 1, index % 10 === 0 ? `สินค้าทดลองไม่มีในระบบ${index + 1}` : "มะนาว", 1, 20)));
    const validation = validateProduceEntry({ parsed, roundRows: [], roundBound: false });
    const capture = buildProducePartialCapture(parsed, validation, []);

    const full = buildPartialCaptureSavedReply(capture);
    const fitted = buildPartialCaptureSavedReplyWithin(capture, (reply) => [...reply].length <= 5000);
    expect([...full].length).toBeGreaterThan(5000);
    expect([...fitted].length).toBeLessThanOrEqual(5000);
    expect(fitted).toContain("รายการที่รอตรวจ");
    expect(fitted).toContain("(อีก 270 รายการตรวจแล้ว ไม่แสดงรายละเอียด)");
    for (const totalLine of [
      "ยอดจากรายการที่อ่านได้ทั้งหมด: 6,000.00 บาท",
      "ยอดที่ตรวจแล้ว: 5,400.00 บาท",
      "⚠️ รอตรวจ: 600.00 บาท (30 รายการ)",
    ]) {
      expect(full).toContain(totalLine);
      expect(fitted).toContain(totalLine);
    }
  });
});
